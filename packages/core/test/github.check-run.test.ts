import { describe, expect, it, vi } from "vitest";
import { createInstallationTokenCache } from "../src/github/github-app-auth.js";
import {
  buildCheckCompletePayload,
  buildCheckStartPayload,
  completeAgentReviewCheck,
  selectCheckRunForUpdate,
  startAgentReviewCheck,
  verdictIsBlocking,
  verdictToCheckConclusion,
} from "../src/github/check-run.js";
import { AGENT_REVIEW_CHECK_NAME, GithubAuthError, type GithubFetchFn } from "../src/github/types.js";

const ENV = { ORCA_PI_GITHUB_REVIEWER_TOKEN: "ghs_reviewer-token-12345678" };
const REVIEWER_BOT = "orca-pi-reviewer[bot]";
const SHA = "abc1234def5678abc1234def5678abc1234def56";

function jsonResponse(data: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) };
}

/**
 * Mock GitHub REST for check runs (production preflight included):
 * - GET /user → reviewer App Bot
 * - GET .../check-runs?... → `existing` list
 * - POST .../check-runs → created run
 * - PATCH .../check-runs/{id} → updated run
 */
function mockChecksFetch(options?: {
  existing?: Array<{ id: number; name?: string; head_sha?: string; status?: string }>;
  createdId?: number;
  failUserStatus?: number;
}): { fetchFn: GithubFetchFn; calls: string[] } {
  const calls: string[] = [];
  const fetchFn: GithubFetchFn = vi.fn(async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    calls.push(`${init.method} ${url}`);
    if (url.endsWith("/user") && init.method === "GET") {
      if (options?.failUserStatus) {
        return { ok: false, status: options.failUserStatus, json: async () => ({}), text: async () => "denied" };
      }
      return jsonResponse({ login: REVIEWER_BOT, type: "Bot" }, 200);
    }
    if (url.includes("/check-runs?") && init.method === "GET") {
      return jsonResponse({ check_runs: options?.existing ?? [] }, 200);
    }
    if (url.endsWith("/check-runs") && init.method === "POST") {
      return jsonResponse({ id: options?.createdId ?? 5001 }, 201);
    }
    if (/\/check-runs\/\d+$/.test(url) && init.method === "PATCH") {
      const id = Number.parseInt(url.split("/").pop() as string, 10);
      return jsonResponse({ id, conclusion: "success" }, 200);
    }
    throw new Error(`unexpected ${init.method} ${url}`);
  });
  return { fetchFn, calls };
}

describe("check-run: verdict mapping", () => {
  it("failure verdict maps to failed check; success verdicts map to successful check", () => {
    expect(verdictToCheckConclusion("request-changes")).toBe("failure");
    expect(verdictToCheckConclusion("approve")).toBe("success");
    expect(verdictToCheckConclusion("comment")).toBe("success");
    expect(verdictIsBlocking("request-changes")).toBe(true);
    expect(verdictIsBlocking("approve")).toBe(false);
  });

  it("uses the deterministic check name for rulesets", () => {
    expect(AGENT_REVIEW_CHECK_NAME).toBe("orca-pi/agent-review");
  });
});

describe("check-run: payloads", () => {
  it("start payload is in_progress with the deterministic name", () => {
    const payload = buildCheckStartPayload({ headSha: SHA }) as { name: string; status: string; head_sha: string };
    expect(payload.name).toBe("orca-pi/agent-review");
    expect(payload.status).toBe("in_progress");
    expect(payload.head_sha).toBe(SHA);
  });

  it("complete payload maps request-changes to failure", () => {
    const payload = buildCheckCompletePayload({ verdict: "request-changes", summary: "2 blocking findings." }) as {
      status: string;
      conclusion: string;
    };
    expect(payload.status).toBe("completed");
    expect(payload.conclusion).toBe("failure");
  });

  it("complete payload maps approve to success", () => {
    const payload = buildCheckCompletePayload({ verdict: "approve", summary: "No blocking findings." }) as {
      conclusion: string;
    };
    expect(payload.conclusion).toBe("success");
  });

  it("rejects empty summaries and invalid SHAs", () => {
    expect(() => buildCheckCompletePayload({ verdict: "approve", summary: "  " })).toThrow(/must not be empty/);
    expect(() => buildCheckStartPayload({ headSha: "not-a-sha!!" })).toThrow(/Invalid head SHA/);
  });
});

describe("check-run: idempotent retry (Blocking 3)", () => {
  it("selects in_progress runs first, else newest completed, else undefined", () => {
    const runs = [
      { id: 1, name: AGENT_REVIEW_CHECK_NAME, headSha: SHA, status: "completed", conclusion: "success" },
      { id: 2, name: AGENT_REVIEW_CHECK_NAME, headSha: SHA, status: "in_progress" },
      { id: 3, name: AGENT_REVIEW_CHECK_NAME, headSha: SHA, status: "in_progress" },
    ];
    // Newest in_progress wins (id 3), avoiding duplicates.
    expect(selectCheckRunForUpdate(runs, SHA)?.id).toBe(3);
    expect(selectCheckRunForUpdate(runs.slice(0, 1), SHA)?.id).toBe(1);
    expect(selectCheckRunForUpdate(runs, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef")).toBeUndefined();
    // Different check names never match.
    expect(selectCheckRunForUpdate([{ id: 9, name: "other", headSha: SHA, status: "in_progress" }], SHA)).toBeUndefined();
  });

  it("start with no existing run creates one (single POST)", async () => {
    const { fetchFn, calls } = mockChecksFetch({ existing: [], createdId: 5001 });
    const started = await startAgentReviewCheck(
      "reviewer",
      { owner: "o", repo: "r", headSha: SHA, summary: "in progress" },
      { fetchFn, env: ENV, cache: createInstallationTokenCache() },
    );
    expect(started.id).toBe(5001);
    expect(started.deduped).toBeUndefined();
    expect(calls.filter((c) => c.startsWith("POST")).length).toBe(1);
  });

  it("Blocking 3: repeating start for the same SHA reuses the run (no duplicate POST)", async () => {
    const { fetchFn, calls } = mockChecksFetch({
      existing: [{ id: 5001, name: AGENT_REVIEW_CHECK_NAME, head_sha: SHA, status: "in_progress" }],
    });
    const first = await startAgentReviewCheck(
      "reviewer",
      { owner: "o", repo: "r", headSha: SHA, summary: "in progress" },
      { fetchFn, env: ENV, cache: createInstallationTokenCache() },
    );
    const second = await startAgentReviewCheck(
      "reviewer",
      { owner: "o", repo: "r", headSha: SHA, summary: "in progress retry" },
      { fetchFn, env: ENV, cache: createInstallationTokenCache() },
    );
    expect(first.id).toBe(5001);
    expect(second.id).toBe(5001);
    expect(second.deduped).toBe(true);
    // No POST creates at all — both starts PATCHed the existing run.
    expect(calls.filter((c) => c.startsWith("POST"))).toEqual([]);
    expect(calls.filter((c) => c.startsWith("PATCH")).length).toBe(2);
  });

  it("complete updates the same run created by start (no duplicates)", async () => {
    const { fetchFn, calls } = mockChecksFetch({ existing: [], createdId: 5001 });
    const cache = createInstallationTokenCache();
    // Start creates the run (no existing → POST).
    const started = await startAgentReviewCheck(
      "reviewer",
      { owner: "o", repo: "r", headSha: SHA, summary: "in progress" },
      { fetchFn, env: ENV, cache },
    );
    expect(started.id).toBe(5001);
    // Complete with explicit id PATCHes the same run.
    const completed = await completeAgentReviewCheck(
      "reviewer",
      { owner: "o", repo: "r", headSha: SHA, checkRunId: started.id, verdict: "approve", summary: "passed" },
      { fetchFn, env: ENV, cache },
    );
    expect(completed.id).toBe(5001);
    expect(completed.conclusion).toBe("success");
    expect(calls.filter((c) => c.startsWith("POST")).length).toBe(1);
  });

  it("complete without an id reuses the existing deterministic run via list", async () => {
    const { fetchFn } = mockChecksFetch({
      existing: [{ id: 7001, name: AGENT_REVIEW_CHECK_NAME, head_sha: SHA, status: "in_progress" }],
    });
    const patchUrls: string[] = [];
    const wrapped: GithubFetchFn = async (url, init) => {
      if (init.method === "PATCH") patchUrls.push(url);
      return fetchFn(url, init);
    };
    const result = await completeAgentReviewCheck(
      "reviewer",
      { owner: "o", repo: "r", headSha: SHA, verdict: "request-changes", summary: "blocking" },
      { fetchFn: wrapped, env: ENV, cache: createInstallationTokenCache() },
    );
    expect(result.id).toBe(7001);
    expect(result.conclusion).toBe("failure");
    expect(patchUrls.length).toBe(1);
    expect(patchUrls[0]).toContain("/check-runs/7001");
  });

  it("Blocking 1: --identity worker cannot write checks (no network write)", async () => {
    const fetchFn: GithubFetchFn = vi.fn(async () => {
      throw new Error("must not be called for worker identity");
    });
    await expect(
      startAgentReviewCheck("worker", { owner: "o", repo: "r", headSha: SHA, summary: "x" }, { fetchFn, env: { ORCA_PI_GITHUB_WORKER_TOKEN: "ghp_x" }, cache: createInstallationTokenCache() }),
    ).rejects.toThrow(/must use the dedicated reviewer GitHub App/i);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("Blocking 1: human PAT in the reviewer slot cannot write checks", async () => {
    const calls: string[] = [];
    const fetchFn: GithubFetchFn = vi.fn(async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
      calls.push(`${init.method} ${url}`);
      if (url.endsWith("/user")) return jsonResponse({ login: "human-user", type: "User" }, 200);
      throw new Error(`must not reach ${init.method} ${url}`);
    });
    await expect(
      startAgentReviewCheck("reviewer", { owner: "o", repo: "r", headSha: SHA, summary: "x" }, { fetchFn, env: ENV, cache: createInstallationTokenCache() }),
    ).rejects.toThrow(/same actor|distinct/i);
    expect(calls.filter((c) => c.startsWith("POST")).length).toBe(0);
    expect(calls.filter((c) => c.startsWith("PATCH")).length).toBe(0);
  });

  it("403 during preflight maps to actionable unauthorized-installation error", async () => {
    const { fetchFn } = mockChecksFetch({ failUserStatus: 403 });
    let error: unknown;
    try {
      await startAgentReviewCheck("reviewer", { owner: "o", repo: "r", headSha: SHA, summary: "x" }, { fetchFn, env: ENV, cache: createInstallationTokenCache() });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(GithubAuthError);
    expect((error as Error).message).toMatch(/Reviewer GitHub App.*not installed|may lack permission/i);
  });
});

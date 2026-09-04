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
const SHA = "abc1234def5678abc1234def5678abc1234def56";

function jsonResponse(data: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) };
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

describe("check-run: idempotent retry", () => {
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

  it("start creates one run; complete updates the same run (no duplicates)", async () => {
    const calls: string[] = [];
    const fetchFn: GithubFetchFn = vi.fn(async (url, init) => {
      calls.push(`${init.method} ${url}`);
      if (init.method === "POST") return jsonResponse({ id: 5001 }, 201);
      return jsonResponse({ id: 5001, conclusion: "success" }, 200);
    });
    const cache = createInstallationTokenCache();
    const started = await startAgentReviewCheck(
      "reviewer",
      { owner: "o", repo: "r", headSha: SHA, summary: "in progress" },
      { fetchFn, env: ENV, cache },
    );
    expect(started.id).toBe(5001);
    const completed = await completeAgentReviewCheck(
      "reviewer",
      { owner: "o", repo: "r", headSha: SHA, checkRunId: started.id, verdict: "approve", summary: "passed" },
      { fetchFn, env: ENV, cache },
    );
    expect(completed.id).toBe(5001);
    expect(completed.conclusion).toBe("success");
    expect(calls.filter((c) => c.startsWith("POST")).length).toBe(1);
    expect(calls.filter((c) => c.startsWith("PATCH")).length).toBe(1);
  });

  it("complete without an id reuses the existing deterministic run via list", async () => {
    const patchUrls: string[] = [];
    const fetchFn: GithubFetchFn = async (url, init) => {
      if (init.method === "GET") {
        return jsonResponse({ check_runs: [{ id: 7001, name: AGENT_REVIEW_CHECK_NAME, head_sha: SHA, status: "in_progress" }] }, 200);
      }
      if (init.method === "PATCH") {
        patchUrls.push(url);
        return jsonResponse({ id: 7001, conclusion: "failure" }, 200);
      }
      throw new Error(`unexpected ${init.method} ${url}`);
    };
    const result = await completeAgentReviewCheck(
      "reviewer",
      { owner: "o", repo: "r", headSha: SHA, verdict: "request-changes", summary: "blocking" },
      { fetchFn, env: ENV, cache: createInstallationTokenCache() },
    );
    expect(result.id).toBe(7001);
    expect(result.conclusion).toBe("failure");
    expect(patchUrls.length).toBe(1);
    expect(patchUrls[0]).toContain("/check-runs/7001");
  });

  it("403 on check APIs maps to actionable unauthorized-installation error", async () => {
    const fetchFn: GithubFetchFn = async () => ({ ok: false, status: 403, json: async () => ({}), text: async () => "forbidden" });
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

import { describe, expect, it, vi } from "vitest";
import { createInstallationTokenCache } from "../src/github/github-app-auth.js";
import { completeAgentReviewCheck, startAgentReviewCheck } from "../src/github/check-run.js";
import { assertDistinctGithubActors } from "../src/github/identity.js";
import { submitGithubReview } from "../src/github/review.js";
import type { GithubFetchFn } from "../src/github/types.js";

/**
 * Integration fixture (offline, no github.com): a worker-authored PR is
 * reviewed by a separate App actor — review + deterministic check.
 *
 * Simulates:
 * 1. worker creates/updates a PR (human/machine-user credential),
 * 2. reviewer App submits REQUEST_CHANGES + failed check,
 * 3. after fixes, reviewer submits APPROVE + passed check,
 * 4. actors are distinct (worker login ≠ reviewer login).
 */
describe("github integration: worker PR -> reviewer review/check -> human-ready", () => {
  it("cross-identity review flow stays distinct and deterministic", async () => {
    const workerEnv = { ORCA_PI_GITHUB_WORKER_TOKEN: "ghp_worker-human-token-12345678" };
    const reviewerEnv = { ORCA_PI_GITHUB_REVIEWER_TOKEN: "ghs_reviewer-app-token-12345678" };
    const workerCache = createInstallationTokenCache();
    const reviewerCache = createInstallationTokenCache();
    const sha = "feedfacefeedfacefeedfacefeedfacefeedface";

    // Distinct actors: human vs reviewer App bot.
    expect(() =>
      assertDistinctGithubActors({ workerLogin: "human-user", reviewerLogin: "orca-pi-reviewer[bot]" }),
    ).not.toThrow();

    const calls: Array<{ method: string; url: string; auth: string; body: string }> = [];
    const fetchFn: GithubFetchFn = vi.fn(async (url, init) => {
      calls.push({ method: init.method, url, auth: init.headers.Authorization ?? "", body: init.body ?? "" });
      if (url.includes("/pulls/7/reviews")) {
        const payload = JSON.parse(init.body as string) as { event: string };
        const id = payload.event === "REQUEST_CHANGES" ? 1001 : 1002;
        return { ok: true, status: 200, json: async () => ({ id }), text: async () => "{}" };
      }
      if (url.includes("/check-runs") && init.method === "POST") {
        return { ok: true, status: 201, json: async () => ({ id: 2001 }), text: async () => "{}" };
      }
      if (url.includes("/check-runs/2001") && init.method === "PATCH") {
        const payload = JSON.parse(init.body as string) as { conclusion: string };
        return { ok: true, status: 200, json: async () => ({ id: 2001, conclusion: payload.conclusion }), text: async () => "{}" };
      }
      if (url.includes("/check-runs?")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ check_runs: [{ id: 2001, name: "orca-pi/agent-review", head_sha: sha, status: "in_progress" }] }),
          text: async () => "{}",
        };
      }
      throw new Error(`unexpected ${init.method} ${url}`);
    });

    // Round 1: blocking findings → REQUEST_CHANGES + failed check.
    const review1 = await submitGithubReview(
      "reviewer",
      { owner: "octo", repo: "hello-world", pullNumber: 7, verdict: "request-changes", body: "Blocking: missing test in foo.ts:12.", provenance: { taskId: "t-1", linearIssueId: "JEF-15", profile: "reviewer" } },
      { fetchFn, env: reviewerEnv, cache: reviewerCache },
    );
    expect(review1.id).toBe(1001);
    const check1 = await startAgentReviewCheck(
      "reviewer",
      { owner: "octo", repo: "hello-world", headSha: sha, summary: "Agent review in progress…" },
      { fetchFn, env: reviewerEnv, cache: reviewerCache },
    );
    expect(check1.id).toBe(2001);
    const done1 = await completeAgentReviewCheck(
      "reviewer",
      { owner: "octo", repo: "hello-world", headSha: sha, checkRunId: 2001, verdict: "request-changes", summary: "1 blocking finding." },
      { fetchFn, env: reviewerEnv, cache: reviewerCache },
    );
    expect(done1.conclusion).toBe("failure");

    // Round 2 (retry after fixes): same deterministic run updated to success.
    const review2 = await submitGithubReview(
      "reviewer",
      { owner: "octo", repo: "hello-world", pullNumber: 7, verdict: "approve", body: "No blocking findings." },
      { fetchFn, env: reviewerEnv, cache: reviewerCache },
    );
    expect(review2.id).toBe(1002);
    const done2 = await completeAgentReviewCheck(
      "reviewer",
      { owner: "octo", repo: "hello-world", headSha: sha, verdict: "approve", summary: "No blocking findings." },
      { fetchFn, env: reviewerEnv, cache: reviewerCache },
    );
    expect(done2.conclusion).toBe("success");
    expect(done2.id).toBe(2001); // idempotent: same run, not a duplicate

    // Reviewer calls all used the App token, never the worker token.
    const reviewCalls = calls.filter((c) => c.url.includes("/reviews"));
    for (const call of reviewCalls) {
      expect(call.auth).toBe(`Bearer ${reviewerEnv.ORCA_PI_GITHUB_REVIEWER_TOKEN}`);
      expect(call.auth).not.toContain(workerEnv.ORCA_PI_GITHUB_WORKER_TOKEN);
      expect(call.body).not.toContain(workerEnv.ORCA_PI_GITHUB_WORKER_TOKEN);
      expect(call.body).not.toContain(reviewerEnv.ORCA_PI_GITHUB_REVIEWER_TOKEN);
    }
    // Human remains merge authority: no merge endpoint was ever called.
    expect(calls.some((c) => c.url.includes("/merge"))).toBe(false);

    // Silence unused vars (worker credential resolves independently).
    expect(workerCache).toBeDefined();
  });
});

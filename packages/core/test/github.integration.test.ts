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
 * Simulates (with production preflight enforcement):
 * 1. worker creates/updates a PR (human/machine-user credential),
 * 2. reviewer App proves Bot identity + distinctness, submits
 *    REQUEST_CHANGES + failed check,
 * 3. after fixes, reviewer submits APPROVE + passed check (idempotent run),
 * 4. actors are distinct (worker login ≠ reviewer login),
 * 5. same-account reviewer is rejected before any POST.
 */
describe("github integration: worker PR -> reviewer review/check -> human-ready", () => {
  it("cross-identity review flow stays distinct and deterministic", async () => {
    const workerEnv = { ORCA_PI_GITHUB_WORKER_TOKEN: "ghp_worker-human-token-12345678" };
    const reviewerEnv = {
      ORCA_PI_GITHUB_REVIEWER_TOKEN: "ghs_reviewer-app-token-12345678",
      ORCA_PI_GITHUB_REVIEWER_LOGIN: "orca-pi-reviewer[bot]",
      ORCA_PI_GITHUB_REVIEWER_INSTALLATION_ID: "123456",
    };
    const workerCache = createInstallationTokenCache();
    const reviewerCache = createInstallationTokenCache();
    const sha = "feedfacefeedfacefeedfacefeedfacefeedface";
    const reviewerBot = "orca-pi-reviewer[bot]";
    const prAuthor = "human-user";

    // Distinct actors: human vs reviewer App bot.
    expect(() =>
      assertDistinctGithubActors({ workerLogin: prAuthor, reviewerLogin: reviewerBot }),
    ).not.toThrow();

    const calls: Array<{ method: string; url: string; auth: string; body: string }> = [];
    let checkRuns: Array<{ id: number; name: string; head_sha: string; status: string }> = [];
    let nextCheckId = 2001;
    let nextReviewId = 1001;
    const fetchFn: GithubFetchFn = vi.fn(async (url, init) => {
      calls.push({ method: init.method, url, auth: init.headers.Authorization ?? "", body: init.body ?? "" });
      if (url === "https://api.github.com/user") {
        throw new Error("GET /user must never be called for installation tokens");
      }
      if (url.includes("/installation/repositories") && init.method === "GET") {
        return { ok: true, status: 200, json: async () => ({ total_count: 1, repositories: [{ id: 1, full_name: "octo/hello-world" }] }), text: async () => "{}" };
      }
      if (/\/repos\/[^/]+\/[^/]+\/pulls\/7$/.test(url) && init.method === "GET") {
        return { ok: true, status: 200, json: async () => ({ user: { login: prAuthor }, head: { sha } }), text: async () => "{}" };
      }
      if (url.includes("/pulls/7/reviews?") && init.method === "GET") {
        // Real listing shape with response states.
        return { ok: true, status: 200, json: async () => [], text: async () => "{}" };
      }
      if (url.includes("/pulls/7/reviews") && init.method === "POST") {
        const payload = JSON.parse(init.body as string) as { event: string };
        const id = payload.event === "REQUEST_CHANGES" ? 1001 : 1002;
        nextReviewId = Math.max(nextReviewId, id + 1);
        return { ok: true, status: 200, json: async () => ({ id }), text: async () => "{}" };
      }
      if (url.includes("/check-runs?") && init.method === "GET") {
        return { ok: true, status: 200, json: async () => ({ check_runs: checkRuns }), text: async () => "{}" };
      }
      if (url.endsWith("/check-runs") && init.method === "POST") {
        const id = nextCheckId++;
        checkRuns = [{ id, name: "orca-pi/agent-review", head_sha: sha, status: "in_progress" }];
        return { ok: true, status: 201, json: async () => ({ id }), text: async () => "{}" };
      }
      if (/\/check-runs\/\d+$/.test(url) && init.method === "PATCH") {
        const payload = JSON.parse(init.body as string) as { conclusion?: string; status?: string };
        const id = Number.parseInt(url.split("/").pop() as string, 10);
        checkRuns = checkRuns.map((run) => (run.id === id ? { ...run, status: String(payload.status ?? "completed") } : run));
        return { ok: true, status: 200, json: async () => ({ id, conclusion: payload.conclusion }), text: async () => "{}" };
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

    // Round 2: start retry reuses the same deterministic run (no duplicate).
    const startRetry = await startAgentReviewCheck(
      "reviewer",
      { owner: "octo", repo: "hello-world", headSha: sha, summary: "retry" },
      { fetchFn, env: reviewerEnv, cache: reviewerCache },
    );
    expect(startRetry.id).toBe(2001);
    expect(startRetry.deduped).toBe(true);

    // Round 2 (after fixes): APPROVE + same run updated to success.
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
    const reviewCalls = calls.filter((c) => c.url.includes("/reviews") && c.method === "POST");
    for (const call of reviewCalls) {
      expect(call.auth).toBe(`Bearer ${reviewerEnv.ORCA_PI_GITHUB_REVIEWER_TOKEN}`);
      expect(call.auth).not.toContain(workerEnv.ORCA_PI_GITHUB_WORKER_TOKEN);
      expect(call.body).not.toContain(workerEnv.ORCA_PI_GITHUB_WORKER_TOKEN);
      expect(call.body).not.toContain(reviewerEnv.ORCA_PI_GITHUB_REVIEWER_TOKEN);
    }
    // Only one deterministic check-run was ever created (start POST once).
    expect(calls.filter((c) => c.url.endsWith("/check-runs") && c.method === "POST").length).toBe(1);
    // Human remains merge authority: no merge endpoint was ever called.
    expect(calls.some((c) => c.url.includes("/merge"))).toBe(false);

    // Silence unused vars (worker credential resolves independently).
    expect(workerCache).toBeDefined();
  });

  it("same-account reviewer is rejected before any review/check POST", async () => {
    // Configured reviewer login equals the PR author → distinctness fails.
    // (IAT class proof still uses the installation endpoint; no GET /user.)
    const reviewerEnv = {
      ORCA_PI_GITHUB_REVIEWER_TOKEN: "ghs_same-installation-12345678",
      ORCA_PI_GITHUB_REVIEWER_LOGIN: "human-user[bot]",
      ORCA_PI_GITHUB_REVIEWER_INSTALLATION_ID: "123456",
    };
    const cache = createInstallationTokenCache();
    const posts: string[] = [];
    const fetchFn: GithubFetchFn = vi.fn(async (url, init) => {
      if (url === "https://api.github.com/user") throw new Error("GET /user must never be called for installation tokens");
      if (url.includes("/installation/repositories")) {
        return { ok: true, status: 200, json: async () => ({ repositories: [] }), text: async () => "{}" };
      }
      if (/\/repos\/[^/]+\/[^/]+\/pulls\/1$/.test(url)) {
        return { ok: true, status: 200, json: async () => ({ user: { login: "human-user[bot]" }, head: { sha: "bbbbbbbb11111111111111111111111111111111" } }), text: async () => "{}" };
      }
      if (init.method === "POST") posts.push(url);
      throw new Error(`must not POST: ${init.method} ${url}`);
    });
    await expect(
      submitGithubReview("reviewer", { owner: "o", repo: "r", pullNumber: 1, verdict: "comment", body: "hi" }, { fetchFn, env: reviewerEnv, cache }),
    ).rejects.toThrow(/same actor|distinct/i);
    expect(posts).toEqual([]);
  });
});

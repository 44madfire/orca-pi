import { describe, expect, it, vi } from "vitest";
import { createInstallationTokenCache } from "../src/github/github-app-auth.js";
import {
  buildReviewPayload,
  findDuplicateReview,
  formatReviewBody,
  listPullReviews,
  parsePullRequestRef,
  parseReviewVerdict,
  submitGithubReview,
  verdictToReviewEvent,
} from "../src/github/review.js";
import { GithubAuthError, type GithubFetchFn } from "../src/github/types.js";

const ENV = { ORCA_PI_GITHUB_REVIEWER_TOKEN: "ghs_reviewer-token-12345678" };
const REVIEWER_BOT = "orca-pi-reviewer[bot]";
const PR_AUTHOR = "human-user";

function jsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

/**
 * Mock GitHub REST for the review path (production preflight included):
 * - GET /user → reviewer App Bot (distinct actor)
 * - GET /repos/{o}/{r}/pulls/{n} → PR author (human)
 * - GET .../reviews?per_page → [] (no duplicate by default)
 * - POST .../reviews → created review
 */
function mockReviewFetch(options?: {
  reviewerLogin?: string;
  reviewerType?: string;
  prAuthor?: string;
  existingReviews?: unknown[];
  onPost?: (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => void;
  failGet?: { userStatus?: number; prStatus?: number };
}): GithubFetchFn {
  const reviewerLogin = options?.reviewerLogin ?? REVIEWER_BOT;
  const reviewerType = options?.reviewerType ?? "Bot";
  const prAuthor = options?.prAuthor ?? PR_AUTHOR;
  return vi.fn(async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    if (url.endsWith("/user") && init.method === "GET") {
      if (options?.failGet?.userStatus) {
        return { ok: false, status: options.failGet.userStatus, json: async () => ({}), text: async () => "denied" };
      }
      return jsonResponse({ login: reviewerLogin, type: reviewerType }, 200);
    }
    if (/\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(url) && init.method === "GET") {
      if (options?.failGet?.prStatus) {
        return { ok: false, status: options.failGet.prStatus, json: async () => ({}), text: async () => "denied" };
      }
      return jsonResponse({ user: { login: prAuthor } }, 200);
    }
    if (url.includes("/reviews?") && init.method === "GET") {
      return jsonResponse(options?.existingReviews ?? [], 200);
    }
    if (url.endsWith("/reviews") && init.method === "POST") {
      options?.onPost?.(url, init);
      return jsonResponse({ id: 9001, html_url: "https://github.com/octo/hello-world/pull/123#review-9001" }, 200);
    }
    throw new Error(`unexpected ${init.method} ${url}`);
  });
}

describe("review: verdict mapping", () => {
  it("maps approve/request-changes/comment to GitHub events", () => {
    expect(verdictToReviewEvent("approve")).toBe("APPROVE");
    expect(verdictToReviewEvent("request-changes")).toBe("REQUEST_CHANGES");
    expect(verdictToReviewEvent("comment")).toBe("COMMENT");
  });

  it("parses --verdict with alias tolerance", () => {
    expect(parseReviewVerdict("approve")).toBe("approve");
    expect(parseReviewVerdict("request-changes")).toBe("request-changes");
    expect(parseReviewVerdict("request_changes")).toBe("request-changes");
    expect(parseReviewVerdict("COMMENT")).toBe("comment");
    expect(() => parseReviewVerdict("merge")).toThrow(/Invalid --verdict/);
  });
});

describe("review: PR parsing", () => {
  it("parses PR URLs", () => {
    expect(parsePullRequestRef("https://github.com/octo/hello-world/pull/123")).toEqual({
      owner: "octo",
      repo: "hello-world",
      pullNumber: 123,
    });
  });

  it("parses owner/repo#n shorthand and bare numbers with --repo", () => {
    expect(parsePullRequestRef("octo/hello-world#42")).toEqual({ owner: "octo", repo: "hello-world", pullNumber: 42 });
    expect(parsePullRequestRef("42", { repo: "octo/hello-world" })).toEqual({
      owner: "octo",
      repo: "hello-world",
      pullNumber: 42,
    });
  });

  it("rejects bare numbers without --repo and malformed refs", () => {
    expect(() => parsePullRequestRef("42")).toThrow(/--repo/);
    expect(() => parsePullRequestRef("not-a-pr")).toThrow(/Invalid --pr/);
  });
});

describe("review: payloads for COMMENT / REQUEST_CHANGES / APPROVE", () => {
  it("builds COMMENT payload with provenance footer, no prompt content", () => {
    const payload = buildReviewPayload({
      verdict: "comment",
      body: "Looks good overall.",
      provenance: { taskId: "t-1", linearIssueId: "JEF-15", profile: "reviewer" },
    });
    expect(payload.event).toBe("COMMENT");
    expect(payload.body).toContain("Looks good overall.");
    expect(payload.body).toContain("JEF-15");
    expect(payload.body).toContain("human remains merge authority");
  });

  it("builds REQUEST_CHANGES with commit_id when known", () => {
    const payload = buildReviewPayload({ verdict: "request-changes", body: "Blocking: missing test.", commitId: "abc1234" });
    expect(payload.event).toBe("REQUEST_CHANGES");
    expect(payload.commit_id).toBe("abc1234");
  });

  it("builds APPROVE payload", () => {
    const payload = buildReviewPayload({ verdict: "approve", body: "Approved — no blocking findings." });
    expect(payload.event).toBe("APPROVE");
  });

  it("rejects empty bodies", () => {
    expect(() => buildReviewPayload({ verdict: "comment", body: "   " })).toThrow(/must not be empty/);
  });

  it("formatReviewBody preserves provenance without prompt leakage", () => {
    const body = formatReviewBody("Findings here.", { taskId: "task-9", linearIssueId: "JEF-15" });
    expect(body).toContain("task-9");
    expect(body).not.toContain("systemPrompt");
  });
});

describe("review: submit via reviewer App identity (production preflight)", () => {
  it("POSTs to /reviews with Bearer auth after proving distinct App actor", async () => {
    let postedEvent = "";
    const fetchFn = mockReviewFetch({
      onPost: (_url, init) => {
        postedEvent = (JSON.parse(init.body as string) as { event: string }).event;
      },
    });
    // Assert the preflight Authorization header on every call.
    const wrapped: GithubFetchFn = async (url, init) => {
      expect(init.headers.Authorization).toBe(`Bearer ${ENV.ORCA_PI_GITHUB_REVIEWER_TOKEN}`);
      return fetchFn(url, init);
    };
    const result = await submitGithubReview(
      "reviewer",
      { owner: "octo", repo: "hello-world", pullNumber: 123, verdict: "request-changes", body: "Blocking finding." },
      { fetchFn: wrapped, env: ENV, cache: createInstallationTokenCache() },
    );
    expect(result.id).toBe(9001);
    expect(postedEvent).toBe("REQUEST_CHANGES");
    // Preflight GETs + list + POST all ran.
    expect(fetchFn).toHaveBeenCalled();
    const postCalls = (fetchFn as ReturnType<typeof vi.fn>).mock.calls.filter(([, init]) => (init as { method: string }).method === "POST");
    expect(postCalls.length).toBe(1);
  });

  it("Blocking 1: same-user separate PATs cannot reach POST /reviews", async () => {
    let posted = 0;
    const fetchFn = mockReviewFetch({
      reviewerLogin: PR_AUTHOR, // same login as PR author, different token
      reviewerType: "User",
      prAuthor: PR_AUTHOR,
      onPost: () => {
        posted += 1;
      },
    });
    let error: unknown;
    try {
      await submitGithubReview(
        "reviewer",
        { owner: "o", repo: "r", pullNumber: 1, verdict: "comment", body: "hi" },
        { fetchFn, env: ENV, cache: createInstallationTokenCache() },
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/same actor|distinct/i);
    expect(posted).toBe(0);
    expect((error as Error).message).not.toContain(ENV.ORCA_PI_GITHUB_REVIEWER_TOKEN);
  });

  it("Blocking 1: --identity worker can never submit a formal review (no network write)", async () => {
    const fetchFn: GithubFetchFn = vi.fn(async () => {
      throw new Error("must not be called for worker identity");
    });
    let error: unknown;
    try {
      await submitGithubReview(
        "worker",
        { owner: "o", repo: "r", pullNumber: 1, verdict: "approve", body: "hi" },
        { fetchFn, env: { ORCA_PI_GITHUB_WORKER_TOKEN: "ghp_worker-12345678" }, cache: createInstallationTokenCache() },
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(GithubAuthError);
    expect((error as Error).message).toMatch(/must use the dedicated reviewer GitHub App/i);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("Blocking 1: human PAT in the reviewer slot (type User) is rejected before POST", async () => {
    let posted = 0;
    const fetchFn = mockReviewFetch({
      reviewerLogin: "human-user",
      reviewerType: "User",
      prAuthor: "other-author",
      onPost: () => {
        posted += 1;
      },
    });
    await expect(
      submitGithubReview(
        "reviewer",
        { owner: "o", repo: "r", pullNumber: 1, verdict: "approve", body: "hi" },
        { fetchFn, env: ENV, cache: createInstallationTokenCache() },
      ),
    ).rejects.toThrow(/same actor|distinct/i);
    expect(posted).toBe(0);
  });

  it("retry with identical inputs dedupes instead of POSTing a duplicate review", async () => {
    const formattedBody = "Blocking finding.\n\n---\n🤖 orca-pi agent-review (profile: reviewer) · human remains merge authority";
    let posts = 0;
    const fetchFn = mockReviewFetch({
      existingReviews: [{ id: 555, user: { login: REVIEWER_BOT }, state: "REQUEST_CHANGES", body: formattedBody }],
      onPost: () => {
        posts += 1;
      },
    });
    const result = await submitGithubReview(
      "reviewer",
      { owner: "o", repo: "r", pullNumber: 1, verdict: "request-changes", body: "Blocking finding.", provenance: { profile: "reviewer" } },
      { fetchFn, env: ENV, cache: createInstallationTokenCache() },
    );
    expect(result.id).toBe(555);
    expect(result.deduped).toBe(true);
    expect(posts).toBe(0);
  });

  it("findDuplicateReview matches same reviewer/event/body, ignores others", () => {
    const reviews = [
      { id: 1, userLogin: REVIEWER_BOT, state: "APPROVE", body: "ok" },
      { id: 2, userLogin: REVIEWER_BOT, state: "REQUEST_CHANGES", body: "blocking" },
      { id: 3, userLogin: "someone-else", state: "REQUEST_CHANGES", body: "blocking" },
    ];
    expect(findDuplicateReview(reviews, { reviewerLogin: REVIEWER_BOT, event: "REQUEST_CHANGES", body: "blocking" })?.id).toBe(2);
    expect(findDuplicateReview(reviews, { reviewerLogin: REVIEWER_BOT, event: "APPROVE", body: "different" })).toBeUndefined();
  });

  it("listPullReviews parses the API shape", async () => {
    const fetchFn: GithubFetchFn = async (url, init) => {
      expect(url).toContain("/reviews?");
      expect(init.method).toBe("GET");
      return jsonResponse([{ id: 1, user: { login: REVIEWER_BOT }, state: "APPROVE", body: "ok", commit_id: "abc" }], 200);
    };
    const reviews = await listPullReviews("reviewer", { owner: "o", repo: "r", pullNumber: 1 }, { fetchFn, env: ENV, cache: createInstallationTokenCache() });
    expect(reviews).toEqual([{ id: 1, userLogin: REVIEWER_BOT, state: "APPROVE", body: "ok", commitId: "abc" }]);
  });

  it("401/403/404 during preflight map to actionable auth errors", async () => {
    for (const status of [401, 403, 404]) {
      const fetchFn: GithubFetchFn = async (url) => {
        if (url.endsWith("/user")) {
          return { ok: false, status, json: async () => ({ message: "denied" }), text: async () => "denied" };
        }
        throw new Error(`unexpected ${url}`);
      };
      let error: unknown;
      try {
        await submitGithubReview(
          "reviewer",
          { owner: "o", repo: "r", pullNumber: 1, verdict: "comment", body: "hi" },
          { fetchFn, env: ENV, cache: createInstallationTokenCache() },
        );
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(GithubAuthError);
      expect((error as Error).message).not.toContain(ENV.ORCA_PI_GITHUB_REVIEWER_TOKEN);
    }
  });

  it("never leaks the token into error text", async () => {
    const fetchFn: GithubFetchFn = async (url) => {
      if (url.endsWith("/user")) {
        throw new Error(`boom with ${ENV.ORCA_PI_GITHUB_REVIEWER_TOKEN} inside`);
      }
      throw new Error(`unexpected ${url}`);
    };
    let message = "";
    try {
      await submitGithubReview(
        "reviewer",
        { owner: "o", repo: "r", pullNumber: 1, verdict: "comment", body: "hi" },
        { fetchFn, env: ENV, cache: createInstallationTokenCache() },
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain(ENV.ORCA_PI_GITHUB_REVIEWER_TOKEN);
  });
});

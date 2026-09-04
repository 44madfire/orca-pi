import { describe, expect, it, vi } from "vitest";
import { createInstallationTokenCache } from "../src/github/github-app-auth.js";
import {
  buildReviewPayload,
  formatReviewBody,
  parsePullRequestRef,
  parseReviewVerdict,
  submitGithubReview,
  verdictToReviewEvent,
} from "../src/github/review.js";
import { GithubAuthError, type GithubFetchFn } from "../src/github/types.js";

const ENV = { ORCA_PI_GITHUB_REVIEWER_TOKEN: "ghs_reviewer-token-12345678" };

function jsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
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

describe("review: submit via reviewer App identity", () => {
  it("POSTs to /reviews with Bearer auth and returns the review id", async () => {
    const fetchFn: GithubFetchFn = vi.fn(async (url, init) => {
      expect(url).toContain("/repos/octo/hello-world/pulls/123/reviews");
      expect(init.method).toBe("POST");
      expect(init.headers.Authorization).toBe(`Bearer ${ENV.ORCA_PI_GITHUB_REVIEWER_TOKEN}`);
      const payload = JSON.parse(init.body as string) as { event: string };
      expect(payload.event).toBe("REQUEST_CHANGES");
      return jsonResponse({ id: 9001, html_url: "https://github.com/octo/hello-world/pull/123#review-9001" }, 200);
    });
    const result = await submitGithubReview(
      "reviewer",
      { owner: "octo", repo: "hello-world", pullNumber: 123, verdict: "request-changes", body: "Blocking finding." },
      { fetchFn, env: ENV, cache: createInstallationTokenCache() },
    );
    expect(result.id).toBe(9001);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("401/403/404 map to actionable auth errors (missing/unauthorized installation)", async () => {
    for (const status of [401, 403, 404]) {
      const fetchFn: GithubFetchFn = async () => ({
        ok: false,
        status,
        json: async () => ({ message: "denied" }),
        text: async () => "denied",
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
      expect(error).toBeInstanceOf(GithubAuthError);
      expect((error as Error).message).not.toContain(ENV.ORCA_PI_GITHUB_REVIEWER_TOKEN);
    }
  });

  it("never leaks the token into error text", async () => {
    const fetchFn: GithubFetchFn = async () => {
      throw new Error(`boom with ${ENV.ORCA_PI_GITHUB_REVIEWER_TOKEN} inside`);
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

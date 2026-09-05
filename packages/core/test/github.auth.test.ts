import { describe, expect, it, vi } from "vitest";
import {
  assertReviewerIdentityForWrites,
  createInstallationTokenCache,
  describeCredentialStatus,
  fetchAuthenticatedActor,
  fetchPullRequestAuthor,
  resolveGithubCredential,
  verifyReviewerForChecks,
  verifyReviewerForReview,
} from "../src/github/github-app-auth.js";
import { GithubAuthError, type GithubFetchFn } from "../src/github/types.js";

const REVIEWER_TOKEN = "ghs_reviewer-installation-token-12345678";

describe("github-app-auth: missing credential produces actionable error", () => {
  it("missing reviewer token names the exact env var, never a value", () => {
    const cache = createInstallationTokenCache();
    let error: unknown;
    try {
      resolveGithubCredential("reviewer", {}, cache);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(GithubAuthError);
    const auth = error as GithubAuthError;
    expect(auth.code).toBe("missing-credential");
    expect(auth.message).toContain("ORCA_PI_GITHUB_REVIEWER_TOKEN");
    expect(auth.message).toContain("Reviewer GitHub App");
    expect(auth.message).not.toContain(REVIEWER_TOKEN);
  });

  it("missing worker token is actionable without leaking", () => {
    const cache = createInstallationTokenCache();
    expect(() => resolveGithubCredential("worker", {}, cache)).toThrow(/ORCA_PI_GITHUB_WORKER_TOKEN/);
  });

  it("blank tokens count as missing", () => {
    const cache = createInstallationTokenCache();
    expect(() =>
      resolveGithubCredential("reviewer", { ORCA_PI_GITHUB_REVIEWER_TOKEN: "   " }, cache),
    ).toThrow(/Missing GitHub credential/);
  });
});

describe("github-app-auth: installation-token refresh/expiry", () => {
  it("resolves a fresh installation token with expiry", () => {
    const cache = createInstallationTokenCache();
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const credential = resolveGithubCredential(
      "reviewer",
      { ORCA_PI_GITHUB_REVIEWER_TOKEN: REVIEWER_TOKEN, ORCA_PI_GITHUB_REVIEWER_EXPIRES_AT: future },
      cache,
    );
    expect(credential.token).toBe(REVIEWER_TOKEN);
    expect(credential.sourceLabel).toContain("ORCA_PI_GITHUB_REVIEWER_TOKEN");
    expect(credential.expiresAt?.toISOString()).toBe(future);
  });

  it("expired tokens throw expired-token with refresh guidance", () => {
    const cache = createInstallationTokenCache();
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    let error: unknown;
    try {
      resolveGithubCredential(
        "reviewer",
        { ORCA_PI_GITHUB_REVIEWER_TOKEN: REVIEWER_TOKEN, ORCA_PI_GITHUB_REVIEWER_EXPIRES_AT: past },
        cache,
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(GithubAuthError);
    expect((error as GithubAuthError).code).toBe("expired-token");
    expect((error as Error).message).toMatch(/expired.*outside LLM context/i);
    expect((error as Error).message).not.toContain(REVIEWER_TOKEN);
  });

  it("cache honors expiry: expired entries are evicted, fresh ones reused", () => {
    let now = Date.now();
    const cache = createInstallationTokenCache({ now: () => now });
    const expiresAt = new Date(now + 10 * 60 * 1000);
    cache.set("reviewer", { token: REVIEWER_TOKEN, expiresAt });
    expect(cache.get("reviewer")?.token).toBe(REVIEWER_TOKEN);
    now += 15 * 60 * 1000; // past expiry + skew
    expect(cache.get("reviewer")).toBeUndefined();
  });

  it("invalid expiry strings are actionable", () => {
    const cache = createInstallationTokenCache();
    expect(() =>
      resolveGithubCredential(
        "reviewer",
        { ORCA_PI_GITHUB_REVIEWER_TOKEN: REVIEWER_TOKEN, ORCA_PI_GITHUB_REVIEWER_EXPIRES_AT: "not-a-date" },
        cache,
      ),
    ).toThrow(/Invalid expiry.*ISO-8601/);
  });

  it("Blocking 1: only the reviewer slot may perform review/check writes", () => {
    expect(() => assertReviewerIdentityForWrites("reviewer")).not.toThrow();
    expect(() => assertReviewerIdentityForWrites("worker")).toThrow(/must use the dedicated reviewer GitHub App/i);
    expect(() => assertReviewerIdentityForWrites("custom")).toThrow(/must use the dedicated reviewer GitHub App/i);
  });

  it("fetchAuthenticatedActor proves login/type via live GET /user (never token prefix)", async () => {
    const fetchFn: GithubFetchFn = vi.fn(async (url, init) => {
      expect(url.endsWith("/user")).toBe(true);
      expect(init.headers.Authorization).toBe(`Bearer ${REVIEWER_TOKEN}`);
      return { ok: true, status: 200, json: async () => ({ login: "orca-pi-reviewer[bot]", type: "Bot" }), text: async () => "{}" };
    });
    const actor = await fetchAuthenticatedActor("reviewer", { fetchFn, env: { ORCA_PI_GITHUB_REVIEWER_TOKEN: REVIEWER_TOKEN }, cache: createInstallationTokenCache() });
    expect(actor).toEqual({ login: "orca-pi-reviewer[bot]", type: "Bot" });
  });

  it("fetchPullRequestAuthor returns user.login for distinct-actor comparison", async () => {
    const fetchFn: GithubFetchFn = async () => ({ ok: true, status: 200, json: async () => ({ user: { login: "human-user" }, head: { sha: "abc1234" } }), text: async () => "{}" });
    const author = await fetchPullRequestAuthor({ owner: "o", repo: "r", pullNumber: 1 }, { fetchFn, token: REVIEWER_TOKEN });
    expect(author).toBe("human-user");
  });

  it("fetchPullRequestMeta returns author + head SHA for head-aware targeting", async () => {
    const { fetchPullRequestMeta } = await import("../src/github/github-app-auth.js");
    const fetchFn: GithubFetchFn = async () => ({ ok: true, status: 200, json: async () => ({ user: { login: "human-user" }, head: { sha: "deadbeef" } }), text: async () => "{}" });
    const meta = await fetchPullRequestMeta({ owner: "o", repo: "r", pullNumber: 1 }, { fetchFn, token: REVIEWER_TOKEN });
    expect(meta).toEqual({ authorLogin: "human-user", headSha: "deadbeef" });
  });

  it("resolveReviewerAppMetadata requires verified login + installation id (fail closed)", async () => {
    const { resolveReviewerAppMetadata } = await import("../src/github/github-app-auth.js");
    expect(resolveReviewerAppMetadata({ ORCA_PI_GITHUB_REVIEWER_LOGIN: "orca-pi-reviewer[bot]", ORCA_PI_GITHUB_REVIEWER_INSTALLATION_ID: "123" })).toEqual({ login: "orca-pi-reviewer[bot]", installationId: "123" });
    expect(() => resolveReviewerAppMetadata({})).toThrow(/Missing verified reviewer App identity/);
    expect(() => resolveReviewerAppMetadata({ ORCA_PI_GITHUB_REVIEWER_LOGIN: "x[bot]" })).toThrow(/ORCA_PI_GITHUB_REVIEWER_INSTALLATION_ID/);
  });

  it("proveInstallationTokenClass uses the IAT-supported endpoint (contract test)", async () => {
    const { proveInstallationTokenClass } = await import("../src/github/github-app-auth.js");
    // Real IAT behavior: GET /installation/repositories succeeds with a
    // repositories payload; GET /user is never consulted for IATs.
    const iatFetch: GithubFetchFn = vi.fn(async (url: string, init) => {
      expect(url).toContain("/installation/repositories");
      expect(url.endsWith("/user")).toBe(false);
      expect(init.headers.Authorization).toBe(`Bearer ${REVIEWER_TOKEN}`);
      return { ok: true, status: 200, json: async () => ({ total_count: 1, repositories: [{ id: 1, full_name: "o/r" }] }), text: async () => "{}" };
    });
    await expect(proveInstallationTokenClass("reviewer", { fetchFn: iatFetch, env: { ORCA_PI_GITHUB_REVIEWER_TOKEN: REVIEWER_TOKEN }, cache: createInstallationTokenCache() })).resolves.toBeUndefined();
    // Human PAT behavior: installation endpoint denies with 403 → actionable error, token redacted.
    const patFetch: GithubFetchFn = async () => ({ ok: false, status: 403, json: async () => ({}), text: async () => "forbidden" });
    let error: unknown;
    try {
      await proveInstallationTokenClass("reviewer", { fetchFn: patFetch, env: { ORCA_PI_GITHUB_REVIEWER_TOKEN: REVIEWER_TOKEN }, cache: createInstallationTokenCache() });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(GithubAuthError);
    expect((error as Error).message).toMatch(/installation.token|Reviewer GitHub App/i);
    expect((error as Error).message).not.toContain(REVIEWER_TOKEN);
  });

  it("verifyReviewerForReview enforces IAT class + distinct author (never GET /user)", async () => {
    const reviewerEnv = { ORCA_PI_GITHUB_REVIEWER_TOKEN: REVIEWER_TOKEN, ORCA_PI_GITHUB_REVIEWER_LOGIN: "orca-pi-reviewer[bot]", ORCA_PI_GITHUB_REVIEWER_INSTALLATION_ID: "123" };
    const HEAD = "feedfacefeedfacefeedfacefeedfacefeedface";
    const mkFetch = (prAuthor: string, installationStatus = 200): GithubFetchFn =>
      (async (url: string) => {
        if (url.includes("/installation/repositories")) {
          if (installationStatus !== 200) return { ok: false, status: installationStatus, json: async () => ({}), text: async () => "denied" };
          return { ok: true, status: 200, json: async () => ({ repositories: [] }), text: async () => "{}" };
        }
        if (url === "https://api.github.com/user") throw new Error("GET /user must never be called for installation tokens");
        return { ok: true, status: 200, json: async () => ({ user: { login: prAuthor }, head: { sha: HEAD } }), text: async () => "{}" };
      }) as GithubFetchFn;
    // Happy path: IAT + configured Bot distinct from author (head SHA captured).
    const ok = await verifyReviewerForReview("reviewer", { owner: "o", repo: "r", pullNumber: 1 }, { fetchFn: mkFetch("human-user"), env: reviewerEnv, cache: createInstallationTokenCache() });
    expect(ok).toEqual({ reviewerLogin: "orca-pi-reviewer[bot]", prAuthorLogin: "human-user", installationId: "123", headSha: HEAD });
    // Same login → same-actor rejection before any POST.
    const sameEnv = { ...reviewerEnv, ORCA_PI_GITHUB_REVIEWER_LOGIN: "human-user[bot]" };
    // Note: configured login must still look like a bot; use a bot login equal to author to trigger distinctness.
    await expect(verifyReviewerForReview("reviewer", { owner: "o", repo: "r", pullNumber: 1 }, { fetchFn: mkFetch("human-user[bot]"), env: sameEnv, cache: createInstallationTokenCache() })).rejects.toThrow(/same actor/i);
    // Non-IAT token (installation endpoint 403) → actionable before PR fetch.
    await expect(verifyReviewerForReview("reviewer", { owner: "o", repo: "r", pullNumber: 1 }, { fetchFn: mkFetch("human-user", 403), env: reviewerEnv, cache: createInstallationTokenCache() })).rejects.toThrow(/installation.token|Reviewer GitHub App/i);
    // Missing metadata → fail closed without network writes.
    await expect(verifyReviewerForReview("reviewer", { owner: "o", repo: "r", pullNumber: 1 }, { fetchFn: mkFetch("human-user"), env: { ORCA_PI_GITHUB_REVIEWER_TOKEN: REVIEWER_TOKEN }, cache: createInstallationTokenCache() })).rejects.toThrow(/Missing verified reviewer App identity/);
    // Human login in reviewer slot → refused even with valid IAT proof.
    const humanEnv = { ...reviewerEnv, ORCA_PI_GITHUB_REVIEWER_LOGIN: "human-user" };
    await expect(verifyReviewerForReview("reviewer", { owner: "o", repo: "r", pullNumber: 1 }, { fetchFn: mkFetch("other"), env: humanEnv, cache: createInstallationTokenCache() })).rejects.toThrow(/does not look like a GitHub App bot/i);
  });

  it("verifyReviewerForChecks enforces IAT identity for check writes", async () => {
    const reviewerEnv = { ORCA_PI_GITHUB_REVIEWER_TOKEN: REVIEWER_TOKEN, ORCA_PI_GITHUB_REVIEWER_LOGIN: "orca-pi-reviewer[bot]", ORCA_PI_GITHUB_REVIEWER_INSTALLATION_ID: "123" };
    const botFetch: GithubFetchFn = async (url) => {
      if (url.includes("/installation/repositories")) return { ok: true, status: 200, json: async () => ({ repositories: [] }), text: async () => "{}" };
      if (url === "https://api.github.com/user") throw new Error("GET /user must never be called for installation tokens");
      throw new Error(`unexpected ${url}`);
    };
    await expect(verifyReviewerForChecks("reviewer", { fetchFn: botFetch, env: reviewerEnv, cache: createInstallationTokenCache() })).resolves.toEqual({ reviewerLogin: "orca-pi-reviewer[bot]", installationId: "123" });
    await expect(verifyReviewerForChecks("worker", { fetchFn: botFetch, env: { ORCA_PI_GITHUB_WORKER_TOKEN: "x" }, cache: createInstallationTokenCache() })).rejects.toThrow(/must use the dedicated reviewer/i);
  });

  it("status reports configured/expired/missing without values", () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const past = new Date(Date.now() - 3600_000).toISOString();
    const ok = describeCredentialStatus(
      "reviewer",
      { ORCA_PI_GITHUB_REVIEWER_TOKEN: REVIEWER_TOKEN, ORCA_PI_GITHUB_REVIEWER_EXPIRES_AT: future },
      createInstallationTokenCache(),
    );
    expect(ok.configured).toBe(true);
    expect(JSON.stringify(ok)).not.toContain(REVIEWER_TOKEN);

    const expired = describeCredentialStatus(
      "reviewer",
      { ORCA_PI_GITHUB_REVIEWER_TOKEN: REVIEWER_TOKEN, ORCA_PI_GITHUB_REVIEWER_EXPIRES_AT: past },
      createInstallationTokenCache(),
    );
    expect(expired.configured).toBe(false);
    expect(expired.expired).toBe(true);

    const missing = describeCredentialStatus("reviewer", {}, createInstallationTokenCache());
    expect(missing.configured).toBe(false);
  });
});

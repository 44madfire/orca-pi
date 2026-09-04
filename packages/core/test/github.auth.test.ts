import { describe, expect, it } from "vitest";
import {
  createInstallationTokenCache,
  describeCredentialStatus,
  resolveGithubCredential,
} from "../src/github/github-app-auth.js";
import { GithubAuthError } from "../src/github/types.js";

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

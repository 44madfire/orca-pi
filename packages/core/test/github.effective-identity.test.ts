import { describe, expect, it } from "vitest";
import {
  EFFECTIVE_IDENTITY_ENV_VAR,
  prefixTerminalCommandWithIdentity,
  resolveEffectiveGithubIdentity,
  resolveIdentityWithEnvFallback,
} from "../src/github/effective-identity.js";
import { GithubAuthError } from "../src/github/types.js";
import { getBuiltinProfilesDocument } from "../src/profile/builtins.js";
import { resolveProfile } from "../src/profile/resolve.js";

describe("effective identity: profile inheritance", () => {
  it("worker profile resolves to worker without explicit override", () => {
    const builtins = getBuiltinProfilesDocument();
    const worker = resolveProfile("worker", builtins);
    expect(worker.githubIdentity).toBe("worker");
    expect(resolveEffectiveGithubIdentity(worker, {})).toBe("worker");
  });

  it("reviewer profile resolves to reviewer without explicit override", () => {
    const builtins = getBuiltinProfilesDocument();
    const reviewer = resolveProfile("reviewer", builtins);
    expect(reviewer.githubIdentity).toBe("reviewer");
    expect(resolveEffectiveGithubIdentity(reviewer, {})).toBe("reviewer");
  });

  it("matching explicit override passes through", () => {
    const builtins = getBuiltinProfilesDocument();
    const worker = resolveProfile("worker", builtins);
    expect(resolveEffectiveGithubIdentity(worker, { explicitIdentity: "worker" })).toBe("worker");
  });

  it("scout (no identity) with no override resolves to undefined", () => {
    const builtins = getBuiltinProfilesDocument();
    const scout = resolveProfile("scout", builtins);
    expect(scout.githubIdentity).toBeUndefined();
    expect(resolveEffectiveGithubIdentity(scout, {})).toBeUndefined();
  });

  it("scout with explicit diagnostics identity is allowed", () => {
    const builtins = getBuiltinProfilesDocument();
    const scout = resolveProfile("scout", builtins);
    expect(resolveEffectiveGithubIdentity(scout, { explicitIdentity: "worker" })).toBe("worker");
  });
});

describe("effective identity: escalation is refused", () => {
  it("reviewer profile cannot select worker credentials", () => {
    const builtins = getBuiltinProfilesDocument();
    const reviewer = resolveProfile("reviewer", builtins);
    let error: unknown;
    try {
      resolveEffectiveGithubIdentity(reviewer, { explicitIdentity: "worker" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(GithubAuthError);
    expect((error as GithubAuthError).code).toBe("unauthorized-installation");
    expect(String((error as Error).message)).toMatch(/authoritative|cannot select worker/i);
  });

  it("worker profile cannot select reviewer credentials", () => {
    const builtins = getBuiltinProfilesDocument();
    const worker = resolveProfile("worker", builtins);
    expect(() => resolveEffectiveGithubIdentity(worker, { explicitIdentity: "reviewer" })).toThrow(
      /authoritative|reviewer/i,
    );
  });
});

describe("effective identity: env fallback", () => {
  it("inherits ORCA_PI_GITHUB_IDENTITY when profile has none", () => {
    const builtins = getBuiltinProfilesDocument();
    const scout = resolveProfile("scout", builtins);
    const effective = resolveIdentityWithEnvFallback(scout, {
      env: { [EFFECTIVE_IDENTITY_ENV_VAR]: "worker" },
    });
    expect(effective).toBe("worker");
  });

  it("profile wins over matching env", () => {
    const builtins = getBuiltinProfilesDocument();
    const worker = resolveProfile("worker", builtins);
    const effective = resolveIdentityWithEnvFallback(worker, {
      env: { [EFFECTIVE_IDENTITY_ENV_VAR]: "worker" },
    });
    expect(effective).toBe("worker");
  });

  it("mismatched env fails closed", () => {
    const builtins = getBuiltinProfilesDocument();
    const worker = resolveProfile("worker", builtins);
    expect(() =>
      resolveIdentityWithEnvFallback(worker, {
        env: { [EFFECTIVE_IDENTITY_ENV_VAR]: "reviewer" },
      }),
    ).toThrow(/ORCA_PI_GITHUB_IDENTITY.*reviewer/i);
  });

  it("no profile, no explicit, no env resolves to undefined", () => {
    const builtins = getBuiltinProfilesDocument();
    const scout = resolveProfile("scout", builtins);
    expect(resolveIdentityWithEnvFallback(scout, { env: {} })).toBeUndefined();
  });
});

describe("terminal command prefix: per-process scoping", () => {
  it("prefixes identity + profile without secrets", () => {
    const prefixed = prefixTerminalCommandWithIdentity("pi --thinking high", {
      githubIdentity: "worker",
      profileName: "worker",
    });
    expect(prefixed).toContain(`${EFFECTIVE_IDENTITY_ENV_VAR}=worker`);
    expect(prefixed).toContain("ORCA_PI_PROFILE=worker");
    expect(prefixed).toContain("pi --thinking high");
    expect(prefixed).not.toContain("ghs_");
    expect(prefixed).not.toContain("ghp_");
  });

  it("leaves command untouched when no identity/profile", () => {
    expect(prefixTerminalCommandWithIdentity("pi --x", {})).toBe("pi --x");
  });
});

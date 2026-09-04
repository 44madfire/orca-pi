import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AGENT_REVIEW_CHECK_NAME,
  assertDistinctGithubActors,
  assertReviewerHasNoWriteTools,
  collectSecretsFromEnv,
  githubPermissionsForIdentity,
  redactSecretsFromText,
  redactTokenLikeValues,
  sanitizeErrorForDisplay,
  tokenEnvVarForIdentity,
} from "../src/github/identity.js";
import { getBuiltinProfilesDocument } from "../src/profile/builtins.js";
import { parseAndValidateProfilesText } from "../src/profile/load.js";
import { resolveProfile } from "../src/profile/resolve.js";
import { validateProfilesDocument } from "../src/profile/schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

describe("github identity: permissions", () => {
  it("reviewer holds Contents: read only (never write)", () => {
    const perms = githubPermissionsForIdentity("reviewer");
    expect(perms.contents).toBe("read");
    expect(perms.pullRequests).toBe("write");
    expect(perms.checks).toBe("write");
    expect(perms.metadata).toBe("read");
  });

  it("worker may hold Contents: write for pushes/PR creation", () => {
    const perms = githubPermissionsForIdentity("worker");
    expect(perms.contents).toBe("write");
    expect(perms.pullRequests).toBe("write");
  });

  it("reviewer check name is deterministic for rulesets", () => {
    expect(AGENT_REVIEW_CHECK_NAME).toBe("orca-pi/agent-review");
  });

  it("token env slots are deterministic and log-safe (names, not values)", () => {
    expect(tokenEnvVarForIdentity("reviewer")).toBe("ORCA_PI_GITHUB_REVIEWER_TOKEN");
    expect(tokenEnvVarForIdentity("worker")).toBe("ORCA_PI_GITHUB_WORKER_TOKEN");
    expect(tokenEnvVarForIdentity("reviewer")).not.toContain("ghs_");
  });
});

describe("github identity: same-account PATs are not distinct", () => {
  it("same login (case-insensitive) throws distinct-actor error", () => {
    expect(() =>
      assertDistinctGithubActors({ workerLogin: "Octo-User", reviewerLogin: "octo-user" }),
    ).toThrow(/same actor/i);
  });

  it("different logins pass", () => {
    expect(() =>
      assertDistinctGithubActors({ workerLogin: "human-user", reviewerLogin: "orca-pi-reviewer[bot]" }),
    ).not.toThrow();
  });

  it("identical token fingerprints without logins throw", () => {
    expect(() =>
      assertDistinctGithubActors({ workerTokenFingerprint: "abc", reviewerTokenFingerprint: "abc" }),
    ).toThrow(/same credential/i);
  });

  it("different fingerprints pass", () => {
    expect(() =>
      assertDistinctGithubActors({ workerTokenFingerprint: "abc", reviewerTokenFingerprint: "def" }),
    ).not.toThrow();
  });
});

describe("github identity: reviewer cannot request source-write", () => {
  it("schema rejects reviewer + edit/write tools in the same entry", () => {
    let error: unknown;
    try {
      validateProfilesDocument(
        { profiles: { reviewer: { githubIdentity: "reviewer", tools: ["read", "edit"] } } },
        "reviewer-write.yaml",
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).toMatch(/reviewer.*must not request source-write/i);
  });

  it("schema accepts reviewer without write tools and worker with write tools", () => {
    const doc = validateProfilesDocument(
      {
        profiles: {
          reviewer: { githubIdentity: "reviewer", tools: ["read", "bash"] },
          worker: { githubIdentity: "worker", tools: ["read", "edit", "write"] },
        },
      },
      "ok.yaml",
    );
    expect(doc.profiles.reviewer?.githubIdentity).toBe("reviewer");
    expect(doc.profiles.worker?.githubIdentity).toBe("worker");
  });

  it("Blocking 2: resolve fails closed for inherited reviewer write tools (authoritative boundary)", async () => {
    const doc = validateProfilesDocument(
      {
        profiles: {
          base: { tools: ["read", "edit"] },
          audit: { extends: "base", githubIdentity: "reviewer" },
        },
      },
      "inherited.yaml",
    );
    // resolveProfile itself throws (not just the optional helper) so every
    // production path (validate/show/inspect/launch) fails closed.
    let error: unknown;
    try {
      resolveProfile("audit", doc);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as { code?: string }).code).toBe("invalid-github-identity");
    expect(String((error as Error).message)).toMatch(/source-write tools/i);
    // The helper remains for direct ResolvedPiProfile checks (defense in depth).
    const { ProfileResolveError } = await import("../src/profile/resolve.js");
    expect(error).toBeInstanceOf(ProfileResolveError);
    // validateAllProfiles marks the profile invalid via the same boundary.
    const { validateAllProfiles } = await import("../src/profile/presentation.js");
    const entries = validateAllProfiles({ mergedDoc: doc });
    const audit = entries.find((entry) => entry.name === "audit");
    expect(audit?.valid).toBe(false);
    expect(audit?.code).toBe("invalid-github-identity");
  });

  it("builtin reviewer passes the guard; builtins carry logical identities", () => {
    const builtins = getBuiltinProfilesDocument();
    const reviewer = resolveProfile("reviewer", builtins);
    const worker = resolveProfile("worker", builtins);
    expect(reviewer.githubIdentity).toBe("reviewer");
    expect(worker.githubIdentity).toBe("worker");
    expect(() => assertReviewerHasNoWriteTools(reviewer)).not.toThrow();
    expect(() => assertReviewerHasNoWriteTools(worker)).not.toThrow();
  });

  it("githubIdentity validates as a logical slot, never a secret", () => {
    let error: unknown;
    try {
      validateProfilesDocument(
        { profiles: { reviewer: { githubIdentity: "ghs_abc123!!" } } },
        "bad-identity.yaml",
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).toMatch(/logical GitHub identity/i);
  });
});

describe("github identity: shipped YAML stays in sync with builtins", () => {
  it("worker.yaml → worker, reviewer.yaml → reviewer, scout.yaml unset", () => {
    for (const [name, expected] of [["worker", "worker"], ["reviewer", "reviewer"]] as const) {
      const text = readFileSync(join(repoRoot, "profiles", `${name}.yaml`), "utf8");
      const doc = parseAndValidateProfilesText(text, `profiles/${name}.yaml`);
      expect(resolveProfile(name, doc).githubIdentity).toBe(expected);
    }
    const scoutText = readFileSync(join(repoRoot, "profiles", "scout.yaml"), "utf8");
    const scoutDoc = parseAndValidateProfilesText(scoutText, "profiles/scout.yaml");
    expect(resolveProfile("scout", scoutDoc).githubIdentity).toBeUndefined();
  });
});

describe("github identity: secret redaction", () => {
  it("redacts ghp/ghs/pat shapes from text", () => {
    const text = "token ghp_abcdefgh12345678 and ghs_zxywvuts12345678 plus github_pat_ABCDEF1234567890 done";
    const redacted = redactTokenLikeValues(text);
    expect(redacted).not.toContain("ghp_abcdefgh12345678");
    expect(redacted).not.toContain("ghs_zxywvuts12345678");
    expect(redacted).not.toContain("github_pat_ABCDEF1234567890");
    expect(redacted).toContain("<redacted-token>");
  });

  it("redacts explicit env-sourced secrets", () => {
    const secret = "super-secret-installation-token-value";
    const redacted = redactSecretsFromText(`failed with ${secret} here`, [secret]);
    expect(redacted).not.toContain(secret);
    expect(redacted).toContain("<redacted>");
  });

  it("sanitizes errors without leaking token env values", () => {
    const env = { ORCA_PI_GITHUB_REVIEWER_TOKEN: "ghs_reviewer-secret-12345678" };
    const error = new Error(`call failed with ${env.ORCA_PI_GITHUB_REVIEWER_TOKEN}`);
    const safe = sanitizeErrorForDisplay(error, env);
    expect(safe).not.toContain(env.ORCA_PI_GITHUB_REVIEWER_TOKEN);
    expect(collectSecretsFromEnv(env)).toContain(env.ORCA_PI_GITHUB_REVIEWER_TOKEN);
  });
});

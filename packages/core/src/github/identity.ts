/**
 * GitHub identity selection and safety guards (OP1.9 / JEF-15).
 *
 * Identities are logical credential slots (`worker`, `reviewer`) referenced
 * from profile config (`githubIdentity`) and resolved to tokens at
 * launch/runtime through `github-app-auth.ts`. This module never touches
 * secrets itself — it only maps identities to permission sets, validates
 * distinct-actor requirements, and redacts token-like values from logs.
 *
 * Identity model:
 * ```text
 * Human / worker identity  → create/update PR
 * Reviewer GitHub App      → PR review comments, REQUEST_CHANGES/APPROVE,
 *                            orca-pi/agent-review check run
 * ```
 */

import { REVIEWER_FORBIDDEN_TOOLS } from "../profile/schema.js";
import type { ResolvedPiProfile } from "../profile/types.js";
import {
  AGENT_REVIEW_CHECK_NAME,
  REVIEWER_IDENTITY,
  WORKER_IDENTITY,
  type GithubIdentity,
  type GithubRepoPermissions,
} from "./types.js";

export { AGENT_REVIEW_CHECK_NAME, REVIEWER_IDENTITY, WORKER_IDENTITY };

/** Logical identities V1 knows by name (custom identities allowed). */
export const KNOWN_GITHUB_IDENTITIES: readonly string[] = [
  WORKER_IDENTITY,
  REVIEWER_IDENTITY,
] as const;

/**
 * Minimum repository permissions per identity (GitHub App permission names).
 *
 * Reviewer is intentionally read-only for contents: it may comment/review
 * PRs and publish checks but must never push code. The worker (human or
 * future worker App) needs contents write for pushes and PR creation.
 */
export function githubPermissionsForIdentity(
  identity: GithubIdentity,
): GithubRepoPermissions {
  if (identity === REVIEWER_IDENTITY) {
    return {
      contents: "read",
      pullRequests: "write",
      checks: "write",
      metadata: "read",
    };
  }
  return {
    contents: "write",
    pullRequests: "write",
    checks: "none",
    metadata: "read",
  };
}

/** True when the identity is the canonical reviewer App slot. */
export function isReviewerIdentity(identity: GithubIdentity): boolean {
  return identity === REVIEWER_IDENTITY;
}

/**
 * Guard: a resolved reviewer profile must never carry Pi source-write
 * tools (`edit`/`write`). Schema validation catches direct violations;
 * this catches inherited ones (`extends` cannot smuggle write access in).
 *
 * Throws with an actionable message naming the profile and the offending
 * tools. Never throws for non-reviewer identities.
 */
export function assertReviewerHasNoWriteTools(
  profile: ResolvedPiProfile,
): void {
  if (profile.githubIdentity !== REVIEWER_IDENTITY) return;
  const tools = profile.tools ?? [];
  const offending = tools.filter((tool) =>
    (REVIEWER_FORBIDDEN_TOOLS as readonly string[]).includes(tool),
  );
  if (offending.length > 0) {
    throw new Error(
      `Pi profile "${profile.name}" uses reviewer githubIdentity but requests source-write tools (${offending.map((tool) => `"${tool}"`).join(", ")}). ` +
        `The reviewer GitHub App holds Contents: read only — remove "edit"/"write" from this profile (reviewers describe follow-ups; they never edit files).`,
    );
  }
}

/**
 * Distinct-actor guard: worker and reviewer must not resolve to the same
 * GitHub account.
 *
 * Using two PATs for the same user does NOT create distinct actors —
 * GitHub attributes PR authorship/reviews to the authenticated account, so
 * a reviewer on the same account cannot formally approve/request changes
 * on its own PR. Compare authenticated logins (case-insensitive), not just
 * token inequality: equal tokens are trivially the same actor, but
 * different tokens for the same user are also the same actor.
 *
 * Throws with an actionable remediation (install the reviewer GitHub App).
 */
export function assertDistinctGithubActors(options: {
  workerLogin?: string;
  reviewerLogin?: string;
  workerTokenFingerprint?: string;
  reviewerTokenFingerprint?: string;
}): void {
  const normalize = (login: string): string => login.trim().toLowerCase();
  const { workerLogin, reviewerLogin } = options;
  if (workerLogin !== undefined && reviewerLogin !== undefined) {
    if (normalize(workerLogin) === normalize(reviewerLogin) && normalize(workerLogin).length > 0) {
      throw new Error(
        `GitHub worker and reviewer resolve to the same actor ("${workerLogin}"). ` +
          `Same-account PATs are not distinct identities — GitHub attributes PR authorship/reviews to the authenticated account, so the reviewer cannot formally approve/request changes on its own PR. ` +
          `Install the Orca-Pi Reviewer GitHub App on the repository and configure a distinct reviewer installation token (see docs for ORCA_PI_GITHUB_REVIEWER_TOKEN).`,
      );
    }
    return;
  }
  // Fallback when logins are unavailable (offline): identical token
  // fingerprints are definitely the same actor.
  const { workerTokenFingerprint, reviewerTokenFingerprint } = options;
  if (
    workerTokenFingerprint !== undefined &&
    reviewerTokenFingerprint !== undefined &&
    workerTokenFingerprint === reviewerTokenFingerprint
  ) {
    throw new Error(
      `GitHub worker and reviewer use the same credential (identical token fingerprint). ` +
        `Same-account PATs are not distinct identities — configure a distinct reviewer GitHub App installation token.`,
    );
  }
}

/**
 * Env-var slot for an identity's token. Deterministic and safe to log
 * (the name, never the value):
 * `ORCA_PI_GITHUB_<IDENTITY>_TOKEN` (uppercased, `-` → `_`).
 */
export function tokenEnvVarForIdentity(identity: GithubIdentity): string {
  const slot = identity
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `ORCA_PI_GITHUB_${slot || "TOKEN"}_TOKEN`;
}

/** Expiry env-var slot: `ORCA_PI_GITHUB_<IDENTITY>_EXPIRES_AT` (ISO-8601). */
export function expiryEnvVarForIdentity(identity: GithubIdentity): string {
  return tokenEnvVarForIdentity(identity).replace(/_TOKEN$/, "_EXPIRES_AT");
}

/** Token-like patterns that must never appear in logs/errors. */
const TOKEN_PATTERNS: readonly RegExp[] = [
  /\bghp_[A-Za-z0-9]{8,}\b/g,
  /\bghu_[A-Za-z0-9]{8,}\b/g,
  /\bghs_[A-Za-z0-9]{8,}\b/g,
  /\bghr_[A-Za-z0-9]{8,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{8,}\b/g,
  /\bx-access-token:[^\s"']+/g,
];

/**
 * Redact GitHub token-like values from free text for logs/errors.
 * Replaces matches with `<redacted-token>`; never throws.
 */
export function redactTokenLikeValues(text: string): string {
  if (!text) return text;
  let out = text;
  for (const pattern of TOKEN_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, "<redacted-token>");
  }
  return out;
}

/**
 * Redact explicit secret values (e.g. env-sourced tokens) from text.
 * Each non-empty secret is replaced with `<redacted>`; token-like shapes
 * are additionally scrubbed via {@link redactTokenLikeValues}.
 */
export function redactSecretsFromText(
  text: string,
  secrets: readonly string[],
): string {
  let out = redactTokenLikeValues(text);
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue;
    // Avoid replacing tiny substrings that would mangle normal prose.
    out = out.split(secret).join("<redacted>");
  }
  return out;
}

/**
 * Collect redactable secret values from an env mapping without logging
 * them: any `*TOKEN*`, `*SECRET*`, `*PRIVATE_KEY*` value plus token-like
 * values in any var. Callers pass the result to
 * {@link redactSecretsFromText} / {@link sanitizeErrorForDisplay}.
 */
export function collectSecretsFromEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): string[] {
  const secrets: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string" || value.length === 0) continue;
    const upper = key.toUpperCase();
    if (
      upper.includes("TOKEN") ||
      upper.includes("SECRET") ||
      upper.includes("PRIVATE_KEY")
    ) {
      secrets.push(value);
      continue;
    }
    // Token-shaped values in otherwise innocent vars (defense in depth).
    if (
      /^(ghp_|ghu_|ghs_|ghr_|github_pat_)/.test(value) &&
      value.length >= 12
    ) {
      secrets.push(value);
    }
  }
  return secrets;
}

/**
 * Sanitize an error for display: message + name, with all known secrets
 * and token-like values redacted. Never includes token values.
 */
export function sanitizeErrorForDisplay(
  error: unknown,
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
): string {
  const raw = error instanceof Error ? error.message : String(error);
  const secrets = env ? collectSecretsFromEnv(env) : [];
  return redactSecretsFromText(raw, secrets);
}

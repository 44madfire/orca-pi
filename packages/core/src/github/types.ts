/**
 * Shared GitHub automation types (OP1.9 / JEF-15).
 *
 * Distinct GitHub actors for implementation vs review so Orca-Pi agents do
 * not all act as the same human account. The reviewer acts through a
 * dedicated GitHub App installation (PR reviews + check runs); the worker
 * uses the human/machine-user credential for pushes and PR creation.
 *
 * Design rules:
 * - Profile config references a logical identity (`worker`, `reviewer`),
 *   never a secret. Tokens are resolved at launch/runtime via
 *   `github-app-auth.ts` (env / helper process) and never enter Pi
 *   prompts, task text, or normal logs.
 * - All network access is injectable (`fetchFn`) so unit tests never hit
 *   github.com.
 * - Human remains the final merge authority by default — helpers never
 *   auto-merge.
 */

import type { ResolvedPiProfile } from "../profile/types.js";

/** Logical GitHub automation identity (credential slot, not a secret). */
export type GithubIdentity = string;

/** Canonical identities (see `GITHUB_IDENTITY_PATTERN` in profile schema). */
export const WORKER_IDENTITY: GithubIdentity = "worker";
export const REVIEWER_IDENTITY: GithubIdentity = "reviewer";

/**
 * Deterministic automated-review check name, suitable for branch
 * protection / rulesets once stable.
 */
export const AGENT_REVIEW_CHECK_NAME = "orca-pi/agent-review";

/** Formal PR review verdicts (GitHub review `event` values). */
export type ReviewVerdict = "approve" | "request-changes" | "comment";

/** GitHub review `event` values (uppercase API form). */
export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

/** GitHub check-run `conclusion` values used by the agent review check. */
export type CheckConclusion = "success" | "failure" | "neutral";

/** GitHub check-run `status` values. */
export type CheckStatus = "queued" | "in_progress" | "completed";

/** Minimal repository permission set (subset of GitHub App permissions). */
export interface GithubRepoPermissions {
  contents: "read" | "write";
  pullRequests: "read" | "write";
  checks: "read" | "write" | "none";
  metadata: "read";
}

/** Provenance carried in review/check summaries (never prompt content). */
export interface ReviewProvenance {
  taskId?: string;
  linearIssueId?: string;
  profile?: string;
  /** PR author login when known (used for distinct-actor diagnostics). */
  prAuthor?: string;
}

/** Structured reviewer findings (blocking vs non-blocking). */
export interface ReviewFindings {
  blocking: string[];
  nonBlocking: string[];
}

/** Input for submitting a formal PR review. */
export interface SubmitReviewInput {
  owner: string;
  repo: string;
  pullNumber: number;
  verdict: ReviewVerdict;
  body: string;
  /** Head SHA the review applies to (passed as `commit_id` when known). */
  commitId?: string;
  provenance?: ReviewProvenance;
}

/** GitHub `POST /repos/{owner}/{repo}/pulls/{n}/reviews` payload. */
export interface ReviewPayload {
  commit_id?: string;
  body: string;
  event: ReviewEvent;
}

/** Result metadata returned to Orca (review + check identifiers). */
export interface ReviewResultMeta {
  reviewId?: number;
  reviewHtmlUrl?: string;
  checkRunId?: number;
  checkHtmlUrl?: string;
  verdict: ReviewVerdict;
  conclusion: CheckConclusion;
}

/** Input for creating/updating the deterministic agent-review check. */
export interface CheckRunInput {
  owner: string;
  repo: string;
  headSha: string;
  status: CheckStatus;
  conclusion?: CheckConclusion;
  summary: string;
  text?: string;
  provenance?: ReviewProvenance;
}

/** Minimal fetch-compatible response used by the injectable HTTP layer. */
export interface GithubHttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/** Injectable `fetch` shape (defaults to global `fetch`). */
export type GithubFetchFn = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
  },
) => Promise<GithubHttpResponse>;

/** Resolved credential for one identity (token kept out of logs). */
export interface ResolvedGithubCredential {
  identity: GithubIdentity;
  /** Env var (or helper label) the token was sourced from — safe to log. */
  sourceLabel: string;
  /** Installation token or PAT. Never log this value. */
  token: string;
  /** Expiry of installation tokens (undefined for long-lived PATs). */
  expiresAt?: Date;
  /** GitHub App installation id when the token is an installation token. */
  installationId?: string;
}

/** Actionable auth failure (missing/expired/unauthorized installation). */
export class GithubAuthError extends Error {
  readonly identity: string;
  readonly code:
    | "missing-credential"
    | "expired-token"
    | "unauthorized-installation"
    | "helper-failed";
  constructor(
    identity: string,
    code: GithubAuthError["code"],
    message: string,
  ) {
    super(message);
    this.name = "GithubAuthError";
    this.identity = identity;
    this.code = code;
  }
}

/** Actionable API failure (network/validation, secrets already redacted). */
export class GithubApiError extends Error {
  readonly status: number;
  readonly endpoint: string;
  constructor(endpoint: string, status: number, message: string) {
    super(message);
    this.name = "GithubApiError";
    this.endpoint = endpoint;
    this.status = status;
  }
}

/** Convenience: profile's logical GitHub identity, if configured. */
export function githubIdentityForProfile(
  profile: Pick<ResolvedPiProfile, "githubIdentity">,
): GithubIdentity | undefined {
  return profile.githubIdentity;
}

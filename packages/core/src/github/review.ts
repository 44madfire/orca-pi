/**
 * Formal PR review submission (OP1.9 / JEF-15).
 *
 * The reviewer GitHub App submits `COMMENT`, `REQUEST_CHANGES`, or
 * `APPROVE` through `POST /repos/{owner}/{repo}/pulls/{n}/reviews`:
 * - blocking findings → `REQUEST_CHANGES`
 * - no blocking findings → `APPROVE` (or `COMMENT` per policy)
 *
 * Helpers here are pure (payload builders, PR parsing, verdict mapping)
 * plus a thin injectable HTTP layer — unit tests never hit github.com.
 * Credentials are resolved via `github-app-auth.ts` behind the logical
 * identity name; tokens never enter logs (see `identity.ts` redaction).
 *
 * GitHub references:
 * - https://docs.github.com/en/rest/pulls/reviews
 */

import {
  defaultTokenCache,
  resolveGithubCredential,
  toAuthError,
  verifyReviewerForReview,
  type InstallationTokenCache,
} from "./github-app-auth.js";
import { redactSecretsFromText } from "./identity.js";
import {
  GithubApiError,
  type GithubFetchFn,
  type GithubIdentity,
  type ReviewEvent,
  type ReviewPayload,
  type ReviewProvenance,
  type ReviewVerdict,
  type SubmitReviewInput,
} from "./types.js";

/** Map a worker-facing verdict to the GitHub review `event`. */
export function verdictToReviewEvent(verdict: ReviewVerdict): ReviewEvent {
  switch (verdict) {
    case "approve":
      return "APPROVE";
    case "request-changes":
      return "REQUEST_CHANGES";
    case "comment":
      return "COMMENT";
  }
}

/** Parse `--verdict` CLI values (accepts `request_changes` alias). */
export function parseReviewVerdict(raw: string): ReviewVerdict {
  const normalized = raw.trim().toLowerCase().replace(/_/g, "-");
  if (normalized === "approve" || normalized === "request-changes" || normalized === "comment") {
    return normalized;
  }
  throw new Error(
    `Invalid --verdict ${JSON.stringify(raw)}: expected "approve", "request-changes", or "comment".`,
  );
}

/** Parse `--pr <url|number>` into `{ owner, repo, pullNumber }` (repo from `--repo` for numbers). */
export function parsePullRequestRef(
  ref: string,
  options?: { repo?: string },
): { owner: string; repo: string; pullNumber: number } {
  const trimmed = ref.trim();
  // Numeric form: requires --repo owner/name.
  if (/^\d+$/.test(trimmed)) {
    const repo = options?.repo?.trim();
    if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
      throw new Error(
        `PR "${trimmed}" is a bare number — pass --repo <owner/repo> (e.g. --repo octo/hello-world --pr ${trimmed}).`,
      );
    }
    const [owner, repoName] = repo.split("/") as [string, string];
    return { owner, repo: repoName, pullNumber: Number.parseInt(trimmed, 10) };
  }
  // URL forms: https://github.com/o/r/pull/123 (+ query/hash tolerance).
  const urlMatch = /^https?:\/\/[^/]+\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(trimmed);
  if (urlMatch) {
    const owner = urlMatch[1] as string;
    const repoName = urlMatch[2] as string;
    const num = urlMatch[3] as string;
    return { owner, repo: repoName.replace(/\.git$/, ""), pullNumber: Number.parseInt(num, 10) };
  }
  // Shorthand owner/repo#123.
  const shorthand = /^([^/\s]+)\/([^/\s#]+)#(\d+)$/.exec(trimmed);
  if (shorthand) {
    const owner = shorthand[1] as string;
    const repoName = shorthand[2] as string;
    const num = shorthand[3] as string;
    return { owner, repo: repoName, pullNumber: Number.parseInt(num, 10) };
  }
  throw new Error(
    `Invalid --pr ${JSON.stringify(ref)}: expected a PR URL (https://github.com/<owner>/<repo>/pull/<n>), "owner/repo#<n>", or a number with --repo <owner/repo>.`,
  );
}

/**
 * Format the review body with a machine-readable provenance footer.
 * Preserves Task/Dispatch provenance (task/Linear/profile) without leaking
 * prompt content — callers pass only IDs, never prompt text.
 */
export function formatReviewBody(
  body: string,
  provenance?: ReviewProvenance,
): string {
  const trimmed = body.trim();
  if (!provenance || (!provenance.taskId && !provenance.linearIssueId && !provenance.profile)) {
    return body;
  }
  const parts: string[] = [];
  if (provenance.profile) parts.push(`profile: ${provenance.profile}`);
  if (provenance.taskId) parts.push(`task: ${provenance.taskId}`);
  if (provenance.linearIssueId) parts.push(`linear: ${provenance.linearIssueId}`);
  if (parts.length === 0) return body;
  return `${trimmed}\n\n---\n🤖 orca-pi agent-review (${parts.join(" · ")}) · human remains merge authority`;
}

/** Build the `POST .../reviews` payload (pure, no I/O). */
export function buildReviewPayload(input: {
  verdict: ReviewVerdict;
  body: string;
  commitId?: string;
  provenance?: ReviewProvenance;
}): ReviewPayload {
  const body = formatReviewBody(input.body, input.provenance);
  if (!body.trim()) {
    throw new Error("Review body must not be empty — provide findings with file/line evidence.");
  }
  return {
    ...(input.commitId ? { commit_id: input.commitId } : {}),
    body,
    event: verdictToReviewEvent(input.verdict),
  };
}

function defaultFetch(): GithubFetchFn {
  const globalFetch = (globalThis as { fetch?: unknown }).fetch;
  if (typeof globalFetch !== "function") {
    throw new Error(
      "No fetch implementation available — pass an explicit fetchFn (Node >= 18 provides global fetch).",
    );
  }
  return async (url, init) => {
    const response = await (globalFetch as typeof fetch)(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
    });
    return {
      ok: response.ok,
      status: response.status,
      json: () => response.json() as Promise<unknown>,
      text: () => response.text(),
    };
  };
}

/** Existing PR review record (subset of `GET .../pulls/{n}/reviews`). */
export interface ExistingPullReview {
  id: number;
  userLogin?: string;
  state?: string;
  body?: string;
  commitId?: string;
}

/**
 * List existing reviews for a PR (newest last in API order). Used for
 * retry idempotency: a retry with identical `(reviewer, event, body,
 * commit)` returns the existing review instead of POSTing a duplicate.
 */
export async function listPullReviews(
  identity: GithubIdentity,
  input: { owner: string; repo: string; pullNumber: number },
  options?: {
    fetchFn?: GithubFetchFn;
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    cache?: InstallationTokenCache;
    apiBase?: string;
  },
): Promise<ExistingPullReview[]> {
  const env = options?.env ?? process.env;
  const cache = options?.cache ?? defaultTokenCache;
  const credential = resolveGithubCredential(identity, env, cache);
  const fetchFn = options?.fetchFn ?? defaultFetch();
  const apiBase = (options?.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
  const endpoint = `/repos/${input.owner}/${input.repo}/pulls/${input.pullNumber}/reviews?per_page=50`;
  const response = await fetchFn(`${apiBase}${endpoint}`, {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${credential.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    const authError = toAuthError(identity, response.status, endpoint);
    if (authError) throw authError;
    const text = await response.text().catch(() => "");
    throw new GithubApiError(endpoint, response.status, `GitHub list reviews failed (${response.status}): ${redactSecretsFromText(text.slice(0, 1000), [credential.token]) || "no response body"}.`);
  }
  const data = (await response.json()) as unknown;
  if (!Array.isArray(data)) return [];
  const out: ExistingPullReview[] = [];
  for (const entry of data as Array<Record<string, unknown>>) {
    if (typeof entry.id !== "number") continue;
    const user = entry.user as { login?: unknown } | undefined;
    out.push({
      id: entry.id,
      ...(typeof user?.login === "string" ? { userLogin: user.login } : {}),
      ...(typeof entry.state === "string" ? { state: entry.state } : {}),
      ...(typeof entry.body === "string" ? { body: entry.body } : {}),
      ...(typeof entry.commit_id === "string" ? { commitId: entry.commit_id } : {}),
    });
  }
  return out;
}

/**
 * Retry-idempotency selector: find an existing review by the same reviewer
 * with the identical event/body/commit. Returns the newest match, or
 * `undefined` when the review must be created. Body comparison uses the
 * fully formatted body (including the provenance footer) so retries with
 * identical inputs dedupe while genuinely new findings still POST.
 */
export function findDuplicateReview(
  reviews: readonly ExistingPullReview[],
  match: { reviewerLogin: string; event: ReviewEvent; body: string; commitId?: string },
): ExistingPullReview | undefined {
  const wantBody = match.body.trim();
  const candidates = reviews.filter((review) => {
    if (review.userLogin?.toLowerCase() !== match.reviewerLogin.toLowerCase()) return false;
    if (review.state?.toUpperCase() !== match.event) return false;
    if ((review.body ?? "").trim() !== wantBody) return false;
    if (match.commitId !== undefined && review.commitId !== undefined && review.commitId !== match.commitId) return false;
    return true;
  });
  if (candidates.length === 0) return undefined;
  return candidates.reduce((a, b) => (b.id > a.id ? b : a));
}

/**
 * Submit a formal PR review as the reviewer GitHub App (fail closed).
 *
 * Production enforcement (Blocking 1): before any `POST /reviews`, a live
 * preflight proves the credential is the reviewer App Bot (`GET /user`
 * `type: Bot`, optional `ORCA_PI_GITHUB_REVIEWER_LOGIN` match) and distinct
 * from the PR author (`GET` PR → distinct-actor guard). `--identity worker`
 * and human PATs in the reviewer slot never reach POST. Tokens never enter
 * logs.
 *
 * Retry semantics: retries with identical `(reviewer, event, body, commit)`
 * return the existing review instead of POSTing a duplicate (best-effort
 * list-then-dedupe; genuinely new findings still create a new review).
 *
 * `fetchFn` is injectable for tests; `env`/`cache` thread through to
 * credential resolution. Throws `GithubAuthError` for 401/403/404
 * (actionable installation guidance) and `GithubApiError` otherwise.
 */
export async function submitGithubReview(
  identity: GithubIdentity,
  input: SubmitReviewInput,
  options?: {
    fetchFn?: GithubFetchFn;
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    cache?: InstallationTokenCache;
    apiBase?: string;
  },
): Promise<{ id: number; htmlUrl?: string; submittedAt?: string; deduped?: boolean }> {
  const env = options?.env ?? process.env;
  const cache = options?.cache ?? defaultTokenCache;
  // Fail closed before any write: reviewer App Bot + distinct from author.
  const preflight = await verifyReviewerForReview(
    identity,
    { owner: input.owner, repo: input.repo, pullNumber: input.pullNumber },
    { ...(options?.fetchFn ? { fetchFn: options.fetchFn } : {}), env, cache, ...(options?.apiBase ? { apiBase: options.apiBase } : {}) },
  );
  const credential = resolveGithubCredential(identity, env, cache);
  const fetchFn = options?.fetchFn ?? defaultFetch();
  const apiBase = (options?.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
  const endpoint = `/repos/${input.owner}/${input.repo}/pulls/${input.pullNumber}/reviews`;
  const payload = buildReviewPayload({
    verdict: input.verdict,
    body: input.body,
    ...(input.commitId ? { commitId: input.commitId } : {}),
    ...(input.provenance ? { provenance: input.provenance } : {}),
  });
  // Idempotent retry: identical retry returns the existing review.
  try {
    const existing = await listPullReviews(identity, { owner: input.owner, repo: input.repo, pullNumber: input.pullNumber }, { fetchFn, env, cache, apiBase });
    const duplicate = findDuplicateReview(existing, { reviewerLogin: preflight.reviewerLogin, event: payload.event, body: payload.body, ...(payload.commit_id ? { commitId: payload.commit_id } : {}) });
    if (duplicate) {
      return { id: duplicate.id, deduped: true };
    }
  } catch {
    // Listing is best-effort idempotency — fall through to POST.
  }

  let response;
  try {
    response = await fetchFn(`${apiBase}${endpoint}`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${credential.token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    const safe = redactSecretsFromText(error instanceof Error ? error.message : String(error), [credential.token]);
    throw new GithubApiError(endpoint, 0, `GitHub review request failed (network): ${safe}`);
  }

  if (!response.ok) {
    const authError = toAuthError(identity, response.status, endpoint);
    if (authError) throw authError;
    const text = await response.text().catch(() => "");
    const safe = redactSecretsFromText(text.slice(0, 2000), [credential.token]);
    throw new GithubApiError(
      endpoint,
      response.status,
      `GitHub review request failed (${response.status}) for ${endpoint}: ${safe || "no response body"}.`,
    );
  }
  const data = (await response.json()) as { id?: unknown; html_url?: unknown; submitted_at?: unknown };
  if (typeof data.id !== "number") {
    throw new GithubApiError(endpoint, response.status, `GitHub review succeeded but returned no numeric id for ${endpoint}.`);
  }
  return {
    id: data.id,
    ...(typeof data.html_url === "string" ? { htmlUrl: data.html_url } : {}),
    ...(typeof data.submitted_at === "string" ? { submittedAt: data.submitted_at } : {}),
  };
}

/**
 * Deterministic automated-review check runs (OP1.9 / JEF-15).
 *
 * One check (`orca-pi/agent-review`) reports the agent review outcome so it
 * can later be required by branch protection / rulesets:
 * - `in_progress` while reviewing,
 * - `success` when no blocking findings,
 * - `failure` when blocking findings exist.
 *
 * Helpers are pure (payload builders, verdict mapping, dedupe selection)
 * plus a thin injectable HTTP layer. Retries are idempotent: callers list
 * existing runs for the head SHA and update the matching run instead of
 * creating duplicates.
 *
 * GitHub references:
 * - https://docs.github.com/en/rest/checks/runs
 */

import { resolveGithubCredential, toAuthError, type InstallationTokenCache } from "./github-app-auth.js";
import { defaultTokenCache } from "./github-app-auth.js";
import { redactSecretsFromText } from "./identity.js";
import {
  AGENT_REVIEW_CHECK_NAME,
  GithubApiError,
  type CheckConclusion,
  type CheckRunInput,
  type CheckStatus,
  type GithubFetchFn,
  type GithubIdentity,
  type ReviewProvenance,
  type ReviewVerdict,
} from "./types.js";

export { AGENT_REVIEW_CHECK_NAME };

/** Map a review verdict to the deterministic check conclusion. */
export function verdictToCheckConclusion(verdict: ReviewVerdict): CheckConclusion {
  // Blocking findings → REQUEST_CHANGES → failed check. Non-blocking
  // outcomes (APPROVE per policy, or COMMENT per policy) → passed check so
  // the gate stays deterministic for rulesets.
  return verdict === "request-changes" ? "failure" : "success";
}

/** True when the verdict represents blocking findings. */
export function verdictIsBlocking(verdict: ReviewVerdict): boolean {
  return verdict === "request-changes";
}

function provenanceSuffix(provenance?: ReviewProvenance): string {
  if (!provenance) return "";
  const parts: string[] = [];
  if (provenance.profile) parts.push(`profile ${provenance.profile}`);
  if (provenance.taskId) parts.push(`task ${provenance.taskId}`);
  if (provenance.linearIssueId) parts.push(provenance.linearIssueId);
  if (parts.length === 0) return "";
  return `\n\n🤖 orca-pi agent-review (${parts.join(" · ")}) · human remains merge authority`;
}

/** Build a `POST .../check-runs` payload for the `start` step (`in_progress`). */
export function buildCheckStartPayload(input: {
  headSha: string;
  summary?: string;
  text?: string;
  provenance?: ReviewProvenance;
}): Record<string, unknown> {
  if (!/^[0-9a-f]{4,64}$/i.test(input.headSha.trim())) {
    throw new Error(`Invalid head SHA ${JSON.stringify(input.headSha)}: expected a commit SHA.`);
  }
  const summary = (input.summary ?? "Agent review in progress…").trim() || "Agent review in progress…";
  return {
    name: AGENT_REVIEW_CHECK_NAME,
    head_sha: input.headSha.trim(),
    status: "in_progress" satisfies CheckStatus,
    output: {
      title: "Agent review in progress",
      summary: `${summary}${provenanceSuffix(input.provenance)}`.slice(0, 65000),
      ...(input.text ? { text: input.text.slice(0, 65000) } : {}),
    },
  };
}

/** Build a `PATCH .../check-runs/{id}` payload for the `complete` step. */
export function buildCheckCompletePayload(input: {
  verdict: ReviewVerdict;
  summary: string;
  text?: string;
  provenance?: ReviewProvenance;
}): Record<string, unknown> {
  const summary = input.summary.trim();
  if (!summary) {
    throw new Error("Check summary must not be empty — provide a concise pass/fail summary.");
  }
  const conclusion = verdictToCheckConclusion(input.verdict);
  const title = conclusion === "success" ? "Agent review passed" : "Agent review failed — changes requested";
  return {
    status: "completed" satisfies CheckStatus,
    conclusion,
    output: {
      title,
      summary: `${summary}${provenanceSuffix(input.provenance)}`.slice(0, 65000),
      ...(input.text ? { text: input.text.slice(0, 65000) } : {}),
    },
  };
}

/** Minimal check-run record (subset of the GitHub Checks API). */
export interface ExistingCheckRun {
  id: number;
  name: string;
  headSha: string;
  status: string;
  conclusion?: string | null;
}

/**
 * Idempotency selector: pick the existing deterministic run to update
 * instead of creating a duplicate. Prefers an `in_progress` run for the
 * same head SHA, else the newest completed run for the same SHA. Returns
 * `undefined` when no matching run exists (caller creates one).
 */
export function selectCheckRunForUpdate(
  runs: readonly ExistingCheckRun[],
  headSha: string,
  checkName: string = AGENT_REVIEW_CHECK_NAME,
): ExistingCheckRun | undefined {
  const matches = runs.filter((run) => run.name === checkName && run.headSha.toLowerCase() === headSha.toLowerCase());
  if (matches.length === 0) return undefined;
  const inProgress = matches.filter((run) => run.status === "in_progress");
  if (inProgress.length > 0) {
    return inProgress.reduce((a, b) => (b.id > a.id ? b : a));
  }
  return matches.reduce((a, b) => (b.id > a.id ? b : a));
}

function defaultFetch(): GithubFetchFn {
  const globalFetch = (globalThis as { fetch?: unknown }).fetch;
  if (typeof globalFetch !== "function") {
    throw new Error("No fetch implementation available — pass an explicit fetchFn (Node >= 18 provides global fetch).");
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

function baseHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/** List check runs for a ref (used for idempotent upsert). */
export async function listCheckRunsForRef(
  identity: GithubIdentity,
  input: { owner: string; repo: string; ref: string; checkName?: string },
  options?: {
    fetchFn?: GithubFetchFn;
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    cache?: InstallationTokenCache;
    apiBase?: string;
  },
): Promise<ExistingCheckRun[]> {
  const env = options?.env ?? process.env;
  const cache = options?.cache ?? defaultTokenCache;
  const credential = resolveGithubCredential(identity, env, cache);
  const fetchFn = options?.fetchFn ?? defaultFetch();
  const apiBase = (options?.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
  const params = new URLSearchParams({ check_name: input.checkName ?? AGENT_REVIEW_CHECK_NAME, per_page: "50" });
  const endpoint = `/repos/${input.owner}/${input.repo}/commits/${encodeURIComponent(input.ref)}/check-runs?${params}`;
  const response = await fetchFn(`${apiBase}${endpoint}`, { method: "GET", headers: baseHeaders(credential.token) });
  if (!response.ok) {
    const authError = toAuthError(identity, response.status, endpoint);
    if (authError) throw authError;
    const text = await response.text().catch(() => "");
    throw new GithubApiError(endpoint, response.status, `GitHub list check-runs failed (${response.status}): ${redactSecretsFromText(text.slice(0, 2000), [credential.token]) || "no response body"}.`);
  }
  const data = (await response.json()) as { check_runs?: unknown };
  if (!Array.isArray(data.check_runs)) return [];
  const out: ExistingCheckRun[] = [];
  for (const run of data.check_runs as Array<Record<string, unknown>>) {
    if (typeof run.id !== "number" || typeof run.name !== "string") continue;
    out.push({
      id: run.id,
      name: run.name,
      headSha: typeof run.head_sha === "string" ? run.head_sha : "",
      status: typeof run.status === "string" ? run.status : "",
      conclusion: typeof run.conclusion === "string" ? run.conclusion : undefined,
    });
  }
  return out;
}

/** Create the deterministic check run (`in_progress`). */
export async function startAgentReviewCheck(
  identity: GithubIdentity,
  input: Omit<CheckRunInput, "status" | "conclusion"> & { status?: CheckStatus },
  options?: {
    fetchFn?: GithubFetchFn;
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    cache?: InstallationTokenCache;
    apiBase?: string;
  },
): Promise<{ id: number; htmlUrl?: string }> {
  const env = options?.env ?? process.env;
  const cache = options?.cache ?? defaultTokenCache;
  const credential = resolveGithubCredential(identity, env, cache);
  const fetchFn = options?.fetchFn ?? defaultFetch();
  const apiBase = (options?.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
  const endpoint = `/repos/${input.owner}/${input.repo}/check-runs`;
  const payload = buildCheckStartPayload({ headSha: input.headSha, summary: input.summary, text: input.text, provenance: input.provenance });
  let response;
  try {
    response = await fetchFn(`${apiBase}${endpoint}`, { method: "POST", headers: baseHeaders(credential.token), body: JSON.stringify(payload) });
  } catch (error) {
    throw new GithubApiError(endpoint, 0, `GitHub create check-run failed (network): ${redactSecretsFromText(error instanceof Error ? error.message : String(error), [credential.token])}`);
  }
  if (!response.ok) {
    const authError = toAuthError(identity, response.status, endpoint);
    if (authError) throw authError;
    const text = await response.text().catch(() => "");
    throw new GithubApiError(endpoint, response.status, `GitHub create check-run failed (${response.status}): ${redactSecretsFromText(text.slice(0, 2000), [credential.token]) || "no response body"}.`);
  }
  const data = (await response.json()) as { id?: unknown; html_url?: unknown };
  if (typeof data.id !== "number") throw new GithubApiError(endpoint, response.status, `GitHub create check-run succeeded but returned no numeric id.`);
  return { id: data.id, ...(typeof data.html_url === "string" ? { htmlUrl: data.html_url } : {}) };
}

/** Complete the deterministic check run (idempotent: updates existing when found). */
export async function completeAgentReviewCheck(
  identity: GithubIdentity,
  input: {
    owner: string;
    repo: string;
    headSha: string;
    checkRunId?: number;
    verdict: ReviewVerdict;
    summary: string;
    text?: string;
    provenance?: ReviewProvenance;
  },
  options?: {
    fetchFn?: GithubFetchFn;
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    cache?: InstallationTokenCache;
    apiBase?: string;
    listRuns?: (ref: string) => Promise<ExistingCheckRun[]>;
  },
): Promise<{ id: number; conclusion: CheckConclusion; htmlUrl?: string }> {
  const env = options?.env ?? process.env;
  const cache = options?.cache ?? defaultTokenCache;
  const credential = resolveGithubCredential(identity, env, cache);
  const fetchFn = options?.fetchFn ?? defaultFetch();
  const apiBase = (options?.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
  const payload = buildCheckCompletePayload({ verdict: input.verdict, summary: input.summary, text: input.text, provenance: input.provenance });

  let checkRunId = input.checkRunId;
  if (checkRunId === undefined && options?.listRuns) {
    const existing = selectCheckRunForUpdate(await options.listRuns(input.headSha), input.headSha);
    if (existing) checkRunId = existing.id;
  }
  // Default idempotent path: list existing runs for the SHA and update the
  // matching deterministic run instead of creating a duplicate.
  if (checkRunId === undefined && !options?.listRuns) {
    try {
      const existing = await listCheckRunsForRef(identity, { owner: input.owner, repo: input.repo, ref: input.headSha }, { fetchFn, env, cache, apiBase });
      const match = selectCheckRunForUpdate(existing, input.headSha);
      if (match) checkRunId = match.id;
    } catch {
      // Listing is best-effort idempotency — fall through to create+complete.
    }
  }

  if (checkRunId !== undefined) {
    const endpoint = `/repos/${input.owner}/${input.repo}/check-runs/${checkRunId}`;
    const response = await fetchFn(`${apiBase}${endpoint}`, { method: "PATCH", headers: baseHeaders(credential.token), body: JSON.stringify(payload) });
    if (!response.ok) {
      const authError = toAuthError(identity, response.status, endpoint);
      if (authError) throw authError;
      const text = await response.text().catch(() => "");
      throw new GithubApiError(endpoint, response.status, `GitHub update check-run failed (${response.status}): ${redactSecretsFromText(text.slice(0, 2000), [credential.token]) || "no response body"}.`);
    }
    const data = (await response.json()) as { id?: unknown; conclusion?: unknown; html_url?: unknown };
    return {
      id: typeof data.id === "number" ? data.id : checkRunId,
      conclusion: verdictToCheckConclusion(input.verdict),
      ...(typeof data.html_url === "string" ? { htmlUrl: data.html_url } : {}),
    };
  }

  // No existing run: create an in_progress run then complete it (two calls,
  // same deterministic name — a later retry will find and update it).
  const created = await startAgentReviewCheck(identity, { owner: input.owner, repo: input.repo, headSha: input.headSha, summary: input.summary, text: input.text, provenance: input.provenance }, { fetchFn, env, cache, apiBase });
  const endpoint = `/repos/${input.owner}/${input.repo}/check-runs/${created.id}`;
  const response = await fetchFn(`${apiBase}${endpoint}`, { method: "PATCH", headers: baseHeaders(credential.token), body: JSON.stringify(payload) });
  if (!response.ok) {
    const authError = toAuthError(identity, response.status, endpoint);
    if (authError) throw authError;
    const text = await response.text().catch(() => "");
    throw new GithubApiError(endpoint, response.status, `GitHub update check-run failed (${response.status}): ${redactSecretsFromText(text.slice(0, 2000), [credential.token]) || "no response body"}.`);
  }
  const data = (await response.json()) as { html_url?: unknown };
  return { id: created.id, conclusion: verdictToCheckConclusion(input.verdict), ...(typeof data.html_url === "string" ? { htmlUrl: data.html_url } : {}) };
}

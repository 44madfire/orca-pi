/**
 * GitHub App installation-token handling (OP1.9 / JEF-15).
 *
 * Prefers short-lived installation access tokens over long-lived PATs.
 * Tokens are generated/refreshed OUTSIDE LLM context (a helper process or
 * operator mints them); this module only resolves, caches, and validates
 * them behind logical identity names (`worker`, `reviewer`).
 *
 * Sources (in order):
 * 1. In-memory installation-token cache (`createInstallationTokenCache`) —
 *    honors expiry so refresh is explicit and testable.
 * 2. Environment: `ORCA_PI_GITHUB_<IDENTITY>_TOKEN` plus optional
 *    `ORCA_PI_GITHUB_<IDENTITY>_EXPIRES_AT` (ISO-8601). The reviewer slot
 *    additionally honors `GH_APP_INSTALLATION_TOKEN` nomenclatures via
 *    explicit aliases (never the worker token — identities stay separate).
 *
 * Never logs token values. Errors are actionable (missing/expired/
 * unauthorized installation) and safe to display (see `sanitize*`).
 */

import {
  assertDistinctGithubActors,
  expiryEnvVarForIdentity,
  redactSecretsFromText,
  redactTokenLikeValues,
  tokenEnvVarForIdentity,
} from "./identity.js";
import {
  GithubApiError,
  GithubAuthError,
  type GithubIdentity,
  type ResolvedGithubCredential,
} from "./types.js";

/** Reviewer token aliases honored in addition to the canonical slot. */
const REVIEWER_TOKEN_ALIASES: readonly string[] = [
  "ORCA_PI_GITHUB_REVIEWER_INSTALLATION_TOKEN",
  "ORCA_PI_REVIEWER_GITHUB_TOKEN",
] as const;

/** Clock skew tolerance when evaluating installation-token expiry. */
const EXPIRY_SKEW_MS = 60_000;

export interface TokenCacheEntry {
  token: string;
  expiresAt?: Date;
  installationId?: string;
}

/**
 * Small expiry-aware cache for installation tokens. `get` returns
 * `undefined` for missing OR expired entries (callers then re-resolve from
 * env/helper, which mints fresh tokens outside LLM context). Never logs.
 */
export function createInstallationTokenCache(options?: {
  now?: () => number;
  skewMs?: number;
}) {
  const now = options?.now ?? Date.now;
  const skewMs = options?.skewMs ?? EXPIRY_SKEW_MS;
  const entries = new Map<string, TokenCacheEntry>();

  function isExpired(entry: TokenCacheEntry): boolean {
    if (!entry.expiresAt) return false;
    return entry.expiresAt.getTime() <= now() + skewMs;
  }

  return {
    get(identity: GithubIdentity): TokenCacheEntry | undefined {
      const entry = entries.get(identity);
      if (!entry) return undefined;
      if (isExpired(entry)) {
        entries.delete(identity);
        return undefined;
      }
      return { ...entry };
    },
    set(
      identity: GithubIdentity,
      entry: TokenCacheEntry,
    ): void {
      entries.set(identity, { ...entry });
    },
    clear(identity?: GithubIdentity): void {
      if (identity === undefined) entries.clear();
      else entries.delete(identity);
    },
    /** Test seam: true when a non-expired entry exists. */
    has(identity: GithubIdentity): boolean {
      return entries.get(identity) !== undefined && !isExpired(entries.get(identity)!);
    },
  };
}

export type InstallationTokenCache = ReturnType<
  typeof createInstallationTokenCache
>;

/** Shared default cache (long-lived process use; tests create their own). */
export const defaultTokenCache = createInstallationTokenCache();

function parseExpiry(raw: string | undefined, identity: string): Date | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const time = Date.parse(trimmed);
  if (Number.isNaN(time)) {
    throw new GithubAuthError(
      identity,
      "helper-failed",
      `Invalid expiry in ${expiryEnvVarForIdentity(identity)} (${redactTokenLikeValues(trimmed)}): expected ISO-8601 (e.g. "2026-09-04T19:00:00Z"). Mint a fresh installation token outside LLM context and retry.`,
    );
  }
  return new Date(time);
}

/**
 * Resolve one identity to a credential. Reads env only (never prompts,
 * never spawns); token minting/refresh happens outside LLM context.
 *
 * Throws {@link GithubAuthError} with actionable, log-safe messages for:
 * - missing credential (prints the exact env var to set, never a value),
 * - expired installation token (asks for refresh outside LLM context),
 * - unauthorized installation shape (empty/blank token).
 *
 * `env` defaults to `process.env` in production; tests inject a record.
 */
export function resolveGithubCredential(
  identity: GithubIdentity,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  cache: InstallationTokenCache = defaultTokenCache,
): ResolvedGithubCredential {
  const cached = cache.get(identity);
  if (cached) {
    return {
      identity,
      sourceLabel: `${tokenEnvVarForIdentity(identity)} (cached)`,
      token: cached.token,
      ...(cached.expiresAt ? { expiresAt: cached.expiresAt } : {}),
      ...(cached.installationId ? { installationId: cached.installationId } : {}),
    };
  }

  const primaryVar = tokenEnvVarForIdentity(identity);
  const candidates: string[] =
    identity === "reviewer"
      ? [primaryVar, ...REVIEWER_TOKEN_ALIASES]
      : [primaryVar];

  let token: string | undefined;
  let sourceLabel = primaryVar;
  for (const name of candidates) {
    const value = env[name];
    if (typeof value === "string" && value.trim().length > 0) {
      token = value.trim();
      sourceLabel = name;
      break;
    }
  }

  if (!token) {
    const hint =
      identity === "reviewer"
        ? `Install the Orca-Pi Reviewer GitHub App on the repository, mint an installation access token outside LLM context, and export ${primaryVar} (plus optional ${expiryEnvVarForIdentity(identity)} as ISO-8601). ` +
          `Never place private keys, installation tokens, PATs, or webhook secrets in prompts, task text, logs, or Linear descriptions.`
        : `Export ${primaryVar} with a token for the "${identity}" identity (minted outside LLM context). ` +
          `Profile config references the logical identity ("${identity}") — never a secret.`;
    throw new GithubAuthError(
      identity,
      "missing-credential",
      `Missing GitHub credential for identity "${identity}" (looked for ${candidates.join(", ")}). ${hint}`,
    );
  }

  const expiresAt = parseExpiry(env[expiryEnvVarForIdentity(identity)], identity);
  if (expiresAt && expiresAt.getTime() <= Date.now() + EXPIRY_SKEW_MS) {
    throw new GithubAuthError(
      identity,
      "expired-token",
      `GitHub credential for identity "${identity}" is expired (from ${sourceLabel}, expired at ${expiresAt.toISOString()}). ` +
        `Mint a fresh installation access token outside LLM context and retry — never paste tokens into prompts or task text.`,
    );
  }

  const installationId =
    identity === "reviewer"
      ? env.ORCA_PI_GITHUB_REVIEWER_INSTALLATION_ID?.trim() || undefined
      : undefined;

  const credential: ResolvedGithubCredential = {
    identity,
    sourceLabel,
    token,
    ...(expiresAt ? { expiresAt } : {}),
    ...(installationId ? { installationId } : {}),
  };
  // Cache installation tokens with known expiry so refresh is explicit;
  // PAT-like tokens without expiry are not cached (always re-read env).
  if (expiresAt) {
    cache.set(identity, {
      token,
      expiresAt,
      ...(installationId ? { installationId } : {}),
    });
  }
  return credential;
}

/**
 * Report credential presence without exposing values (for
 * `orca-pi github auth status`). Returns the source label and expiry
 * state; never the token.
 */
export function describeCredentialStatus(
  identity: GithubIdentity,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  cache: InstallationTokenCache = defaultTokenCache,
): {
  identity: string;
  configured: boolean;
  sourceLabel: string;
  expiresAt?: string;
  expired?: boolean;
} {
  try {
    const credential = resolveGithubCredential(identity, env, cache);
    return {
      identity,
      configured: true,
      sourceLabel: credential.sourceLabel,
      ...(credential.expiresAt
        ? { expiresAt: credential.expiresAt.toISOString(), expired: false }
        : {}),
    };
  } catch (error) {
    if (error instanceof GithubAuthError && error.code === "expired-token") {
      return {
        identity,
        configured: false,
        sourceLabel: tokenEnvVarForIdentity(identity),
        expired: true,
      };
    }
    return {
      identity,
      configured: false,
      sourceLabel: tokenEnvVarForIdentity(identity),
    };
  }
}

/** Authorization header for GitHub REST calls (token never logged). */
export function authHeaderForCredential(
  credential: Pick<ResolvedGithubCredential, "token">,
): Record<string, string> {
  return { Authorization: `Bearer ${credential.token}` };
}

/** Verified reviewer App login slot (operator-set outside LLM context, safe to log the name). */
export const REVIEWER_LOGIN_ENV_VAR = "ORCA_PI_GITHUB_REVIEWER_LOGIN";

/** Authenticated GitHub actor (`GET /user` subset). */
export interface AuthenticatedGithubActor {
  login: string;
  type?: string;
}

function apiBaseUrl(apiBase?: string): string {
  return (apiBase ?? "https://api.github.com").replace(/\/+$/, "");
}

function baseHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

type FetchInit = { method: string; headers: Record<string, string>; body?: string };
type FetchFn = (url: string, init: FetchInit) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

function defaultFetchFn(): FetchFn {
  const globalFetch = (globalThis as { fetch?: unknown }).fetch;
  if (typeof globalFetch !== "function") {
    throw new Error("No fetch implementation available — pass an explicit fetchFn (Node >= 18 provides global fetch).");
  }
  return async (url, init) => {
    const response = await (globalFetch as typeof fetch)(url, { method: init.method, headers: init.headers, body: init.body });
    return { ok: response.ok, status: response.status, json: () => response.json() as Promise<unknown>, text: () => response.text() };
  };
}

/**
 * Reject non-reviewer identities for formal review/check writes (fail closed).
 *
 * Formal `REQUEST_CHANGES`/`APPROVE` reviews and the deterministic
 * `orca-pi/agent-review` check must come from the dedicated reviewer GitHub
 * App (distinct actor). `--identity worker` (or any non-reviewer slot) can
 * create/update PRs but must never submit formal reviews — that is the
 * same-account failure mode JEF-15 prevents.
 */
export function assertReviewerIdentityForWrites(identity: string): void {
  if (identity !== "reviewer") {
    throw new GithubAuthError(
      identity,
      "unauthorized-installation",
      `Refusing GitHub review/check write as identity "${identity}" — formal reviews and the orca-pi/agent-review check must use the dedicated reviewer GitHub App (distinct actor). ` +
        `Use --identity reviewer with ORCA_PI_GITHUB_REVIEWER_TOKEN (installation token, Contents: read / Pull requests: write / Checks: write). ` +
        `Same-account PATs are not distinct identities.`,
    );
  }
}

/**
 * Live preflight: resolve the authenticated actor for an identity via
 * `GET /user`. Proves *which* GitHub account the token acts as — never
 * inferred from token prefixes. Used to reject human PATs in the reviewer
 * slot (type `User`) and to verify the token matches the operator-configured
 * reviewer App login when `ORCA_PI_GITHUB_REVIEWER_LOGIN` is set.
 */
export async function fetchAuthenticatedActor(
  identity: string,
  options?: { fetchFn?: FetchFn; env?: NodeJS.ProcessEnv | Record<string, string | undefined>; cache?: InstallationTokenCache; apiBase?: string },
): Promise<AuthenticatedGithubActor> {
  const env = options?.env ?? process.env;
  const cache = options?.cache ?? defaultTokenCache;
  const credential = resolveGithubCredential(identity, env, cache);
  const fetchFn = options?.fetchFn ?? defaultFetchFn();
  const base = apiBaseUrl(options?.apiBase);
  const endpoint = "/user";
  let response;
  try {
    response = await fetchFn(`${base}${endpoint}`, { method: "GET", headers: baseHeaders(credential.token) });
  } catch (error) {
    throw new GithubAuthError(identity, "helper-failed", `Could not verify GitHub actor for "${identity}" (${endpoint}): ${redactSecretsFromText(error instanceof Error ? error.message : String(error), [credential.token])}`);
  }
  if (!response.ok) {
    const authError = toAuthError(identity, response.status, endpoint);
    if (authError) throw authError;
    const text = await response.text().catch(() => "");
    throw new GithubApiError(endpoint, response.status, `Could not verify GitHub actor for "${identity}" (${response.status}): ${redactSecretsFromText(text.slice(0, 1000), [credential.token]) || "no response body"}.`);
  }
  const data = (await response.json()) as { login?: unknown; type?: unknown };
  if (typeof data.login !== "string" || !data.login.trim()) {
    throw new GithubApiError(endpoint, response.status, `GitHub /user returned no login for identity "${identity}" — cannot prove distinct reviewer actor. Mint a fresh installation token outside LLM context and retry.`);
  }
  return { login: data.login.trim(), ...(typeof data.type === "string" ? { type: data.type } : {}) };
}

/** Fetch the PR author login (`GET /repos/{o}/{r}/pulls/{n}` → `user.login`). */
export async function fetchPullRequestAuthor(
  input: { owner: string; repo: string; pullNumber: number },
  options?: { fetchFn?: FetchFn; token?: string; identity?: string; env?: NodeJS.ProcessEnv | Record<string, string | undefined>; cache?: InstallationTokenCache; apiBase?: string },
): Promise<string> {
  const identity = options?.identity ?? "reviewer";
  const env = options?.env ?? process.env;
  const cache = options?.cache ?? defaultTokenCache;
  let token = options?.token;
  if (!token) token = resolveGithubCredential(identity, env, cache).token;
  const fetchFn = options?.fetchFn ?? defaultFetchFn();
  const base = apiBaseUrl(options?.apiBase);
  const endpoint = `/repos/${input.owner}/${input.repo}/pulls/${input.pullNumber}`;
  const response = await fetchFn(`${base}${endpoint}`, { method: "GET", headers: baseHeaders(token) });
  if (!response.ok) {
    const authError = toAuthError(identity, response.status, endpoint);
    if (authError) throw authError;
    const text = await response.text().catch(() => "");
    throw new GithubApiError(endpoint, response.status, `Could not load PR author for ${input.owner}/${input.repo}#${input.pullNumber} (${response.status}): ${redactSecretsFromText(text.slice(0, 1000), [token as string]) || "no response body"}.`);
  }
  const data = (await response.json()) as { user?: { login?: unknown } };
  const login = data.user?.login;
  if (typeof login !== "string" || !login.trim()) {
    throw new GithubApiError(endpoint, response.status, `PR ${input.owner}/${input.repo}#${input.pullNumber} returned no author login — cannot prove reviewer is distinct from the PR author.`);
  }
  return login.trim();
}

/**
 * Review preflight (fail closed): proves the reviewer credential is the
 * configured App Bot and distinct from the PR author *before* any
 * `POST /reviews`. Never infers from token prefixes — uses live `GET /user`
 * (`type` + `login`) plus `GET` PR author, then the distinct-actor guard.
 *
 * - Rejects `--identity worker` (and any non-reviewer slot).
 * - Rejects human PATs in the reviewer slot (`type: User`).
 * - When `ORCA_PI_GITHUB_REVIEWER_LOGIN` is set, requires an exact
 *   (case-insensitive) match — the secret-provider verified-identity path.
 * - Rejects same-actor reviewer/author pairs (separate PATs, same user).
 */
export async function verifyReviewerForReview(
  identity: string,
  pr: { owner: string; repo: string; pullNumber: number },
  options?: { fetchFn?: FetchFn; env?: NodeJS.ProcessEnv | Record<string, string | undefined>; cache?: InstallationTokenCache; apiBase?: string },
): Promise<{ reviewerLogin: string; prAuthorLogin: string }> {
  assertReviewerIdentityForWrites(identity);
  const env = options?.env ?? process.env;
  const actor = await fetchAuthenticatedActor(identity, options);
  if (actor.type !== undefined && actor.type.toLowerCase() !== "bot") {
    // Human PAT in the reviewer slot — fail with the distinct-actor message
    // (same-account PATs are not distinct identities).
    assertDistinctGithubActors({ workerLogin: actor.login, reviewerLogin: actor.login });
  }
  const expected = env[REVIEWER_LOGIN_ENV_VAR]?.trim();
  if (expected && actor.login.toLowerCase() !== expected.toLowerCase()) {
    throw new GithubAuthError(identity, "unauthorized-installation", `Reviewer credential acts as "${actor.login}" but the configured reviewer App login is "${expected}" (${REVIEWER_LOGIN_ENV_VAR}). Mint the installation token for the configured App outside LLM context and retry — never paste tokens into prompts.`);
  }
  const prAuthorLogin = await fetchPullRequestAuthor(pr, { ...(options ?? {}), identity });
  assertDistinctGithubActors({ workerLogin: prAuthorLogin, reviewerLogin: actor.login });
  return { reviewerLogin: actor.login, prAuthorLogin };
}

/**
 * Check-write preflight (fail closed): proves the check writer is the
 * reviewer App Bot via live `GET /user` before any check-run POST/PATCH.
 */
export async function verifyReviewerForChecks(
  identity: string,
  options?: { fetchFn?: FetchFn; env?: NodeJS.ProcessEnv | Record<string, string | undefined>; cache?: InstallationTokenCache; apiBase?: string },
): Promise<{ reviewerLogin: string }> {
  assertReviewerIdentityForWrites(identity);
  const env = options?.env ?? process.env;
  const actor = await fetchAuthenticatedActor(identity, options);
  if (actor.type !== undefined && actor.type.toLowerCase() !== "bot") {
    assertDistinctGithubActors({ workerLogin: actor.login, reviewerLogin: actor.login });
  }
  const expected = env[REVIEWER_LOGIN_ENV_VAR]?.trim();
  if (expected && actor.login.toLowerCase() !== expected.toLowerCase()) {
    throw new GithubAuthError(identity, "unauthorized-installation", `Reviewer credential acts as "${actor.login}" but the configured reviewer App login is "${expected}" (${REVIEWER_LOGIN_ENV_VAR}). Mint the installation token for the configured App outside LLM context and retry.`);
  }
  return { reviewerLogin: actor.login };
}

/**
 * Translate HTTP 401/403/404 from installation-token calls into an
 * actionable {@link GithubAuthError} (missing/unauthorized App
 * installation). Other statuses pass through for `GithubApiError`.
 */
export function toAuthError(
  identity: GithubIdentity,
  status: number,
  endpoint: string,
): GithubAuthError | undefined {
  if (status === 401) {
    return new GithubAuthError(
      identity,
      "expired-token",
      `GitHub rejected the "${identity}" credential for ${endpoint} (401). ` +
        `The installation token may be expired or revoked — mint a fresh installation access token outside LLM context and retry.`,
    );
  }
  if (status === 403) {
    return new GithubAuthError(
      identity,
      "unauthorized-installation",
      `GitHub denied the "${identity}" credential for ${endpoint} (403). ` +
        `The Reviewer GitHub App may lack permission (needs Pull requests: write, Checks: write, Contents: read) or is not installed on this repository. ` +
        `Install/authorize the App, then retry. Do not grant Contents: write to the reviewer.`,
    );
  }
  if (status === 404) {
    return new GithubAuthError(
      identity,
      "unauthorized-installation",
      `GitHub returned 404 for ${endpoint} with the "${identity}" credential. ` +
        `The App installation may not cover this repository (GitHub hides unauthorized repos as 404). Install the Reviewer GitHub App on the repository and retry.`,
    );
  }
  return undefined;
}

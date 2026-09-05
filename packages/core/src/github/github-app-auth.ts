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

/**
 * Verified reviewer App identity slots (operator-set outside LLM context,
 * safe to log the names — never the values).
 *
 * The out-of-LLM credential provider (operator/helper that mints the
 * installation token) must also supply this verified App/installation
 * metadata. Production review/check writes compare the trusted configured
 * login against the PR author for distinctness — never `GET /user`, which
 * does not support installation access tokens (see `fetchAuthenticatedActor`
 * below), and never token-prefix inference.
 */
export const REVIEWER_LOGIN_ENV_VAR = "ORCA_PI_GITHUB_REVIEWER_LOGIN";
export const REVIEWER_INSTALLATION_ID_ENV_VAR = "ORCA_PI_GITHUB_REVIEWER_INSTALLATION_ID";

/** Trusted reviewer App/installation identity (from env, outside LLM context). */
export interface ReviewerAppMetadata {
  login: string;
  installationId: string;
}

/**
 * Resolve trusted reviewer App metadata (fail closed when unconfigured).
 *
 * Both `ORCA_PI_GITHUB_REVIEWER_LOGIN` (e.g. `"orca-pi-reviewer[bot]"`) and
 * `ORCA_PI_GITHUB_REVIEWER_INSTALLATION_ID` must be set by the operator or
 * credential helper outside LLM context alongside
 * `ORCA_PI_GITHUB_REVIEWER_TOKEN`. Prints var names, never values.
 */
export function resolveReviewerAppMetadata(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): ReviewerAppMetadata {
  const login = env[REVIEWER_LOGIN_ENV_VAR]?.trim();
  const installationId = env[REVIEWER_INSTALLATION_ID_ENV_VAR]?.trim();
  const missing: string[] = [];
  if (!login) missing.push(REVIEWER_LOGIN_ENV_VAR);
  if (!installationId) missing.push(REVIEWER_INSTALLATION_ID_ENV_VAR);
  if (missing.length > 0) {
    throw new GithubAuthError(
      "reviewer",
      "missing-credential",
      `Missing verified reviewer App identity (${missing.join(", ")}). Install the Orca-Pi Reviewer GitHub App on the repository outside LLM context, then export ${REVIEWER_LOGIN_ENV_VAR} (App bot login, e.g. "orca-pi-reviewer[bot]") and ${REVIEWER_INSTALLATION_ID_ENV_VAR} (numeric installation id) alongside ORCA_PI_GITHUB_REVIEWER_TOKEN. Never place private keys, installation tokens, PATs, or webhook secrets in prompts, task text, logs, or Linear descriptions.`,
    );
  }
  return { login: login as string, installationId: installationId as string };
}

/**
 * Prove the reviewer token is an installation access token (IAT class).
 *
 * Uses `GET /installation/repositories?per_page=1`, an endpoint that
 * supports installation access tokens (unlike `GET /user`, which lists only
 * user access tokens/fine-grained PATs and must never be used to verify an
 * IAT). A 200 proves IAT class; 401/403/404 map to actionable
 * expired/unauthorized-installation errors. Human PATs in the reviewer slot
 * fail here (or later at the distinct-actor comparison) — never by token
 * prefix.
 */
export async function proveInstallationTokenClass(
  identity: string,
  options?: { fetchFn?: FetchFn; env?: NodeJS.ProcessEnv | Record<string, string | undefined>; cache?: InstallationTokenCache; apiBase?: string },
): Promise<void> {
  const env = options?.env ?? process.env;
  const cache = options?.cache ?? defaultTokenCache;
  const credential = resolveGithubCredential(identity, env, cache);
  const fetchFn = options?.fetchFn ?? defaultFetchFn();
  const base = apiBaseUrl(options?.apiBase);
  const endpoint = "/installation/repositories?per_page=1";
  let response;
  try {
    response = await fetchFn(`${base}${endpoint}`, { method: "GET", headers: baseHeaders(credential.token) });
  } catch (error) {
    throw new GithubAuthError(identity, "helper-failed", `Could not prove installation token class for "${identity}" (${endpoint}): ${redactSecretsFromText(error instanceof Error ? error.message : String(error), [credential.token])}`);
  }
  if (!response.ok) {
    const authError = toAuthError(identity, response.status, endpoint);
    if (authError) {
      throw new GithubAuthError(identity, authError.code, `${authError.message} (installation-token proof via ${endpoint} failed — the reviewer slot must hold a GitHub App installation access token, not a human PAT.)`);
    }
    const text = await response.text().catch(() => "");
    throw new GithubApiError(endpoint, response.status, `Could not prove installation token class for "${identity}" (${response.status}): ${redactSecretsFromText(text.slice(0, 1000), [credential.token]) || "no response body"}.`);
  }
}

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
 * PAT/user-token actor lookup via `GET /user` (NOT for installation tokens).
 *
 * GitHub's Get-the-authenticated-user endpoint supports GitHub App *user*
 * access tokens and fine-grained PATs, but NOT GitHub App *installation*
 * access tokens (IATs) — the credential model JEF-15 targets for the
 * reviewer. Reviewer preflight must therefore use
 * `proveInstallationTokenClass` + trusted `resolveReviewerAppMetadata`
 * instead of this helper. This function remains for worker/PAT diagnostics
 * and tests only.
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
 * Review preflight (fail closed, IAT-compatible): proves the reviewer
 * credential is an installation token for the configured App and distinct
 * from the PR author *before* any `POST /reviews`. Never calls `GET /user`
 * (unsupported for IATs) and never infers from token prefixes.
 *
 * 1. Rejects `--identity worker` (and any non-reviewer slot).
 * 2. Requires trusted App metadata (`ORCA_PI_GITHUB_REVIEWER_LOGIN` +
 *    `ORCA_PI_GITHUB_REVIEWER_INSTALLATION_ID`) from the out-of-LLM
 *    credential provider; validates the configured login looks like an App
 *    bot (`[bot]` suffix — config validation, not token inference).
 * 3. Proves IAT class via `GET /installation/repositories` (human PATs fail
 *    here with 401/403).
 * 4. Loads the PR author (`GET` PR, IAT-supported) and enforces
 *    distinctness against the *configured* reviewer login.
 */
export async function verifyReviewerForReview(
  identity: string,
  pr: { owner: string; repo: string; pullNumber: number },
  options?: { fetchFn?: FetchFn; env?: NodeJS.ProcessEnv | Record<string, string | undefined>; cache?: InstallationTokenCache; apiBase?: string },
): Promise<{ reviewerLogin: string; prAuthorLogin: string; installationId: string }> {
  assertReviewerIdentityForWrites(identity);
  const env = options?.env ?? process.env;
  const metadata = resolveReviewerAppMetadata(env);
  if (!metadata.login.toLowerCase().endsWith("[bot]")) {
    throw new GithubAuthError(identity, "unauthorized-installation", `Configured reviewer login "${metadata.login}" (${REVIEWER_LOGIN_ENV_VAR}) does not look like a GitHub App bot (expected a "[bot]" suffix, e.g. "orca-pi-reviewer[bot]"). Refusing to review — a human login must never occupy the reviewer slot (same-account PATs are not distinct identities). Fix the App configuration outside LLM context and retry.`);
  }
  await proveInstallationTokenClass(identity, options);
  const prAuthorLogin = await fetchPullRequestAuthor(pr, { ...(options ?? {}), identity });
  assertDistinctGithubActors({ workerLogin: prAuthorLogin, reviewerLogin: metadata.login });
  return { reviewerLogin: metadata.login, prAuthorLogin, installationId: metadata.installationId };
}

/**
 * Check-write preflight (fail closed, IAT-compatible): proves an
 * installation token for the configured App before any check-run POST/PATCH.
 * Same metadata + IAT-class proof as review preflight, minus the PR-author
 * comparison (checks address a head SHA, not a PR number).
 */
export async function verifyReviewerForChecks(
  identity: string,
  options?: { fetchFn?: FetchFn; env?: NodeJS.ProcessEnv | Record<string, string | undefined>; cache?: InstallationTokenCache; apiBase?: string },
): Promise<{ reviewerLogin: string; installationId: string }> {
  assertReviewerIdentityForWrites(identity);
  const env = options?.env ?? process.env;
  const metadata = resolveReviewerAppMetadata(env);
  if (!metadata.login.toLowerCase().endsWith("[bot]")) {
    throw new GithubAuthError(identity, "unauthorized-installation", `Configured reviewer login "${metadata.login}" (${REVIEWER_LOGIN_ENV_VAR}) does not look like a GitHub App bot (expected a "[bot]" suffix). Refusing check write — fix the App configuration outside LLM context and retry.`);
  }
  await proveInstallationTokenClass(identity, options);
  return { reviewerLogin: metadata.login, installationId: metadata.installationId };
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

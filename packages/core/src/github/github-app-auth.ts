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
  expiryEnvVarForIdentity,
  redactTokenLikeValues,
  tokenEnvVarForIdentity,
} from "./identity.js";
import {
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

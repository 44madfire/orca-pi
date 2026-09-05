/**
 * Expiry-aware in-memory installation-token cache (OP1.9 / OP1.12).
 *
 * Extracted to its own module so both `github-app-auth.ts` (env
 * resolution + preflights) and `credential-provider.ts` (disk cache +
 * App mint) can share one cache type without a static import cycle.
 * Never logs token values.
 */

import type { GithubIdentity } from "./types.js";

/** Clock skew tolerance when evaluating installation-token expiry. */
export const EXPIRY_SKEW_MS = 60_000;

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

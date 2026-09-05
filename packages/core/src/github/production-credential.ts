/**
 * Centralized production credential resolver (OP1.12 blocker 1).
 *
 * Single async entry point for ALL production consumers:
 * - `github review` / `github check` preflights + writes
 * - `github auth status` / `github doctor`
 * - `github exec` (scoped child env)
 * - `github git-credential` (repo-local helper)
 *
 * Order per identity: in-memory cache → fresh `ORCA_PI_GITHUB_<IDENT>_TOKEN`
 * → disk cache `<config>/github-tokens/<identity>.json` (0600, outside repo)
 * → App private-key mint (`*_APP_ID` + `*_PRIVATE_KEY_PATH` +
 * `*_INSTALLATION_ID`). Records expiry, refreshes before expiration, never
 * prints token/key values.
 *
 * Separate CLI invocations share state via the disk cache: `github mint`
 * once, then later `review`/`check`/`git-credential get` with App config but
 * no `*_TOKEN` env still resolve (regression-covered).
 */

import {
  ensureInstallationToken,
  tokenCacheFileForIdentity,
  type CredentialProviderFs,
} from "./credential-provider.js";
import { redactSecretsFromText } from "./identity.js";
import { defaultTokenCache, type InstallationTokenCache } from "./token-cache.js";
import {
  GithubAuthError,
  type GithubFetchFn,
  type ResolvedGithubCredential,
} from "./types.js";
import { resolveGithubCredential } from "./github-app-auth.js";

export interface ProductionCredentialOptions {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  cache?: InstallationTokenCache;
  providerFs?: CredentialProviderFs;
  fetchFn?: GithubFetchFn;
  apiBase?: string;
  homedir?: string;
  osHomedir?: () => string;
  nowMs?: number;
}

async function nodeProviderFs(): Promise<CredentialProviderFs> {
  const fs = await import("node:fs/promises");
  return {
    readFile: (path: string, encoding: "utf8") => fs.readFile(path, encoding),
    writeFile: (path: string, data: string, options?: { mode?: number }) =>
      fs.writeFile(path, data, options as never) as Promise<void>,
    mkdir: (path: string, options?: { recursive?: boolean; mode?: number }) =>
      fs.mkdir(path, options as never) as Promise<void>,
  };
}

/**
 * Resolve one identity via the full production chain (env → disk → mint).
 * When `providerFs` is absent, falls back to a real node fs in production;
 * callers that must stay offline (pure status display) should use
 * `describeProductionCredentialStatus` instead (no mint).
 */
export async function resolveProductionCredential(
  identity: string,
  options?: ProductionCredentialOptions,
): Promise<ResolvedGithubCredential> {
  const env = options?.env ?? process.env;
  const cache = options?.cache ?? defaultTokenCache;
  let providerFs = options?.providerFs;
  if (!providerFs) {
    try {
      providerFs = await nodeProviderFs();
    } catch {
      // Constrained host without node:fs — fall back to env-only.
      return resolveGithubCredential(identity, env, cache);
    }
  }
  try {
    return await ensureInstallationToken(identity, {
      env,
      cache,
      fs: providerFs,
      ...(options?.fetchFn ? { fetchFn: options.fetchFn } : {}),
      ...(options?.apiBase ? { apiBase: options.apiBase } : {}),
      ...(options?.homedir ? { homedir: options.homedir } : {}),
      ...(options?.osHomedir ? { osHomedir: options.osHomedir } : {}),
      ...(options?.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
    });
  } catch (error) {
    // If the full chain fails because minting is impossible (no App
    // config / no fs), surface the underlying env-only error when an env
    // token exists? ensureInstallationToken already prefers env, so any
    // error here is authoritative. Redact just in case.
    if (error instanceof GithubAuthError) throw error;
    const secrets: string[] = [];
    throw new GithubAuthError(
      identity,
      "helper-failed",
      `Could not resolve production credential for "${identity}": ${redactSecretsFromText(error instanceof Error ? error.message : String(error), secrets)}`,
    );
  }
}

/**
 * Read-only production status (no mint): checks in-memory → env → disk
 * cache file, never POSTs a new token. Used by `auth status` / `doctor`
 * display so `mint` once → later status succeeds without re-minting and
 * without requiring `*_TOKEN` exports.
 */
export async function describeProductionCredentialStatus(
  identity: string,
  options?: ProductionCredentialOptions,
): Promise<{
  identity: string;
  configured: boolean;
  sourceLabel: string;
  expiresAt?: string;
  expired?: boolean;
}> {
  const env = options?.env ?? process.env;
  const cache = options?.cache ?? defaultTokenCache;
  // 1. Warmed memory / fresh env via the sync path (no I/O).
  try {
    const credential = resolveGithubCredential(identity, env, cache);
    return {
      identity,
      configured: true,
      sourceLabel: credential.sourceLabel,
      ...(credential.expiresAt ? { expiresAt: credential.expiresAt.toISOString(), expired: false } : {}),
    };
  } catch (error) {
    if (error instanceof GithubAuthError && error.code === "expired-token") {
      return { identity, configured: false, sourceLabel: `ORCA_PI_GITHUB_${identity.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_TOKEN`, expired: true };
    }
    // Fall through to disk below (missing-credential).
  }
  // 2. Disk cache file (async, no mint).
  let providerFs = options?.providerFs;
  if (!providerFs) {
    try {
      providerFs = await nodeProviderFs();
    } catch {
      return { identity, configured: false, sourceLabel: `ORCA_PI_GITHUB_${identity.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_TOKEN` };
    }
  }
  try {
    // Reuse ensure's disk path without minting: attempt a resolve that
    // will hit disk when fresh but fail (missing App config) otherwise.
    // To avoid an unintended mint attempt, first probe the file directly.
    const path = tokenCacheFileForIdentity(identity, {
      ...(options?.env !== undefined ? { env: options.env } : {}),
      ...(options?.homedir !== undefined ? { homedir: options.homedir } : {}),
      ...(options?.osHomedir !== undefined ? { osHomedir: options.osHomedir } : {}),
    });
    const text = await providerFs.readFile(path, "utf8").catch(() => undefined);
    if (!text) {
      return { identity, configured: false, sourceLabel: `ORCA_PI_GITHUB_${identity.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_TOKEN` };
    }
    const parsed = JSON.parse(text) as { token?: unknown; expiresAt?: unknown; installationId?: unknown };
    if (typeof parsed.token !== "string" || !parsed.token.trim()) {
      return { identity, configured: false, sourceLabel: `ORCA_PI_GITHUB_${identity.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_TOKEN` };
    }
    if (typeof parsed.expiresAt === "string" && parsed.expiresAt.trim()) {
      const time = Date.parse(parsed.expiresAt);
      if (Number.isNaN(time)) {
        return { identity, configured: false, sourceLabel: `ORCA_PI_GITHUB_${identity.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_TOKEN` };
      }
      const skew = 5 * 60 * 1000;
      if (time <= (options?.nowMs ?? Date.now()) + skew) {
        return { identity, configured: false, sourceLabel: path, expired: true };
      }
      // Warm memory for subsequent writes in this process.
      const expiresAt = new Date(time);
      cache.set(identity, {
        token: parsed.token.trim(),
        expiresAt,
        ...(typeof parsed.installationId === "string" && parsed.installationId.trim()
          ? { installationId: parsed.installationId.trim() }
          : {}),
      });
      return { identity, configured: true, sourceLabel: `${path} (cache-file)`, expiresAt: expiresAt.toISOString(), expired: false };
    }
    // No expiry (long-lived cache entry, e.g. test fixture): treat as configured.
    cache.set(identity, { token: parsed.token.trim() });
    return { identity, configured: true, sourceLabel: `${path} (cache-file)` };
  } catch {
    return { identity, configured: false, sourceLabel: `ORCA_PI_GITHUB_${identity.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_TOKEN` };
  }
}

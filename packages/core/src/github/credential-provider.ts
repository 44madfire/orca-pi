/**
 * Out-of-LLM GitHub App credential provider (OP1.12).
 *
 * Mints/refreshes Worker and Reviewer installation tokens outside model
 * context from local App private keys. Private keys are consumed from a
 * local secret path (never prompt/task/profile text), tokens are cached
 * with expiry and refreshed before expiration, and token/private-key
 * values never appear in logs/errors/output.
 *
 * Env contract per identity (logical slot `worker` / `reviewer`):
 * - `ORCA_PI_GITHUB_<IDENT>_APP_ID` — numeric GitHub App id (operator-set).
 * - `ORCA_PI_GITHUB_<IDENT>_PRIVATE_KEY_PATH` (alias `..._PRIVATE_KEY_FILE`)
 *   — local PEM path (Windows `C:\\...` and WSL `/mnt/c/...` both
 *   supported; `~` expands via HOME/os.homedir).
 * - `ORCA_PI_GITHUB_<IDENT>_INSTALLATION_ID` — numeric installation id.
 * - `ORCA_PI_GITHUB_<IDENT>_LOGIN` — expected bot login
 *   (e.g. `orca-pi-worker[bot]`), used for distinct-actor checks.
 * - `ORCA_PI_GITHUB_<IDENT>_TOKEN` (+ `..._EXPIRES_AT`) — direct token
 *   slot (existing OP1.9 contract); the provider prefers a fresh env token
 *   when present and only mints when it is missing/expired.
 *
 * Short-lived installation tokens are additionally cached on disk
 * (`<config-dir>/github-tokens/<identity>.json`, mode 0600) so repeated
 * `exec`/`review` invocations refresh explicitly instead of re-minting.
 */

import { createHash } from "node:crypto";
import {
  expiryEnvVarForIdentity,
  redactSecretsFromText,
  tokenEnvVarForIdentity,
} from "./identity.js";
import {
  GithubApiError,
  GithubAuthError,
  type GithubFetchFn,
  type ResolvedGithubCredential,
} from "./types.js";
import type { InstallationTokenCache } from "./github-app-auth.js";
import { defaultTokenCache } from "./github-app-auth.js";

/** Refresh ahead of expiry so workers never use a token at the edge. */
export const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
/** Clock skew tolerance for env-supplied expiry evaluation. */
const ENV_EXPIRY_SKEW_MS = 60_000;

export interface CredentialProviderFs {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, options?: { mode?: number }): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void>;
}

function slotForIdentity(identity: string): string {
  const slot = identity
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slot || "TOKEN";
}

/** `ORCA_PI_GITHUB_<IDENT>_APP_ID` */
export function appIdEnvVarForIdentity(identity: string): string {
  return `ORCA_PI_GITHUB_${slotForIdentity(identity)}_APP_ID`;
}
/** `ORCA_PI_GITHUB_<IDENT>_PRIVATE_KEY_PATH` (canonical). */
export function privateKeyPathEnvVarForIdentity(identity: string): string {
  return `ORCA_PI_GITHUB_${slotForIdentity(identity)}_PRIVATE_KEY_PATH`;
}
/** Alias honored for operator convenience. */
export function privateKeyFileAliasForIdentity(identity: string): string {
  return `ORCA_PI_GITHUB_${slotForIdentity(identity)}_PRIVATE_KEY_FILE`;
}
/** `ORCA_PI_GITHUB_<IDENT>_INSTALLATION_ID` */
export function installationIdEnvVarForIdentity(identity: string): string {
  return `ORCA_PI_GITHUB_${slotForIdentity(identity)}_INSTALLATION_ID`;
}
/** `ORCA_PI_GITHUB_<IDENT>_LOGIN` */
export function loginEnvVarForIdentity(identity: string): string {
  return `ORCA_PI_GITHUB_${slotForIdentity(identity)}_LOGIN`;
}

// ---------------------------------------------------------------------------
// Windows / WSL path helpers (pure, tested without touching disk)
// ---------------------------------------------------------------------------

/** True for `C:\...`, `C:/...`, `D:...` drive paths. */
export function isWindowsDrivePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path.trim());
}

/**
 * Translate a Windows drive path to its WSL mount equivalent:
 * `C:\keys\worker.pem` → `/mnt/c/keys/worker.pem`.
 * Returns the input unchanged when it is not a drive path.
 */
export function windowsPathToWslPath(path: string): string {
  const trimmed = path.trim();
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(trimmed);
  if (!match) return trimmed;
  const drive = (match[1] as string).toLowerCase();
  const rest = (match[2] as string).replace(/\\/g, "/").replace(/^\/+/, "");
  return `/mnt/${drive}/${rest}`;
}

/** Expand a leading `~/` via an explicit home (never `~` literal). */
export function expandHomeInPath(path: string, homedir?: string): string {
  const trimmed = path.trim();
  if (trimmed === "~") return homedir?.trim() || trimmed;
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    const home = homedir?.trim();
    if (!home) return trimmed;
    return `${home.replace(/\/+$/, "")}/${trimmed.slice(2).replace(/\\/g, "/")}`;
  }
  return trimmed;
}

function resolveHomeDir(options?: {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  homedir?: string;
  osHomedir?: () => string;
}): string | undefined {
  const explicit = options?.homedir?.trim();
  if (explicit) return explicit;
  const envHome = options?.env?.HOME?.trim();
  if (envHome) return envHome;
  try {
    const osHome = options?.osHomedir?.()?.trim();
    if (osHome) return osHome;
  } catch {
    // No OS home available (constrained host) — callers fall back.
  }
  return undefined;
}

/**
 * Normalize a local secret path without touching disk: trim, expand `~`,
 * convert backslashes to forward slashes. Never logs the value itself —
 * callers log only the env var name.
 */
export function normalizeSecretPath(
  raw: string,
  options?: {
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    homedir?: string;
    osHomedir?: () => string;
  },
): string {
  const home = resolveHomeDir(options);
  const expanded = expandHomeInPath(raw, home);
  return expanded.replace(/\\/g, "/");
}

/**
 * Candidate filesystem paths for a configured secret path: the normalized
 * path plus, for Windows drive paths, the WSL `/mnt/<drive>/...`
 * translation. Readers try candidates in order so one config works from
 * both Windows Node and WSL Node.
 */
export function candidateSecretPaths(
  raw: string,
  options?: {
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    homedir?: string;
    osHomedir?: () => string;
  },
): string[] {
  const normalized = normalizeSecretPath(raw, options);
  const out = [normalized];
  if (isWindowsDrivePath(raw.trim())) {
    const wsl = windowsPathToWslPath(raw.trim());
    if (wsl !== normalized) out.push(wsl);
  }
  // Also try the raw trimmed value when normalization changed it (defense).
  const trimmedRaw = raw.trim();
  if (trimmedRaw !== normalized && !out.includes(trimmedRaw)) out.push(trimmedRaw);
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------
// Token cache file (0600, outside the repo, never logged)
// ---------------------------------------------------------------------------

function normalizeSlashes(input: string): string {
  return input.replace(/\\/g, "/").replace(/\/+$/, "");
}

function joinPosix(...parts: string[]): string {
  return parts
    .map((part, index) => (index === 0 ? part.replace(/\/+$/, "") : part.replace(/^\/+|\/+$/g, "")))
    .filter((part) => part.length > 0)
    .join("/");
}

function configDirForTokens(options?: {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  homedir?: string;
  osHomedir?: () => string;
}): string {
  const env = options?.env ?? process.env;
  const base = env.PI_CODING_AGENT_DIR?.trim();
  if (base) return joinPosix(normalizeSlashes(base), "github-tokens");
  const home =
    options?.homedir?.trim() || env.HOME?.trim() || resolveHomeDir(options);
  if (home) return joinPosix(normalizeSlashes(home), ".pi/agent/github-tokens");
  return "~/.pi/agent/github-tokens";
}

/** Cache file for one identity (safe to log the path, never the content). */
export function tokenCacheFileForIdentity(
  identity: string,
  options?: {
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    homedir?: string;
    osHomedir?: () => string;
  },
): string {
  const safe = identity.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || "token";
  return joinPosix(configDirForTokens(options), `${safe}.json`);
}

interface DiskTokenEntry {
  token: string;
  expiresAt?: string;
  installationId?: string;
  login?: string;
}

async function loadDiskTokenEntry(
  identity: string,
  options: {
    fs: CredentialProviderFs;
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    homedir?: string;
    osHomedir?: () => string;
    nowMs?: number;
    skewMs?: number;
  },
): Promise<{ entry: DiskTokenEntry; path: string } | undefined> {
  const path = tokenCacheFileForIdentity(identity, {
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.homedir !== undefined ? { homedir: options.homedir } : {}),
    ...(options.osHomedir !== undefined ? { osHomedir: options.osHomedir } : {}),
  });
  let text: string;
  try {
    text = await options.fs.readFile(path, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;
  if (typeof record.token !== "string" || record.token.trim().length === 0) return undefined;
  const now = options.nowMs ?? Date.now();
  const skew = options.skewMs ?? TOKEN_REFRESH_SKEW_MS;
  if (typeof record.expiresAt === "string" && record.expiresAt.trim().length > 0) {
    const time = Date.parse(record.expiresAt);
    if (Number.isNaN(time)) return undefined;
    if (time <= now + skew) return undefined;
  }
  return {
    entry: {
      token: (record.token as string).trim(),
      ...(typeof record.expiresAt === "string" ? { expiresAt: record.expiresAt } : {}),
      ...(typeof record.installationId === "string" ? { installationId: record.installationId } : {}),
      ...(typeof record.login === "string" ? { login: record.login } : {}),
    },
    path,
  };
}

async function saveDiskTokenEntry(
  identity: string,
  entry: DiskTokenEntry,
  options: {
    fs: CredentialProviderFs;
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    homedir?: string;
    osHomedir?: () => string;
  },
): Promise<string> {
  const path = tokenCacheFileForIdentity(identity, {
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.homedir !== undefined ? { homedir: options.homedir } : {}),
    ...(options.osHomedir !== undefined ? { osHomedir: options.osHomedir } : {}),
  });
  const dir = path.split("/").slice(0, -1).join("/") || ".";
  try {
    await options.fs.mkdir(dir, { recursive: true, mode: 0o700 });
  } catch {
    // Best-effort: the write below may still succeed.
  }
  await options.fs.writeFile(path, JSON.stringify(entry, null, 2), { mode: 0o600 });
  return path;
}

// ---------------------------------------------------------------------------
// App JWT (RS256) — pure except for node:crypto signing
// ---------------------------------------------------------------------------

function base64url(input: Buffer | string): string {
  const buffer = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Create a GitHub App JWT (`RS256`, 10-minute max lifetime).
 * `nowMs` is injectable for deterministic tests. Never logs the key.
 */
export function createAppJwt(options: {
  appId: string;
  privateKeyPem: string;
  nowMs?: number;
}): string {
  const appId = options.appId.trim();
  if (!appId) {
    throw new GithubAuthError(
      "app",
      "missing-credential",
      `Missing GitHub App id: export the numeric App id outside LLM context (e.g. ORCA_PI_GITHUB_WORKER_APP_ID) and retry. Never place App ids from untrusted text — use operator-configured env.`,
    );
  }
  const pem = options.privateKeyPem;
  if (!pem || !pem.includes("BEGIN") || !pem.includes("PRIVATE KEY")) {
    throw new GithubAuthError(
      "app",
      "missing-credential",
      `GitHub App private key is missing or not PEM-encoded (expected "-----BEGIN ... PRIVATE KEY-----"). ` +
        `Store the .pem outside the repo (e.g. ~/.pi/github-apps/<identity>.pem, mode 0600) and point ORCA_PI_GITHUB_<IDENTITY>_PRIVATE_KEY_PATH at it — never paste keys into prompts, task text, or env dumps.`,
    );
  }
  const nowSec = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ iat: nowSec - 60, exp: nowSec + 600, iss: appId }),
  );
  const signingInput = `${header}.${payload}`;
  let signature: Buffer;
  try {
    // Lazy require keeps core importable where node:crypto is stubbed.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const crypto = require("node:crypto") as typeof import("node:crypto");
    const signer = crypto.createSign("RSA-SHA256");
    signer.update(signingInput);
    signer.end();
    signature = signer.sign(pem);
  } catch (error) {
    throw new GithubAuthError(
      "app",
      "helper-failed",
      `Could not sign GitHub App JWT (check the PEM at the configured private-key path has mode 0600 and is a valid RSA key): ${error instanceof Error ? error.message : String(error)}. ` +
        `Keys never appear in this message.`,
    );
  }
  return `${signingInput}.${base64url(signature)}`;
}

/** Fingerprint helper for diagnostics that must never carry values. */
export function fingerprintForDiagnostics(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}

// ---------------------------------------------------------------------------
// Installation token mint (JWT → IAT exchange)
// ---------------------------------------------------------------------------

export interface MintedInstallationToken {
  token: string;
  expiresAt?: Date;
}

function apiBaseUrl(apiBase?: string): string {
  return (apiBase ?? "https://api.github.com").replace(/\/+$/, "");
}

function defaultFetchFn(): GithubFetchFn {
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

/**
 * Exchange an App JWT for an installation access token
 * (`POST /app/installations/{id}/access_tokens`). Never logs JWT/token.
 */
export async function mintInstallationToken(options: {
  installationId: string;
  appJwt: string;
  fetchFn?: GithubFetchFn;
  apiBase?: string;
}): Promise<MintedInstallationToken> {
  const installationId = options.installationId.trim();
  if (!installationId) {
    throw new GithubAuthError(
      "app",
      "missing-credential",
      `Missing GitHub App installation id: export ORCA_PI_GITHUB_<IDENTITY>_INSTALLATION_ID (numeric, from the App install URL) outside LLM context and retry.`,
    );
  }
  const fetchFn = options.fetchFn ?? defaultFetchFn();
  const base = apiBaseUrl(options.apiBase);
  const endpoint = `/app/installations/${encodeURIComponent(installationId)}/access_tokens`;
  let response;
  try {
    response = await fetchFn(`${base}${endpoint}`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${options.appJwt}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({}),
    });
  } catch (error) {
    throw new GithubAuthError(
      "app",
      "helper-failed",
      `Could not mint installation token (${endpoint}): ${redactSecretsFromText(error instanceof Error ? error.message : String(error), [options.appJwt])}`,
    );
  }
  if (!response.ok) {
    if (response.status === 401) {
      throw new GithubAuthError(
        "app",
        "expired-token",
        `GitHub rejected the App JWT for ${endpoint} (401). The App private key or App id may be wrong, or the JWT clock is skewed — verify ORCA_PI_GITHUB_<IDENTITY>_APP_ID and the PEM at ORCA_PI_GITHUB_<IDENTITY>_PRIVATE_KEY_PATH outside LLM context and retry.`,
      );
    }
    if (response.status === 403 || response.status === 404) {
      throw new GithubAuthError(
        "app",
        "unauthorized-installation",
        `GitHub denied installation-token mint for installation "${installationId}" (${response.status}). ` +
          `The App may not be installed on 44madfire/orca-pi or the installation id is wrong — install the App on the repository and export the numeric installation id.`,
      );
    }
    const text = await response.text().catch(() => "");
    throw new GithubApiError(
      endpoint,
      response.status,
      `GitHub installation-token mint failed (${response.status}): ${redactSecretsFromText(text.slice(0, 1000), [options.appJwt]) || "no response body"}.`,
    );
  }
  const data = (await response.json()) as { token?: unknown; expires_at?: unknown };
  if (typeof data.token !== "string" || !data.token.trim()) {
    throw new GithubApiError(
      endpoint,
      response.status,
      `GitHub installation-token mint succeeded but returned no token for installation "${installationId}".`,
    );
  }
  const token = data.token.trim();
  let expiresAt: Date | undefined;
  if (typeof data.expires_at === "string" && data.expires_at.trim()) {
    const time = Date.parse(data.expires_at);
    if (!Number.isNaN(time)) expiresAt = new Date(time);
  }
  return { token, ...(expiresAt ? { expiresAt } : {}) };
}

// ---------------------------------------------------------------------------
// App config resolution + ensure (env → disk cache → mint)
// ---------------------------------------------------------------------------

export interface AppIdentityConfig {
  appId: string;
  appIdVar: string;
  privateKeyPath?: string;
  privateKeyPathVar: string;
  installationId?: string;
  installationIdVar: string;
  login?: string;
  loginVar: string;
}

/** Non-secret App config presence (safe to log var names + booleans). */
export function describeAppConfigStatus(
  identity: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): {
  identity: string;
  appIdVar: string;
  appIdConfigured: boolean;
  privateKeyPathVar: string;
  privateKeyPathConfigured: boolean;
  installationIdVar: string;
  installationIdConfigured: boolean;
  loginVar: string;
  loginConfigured: boolean;
} {
  const appIdVar = appIdEnvVarForIdentity(identity);
  const keyVar = privateKeyPathEnvVarForIdentity(identity);
  const keyAlias = privateKeyFileAliasForIdentity(identity);
  const instVar = installationIdEnvVarForIdentity(identity);
  const loginVar = loginEnvVarForIdentity(identity);
  return {
    identity,
    appIdVar,
    appIdConfigured: !!env[appIdVar]?.trim(),
    privateKeyPathVar: keyVar,
    privateKeyPathConfigured: !!(env[keyVar]?.trim() || env[keyAlias]?.trim()),
    installationIdVar: instVar,
    installationIdConfigured: !!env[instVar]?.trim(),
    loginVar,
    loginConfigured: !!env[loginVar]?.trim(),
  };
}

function resolveAppIdentityConfig(
  identity: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): AppIdentityConfig {
  const appIdVar = appIdEnvVarForIdentity(identity);
  const keyVar = privateKeyPathEnvVarForIdentity(identity);
  const keyAlias = privateKeyFileAliasForIdentity(identity);
  const instVar = installationIdEnvVarForIdentity(identity);
  const loginVar = loginEnvVarForIdentity(identity);
  const appId = env[appIdVar]?.trim() || "";
  const privateKeyPath =
    env[keyVar]?.trim() || env[keyAlias]?.trim() || undefined;
  const installationId = env[instVar]?.trim() || undefined;
  const login = env[loginVar]?.trim() || undefined;
  return {
    appId,
    appIdVar,
    ...(privateKeyPath ? { privateKeyPath } : {}),
    privateKeyPathVar: env[keyVar]?.trim() ? keyVar : keyAlias,
    ...(installationId ? { installationId } : {}),
    installationIdVar: instVar,
    ...(login ? { login } : {}),
    loginVar,
  };
}

async function readPrivateKeyPem(
  configuredPath: string,
  options: {
    fs: CredentialProviderFs;
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    homedir?: string;
    osHomedir?: () => string;
  },
): Promise<{ pem: string; resolvedPath: string }> {
  const candidates = candidateSecretPaths(configuredPath, {
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.homedir !== undefined ? { homedir: options.homedir } : {}),
    ...(options.osHomedir !== undefined ? { osHomedir: options.osHomedir } : {}),
  });
  const tried: string[] = [];
  for (const candidate of candidates) {
    tried.push(candidate);
    try {
      const pem = await options.fs.readFile(candidate, "utf8");
      if (pem && pem.includes("PRIVATE KEY")) return { pem, resolvedPath: candidate };
    } catch {
      continue;
    }
  }
  throw new GithubAuthError(
    "app",
    "missing-credential",
    `Could not read GitHub App private key (tried ${tried.length} path${tried.length === 1 ? "" : "s"}; showing count only, never the key). ` +
      `Store the .pem outside the repo with mode 0600 and point the private-key path var at it (Windows C:\\... and WSL /mnt/c/... both supported; ~ expands via HOME). ` +
      `Never paste keys into prompts, task text, logs, or Linear descriptions.`,
  );
}

function parseEnvExpiry(
  raw: string | undefined,
  identity: string,
): Date | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const time = Date.parse(trimmed);
  if (Number.isNaN(time)) {
    throw new GithubAuthError(
      identity,
      "helper-failed",
      `Invalid expiry in ${expiryEnvVarForIdentity(identity)}: expected ISO-8601 (e.g. "2026-09-04T19:00:00Z"). Mint a fresh installation token outside LLM context and retry.`,
    );
  }
  return new Date(time);
}

/**
 * Ensure a fresh installation token for `identity` (out-of-LLM helper).
 *
 * Order: in-memory cache → env token (when fresh) → disk cache file (when
 * fresh) → App private-key mint. Records expiry and refreshes before
 * expiration (`TOKEN_REFRESH_SKEW_MS`). Never prints token/key values;
 * `sourceLabel` carries only var names / cache paths / App ids.
 */
export async function ensureInstallationToken(
  identity: string,
  options?: {
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    fetchFn?: GithubFetchFn;
    fs?: CredentialProviderFs;
    cache?: InstallationTokenCache;
    apiBase?: string;
    nowMs?: number;
    homedir?: string;
    osHomedir?: () => string;
  },
): Promise<ResolvedGithubCredential> {
  const env = options?.env ?? process.env;
  const cache = options?.cache ?? defaultTokenCache;
  const nowMs = options?.nowMs ?? Date.now();

  // 1. In-memory cache (honors refresh skew).
  const cached = cache.get(identity);
  if (cached) {
    // `createInstallationTokenCache` uses its own 60s skew; re-check the
    // stricter refresh skew here so long-lived processes refresh early.
    if (!cached.expiresAt || cached.expiresAt.getTime() > nowMs + TOKEN_REFRESH_SKEW_MS) {
      return {
        identity,
        sourceLabel: `${tokenEnvVarForIdentity(identity)} (cached)`,
        token: cached.token,
        ...(cached.expiresAt ? { expiresAt: cached.expiresAt } : {}),
        ...(cached.installationId ? { installationId: cached.installationId } : {}),
      };
    }
    cache.clear(identity);
  }

  // 2. Direct env token (existing OP1.9 contract) when fresh.
  const tokenVar = tokenEnvVarForIdentity(identity);
  const envToken = env[tokenVar]?.trim();
  if (envToken) {
    const expiresAt = parseEnvExpiry(env[expiryEnvVarForIdentity(identity)], identity);
    if (!expiresAt || expiresAt.getTime() > nowMs + ENV_EXPIRY_SKEW_MS) {
      const instVar = installationIdEnvVarForIdentity(identity);
      const installationId = env[instVar]?.trim() || undefined;
      if (expiresAt) {
        cache.set(identity, {
          token: envToken,
          expiresAt,
          ...(installationId ? { installationId } : {}),
        });
      }
      return {
        identity,
        sourceLabel: tokenVar,
        token: envToken,
        ...(expiresAt ? { expiresAt } : {}),
        ...(installationId ? { installationId } : {}),
      };
    }
    throw new GithubAuthError(
      identity,
      "expired-token",
      `GitHub credential for identity "${identity}" is expired (from ${tokenVar}). ` +
        `Mint a fresh installation access token outside LLM context and retry — never paste tokens into prompts or task text.`,
    );
  }

  // 3. Disk cache file (0600, outside repo) when fresh.
  if (options?.fs) {
    const disk = await loadDiskTokenEntry(identity, {
      fs: options.fs,
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.homedir !== undefined ? { homedir: options.homedir } : {}),
      ...(options.osHomedir !== undefined ? { osHomedir: options.osHomedir } : {}),
      nowMs,
      skewMs: TOKEN_REFRESH_SKEW_MS,
    });
    if (disk) {
      const expiresAt = disk.entry.expiresAt ? new Date(disk.entry.expiresAt) : undefined;
      cache.set(identity, {
        token: disk.entry.token,
        ...(expiresAt ? { expiresAt } : {}),
        ...(disk.entry.installationId ? { installationId: disk.entry.installationId } : {}),
      });
      return {
        identity,
        sourceLabel: `${disk.path} (cache-file)`,
        token: disk.entry.token,
        ...(expiresAt ? { expiresAt } : {}),
        ...(disk.entry.installationId ? { installationId: disk.entry.installationId } : {}),
      };
    }
  }

  // 4. Mint via App private key (out-of-LLM).
  const app = resolveAppIdentityConfig(identity, env);
  if (!app.appId || !app.privateKeyPath || !app.installationId) {
    const missing: string[] = [];
    if (!app.appId) missing.push(app.appIdVar);
    if (!app.privateKeyPath) missing.push(`${privateKeyPathEnvVarForIdentity(identity)} (or ${privateKeyFileAliasForIdentity(identity)})`);
    if (!app.installationId) missing.push(app.installationIdVar);
    throw new GithubAuthError(
      identity,
      "missing-credential",
      `Missing GitHub credential for identity "${identity}" (no ${tokenVar}, no fresh cache file, and App mint needs ${missing.join(", ")}). ` +
        `Run \`orca-pi github setup --identity ${identity}\` for the exact non-secret operator steps (create the GitHub App with the documented permissions, install it on 44madfire/orca-pi, store the .pem with mode 0600, export the vars outside LLM context). ` +
        `Never place private keys, installation tokens, PATs, or webhook secrets in prompts, task text, logs, or Linear descriptions.`,
    );
  }
  if (!options?.fs) {
    throw new GithubAuthError(
      identity,
      "helper-failed",
      `Cannot mint GitHub installation token for "${identity}" without filesystem access to the private key at ${app.privateKeyPathVar} (pass an fs handle or export ${tokenVar} directly outside LLM context).`,
    );
  }
  const { pem } = await readPrivateKeyPem(app.privateKeyPath, {
    fs: options.fs,
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.homedir !== undefined ? { homedir: options.homedir } : {}),
    ...(options.osHomedir !== undefined ? { osHomedir: options.osHomedir } : {}),
  });
  const jwt = createAppJwt({ appId: app.appId, privateKeyPem: pem, nowMs });
  const minted = await mintInstallationToken({
    installationId: app.installationId,
    appJwt: jwt,
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
    ...(options.apiBase ? { apiBase: options.apiBase } : {}),
  });
  const credential: ResolvedGithubCredential = {
    identity,
    sourceLabel: `minted via App ${app.appId} (installation ${app.installationId})`,
    token: minted.token,
    ...(minted.expiresAt ? { expiresAt: minted.expiresAt } : {}),
    installationId: app.installationId,
  };
  if (minted.expiresAt) {
    cache.set(identity, { token: minted.token, expiresAt: minted.expiresAt, installationId: app.installationId });
  }
  // Persist to disk cache (best-effort; a save failure never fails the mint).
  try {
    await saveDiskTokenEntry(
      identity,
      {
        token: minted.token,
        ...(minted.expiresAt ? { expiresAt: minted.expiresAt.toISOString() } : {}),
        installationId: app.installationId,
        ...(app.login ? { login: app.login } : {}),
      },
      {
        fs: options.fs,
        ...(options.env !== undefined ? { env: options.env } : {}),
        ...(options.homedir !== undefined ? { homedir: options.homedir } : {}),
        ...(options.osHomedir !== undefined ? { osHomedir: options.osHomedir } : {}),
      },
    );
  } catch {
    // Best-effort only.
  }
  // Scrub JWT from any chance of retention (strings are immutable, but drop refs).
  void fingerprintForDiagnostics(jwt);
  return credential;
}

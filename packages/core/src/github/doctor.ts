/**
 * GitHub identity diagnostics (OP1.12, blockers 1+3).
 *
 * `doctor` reports only non-secret information:
 * - expected logical identity + permissions;
 * - configured App/bot login + installation id (names, never values);
 * - repository access + permission validation;
 * - token configured/refreshable + expiry status;
 * - whether worker/reviewer/ambient human actors are distinct.
 *
 * Network contract (fail-closed):
 * - IAT-class proof uses `GET /installation/repositories` with the
 *   installation token (IAT-supported; `GET /user` never works for IATs).
 * - Repository installation/permission validation uses
 *   `GET /repos/{owner}/{repo}/installation` with a GitHub App JWT
 *   (JWT-only per GitHub REST docs — IATs explicitly do NOT work there).
 *   JWTs are built locally from `*_APP_ID` + `*_PRIVATE_KEY_PATH` (never
 *   logged) via `providerFs`.
 * - Production defaults to global `fetch` when available; when `--repo`
 *   verification is requested but could not run (no JWT/key/fetch), doctor
 *   records `repoAccess=false`/`permissionsValid=false` and `ok=false`
 *   (fail closed, never silent OK).
 *
 * All network access is injectable (`fetchFn`) so unit tests never hit
 * github.com. Tokens/keys/JWTs never enter the report.
 */

import {
  appIdEnvVarForIdentity,
  createAppJwt,
  describeAppConfigStatus,
  installationIdEnvVarForIdentity,
  loginEnvVarForIdentity,
  privateKeyFileAliasForIdentity,
  privateKeyPathEnvVarForIdentity,
  candidateSecretPaths,
  type CredentialProviderFs,
} from "./credential-provider.js";
import {
  defaultTokenCache,
  proveInstallationTokenClass,
  type InstallationTokenCache,
} from "./github-app-auth.js";
import { defaultTokenCache as defaultCacheAlias } from "./token-cache.js";
import {
  githubPermissionsForIdentity,
  sanitizeErrorForDisplay,
} from "./identity.js";
import {
  GithubApiError,
  GithubAuthError,
  type GithubFetchFn,
  type GithubIdentity,
} from "./types.js";
import { describeProductionCredentialStatus } from "./production-credential.js";

void defaultCacheAlias;

export interface IdentityDoctorEntry {
  identity: string;
  expectedPermissions: { contents: string; pullRequests: string; checks: string; metadata: string };
  configured: boolean;
  sourceLabel: string;
  expiresAt?: string;
  expired?: boolean;
  appLogin?: string;
  appLoginConfigured: boolean;
  installationId?: string;
  installationIdConfigured: boolean;
  tokenRefreshable: boolean;
  refreshVars: { appIdVar: string; keyVar: string; installationVar: string };
  iatProved?: boolean;
  iatError?: string;
  repoAccess?: boolean;
  repoError?: string;
  permissionsValid?: boolean;
  permissionDetail?: string;
}

export interface GithubDoctorReport {
  worker: IdentityDoctorEntry;
  reviewer: IdentityDoctorEntry;
  workerLogin?: string;
  reviewerLogin?: string;
  ambientLogin?: string;
  distinctWorkerReviewer?: boolean;
  distinctFromAmbient?: boolean;
  distinctDetail: string;
  setupNeeded: string[];
  ok: boolean;
}

function appLoginForIdentity(
  identity: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): { login?: string; configured: boolean; installationId?: string; instConfigured: boolean } {
  const upper = identity.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const loginVar = `ORCA_PI_GITHUB_${upper}_LOGIN`;
  const instVar = `ORCA_PI_GITHUB_${upper}_INSTALLATION_ID`;
  const login = env[loginVar]?.trim() || undefined;
  const installationId = env[instVar]?.trim() || undefined;
  return {
    ...(login ? { login } : {}),
    configured: !!login,
    ...(installationId ? { installationId } : {}),
    instConfigured: !!installationId,
  };
}

function refreshableForIdentity(
  identity: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): { refreshable: boolean; appIdVar: string; keyVar: string; installationVar: string } {
  const status = describeAppConfigStatus(identity, env);
  return {
    refreshable: status.appIdConfigured && status.privateKeyPathConfigured && status.installationIdConfigured,
    appIdVar: status.appIdVar,
    keyVar: status.privateKeyPathVar,
    installationVar: status.installationIdVar,
  };
}

function getDefaultFetchFn(): GithubFetchFn | undefined {
  const globalFetch = (globalThis as { fetch?: unknown }).fetch;
  if (typeof globalFetch !== "function") return undefined;
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

function apiBaseUrl(apiBase?: string): string {
  return (apiBase ?? "https://api.github.com").replace(/\/+$/, "");
}

/**
 * Build a GitHub App JWT for `identity` from local config (never logged).
 * Requires `*_APP_ID` + `*_PRIVATE_KEY_PATH` (or alias) + `providerFs`.
 */
async function resolveAppJwtForIdentity(
  identity: string,
  options: {
    env: NodeJS.ProcessEnv | Record<string, string | undefined>;
    providerFs: CredentialProviderFs;
    homedir?: string;
    osHomedir?: () => string;
    nowMs?: number;
  },
): Promise<{ jwt: string; appId: string }> {
  const env = options.env;
  const appIdVar = appIdEnvVarForIdentity(identity);
  const keyVar = privateKeyPathEnvVarForIdentity(identity);
  const keyAlias = privateKeyFileAliasForIdentity(identity);
  const appId = env[appIdVar]?.trim() || "";
  const keyPath = env[keyVar]?.trim() || env[keyAlias]?.trim() || "";
  if (!appId) {
    throw new GithubAuthError(
      identity,
      "missing-credential",
      `Cannot verify repository installation for "${identity}": missing ${appIdVar} (export the numeric App id outside LLM context).`,
    );
  }
  if (!keyPath) {
    throw new GithubAuthError(
      identity,
      "missing-credential",
      `Cannot verify repository installation for "${identity}": missing ${keyVar} (or ${keyAlias}) pointing at the App .pem (mode 0600).`,
    );
  }
  const candidates = candidateSecretPaths(keyPath, {
    env,
    ...(options.homedir ? { homedir: options.homedir } : {}),
    ...(options.osHomedir ? { osHomedir: options.osHomedir } : {}),
  });
  let pem: string | undefined;
  for (const candidate of candidates) {
    try {
      const text = await options.providerFs.readFile(candidate, "utf8");
      if (text && text.includes("PRIVATE KEY")) {
        pem = text;
        break;
      }
    } catch {
      continue;
    }
  }
  if (!pem) {
    throw new GithubAuthError(
      identity,
      "missing-credential",
      `Cannot verify repository installation for "${identity}": could not read App private key (tried ${candidates.length} path${candidates.length === 1 ? "" : "s"}; never logged). Check ${keyVar} points at a valid .pem with mode 0600.`,
    );
  }
  const jwt = createAppJwt({ appId, privateKeyPem: pem, ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}) });
  return { jwt, appId };
}

/**
 * JWT-only repository installation check:
 * `GET /repos/{owner}/{repo}/installation` with `Authorization: Bearer <JWT>`.
 * GitHub explicitly requires a JWT here — IATs do not work. Returns the
 * installation id + granted permissions for comparison.
 */
export async function fetchRepoInstallationWithJwt(options: {
  owner: string;
  repo: string;
  appJwt: string;
  fetchFn: GithubFetchFn;
  apiBase?: string;
}): Promise<{ installationId: string; permissions: Record<string, unknown> }> {
  const base = apiBaseUrl(options.apiBase);
  const endpoint = `/repos/${options.owner}/${options.repo}/installation`;
  let response;
  try {
    response = await options.fetchFn(`${base}${endpoint}`, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${options.appJwt}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  } catch (error) {
    throw new GithubAuthError(
      "app",
      "helper-failed",
      `Could not verify repository installation (${endpoint}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    if (response.status === 401) {
      throw new GithubAuthError(
        "app",
        "expired-token",
        `GitHub rejected the App JWT for ${endpoint} (401). Check the App id/private key and clock skew.`,
      );
    }
    if (response.status === 403 || response.status === 404) {
      // 404 here means no installation for this repo (or JWT for wrong App).
      throw new GithubAuthError(
        "app",
        "unauthorized-installation",
        `GitHub returned ${response.status} for ${endpoint} with the App JWT. The App is not installed on ${options.owner}/${options.repo} (or the JWT belongs to a different App). Install the App on the repository and retry.`,
      );
    }
    const text = await response.text().catch(() => "");
    throw new GithubApiError(endpoint, response.status, `Repository installation lookup failed (${response.status}): ${text.slice(0, 500) || "no body"}.`);
  }
  const data = (await response.json()) as { id?: unknown; permissions?: unknown };
  if (typeof data.id !== "number" && typeof data.id !== "string") {
    throw new GithubApiError(endpoint, response.status, `Repository installation lookup succeeded but returned no installation id.`);
  }
  const permissions = (data.permissions ?? {}) as Record<string, unknown>;
  return { installationId: String(data.id), permissions };
}

async function checkRepoAccessWithJwt(options: {
  identity: string;
  owner: string;
  repo: string;
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  providerFs?: CredentialProviderFs;
  fetchFn?: GithubFetchFn;
  apiBase?: string;
  homedir?: string;
  osHomedir?: () => string;
  nowMs?: number;
}): Promise<{ access: boolean; permissionsValid?: boolean; detail: string; installationId?: string }> {
  const fetchFn = options.fetchFn ?? getDefaultFetchFn();
  if (!fetchFn) {
    return { access: false, permissionsValid: false, detail: "no fetch available — cannot verify repository installation (fail closed)." };
  }
  if (!options.providerFs) {
    return {
      access: false,
      permissionsValid: false,
      detail: `no filesystem access to App private key (${privateKeyPathEnvVarForIdentity(options.identity)}) — cannot build JWT for repository installation check (fail closed).`,
    };
  }
  let jwt: string;
  try {
    const resolved = await resolveAppJwtForIdentity(options.identity, {
      env: options.env,
      providerFs: options.providerFs,
      ...(options.homedir ? { homedir: options.homedir } : {}),
      ...(options.osHomedir ? { osHomedir: options.osHomedir } : {}),
      ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
    });
    jwt = resolved.jwt;
  } catch (error) {
    return { access: false, permissionsValid: false, detail: sanitizeErrorForDisplay(error, options.env).slice(0, 300) };
  }
  let installation: { installationId: string; permissions: Record<string, unknown> };
  try {
    installation = await fetchRepoInstallationWithJwt({
      owner: options.owner,
      repo: options.repo,
      appJwt: jwt,
      fetchFn,
      apiBase: options.apiBase,
    });
  } catch (error) {
    return { access: false, permissionsValid: false, detail: sanitizeErrorForDisplay(error, options.env).slice(0, 300) };
  } finally {
    // Drop JWT reference (strings immutable, but avoid retention).
    jwt = "";
  }
  const configuredId = options.env[installationIdEnvVarForIdentity(options.identity)]?.trim();
  if (configuredId && configuredId !== installation.installationId) {
    return {
      access: false,
      permissionsValid: false,
      detail: `installation id mismatch: configured ${installationIdEnvVarForIdentity(options.identity)}=${configuredId} but GitHub reports installation ${installation.installationId} for ${options.owner}/${options.repo}. Fix the configured id outside LLM context.`,
      installationId: installation.installationId,
    };
  }
  const expected = githubPermissionsForIdentity(options.identity);
  const perms = installation.permissions;
  const actual: Record<string, string> = {
    contents: typeof perms.contents === "string" ? (perms.contents as string) : "?",
    pullRequests: typeof perms.pull_requests === "string" ? (perms.pull_requests as string) : "?",
    checks: typeof perms.checks === "string" ? (perms.checks as string) : (typeof perms.checks === "undefined" && expected.checks === "none" ? "none" : "?"),
    metadata: typeof perms.metadata === "string" ? (perms.metadata as string) : "?",
  };
  const mismatches: string[] = [];
  if (options.identity === "reviewer") {
    if (actual.contents !== "read") mismatches.push(`contents=${actual.contents} (want read; never write)`);
    if (actual.pullRequests !== "write") mismatches.push(`pull_requests=${actual.pullRequests} (want write)`);
    if (actual.checks !== "write") mismatches.push(`checks=${actual.checks} (want write)`);
  } else if (options.identity === "worker") {
    if (actual.contents !== "write") mismatches.push(`contents=${actual.contents} (want write)`);
    if (actual.pullRequests !== "write") mismatches.push(`pull_requests=${actual.pullRequests} (want write)`);
  }
  if (mismatches.length === 0) {
    return {
      access: true,
      permissionsValid: true,
      detail: `ok: installation ${installation.installationId} covers ${options.owner}/${options.repo} with expected permissions (verified via App JWT).`,
      installationId: installation.installationId,
    };
  }
  return {
    access: true,
    permissionsValid: false,
    detail: `permission mismatch (via App JWT): ${mismatches.join("; ")}.`,
    installationId: installation.installationId,
  };
}

async function nodeProviderFs(): Promise<CredentialProviderFs | undefined> {
  try {
    const fs = await import("node:fs/promises");
    return {
      readFile: (path: string, encoding: "utf8") => fs.readFile(path, encoding),
      writeFile: (path: string, data: string, options?: { mode?: number }) =>
        fs.writeFile(path, data, options as never) as Promise<void>,
      mkdir: (path: string, options?: { recursive?: boolean; mode?: number }) =>
        fs.mkdir(path, options as never) as Promise<void>,
    };
  } catch {
    return undefined;
  }
}

async function buildEntry(options: {
  identity: GithubIdentity;
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  cache: InstallationTokenCache;
  fetchFn?: GithubFetchFn;
  apiBase?: string;
  repo?: { owner: string; repo: string };
  providerFs?: CredentialProviderFs;
  homedir?: string;
  osHomedir?: () => string;
  nowMs?: number;
}): Promise<IdentityDoctorEntry> {
  const { identity, env, cache } = options;
  const expected = githubPermissionsForIdentity(identity);
  const expectedPermissions = {
    contents: expected.contents,
    pullRequests: expected.pullRequests,
    checks: expected.checks,
    metadata: expected.metadata,
  };
  // Credential presence via the centralized read-only production path
  // (env → disk cache, no mint). Never values.
  const status = await describeProductionCredentialStatus(identity, {
    env,
    cache,
    ...(options.providerFs ? { providerFs: options.providerFs } : {}),
    ...(options.homedir ? { homedir: options.homedir } : {}),
    ...(options.osHomedir ? { osHomedir: options.osHomedir } : {}),
    ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
  });
  const configured = status.configured;
  const sourceLabel = status.sourceLabel;
  const expiresAt = status.expiresAt;
  const expired = status.expired;
  const app = appLoginForIdentity(identity, env);
  const refresh = refreshableForIdentity(identity, env);

  const entry: IdentityDoctorEntry = {
    identity,
    expectedPermissions,
    configured,
    sourceLabel,
    ...(expiresAt ? { expiresAt } : {}),
    ...(expired !== undefined ? { expired } : {}),
    ...(app.login ? { appLogin: app.login } : {}),
    appLoginConfigured: app.configured,
    ...(app.installationId ? { installationId: app.installationId } : {}),
    installationIdConfigured: app.instConfigured,
    tokenRefreshable: refresh.refreshable,
    refreshVars: { appIdVar: refresh.appIdVar, keyVar: refresh.keyVar, installationVar: refresh.installationVar },
  };

  // IAT-class proof with real default network path (fail closed when it
  // cannot run). Uses the installation token (resolved via production
  // chain) on the IAT-supported endpoint.
  const fetchFn = options.fetchFn ?? getDefaultFetchFn();
  if (configured) {
    if (!fetchFn) {
      entry.iatProved = false;
      entry.iatError = "no fetch available — cannot prove installation-token class (fail closed).";
    } else {
      try {
        await proveInstallationTokenClass(identity, {
          fetchFn,
          env,
          cache,
          ...(options.apiBase ? { apiBase: options.apiBase } : {}),
          ...(options.providerFs ? { providerFs: options.providerFs } : {}),
          ...(options.homedir ? { homedir: options.homedir } : {}),
          ...(options.osHomedir ? { osHomedir: options.osHomedir } : {}),
          ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
        });
        entry.iatProved = true;
      } catch (error) {
        entry.iatProved = false;
        entry.iatError = sanitizeErrorForDisplay(error, env).slice(0, 300);
      }
    }
  }

  // Repo installation/permission validation via App JWT (JWT-only endpoint).
  // Fail closed when --repo is requested but verification could not run.
  if (options.repo) {
    let providerFs = options.providerFs;
    if (!providerFs) {
      providerFs = (await nodeProviderFs()) ?? undefined;
    }
    const result = await checkRepoAccessWithJwt({
      identity,
      owner: options.repo.owner,
      repo: options.repo.repo,
      env,
      ...(providerFs ? { providerFs } : {}),
      ...(fetchFn ? { fetchFn } : {}),
      apiBase: apiBaseUrl(options.apiBase),
      ...(options.homedir ? { homedir: options.homedir } : {}),
      ...(options.osHomedir ? { osHomedir: options.osHomedir } : {}),
      ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
    });
    entry.repoAccess = result.access;
    if (result.permissionsValid !== undefined) entry.permissionsValid = result.permissionsValid;
    entry.permissionDetail = result.detail;
    if (!result.access) entry.repoError = result.detail;
  }
  return entry;
}

/**
 * Run identity diagnostics for worker + reviewer. Never includes secret
 * values. `ambientLogin` (e.g. `44madfire` / `GITHUB_ACTOR`) enables the
 * three-actor distinctness check `worker != reviewer != ambient`.
 */
export async function doctorGithubIdentities(options?: {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  cache?: InstallationTokenCache;
  fetchFn?: GithubFetchFn;
  apiBase?: string;
  repo?: { owner: string; repo: string };
  ambientLogin?: string;
  providerFs?: CredentialProviderFs;
  homedir?: string;
  osHomedir?: () => string;
  nowMs?: number;
}): Promise<GithubDoctorReport> {
  const env = options?.env ?? process.env;
  const cache = options?.cache ?? defaultTokenCache;
  let providerFs = options?.providerFs;
  if (!providerFs) {
    providerFs = (await nodeProviderFs()) ?? undefined;
  }
  const fetchFn = options?.fetchFn ?? getDefaultFetchFn();
  const baseOpts = {
    env,
    cache,
    ...(fetchFn ? { fetchFn } : {}),
    ...(options?.apiBase ? { apiBase: options.apiBase } : {}),
    ...(providerFs ? { providerFs } : {}),
    ...(options?.homedir ? { homedir: options.homedir } : {}),
    ...(options?.osHomedir ? { osHomedir: options.osHomedir } : {}),
    ...(options?.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
  };
  const worker = await buildEntry({ identity: "worker", ...baseOpts, ...(options?.repo ? { repo: options.repo } : {}) });
  const reviewer = await buildEntry({ identity: "reviewer", ...baseOpts, ...(options?.repo ? { repo: options.repo } : {}) });

  const workerLogin = worker.appLogin;
  const reviewerLogin = reviewer.appLogin;
  const ambientLogin = options?.ambientLogin?.trim() || (env as Record<string, string | undefined>).GITHUB_ACTOR?.trim() || undefined;

  let distinctWorkerReviewer: boolean | undefined;
  if (workerLogin && reviewerLogin) {
    distinctWorkerReviewer = workerLogin.toLowerCase() !== reviewerLogin.toLowerCase();
  }
  let distinctFromAmbient: boolean | undefined;
  if (workerLogin && reviewerLogin && ambientLogin) {
    distinctFromAmbient =
      workerLogin.toLowerCase() !== ambientLogin.toLowerCase() &&
      reviewerLogin.toLowerCase() !== ambientLogin.toLowerCase();
  }

  const setupNeeded: string[] = [];
  for (const entry of [worker, reviewer]) {
    if (!entry.configured) {
      setupNeeded.push(
        `${entry.identity}: no credential in ${entry.sourceLabel}${entry.tokenRefreshable ? " (App config present — run `orca-pi github mint --identity " + entry.identity + "` outside LLM context)" : ` (run \`orca-pi github setup --identity ${entry.identity}\` for operator steps)`}`,
      );
    } else if (entry.expired) {
      setupNeeded.push(`${entry.identity}: token expired — mint a fresh installation token outside LLM context.`);
    }
    if (!entry.appLoginConfigured || !entry.installationIdConfigured) {
      setupNeeded.push(
        `${entry.identity}: missing App metadata (${[!entry.appLoginConfigured ? `ORCA_PI_GITHUB_${entry.identity.toUpperCase()}_LOGIN` : null, !entry.installationIdConfigured ? `ORCA_PI_GITHUB_${entry.identity.toUpperCase()}_INSTALLATION_ID` : null].filter(Boolean).join(", ")}) — set outside LLM context.`,
      );
    }
    if (entry.iatProved === false) {
      setupNeeded.push(`${entry.identity}: installation-token proof failed — ${entry.iatError ?? "see iatError"}.`);
    }
    if (options?.repo) {
      if (entry.repoAccess === false) {
        setupNeeded.push(`${entry.identity}: repository verification failed — ${entry.repoError ?? entry.permissionDetail ?? "see repoError"}.`);
      } else if (entry.permissionsValid === false) {
        setupNeeded.push(`${entry.identity}: ${entry.permissionDetail ?? "permission mismatch"}.`);
      } else if (entry.repoAccess === undefined || entry.permissionsValid === undefined) {
        setupNeeded.push(`${entry.identity}: repository verification did not run for ${options.repo.owner}/${options.repo.repo} (fail closed) — check App JWT/key/fetch.`);
      }
    } else if (entry.permissionsValid === false) {
      setupNeeded.push(`${entry.identity}: ${entry.permissionDetail ?? "permission mismatch"}.`);
    }
  }
  if (distinctWorkerReviewer === false) {
    setupNeeded.push(`worker and reviewer resolve to the same actor ("${workerLogin}") — provision distinct GitHub Apps (worker != reviewer).`);
  }
  if (distinctFromAmbient === false) {
    setupNeeded.push(`automation actor matches ambient human ("${ambientLogin}") — worker-authored PRs must not be authored by ${ambientLogin} (ChatGPT/human review needs a distinct author).`);
  }

  // Fail closed: absent proofs when verification was expected count as failure.
  const iatOk = (e: IdentityDoctorEntry) => (e.configured ? e.iatProved === true : true);
  const repoOk = (e: IdentityDoctorEntry) => {
    if (!options?.repo) return e.permissionsValid ?? true;
    return e.repoAccess === true && e.permissionsValid === true;
  };
  const ok =
    worker.configured &&
    reviewer.configured &&
    !worker.expired &&
    !reviewer.expired &&
    worker.appLoginConfigured &&
    reviewer.appLoginConfigured &&
    worker.installationIdConfigured &&
    reviewer.installationIdConfigured &&
    (distinctWorkerReviewer ?? false) &&
    (distinctFromAmbient ?? true) &&
    iatOk(worker) &&
    iatOk(reviewer) &&
    repoOk(worker) &&
    repoOk(reviewer);

  // When logins are unconfigured, distinctness is unknown → not ok.
  const distinctKnown = !!workerLogin && !!reviewerLogin;
  const finalOk = !!ok && distinctKnown;

  const distinctDetail =
    workerLogin && reviewerLogin
      ? ambientLogin
        ? `${workerLogin} != ${reviewerLogin} != ${ambientLogin} : ${distinctWorkerReviewer && distinctFromAmbient ? "distinct (ok)" : "NOT distinct (fix App installs)"}`
        : `${workerLogin} != ${reviewerLogin} : ${distinctWorkerReviewer ? "distinct (ok)" : "NOT distinct (same actor)"} (ambient unknown; pass --ambient <login> or set GITHUB_ACTOR to verify human distinctness)`
      : "actor distinctness unknown (configure ORCA_PI_GITHUB_WORKER_LOGIN / ORCA_PI_GITHUB_REVIEWER_LOGIN outside LLM context)";

  // Surface unused imports for lint stability (login helper vars are part of
  // the non-secret contract even when refresh path changes).
  void loginEnvVarForIdentity;
  void installationIdEnvVarForIdentity;

  return {
    worker,
    reviewer,
    ...(workerLogin ? { workerLogin } : {}),
    ...(reviewerLogin ? { reviewerLogin } : {}),
    ...(ambientLogin ? { ambientLogin } : {}),
    ...(distinctWorkerReviewer !== undefined ? { distinctWorkerReviewer } : {}),
    ...(distinctFromAmbient !== undefined ? { distinctFromAmbient } : {}),
    distinctDetail,
    setupNeeded,
    ok: finalOk,
  };
}

/** Human-readable doctor rendering (no secrets — logins/ids only). */
export function formatDoctorReport(report: GithubDoctorReport): string {
  const lines: string[] = ["github identity doctor (non-secret diagnostics)"];
  for (const entry of [report.worker, report.reviewer]) {
    lines.push(`  ${entry.identity}:`);
    lines.push(`    credential: ${entry.configured ? `configured via ${entry.sourceLabel}${entry.expiresAt ? ` (expires ${entry.expiresAt})` : ""}` : entry.expired ? `expired (see ${entry.sourceLabel})` : `missing (see ${entry.sourceLabel})`}`);
    lines.push(`    app: login ${entry.appLogin ?? "(missing)"} · installation ${entry.installationId ?? "(missing)"}`);
    lines.push(`    expected perms: contents=${entry.expectedPermissions.contents} pull_requests=${entry.expectedPermissions.pullRequests} checks=${entry.expectedPermissions.checks}`);
    lines.push(`    refreshable: ${entry.tokenRefreshable ? `yes (${entry.refreshVars.appIdVar} + ${entry.refreshVars.keyVar})` : `no (missing ${entry.refreshVars.appIdVar} / ${entry.refreshVars.keyVar} / ${entry.refreshVars.installationVar})`}`);
    if (entry.iatProved !== undefined) lines.push(`    installation-token proof: ${entry.iatProved ? "ok (GET /installation/repositories with IAT)" : `FAILED — ${entry.iatError ?? ""}`}`);
    if (entry.repoAccess !== undefined) lines.push(`    repo access: ${entry.repoAccess ? "ok" : `FAILED — ${entry.repoError ?? entry.permissionDetail ?? ""}`}${entry.permissionDetail ? ` (${entry.permissionDetail})` : ""} [JWT: GET /repos/{owner}/{repo}/installation]`);
  }
  lines.push(`  distinct actors: ${report.distinctDetail}`);
  lines.push(`  worker bot != reviewer bot != ${report.ambientLogin ?? "44madfire/human"} (ChatGPT connector acts as human; human holds final merge authority)`);
  if (report.setupNeeded.length > 0) {
    lines.push(`  next actions:`);
    for (const action of report.setupNeeded) lines.push(`    - ${action}`);
  } else {
    lines.push(`  ok: worker/reviewer actors distinct and credentials fresh.`);
  }
  return lines.join("\n");
}

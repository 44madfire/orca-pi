/**
 * GitHub identity diagnostics (OP1.12).
 *
 * `doctor` reports only non-secret information:
 * - expected logical identity + permissions;
 * - configured App/bot login + installation id (names, never values);
 * - repository access + permission validation (via IAT-supported APIs);
 * - token configured/refreshable + expiry status;
 * - whether worker/reviewer/ambient human actors are distinct.
 *
 * All network access is injectable (`fetchFn`) so unit tests never hit
 * github.com. Tokens/keys never enter the report.
 */

import {
  describeAppConfigStatus,
  type CredentialProviderFs,
} from "./credential-provider.js";
import {
  defaultTokenCache,
  proveInstallationTokenClass,
  resolveGithubCredential,
  type InstallationTokenCache,
} from "./github-app-auth.js";
import {
  expiryEnvVarForIdentity,
  githubPermissionsForIdentity,
  sanitizeErrorForDisplay,
  tokenEnvVarForIdentity,
} from "./identity.js";
import {
  GithubAuthError,
  type GithubFetchFn,
  type GithubIdentity,
} from "./types.js";

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

async function checkRepoAccess(options: {
  identity: string;
  owner: string;
  repo: string;
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  cache: InstallationTokenCache;
  fetchFn: GithubFetchFn;
  apiBase: string;
}): Promise<{ access: boolean; permissionsValid?: boolean; detail: string }> {
  const credential = resolveGithubCredential(options.identity, options.env, options.cache);
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${credential.token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  // Installation permission surface (IAT-supported): GET /repos/{o}/{r}/installation
  // returns `{ permissions: { contents, pull_requests, checks, metadata } }`.
  const endpoint = `/repos/${options.owner}/${options.repo}/installation`;
  let response;
  try {
    response = await options.fetchFn(`${options.apiBase}${endpoint}`, { method: "GET", headers });
  } catch (error) {
    return {
      access: false,
      detail: `network error: ${sanitizeErrorForDisplay(error, options.env).slice(0, 200)}`,
    };
  }
  if (!response.ok) {
    if (response.status === 404) {
      return { access: false, detail: "404: App installation does not cover this repository (install the App on the repo)." };
    }
    if (response.status === 401) {
      return { access: false, detail: "401: token expired/revoked — mint a fresh installation token outside LLM context." };
    }
    if (response.status === 403) {
      return { access: false, detail: "403: App lacks permission or is not installed — check App permissions/installation." };
    }
    return { access: false, detail: `${response.status}: could not verify installation.` };
  }
  const data = (await response.json()) as { permissions?: Record<string, unknown> };
  const perms = data.permissions ?? {};
  const expected = githubPermissionsForIdentity(options.identity);
  // Normalize GitHub API keys (`pull_requests`) to our camel-ish report.
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
    return { access: true, permissionsValid: true, detail: `ok: installation covers ${options.owner}/${options.repo} with expected permissions.` };
  }
  return { access: true, permissionsValid: false, detail: `permission mismatch: ${mismatches.join("; ")}.` };
}

async function buildEntry(options: {
  identity: GithubIdentity;
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  cache: InstallationTokenCache;
  fetchFn?: GithubFetchFn;
  apiBase?: string;
  repo?: { owner: string; repo: string };
}): Promise<IdentityDoctorEntry> {
  const { identity, env, cache } = options;
  const expected = githubPermissionsForIdentity(identity);
  const expectedPermissions = {
    contents: expected.contents,
    pullRequests: expected.pullRequests,
    checks: expected.checks,
    metadata: expected.metadata,
  };
  // Credential presence (never values).
  let configured = false;
  let sourceLabel = tokenEnvVarForIdentity(identity);
  let expiresAt: string | undefined;
  let expired: boolean | undefined;
  try {
    const credential = resolveGithubCredential(identity, env, cache);
    configured = true;
    sourceLabel = credential.sourceLabel;
    if (credential.expiresAt) expiresAt = credential.expiresAt.toISOString();
  } catch (error) {
    if (error instanceof GithubAuthError && error.code === "expired-token") {
      expired = true;
      try {
        const raw = env[expiryEnvVarForIdentity(identity)]?.trim();
        if (raw) expiresAt = new Date(raw).toISOString();
      } catch {
        // Ignore malformed expiry for display.
      }
    }
  }
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

  // IAT-class proof (only when a credential is configured; never values).
  if (configured && options.fetchFn) {
    try {
      await proveInstallationTokenClass(identity, {
        fetchFn: options.fetchFn,
        env,
        cache,
        ...(options.apiBase ? { apiBase: options.apiBase } : {}),
      });
      entry.iatProved = true;
    } catch (error) {
      entry.iatProved = false;
      entry.iatError = sanitizeErrorForDisplay(error, env).slice(0, 300);
    }
  }

  // Repo access + permission validation (only when repo + fetch available).
  if (options.repo && options.fetchFn && configured) {
    try {
      const result = await checkRepoAccess({
        identity,
        owner: options.repo.owner,
        repo: options.repo.repo,
        env,
        cache,
        fetchFn: options.fetchFn,
        apiBase: (options.apiBase ?? "https://api.github.com").replace(/\/+$/, ""),
      });
      entry.repoAccess = result.access;
      if (result.permissionsValid !== undefined) entry.permissionsValid = result.permissionsValid;
      entry.permissionDetail = result.detail;
      if (!result.access) entry.repoError = result.detail;
    } catch (error) {
      entry.repoAccess = false;
      entry.repoError = sanitizeErrorForDisplay(error, env).slice(0, 300);
    }
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
  fs?: CredentialProviderFs;
}): Promise<GithubDoctorReport> {
  const env = options?.env ?? process.env;
  const cache = options?.cache ?? defaultTokenCache;
  const baseOpts = {
    env,
    cache,
    ...(options?.fetchFn ? { fetchFn: options.fetchFn } : {}),
    ...(options?.apiBase ? { apiBase: options.apiBase } : {}),
  };
  const worker = await buildEntry({ identity: "worker", ...baseOpts, ...(options?.repo ? { repo: options.repo } : {}) });
  const reviewer = await buildEntry({ identity: "reviewer", ...baseOpts, ...(options?.repo ? { repo: options.repo } : {}) });

  const workerLogin = worker.appLogin;
  const reviewerLogin = reviewer.appLogin;
  const ambientLogin = options?.ambientLogin?.trim() || env.GITHUB_ACTOR?.trim() || undefined;

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
    if (entry.permissionsValid === false) {
      setupNeeded.push(`${entry.identity}: ${entry.permissionDetail ?? "permission mismatch"}.`);
    }
  }
  if (distinctWorkerReviewer === false) {
    setupNeeded.push(`worker and reviewer resolve to the same actor ("${workerLogin}") — provision distinct GitHub Apps (worker != reviewer).`);
  }
  if (distinctFromAmbient === false) {
    setupNeeded.push(`automation actor matches ambient human ("${ambientLogin}") — worker-authored PRs must not be authored by ${ambientLogin} (ChatGPT/human review needs a distinct author).`);
  }

  const ok =
    worker.configured &&
    reviewer.configured &&
    !worker.expired &&
    !reviewer.expired &&
    worker.appLoginConfigured &&
    reviewer.appLoginConfigured &&
    worker.installationIdConfigured &&
    reviewer.installationIdConfigured &&
    (distinctWorkerReviewer ?? true) &&
    (distinctFromAmbient ?? true) &&
    (worker.iatProved ?? true) &&
    (reviewer.iatProved ?? true) &&
    (worker.permissionsValid ?? true) &&
    (reviewer.permissionsValid ?? true);

  const distinctDetail =
    workerLogin && reviewerLogin
      ? ambientLogin
        ? `${workerLogin} != ${reviewerLogin} != ${ambientLogin} : ${distinctWorkerReviewer && distinctFromAmbient ? "distinct (ok)" : "NOT distinct (fix App installs)"}`
        : `${workerLogin} != ${reviewerLogin} : ${distinctWorkerReviewer ? "distinct (ok)" : "NOT distinct (same actor)"} (ambient unknown; pass --ambient <login> or set GITHUB_ACTOR to verify human distinctness)`
      : "actor distinctness unknown (configure ORCA_PI_GITHUB_WORKER_LOGIN / ORCA_PI_GITHUB_REVIEWER_LOGIN outside LLM context)";

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
    ok: !!ok,
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
    if (entry.iatProved !== undefined) lines.push(`    installation-token proof: ${entry.iatProved ? "ok" : `FAILED — ${entry.iatError ?? ""}`}`);
    if (entry.repoAccess !== undefined) lines.push(`    repo access: ${entry.repoAccess ? "ok" : `FAILED — ${entry.repoError ?? entry.permissionDetail ?? ""}`}${entry.permissionDetail ? ` (${entry.permissionDetail})` : ""}`);
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

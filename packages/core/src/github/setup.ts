/**
 * Idempotent GitHub App bootstrap/setup guidance (OP1.12).
 *
 * GitHub App creation/installation requires UI/admin interaction that
 * cannot be fully automated from the repo. This module therefore provides
 * the reproducible non-secret operator steps plus validation of the
 * resulting App/installation — the minimal unavoidable manual surface.
 *
 * No private keys, installation tokens, webhook secrets, or PATs are ever
 * emitted or committed. Steps reference env var *names* and permission
 * levels only.
 */

import { describeAppConfigStatus } from "./credential-provider.js";
import { githubPermissionsForIdentity } from "./identity.js";
import type { GithubIdentity } from "./types.js";

export const WORKER_APP_SLUG_SUGGESTION = "orca-pi-worker";
export const REVIEWER_APP_SLUG_SUGGESTION = "orca-pi-reviewer";
export const TARGET_REPO = "44madfire/orca-pi";

/**
 * Non-secret operator steps for one identity. Idempotent: safe to re-run;
 * already-configured pieces are marked done, missing pieces list the exact
 * var/action still required.
 */
export function operatorSetupStepsForIdentity(
  identity: GithubIdentity,
  options?: { repo?: string },
): string[] {
  const repo = options?.repo ?? TARGET_REPO;
  const upper = identity.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const perms = githubPermissionsForIdentity(identity);
  const slug = identity === "reviewer" ? REVIEWER_APP_SLUG_SUGGESTION : WORKER_APP_SLUG_SUGGESTION;
  const appName = identity === "reviewer" ? "Orca-Pi Reviewer" : "Orca-Pi Worker";
  const contentsLine =
    identity === "reviewer"
      ? "Contents: read (never write — reviewer describes follow-ups, never pushes)"
      : "Contents: write (worker pushes branches + creates/updates PRs)";
  const checksLine =
    identity === "reviewer"
      ? "Checks: write (publishes orca-pi/agent-review)"
      : "Checks: none (worker never writes checks)";
  return [
    `1. Create the GitHub App "${appName}" (slug suggestion "${slug}"): https://github.com/settings/apps/new — Homepage URL can be https://github.com/${repo}; disable webhooks unless you operate a check-run receiver.`,
    `2. Set repository permissions exactly: ${contentsLine}; Pull requests: ${perms.pullRequests}; ${checksLine}; Metadata: read. Install initially only on ${repo}.`,
    `3. Install the App on ${repo} (App settings → Install App → Only select repositories → ${repo}); record the numeric installation id from the install URL (…/installations/<id>).`,
    `4. Generate a private key (App settings → Private keys → Generate); save the .pem outside the repo with mode 0600 (e.g. ~/.pi/github-apps/${slug}.pem). Never commit the .pem.`,
    `5. Export outside LLM context (shell profile / OS secret store → env, never prompt/task/profile text): ORCA_PI_GITHUB_${upper}_APP_ID=<numeric-app-id>, ORCA_PI_GITHUB_${upper}_PRIVATE_KEY_PATH=<pem-path> (Windows C:\\... and WSL /mnt/c/... both supported; ~ expands), ORCA_PI_GITHUB_${upper}_INSTALLATION_ID=<numeric-installation-id>, ORCA_PI_GITHUB_${upper}_LOGIN=<bot-login e.g. ${slug}[bot]>.`,
    `6. Mint (outside LLM context): orca-pi github mint --identity ${identity} — prints only expiry/installation/cache-path, never the token. Verify: orca-pi github auth status --identity ${identity} && orca-pi github identity doctor${options?.repo ? ` --repo ${options.repo}` : ""}.`,
    `7. Keep ChatGPT/human distinct: the ChatGPT GitHub connector continues to act as 44madfire (human review + final squash merge). Verify worker bot != reviewer bot != 44madfire via doctor before opening worker PRs.`,
  ];
}

/** Validation of one identity's non-secret config (fail-closed guidance). */
export function validateSetupForIdentity(
  identity: GithubIdentity,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): { ok: boolean; missing: string[]; guidance: string } {
  const status = describeAppConfigStatus(identity, env);
  const missing: string[] = [];
  if (!status.appIdConfigured) missing.push(status.appIdVar);
  if (!status.privateKeyPathConfigured) missing.push(`${status.privateKeyPathVar} (or alias)`);
  if (!status.installationIdConfigured) missing.push(status.installationIdVar);
  if (!status.loginConfigured) missing.push(status.loginVar);
  if (missing.length === 0) {
    return {
      ok: true,
      missing,
      guidance: `App config for "${identity}" looks complete (ids/paths/login present; values never shown). Mint with \`orca-pi github mint --identity ${identity}\` outside LLM context, then run \`orca-pi github identity doctor\`.`,
    };
  }
  return {
    ok: false,
    missing,
    guidance:
      `App config for "${identity}" is incomplete (missing ${missing.join(", ")}). ` +
      `Complete the non-secret operator steps (orca-pi github setup --identity ${identity}) — create/install the App, store the .pem with mode 0600, export the vars outside LLM context. ` +
      `Never place private keys, installation tokens, PATs, or webhook secrets in prompts, task text, logs, or repo files.`,
  };
}

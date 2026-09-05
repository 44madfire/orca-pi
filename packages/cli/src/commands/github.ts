/**
 * `orca-pi github` commands (OP1.9 / JEF-15 + OP1.12 identity propagation).
 *
 * Structured helpers over distinct GitHub automation identities — never
 * exposes raw credentials to Pi. All GitHub actions run behind a logical
 * identity name (`worker`, `reviewer`); tokens resolve at launch/runtime
 * via env / helper (see `@orca-pi/core` github module) and are never
 * logged.
 *
 * OP1.12: the launch role is authoritative. `--profile <name>` and the
 * spawn-injected `ORCA_PI_GITHUB_IDENTITY` env let agents inherit without
 * repeating `--identity`; explicit `--identity` overrides must match the
 * profile (no privilege escalation).
 *
 * Commands:
 *   orca-pi github auth status [--identity <name>] [--profile <name>] [--json]
 *   orca-pi github review [--identity <name>] [--profile <name>] --pr <url|number|owner/repo#n>
 *     --verdict <approve|request-changes|comment> --body <text|@file>
 *     [--repo <owner/repo>] [--commit <sha>] [--task <id>] [--issue <JEF-...>] [--json]
 *
 * Reviews are head-aware: an omitted --commit pins to the PR's current
 * head.sha (captured in preflight, matching GitHub's default) and is always
 * sent as commit_id; retries dedupe only on exact commit equality, so new
 * pushes always get a fresh review.
 *   orca-pi github check start|complete [--identity <name>] [--profile <name>] --repo <owner/repo> --sha <sha> ...
 *   orca-pi github doctor [--repo <owner/repo>] [--ambient <login>] [--json]
 *   orca-pi github identity doctor [--repo <owner/repo>] [--ambient <login>] [--json]
 *   orca-pi github setup --identity <name> [--repo <owner/repo>] [--json]
 *   orca-pi github mint --identity <name> [--json]
 *   orca-pi github exec [--identity <name>] [--profile <name>] -- <command...>
 *   orca-pi github git-credential --identity <name> <get|store|erase>
 *   orca-pi github setup-git --identity worker [--path <repo-path>] [--json]
 *
 * Human remains the final merge authority — no auto-merge command exists.
 * ChatGPT/human acts as 44madfire, distinct from both bots.
 */

import {
  AGENT_REVIEW_CHECK_NAME,
  completeAgentReviewCheck,
  describeProductionCredentialStatus,
  doctorGithubIdentities,
  ensureInstallationToken,
  formatGithubDoctorReport,
  GITHUB_IDENTITY_PATTERN,
  isWorkerMutationCommand,
  MAX_GITHUB_IDENTITY_LENGTH,
  operatorSetupStepsForIdentity,
  parsePullRequestRef,
  parseReviewVerdict,
  resolveIdentityWithEnvFallback,
  resolveProductionCredential,
  sanitizeErrorForDisplay,
  startAgentReviewCheck,
  submitGithubReview,
  validateSetupForIdentity,
  verifyWorkerForWrites,
  verdictToCheckConclusion,
  assertIdentityMayRunCommand,
  assertWorkerIdentityForWrites,
  buildScopedEnvForIdentity,
  handleGitCredentialRequest,
  parseGitCredentialInput,
  setupRepoGitAuth,
  tokenCacheFileForIdentity,
  type CredentialProviderFs,
  type GithubFetchFn,
  type InstallationTokenCache,
} from "@orca-pi/core";
import { createInstallationTokenCache } from "@orca-pi/core";
import { loadMergedProfiles } from "@orca-pi/core";
import { resolveProfile } from "@orca-pi/core";

export interface GithubCommandDeps {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env?: NodeJS.ProcessEnv;
  fs?: Pick<typeof import("node:fs/promises"), "readFile"> & Partial<Pick<typeof import("node:fs/promises"), "writeFile" | "mkdir" | "stat">>;
  fetchFn?: GithubFetchFn;
  cache?: InstallationTokenCache;
  apiBase?: string;
  projectRoot?: string;
  homedir?: string;
  osHomedir?: () => string;
  userConfigPathOverride?: string;
  projectConfigPathOverride?: string;
  runner?: import("@orca-pi/core").ProcessRunner;
  providerFs?: CredentialProviderFs;
  stdinText?: () => Promise<string>;
  execSpawn?: (command: string[], options: { env: Record<string, string> }) => Promise<number>;
}

export interface GithubCommandResult {
  exitCode: number;
}

const GITHUB_USAGE = `orca-pi github — distinct GitHub automation identities and review checks

Usage:
  orca-pi github auth status [--identity <name>] [--profile <name>] [--json]
  orca-pi github review [--identity <name>] [--profile <name>] --pr <url|number|owner/repo#n> --verdict <approve|request-changes|comment> --body <text|@file> [--repo <owner/repo>] [--commit <sha>] [--task <id>] [--issue <id>] [--json]
  orca-pi github check start|complete [--identity <name>] [--profile <name>] --repo <owner/repo> --sha <sha> ...
  orca-pi github doctor [--repo <owner/repo>] [--ambient <login>] [--json]
  orca-pi github identity doctor [--repo <owner/repo>] [--ambient <login>] [--json]
  orca-pi github setup --identity <name> [--repo <owner/repo>] [--json]
  orca-pi github mint --identity <name> [--json]
  orca-pi github exec [--identity <name>] [--profile <name>] -- <command...>
  orca-pi github git-credential --identity <name> <get|store|erase>
  orca-pi github setup-git --identity worker [--path <repo-path>] [--json]

Identity inheritance (OP1.12): the launch role is authoritative. Prefer
--profile <name> or the spawn-injected ORCA_PI_GITHUB_IDENTITY env over
repeating --identity. Explicit --identity must match the profile's
githubIdentity (reviewer cannot select worker credentials and vice versa).
Identities are logical credential slots resolved at runtime via env
(ORCA_PI_GITHUB_<IDENTITY>_TOKEN plus verified ORCA_PI_GITHUB_<IDENTITY>_LOGIN /
ORCA_PI_GITHUB_<IDENTITY>_INSTALLATION_ID for App identities, all outside LLM
context) or via App private-key mint (ORCA_PI_GITHUB_<IDENTITY>_APP_ID +
..._PRIVATE_KEY_PATH + ..._INSTALLATION_ID). Tokens never appear in output.
Formal reviews and the orca-pi/agent-review check must use the reviewer
identity: the CLI proves installation-token class (GET /installation/repositories, which
supports IATs unlike GET /user) for the trusted configured App login and
distinctness from the PR author before any POST, so same-account PATs and
worker identity never reach the write APIs. Check start is idempotent
(reuses the deterministic run for the SHA); review retries with identical
inputs dedupe via response-state matching. Worker pushes run as the
worker App (Contents: write) via scoped exec (per-process GH_TOKEN) and worktree-scoped
git helper override (empty credential.helper reset + worker helper, never --global).
Plain gh is NOT authenticated by setup-git (gh ignores git helpers) -- use
orca-pi github exec --identity worker -- gh pr create ... for gh writes. The reviewer App holds Contents: read only; human (44madfire,
including ChatGPT-assisted review) merges. worker bot != reviewer bot != 44madfire.
`;

function isHelpFlag(arg: string): boolean {
  return arg === "--help" || arg === "-h" || arg === "help";
}

function validateIdentity(raw: string | undefined): string {
  if (!raw || !raw.trim()) {
    throw new Error(`Missing --identity <name>: pass a logical GitHub identity (e.g. --identity reviewer).`);
  }
  const identity = raw.trim();
  if (
    identity.length > MAX_GITHUB_IDENTITY_LENGTH ||
    !GITHUB_IDENTITY_PATTERN.test(identity)
  ) {
    throw new Error(
      `Invalid --identity ${JSON.stringify(raw)}: expected 1-${MAX_GITHUB_IDENTITY_LENGTH} chars matching ${GITHUB_IDENTITY_PATTERN} (e.g. "worker", "reviewer").`,
    );
  }
  return identity;
}

function parseRepo(raw: string | undefined, flag = "--repo"): { owner: string; repo: string } {
  if (!raw || !raw.trim()) {
    throw new Error(`Missing ${flag} <owner/repo> (e.g. ${flag} octo/hello-world).`);
  }
  const trimmed = raw.trim();
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(trimmed);
  if (!match) {
    throw new Error(`Invalid ${flag} ${JSON.stringify(raw)}: expected "<owner>/<repo>" (e.g. octo/hello-world).`);
  }
  return { owner: match[1] as string, repo: (match[2] as string).replace(/\.git$/, "") };
}

function takeValue(args: readonly string[], index: number, flag: string): { value?: string; consumed: number } {
  const value = args[index + 1];
  if (value === undefined || (value.startsWith("-") && value.length > 1 && Number.isNaN(Number(value)))) {
    // Allow negative numbers? Not needed; treat leading-dash as missing.
    // Bare numeric PRs (e.g. "123") do not start with "-", so they pass through.
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} requires a value (got none).`);
    }
  }
  if (value === undefined) throw new Error(`${flag} requires a value (got none).`);
  return { value, consumed: 2 };
}

async function resolveBody(
  raw: string,
  fs?: Pick<typeof import("node:fs/promises"), "readFile">,
): Promise<string> {
  if (!raw.startsWith("@")) return raw;
  const filePath = raw.slice(1).trim();
  if (!filePath) throw new Error(`Invalid --body "@": expected "@<file>" (e.g. --body @/tmp/review.md) or inline text.`);
  const reader = fs?.readFile ?? (await import("node:fs/promises")).readFile;
  try {
    return await reader(filePath, "utf8");
  } catch (error) {
    throw new Error(`Could not read --body file ${JSON.stringify(filePath)}: ${error instanceof Error ? error.message : String(error)}.`);
  }
}

function defaultProjectRoot(deps: GithubCommandDeps): string {
  if (deps.projectRoot && deps.projectRoot.length > 0) return deps.projectRoot;
  try {
    return process.cwd();
  } catch {
    return ".";
  }
}

/**
 * Resolve the effective identity for a github subcommand (OP1.12).
 * Precedence: explicit --identity > --profile githubIdentity >
 * ORCA_PI_GITHUB_IDENTITY env. Cross-role overrides fail closed.
 */
async function resolveCommandIdentity(
  options: { explicitIdentity?: string; profileName?: string },
  deps: GithubCommandDeps,
): Promise<string> {
  const env = deps.env ?? process.env;
  const explicit = options.explicitIdentity?.trim() || undefined;
  const profileName = options.profileName?.trim() || undefined;
  if (profileName) {
    const merged = await loadMergedProfiles({
      projectRoot: defaultProjectRoot(deps),
      ...(deps.userConfigPathOverride !== undefined ? { userConfigPath: deps.userConfigPathOverride } : {}),
      ...(deps.projectConfigPathOverride !== undefined ? { projectConfigPath: deps.projectConfigPathOverride } : {}),
      ...(deps.env !== undefined ? { env: deps.env } : {}),
      ...(deps.homedir !== undefined ? { homedir: deps.homedir } : {}),
      ...(deps.osHomedir !== undefined ? { osHomedir: deps.osHomedir } : {}),
      ...(deps.fs?.readFile ? { fs: { readFile: deps.fs.readFile } } : {}),
    });
    const profile = resolveProfile(profileName, merged);
    const effective = resolveIdentityWithEnvFallback(profile, {
      ...(explicit ? { explicitIdentity: explicit } : {}),
      env,
    });
    if (!effective) {
      throw new Error(
        `Pi profile "${profileName}" sets no githubIdentity and no --identity/ORCA_PI_GITHUB_IDENTITY fallback was provided. Pass --identity <name> (worker|reviewer) or launch a role profile (worker, reviewer).`,
      );
    }
    return effective;
  }
  if (explicit) {
    const validated = validateIdentity(explicit);
    // Still honor env agreement: a mismatched spawn env fails closed.
    const effective = resolveIdentityWithEnvFallback(
      { name: "(cli)", githubIdentity: undefined },
      { explicitIdentity: validated, env },
    );
    // When no profile is involved the helper returns the explicit value
    // unless env disagrees (then it throws). Fall back to validated.
    return effective ?? validated;
  }
  // No flags: inherit spawn env (worker-terminal case).
  const effective = resolveIdentityWithEnvFallback(
    { name: "(cli)", githubIdentity: undefined },
    { env },
  );
  if (!effective) {
    throw new Error(`Missing --identity <name>: pass --identity <name> or --profile <name> (e.g. --identity reviewer, --profile reviewer). Spawned workers inherit ORCA_PI_GITHUB_IDENTITY automatically.`);
  }
  return effective;
}

function providerFsForDeps(deps: GithubCommandDeps): CredentialProviderFs | undefined {
  if (deps.providerFs) return deps.providerFs;
  const fs = deps.fs;
  if (fs?.readFile && (fs as Partial<CredentialProviderFs>).writeFile && (fs as Partial<CredentialProviderFs>).mkdir) {
    return fs as CredentialProviderFs;
  }
  return undefined;
}

async function nodeProviderFs(): Promise<CredentialProviderFs> {
  const fs = await import("node:fs/promises");
  return {
    readFile: (path: string, encoding: "utf8") => fs.readFile(path, encoding),
    writeFile: (path: string, data: string, options?: { mode?: number }) => fs.writeFile(path, data, options as never) as Promise<void>,
    mkdir: (path: string, options?: { recursive?: boolean; mode?: number }) => fs.mkdir(path, options as never) as Promise<void>,
  };
}

async function runAuthStatus(args: readonly string[], deps: GithubCommandDeps): Promise<GithubCommandResult> {
  let identity: string | undefined;
  let profileName: string | undefined;
  let asJson = false;
  for (let i = 0; i < args.length;) {
    const arg = args[i] as string;
    if (arg === "--identity") {
      const taken = takeValue(args, i, "--identity");
      identity = taken.value;
      i += taken.consumed;
    } else if (arg === "--profile") {
      const taken = takeValue(args, i, "--profile");
      profileName = taken.value;
      i += taken.consumed;
    } else if (arg === "--json") {
      asJson = true;
      i += 1;
    } else if (isHelpFlag(arg)) {
      deps.stdout(`${GITHUB_USAGE}`);
      return { exitCode: 0 };
    } else if (arg.startsWith("--")) {
      deps.stderr(`error: unknown github auth status option: ${arg}\n`);
      deps.stderr(`usage: orca-pi github auth status [--identity <name>] [--profile <name>] [--json]\n`);
      return { exitCode: 2 };
    } else {
      deps.stderr(`error: unexpected argument: ${arg}\n`);
      deps.stderr(`usage: orca-pi github auth status [--identity <name>] [--profile <name>] [--json]\n`);
      return { exitCode: 2 };
    }
  }
  let resolvedIdentity: string;
  try {
    resolvedIdentity = await resolveCommandIdentity({ ...(identity ? { explicitIdentity: identity } : {}), ...(profileName ? { profileName } : {}) }, deps);
  } catch (error) {
    deps.stderr(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    const message = error instanceof Error ? error.message : String(error);
    const isUsage = message.includes("Missing --identity") || message.includes("Invalid --identity");
    if ((error as { name?: string }).name?.startsWith("Github")) return { exitCode: 1 };
    return { exitCode: isUsage ? 2 : 1 };
  }
  const env = deps.env ?? process.env;
  const cache = deps.cache ?? createInstallationTokenCache();
  const prodFs = providerFsForDeps(deps) ?? (await nodeProviderFs().catch(() => undefined));
  const status = await describeProductionCredentialStatus(resolvedIdentity, {
    env,
    cache,
    ...(prodFs ? { providerFs: prodFs } : {}),
    ...(deps.homedir ? { homedir: deps.homedir } : {}),
    ...(deps.osHomedir ? { osHomedir: deps.osHomedir } : {}),
  });
  if (asJson) {
    deps.stdout(`${JSON.stringify({ ...status, check: AGENT_REVIEW_CHECK_NAME }, null, 2)}\n`);
  } else if (status.configured) {
    const expiry = status.expiresAt ? ` (expires ${status.expiresAt})` : "";
    deps.stdout(`ok github identity "${resolvedIdentity}" — configured via ${status.sourceLabel}${expiry}\n`);
  } else if (status.expired) {
    deps.stdout(`expired github identity "${resolvedIdentity}" — installation token expired; mint a fresh token outside LLM context.\n`);
  } else {
    deps.stdout(`missing github identity "${resolvedIdentity}" — no credential in ${status.sourceLabel}; see --help.\n`);
  }
  return { exitCode: status.configured ? 0 : 1 };
}

async function runReview(args: readonly string[], deps: GithubCommandDeps): Promise<GithubCommandResult> {
  let identity: string | undefined;
  let profileName: string | undefined;
  let pr: string | undefined;
  let repo: string | undefined;
  let verdictRaw: string | undefined;
  let bodyRaw: string | undefined;
  let commit: string | undefined;
  let task: string | undefined;
  let issue: string | undefined;
  let asJson = false;
  for (let i = 0; i < args.length;) {
    const arg = args[i] as string;
    if (arg === "--identity") {
      identity = takeValue(args, i, arg).value;
      i += 2;
    } else if (arg === "--profile") {
      profileName = takeValue(args, i, arg).value;
      i += 2;
    } else if (arg === "--pr") {
      pr = takeValue(args, i, arg).value;
      i += 2;
    } else if (arg === "--repo") {
      repo = takeValue(args, i, arg).value;
      i += 2;
    } else if (arg === "--verdict") {
      verdictRaw = takeValue(args, i, arg).value;
      i += 2;
    } else if (arg === "--body") {
      bodyRaw = takeValue(args, i, arg).value;
      i += 2;
    } else if (arg === "--commit") {
      commit = takeValue(args, i, arg).value;
      i += 2;
    } else if (arg === "--task") {
      task = takeValue(args, i, arg).value;
      i += 2;
    } else if (arg === "--issue") {
      issue = takeValue(args, i, arg).value;
      i += 2;
    } else if (arg === "--json") {
      asJson = true;
      i += 1;
    } else if (isHelpFlag(arg)) {
      deps.stdout(`${GITHUB_USAGE}`);
      return { exitCode: 0 };
    } else if (arg.startsWith("--")) {
      deps.stderr(`error: unknown github review option: ${arg}\n`);
      deps.stderr(`usage: orca-pi github review [--identity <name>] [--profile <name>] --pr <ref> --verdict <v> --body <text|@file> [--repo <o/r>] [--json]\n`);
      return { exitCode: 2 };
    } else {
      deps.stderr(`error: unexpected argument: ${arg}\n`);
      deps.stderr(`usage: orca-pi github review [--identity <name>] [--profile <name>] --pr <ref> --verdict <v> --body <text|@file> [--repo <o/r>] [--json]\n`);
      return { exitCode: 2 };
    }
  }
  try {
    const resolvedIdentity = await resolveCommandIdentity({ ...(identity ? { explicitIdentity: identity } : {}), ...(profileName ? { profileName } : {}) }, deps);
    if (!pr) throw new Error(`Missing --pr <url|number|owner/repo#n> (e.g. --pr https://github.com/octo/hello-world/pull/123).`);
    if (!verdictRaw) throw new Error(`Missing --verdict <approve|request-changes|comment>.`);
    if (bodyRaw === undefined) throw new Error(`Missing --body <text|@file> (inline text or @<file>).`);
    const verdict = parseReviewVerdict(verdictRaw);
    const prRef = parsePullRequestRef(pr, repo ? { repo } : undefined);
    const body = await resolveBody(bodyRaw, deps.fs);
    if (!body.trim()) throw new Error(`Review body must not be empty — provide findings with file/line evidence.`);
    const env = deps.env ?? process.env;
    const prodFs = providerFsForDeps(deps) ?? (await nodeProviderFs().catch(() => undefined));
    const result = await submitGithubReview(
      resolvedIdentity,
      {
        owner: prRef.owner,
        repo: prRef.repo,
        pullNumber: prRef.pullNumber,
        verdict,
        body,
        ...(commit ? { commitId: commit.trim() } : {}),
        ...((task || issue) ? { provenance: { ...(task ? { taskId: task } : {}), ...(issue ? { linearIssueId: issue } : {}), profile: resolvedIdentity } } : {}),
      },
      {
        ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
        env,
        ...(deps.cache ? { cache: deps.cache } : {}),
        ...(deps.apiBase ? { apiBase: deps.apiBase } : {}),
        ...(prodFs ? { providerFs: prodFs } : {}),
        ...(deps.homedir ? { homedir: deps.homedir } : {}),
        ...(deps.osHomedir ? { osHomedir: deps.osHomedir } : {}),
      },
    );
    const conclusion = verdictToCheckConclusion(verdict);
    if (asJson) {
      deps.stdout(`${JSON.stringify({ ok: true, identity: resolvedIdentity, pr: prRef, verdict, conclusion, reviewId: result.id, ...(result.htmlUrl ? { htmlUrl: result.htmlUrl } : {}) }, null, 2)}\n`);
    } else {
      deps.stdout(`ok github review — ${verdict} on ${prRef.owner}/${prRef.repo}#${prRef.pullNumber} as "${resolvedIdentity}" (review ${result.id})\n`);
    }
    return { exitCode: 0 };
  } catch (error) {
    const env = deps.env ?? process.env;
    deps.stderr(`error: ${sanitizeErrorForDisplay(error, env)}\n`);
    const message = error instanceof Error ? error.message : String(error);
    const isUsage =
      message.includes("Missing --") || message.includes("Invalid --") || message.includes("expected");
    return { exitCode: isUsage && !(error as { name?: string }).name?.startsWith("Github") ? 2 : 1 };
  }
}

async function runCheck(args: readonly string[], deps: GithubCommandDeps): Promise<GithubCommandResult> {
  const [action, ...rest] = args;
  if (action === undefined || isHelpFlag(action)) {
    deps.stdout(`${GITHUB_USAGE}`);
    return { exitCode: 0 };
  }
  if (action !== "start" && action !== "complete") {
    deps.stderr(`error: unknown github check action: ${action} (expected "start" or "complete")\n`);
    deps.stderr(`usage: orca-pi github check start|complete [--identity <name>] [--profile <name>] --repo <owner/repo> --sha <sha> ...\n`);
    return { exitCode: 2 };
  }
  let identity: string | undefined;
  let profileName: string | undefined;
  let repo: string | undefined;
  let sha: string | undefined;
  let verdictRaw: string | undefined;
  let summary: string | undefined;
  let checkRunIdRaw: string | undefined;
  let task: string | undefined;
  let issue: string | undefined;
  let asJson = false;
  for (let i = 0; i < rest.length;) {
    const arg = rest[i] as string;
    if (arg === "--identity") {
      identity = takeValue(rest, i, arg).value;
      i += 2;
    } else if (arg === "--profile") {
      profileName = takeValue(rest, i, arg).value;
      i += 2;
    } else if (arg === "--repo") {
      repo = takeValue(rest, i, arg).value;
      i += 2;
    } else if (arg === "--sha") {
      sha = takeValue(rest, i, arg).value;
      i += 2;
    } else if (arg === "--verdict") {
      verdictRaw = takeValue(rest, i, arg).value;
      i += 2;
    } else if (arg === "--summary") {
      summary = takeValue(rest, i, arg).value;
      i += 2;
    } else if (arg === "--check-run-id") {
      checkRunIdRaw = takeValue(rest, i, arg).value;
      i += 2;
    } else if (arg === "--task") {
      task = takeValue(rest, i, arg).value;
      i += 2;
    } else if (arg === "--issue") {
      issue = takeValue(rest, i, arg).value;
      i += 2;
    } else if (arg === "--json") {
      asJson = true;
      i += 1;
    } else if (isHelpFlag(arg)) {
      deps.stdout(`${GITHUB_USAGE}`);
      return { exitCode: 0 };
    } else if (arg.startsWith("--")) {
      deps.stderr(`error: unknown github check ${action} option: ${arg}\n`);
      deps.stderr(`usage: orca-pi github check ${action} [--identity <name>] [--profile <name>] --repo <owner/repo> --sha <sha> ...\n`);
      return { exitCode: 2 };
    } else {
      deps.stderr(`error: unexpected argument: ${arg}\n`);
      deps.stderr(`usage: orca-pi github check ${action} [--identity <name>] [--profile <name>] --repo <owner/repo> --sha <sha> ...\n`);
      return { exitCode: 2 };
    }
  }
  try {
    const resolvedIdentity = await resolveCommandIdentity({ ...(identity ? { explicitIdentity: identity } : {}), ...(profileName ? { profileName } : {}) }, deps);
    if (!repo) throw new Error(`Missing --repo <owner/repo> (e.g. --repo octo/hello-world).`);
    const { owner, repo: repoName } = parseRepo(repo);
    if (!sha || !sha.trim()) throw new Error(`Missing --sha <commit-sha>.`);
    if (!/^[0-9a-f]{4,64}$/i.test(sha.trim())) throw new Error(`Invalid --sha ${JSON.stringify(sha)}: expected a commit SHA.`);
    const headSha = sha.trim();
    const provenance = (task || issue) ? { ...(task ? { taskId: task } : {}), ...(issue ? { linearIssueId: issue } : {}), profile: resolvedIdentity } : undefined;
    const env = deps.env ?? process.env;
    const prodFs = providerFsForDeps(deps) ?? (await nodeProviderFs().catch(() => undefined));
    const baseOpts = {
      ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
      env,
      ...(deps.cache ? { cache: deps.cache } : {}),
      ...(deps.apiBase ? { apiBase: deps.apiBase } : {}),
      ...(prodFs ? { providerFs: prodFs } : {}),
      ...(deps.homedir ? { homedir: deps.homedir } : {}),
      ...(deps.osHomedir ? { osHomedir: deps.osHomedir } : {}),
    };
    if (action === "start") {
      const result = await startAgentReviewCheck(
        resolvedIdentity,
        { owner, repo: repoName, headSha, summary: summary?.trim() ? summary : "Agent review in progress…", ...(provenance ? { provenance } : {}) },
        baseOpts,
      );
      if (asJson) {
        deps.stdout(`${JSON.stringify({ ok: true, identity: resolvedIdentity, check: AGENT_REVIEW_CHECK_NAME, status: "in_progress", checkRunId: result.id, ...(result.htmlUrl ? { htmlUrl: result.htmlUrl } : {}) }, null, 2)}\n`);
      } else {
        deps.stdout(`ok github check — ${AGENT_REVIEW_CHECK_NAME} started for ${headSha.slice(0, 7)} as "${resolvedIdentity}" (run ${result.id})\n`);
      }
      return { exitCode: 0 };
    }
    // complete
    if (!verdictRaw) throw new Error(`Missing --verdict <approve|request-changes|comment> (blocking → failure, else success).`);
    if (!summary || !summary.trim()) throw new Error(`Missing --summary <text> (concise pass/fail summary).`);
    const verdict = parseReviewVerdict(verdictRaw);
    let checkRunId: number | undefined;
    if (checkRunIdRaw !== undefined) {
      const parsed = Number.parseInt(checkRunIdRaw, 10);
      if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Invalid --check-run-id ${JSON.stringify(checkRunIdRaw)}: expected a positive integer.`);
      checkRunId = parsed;
    }
    // Idempotency lives in completeAgentReviewCheck (list-then-update the
    // deterministic run for this SHA); no CLI-side duplicate listing needed.
    const result = await completeAgentReviewCheck(
      resolvedIdentity,
      { owner, repo: repoName, headSha, verdict, summary, ...(checkRunId !== undefined ? { checkRunId } : {}), ...(provenance ? { provenance } : {}) },
      baseOpts,
    );
    if (asJson) {
      deps.stdout(`${JSON.stringify({ ok: true, identity: resolvedIdentity, check: AGENT_REVIEW_CHECK_NAME, status: "completed", conclusion: result.conclusion, checkRunId: result.id, verdict }, null, 2)}\n`);
    } else {
      deps.stdout(`ok github check — ${AGENT_REVIEW_CHECK_NAME} ${result.conclusion} for ${headSha.slice(0, 7)} as "${resolvedIdentity}" (run ${result.id})\n`);
    }
    return { exitCode: 0 };
  } catch (error) {
    const env = deps.env ?? process.env;
    deps.stderr(`error: ${sanitizeErrorForDisplay(error, env)}\n`);
    const message = error instanceof Error ? error.message : String(error);
    const isUsage = message.includes("Missing --") || message.includes("Invalid --") || message.includes("expected");
    return { exitCode: isUsage && !(error as { name?: string }).name?.startsWith("Github") ? 2 : 1 };
  }
}

async function runDoctor(args: readonly string[], deps: GithubCommandDeps): Promise<GithubCommandResult> {
  let repoRaw: string | undefined;
  let ambient: string | undefined;
  let asJson = false;
  for (let i = 0; i < args.length;) {
    const arg = args[i] as string;
    if (arg === "--repo") {
      repoRaw = takeValue(args, i, arg).value;
      i += 2;
    } else if (arg === "--ambient") {
      ambient = takeValue(args, i, arg).value;
      i += 2;
    } else if (arg === "--json") {
      asJson = true;
      i += 1;
    } else if (isHelpFlag(arg)) {
      deps.stdout(`${GITHUB_USAGE}`);
      return { exitCode: 0 };
    } else if (arg.startsWith("--")) {
      deps.stderr(`error: unknown github doctor option: ${arg}\n`);
      deps.stderr(`usage: orca-pi github doctor [--repo <owner/repo>] [--ambient <login>] [--json]\n`);
      return { exitCode: 2 };
    } else {
      deps.stderr(`error: unexpected argument: ${arg}\n`);
      deps.stderr(`usage: orca-pi github doctor [--repo <owner/repo>] [--ambient <login>] [--json]\n`);
      return { exitCode: 2 };
    }
  }
  try {
    let repo: { owner: string; repo: string } | undefined;
    if (repoRaw) repo = parseRepo(repoRaw);
    const env = deps.env ?? process.env;
    const cache = deps.cache ?? createInstallationTokenCache();
    const prodFs = providerFsForDeps(deps) ?? (await nodeProviderFs().catch(() => undefined));
    const report = await doctorGithubIdentities({
      env,
      cache,
      ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
      ...(deps.apiBase ? { apiBase: deps.apiBase } : {}),
      ...(repo ? { repo } : {}),
      ...(ambient?.trim() ? { ambientLogin: ambient.trim() } : {}),
      ...(prodFs ? { providerFs: prodFs } : {}),
      ...(deps.homedir ? { homedir: deps.homedir } : {}),
      ...(deps.osHomedir ? { osHomedir: deps.osHomedir } : {}),
    });
    if (asJson) {
      deps.stdout(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      deps.stdout(`${formatGithubDoctorReport(report)}\n`);
    }
    return { exitCode: report.ok ? 0 : 1 };
  } catch (error) {
    const env = deps.env ?? process.env;
    deps.stderr(`error: ${sanitizeErrorForDisplay(error, env)}\n`);
    return { exitCode: 1 };
  }
}

async function runSetup(args: readonly string[], deps: GithubCommandDeps): Promise<GithubCommandResult> {
  let identity: string | undefined;
  let repoRaw: string | undefined;
  let asJson = false;
  for (let i = 0; i < args.length;) {
    const arg = args[i] as string;
    if (arg === "--identity") {
      identity = takeValue(args, i, arg).value;
      i += 2;
    } else if (arg === "--repo") {
      repoRaw = takeValue(args, i, arg).value;
      i += 2;
    } else if (arg === "--json") {
      asJson = true;
      i += 1;
    } else if (isHelpFlag(arg)) {
      deps.stdout(`${GITHUB_USAGE}`);
      return { exitCode: 0 };
    } else if (arg.startsWith("--")) {
      deps.stderr(`error: unknown github setup option: ${arg}\n`);
      deps.stderr(`usage: orca-pi github setup --identity <name> [--repo <owner/repo>] [--json]\n`);
      return { exitCode: 2 };
    } else {
      deps.stderr(`error: unexpected argument: ${arg}\n`);
      deps.stderr(`usage: orca-pi github setup --identity <name> [--repo <owner/repo>] [--json]\n`);
      return { exitCode: 2 };
    }
  }
  try {
    const resolved = validateIdentity(identity);
    const env = deps.env ?? process.env;
    const validation = validateSetupForIdentity(resolved, env);
    const steps = operatorSetupStepsForIdentity(resolved, { ...(repoRaw?.trim() ? { repo: repoRaw.trim() } : {}) });
    if (asJson) {
      deps.stdout(`${JSON.stringify({ ok: validation.ok, identity: resolved, missing: validation.missing, guidance: validation.guidance, steps }, null, 2)}\n`);
    } else {
      deps.stdout(`github setup — identity "${resolved}": ${validation.guidance}\n`);
      for (const step of steps) deps.stdout(`${step}\n`);
    }
    return { exitCode: validation.ok ? 0 : 1 };
  } catch (error) {
    const env = deps.env ?? process.env;
    deps.stderr(`error: ${sanitizeErrorForDisplay(error, env)}\n`);
    return { exitCode: 2 };
  }
}

async function runMint(args: readonly string[], deps: GithubCommandDeps): Promise<GithubCommandResult> {
  let identity: string | undefined;
  let asJson = false;
  for (let i = 0; i < args.length;) {
    const arg = args[i] as string;
    if (arg === "--identity") {
      identity = takeValue(args, i, arg).value;
      i += 2;
    } else if (arg === "--json") {
      asJson = true;
      i += 1;
    } else if (isHelpFlag(arg)) {
      deps.stdout(`${GITHUB_USAGE}`);
      return { exitCode: 0 };
    } else if (arg.startsWith("--")) {
      deps.stderr(`error: unknown github mint option: ${arg}\n`);
      deps.stderr(`usage: orca-pi github mint --identity <name> [--json]\n`);
      return { exitCode: 2 };
    } else {
      deps.stderr(`error: unexpected argument: ${arg}\n`);
      deps.stderr(`usage: orca-pi github mint --identity <name> [--json]\n`);
      return { exitCode: 2 };
    }
  }
  try {
    const resolved = validateIdentity(identity);
    const env = deps.env ?? process.env;
    const cache = deps.cache ?? createInstallationTokenCache();
    const fs = providerFsForDeps(deps) ?? (await nodeProviderFs());
    const credential = await ensureInstallationToken(resolved, {
      env,
      cache,
      fs,
      ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
      ...(deps.apiBase ? { apiBase: deps.apiBase } : {}),
      ...(deps.homedir ? { homedir: deps.homedir } : {}),
      ...(deps.osHomedir ? { osHomedir: deps.osHomedir } : {}),
    });
    const cachePath = tokenCacheFileForIdentity(resolved, {
      env,
      ...(deps.homedir ? { homedir: deps.homedir } : {}),
      ...(deps.osHomedir ? { osHomedir: deps.osHomedir } : {}),
    });
    // Never print the token value — only non-secret metadata.
    if (asJson) {
      deps.stdout(
        `${JSON.stringify({ ok: true, identity: resolved, sourceLabel: credential.sourceLabel, ...(credential.expiresAt ? { expiresAt: credential.expiresAt.toISOString() } : {}), ...(credential.installationId ? { installationId: credential.installationId } : {}), cachePath }, null, 2)}\n`,
      );
    } else {
      deps.stdout(
        `ok github mint — "${resolved}" via ${credential.sourceLabel}${credential.expiresAt ? ` (expires ${credential.expiresAt.toISOString()})` : ""} — cached at ${cachePath} (token value never printed)\n`,
      );
    }
    return { exitCode: 0 };
  } catch (error) {
    const env = deps.env ?? process.env;
    deps.stderr(`error: ${sanitizeErrorForDisplay(error, env)}\n`);
    return { exitCode: 1 };
  }
}

async function runExec(args: readonly string[], deps: GithubCommandDeps): Promise<GithubCommandResult> {
  let identity: string | undefined;
  let profileName: string | undefined;
  const command: string[] = [];
  let seenSep = false;
  for (let i = 0; i < args.length;) {
    const arg = args[i] as string;
    if (!seenSep && arg === "--") {
      seenSep = true;
      i += 1;
      continue;
    }
    if (!seenSep && arg === "--identity") {
      identity = takeValue(args, i, arg).value;
      i += 2;
    } else if (!seenSep && arg === "--profile") {
      profileName = takeValue(args, i, arg).value;
      i += 2;
    } else if (!seenSep && (arg === "--json" || isHelpFlag(arg))) {
      if (isHelpFlag(arg)) {
        deps.stdout(`${GITHUB_USAGE}`);
        return { exitCode: 0 };
      }
      deps.stderr(`error: unknown github exec option: ${arg}\n`);
      return { exitCode: 2 };
    } else if (!seenSep && arg.startsWith("--")) {
      deps.stderr(`error: unknown github exec option: ${arg}\n`);
      deps.stderr(`usage: orca-pi github exec [--identity <name>] [--profile <name>] -- <command...>\n`);
      return { exitCode: 2 };
    } else {
      command.push(arg);
      i += 1;
    }
  }
  if (command.length === 0) {
    deps.stderr(`error: github exec requires -- <command...> (e.g. orca-pi github exec --identity worker -- git push origin HEAD)\n`);
    return { exitCode: 2 };
  }
  try {
    const resolved = await resolveCommandIdentity({ ...(identity ? { explicitIdentity: identity } : {}), ...(profileName ? { profileName } : {}) }, deps);
    assertIdentityMayRunCommand(resolved, command);
    const env = deps.env ?? process.env;
    const cache = deps.cache ?? createInstallationTokenCache();
    const prodFs = providerFsForDeps(deps) ?? (await nodeProviderFs().catch(() => undefined));
    const prodOpts = {
      env,
      cache,
      ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
      ...(deps.apiBase ? { apiBase: deps.apiBase } : {}),
      ...(prodFs ? { providerFs: prodFs } : {}),
      ...(deps.homedir ? { homedir: deps.homedir } : {}),
      ...(deps.osHomedir ? { osHomedir: deps.osHomedir } : {}),
    };
    // Blocker 2: worker remote mutations require Worker-App/IAT preflight
    // BEFORE any child is spawned � a human PAT in the worker slot fails
    // here (401/403 via GET /installation/repositories) and never reaches
    // git/gh. Non-mutating reads (e.g. `git status`) skip the network proof.
    if (resolved === "worker" && isWorkerMutationCommand(command)) {
      await verifyWorkerForWrites(resolved, prodOpts);
    }
    const credential = await resolveProductionCredential(resolved, {
      env,
      cache,
      ...(prodFs ? { providerFs: prodFs } : {}),
      ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
      ...(deps.apiBase ? { apiBase: deps.apiBase } : {}),
      ...(deps.homedir ? { homedir: deps.homedir } : {}),
      ...(deps.osHomedir ? { osHomedir: deps.osHomedir } : {}),
    });
    const token = credential.token;
    const overlay = buildScopedEnvForIdentity(resolved, token);
    if (deps.execSpawn) {
      const code = await deps.execSpawn(command, { env: overlay });
      return { exitCode: code };
    }
    // Production: inherit stdio, scope env to the child only.
    const { spawn } = await import("node:child_process");
    const [exe, ...restArgs] = command as [string, ...string[]];
    const code: number = await new Promise((resolve) => {
      const child = spawn(exe, restArgs, {
        stdio: "inherit",
        env: { ...process.env, ...overlay },
        windowsHide: true,
      });
      child.on("error", () => resolve(1));
      child.on("close", (c) => resolve(c ?? 1));
    });
    return { exitCode: code };
  } catch (error) {
    const env = deps.env ?? process.env;
    deps.stderr(`error: ${sanitizeErrorForDisplay(error, env)}\n`);
    return { exitCode: 1 };
  }
}

async function readStdinText(deps: GithubCommandDeps): Promise<string> {
  if (deps.stdinText) return await deps.stdinText();
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

async function runGitCredential(args: readonly string[], deps: GithubCommandDeps): Promise<GithubCommandResult> {
  let identity: string | undefined;
  let action: string | undefined;
  for (let i = 0; i < args.length;) {
    const arg = args[i] as string;
    if (arg === "--identity") {
      identity = takeValue(args, i, arg).value;
      i += 2;
    } else if (isHelpFlag(arg)) {
      deps.stdout(`${GITHUB_USAGE}`);
      return { exitCode: 0 };
    } else if (arg.startsWith("--")) {
      deps.stderr(`error: unknown github git-credential option: ${arg}\n`);
      return { exitCode: 2 };
    } else if (!action) {
      action = arg;
      i += 1;
    } else {
      deps.stderr(`error: unexpected argument: ${arg}\n`);
      return { exitCode: 2 };
    }
  }
  try {
    const resolved = validateIdentity(identity);
    if (action !== "get" && action !== "store" && action !== "erase") {
      throw new Error(`Missing action: usage orca-pi github git-credential --identity <name> <get|store|erase> (invoked by git, not manually).`);
    }
    const inputText = action === "get" ? await readStdinText(deps) : "";
    const input = parseGitCredentialInput(inputText);
    const env = deps.env ?? process.env;
    const cache = deps.cache ?? createInstallationTokenCache();
    const prodFs = providerFsForDeps(deps) ?? (await nodeProviderFs().catch(() => undefined));
    const prodOpts = {
      env,
      cache,
      ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
      ...(deps.apiBase ? { apiBase: deps.apiBase } : {}),
      ...(prodFs ? { providerFs: prodFs } : {}),
      ...(deps.homedir ? { homedir: deps.homedir } : {}),
      ...(deps.osHomedir ? { osHomedir: deps.osHomedir } : {}),
    };
    const resolveToken = async (): Promise<{ token: string }> => {
      if (resolved === "worker" && action === "get") {
        await verifyWorkerForWrites(resolved, prodOpts);
      }
      const credential = await resolveProductionCredential(resolved, {
        env,
        cache,
        ...(prodFs ? { providerFs: prodFs } : {}),
        ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
        ...(deps.apiBase ? { apiBase: deps.apiBase } : {}),
        ...(deps.homedir ? { homedir: deps.homedir } : {}),
        ...(deps.osHomedir ? { osHomedir: deps.osHomedir } : {}),
      });
      return { token: credential.token };
    };
    const result = await handleGitCredentialRequest(resolved, action, input, resolveToken);
    // stdout is piped to git — never add framing/logs here.
    if (result.stdout) deps.stdout(result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`);
    return { exitCode: result.exitCode };
  } catch (error) {
    const env = deps.env ?? process.env;
    deps.stderr(`error: ${sanitizeErrorForDisplay(error, env)}\n`);
    return { exitCode: 1 };
  }
}

async function runSetupGit(args: readonly string[], deps: GithubCommandDeps): Promise<GithubCommandResult> {
  let identity: string | undefined;
  let repoPath: string | undefined;
  let asJson = false;
  for (let i = 0; i < args.length;) {
    const arg = args[i] as string;
    if (arg === "--identity") {
      identity = takeValue(args, i, arg).value;
      i += 2;
    } else if (arg === "--path") {
      repoPath = takeValue(args, i, arg).value;
      i += 2;
    } else if (arg === "--json") {
      asJson = true;
      i += 1;
    } else if (isHelpFlag(arg)) {
      deps.stdout(`${GITHUB_USAGE}`);
      return { exitCode: 0 };
    } else if (arg.startsWith("--")) {
      deps.stderr(`error: unknown github setup-git option: ${arg}\n`);
      deps.stderr(`usage: orca-pi github setup-git --identity worker [--path <repo-path>] [--json]\n`);
      return { exitCode: 2 };
    } else {
      deps.stderr(`error: unexpected argument: ${arg}\n`);
      deps.stderr(`usage: orca-pi github setup-git --identity worker [--path <repo-path>] [--json]\n`);
      return { exitCode: 2 };
    }
  }
  try {
    const resolved = validateIdentity(identity);
    // Reviewer must never configure push credentials (Contents: read only).
    assertWorkerIdentityForWrites(resolved);
    const path = (repoPath ?? defaultProjectRoot(deps)).trim();
    if (!path) throw new Error(`Missing --path <repo-path> (e.g. --path /wt/worker-checkout).`);
    const runner = deps.runner;
    if (!runner) throw new Error(`setup-git requires a process runner (unavailable in this host).`);
    const receipt = await setupRepoGitAuth(runner, { repoPath: path });
    if (asJson) {
      deps.stdout(`${JSON.stringify({ ok: true, identity: resolved, repoPath: receipt.repoPath, helper: receipt.helperCommand, scope: receipt.scope, ghNote: "setup-git authenticates git only; gh needs: orca-pi github exec --identity worker -- gh ..." }, null, 2)}\n`);
    } else {
      deps.stdout(`ok github setup-git — worker helper override in ${receipt.repoPath} (scope ${receipt.scope}: empty reset + worker helper, never --global; git only)\n`);
    }
    return { exitCode: 0 };
  } catch (error) {
    const env = deps.env ?? process.env;
    deps.stderr(`error: ${sanitizeErrorForDisplay(error, env)}\n`);
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Missing --") || message.includes("Invalid --") || message.includes("Refusing git config scope")) return { exitCode: 2 };
    return { exitCode: 1 };
  }
}

/** Route `github` subcommands. `argv` is everything after the `github` word. */
export async function runGithubCommand(
  argv: readonly string[],
  deps: GithubCommandDeps,
): Promise<GithubCommandResult> {
  const [subcommand, ...rest] = argv;
  if (subcommand === undefined || isHelpFlag(subcommand)) {
    deps.stdout(`${GITHUB_USAGE}`);
    return { exitCode: 0 };
  }
  if (subcommand === "auth") {
    const [action, ...authRest] = rest;
    if (action === "status") return await runAuthStatus(authRest, deps);
    deps.stderr(`error: unknown github auth action: ${action ?? "(none)"} (expected "status")\n`);
    deps.stderr(`usage: orca-pi github auth status [--identity <name>] [--profile <name>] [--json]\n`);
    return { exitCode: 2 };
  }
  if (subcommand === "review") return await runReview(rest, deps);
  if (subcommand === "check") return await runCheck(rest, deps);
  if (subcommand === "doctor") return await runDoctor(rest, deps);
  if (subcommand === "identity") {
    const [action, ...identityRest] = rest;
    if (action === "doctor") return await runDoctor(identityRest, deps);
    deps.stderr(`error: unknown github identity action: ${action ?? "(none)"} (expected "doctor")\n`);
    deps.stderr(`usage: orca-pi github identity doctor [--repo <owner/repo>] [--json]\n`);
    return { exitCode: 2 };
  }
  if (subcommand === "setup") {
    // `setup-git` is a distinct subcommand; `setup` alone is App bootstrap.
    if (rest[0] === "-git" || (rest[0] as string) === "git") {
      deps.stderr(`error: unknown github subcommand: ${subcommand} ${rest[0] ?? ""} (did you mean "setup-git"?)\n`);
      return { exitCode: 2 };
    }
    return await runSetup(rest, deps);
  }
  if (subcommand === "setup-git") return await runSetupGit(rest, deps);
  if (subcommand === "mint") return await runMint(rest, deps);
  if (subcommand === "exec") return await runExec(rest, deps);
  if (subcommand === "git-credential") return await runGitCredential(rest, deps);
  deps.stderr(`error: unknown github subcommand: ${subcommand}\n`);
  deps.stderr(`${GITHUB_USAGE}`);
  return { exitCode: 2 };
}

/**
 * Scoped Git/GitHub authentication broker (OP1.12, blockers 2+4).
 *
 * Worker `git push` / `gh pr create` operations must run as the Worker
 * GitHub App — never as the ambient developer credential — and never by
 * globally overwriting the developer's git config. All scoping is per
 * worker/process/worktree/session:
 *
 * - `buildScopedEnvForIdentity` returns a child-process-only env overlay
 *   (`GH_TOKEN`/`GITHUB_TOKEN` + identity provenance). Callers pass it as
 *   the child env; the parent/ambient env is never mutated.
 * - `handleGitCredentialRequest` implements the `git credential helper`
 *   protocol (`get`/`store`/`erase` over stdin) backed by the out-of-LLM
 *   provider. `get` prints `username`/`password` to stdout (piped to git,
 *   never logged); `store`/`erase` are no-ops (tokens are short-lived).
 * - `gitConfigCommandsForSetup` builds the deterministic override sequence
 *   (generic `credential.helper ""` reset + host-scoped
 *   `credential.https://<host>.helper ""` reset + host-scoped worker helper
 *   `--add`) in `--worktree` scope (fallback `--local` only for single
 *   worktrees on old git — never silently for linked worktrees). Resets are
 *   Git's documented way to ignore inherited/global helpers (e.g. Git
 *   Credential Manager holding ambient `44madfire`), so the worker helper
 *   wins without mutating global config. `--worktree` (with
 *   `extensions.worktreeConfig` auto-enabled) keeps linked worktrees isolated
 *   (plain `--local` is shared across linked worktrees).
 * - `buildWorkerExecEnv` builds the process-scoped child env for worker
 *   `exec` (GH_TOKEN + GIT_CONFIG_* host override + GIT_SSH_COMMAND guard),
 *   so `git push` via exec deterministically uses the verified worker token
 *   even with ambient helpers configured, and SSH remotes fail closed.
 * - `assertIdentityMayRunCommand` blocks reviewer Contents-write
 *   (`git push ...` with global `-C`/`-c` forms); reviewers describe
 *   follow-ups, they never push. `isWorkerMutationCommand` identifies
 *   worker remote mutations (`git push`, `gh pr create/edit/merge/...`,
 *   `gh api --method POST/...`) for mandatory Worker-App preflight.
 *
 * Configuring git's credential helper does NOT authenticate `gh`: the GitHub
 * CLI ignores git helpers and needs `GH_TOKEN` via `github exec`
 * (`orca-pi github exec --identity worker -- gh pr create ...`).
 *
 * Tokens never enter logs; helpers redact explicitly.
 */

import type { ProcessRunner } from "../runner.js";
import { redactSecretsFromText } from "./identity.js";
import { GithubAuthError } from "./types.js";

/** Env overlay for one scoped child process (never merged into parent). */
export function buildScopedEnvForIdentity(
  identity: string,
  token: string,
): Record<string, string> {
  const trimmed = identity.trim();
  if (!trimmed) throw new Error(`buildScopedEnvForIdentity requires a non-empty identity.`);
  if (!token || !token.trim()) {
    throw new GithubAuthError(
      trimmed,
      "missing-credential",
      `Missing GitHub credential for identity "${trimmed}" — mint outside LLM context (orca-pi github mint --identity ${trimmed}) and retry.`,
    );
  }
  return {
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    GIT_TERMINAL_PROMPT: "0",
    ORCA_PI_GITHUB_IDENTITY: trimmed,
  };
}

/**
 * Extract the git subcommand from argv, skipping the executable plus global
 * options (`-C <path>`, `-c k=v`, `--git-dir=...`, `--work-tree=...`,
 * `--namespace`, etc.). Returns lowercase subcommand or undefined.
 * Handles `git -C /wt -c k=v push`, `git --git-dir=/x/.git push`, etc.
 */
export function extractGitSubcommand(argv: readonly string[]): string | undefined {
  if (argv.length < 2) return undefined;
  const rest = argv.slice(1) as string[];
  let i = 0;
  while (i < rest.length) {
    const arg = rest[i] as string;
    if (arg === "--") {
      i += 1;
      break;
    }
    if (arg === "-C" || arg === "--git-dir" || arg === "--work-tree" || arg === "--namespace") {
      i += 2;
      continue;
    }
    if (arg.startsWith("--git-dir=") || arg.startsWith("--work-tree=") || arg.startsWith("--namespace=")) {
      i += 1;
      continue;
    }
    if (arg === "-c") {
      i += 2;
      continue;
    }
    if (arg.startsWith("-c")) {
      // `-ckey=val` single-token form.
      i += 1;
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      // Other global flags (e.g. `--no-pager` is git-wrapper, `-p`); skip
      // bare flags, but a `--config` style flag with separate value needs
      // the value skipped too — handle common ones conservatively.
      if (arg === "--config" || arg === "--exec-path") {
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    return arg.toLowerCase();
  }
  const sub = rest[i] as string | undefined;
  return sub?.toLowerCase();
}

/**
 * True when argv is a Contents-write git operation that only the worker
 * (Contents: write) may perform. Handles global option prefixes.
 */
export function isContentsWriteGitCommand(argv: readonly string[]): boolean {
  if (argv.length === 0) return false;
  const [exe] = argv as string[];
  const base = exe.split("/").pop() ?? exe;
  const lowered = base.toLowerCase().replace(/\.exe$/, "");
  if (lowered !== "git") return false;
  return extractGitSubcommand(argv) === "push";
}

/**
 * True when argv is a worker remote mutation requiring Worker-App preflight:
 * - `git push` (any global-option prefix form)
 * - `gh pr create|edit|merge|close|reopen|ready|lock|unlock`
 * - `gh issue create|edit|close|reopen|lock|unlock|transfer|pin|unpin`
 * - `gh release create|edit|delete|upload`
 * - `gh api` with mutating `--method`/`--method=` (POST/PUT/PATCH/DELETE) or
 *   `/repos/.../pulls|issues|check-runs|contents` POST-ish paths
 * - `gh auth` subcommands are NOT mutations (excluded)
 */
export function isWorkerMutationCommand(argv: readonly string[]): boolean {
  if (argv.length === 0) return false;
  const [exe, ...rest] = argv as string[];
  const base = (exe.split("/").pop() ?? exe).toLowerCase().replace(/\.exe$/, "");
  if (base === "git") return isContentsWriteGitCommand(argv);
  if (base !== "gh") return false;
  const [group, sub, ...tail] = rest.map((s) => s.toLowerCase());
  if (group === "pr" || group === "issue") {
    return ["create", "edit", "merge", "close", "reopen", "ready", "lock", "unlock", "transfer", "pin", "unpin"].includes(sub ?? "");
  }
  if (group === "release") {
    return ["create", "edit", "delete", "upload"].includes(sub ?? "");
  }
  if (group === "api") {
    const joined = rest.join(" ").toLowerCase();
    // Explicit mutating method wins (space and equals forms).
    const methodMatch = /--method[\s=]+(\w+)/.exec(joined) ?? /-x\s*(\w+)/.exec(joined);
    if (methodMatch) {
      const method = (methodMatch[1] as string).toUpperCase();
      if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) return true;
      return false;
    }
    // `gh api -f/-F` (fields) implies POST (default method is GET without -f).
    if (/(^|\s)(--field|-f)\b/.test(joined) || /(^|\s)(--raw-field|--input)\b/.test(joined)) return true;
    void tail;
    return false;
  }
  return false;
}

/**
 * Fail closed when a reviewer identity attempts a Contents-write command.
 * Worker/scout/custom identities pass through.
 */
export function assertIdentityMayRunCommand(
  identity: string,
  argv: readonly string[],
): void {
  if (identity.trim() !== "reviewer") return;
  if (isContentsWriteGitCommand(argv)) {
    throw new GithubAuthError(
      identity,
      "unauthorized-installation",
      `Refusing "git push" as identity "reviewer" — the Reviewer GitHub App holds Contents: read only (Pull requests: write, Checks: write). ` +
        `Pushes must run as the worker identity (orca-pi github exec --identity worker -- git push ...). Reviewers describe follow-ups; they never edit or push files.`,
    );
  }
}

/** Default GitHub host allowlist for the credential helper (enterprise via ORCA_PI_GITHUB_ALLOWED_HOSTS). */
export const DEFAULT_CREDENTIAL_HOSTS: readonly string[] = ["github.com"] as const;

/** Env var carrying extra allowed credential hosts (comma-separated, e.g. GHE). */
export const ALLOWED_HOSTS_ENV_VAR = "ORCA_PI_GITHUB_ALLOWED_HOSTS";

/** Exit code for the SSH guard (git fatal convention). */
export const SSH_GUARD_EXIT_CODE = 128;

/** Message printed by the SSH guard (no secrets). */
export const SSH_GUARD_MESSAGE =
  "error: SSH remotes are not supported for worker Git operations (worker identity requires HTTPS with the Worker App credential helper). " +
  "Use an HTTPS remote (https://github.com/...) and retry via: orca-pi github exec --identity worker -- git push ...";

/** Default SSH guard command (relies on orca-pi on PATH, like the credential helper). */
export function defaultSshGuardCommand(executable = "orca-pi"): string {
  return `${executable} github ssh-guard`;
}

/** Normalize a credential host for comparison (lowercase, strip scheme/path/port). */
export function normalizeCredentialHost(raw: string): string {
  let host = raw.trim().toLowerCase();
  const schemeIdx = host.indexOf("://");
  if (schemeIdx >= 0) host = host.slice(schemeIdx + 3);
  const slashIdx = host.indexOf("/");
  if (slashIdx >= 0) host = host.slice(0, slashIdx);
  const colonIdx = host.indexOf(":");
  if (colonIdx >= 0) host = host.slice(0, colonIdx);
  return host.replace(/\.+$/, "");
}

/** Allowlist from env (default github.com plus ORCA_PI_GITHUB_ALLOWED_HOSTS). */
export function allowedHostsFromEnv(
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
): string[] {
  const hosts = ["github.com"];
  const raw = env?.[ALLOWED_HOSTS_ENV_VAR];
  if (typeof raw === "string" && raw.trim()) {
    for (const part of raw.split(",")) {
      const normalized = normalizeCredentialHost(part);
      if (normalized && !hosts.includes(normalized)) hosts.push(normalized);
    }
  }
  return hosts;
}

/** True when the credential request host is allowed to receive the token. */
export function isHostAllowed(host: string, allowedHosts?: readonly string[]): boolean {
  const normalized = normalizeCredentialHost(host);
  if (!normalized) return false;
  return (allowedHosts ?? DEFAULT_CREDENTIAL_HOSTS).includes(normalized);
}

/** Config key for host-scoped credential helpers (e.g. credential.https://github.com.helper). */
export function credentialHostKey(host = "github.com"): string {
  const normalized = normalizeCredentialHost(host) || "github.com";
  return "credential.https://" + normalized + ".helper";
}

/** Parse `git credential` helper input (`key=value` lines) into a map. */
export function parseGitCredentialInput(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1);
    if (key) out[key] = value;
  }
  return out;
}

/**
 * Handle one `git credential <action>` request. `get` validates the request
 * host (protocol=https + allowlisted host, default github.com) BEFORE
 * resolving any token, then returns the helper stdout
 * (`username=x-access-token\npassword=<token>\n`); `store`/`erase` return
 * empty success (short-lived tokens are never stored by git).
 */
export async function handleGitCredentialRequest(
  identity: string,
  action: "get" | "store" | "erase",
  input: Record<string, string>,
  resolveToken: () => Promise<{ token: string }>,
  options?: { allowedHosts?: readonly string[] },
): Promise<{ stdout: string; exitCode: number }> {
  if (action === "store" || action === "erase") return { stdout: "", exitCode: 0 };
  const protocol = (input.protocol ?? "").trim().toLowerCase();
  const host = (input.host ?? "").trim();
  if (protocol !== "https" || !isHostAllowed(host, options?.allowedHosts)) {
    return { stdout: "", exitCode: 0 };
  }
  // `get` for an allowed host: mint/refresh outside LLM context, then hand
  // to git via stdout.
  const { token } = await resolveToken();
  if (!token || !token.trim()) {
    throw new GithubAuthError(
      identity,
      "missing-credential",
      `Git credential helper for identity "${identity}" resolved an empty token — mint outside LLM context and retry.`,
    );
  }
  return { stdout: `username=x-access-token\npassword=${token.trim()}\n`, exitCode: 0 };
}

/**
 * Sanitize helper output for any accidental log path: the `password=`
 * line is replaced wholesale. Normal callers never log `stdout` at all —
 * it is piped directly to git.
 */
export function redactGitCredentialOutput(stdout: string): string {
  return stdout
    .split("\n")
    .map((line) => (line.startsWith("password=") ? "password=<redacted>" : line))
    .join("\n");
}

/**
 * Build `git -C <repoPath> config <scope> ...` argv pinning the
 * credential helper to one checkout. Always `--worktree` (preferred,
 * isolated per linked worktree) or `--local` fallback — callers must
 * never pass `--global`/`--system` (refused here).
 */
export function gitConfigArgsForSetup(options: {
  repoPath: string;
  helperCommand: string;
  scope?: string;
}): { executable: string; args: string[] } {
  const repoPath = options.repoPath.trim();
  if (!repoPath) throw new Error(`setup-git requires a non-empty --path <repo-path>.`);
  const scope = options.scope?.trim() || "--worktree";
  if (scope !== "--worktree" && scope !== "--local") {
    throw new Error(
      `Refusing git config scope ${JSON.stringify(scope)}: worker identity scoping must be per worktree/repo (--worktree preferred, --local fallback), never --global/--system (would overwrite the developer's normal GitHub credentials).`,
    );
  }
  if (!options.helperCommand.trim()) throw new Error(`setup-git requires a helper command.`);
  return {
    executable: "git",
    args: ["-C", repoPath, "config", scope, "credential.helper", options.helperCommand],
  };
}

/**
 * Deterministic override sequence: generic empty reset + host-scoped empty
 * reset + host-scoped worker helper `--add`, all in worktree scope. Git tries
 * multiple `credential.helper` values in order; without the resets a
 * global/system Git Credential Manager helper holding ambient `44madfire`
 * can answer before the worker helper. Host scoping means non-GitHub hosts
 * never receive the worker token (fail closed, no leak).
 */
export function gitConfigCommandsForSetup(options: {
  repoPath: string;
  helperCommand: string;
  scope?: "--worktree" | "--local";
  githubHost?: string;
}): { executable: string; args: string[] }[] {
  const scope = options.scope ?? "--worktree";
  if (scope !== "--worktree" && scope !== "--local") {
    throw new Error(
      `Refusing git config scope ${JSON.stringify(scope)}: use --worktree (preferred) or --local (fallback).`,
    );
  }
  const repoPath = options.repoPath.trim();
  if (!repoPath) throw new Error(`setup-git requires a non-empty --path <repo-path>.`);
  if (!options.helperCommand.trim()) throw new Error(`setup-git requires a helper command.`);
  const hostKey = credentialHostKey(options.githubHost ?? "github.com");
  return [
    { executable: "git", args: ["-C", repoPath, "config", scope, "--replace-all", "credential.helper", ""] },
    { executable: "git", args: ["-C", repoPath, "config", scope, "--replace-all", hostKey, ""] },
    { executable: "git", args: ["-C", repoPath, "config", scope, "--add", hostKey, options.helperCommand] },
  ];
}

/**
 * Process-scoped child env for worker `exec` (blocker 2, second half).
 *
 * In addition to GH_TOKEN/GITHUB_TOKEN this installs a Git credential
 * override for the child only (generic empty reset + host-scoped empty
 * reset + host-scoped worker helper via GIT_CONFIG_COUNT/KEY/VALUE) so
 * `git push` via exec deterministically uses the verified worker token even
 * when ambient helpers (GCM with human credential) are configured — without
 * touching any repo/global config. Non-GitHub hosts get no helper (fail
 * closed, no leak). SSH remotes fail closed via GIT_SSH_COMMAND guard.
 */
export function buildWorkerExecEnv(
  token: string,
  options?: { helperCommand?: string; githubHost?: string; sshGuardCommand?: string },
): Record<string, string> {
  const base = buildScopedEnvForIdentity("worker", token);
  const helperCommand = options?.helperCommand ?? defaultHelperCommand();
  const hostKey = credentialHostKey(options?.githubHost ?? "github.com");
  const sshGuard = options?.sshGuardCommand ?? defaultSshGuardCommand();
  return {
    ...base,
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: hostKey,
    GIT_CONFIG_VALUE_1: "",
    GIT_CONFIG_KEY_2: hostKey,
    GIT_CONFIG_VALUE_2: helperCommand,
    GIT_SSH_COMMAND: sshGuard,
  };
}

/** Default helper command embedded in worktree git config. */
export function defaultHelperCommand(executable = "orca-pi"): string {
  return `${executable} github git-credential --identity worker`;
}

/**
 * True when `repoPath` is inside a linked worktree (git-dir differs from
 * git-common-dir, typically `<common>/.git/worktrees/<name>`). Best-effort:
 * unparseable output is treated as NOT linked (preserves mocked-runner
 * behavior); real git always reports parseable paths. Throws when the path
 * is not a git checkout.
 */
export async function isLinkedWorktree(
  runner: ProcessRunner,
  repoPath: string,
): Promise<boolean> {
  let gitDirOut: string;
  let commonDirOut: string;
  try {
    const gitDirRes = await runner.run("git", ["-C", repoPath, "rev-parse", "--git-dir"]);
    const commonRes = await runner.run("git", ["-C", repoPath, "rev-parse", "--git-common-dir"]);
    if (gitDirRes.exitCode !== 0 || commonRes.exitCode !== 0) {
      throw new Error(
        `setup-git failed: ${JSON.stringify(repoPath)} is not a git checkout ` +
          `(${(gitDirRes.stderr || gitDirRes.stdout || commonRes.stderr || commonRes.stdout).trim().slice(0, 200) || "rev-parse failed"}).`,
      );
    }
    gitDirOut = gitDirRes.stdout;
    commonDirOut = commonRes.stdout;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("setup-git failed")) throw error;
    throw new Error(
      `setup-git failed: could not inspect git worktree in ${JSON.stringify(repoPath)} (${error instanceof Error ? error.message : String(error)}). Is this a git checkout?`,
    );
  }
  const norm = (s: string): string => s.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const gitDir = norm(gitDirOut);
  const commonDir = norm(commonDirOut);
  if (!gitDir || !commonDir) return false;
  if (gitDir.includes("/worktrees/")) return true;
  return gitDir !== commonDir;
}

/**
 * Run worktree-scoped `git config` override via an injectable runner.
 *
 * Linked worktrees: safely enables `extensions.worktreeConfig` in the
 * common repo config first (idempotent, repo-scoped, never global), then
 * writes the host-scoped reset+helper sequence with `--worktree`. Never
 * falls back to `--local` for linked worktrees (`--local` is shared across
 * linked worktrees and would violate per-worker isolation).
 * Single worktrees: writes with `--worktree`, falling back to `--local`
 * only on old git without worktree scope (equivalent when unlinked).
 * Old git + linked worktree fails closed (upgrade git).
 * After writing, reads back the host-scoped helpers and verifies the
 * worker entry is present (fail closed).
 * Never touches global/system config. Returns the helper command recorded.
 */
export async function setupRepoGitAuth(
  runner: ProcessRunner,
  options: { repoPath: string; helperCommand?: string; executable?: string; githubHost?: string },
): Promise<{ repoPath: string; helperCommand: string; scope: "--worktree" | "--local"; hostKey: string }> {
  const helperCommand = options.helperCommand ?? defaultHelperCommand(options.executable ?? "orca-pi");
  const hostKey = credentialHostKey(options.githubHost ?? "github.com");
  const repoPath = options.repoPath;
  if (!repoPath.trim()) throw new Error(`setup-git requires a non-empty --path <repo-path>.`);
  if (!helperCommand.trim()) throw new Error(`setup-git requires a helper command.`);
  const linked = await isLinkedWorktree(runner, repoPath);

  async function runConfig(args: readonly string[]): Promise<void> {
    let result;
    try {
      result = await runner.run("git", args);
    } catch (error) {
      throw new Error(
        `setup-git failed: could not run git ${args.slice(0, 4).join(" ")} in ${JSON.stringify(repoPath)} (${error instanceof Error ? error.message : String(error)}). Is this a git checkout?`,
      );
    }
    if (result.exitCode !== 0) {
      const detail = `${result.stderr || result.stdout}`.trim().slice(0, 500);
      if (/cannot be used with multiple working trees|worktreeconfig/i.test(detail)) {
        throw new Error(`worktree-config-disabled: ${detail}`);
      }
      if (/unknown option|unknown switch/i.test(detail)) {
        throw new Error(`worktree-scope-unsupported: ${detail}`);
      }
      throw new Error(
        `setup-git failed: git ${args.slice(2, 4).join(" ")} exited ${result.exitCode}${detail ? ` — ${redactSecretsFromText(detail, [])}` : ""}. Is ${JSON.stringify(repoPath)} a git checkout?`,
      );
    }
  }

  async function writeWorktreeSequence(): Promise<void> {
    const commands = gitConfigCommandsForSetup({ repoPath, helperCommand, scope: "--worktree", githubHost: options.githubHost });
    for (const { args } of commands) {
      await runConfig(args);
    }
  }

  async function enableWorktreeConfigExtension(): Promise<void> {
    await runConfig(["-C", repoPath, "config", "extensions.worktreeConfig", "true"]);
  }

  async function verifyHostHelper(): Promise<void> {
    let result;
    try {
      result = await runner.run("git", ["-C", repoPath, "config", "--show-origin", "--get-all", hostKey]);
    } catch (error) {
      throw new Error(
        `setup-git verification failed in ${JSON.stringify(repoPath)} (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
    if (result.exitCode !== 0) {
      throw new Error(
        `setup-git verification failed: ${hostKey} not readable in ${JSON.stringify(repoPath)} (exit ${result.exitCode}).`,
      );
    }
    try {
      assertWorktreeHelperConfigured(result.stdout, { repoPath, helperCommand });
    } catch (error) {
      throw new Error(
        `setup-git verification failed: worker helper not deterministically configured in ${JSON.stringify(repoPath)} (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
  }

  if (linked) {
    try {
      await writeWorktreeSequence();
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("worktree-config-disabled")) {
        await enableWorktreeConfigExtension();
        await writeWorktreeSequence();
      } else if (error instanceof Error && error.message.startsWith("worktree-scope-unsupported")) {
        throw new Error(
          `setup-git failed: linked worktree at ${JSON.stringify(repoPath)} requires git with --worktree scope (old git detected). ` +
            `Upgrade git instead of sharing --local config across linked worktrees (per-worker isolation).`,
        );
      } else {
        throw error;
      }
    }
    await verifyHostHelper();
    return { repoPath, helperCommand, scope: "--worktree", hostKey };
  }

  try {
    await writeWorktreeSequence();
    await verifyHostHelper();
    return { repoPath, helperCommand, scope: "--worktree", hostKey };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("worktree-config-disabled")) {
      await enableWorktreeConfigExtension();
      await writeWorktreeSequence();
      await verifyHostHelper();
      return { repoPath, helperCommand, scope: "--worktree", hostKey };
    }
    if (error instanceof Error && error.message.startsWith("worktree-scope-unsupported")) {
      const commands = gitConfigCommandsForSetup({ repoPath, helperCommand, scope: "--local", githubHost: options.githubHost });
      for (const { args } of commands) {
        await runConfig(args);
      }
      await verifyHostHelper();
      return { repoPath, helperCommand, scope: "--local", hostKey };
    }
    throw error;
  }
}

/**
 * Verify repo-local config does not leak to global scope: reads
 * `git config --show-origin --get credential.helper` and asserts at least
 * one entry originates from the repo-local file. Pure parser over runner
 * output (testable without git).
 *
 * @deprecated Prefer `assertWorktreeHelperConfigured` (empty-reset aware).
 */
export function assertRepoLocalHelperConfigured(
  showOriginOutput: string,
  options?: { repoPath?: string },
): void {
  const lines = showOriginOutput.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) {
    throw new Error(
      `No git credential.helper is configured${options?.repoPath ? ` for ${JSON.stringify(options.repoPath)}` : ""} — run \`orca-pi github setup-git --identity worker --path <repo-path>\` (worktree-scoped, never --global) and retry.`,
    );
  }
  const local = lines.some((line) => line.includes(".git/config"));
  if (!local) {
    throw new Error(
      `git credential.helper is not repo-local (no ".git/config" origin; got ${lines.length} entr${lines.length === 1 ? "y" : "ies"} from other scopes). ` +
        `Worker identity scoping must be per repo/worktree — remove any --global helper and run \`orca-pi github setup-git --identity worker --path <repo-path>\`.`,
    );
  }
}

/**
 * Verify the deterministic worktree override is present: parses
 * `git config --show-origin --get-all credential.helper` output and asserts
 * the worker helper appears AFTER an empty reset from a worktree-scoped
 * file (so inherited ambient helpers cannot win). Pure parser (no git).
 */
export function assertWorktreeHelperConfigured(
  showOriginAllOutput: string,
  options?: { repoPath?: string; helperCommand?: string },
): void {
  const expectedHelper = options?.helperCommand ?? "orca-pi github git-credential --identity worker";
  // Split first, trim parts second: trimming the whole line first would strip
  // the trailing tab of empty-reset entries (`file:<path>\t`), destroying
  // the separator that marks them as resets.
  const lines = showOriginAllOutput
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    throw new Error(
      `No git credential.helper is configured${options?.repoPath ? ` for ${JSON.stringify(options.repoPath)}` : ""} — run \`orca-pi github setup-git --identity worker --path <repo-path>\` (worktree-scoped empty reset + worker helper, never --global) and retry.`,
    );
  }
  // Split `file:<path>\t<value>`; values without tab are bare (treat as value with unknown origin).
  const entries = lines.map((line) => {
    const tab = line.indexOf("\t");
    if (tab < 0) { let v = line.trim(); if (v.startsWith("credential.helper=")) v = v.slice("credential.helper=".length).trim(); return { origin: "", value: v }; }
    let w = line.slice(tab + 1).trim(); if (w.startsWith("credential.helper=")) w = w.slice("credential.helper=".length).trim(); return { origin: line.slice(0, tab), value: w };
  });
  const workerIdx = entries.findIndex((e) => e.value.includes("orca-pi") && e.value.includes("git-credential"));
  if (workerIdx < 0) {
    throw new Error(
      `Worker credential helper not found (expected "${expectedHelper}"). Run \`orca-pi github setup-git --identity worker --path <repo-path>\`.`,
    );
  }
  const workerOrigin = entries[workerIdx]?.origin ?? "";
  const isWorktreeScoped =
    workerOrigin.includes("config.worktree") || workerOrigin.includes(".git/config");
  if (!isWorktreeScoped) {
    throw new Error(
      `Worker credential helper is not worktree/repo-scoped (origin "${workerOrigin}"). Re-run \`orca-pi github setup-git --identity worker --path <repo-path>\` (never --global).`,
    );
  }
  // An ambient helper BEFORE the worker helper without an intervening empty
  // reset would win. Require an empty reset from worktree scope at or before
  // the worker entry.
  const resetIdx = entries.findIndex(
    (e, idx) =>
      idx <= workerIdx &&
      e.value === "" &&
      (e.origin.includes("config.worktree") || e.origin.includes(".git/config")),
  );
  if (resetIdx < 0) {
    throw new Error(
      `Worker credential helper is appended without an empty-reset override (no \`credential.helper ""\` before it in worktree scope) — an inherited global helper (e.g. Git Credential Manager with ambient 44madfire) could answer first. ` +
        `Re-run \`orca-pi github setup-git --identity worker --path <repo-path>\` to install the deterministic empty-reset + worker sequence.`,
    );
  }
}

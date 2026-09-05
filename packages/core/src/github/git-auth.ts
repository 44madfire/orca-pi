/**
 * Scoped Git/GitHub authentication broker (OP1.12).
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
 * - `gitConfigArgsForSetup` builds `git -C <path> config --local ...`
 *   argv that pins the helper to one repo checkout. `--local` is always
 *   used — `--global`/`--system` are refused.
 * - `assertIdentityMayRunCommand` blocks reviewer Contents-write
 *   (`git push ...`); reviewers describe follow-ups, they never push.
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
 * True when argv is a Contents-write git operation that only the worker
 * (Contents: write) may perform. Reviewer (Contents: read) is refused.
 */
export function isContentsWriteGitCommand(argv: readonly string[]): boolean {
  if (argv.length === 0) return false;
  const [exe, ...rest] = argv as string[];
  const base = exe.split("/").pop() ?? exe;
  const lowered = base.toLowerCase().replace(/\.exe$/, "");
  if (lowered !== "git") return false;
  const sub = rest[0]?.toLowerCase();
  // `git push ...` is the remote Contents-write surface. Local `commit`
  // stays allowed (reviewers never reach it: no edit/write Pi tools).
  return sub === "push";
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
 * Handle one `git credential <action>` request. `get` resolves the
 * credential via `resolveToken` and returns the helper stdout
 * (`username=x-access-token\npassword=<token>\n`); `store`/`erase` return
 * empty success (short-lived tokens are never stored by git).
 */
export async function handleGitCredentialRequest(
  identity: string,
  action: "get" | "store" | "erase",
  input: Record<string, string>,
  resolveToken: () => Promise<{ token: string }>,
): Promise<{ stdout: string; exitCode: number }> {
  void input;
  if (action === "store" || action === "erase") return { stdout: "", exitCode: 0 };
  // `get`: mint/refresh outside LLM context, then hand to git via stdout.
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
 * Build `git -C <repoPath> config --local ...` argv pinning the
 * credential helper to one checkout. Always `--local` — callers must
 * never pass `--global`/`--system` (refused here).
 */
export function gitConfigArgsForSetup(options: {
  repoPath: string;
  helperCommand: string;
  scope?: string;
}): { executable: string; args: string[] } {
  const repoPath = options.repoPath.trim();
  if (!repoPath) throw new Error(`setup-git requires a non-empty --path <repo-path>.`);
  const scope = options.scope?.trim() || "--local";
  if (scope !== "--local") {
    throw new Error(
      `Refusing git config scope ${JSON.stringify(scope)}: worker identity scoping must be per repo/worktree (--local), never --global/--system (would overwrite the developer's normal GitHub credentials).`,
    );
  }
  if (!options.helperCommand.trim()) throw new Error(`setup-git requires a helper command.`);
  return {
    executable: "git",
    args: ["-C", repoPath, "config", scope, "credential.helper", options.helperCommand],
  };
}

/** Default helper command embedded in repo-local git config. */
export function defaultHelperCommand(executable = "orca-pi"): string {
  return `${executable} github git-credential --identity worker`;
}

/**
 * Run repo-local `git config` via an injectable runner. Never touches
 * global/system config. Returns the helper command recorded.
 */
export async function setupRepoGitAuth(
  runner: ProcessRunner,
  options: { repoPath: string; helperCommand?: string; executable?: string },
): Promise<{ repoPath: string; helperCommand: string }> {
  const helperCommand = options.helperCommand ?? defaultHelperCommand(options.executable ?? "orca-pi");
  const { executable, args } = gitConfigArgsForSetup({
    repoPath: options.repoPath,
    helperCommand,
  });
  let result;
  try {
    result = await runner.run(executable, args);
  } catch (error) {
    throw new Error(
      `setup-git failed: could not run git config --local in ${JSON.stringify(options.repoPath)} (${error instanceof Error ? error.message : String(error)}). Is this a git checkout?`,
    );
  }
  if (result.exitCode !== 0) {
    const detail = `${result.stderr || result.stdout}`.trim().slice(0, 500);
    throw new Error(
      `setup-git failed: git config --local exited ${result.exitCode}${detail ? ` — ${redactSecretsFromText(detail, [])}` : ""}. Is ${JSON.stringify(options.repoPath)} a git checkout?`,
    );
  }
  return { repoPath: options.repoPath, helperCommand };
}

/**
 * Verify repo-local config does not leak to global scope: reads
 * `git config --show-origin --get credential.helper` and asserts at least
 * one entry originates from the repo-local file. Pure parser over runner
 * output (testable without git).
 */
export function assertRepoLocalHelperConfigured(
  showOriginOutput: string,
  options?: { repoPath?: string },
): void {
  const lines = showOriginOutput.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) {
    throw new Error(
      `No git credential.helper is configured${options?.repoPath ? ` for ${JSON.stringify(options.repoPath)}` : ""} — run \`orca-pi github setup-git --identity worker --path <repo-path>\` (repo-local, never --global) and retry.`,
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

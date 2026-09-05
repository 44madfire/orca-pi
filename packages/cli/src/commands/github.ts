/**
 * `orca-pi github` commands (OP1.9 / JEF-15).
 *
 * Structured helpers over distinct GitHub automation identities — never
 * exposes raw credentials to Pi. All GitHub actions run behind a logical
 * identity name (`worker`, `reviewer`); tokens resolve at launch/runtime
 * via env / helper (see `@orca-pi/core` github module) and are never
 * logged.
 *
 * Commands:
 *   orca-pi github auth status --identity <name> [--json]
 *   orca-pi github review --identity <name> --pr <url|number|owner/repo#n>
 *     --verdict <approve|request-changes|comment> --body <text|@file>
 *     [--repo <owner/repo>] [--commit <sha>] [--task <id>] [--issue <JEF-...>] [--json]
 *
 * Reviews are head-aware: an omitted --commit pins to the PR's current
 * head.sha (captured in preflight, matching GitHub's default) and is always
 * sent as commit_id; retries dedupe only on exact commit equality, so new
 * pushes always get a fresh review.
 *   orca-pi github check start --identity <name> --repo <owner/repo> --sha <sha>
 *     [--summary <text>] [--task <id>] [--issue <JEF-...>] [--json]
 *   orca-pi github check complete --identity <name> --repo <owner/repo> --sha <sha>
 *     --verdict <approve|request-changes|comment> --summary <text>
 *     [--check-run-id <n>] [--task <id>] [--issue <JEF-...>] [--json]
 *
 * Human remains the final merge authority — no auto-merge command exists.
 */

import {
  AGENT_REVIEW_CHECK_NAME,
  completeAgentReviewCheck,
  describeCredentialStatus,
  GITHUB_IDENTITY_PATTERN,
  MAX_GITHUB_IDENTITY_LENGTH,
  parsePullRequestRef,
  parseReviewVerdict,
  sanitizeErrorForDisplay,
  startAgentReviewCheck,
  submitGithubReview,
  verdictToCheckConclusion,
  type GithubFetchFn,
  type InstallationTokenCache,
} from "@orca-pi/core";
import { createInstallationTokenCache } from "@orca-pi/core";

export interface GithubCommandDeps {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env?: NodeJS.ProcessEnv;
  fs?: Pick<typeof import("node:fs/promises"), "readFile">;
  fetchFn?: GithubFetchFn;
  cache?: InstallationTokenCache;
  apiBase?: string;
}

export interface GithubCommandResult {
  exitCode: number;
}

const GITHUB_USAGE = `orca-pi github — distinct GitHub automation identities and review checks

Usage:
  orca-pi github auth status --identity <name> [--json]
  orca-pi github review --identity reviewer --pr <url|number|owner/repo#n> --verdict <approve|request-changes|comment> --body <text|@file> [--repo <owner/repo>] [--commit <sha>] [--task <id>] [--issue <id>] [--json]
  orca-pi github check start --identity reviewer --repo <owner/repo> --sha <sha> [--summary <text>] [--task <id>] [--issue <id>] [--json]
  orca-pi github check complete --identity reviewer --repo <owner/repo> --sha <sha> --verdict <approve|request-changes|comment> --summary <text> [--check-run-id <n>] [--task <id>] [--issue <id>] [--json]

Identities are logical credential slots resolved at runtime via env
(ORCA_PI_GITHUB_<IDENTITY>_TOKEN plus verified ORCA_PI_GITHUB_REVIEWER_LOGIN /
ORCA_PI_GITHUB_REVIEWER_INSTALLATION_ID for the reviewer App, all outside LLM
context). Tokens never appear in output.
Formal reviews and the orca-pi/agent-review check must use --identity reviewer:
the CLI proves installation-token class (GET /installation/repositories, which
supports IATs unlike GET /user) for the trusted configured App login and
distinctness from the PR author before any POST, so same-account PATs and
--identity worker never reach the write APIs. Check start is idempotent
(reuses the deterministic run for the SHA); review retries with identical
inputs dedupe via response-state matching. The reviewer App holds Contents:
read only; human merges.
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

async function runAuthStatus(args: readonly string[], deps: GithubCommandDeps): Promise<GithubCommandResult> {
  let identity: string | undefined;
  let asJson = false;
  for (let i = 0; i < args.length;) {
    const arg = args[i] as string;
    if (arg === "--identity") {
      const taken = takeValue(args, i, "--identity");
      identity = taken.value;
      i += taken.consumed;
    } else if (arg === "--json") {
      asJson = true;
      i += 1;
    } else if (isHelpFlag(arg)) {
      deps.stdout(`${GITHUB_USAGE}`);
      return { exitCode: 0 };
    } else if (arg.startsWith("--")) {
      deps.stderr(`error: unknown github auth status option: ${arg}\n`);
      deps.stderr(`usage: orca-pi github auth status --identity <name> [--json]\n`);
      return { exitCode: 2 };
    } else {
      deps.stderr(`error: unexpected argument: ${arg}\n`);
      deps.stderr(`usage: orca-pi github auth status --identity <name> [--json]\n`);
      return { exitCode: 2 };
    }
  }
  let resolvedIdentity: string;
  try {
    resolvedIdentity = validateIdentity(identity);
  } catch (error) {
    deps.stderr(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return { exitCode: 2 };
  }
  const env = deps.env ?? process.env;
  const cache = deps.cache ?? createInstallationTokenCache();
  const status = describeCredentialStatus(resolvedIdentity, env, cache);
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
      deps.stderr(`usage: orca-pi github review --identity <name> --pr <ref> --verdict <v> --body <text|@file> [--repo <o/r>] [--json]\n`);
      return { exitCode: 2 };
    } else {
      deps.stderr(`error: unexpected argument: ${arg}\n`);
      deps.stderr(`usage: orca-pi github review --identity <name> --pr <ref> --verdict <v> --body <text|@file> [--repo <o/r>] [--json]\n`);
      return { exitCode: 2 };
    }
  }
  try {
    const resolvedIdentity = validateIdentity(identity);
    if (!pr) throw new Error(`Missing --pr <url|number|owner/repo#n> (e.g. --pr https://github.com/octo/hello-world/pull/123).`);
    if (!verdictRaw) throw new Error(`Missing --verdict <approve|request-changes|comment>.`);
    if (bodyRaw === undefined) throw new Error(`Missing --body <text|@file> (inline text or @<file>).`);
    const verdict = parseReviewVerdict(verdictRaw);
    const prRef = parsePullRequestRef(pr, repo ? { repo } : undefined);
    const body = await resolveBody(bodyRaw, deps.fs);
    if (!body.trim()) throw new Error(`Review body must not be empty — provide findings with file/line evidence.`);
    const env = deps.env ?? process.env;
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
    deps.stderr(`usage: orca-pi github check start|complete --identity <name> --repo <owner/repo> --sha <sha> ...\n`);
    return { exitCode: 2 };
  }
  let identity: string | undefined;
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
      deps.stderr(`usage: orca-pi github check ${action} --identity <name> --repo <owner/repo> --sha <sha> ...\n`);
      return { exitCode: 2 };
    } else {
      deps.stderr(`error: unexpected argument: ${arg}\n`);
      deps.stderr(`usage: orca-pi github check ${action} --identity <name> --repo <owner/repo> --sha <sha> ...\n`);
      return { exitCode: 2 };
    }
  }
  try {
    const resolvedIdentity = validateIdentity(identity);
    if (!repo) throw new Error(`Missing --repo <owner/repo> (e.g. --repo octo/hello-world).`);
    const { owner, repo: repoName } = parseRepo(repo);
    if (!sha || !sha.trim()) throw new Error(`Missing --sha <commit-sha>.`);
    if (!/^[0-9a-f]{4,64}$/i.test(sha.trim())) throw new Error(`Invalid --sha ${JSON.stringify(sha)}: expected a commit SHA.`);
    const headSha = sha.trim();
    const provenance = (task || issue) ? { ...(task ? { taskId: task } : {}), ...(issue ? { linearIssueId: issue } : {}), profile: resolvedIdentity } : undefined;
    const env = deps.env ?? process.env;
    const baseOpts = {
      ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
      env,
      ...(deps.cache ? { cache: deps.cache } : {}),
      ...(deps.apiBase ? { apiBase: deps.apiBase } : {}),
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
    deps.stderr(`usage: orca-pi github auth status --identity <name> [--json]\n`);
    return { exitCode: 2 };
  }
  if (subcommand === "review") return await runReview(rest, deps);
  if (subcommand === "check") return await runCheck(rest, deps);
  deps.stderr(`error: unknown github subcommand: ${subcommand}\n`);
  deps.stderr(`${GITHUB_USAGE}`);
  return { exitCode: 2 };
}

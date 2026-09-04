/**
 * Localized `--json` parsing for public Orca CLI contracts (OP1.4 / JEF-8).
 *
 * All raw JSON handling lives here so the process runner and the spawn
 * orchestrator never scatter `JSON.parse` or shape assumptions. Parsers are
 * intentionally tolerant: Orca's `--json` envelope is stable
 * (`{ ok, result, error, _meta }`) but nested field names vary across
 * versions (`task.id` vs `taskId`, `terminal.handle` vs `handle`, ...), so
 * each parser probes a bounded candidate list and fails with an actionable
 * {@link OrcaJsonParseError} when nothing matches.
 *
 * Parsers never echo full prompts or secrets: error snippets are truncated
 * to {@link ORCA_JSON_SNIPPET_LIMIT} characters.
 */

import type {
  TaskReceipt,
  TerminalReceipt,
  WorkerAttachReceipt,
  WorktreeIdentity,
  WorktreeReceipt,
} from "./receipts.js";

/** Max characters of raw stdout included in parse-error diagnostics. */
export const ORCA_JSON_SNIPPET_LIMIT = 500;

/** Raw Orca CLI stdout was not usable JSON or lacked the expected shape. */
export class OrcaJsonParseError extends Error {
  readonly context: string;
  readonly snippet: string;

  constructor(context: string, snippet: string, message: string) {
    super(message);
    this.name = "OrcaJsonParseError";
    this.context = context;
    this.snippet = snippet;
  }
}

function snippetOf(stdout: string): string {
  const trimmed = stdout.trim();
  if (trimmed.length <= ORCA_JSON_SNIPPET_LIMIT) return trimmed || "(empty)";
  return `${trimmed.slice(0, ORCA_JSON_SNIPPET_LIMIT)}... (+${trimmed.length - ORCA_JSON_SNIPPET_LIMIT} more)`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Parse the outer envelope and return `result` (throws on malformed JSON). */
function parseEnvelopeResult(stdout: string, context: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new OrcaJsonParseError(
      context,
      snippetOf(stdout),
      `${context}: Orca CLI returned malformed JSON (${error instanceof Error ? error.message : String(error)}). ` +
        `Raw output (truncated): ${snippetOf(stdout)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new OrcaJsonParseError(
      context,
      snippetOf(stdout),
      `${context}: expected a JSON object envelope, got ${Array.isArray(parsed) ? "array" : typeof parsed}. ` +
        `Raw output (truncated): ${snippetOf(stdout)}`,
    );
  }
  if (parsed["ok"] === false) {
    const error = isRecord(parsed["error"])
      ? parsed["error"]
      : undefined;
    const code =
      asNonEmptyString(error?.["code"]) ?? "orca-command-failed";
    const message =
      asNonEmptyString(error?.["message"]) ?? "Orca CLI reported failure.";
    throw new OrcaJsonParseError(
      context,
      snippetOf(stdout),
      `${context}: Orca CLI reported ok:false (code ${code}): ${message}`,
    );
  }
  if (!("result" in parsed)) {
    throw new OrcaJsonParseError(
      context,
      snippetOf(stdout),
      `${context}: Orca JSON envelope has no "result" field. Raw output (truncated): ${snippetOf(stdout)}`,
    );
  }
  return parsed["result"];
}

function firstString(candidates: readonly unknown[]): string | undefined {
  for (const candidate of candidates) {
    const value = asNonEmptyString(candidate);
    if (value !== undefined) return value;
  }
  return undefined;
}

function child(record: unknown, key: string): unknown {
  return isRecord(record) ? record[key] : undefined;
}

function missingField(context: string, stdout: string, field: string, tried: string): never {
  throw new OrcaJsonParseError(
    context,
    snippetOf(stdout),
    `${context}: Orca JSON is missing required "${field}" (tried ${tried}). ` +
      `The installed Orca CLI may use a different shape — see Raw output (truncated): ${snippetOf(stdout)}`,
  );
}

/** Parse `orchestration task-create --json` stdout. */
export function parseTaskCreateJson(stdout: string): TaskReceipt {
  const context = "task-create";
  const result = parseEnvelopeResult(stdout, context);
  const task = child(result, "task");
  const taskId = firstString([
    child(task, "id"),
    child(task, "taskId"),
    child(task, "task_id"),
    child(result, "taskId"),
    child(result, "task_id"),
    child(result, "id"),
  ]);
  if (taskId === undefined) {
    missingField(
      context,
      stdout,
      "taskId",
      "result.task.id, result.task.taskId, result.taskId, result.id",
    );
  }
  const run = child(result, "run");
  const runId = firstString([
    child(run, "id"),
    child(task, "runId"),
    child(result, "runId"),
    child(result, "run_id"),
  ]);
  return runId !== undefined ? { taskId, runId } : { taskId };
}

/** Parse `terminal create --json` stdout. */
export function parseTerminalCreateJson(stdout: string): TerminalReceipt {
  const context = "terminal-create";
  const result = parseEnvelopeResult(stdout, context);
  const terminal = child(result, "terminal");
  const startupTerminal = child(result, "startupTerminal");
  const handle = firstString([
    child(terminal, "handle"),
    child(result, "handle"),
    child(result, "terminalHandle"),
    child(result, "terminal_handle"),
    child(result, "agentTerminalHandle"),
    child(startupTerminal, "handle"),
    child(result, "id"),
  ]);
  if (handle === undefined) {
    missingField(
      context,
      stdout,
      "terminal handle",
      "result.terminal.handle, result.handle, result.terminalHandle, result.agentTerminalHandle, result.startupTerminal.handle",
    );
  }
  return { handle };
}

/** Parse `worktree create --json` stdout. */
export function parseWorktreeCreateJson(stdout: string): WorktreeReceipt {
  const context = "worktree-create";
  const result = parseEnvelopeResult(stdout, context);
  return parseWorktreeIdentityFromResult(result, context, stdout);
}

/** Parse `worktree current --json` / `worktree show --json` stdout. */
export function parseWorktreeShowJson(stdout: string): WorktreeIdentity {
  const context = "worktree-resolve";
  const result = parseEnvelopeResult(stdout, context);
  return parseWorktreeIdentityFromResult(result, context, stdout);
}

function parseWorktreeIdentityFromResult(
  result: unknown,
  context: string,
  stdout: string,
): WorktreeIdentity {
  const worktree = child(result, "worktree");
  const id = firstString([
    child(worktree, "id"),
    child(result, "worktreeId"),
    child(result, "worktree_id"),
    child(result, "id"),
  ]);
  if (id === undefined) {
    missingField(
      context,
      stdout,
      "worktree id",
      "result.worktree.id, result.worktreeId, result.id",
    );
  }
  const path = firstString([child(worktree, "path"), child(result, "path")]);
  const displayName = firstString([
    child(worktree, "displayName"),
    child(result, "displayName"),
  ]);
  return {
    id,
    ...(path !== undefined ? { path } : {}),
    ...(displayName !== undefined ? { displayName } : {}),
  };
}

/** Parse `orchestration run-current --json` stdout (`run` may be null). */
export function parseRunCurrentJson(stdout: string): { runId?: string } {
  const context = "run-resolve";
  const result = parseEnvelopeResult(stdout, context);
  if (result === null || result === undefined) return {};
  const run = child(result, "run");
  if (run === null || run === undefined) return {};
  if (!isRecord(run)) {
    throw new OrcaJsonParseError(
      context,
      snippetOf(stdout),
      `${context}: expected result.run to be an object or null. Raw output (truncated): ${snippetOf(stdout)}`,
    );
  }
  const runId = firstString([
    child(run, "id"),
    child(result, "runId"),
    child(result, "run_id"),
  ]);
  return runId !== undefined ? { runId } : {};
}

/**
 * Parse `orchestration worker-start --task ... --terminal ... --json` stdout.
 *
 * The supervised contract is strict: a missing dispatch id or a non-ready
 * state is a failure, never a successful receipt. `dispatch --inject` is
 * deliberately unsupervised (no `worker_dispatches` row) and must not be
 * used here — Orca directs supervised callers to `worker-start --terminal`.
 *
 * Tolerated dispatch-id shapes (first hit wins):
 * `result.dispatch.id`, `result.dispatch.dispatchId`,
 * `result.dispatch.dispatch_id`, `result.dispatchId`, `result.dispatch_id`,
 * `result.worker.dispatchId`, `result.worker.dispatch_id`.
 *
 * Readiness: `result.ready === false` (or a `failed`/`outcome_unknown`
 * stage/status) throws. An absent `ready` flag is accepted because the CLI
 * exits nonzero for failed/unknown starts, so exit-0 plus a dispatch id
 * implies ready. An explicit unsupervised marker (`unsupervised: true` /
 * `supervised: false`) also throws — the receipt must be supervised.
 */
export function parseWorkerStartJson(
  stdout: string,
  fallback: { taskId: string; terminalHandle: string },
): WorkerAttachReceipt {
  const context = "worker-start";
  const result = parseEnvelopeResult(stdout, context);
  const dispatch = child(result, "dispatch");
  const worker = child(result, "worker");
  const dispatchId = firstString([
    child(dispatch, "id"),
    child(dispatch, "dispatchId"),
    child(dispatch, "dispatch_id"),
    child(result, "dispatchId"),
    child(result, "dispatch_id"),
    child(worker, "dispatchId"),
    child(worker, "dispatch_id"),
  ]);
  if (dispatchId === undefined) {
    missingField(
      context,
      stdout,
      "dispatch id",
      "result.dispatch.id, result.dispatchId, result.dispatch_id",
    );
  }
  const unsupervisedRaw =
    child(dispatch, "unsupervised") ??
    child(worker, "unsupervised") ??
    child(result, "unsupervised");
  const supervisedRaw =
    child(dispatch, "supervised") ??
    child(worker, "supervised") ??
    child(result, "supervised");
  if (unsupervisedRaw === true || supervisedRaw === false) {
    throw new OrcaJsonParseError(
      context,
      snippetOf(stdout),
      `${context}: Orca reported an unsupervised dispatch for a supervised ` +
        `worker-start --terminal attach (dispatch ${dispatchId}). ` +
        `Use worker-start --terminal for supervised lifecycle; dispatch ` +
        `--inject is deliberately unsupervised.`,
    );
  }
  const ready = child(result, "ready");
  if (ready === false) {
    throw new OrcaJsonParseError(
      context,
      snippetOf(stdout),
      `${context}: Orca reported non-ready state (ready:false) for dispatch ` +
        `${dispatchId}. A failed or unknown start exits nonzero; inspect its ` +
        `stage, effects, and residualResources instead of retrying blindly.`,
    );
  }
  const stage = firstString([
    child(result, "stage"),
    child(result, "status"),
    child(dispatch, "stage"),
    child(dispatch, "status"),
  ]);
  if (
    stage !== undefined &&
    ["failed", "outcome_unknown", "stopped", "failedstage"].includes(
      stage.toLowerCase().replace(/[^a-z_]/g, ""),
    )
  ) {
    throw new OrcaJsonParseError(
      context,
      snippetOf(stdout),
      `${context}: Orca reported non-ready stage "${stage}" for dispatch ` +
        `${dispatchId}.`,
    );
  }
  return {
    taskId: fallback.taskId,
    dispatchId,
    terminalHandle: fallback.terminalHandle,
  };
}

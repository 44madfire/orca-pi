/**
 * Tolerant `--json` parsers for compact orchestration reads (OP1.5 / JEF-9).
 *
 * Mirrors `../orca/json-parsers.ts` conventions: probe the stable outer
 * envelope (`{ ok, result, error }`) then a bounded candidate list for
 * nested fields that vary across Orca versions. Parsers return normalized
 * summaries plus the raw `result` for forward compatibility — they never
 * echo prompts/secrets and never infer completion from terminal text.
 */

import { ORCA_JSON_SNIPPET_LIMIT, OrcaJsonParseError } from "../orca/json-parsers.js";

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

function child(record: unknown, key: string): unknown {
  return isRecord(record) ? record[key] : undefined;
}

function firstString(candidates: readonly unknown[]): string | undefined {
  for (const candidate of candidates) {
    const value = asNonEmptyString(candidate);
    if (value !== undefined) return value;
  }
  return undefined;
}

function parseEnvelopeResult(stdout: string, context: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new OrcaJsonParseError(
      context,
      snippetOf(stdout),
      `${context}: Orca CLI returned malformed JSON (${error instanceof Error ? error.message : String(error)}). Raw output (truncated): ${snippetOf(stdout)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new OrcaJsonParseError(
      context,
      snippetOf(stdout),
      `${context}: expected a JSON object envelope, got ${Array.isArray(parsed) ? "array" : typeof parsed}. Raw output (truncated): ${snippetOf(stdout)}`,
    );
  }
  if (parsed["ok"] === false) {
    const error = isRecord(parsed["error"]) ? parsed["error"] : undefined;
    const code = asNonEmptyString(error?.["code"]) ?? "orca-command-failed";
    const message = asNonEmptyString(error?.["message"]) ?? "Orca CLI reported failure.";
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

/** Normalized `worker-show --dispatch` view (Orca-state only, no terminal-text inference). */
export interface ParsedWorkerShow {
  readonly dispatchId: string;
  readonly taskId?: string;
  readonly workerState?: string;
  readonly terminalHandle?: string;
  readonly supervised?: boolean;
  readonly raw: unknown;
}

/** Parse `orchestration worker-show --dispatch ... --json` stdout. */
export function parseWorkerShowJson(stdout: string, fallbackDispatchId: string): ParsedWorkerShow {
  const context = "worker-show";
  const result = parseEnvelopeResult(stdout, context);
  const dispatch = child(result, "dispatch");
  const worker = child(result, "worker");
  const observation = child(result, "observation");
  const dispatchId =
    firstString([
      child(dispatch, "id"),
      child(dispatch, "dispatchId"),
      child(dispatch, "dispatch_id"),
      child(result, "dispatchId"),
      child(result, "dispatch_id"),
      child(worker, "dispatchId"),
      child(worker, "dispatch_id"),
    ]) ?? fallbackDispatchId;
  const taskId = firstString([
    child(dispatch, "taskId"),
    child(dispatch, "task_id"),
    child(dispatch, "task"),
    child(result, "taskId"),
    child(result, "task_id"),
    child(worker, "taskId"),
    child(worker, "task_id"),
  ]);
  const workerState = firstString([
    child(dispatch, "state"),
    child(dispatch, "stage"),
    child(dispatch, "status"),
    child(result, "state"),
    child(result, "stage"),
    child(result, "status"),
    child(worker, "state"),
    child(worker, "status"),
    child(observation, "state"),
  ]);
  const terminalHandle = firstString([
    child(dispatch, "terminalHandle"),
    child(dispatch, "terminal_handle"),
    child(dispatch, "agentTerminalHandle"),
    child(worker, "terminalHandle"),
    child(worker, "terminal_handle"),
    child(worker, "agent_terminal_handle"),
    child(worker, "agentTerminalHandle"),
    child(result, "terminalHandle"),
    child(result, "agentTerminalHandle"),
  ]);
  const unsupervisedRaw =
    child(dispatch, "unsupervised") ?? child(worker, "unsupervised") ?? child(result, "unsupervised");
  const supervisedRaw =
    child(dispatch, "supervised") ?? child(worker, "supervised") ?? child(result, "supervised");
  const supervised =
    unsupervisedRaw === true ? false : supervisedRaw === false ? false : undefined;
  return {
    dispatchId,
    ...(taskId !== undefined ? { taskId } : {}),
    ...(workerState !== undefined ? { workerState } : {}),
    ...(terminalHandle !== undefined ? { terminalHandle } : {}),
    ...(supervised !== undefined ? { supervised } : {}),
    raw: result,
  };
}

/** One normalized worker-list row. */
export interface ParsedWorkerListEntry {
  readonly dispatchId?: string;
  readonly taskId?: string;
  readonly terminalHandle?: string;
  readonly terminalState?: string;
  readonly workerState?: string;
  readonly supervised?: boolean;
}

/** Parse `orchestration worker-list --json` stdout (empty list is valid). */
export function parseWorkerListJson(stdout: string): { entries: ParsedWorkerListEntry[]; raw: unknown } {
  const context = "worker-list";
  const result = parseEnvelopeResult(stdout, context);
  const workersRaw =
    child(result, "workers") ?? child(result, "dispatches") ?? child(result, "items") ?? [];
  const rows: unknown[] = Array.isArray(workersRaw) ? workersRaw : [];
  const entries: ParsedWorkerListEntry[] = rows.map((row) => {
    const dispatch = child(row, "dispatch");
    const worker = child(row, "worker");
    const terminal = child(row, "terminal");
    const dispatchId = firstString([
      child(dispatch, "id"),
      child(dispatch, "dispatchId"),
      child(row, "dispatchId"),
      child(row, "dispatch_id"),
      child(worker, "dispatchId"),
    ]);
    const taskId = firstString([
      child(dispatch, "taskId"),
      child(row, "taskId"),
      child(row, "task_id"),
      child(worker, "taskId"),
    ]);
    const terminalHandle = firstString([
      child(dispatch, "terminalHandle"),
      child(worker, "terminalHandle"),
      child(worker, "agent_terminal_handle"),
      child(worker, "agentTerminalHandle"),
      child(terminal, "handle"),
      child(row, "terminalHandle"),
      child(row, "agentTerminalHandle"),
    ]);
    const terminalState = firstString([child(row, "terminalState"), child(row, "terminal_state")]);
    const workerState = firstString([
      child(dispatch, "state"),
      child(row, "state"),
      child(row, "status"),
      child(worker, "state"),
    ]);
    const unsupervisedRaw = child(dispatch, "unsupervised") ?? child(row, "unsupervised");
    const supervised = unsupervisedRaw === true ? false : undefined;
    return {
      ...(dispatchId !== undefined ? { dispatchId } : {}),
      ...(taskId !== undefined ? { taskId } : {}),
      ...(terminalHandle !== undefined ? { terminalHandle } : {}),
      ...(terminalState !== undefined ? { terminalState } : {}),
      ...(workerState !== undefined ? { workerState } : {}),
      ...(supervised !== undefined ? { supervised } : {}),
    };
  });
  return { entries: Object.freeze(entries) as ParsedWorkerListEntry[], raw: result };
}

/** Normalized `dispatch-show --task` view. */
export interface ParsedDispatchShow {
  readonly taskId: string;
  readonly dispatchId?: string;
  readonly taskStatus?: string;
  readonly workerState?: string;
  readonly terminalHandle?: string;
  readonly raw: unknown;
}

/** Parse `orchestration dispatch-show --task ... --json` stdout. */
export function parseDispatchShowJson(stdout: string, fallbackTaskId: string): ParsedDispatchShow {
  const context = "dispatch-show";
  const result = parseEnvelopeResult(stdout, context);
  const dispatch = child(result, "dispatch");
  const task = child(result, "task");
  const worker = child(result, "worker");
  const taskId =
    firstString([
      child(task, "id"),
      child(task, "taskId"),
      child(dispatch, "taskId"),
      child(result, "taskId"),
      child(result, "task_id"),
    ]) ?? fallbackTaskId;
  const dispatchId = firstString([
    child(dispatch, "id"),
    child(dispatch, "dispatchId"),
    child(result, "dispatchId"),
    child(result, "dispatch_id"),
    child(worker, "dispatchId"),
  ]);
  const taskStatus = firstString([
    child(task, "status"),
    child(task, "state"),
    child(result, "taskStatus"),
    child(dispatch, "taskStatus"),
  ]);
  const workerState = firstString([
    child(dispatch, "state"),
    child(dispatch, "status"),
    child(result, "state"),
    child(result, "status"),
    child(worker, "state"),
  ]);
  const terminalHandle = firstString([
    child(dispatch, "terminalHandle"),
    child(worker, "terminalHandle"),
    child(worker, "agent_terminal_handle"),
    child(result, "terminalHandle"),
  ]);
  return {
    taskId,
    ...(dispatchId !== undefined ? { dispatchId } : {}),
    ...(taskStatus !== undefined ? { taskStatus } : {}),
    ...(workerState !== undefined ? { workerState } : {}),
    ...(terminalHandle !== undefined ? { terminalHandle } : {}),
    raw: result,
  };
}

/** One normalized task-list row. */
export interface ParsedTaskListEntry {
  readonly taskId: string;
  readonly status?: string;
  readonly specTruncated?: string;
}

/** Parse `orchestration task-list --json` stdout. */
export function parseTaskListJson(stdout: string): { entries: ParsedTaskListEntry[]; raw: unknown } {
  const context = "task-list";
  const result = parseEnvelopeResult(stdout, context);
  const tasksRaw = child(result, "tasks") ?? child(result, "items") ?? [];
  const rows: unknown[] = Array.isArray(tasksRaw) ? tasksRaw : [];
  const entries: ParsedTaskListEntry[] = [];
  for (const row of rows) {
    const task = child(row, "task") ?? row;
    const taskId = firstString([
      child(task, "id"),
      child(task, "taskId"),
      child(row, "taskId"),
      child(row, "id"),
    ]);
    if (taskId === undefined) continue;
    const status = firstString([child(task, "status"), child(task, "state"), child(row, "status")]);
    const spec = firstString([child(task, "spec"), child(task, "specTruncated"), child(row, "spec")]);
    entries.push({
      taskId,
      ...(status !== undefined ? { status } : {}),
      ...(spec !== undefined ? { specTruncated: spec.slice(0, 160) } : {}),
    });
  }
  return { entries: Object.freeze(entries) as ParsedTaskListEntry[], raw: result };
}

/** Parse `orchestration send --json` stdout (delivery acknowledgement). */
export function parseSendJson(stdout: string): { raw: unknown } {
  const context = "send";
  const result = parseEnvelopeResult(stdout, context);
  return { raw: result };
}

/** Parse `orchestration worker-stop --json` stdout. */
export function parseWorkerStopJson(stdout: string): { raw: unknown } {
  const context = "worker-stop";
  const result = parseEnvelopeResult(stdout, context);
  return { raw: result };
}

/**
 * True when a task status means settled (Orca is authoritative for
 * completion — never terminal text).
 */
export function isSettledTaskStatus(status: unknown): boolean {
  if (typeof status !== "string") return false;
  const normalized = status.toLowerCase();
  return normalized === "completed" || normalized === "failed" || normalized === "blocked";
}

/** True when a task status means success. */
export function isSuccessfulTaskStatus(status: unknown): boolean {
  return typeof status === "string" && status.toLowerCase() === "completed";
}

/** True when a worker/dispatch state means the terminal is settled. */
export function isSettledWorkerState(state: unknown): boolean {
  if (typeof state !== "string") return false;
  const normalized = state.toLowerCase().replace(/[^a-z_]/g, "");
  return (
    normalized === "completed" ||
    normalized === "failed" ||
    normalized === "stopped" ||
    normalized === "released" ||
    normalized === "releaseready"
  );
}

/**
 * Compact Pi-facing orchestration types (OP1.5 / JEF-9).
 *
 * The coordinator-facing surface is deliberately small: spawn, status, send,
 * wait, stop. Every receipt is frozen, JSON-stable, and carries only Orca's
 * own identities (Task/Dispatch/terminal/worktree) — Orca remains the
 * orchestration source of truth and these types never duplicate its database.
 *
 * Terminal text is never a status/completion authority: `status` and `wait`
 * read Task/Dispatch/terminal state via the public `orca ... --json`
 * contracts, never by inferring from pane output.
 */

import type { SupervisedWorkerReceipt, WorktreePolicy } from "../orca/receipts.js";

export type { WorktreePolicy };

/** How the coordinator names a worker: dispatch id (primary) or terminal handle (alias). */
export type WorkerSelector =
  | { readonly dispatchId: string }
  | { readonly terminalHandle: string };

/** How the coordinator names a wait/status target. */
export type WaitTarget =
  | { readonly dispatchId: string }
  | { readonly terminalHandle: string }
  | { readonly taskId: string };

/** Caller supplies either an inline spec or an existing Task id. */
export type CompactTaskSelection =
  | { readonly spec: string; readonly taskTitle?: string; readonly parentTaskId?: string; readonly deps?: readonly string[] }
  | { readonly taskId: string };

/** Options for the compact `spawn` operation (before CLI flag mapping). */
export interface CompactSpawnOptions {
  readonly profileName: string;
  readonly task: CompactTaskSelection;
  readonly worktree?: WorktreePolicy;
  readonly runId?: string;
  readonly fromHandle?: string;
  readonly terminalTitle?: string;
  readonly readinessTimeoutMs?: number;
  readonly preserveTerminalOnFailure?: boolean;
  readonly signal?: AbortSignal;
}

/**
 * Structured receipt for one compact `spawn`. Extends JEF-8's supervised
 * receipt with the coordinator-facing worker alias: the dispatch id doubles
 * as the `--worker` handle, and the terminal handle remains a valid alias.
 */
export type CompactSpawnReceipt = SupervisedWorkerReceipt;

/** Normalized worker/task state for `status` and `wait` (Orca-state only). */
export interface CompactWorkerStatus {
  /** Dispatch id when known (always present for supervised workers). */
  readonly dispatchId?: string;
  /** Task id when known. */
  readonly taskId?: string;
  /** Normalized task status (`pending|ready|dispatched|completed|failed|blocked`) when known. */
  readonly taskStatus?: string;
  /** Normalized dispatch/worker state (`ready|failed|stopped|outcome_unknown|...`) when known. */
  readonly workerState?: string;
  /** Terminal handle when known. */
  readonly terminalHandle?: string;
  /** True when the worker is settled (completed/failed/stopped). */
  readonly settled: boolean;
  /** True when the outcome is successful (task completed). */
  readonly ok?: boolean;
  /** Human-readable one-line summary (no terminal-text inference). */
  readonly summary: string;
  /** Raw Orca payloads that produced this status (forward-compatible). */
  readonly raw?: unknown;
}

/** Receipt for `status` (single worker/task or a list sweep). */
export interface CompactStatusReceipt {
  readonly kind: "worker" | "task" | "list";
  readonly status?: CompactWorkerStatus;
  readonly workers?: readonly CompactWorkerStatus[];
  readonly tasks?: readonly { taskId: string; status?: string; specTruncated?: string }[];
}

/** Receipt for `send` (coordinator follow-up mail, not lifecycle completion). */
export interface CompactSendReceipt {
  readonly dispatchId: string;
  readonly taskId?: string;
  readonly subject: string;
  readonly delivered: boolean;
  readonly raw?: unknown;
}

/** Outcome for `wait` (bounded Orca-state poll, never terminal-text inference). */
export type CompactWaitOutcome = "completed" | "failed" | "timeout" | "cancelled";

/** Receipt for `wait`. */
export interface CompactWaitReceipt {
  readonly outcome: CompactWaitOutcome;
  readonly dispatchId?: string;
  readonly taskId?: string;
  readonly taskStatus?: string;
  readonly workerState?: string;
  readonly elapsedMs: number;
  readonly timedOut: boolean;
  readonly summary: string;
  readonly raw?: unknown;
}

/** Receipt for `stop` (terminal fence, never Task completion). */
export interface CompactStopReceipt {
  readonly dispatchId: string;
  readonly stopped: boolean;
  /** True when the second (or later) stop found nothing to do. */
  readonly alreadyStopped: boolean;
  /** Task status observed after the stop (unchanged by the stop itself). */
  readonly taskStatus?: string;
  readonly summary: string;
  readonly raw?: unknown;
}

/** Typed compact-operation failure (pre-launch vs Orca-stage failures). */
export class CompactOrchestrationError extends Error {
  readonly code: string;
  readonly dispatchId?: string;
  readonly taskId?: string;
  readonly terminalHandle?: string;
  readonly diagnostics: string;

  constructor(options: {
    code: string;
    message: string;
    diagnostics?: string;
    dispatchId?: string;
    taskId?: string;
    terminalHandle?: string;
    cause?: unknown;
  }) {
    super(options.message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "CompactOrchestrationError";
    this.code = options.code;
    this.diagnostics = options.diagnostics ?? "";
    if (options.dispatchId !== undefined) this.dispatchId = options.dispatchId;
    if (options.taskId !== undefined) this.taskId = options.taskId;
    if (options.terminalHandle !== undefined) this.terminalHandle = options.terminalHandle;
  }
}

/** Freeze a compact receipt (shallow + nested arrays) for provenance safety. */
export function freezeCompact<T extends object>(receipt: T): T {
  return Object.freeze(receipt);
}

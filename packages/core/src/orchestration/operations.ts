/**
 * Compact orchestration operations (OP1.5 / JEF-9).
 *
 * Thin wrappers over JEF-8's supervised adapter plus the JEF-9 Orca reads:
 * every operation resolves profiles pre-launch (unknown profiles fail before
 * any Orca effects), delegates lifecycle to Orca, and returns one frozen,
 * JSON-stable receipt. Orca Task/Dispatch/terminal state is authoritative —
 * terminal output is never inspected for completion/status.
 */

import { loadMergedProfiles } from "../profile/load.js";
import { resolveProfile, ProfileResolveError } from "../profile/resolve.js";
import type { ResolvedPiProfile } from "../profile/types.js";
import type { OrcaCli } from "../orca/orca-cli.js";
import { OrcaCommandError } from "../orca/orca-cli-process.js";
import { spawnSupervisedPiWorker } from "../orca/spawn-supervised-pi-worker.js";
import {
  isSettledTaskStatus,
  isSettledWorkerState,
  isSuccessfulTaskStatus,
} from "./orchestration-parsers.js";
import {
  loadWorkerMappings,
  recordWorkerMapping,
  resolveMapping,
  type MappingFs,
} from "./mapping-store.js";
import {
  DEFAULT_WAIT_TIMEOUT_MS,
  MAX_POLL_INTERVAL_MS,
  DEFAULT_POLL_INTERVAL_MS,
} from "./timeout.js";
import type {
  CompactSendReceipt,
  CompactSpawnOptions,
  CompactStatusReceipt,
  CompactStopReceipt,
  CompactWaitReceipt,
  CompactWorkerStatus,
} from "./types.js";
import { CompactOrchestrationError } from "./types.js";

export interface OperationProfileOptions {
  readonly projectRoot: string;
  readonly userConfigPath?: string;
  readonly projectConfigPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly homedir?: string;
  readonly osHomedir?: () => string;
  readonly fs?: Pick<typeof import("node:fs/promises"), "readFile">;
}

export interface SpawnOperationOptions extends CompactSpawnOptions, OperationProfileOptions {
  readonly orca: OrcaCli;
  readonly mappingFs?: MappingFs;
  readonly skipMappingPersist?: boolean;
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRunRequired(error: unknown): boolean {
  if (error instanceof OrcaCommandError) {
    const probe = `${error.code} ${error.message} ${error.diagnostics}`.toLowerCase();
    return probe.includes("run_required") || probe.includes("no run is bound");
  }
  const message = asMessage(error).toLowerCase();
  return message.includes("run_required") || message.includes("no run is bound");
}

function isNotFoundProbe(error: unknown): boolean {
  if (error instanceof OrcaCommandError) {
    const probe = `${error.code} ${error.message} ${error.diagnostics}`.toLowerCase();
    return (
      probe.includes("not_found") ||
      probe.includes("notfound") ||
      probe.includes("no such") ||
      probe.includes("unknown dispatch") ||
      probe.includes("unknown task") ||
      probe.includes("dispatch_not_found") ||
      probe.includes("task_not_found")
    );
  }
  const message = asMessage(error).toLowerCase();
  return message.includes("not_found") || message.includes("no such") || message.includes("unknown");
}

async function resolveProfileForSpawn(
  profileName: string,
  opts: OperationProfileOptions,
): Promise<ResolvedPiProfile> {
  const merged = await loadMergedProfiles({
    projectRoot: opts.projectRoot,
    ...(opts.userConfigPath !== undefined ? { userConfigPath: opts.userConfigPath } : {}),
    ...(opts.projectConfigPath !== undefined ? { projectConfigPath: opts.projectConfigPath } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.homedir !== undefined ? { homedir: opts.homedir } : {}),
    ...(opts.osHomedir !== undefined ? { osHomedir: opts.osHomedir } : {}),
    ...(opts.fs !== undefined ? { fs: opts.fs } : {}),
  });
  try {
    return resolveProfile(profileName, merged);
  } catch (error) {
    if (error instanceof ProfileResolveError) {
      throw new CompactOrchestrationError({
        code: "unknown-profile",
        message: error.message,
        diagnostics: `profile-resolve: ${error.message}`,
      });
    }
    throw error;
  }
}

/** Compact `spawn`: resolve profile pre-launch, then delegate to JEF-8's supervised adapter. */
export async function spawnCompactWorker(
  options: SpawnOperationOptions,
): Promise<import("./types.js").CompactSpawnReceipt> {
  const profile = await resolveProfileForSpawn(options.profileName, options);
  const receipt = await spawnSupervisedPiWorker({
    orca: options.orca,
    profile,
    task: options.task,
    ...(options.worktree !== undefined ? { worktree: options.worktree } : {}),
    ...(options.runId !== undefined ? { runId: options.runId } : {}),
    ...(options.fromHandle !== undefined ? { fromHandle: options.fromHandle } : {}),
    ...(options.terminalTitle !== undefined ? { terminalTitle: options.terminalTitle } : {}),
    ...(options.readinessTimeoutMs !== undefined
      ? { readinessTimeoutMs: options.readinessTimeoutMs }
      : {}),
    ...(options.preserveTerminalOnFailure !== undefined
      ? { preserveTerminalOnFailure: options.preserveTerminalOnFailure }
      : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  if (!options.skipMappingPersist) {
    try {
      await recordWorkerMapping(
        options.projectRoot,
        {
          dispatchId: receipt.dispatchId,
          taskId: receipt.taskId,
          terminalHandle: receipt.terminalHandle,
          profileName: receipt.profileName,
          ...(receipt.worktree.id !== undefined ? { worktreeId: receipt.worktree.id } : {}),
          ...(receipt.runId !== undefined ? { runId: receipt.runId } : {}),
          createdAt: new Date().toISOString(),
        },
        options.mappingFs,
      );
    } catch {
      // Best-effort only: the receipt already carries every id.
    }
  }
  return receipt;
}

export interface StatusOperationOptions {
  readonly orca: OrcaCli;
  readonly worker?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly fromHandle?: string;
  readonly projectRoot?: string;
  readonly mappingFs?: MappingFs;
}

function summarizeWorkerStatus(input: {
  dispatchId?: string;
  taskId?: string;
  taskStatus?: string;
  dispatchStatus?: string;
  workerState?: string;
  terminalHandle?: string;
}): CompactWorkerStatus {
  const settled =
    (input.taskStatus !== undefined && isSettledTaskStatus(input.taskStatus)) ||
    (input.workerState !== undefined && isSettledWorkerState(input.workerState));
  const ok =
    input.taskStatus !== undefined ? isSuccessfulTaskStatus(input.taskStatus) : undefined;
  const parts: string[] = [];
  if (input.dispatchId) parts.push(`dispatch ${input.dispatchId}`);
  if (input.taskId) parts.push(`task ${input.taskId} (${input.taskStatus ?? "status unknown"})`);
  if (input.dispatchStatus) parts.push(`dispatch ${input.dispatchStatus}`);
  if (input.workerState) parts.push(`worker ${input.workerState}`);
  if (input.terminalHandle) parts.push(`terminal ${input.terminalHandle}`);
  parts.push(settled ? "settled" : "running");
  return {
    ...(input.dispatchId !== undefined ? { dispatchId: input.dispatchId } : {}),
    ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    ...(input.taskStatus !== undefined ? { taskStatus: input.taskStatus } : {}),
    ...(input.dispatchStatus !== undefined ? { dispatchStatus: input.dispatchStatus } : {}),
    ...(input.workerState !== undefined ? { workerState: input.workerState } : {}),
    ...(input.terminalHandle !== undefined ? { terminalHandle: input.terminalHandle } : {}),
    settled,
    ...(ok !== undefined ? { ok } : {}),
    summary: parts.join(" · ") || "status unknown (Orca state unavailable)",
  };
}

/** Resolve a `--worker` value (dispatch id or terminal handle) to a dispatch id. */
export async function resolveWorkerToDispatch(
  orca: OrcaCli,
  raw: string,
  options?: { projectRoot?: string; mappingFs?: MappingFs },
): Promise<{ dispatchId: string; terminalHandle?: string; taskId?: string }> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new CompactOrchestrationError({
      code: "invalid-worker",
      message: `Invalid --worker "": expected a dispatch id or terminal handle.`,
      diagnostics: "worker-resolve: empty handle.",
    });
  }
  // 1. Local mapping is a hint only — Orca stays authoritative. When a
  // mapping hits, still prove the mapped Dispatch is live before trusting it
  // (especially for side-effecting `send`); stale mappings fall through to
  // live resolution below.
  if (options?.projectRoot) {
    try {
      const table = await loadWorkerMappings(options.projectRoot, options.mappingFs);
      const hit = resolveMapping(table, trimmed);
      if (hit) {
        try {
          const validated = await orca.showWorker(hit.dispatchId);
          return {
            dispatchId: validated.dispatchId,
            ...(validated.terminalHandle !== undefined
              ? { terminalHandle: validated.terminalHandle }
              : { terminalHandle: hit.terminalHandle }),
            ...(validated.taskId !== undefined
              ? { taskId: validated.taskId }
              : { taskId: hit.taskId }),
          };
        } catch {
          // Stale mapping — fall through to live resolution.
        }
      }
    } catch {
      // Fall through to live Orca resolution.
    }
  }
  // 2. Direct dispatch probe.
  try {
    const shown = await orca.showWorker(trimmed);
    return {
      dispatchId: shown.dispatchId,
      ...(shown.terminalHandle !== undefined ? { terminalHandle: shown.terminalHandle } : {}),
      ...(shown.taskId !== undefined ? { taskId: shown.taskId } : {}),
    };
  } catch (error) {
    if (!isNotFoundProbe(error)) {
      // Non-not-found errors (e.g. run_required never applies to worker-show,
      // but transport failures do) propagate with context.
      throw new CompactOrchestrationError({
        code: "worker-resolve-failed",
        message: `Could not inspect worker "${trimmed}": ${asMessage(error)}`,
        diagnostics: `worker-show: ${asMessage(error)}`,
        cause: error,
      });
    }
    // 3. Terminal-handle fallback: scan worker-list for a matching terminal.
    try {
      const listed = await orca.listWorkers();
      const hit = listed.entries.find(
        (entry) => entry.terminalHandle === trimmed || entry.dispatchId === trimmed,
      );
      if (hit?.dispatchId) {
        return {
          dispatchId: hit.dispatchId,
          ...(hit.terminalHandle !== undefined ? { terminalHandle: hit.terminalHandle } : {}),
          ...(hit.taskId !== undefined ? { taskId: hit.taskId } : {}),
        };
      }
    } catch {
      // Ignore list failures here; the final error below is authoritative.
    }
    throw new CompactOrchestrationError({
      code: "unknown-worker",
      message: `Unknown worker "${trimmed}". Check \`orca-pi status\` for live dispatch ids, or pass --task <task-id> instead.`,
      diagnostics: `worker-show: ${asMessage(error)}`,
      cause: error,
    });
  }
}

/** Compact `status`: single worker/task or a list sweep (Orca-state only). */
export async function getCompactStatus(
  options: StatusOperationOptions,
): Promise<CompactStatusReceipt> {
  const { orca } = options;
  if (options.worker !== undefined && options.taskId !== undefined) {
    throw new CompactOrchestrationError({
      code: "mutually-exclusive",
      message: `Invalid status flags: --worker and --task are mutually exclusive; pass exactly one.`,
      diagnostics: "status: --worker/--task are mutually exclusive.",
    });
  }
  if (options.worker !== undefined) {
    const resolved = await resolveWorkerToDispatch(orca, options.worker, {
      ...(options.projectRoot !== undefined ? { projectRoot: options.projectRoot } : {}),
      ...(options.mappingFs !== undefined ? { mappingFs: options.mappingFs } : {}),
    });
    const shown = await orca.showWorker(resolved.dispatchId);
    // Authoritative Task status comes from task-list; dispatch-show carries
    // only Dispatch identity/status in the current contract.
    let taskStatus: string | undefined;
    if (shown.taskId) {
      try {
        const listed = await orca.listTasks({
          ...(options.runId !== undefined ? { runId: options.runId } : {}),
          ...(options.fromHandle !== undefined ? { fromHandle: options.fromHandle } : {}),
        });
        taskStatus = listed.entries.find((entry) => entry.taskId === shown.taskId)?.status;
      } catch {
        // run_required (no Run bound) means tasks are unavailable; worker state stands alone.
      }
    }
    const status = summarizeWorkerStatus({
      dispatchId: shown.dispatchId,
      ...(shown.taskId !== undefined ? { taskId: shown.taskId } : {}),
      ...(taskStatus !== undefined ? { taskStatus } : {}),
      ...(shown.dispatchStatus !== undefined ? { dispatchStatus: shown.dispatchStatus } : {}),
      ...(shown.workerState !== undefined ? { workerState: shown.workerState } : {}),
      ...(shown.terminalHandle !== undefined ? { terminalHandle: shown.terminalHandle } : {}),
    });
    return Object.freeze({
      kind: "worker" as const,
      status: Object.freeze({ ...status, raw: shown.raw }),
    });
  }
  if (options.taskId !== undefined) {
    const taskId = options.taskId.trim();
    if (taskId.length === 0) {
      throw new CompactOrchestrationError({
        code: "invalid-task",
        message: `Invalid --task "": expected an Orca task id.`,
        diagnostics: "status: empty task id.",
      });
    }
    // dispatch-show carries Dispatch identity/status only in the current
    // contract — authoritative Task status always comes from task-list.
    const dispatch = await orca.showDispatch(taskId, {
      ...(options.fromHandle !== undefined ? { fromHandle: options.fromHandle } : {}),
    });
    let workerState = dispatch.workerState;
    let terminalHandle = dispatch.terminalHandle;
    let dispatchStatus = dispatch.dispatchStatus;
    if (dispatch.dispatchId && (workerState === undefined || terminalHandle === undefined)) {
      try {
        const shown = await orca.showWorker(dispatch.dispatchId);
        workerState = workerState ?? shown.workerState;
        terminalHandle = terminalHandle ?? shown.terminalHandle;
        dispatchStatus = dispatchStatus ?? shown.dispatchStatus;
      } catch {
        // dispatch-show already proved the task exists; worker detail is best-effort.
      }
    }
    let taskStatus: string | undefined;
    try {
      const listed = await orca.listTasks({
        ...(options.runId !== undefined ? { runId: options.runId } : {}),
        ...(options.fromHandle !== undefined ? { fromHandle: options.fromHandle } : {}),
      });
      taskStatus = listed.entries.find((entry) => entry.taskId === dispatch.taskId)?.status;
    } catch (error) {
      if (!isRunRequired(error)) throw error;
      // No Run bound: Dispatch identity still answers; task status stays unknown.
    }
    const status = summarizeWorkerStatus({
      ...(dispatch.dispatchId !== undefined ? { dispatchId: dispatch.dispatchId } : {}),
      taskId: dispatch.taskId,
      ...(taskStatus !== undefined ? { taskStatus } : {}),
      ...(dispatchStatus !== undefined ? { dispatchStatus } : {}),
      ...(workerState !== undefined ? { workerState } : {}),
      ...(terminalHandle !== undefined ? { terminalHandle } : {}),
    });
    return Object.freeze({
      kind: "task" as const,
      status: Object.freeze({ ...status, raw: dispatch.raw }),
    });
  }
  // Bare status: worker sweep (no Run required) plus best-effort task sweep.
  const listed = await orca.listWorkers({
    ...(options.runId !== undefined ? { runId: options.runId } : {}),
  });
  const workers: CompactWorkerStatus[] = listed.entries.map((entry) =>
    summarizeWorkerStatus({
      ...(entry.dispatchId !== undefined ? { dispatchId: entry.dispatchId } : {}),
      ...(entry.taskId !== undefined ? { taskId: entry.taskId } : {}),
      ...(entry.dispatchStatus !== undefined ? { dispatchStatus: entry.dispatchStatus } : {}),
      ...(entry.workerState !== undefined ? { workerState: entry.workerState } : {}),
      ...(entry.terminalHandle !== undefined ? { terminalHandle: entry.terminalHandle } : {}),
    }),
  );
  let tasks: { taskId: string; status?: string; specTruncated?: string }[] | undefined;
  try {
    const taskList = await orca.listTasks({
      ...(options.runId !== undefined ? { runId: options.runId } : {}),
      ...(options.fromHandle !== undefined ? { fromHandle: options.fromHandle } : {}),
    });
    tasks = taskList.entries.map((entry) => ({
      taskId: entry.taskId,
      ...(entry.status !== undefined ? { status: entry.status } : {}),
      ...(entry.specTruncated !== undefined ? { specTruncated: entry.specTruncated } : {}),
    }));
  } catch (error) {
    if (!isRunRequired(error)) throw error;
    // No Run bound: worker accounting still answers bare status; tasks are unavailable.
    tasks = undefined;
  }
  return Object.freeze({
    kind: "list" as const,
    workers: Object.freeze(workers),
    ...(tasks !== undefined ? { tasks: Object.freeze(tasks) } : {}),
  });
}

export interface SendOperationOptions {
  readonly orca: OrcaCli;
  readonly worker: string;
  readonly message: string;
  readonly subject?: string;
  readonly type?: string;
  readonly runId?: string;
  readonly fromHandle?: string;
  readonly projectRoot?: string;
  readonly mappingFs?: MappingFs;
}

/** Compact `send`: coordinator follow-up mail to one worker (never `worker_done`). */
export async function sendCompactMessage(
  options: SendOperationOptions,
): Promise<CompactSendReceipt> {
  const message = options.message.trim();
  if (message.length === 0) {
    throw new CompactOrchestrationError({
      code: "invalid-message",
      message: `Invalid --message "": expected non-empty follow-up text.`,
      diagnostics: "send: empty message.",
    });
  }
  const subject =
    options.subject !== undefined && options.subject.trim().length > 0
      ? options.subject.trim()
      : "Coordinator message";
  const resolved = await resolveWorkerToDispatch(options.orca, options.worker, {
    ...(options.projectRoot !== undefined ? { projectRoot: options.projectRoot } : {}),
    ...(options.mappingFs !== undefined ? { mappingFs: options.mappingFs } : {}),
  });
  const sent = await options.orca.sendToDispatch({
    dispatchId: resolved.dispatchId,
    subject,
    body: message,
    ...(options.type !== undefined ? { type: options.type } : {}),
    ...(options.runId !== undefined ? { runId: options.runId } : {}),
    ...(options.fromHandle !== undefined ? { fromHandle: options.fromHandle } : {}),
  });
  return Object.freeze({
    dispatchId: resolved.dispatchId,
    ...(resolved.taskId !== undefined ? { taskId: resolved.taskId } : {}),
    subject,
    delivered: true,
    raw: sent.raw,
  });
}

export interface WaitOperationOptions {
  readonly orca: OrcaCli;
  readonly worker?: string;
  readonly taskId?: string;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly runId?: string;
  readonly fromHandle?: string;
  readonly projectRoot?: string;
  readonly mappingFs?: MappingFs;
  readonly signal?: AbortSignal;
  /** Injectable clock (tests). Defaults to real timers. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const reason = signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? "aborted");
    throw new CompactOrchestrationError({
      code: "cancelled",
      message: `Wait cancelled: ${reason}`,
      diagnostics: `wait: aborted (${reason}).`,
      cause: signal.reason,
    });
  }
}

async function readStatusForWait(
  orca: OrcaCli,
  target: { dispatchId?: string; taskId?: string },
  options: Pick<WaitOperationOptions, "runId" | "fromHandle">,
): Promise<{
  taskStatus?: string;
  dispatchStatus?: string;
  workerState?: string;
  terminalHandle?: string;
}> {
  let taskStatus: string | undefined;
  let dispatchStatus: string | undefined;
  let workerState: string | undefined;
  let terminalHandle: string | undefined;
  if (target.dispatchId) {
    try {
      const shown = await orca.showWorker(target.dispatchId);
      workerState = shown.workerState;
      dispatchStatus = shown.dispatchStatus;
      terminalHandle = shown.terminalHandle;
      const taskId = shown.taskId ?? target.taskId;
      if (taskId) {
        // Authoritative Task status comes from task-list in the current contract.
        try {
          const listed = await orca.listTasks({
            ...(options.runId !== undefined ? { runId: options.runId } : {}),
            ...(options.fromHandle !== undefined ? { fromHandle: options.fromHandle } : {}),
          });
          taskStatus = listed.entries.find((entry) => entry.taskId === taskId)?.status;
        } catch (error) {
          if (!isRunRequired(error)) throw error;
        }
      }
    } catch (error) {
      // A disappearing dispatch during wait is not success — surface it so the
      // coordinator inspects instead of assuming completion.
      throw new CompactOrchestrationError({
        code: "wait-read-failed",
        message: `Wait failed while reading worker "${target.dispatchId}": ${asMessage(error)}`,
        diagnostics: `wait: worker-show failed (${asMessage(error)}).`,
        ...(target.dispatchId !== undefined ? { dispatchId: target.dispatchId } : {}),
        ...(target.taskId !== undefined ? { taskId: target.taskId } : {}),
        cause: error,
      });
    }
  } else if (target.taskId) {
    const dispatch = await orca.showDispatch(target.taskId, {
      ...(options.fromHandle !== undefined ? { fromHandle: options.fromHandle } : {}),
    });
    dispatchStatus = dispatch.dispatchStatus;
    workerState = dispatch.workerState;
    terminalHandle = dispatch.terminalHandle;
    if (dispatch.dispatchId && workerState === undefined) {
      try {
        const shown = await orca.showWorker(dispatch.dispatchId);
        workerState = workerState ?? shown.workerState;
        terminalHandle = terminalHandle ?? shown.terminalHandle;
        dispatchStatus = dispatchStatus ?? shown.dispatchStatus;
      } catch {
        // dispatch-show already answered; worker detail is best-effort.
      }
    }
    // Authoritative Task status always comes from task-list.
    try {
      const listed = await orca.listTasks({
        ...(options.runId !== undefined ? { runId: options.runId } : {}),
        ...(options.fromHandle !== undefined ? { fromHandle: options.fromHandle } : {}),
      });
      taskStatus = listed.entries.find((entry) => entry.taskId === target.taskId)?.status;
    } catch (error) {
      if (!isRunRequired(error)) throw error;
    }
  }
  return {
    ...(taskStatus !== undefined ? { taskStatus } : {}),
    ...(dispatchStatus !== undefined ? { dispatchStatus } : {}),
    ...(workerState !== undefined ? { workerState } : {}),
    ...(terminalHandle !== undefined ? { terminalHandle } : {}),
  };
}

/**
 * Compact `wait`: bounded Orca-state polling with backoff, timeout, and
 * interruption. Never reads terminal output; Orca Task/Dispatch state is
 * authoritative. Returns `completed` only when the Task reports `completed`;
 * `failed` covers `failed`/`blocked` tasks and settled worker states without
 * task success.
 */
export async function waitCompact(options: WaitOperationOptions): Promise<CompactWaitReceipt> {
  if (options.worker !== undefined && options.taskId !== undefined) {
    throw new CompactOrchestrationError({
      code: "mutually-exclusive",
      message: `Invalid wait flags: --worker and --task are mutually exclusive; pass exactly one.`,
      diagnostics: "wait: --worker/--task are mutually exclusive.",
    });
  }
  if (options.worker === undefined && options.taskId === undefined) {
    throw new CompactOrchestrationError({
      code: "missing-target",
      message: `Invalid wait flags: pass --worker <dispatch|terminal-handle> or --task <task-id>.`,
      diagnostics: "wait: no target.",
    });
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new CompactOrchestrationError({
      code: "invalid-timeout",
      message: `Invalid --timeout: expected a positive duration (e.g. 30s, 5m, 1h).`,
      diagnostics: `wait: invalid timeoutMs (${String(timeoutMs)}).`,
    });
  }
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const deadline = startedAt + timeoutMs;

  let target: { dispatchId?: string; taskId?: string };
  if (options.worker !== undefined) {
    const resolved = await resolveWorkerToDispatch(options.orca, options.worker, {
      ...(options.projectRoot !== undefined ? { projectRoot: options.projectRoot } : {}),
      ...(options.mappingFs !== undefined ? { mappingFs: options.mappingFs } : {}),
    });
    target = {
      dispatchId: resolved.dispatchId,
      ...(resolved.taskId !== undefined ? { taskId: resolved.taskId } : {}),
    };
  } else {
    const taskId = (options.taskId as string).trim();
    if (taskId.length === 0) {
      throw new CompactOrchestrationError({
        code: "invalid-task",
        message: `Invalid --task "": expected an Orca task id.`,
        diagnostics: "wait: empty task id.",
      });
    }
    // Resolve the task's dispatch once so later polls can use both states.
    try {
      const dispatch = await options.orca.showDispatch(taskId, {
        ...(options.fromHandle !== undefined ? { fromHandle: options.fromHandle } : {}),
      });
      target = {
        taskId: dispatch.taskId,
        ...(dispatch.dispatchId !== undefined ? { dispatchId: dispatch.dispatchId } : {}),
      };
    } catch (error) {
      throw new CompactOrchestrationError({
        code: "unknown-task",
        message: `Unknown task "${taskId}": ${asMessage(error)}`,
        diagnostics: `wait: dispatch-show failed (${asMessage(error)}).`,
        taskId,
        cause: error,
      });
    }
  }

  let interval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  for (;;) {
    throwIfAborted(options.signal);
    const state = await readStatusForWait(options.orca, target, {
      ...(options.runId !== undefined ? { runId: options.runId } : {}),
      ...(options.fromHandle !== undefined ? { fromHandle: options.fromHandle } : {}),
    });
    const settledByTask = state.taskStatus !== undefined && isSettledTaskStatus(state.taskStatus);
    const settledByWorker =
      state.taskStatus === undefined &&
      state.workerState !== undefined &&
      isSettledWorkerState(state.workerState);
    if (settledByTask || settledByWorker) {
      // Precedence: authoritative Task status wins when present; otherwise
      // map the settled worker lifecycle state (Orca maps accepted
      // worker_done outcome=succeeded to worker state succeeded).
      const succeeded =
        state.taskStatus !== undefined
          ? isSuccessfulTaskStatus(state.taskStatus)
          : state.workerState !== undefined
            ? state.workerState.toLowerCase() === "succeeded"
            : false;
      const outcome = succeeded ? ("completed" as const) : ("failed" as const);
      const elapsedMs = now() - startedAt;
      const summary =
        state.taskStatus !== undefined
          ? `task ${target.taskId ?? target.dispatchId} ${state.taskStatus} after ${Math.round(elapsedMs / 1000)}s`
          : `worker ${target.dispatchId} ${state.workerState ?? "settled"} after ${Math.round(elapsedMs / 1000)}s`;
      return Object.freeze({
        outcome,
        ...(target.dispatchId !== undefined ? { dispatchId: target.dispatchId } : {}),
        ...(target.taskId !== undefined ? { taskId: target.taskId } : {}),
        ...(state.taskStatus !== undefined ? { taskStatus: state.taskStatus } : {}),
        ...(state.dispatchStatus !== undefined ? { dispatchStatus: state.dispatchStatus } : {}),
        ...(state.workerState !== undefined ? { workerState: state.workerState } : {}),
        elapsedMs,
        timedOut: false,
        summary,
      });
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      const elapsedMs = now() - startedAt;
      return Object.freeze({
        outcome: "timeout" as const,
        ...(target.dispatchId !== undefined ? { dispatchId: target.dispatchId } : {}),
        ...(target.taskId !== undefined ? { taskId: target.taskId } : {}),
        ...(state.taskStatus !== undefined ? { taskStatus: state.taskStatus } : {}),
        ...(state.dispatchStatus !== undefined ? { dispatchStatus: state.dispatchStatus } : {}),
        ...(state.workerState !== undefined ? { workerState: state.workerState } : {}),
        elapsedMs,
        timedOut: true,
        summary: `timed out after ${Math.round(elapsedMs / 1000)}s waiting for ${target.taskId ?? target.dispatchId} (task ${state.taskStatus ?? "unknown"}, worker ${state.workerState ?? "unknown"}) — worker may still be running; wait again or inspect with status.`,
      });
    }
    const delay = Math.min(interval, remaining, MAX_POLL_INTERVAL_MS);
    await sleep(delay);
    interval = Math.min(interval * 1.5, MAX_POLL_INTERVAL_MS);
  }
}

export interface StopOperationOptions {
  readonly orca: OrcaCli;
  readonly worker: string;
  readonly projectRoot?: string;
  readonly mappingFs?: MappingFs;
  readonly fromHandle?: string;
}

/**
 * Compact `stop`: idempotent terminal fence (`worker-stop`). Distinguishes
 * the terminal stop from Task completion/failure — the returned `taskStatus`
 * is observed, never set. A second stop succeeds with `alreadyStopped`.
 */
export async function stopCompact(options: StopOperationOptions): Promise<CompactStopReceipt> {
  const resolved = await resolveWorkerToDispatch(options.orca, options.worker, {
    ...(options.projectRoot !== undefined ? { projectRoot: options.projectRoot } : {}),
    ...(options.mappingFs !== undefined ? { mappingFs: options.mappingFs } : {}),
  });
  const stopped = await options.orca.stopWorker(resolved.dispatchId);
  // Observed via task-list (authoritative); dispatch-show carries no Task status.
  let taskStatus: string | undefined;
  const taskId = resolved.taskId;
  if (taskId) {
    try {
      const listed = await options.orca.listTasks({
        ...(options.fromHandle !== undefined ? { fromHandle: options.fromHandle } : {}),
      });
      taskStatus = listed.entries.find((entry) => entry.taskId === taskId)?.status;
    } catch {
      // Task detail is best-effort after a successful fence.
    }
  }
  const summary = stopped.alreadyStopped
    ? `worker ${resolved.dispatchId} already stopped (idempotent; task ${taskStatus ?? "status unknown"} unchanged)`
    : `stopped worker ${resolved.dispatchId} (terminal fenced; task ${taskStatus ?? "status unknown"} unchanged — Orca owns completion)`;
  return Object.freeze({
    dispatchId: resolved.dispatchId,
    stopped: true,
    alreadyStopped: stopped.alreadyStopped,
    ...(taskStatus !== undefined ? { taskStatus } : {}),
    summary,
    raw: stopped.raw,
  });
}

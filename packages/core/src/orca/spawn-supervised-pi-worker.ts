/**
 * Supervised Pi worker adapter (OP1.4 / JEF-8).
 *
 * Takes a resolved Pi profile (OP1.2) plus the deterministic OP1.3 launcher
 * and turns them into a real Orca-supervised worker attached to a
 * Task/Dispatch, using only public Orca CLI contracts (`--json`). A
 * role-configured Pi process then behaves like a normal Orca worker: correct
 * Run/Task, worktree, injected task/preamble, Task/Dispatch lineage, and
 * normal worker completion semantics.
 *
 * Required flow:
 * 1. Resolve target Run/coordinator context.
 * 2. Create/select an Orca Task if the caller supplied only a task spec.
 * 3. Choose worktree policy explicitly (`current` default; new
 *    child/top-level only when requested).
 * 4. Build the Pi launch (OP1.3) against the *selected* worker checkout, so
 *    `spec.cwd` and absolute skill/extension/prompt paths target the
 *    checkout Pi actually starts in.
 * 5. Create an Orca terminal running that Pi command.
 * 6. Wait for terminal/TUI readiness.
 * 7. Attach the existing terminal as a supervised worker with
 *    `orca orchestration worker-start --terminal` (required dispatch id +
 *    ready state).
 * 8. Return a structured receipt (task/dispatch/terminal/worktree/profile).
 *
 * The assigned task is never passed as initial Pi argv text. Orca supervised
 * attachment remains authoritative because it provides task/dispatch IDs and
 * lifecycle instructions. `dispatch --inject` is deliberately unsupervised
 * (no `worker_dispatches` row) and is never used here.
 *
 * Failure/rollback:
 * - Task creation failure: no terminal is created.
 * - Worktree or launch-build failure: no terminal is created.
 * - Terminal creation failure: the Task remains unattached.
 * - Readiness timeout: the new terminal is stopped/cleaned when safe; the
 *   Task is never faked complete.
 * - Worker-start failure (including missing dispatch id / non-ready state):
 *   the unattached terminal is stopped unless explicit preserve/debug mode
 *   is set.
 * - The adapter never marks a Task completed locally; Orca worker lifecycle
 *   owns completion.
 */

import {
  buildPiLaunch,
  type BuildPiLaunchOptions,
  type PiLaunchResult,
} from "../pi/build-pi-launch.js";
import type { ResolvedPiProfile } from "../profile/types.js";
import {
  DEFAULT_READINESS_TIMEOUT_MS,
  formatPiCommandForTerminal,
  summarizePiSpecForDiagnostics,
  type OrcaCli,
} from "./orca-cli.js";
import {
  freezeSupervisedWorkerReceipt,
  SupervisedWorkerError,
  type SupervisedWorkerReceipt,
  type SupervisedWorkerStage,
  type WorktreePolicy,
} from "./receipts.js";

/** Caller supplies either an existing Task id or an inline task spec. */
export type SpawnTaskSelection =
  | { readonly taskId: string }
  | {
      readonly spec: string;
      readonly taskTitle?: string;
      readonly parentTaskId?: string;
      readonly deps?: readonly string[];
    };

/**
 * OP1.3 launch hooks minus the worktree roots. `projectRoot`/`cwd` are
 * always the selected worker checkout path — callers never supply them, so
 * a prebuilt launch can never target a different checkout than the one Pi
 * starts in.
 */
export type SpawnLaunchOptions = Omit<BuildPiLaunchOptions, "projectRoot" | "cwd">;

/** Options for {@link spawnSupervisedPiWorker}. */
export interface SpawnSupervisedPiWorkerOptions {
  /** Injectable Orca boundary (fake in tests, process-backed in prod). */
  readonly orca: OrcaCli;
  /** Resolved Pi profile (OP1.2). The launch is rebuilt per worker checkout. */
  readonly profile: ResolvedPiProfile;
  /**
   * OP1.3 launch hooks (prompt-file reader, collision-probe fs, tmpdir,
   * env). Never includes `projectRoot`/`cwd`: those are always the selected
   * worker checkout path.
   */
  readonly launchOptions?: SpawnLaunchOptions;
  /** Existing Task id or inline spec to create. */
  readonly task: SpawnTaskSelection;
  /**
   * Worktree choice. Defaults to `{ kind: "current" }`. New child/top-level
   * worktrees are only created when explicitly requested.
   */
  readonly worktree?: WorktreePolicy;
  /** Explicit Run id. When omitted, the coordinator binding is resolved. */
  readonly runId?: string;
  /** Coordinator terminal handle (`--from` passthrough) when known. */
  readonly fromHandle?: string;
  /** Terminal tab title. Defaults to `pi:<profileName>`. */
  readonly terminalTitle?: string;
  /** TUI-readiness wait budget (ms). Defaults to 60s. */
  readonly readinessTimeoutMs?: number;
  /**
   * Preserve/debug mode: skip terminal cleanup on readiness/worker-start
   * failure so the pane stays inspectable. Defaults to `false` (clean up).
   */
  readonly preserveTerminalOnFailure?: boolean;
  /** Cooperative cancellation. Checked before each stage; cleanup stays idempotent. */
  readonly signal?: AbortSignal;
}

function isTaskIdSelection(
  task: SpawnTaskSelection,
): task is { readonly taskId: string } {
  return "taskId" in task;
}

function throwIfAborted(
  signal: AbortSignal | undefined,
  context: { taskId?: string; terminalHandle?: string; worktreeId?: string },
): void {
  if (signal?.aborted) {
    throw new SupervisedWorkerError({
      stage: "cancelled",
      code: "cancelled",
      message: `Supervised Pi worker launch cancelled${context.taskId ? ` (task ${context.taskId})` : ""}.`,
      diagnostics: `cancelled before further Orca effects${context.terminalHandle ? `; terminal ${context.terminalHandle} cleanup applies` : ""}.`,
      ...(context.taskId !== undefined ? { taskId: context.taskId } : {}),
      ...(context.terminalHandle !== undefined
        ? { terminalHandle: context.terminalHandle }
        : {}),
      cleanup: {
        terminalClosed: false,
        createdNewWorktree: context.worktreeId !== undefined,
        ...(context.worktreeId !== undefined ? { worktreeId: context.worktreeId } : {}),
      },
      cause: signal.reason,
    });
  }
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function wrapStageError(options: {
  stage: SupervisedWorkerStage;
  code: string;
  stageLabel: string;
  error: unknown;
  taskId?: string;
  terminalHandle?: string;
  dispatchId?: string;
  terminalClosed?: boolean;
  createdNewWorktree?: boolean;
  worktreeId?: string;
  hint: string;
}): SupervisedWorkerError {
  const detail = asErrorMessage(options.error);
  return new SupervisedWorkerError({
    stage: options.stage,
    code: options.code,
    message: `${options.stageLabel} failed${options.taskId ? ` (task ${options.taskId})` : ""}: ${detail} ${options.hint}`,
    diagnostics: `${options.stage}: ${detail}`,
    ...(options.taskId !== undefined ? { taskId: options.taskId } : {}),
    ...(options.terminalHandle !== undefined
      ? { terminalHandle: options.terminalHandle }
      : {}),
    ...(options.dispatchId !== undefined ? { dispatchId: options.dispatchId } : {}),
    cleanup: {
      terminalClosed: options.terminalClosed ?? false,
      createdNewWorktree: options.createdNewWorktree ?? false,
      ...(options.worktreeId !== undefined ? { worktreeId: options.worktreeId } : {}),
    },
    cause: options.error,
  });
}

/**
 * Launch a supervised Pi worker: resolve Run, ensure Task, honor the
 * worktree policy, rebuild the OP1.3 launch against the selected checkout,
 * start a Pi terminal, wait for readiness, and attach it with
 * `worker-start --terminal`.
 */
export async function spawnSupervisedPiWorker(
  options: SpawnSupervisedPiWorkerOptions,
): Promise<SupervisedWorkerReceipt> {
  const {
    orca,
    profile,
    launchOptions,
    task,
    runId: explicitRunId,
    fromHandle,
    terminalTitle,
    readinessTimeoutMs = DEFAULT_READINESS_TIMEOUT_MS,
    preserveTerminalOnFailure = false,
    signal,
  } = options;
  const worktreePolicy: WorktreePolicy = options.worktree ?? { kind: "current" };

  if (!profile.name || profile.name.length === 0) {
    throw new SupervisedWorkerError({
      stage: "launch-build",
      code: "invalid-input",
      message: `Invalid profile: name must be non-empty.`,
      diagnostics: "launch-build: profile.name is empty.",
      cleanup: { terminalClosed: false, createdNewWorktree: false },
    });
  }
  if (isTaskIdSelection(task)) {
    if (task.taskId.trim().length === 0) {
      throw new SupervisedWorkerError({
        stage: "task-create",
        code: "invalid-input",
        message: `Invalid task selection: taskId must be non-empty.`,
        diagnostics: "task-create: taskId is empty.",
        cleanup: { terminalClosed: false, createdNewWorktree: false },
      });
    }
  } else if (task.spec.trim().length === 0) {
    throw new SupervisedWorkerError({
      stage: "task-create",
      code: "invalid-input",
      message: `Invalid task selection: spec must be non-empty.`,
      diagnostics: "task-create: spec is empty.",
      cleanup: { terminalClosed: false, createdNewWorktree: false },
    });
  }
  if (worktreePolicy.kind === "existing" && worktreePolicy.selector.trim().length === 0) {
    throw new SupervisedWorkerError({
      stage: "worktree-resolve",
      code: "invalid-input",
      message: `Invalid worktree policy: existing selector must be non-empty.`,
      diagnostics: "worktree-resolve: selector is empty.",
      cleanup: { terminalClosed: false, createdNewWorktree: false },
    });
  }
  if (
    (worktreePolicy.kind === "new-child" || worktreePolicy.kind === "new-top-level") &&
    worktreePolicy.name.trim().length === 0
  ) {
    throw new SupervisedWorkerError({
      stage: "worktree-create",
      code: "invalid-input",
      message: `Invalid worktree policy: new-worktree name must be non-empty.`,
      diagnostics: "worktree-create: name is empty.",
      cleanup: { terminalClosed: false, createdNewWorktree: false },
    });
  }

  throwIfAborted(signal, {});

  // 1. Resolve target Run/coordinator context (no auto-create: Orca owns Runs).
  let runId = explicitRunId;
  if (runId === undefined) {
    try {
      runId =
        (await orca.resolveRunId(
          fromHandle !== undefined ? { fromHandle } : undefined,
        )) ?? undefined;
    } catch (error) {
      throw wrapStageError({
        stage: "run-resolve",
        code: "run-resolve-failed",
        stageLabel: "Run resolution",
        error,
        hint: "Check that the Orca CLI is available and the coordinator terminal is bound to a Run.",
        createdNewWorktree: false,
      });
    }
  }
  throwIfAborted(signal, {});

  // 2. Create/select the Orca Task. A task-create failure creates no terminal.
  let taskId: string;
  if (isTaskIdSelection(task)) {
    taskId = task.taskId;
  } else {
    try {
      const receipt = await orca.createTask({
        spec: task.spec,
        ...(task.taskTitle !== undefined ? { taskTitle: task.taskTitle } : {}),
        ...(task.parentTaskId !== undefined ? { parentTaskId: task.parentTaskId } : {}),
        ...(task.deps !== undefined ? { deps: task.deps } : {}),
        ...(runId !== undefined ? { runId } : {}),
        ...(fromHandle !== undefined ? { fromHandle } : {}),
      });
      taskId = receipt.taskId;
    } catch (error) {
      throw wrapStageError({
        stage: "task-create",
        code: "task-create-failed",
        stageLabel: "Task creation",
        error,
        hint: "No terminal was created; fix the task spec/Run and retry.",
        createdNewWorktree: false,
      });
    }
  }
  throwIfAborted(signal, { taskId });

  // 3. Choose worktree explicitly. The checkout path is required: step 4
  // rebuilds the OP1.3 launch against it so cwd and absolute resource paths
  // target the checkout Pi actually starts in.
  let worktreeSelector: string;
  let worktreeId: string;
  let worktreePath: string;
  let worktreeDisplayName: string | undefined;
  let createdNewWorktree = false;
  try {
    if (worktreePolicy.kind === "current") {
      worktreeSelector = "active";
      const identity = await orca.resolveWorktree("active");
      if (identity.path === undefined) {
        throw new Error(
          `Orca worktree ${identity.id} reported no checkout path; cannot build the Pi launch for it.`,
        );
      }
      worktreeId = identity.id;
      worktreePath = identity.path;
      worktreeDisplayName = identity.displayName;
    } else if (worktreePolicy.kind === "existing") {
      worktreeSelector = worktreePolicy.selector;
      const identity = await orca.resolveWorktree(worktreePolicy.selector);
      if (identity.path === undefined) {
        throw new Error(
          `Orca worktree ${identity.id} reported no checkout path; cannot build the Pi launch for it.`,
        );
      }
      worktreeId = identity.id;
      worktreePath = identity.path;
      worktreeDisplayName = identity.displayName;
    } else {
      const created = await orca.createWorktree({
        name: worktreePolicy.name,
        parent: worktreePolicy.kind === "new-child" ? "child" : "top-level",
        ...(worktreePolicy.kind === "new-child"
          ? { parentWorktree: worktreePolicy.parentWorktree ?? "active" }
          : {}),
        ...(worktreePolicy.baseBranch !== undefined
          ? { baseBranch: worktreePolicy.baseBranch }
          : {}),
        ...(worktreePolicy.setup !== undefined ? { setup: worktreePolicy.setup } : {}),
      });
      if (created.path === undefined) {
        throw new Error(
          `Orca worktree ${created.id} reported no checkout path; cannot build the Pi launch for it.`,
        );
      }
      createdNewWorktree = true;
      worktreeId = created.id;
      worktreePath = created.path;
      worktreeDisplayName = created.displayName;
      worktreeSelector = `id:${created.id}`;
    }
  } catch (error) {
    if (error instanceof SupervisedWorkerError) throw error;
    const isCreate = worktreePolicy.kind === "new-child" || worktreePolicy.kind === "new-top-level";
    throw wrapStageError({
      stage: isCreate ? "worktree-create" : "worktree-resolve",
      code: isCreate ? "worktree-create-failed" : "worktree-resolve-failed",
      stageLabel: isCreate ? "Worktree creation" : "Worktree resolution",
      error,
      taskId,
      hint: isCreate
        ? "The Task remains unattached; the new worktree may or may not exist — inspect `orca worktree list` before retrying."
        : "The Task remains unattached; verify the worktree selector and retry.",
      createdNewWorktree: false,
    });
  }
  throwIfAborted(signal, { taskId, worktreeId });

  // 4. Build the Pi launch against the selected worker checkout. A prebuilt
  // launch cannot be used: OP1.3 bakes `spec.cwd` and absolute
  // skill/extension/prompt paths at build time, and a new worktree's path is
  // unknown until Orca creates it.
  let launch: PiLaunchResult;
  try {
    launch = await buildPiLaunch(profile, {
      ...(launchOptions ?? {}),
      projectRoot: worktreePath,
      cwd: worktreePath,
    });
  } catch (error) {
    throw wrapStageError({
      stage: "launch-build",
      code: "launch-build-failed",
      stageLabel: "Pi launch build",
      error,
      taskId,
      hint: "No terminal was created; fix the profile/prompt files and retry.",
      createdNewWorktree,
      worktreeId,
    });
  }
  if (Object.keys(launch.spec.env).length > 0) {
    throw new SupervisedWorkerError({
      stage: "launch-build",
      code: "launch-env-unsupported",
      message:
        `Pi launch for profile "${profile.name}" carries a non-empty env overlay ` +
        `(${Object.keys(launch.spec.env).join(", ")}), which terminal command ` +
        `serialization does not preserve yet. Remove env from launchOptions until ` +
        `env preservation is implemented.`,
      diagnostics: `launch-build: non-empty env (${Object.keys(launch.spec.env).length} keys) would be silently dropped.`,
      taskId,
      cleanup: { terminalClosed: false, createdNewWorktree, worktreeId },
    });
  }
  throwIfAborted(signal, { taskId, worktreeId });

  // 5. Create the Orca terminal running Pi. Task text is never embedded:
  // the command carries only the rebuilt OP1.3 Pi argv; supervised
  // attachment delivers the task + preamble authoritatively.
  const terminalCommand = formatPiCommandForTerminal(launch.spec);
  const launchSummary = summarizePiSpecForDiagnostics(launch.spec);
  let terminalHandle: string;
  try {
    const terminal = await orca.createTerminal({
      worktreeSelector,
      command: terminalCommand,
      title: terminalTitle ?? `pi:${profile.name}`,
    });
    terminalHandle = terminal.handle;
  } catch (error) {
    throw wrapStageError({
      stage: "terminal-create",
      code: "terminal-create-failed",
      stageLabel: `Terminal creation (${launchSummary})`,
      error,
      taskId,
      hint: "The Task remains unattached; no worker was started.",
      createdNewWorktree,
      worktreeId,
    });
  }

  // Idempotent closer: double-cleanup (abort + failure path, or repeated
  // teardown) closes at most once and tolerates stale handles.
  let terminalClosed = false;
  async function closeOnce(): Promise<void> {
    if (terminalClosed) return;
    await orca.closeTerminal(terminalHandle);
    terminalClosed = true;
  }

  try {
    throwIfAborted(signal, { taskId, terminalHandle, worktreeId });
  } catch (error) {
    if (error instanceof SupervisedWorkerError && error.stage === "cancelled") {
      await closeOnce().catch(() => undefined);
      throw new SupervisedWorkerError({
        stage: "cancelled",
        code: "cancelled",
        message: error.message,
        diagnostics: error.diagnostics,
        ...({ taskId } as { taskId: string }),
        terminalHandle,
        cleanup: {
          terminalClosed,
          createdNewWorktree,
          worktreeId,
        },
        cause: error.cause,
      });
    }
    throw error;
  }

  // 6. Wait for terminal/TUI readiness.
  try {
    await orca.waitForTerminal(terminalHandle, { timeoutMs: readinessTimeoutMs });
  } catch (error) {
    let cleaned = false;
    if (!preserveTerminalOnFailure) {
      try {
        await closeOnce();
        cleaned = terminalClosed;
      } catch {
        cleaned = false;
      }
    }
    throw wrapStageError({
      stage: "terminal-readiness",
      code: "readiness-timeout",
      stageLabel: `Terminal readiness (${launchSummary})`,
      error,
      taskId,
      terminalHandle,
      terminalClosed: cleaned,
      createdNewWorktree,
      worktreeId,
      hint: preserveTerminalOnFailure
        ? "The terminal was preserved for debugging (preserveTerminalOnFailure); the Task remains unattached."
        : "The new terminal was stopped/cleaned when safe; the Task remains unattached and was never faked complete.",
    });
  }

  try {
    throwIfAborted(signal, { taskId, terminalHandle, worktreeId });
  } catch (error) {
    if (error instanceof SupervisedWorkerError && error.stage === "cancelled") {
      await closeOnce().catch(() => undefined);
      throw new SupervisedWorkerError({
        stage: "cancelled",
        code: "cancelled",
        message: error.message,
        diagnostics: error.diagnostics,
        ...( { taskId } as { taskId: string }),
        terminalHandle,
        cleanup: {
          terminalClosed,
          createdNewWorktree,
          worktreeId,
        },
        cause: error.cause,
      });
    }
    throw error;
  }

  // 7. Attach the existing terminal as a supervised worker. A missing
  // dispatch id or non-ready state is a failure, never a receipt:
  // `dispatch --inject` would leave the worker unsupervised.
  let dispatchId: string;
  try {
    const attached = await orca.attachWorker({
      taskId,
      terminalHandle,
      worktreeSelector,
      ...(runId !== undefined ? { runId } : {}),
      ...(fromHandle !== undefined ? { fromHandle } : {}),
    });
    dispatchId = attached.dispatchId;
  } catch (error) {
    let cleaned = false;
    if (!preserveTerminalOnFailure) {
      try {
        await closeOnce();
        cleaned = terminalClosed;
      } catch {
        cleaned = false;
      }
    }
    throw wrapStageError({
      stage: "worker-start",
      code: "worker-start-failed",
      stageLabel: "Worker attach (worker-start --terminal)",
      error,
      taskId,
      terminalHandle,
      terminalClosed: cleaned,
      createdNewWorktree,
      worktreeId,
      hint: preserveTerminalOnFailure
        ? "The terminal was preserved for debugging (preserveTerminalOnFailure); stop it with `orca terminal close` when done."
        : "The unattached terminal was stopped unless preserve/debug mode was requested; the Task remains unattached.",
    });
  }

  // 8. Structured receipt — Task/Dispatch/terminal/worktree/profile identity.
  return freezeSupervisedWorkerReceipt({
    taskId,
    dispatchId,
    terminalHandle,
    worktree: Object.freeze({
      id: worktreeId,
      ...(worktreeDisplayName !== undefined ? { displayName: worktreeDisplayName } : {}),
      path: worktreePath,
      selector: worktreeSelector,
      createdNew: createdNewWorktree,
    }),
    profileName: profile.name,
    ...(profile.model !== undefined ? { piModel: profile.model } : {}),
    piCommand: launch.spec.command,
    piArgs: Object.freeze([...launch.spec.args]) as readonly string[],
    piCwd: launch.spec.cwd,
    promptSource: launch.promptSource,
    promptTransport: launch.promptTransport,
    ...(runId !== undefined ? { runId } : {}),
  });
}

/**
 * Structured receipts for the Orca supervised Pi worker adapter (OP1.4 / JEF-8).
 *
 * The adapter never introduces a duplicate orchestration database: Orca owns
 * Runs/Tasks/Dispatches, and these types only carry the identities Orca
 * returns over the public CLI (`--json`). All receipts are frozen before
 * they leave the adapter so callers cannot mutate provenance.
 */

/** How the worker's Orca worktree is chosen. Explicit by design. */
export type WorktreePolicy =
  | { readonly kind: "current" }
  | { readonly kind: "existing"; readonly selector: string }
  | {
      readonly kind: "new-child";
      readonly name: string;
      readonly baseBranch?: string;
      readonly setup?: WorktreeSetupPolicy;
      /**
       * Explicit parent selector for `--parent-worktree` (default
       * `"active"`). Always passed explicitly so lineage never depends on
       * the helper process happening to run in the coordinator worktree;
       * pass an exact `id:<repo>::<path>` selector when the coordinator
       * checkout differs from the helper's ambient worktree.
       */
      readonly parentWorktree?: string;
    }
  | {
      readonly kind: "new-top-level";
      readonly name: string;
      readonly baseBranch?: string;
      readonly setup?: WorktreeSetupPolicy;
    };

/** Mirrors `orca worktree create --setup run|skip|inherit`. */
export type WorktreeSetupPolicy = "run" | "skip" | "inherit";

/** Orca Task identity returned by `task-create --json`. */
export interface TaskReceipt {
  readonly taskId: string;
  readonly runId?: string;
}

/** Orca terminal identity returned by `terminal create --json`. */
export interface TerminalReceipt {
  readonly handle: string;
}

/** Orca worktree identity for receipts. */
export interface WorktreeIdentity {
  /** Full Orca worktree id (`<repoId>::<path>`) when known. */
  readonly id: string;
  /** Absolute checkout path when known. */
  readonly path?: string;
  /** Display name when known. */
  readonly displayName?: string;
}

/** Worktree creation result (`worktree create --json`). */
export type WorktreeReceipt = WorktreeIdentity;

/**
 * Supervised attach result (`orchestration worker-start --terminal --json`).
 *
 * Unlike `dispatch --inject` (deliberately unsupervised: no
 * `worker_dispatches` row), `worker-start --terminal` creates real worker
 * lifecycle state, so `dispatchId` is always required.
 */
export interface WorkerAttachReceipt {
  readonly taskId: string;
  readonly dispatchId: string;
  readonly terminalHandle: string;
}

/**
 * Structured receipt for one supervised Pi worker launch.
 *
 * Makes Task/Dispatch/terminal/worktree/profile identity explicit without
 * duplicating Orca's orchestration database. `piArgs` carries the effective
 * Pi argv (flag names + values) but never the assigned task text — Orca
 * supervised attachment (`worker-start --terminal`) remains the
 * authoritative task/lifecycle channel.
 */
export interface SupervisedWorkerReceipt {
  readonly taskId: string;
  /** Supervised dispatch id from `worker-start --terminal` (always present). */
  readonly dispatchId: string;
  readonly terminalHandle: string;
  readonly worktree: WorktreeIdentity & {
    /** Selector that was used to target the worktree (`active`, `id:...`, ...). */
    readonly selector: string;
    /** True when this launch created a new child/top-level worktree. */
    readonly createdNew: boolean;
  };
  readonly profileName: string;
  /** Resolved Pi `--model` value when the profile sets one. */
  readonly piModel?: string;
  readonly piCommand: string;
  readonly piArgs: readonly string[];
  readonly piCwd: string;
  readonly promptSource?: "inline" | "file" | "none";
  readonly promptTransport?: "literal" | "temp-file" | "none";
  readonly runId?: string;
}

/** Failure stage for {@link SupervisedWorkerError}. */
export type SupervisedWorkerStage =
  | "run-resolve"
  | "task-create"
  | "worktree-create"
  | "worktree-resolve"
  | "launch-build"
  | "terminal-create"
  | "terminal-readiness"
  | "worker-start"
  | "cancelled";

/**
 * Typed launch failure. Never marks the Orca Task completed locally — Orca
 * worker lifecycle owns completion. `diagnostics` is redacted (no full
 * prompts, no secrets) and truncated for log safety.
 */
export class SupervisedWorkerError extends Error {
  readonly stage: SupervisedWorkerStage;
  readonly code: string;
  readonly taskId?: string;
  readonly terminalHandle?: string;
  readonly dispatchId?: string;
  readonly diagnostics: string;
  readonly cleanup: {
    readonly terminalClosed: boolean;
    readonly createdNewWorktree: boolean;
    readonly worktreeId?: string;
  };

  constructor(options: {
    stage: SupervisedWorkerStage;
    code: string;
    message: string;
    diagnostics?: string;
    taskId?: string;
    terminalHandle?: string;
    dispatchId?: string;
    cleanup?: {
      terminalClosed?: boolean;
      createdNewWorktree?: boolean;
      worktreeId?: string;
    };
    cause?: unknown;
  }) {
    super(options.message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "SupervisedWorkerError";
    this.stage = options.stage;
    this.code = options.code;
    this.taskId = options.taskId;
    this.terminalHandle = options.terminalHandle;
    this.dispatchId = options.dispatchId;
    this.diagnostics = options.diagnostics ?? "";
    this.cleanup = Object.freeze({
      terminalClosed: options.cleanup?.terminalClosed ?? false,
      createdNewWorktree: options.cleanup?.createdNewWorktree ?? false,
      ...(options.cleanup?.worktreeId !== undefined
        ? { worktreeId: options.cleanup.worktreeId }
        : {}),
    });
  }
}

/** Freeze a receipt (and its nested worktree/piArgs) for provenance safety. */
export function freezeSupervisedWorkerReceipt(
  receipt: SupervisedWorkerReceipt,
): SupervisedWorkerReceipt {
  if (!Object.isFrozen(receipt.piArgs)) Object.freeze(receipt.piArgs);
  if (!Object.isFrozen(receipt.worktree)) Object.freeze(receipt.worktree);
  return Object.freeze(receipt);
}

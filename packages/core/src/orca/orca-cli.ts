/**
 * Injectable Orca CLI boundary for supervised Pi workers (OP1.4 / JEF-8).
 *
 * The spawn orchestrator (`spawn-supervised-pi-worker.ts`) depends only on
 * this interface, so unit tests inject a fake without spawning `orca`. The
 * `ProcessRunner`-backed implementation lives in `orca-cli-process.ts` and
 * is the only place that builds raw `orca ... --json` argv.
 *
 * Public-contract rule: only `orca` CLI commands with `--json` are used.
 * No duplicate orchestration database is introduced — Orca owns Runs, Tasks,
 * and Dispatches; this layer only carries their identities.
 */

import type { PiProcessSpec } from "../pi/process-spec.js";
import type {
  DispatchReceipt,
  SupervisedWorkerStage,
  TaskReceipt,
  TerminalReceipt,
  WorktreeIdentity,
  WorktreePolicy,
  WorktreeReceipt,
  WorktreeSetupPolicy,
} from "./receipts.js";

export type {
  WorktreePolicy,
  WorktreeSetupPolicy,
  TaskReceipt,
  TerminalReceipt,
  WorktreeIdentity,
  WorktreeReceipt,
  DispatchReceipt,
};

/** Input for `orchestration task-create --spec ... --json`. */
export interface TaskCreateInput {
  readonly spec: string;
  readonly taskTitle?: string;
  readonly parentTaskId?: string;
  readonly deps?: readonly string[];
  readonly runId?: string;
  readonly fromHandle?: string;
}

/** Input for `worktree create --json`. */
export interface WorktreeCreateInput {
  readonly name: string;
  /** `child` inherits caller lineage; `top-level` passes `--no-parent`. */
  readonly parent: "child" | "top-level";
  readonly baseBranch?: string;
  readonly setup?: WorktreeSetupPolicy;
}

/** Input for `terminal create --worktree ... --command ... --json`. */
export interface TerminalCreateInput {
  /** Orca worktree selector (`active`, `id:<repo>::<path>`, `name:...`, ...). */
  readonly worktreeSelector: string;
  /** Shell command text running Pi (built from the Pi launch spec). */
  readonly command: string;
  readonly title?: string;
}

/** Input for `orchestration dispatch --task ... --to ... --inject --json`. */
export interface DispatchInput {
  readonly taskId: string;
  readonly terminalHandle: string;
  readonly runId?: string;
  readonly fromHandle?: string;
}

/** Injectable Orca surface used by the spawn orchestrator. */
export interface OrcaCli {
  /**
   * Resolve the Run bound to the coordinator context (`run-current`).
   * Returns `undefined` when no Run is bound — the caller then dispatches
   * without an explicit `--run` and lets Orca apply its default.
   */
  resolveRunId(options?: { fromHandle?: string }): Promise<string | undefined>;
  createTask(input: TaskCreateInput): Promise<TaskReceipt>;
  createWorktree(input: WorktreeCreateInput): Promise<WorktreeReceipt>;
  resolveWorktree(selector: string): Promise<WorktreeIdentity>;
  createTerminal(input: TerminalCreateInput): Promise<TerminalReceipt>;
  /** Wait for TUI readiness (`terminal wait --for tui-idle`). */
  waitForTerminal(handle: string, options?: { timeoutMs?: number }): Promise<void>;
  /** Dispatch with `--inject` so Orca sends task + preamble authoritatively. */
  dispatch(input: DispatchInput): Promise<DispatchReceipt>;
  /**
   * Close one terminal pane (`terminal close`). Must be idempotent:
   * closing an already-closed/stale handle succeeds.
   */
  closeTerminal(handle: string): Promise<void>;
}

/** Default TUI-readiness wait when the caller does not specify one. */
export const DEFAULT_READINESS_TIMEOUT_MS = 60_000;

/**
 * Map a typed {@link WorktreePolicy} to the terminal worktree selector for
 * the `current`/`existing` cases. New-worktree policies have no selector
 * until `createWorktree` returns an id — use
 * {@link worktreeSelectorForNewWorktree} afterwards.
 */
export function terminalSelectorForPolicy(
  policy: WorktreePolicy,
): string | undefined {
  switch (policy.kind) {
    case "current":
      return "active";
    case "existing":
      return policy.selector;
    case "new-child":
    case "new-top-level":
      return undefined;
  }
}

/** Build the post-creation terminal selector (`id:<worktreeId>`). */
export function worktreeSelectorForNewWorktree(worktreeId: string): string {
  return `id:${worktreeId}`;
}

/**
 * Quote one argv token for POSIX shells (Orca terminal `bash`).
 * Single-quote style preserves every byte literally except `'` itself.
 */
export function quoteForTerminalShell(token: string): string {
  if (token.length === 0) return `''`;
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(token)) return token;
  return `'${token.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Serialize a structured Pi launch spec into `terminal create --command`
 * text. Execution-only — the display formatter (`format-inspect.ts`) must
 * never be used to execute.
 *
 * The assigned Orca task is never embedded here: Orca `dispatch --inject`
 * owns task/preamble delivery so lifecycle IDs stay authoritative.
 */
export function formatPiCommandForTerminal(spec: PiProcessSpec): string {
  return [spec.command, ...spec.args].map(quoteForTerminalShell).join(" ");
}

/**
 * Redacted one-line summary of a Pi spec for error diagnostics.
 * Flag names are preserved; `--system-prompt` values are replaced with a
 * length so full prompts never reach logs.
 */
export function summarizePiSpecForDiagnostics(spec: PiProcessSpec): string {
  const parts: string[] = [spec.command];
  for (let i = 0; i < spec.args.length; i++) {
    const token = spec.args[i] as string;
    if (token === "--system-prompt") {
      const value = spec.args[i + 1] as string | undefined;
      const length = value?.length ?? 0;
      parts.push("--system-prompt", `(<${length} chars redacted>)`);
      i++;
      continue;
    }
    parts.push(token.length > 120 ? `${token.slice(0, 117)}...` : token);
  }
  return `${parts.join(" ")} (cwd=${spec.cwd})`;
}

/** Narrow an unknown throw into a stage + message for spawn error wrapping. */
export function describeOrcaFailure(
  stage: SupervisedWorkerStage,
  error: unknown,
): { message: string; diagnostics: string } {
  const message = error instanceof Error ? error.message : String(error);
  const diagnostics =
    error instanceof Error && error.name === "OrcaCommandError"
      ? String((error as { diagnostics?: unknown }).diagnostics ?? message)
      : message;
  return { message, diagnostics };
}

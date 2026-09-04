/**
 * `ProcessRunner`-backed {@link OrcaCli} (OP1.4 / JEF-8).
 *
 * The only module that builds raw `orca ... --json` argv. Everything else
 * depends on the `OrcaCli` interface so tests never spawn processes. Raw
 * JSON parsing is delegated to `json-parsers.ts`; this file only maps
 * transport failures (missing executable, non-zero exit, `ok:false`) into
 * {@link OrcaCommandError} with redacted, truncated diagnostics.
 */

import { isNotFoundError, type ProcessRunner } from "../runner.js";
import {
  parseRunCurrentJson,
  parseTaskCreateJson,
  parseTerminalCreateJson,
  parseWorkerStartJson,
  parseWorktreeCreateJson,
  parseWorktreeShowJson,
  OrcaJsonParseError,
} from "./json-parsers.js";
import type {
  OrcaCli,
  TaskCreateInput,
  TerminalCreateInput,
  WorkerAttachInput,
  WorktreeCreateInput,
} from "./orca-cli.js";
import type {
  TaskReceipt,
  TerminalReceipt,
  WorkerAttachReceipt,
  WorktreeIdentity,
  WorktreeReceipt,
} from "./receipts.js";

/** Max stdout/stderr characters kept in command-error diagnostics. */
export const ORCA_DIAGNOSTIC_LIMIT = 1_000;

/** One `orca ... --json` invocation failed in a typed, diagnosable way. */
export class OrcaCommandError extends Error {
  readonly code: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly exitCode?: number;
  readonly diagnostics: string;
  /** True when `orca` is not on PATH (ENOENT / cmd "not recognized"). */
  readonly isMissingExecutable: boolean;
  /** True when the installed CLI does not understand the command/flag. */
  readonly isCompatibility: boolean;

  constructor(options: {
    code: string;
    message: string;
    executable: string;
    args: readonly string[];
    exitCode?: number;
    diagnostics?: string;
    isMissingExecutable?: boolean;
    isCompatibility?: boolean;
    cause?: unknown;
  }) {
    super(
      options.message,
      options.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = "OrcaCommandError";
    this.code = options.code;
    this.executable = options.executable;
    this.args = options.args;
    if (options.exitCode !== undefined) this.exitCode = options.exitCode;
    this.diagnostics = options.diagnostics ?? "";
    this.isMissingExecutable = options.isMissingExecutable ?? false;
    this.isCompatibility = options.isCompatibility ?? false;
  }
}

function truncate(text: string, limit: number = ORCA_DIAGNOSTIC_LIMIT): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed || "(empty)";
  return `${trimmed.slice(0, limit)}... (+${trimmed.length - limit} more)`;
}

function looksLikeMissingExecutable(output: string): boolean {
  const normalized = output.toLowerCase();
  return (
    normalized.includes("not recognized as an internal or external command") ||
    normalized.includes("was not recognised as an internal or external command") ||
    normalized.includes("command not found")
  );
}

function looksLikeCompatibilityFailure(code: string, message: string): boolean {
  const haystack = `${code} ${message}`.toLowerCase();
  return (
    haystack.includes("unknown command") ||
    haystack.includes("unknown option") ||
    haystack.includes("unknown flag") ||
    haystack.includes("unrecognized") ||
    haystack.includes("unsupported") ||
    haystack.includes("incompatible") ||
    haystack.includes("not supported") ||
    haystack.includes("no such command")
  );
}

function extractOrcaErrorCode(stdout: string): { code?: string; message?: string } {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (parsed && typeof parsed === "object") {
      const error = (parsed as { error?: unknown }).error;
      if (error && typeof error === "object") {
        const code = (error as { code?: unknown }).code;
        const message = (error as { message?: unknown }).message;
        return {
          ...(typeof code === "string" ? { code } : {}),
          ...(typeof message === "string" ? { message } : {}),
        };
      }
    }
  } catch {
    // Not JSON — callers fall back to exit-code diagnostics.
  }
  return {};
}

export interface OrcaCliProcessOptions {
  /** Orca executable name (default `"orca"`). */
  readonly executable?: string;
}

/** Build a `ProcessRunner`-backed {@link OrcaCli}. */
export function createOrcaCliProcess(
  runner: ProcessRunner,
  options?: OrcaCliProcessOptions,
): OrcaCli {
  const executable = options?.executable ?? "orca";

  async function runJson(args: readonly string[], context: string): Promise<string> {
    let result: { stdout: string; stderr: string; exitCode: number };
    try {
      result = await runner.run(executable, args);
    } catch (error) {
      if (isNotFoundError(error)) {
        throw new OrcaCommandError({
          code: "orca-missing",
          message:
            `Orca CLI "${executable}" was not found on PATH (${context}). ` +
            `Install Orca Desktop and ensure the orca CLI is on PATH.`,
          executable,
          args,
          diagnostics: error instanceof Error ? error.message : String(error),
          isMissingExecutable: true,
          cause: error,
        });
      }
      throw new OrcaCommandError({
        code: "orca-spawn-failed",
        message: `${context}: failed to spawn "${executable}" (${error instanceof Error ? error.message : String(error)}).`,
        executable,
        args,
        diagnostics: error instanceof Error ? error.message : String(error),
        cause: error,
      });
    }
    const combined = `${result.stdout}\n${result.stderr}`;
    if (result.exitCode !== 0) {
      if (looksLikeMissingExecutable(combined)) {
        throw new OrcaCommandError({
          code: "orca-missing",
          message:
            `Orca CLI "${executable}" was not found on PATH (${context}). ` +
            `Install Orca Desktop and ensure the orca CLI is on PATH.`,
          executable,
          args,
          exitCode: result.exitCode,
          diagnostics: `exit ${result.exitCode}. stdout: ${truncate(result.stdout)}. stderr: ${truncate(result.stderr)}`,
          isMissingExecutable: true,
        });
      }
      const extracted = extractOrcaErrorCode(result.stdout);
      const code = extracted.code ?? "orca-exit-nonzero";
      const detail = extracted.message ?? truncate(combined);
      throw new OrcaCommandError({
        code,
        message: `${context}: orca exited with code ${result.exitCode} (${code}): ${detail}`,
        executable,
        args,
        exitCode: result.exitCode,
        diagnostics: `exit ${result.exitCode}. stdout: ${truncate(result.stdout)}. stderr: ${truncate(result.stderr)}`,
        isCompatibility: looksLikeCompatibilityFailure(code, detail),
      });
    }
    // Exit 0 but payload may still be `ok:false` (RPC-level failure).
    try {
      const probe: unknown = JSON.parse(result.stdout);
      if (
        probe !== null &&
        typeof probe === "object" &&
        (probe as { ok?: unknown }).ok === false
      ) {
        const error = (probe as { error?: unknown }).error;
        const code =
          error !== null && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
            ? ((error as { code: string }).code)
            : "orca-command-failed";
        const detail =
          error !== null && typeof error === "object" && typeof (error as { message?: unknown }).message === "string"
            ? ((error as { message: string }).message)
            : truncate(combined);
        throw new OrcaCommandError({
          code,
          message: `${context}: orca reported failure (${code}): ${detail}`,
          executable,
          args,
          exitCode: result.exitCode,
          diagnostics: `stdout: ${truncate(result.stdout)}. stderr: ${truncate(result.stderr)}`,
          isCompatibility: looksLikeCompatibilityFailure(code, detail),
        });
      }
    } catch (error) {
      if (error instanceof OrcaCommandError) throw error;
      // Not JSON — leave it to the caller's parser to report malformed JSON.
    }
    return result.stdout;
  }

  function wrapParse<T>(context: string, stdout: string, parse: () => T): T {
    try {
      return parse();
    } catch (error) {
      if (error instanceof OrcaJsonParseError) {
        const looksCompat = looksLikeCompatibilityFailure(error.context, error.message);
        throw new OrcaCommandError({
          code: "orca-malformed-json",
          message: `${context}: ${error.message}`,
          executable,
          args: [],
          diagnostics: error.snippet,
          isCompatibility: looksCompat,
          cause: error,
        });
      }
      throw error;
    }
  }

  return {
    async resolveRunId(options?: { fromHandle?: string }): Promise<string | undefined> {
      const args: string[] = ["orchestration", "run-current", "--json"];
      if (options?.fromHandle !== undefined) {
        args.push("--from", options.fromHandle);
      }
      const stdout = await runJson(args, "run-resolve");
      return wrapParse("run-resolve", stdout, () => parseRunCurrentJson(stdout).runId);
    },

    async createTask(input: TaskCreateInput): Promise<TaskReceipt> {
      const args: string[] = ["orchestration", "task-create", "--spec", input.spec];
      if (input.taskTitle !== undefined) args.push("--task-title", input.taskTitle);
      if (input.parentTaskId !== undefined) args.push("--parent", input.parentTaskId);
      if (input.deps !== undefined && input.deps.length > 0) {
        args.push("--deps", JSON.stringify([...input.deps]));
      }
      if (input.runId !== undefined) args.push("--run", input.runId);
      if (input.fromHandle !== undefined) args.push("--from", input.fromHandle);
      args.push("--json");
      const stdout = await runJson(args, "task-create");
      return wrapParse("task-create", stdout, () => parseTaskCreateJson(stdout));
    },

    async createWorktree(input: WorktreeCreateInput): Promise<WorktreeReceipt> {
      const args: string[] = ["worktree", "create", "--name", input.name];
      if (input.baseBranch !== undefined) args.push("--base-branch", input.baseBranch);
      if (input.setup !== undefined) args.push("--setup", input.setup);
      if (input.parent === "top-level") {
        args.push("--no-parent");
      } else {
        // Child lineage is always explicit via `--parent-worktree` (default
        // `"active"`) so it never depends on ambient CLI-cwd inference.
        // `--base-branch` independently chooses the Git base.
        args.push("--parent-worktree", input.parentWorktree ?? "active");
      }
      args.push("--json");
      const stdout = await runJson(args, "worktree-create");
      return wrapParse("worktree-create", stdout, () => parseWorktreeCreateJson(stdout));
    },

    async resolveWorktree(selector: string): Promise<WorktreeIdentity> {
      if (selector === "active" || selector === "current") {
        const stdout = await runJson(["worktree", "current", "--json"], "worktree-resolve");
        return wrapParse("worktree-resolve", stdout, () => parseWorktreeShowJson(stdout));
      }
      const stdout = await runJson(
        ["worktree", "show", "--worktree", selector, "--json"],
        "worktree-resolve",
      );
      return wrapParse("worktree-resolve", stdout, () => parseWorktreeShowJson(stdout));
    },

    async createTerminal(input: TerminalCreateInput): Promise<TerminalReceipt> {
      const args: string[] = [
        "terminal",
        "create",
        "--worktree",
        input.worktreeSelector,
        "--command",
        input.command,
      ];
      if (input.title !== undefined) args.push("--title", input.title);
      args.push("--json");
      const stdout = await runJson(args, "terminal-create");
      return wrapParse("terminal-create", stdout, () => parseTerminalCreateJson(stdout));
    },

    async waitForTerminal(handle: string, options?: { timeoutMs?: number }): Promise<void> {
      const args: string[] = [
        "terminal",
        "wait",
        "--terminal",
        handle,
        "--for",
        "tui-idle",
        "--timeout-ms",
        String(options?.timeoutMs ?? 60_000),
        "--json",
      ];
      await runJson(args, "terminal-readiness");
    },

    async attachWorker(input: WorkerAttachInput): Promise<WorkerAttachReceipt> {
      // Supervised attach: `worker-start --terminal` creates real worker
      // lifecycle state. Never `--inject` (deliberately unsupervised) and
      // never `--agent`/`--model`/`--effort` (rejected with `--terminal`).
      const args: string[] = [
        "orchestration",
        "worker-start",
        "--task",
        input.taskId,
        "--terminal",
        input.terminalHandle,
      ];
      if (input.worktreeSelector !== undefined) {
        args.push("--worktree", input.worktreeSelector);
      }
      if (input.runId !== undefined) args.push("--run", input.runId);
      if (input.fromHandle !== undefined) args.push("--from", input.fromHandle);
      args.push("--json");
      const stdout = await runJson(args, "worker-start");
      return wrapParse("worker-start", stdout, () =>
        parseWorkerStartJson(stdout, {
          taskId: input.taskId,
          terminalHandle: input.terminalHandle,
        }),
      );
    },

    async closeTerminal(handle: string): Promise<void> {
      try {
        await runJson(["terminal", "close", "--terminal", handle, "--json"], "terminal-close");
      } catch (error) {
        // Idempotent cleanup: a stale/missing handle means the terminal is
        // already gone, which is the desired end state.
        if (error instanceof OrcaCommandError) {
          const probe = `${error.code} ${error.message}`.toLowerCase();
          if (
            probe.includes("stale") ||
            probe.includes("not_found") ||
            probe.includes("notfound") ||
            probe.includes("no such terminal") ||
            probe.includes("terminal_not_found") ||
            probe.includes("terminal_handle_stale")
          ) {
            return;
          }
        }
        throw error;
      }
    },
  };
}

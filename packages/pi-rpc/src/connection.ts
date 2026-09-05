/**
 * Production Pi RPC connection and process transport (SNC1.2).
 *
 * Typed, Orca-independent transport for `pi --mode rpc` proven in SNC1.1.
 * Strict LF-only JSONL framing, correlated requests, async events, bounded
 * deadlines, accepted/rejected/ambiguous semantics, bounded/redacted stderr
 * diagnostics, graceful/forced close, and full listener/process cleanup.
 *
 * Transport rules (from `docs/pi-rpc-contract.md`):
 * - Write `JSON.stringify(cmd) + "\n"` (never CRLF); read by splitting
 *   stdout on `\n` only (never `readline` — it splits on U+2028/U+2029).
 * - `prompt` success means accepted/queued/handled, not completed.
 *   Completion is `agent_end` + `agent_settled` — use `waitForSettled()`.
 * - `abort` responses may arrive *after* `agent_settled`; correlation is by
 *   `id`, never by arrival order.
 * - `bash_execution_update.id` correlates the originating `bash` command;
 *   `tool_*` frames correlate by `toolCallId`; `partialResult` replaces.
 * - Unknown fire-and-forget UI requests must be ignored forward-compatibly.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { JsonlFramer, serializeJsonLine } from "./jsonl.js";
import {
  boundTail,
  PiRpcError,
  STDERR_TAIL_MAX_CHARS,
  redactLinePreview,
  redactStderrTail,
  rejectedError,
} from "./errors.js";
import {
  isExtensionUiRequest,
  isPiResponse,
  type PiBashResult,
  type PiClearQueueData,
  type PiCommand,
  type PiCommandInfo,
  type PiEntriesData,
  type PiExtensionUiRequest,
  type PiExtensionUiResponse,
  type PiForkMessage,
  type PiForkResult,
  type PiImageAttachment,
  type PiMessagesData,
  type PiModel,
  type PiQueueMode,
  type PiResponse,
  type PiServerEvent,
  type PiSessionStats,
  type PiSessionSwitchResult,
  type PiState,
  type PiStreamingBehavior,
  type PiTreeData,
} from "./protocol.js";

export type PiRpcSpawnFn = (
  command: string,
  args: string[],
  options: { stdio: string[]; cwd?: string; env?: NodeJS.ProcessEnv },
) => ChildProcess;

export interface PiRpcConnectionOptions {
  /** Pi executable (default `"pi"`). */
  readonly piCommand?: string;
  /**
   * Extra argv before `--mode rpc` (provider/model/thinking/session …).
   *
   * Prefer passing an already-resolved spec from core's `buildPiLaunch()`
   * (the single profile compiler) through `toPiRpcProcessSpec()` rather
   * than hand-building argv here, so JEF-7 prompt collision/path semantics
   * are preserved. `--mode rpc` is appended idempotently when missing.
   * See `launch.ts` for the single-compiler rule.
   */
  readonly piArgs?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Default per-request deadline (default 30s). */
  readonly defaultTimeoutMs?: number;
  /** Spawn/startup classification window (default 15s outer, 50ms grace). */
  readonly startupTimeoutMs?: number;
  /**
   * Verify RPC readiness during `start()` with a bounded internal
   * `get_state` round-trip (default true). When false, `start()` resolves
   * after OS spawn classification only (unit-test framing mode; not for
   * production use — early Pi failures would surface as `process-exited`
   * instead of `startup-failed`).
   */
  readonly startupProbe?: boolean;
  /** Deadline for the internal startup probe (default min(5s, remainder)). */
  readonly startupProbeTimeoutMs?: number;
  /** Stderr ring-buffer bound in chars (default 16_384). */
  readonly stderrMaxBytes?: number;
  readonly spawnFn?: PiRpcSpawnFn;
  /** Id factory (tests inject determinism; default `r1`, `r2`, …). */
  readonly generateId?: () => string;
}

export interface PiRpcRequestOptions {
  /** Override the default deadline for this request. */
  readonly timeoutMs?: number;
}

export interface PiRpcCloseResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** True when SIGTERM/SIGKILL was required (grace expired). */
  readonly forced: boolean;
}

export type PiRpcEventHandler<T = unknown> = (payload: T) => void;

interface PendingEntry {
  readonly command: string;
  readonly resolve: (response: PiResponse) => void;
  readonly reject: (error: PiRpcError) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_STARTUP_PROBE_TIMEOUT_MS = 5_000;
const STARTUP_GRACE_MS = 50;
const DEFAULT_STDERR_MAX = 16_384;
const CLOSE_TERM_GRACE_MS = 2_000;

function defaultIdFactory(): () => string {
  let n = 0;
  return () => `r${++n}`;
}

function commandNameOf(cmd: Record<string, unknown>): string {
  return typeof cmd["type"] === "string" ? (cmd["type"] as string) : "<unknown>";
}

/**
 * Typed production connection. Lifecycle: `new` → `start()` →
 * `request()` / wrappers / `waitForSettled()` → `close()`.
 *
 * All stdout records are framed strict LF-only via `JsonlFramer`; stderr is
 * captured as a bounded, redacted tail; every request has a bounded
 * deadline; close is graceful (stdin EOF) then forced (SIGTERM → SIGKILL)
 * with full listener/process cleanup.
 */
export class PiRpcConnection {
  private proc: ChildProcess | null = null;
  private readonly framer = new JsonlFramer();
  private stderrRaw = "";
  private readonly pending = new Map<string, PendingEntry>();
  private readonly eventHandlers = new Set<PiRpcEventHandler<PiServerEvent>>();
  private readonly responseHandlers = new Set<PiRpcEventHandler<PiResponse>>();
  private readonly extensionUiHandlers = new Set<PiRpcEventHandler<PiExtensionUiRequest>>();
  private readonly malformedHandlers = new Set<
    PiRpcEventHandler<{ linePreview: string; count: number }>
  >();
  private readonly exitHandlers = new Set<PiRpcEventHandler<PiRpcCloseResult>>();
  private readonly settledWaiters: Array<{
    resolve: () => void;
    reject: (error: PiRpcError) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private readonly generateId: () => string;
  private readonly defaultTimeoutMs: number;
  private readonly startupTimeoutMs: number;
  private readonly startupProbe: boolean;
  private readonly startupProbeTimeoutMs: number | undefined;
  private readonly stderrMaxBytes: number;
  private started = false;
  private closed = false;
  private closing = false;
  /** True while the OS-spawn phase of start() owns child exit/error. */
  private startingPhase1 = false;
  private exitInfo: PiRpcCloseResult | null = null;
  private malformedCount = 0;
  private unmatchedCount = 0;
  private readonly detachFns: Array<() => void> = [];

  constructor(private readonly options: PiRpcConnectionOptions = {}) {
    this.generateId = options.generateId ?? defaultIdFactory();
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.startupProbe = options.startupProbe ?? true;
    this.startupProbeTimeoutMs = options.startupProbeTimeoutMs;
    this.stderrMaxBytes = options.stderrMaxBytes ?? DEFAULT_STDERR_MAX;
  }

  get isStarted(): boolean {
    return this.started && !this.closed;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get malformedLineCount(): number {
    return this.malformedCount;
  }

  get unmatchedResponseCount(): number {
    return this.unmatchedCount;
  }

  /** Bounded, redacted stderr tail (safe for logs/diagnostics). */
  get stderrTail(): string {
    return redactStderrTail(this.stderrRaw.slice(-this.stderrMaxBytes), STDERR_TAIL_MAX_CHARS);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Spawn `pi --mode rpc` and attach strict LF-only framing.
   *
   * Classifies startup failures: spawn errors (ENOENT/EACCES → helpful
   * `spawn-failed`), early non-zero exits (`startup-failed` with stderr
   * tail), and outer timeouts (`startup-timeout`). Readiness is gated on a
   * real RPC round-trip (bounded internal `get_state` probe) unless
   * `startupProbe: false`: in Node, `spawn` only means the OS process was
   * created, so a Pi invocation with invalid args/config can emit `spawn`
   * and then exit non-zero on the next turn. Without the probe, `start()`
   * would resolve on `spawn` and the early exit would surface only as a
   * steady-state `process-exited`. Never leaks the child on failure (kills
   * + detaches before throwing).
   */
  async start(): Promise<void> {
    if (this.closed) {
      throw new PiRpcError(
        { code: "already-closed", ambiguous: false },
        "PiRpcConnection is closed and cannot be restarted; construct a new instance",
      );
    }
    if (this.proc) {
      throw new PiRpcError(
        { code: "already-started", ambiguous: false },
        "PiRpcConnection already started",
      );
    }
    const command = this.options.piCommand ?? "pi";
    // Idempotent `--mode rpc`: callers pass `toPiRpcProcessSpec()` args
    // (which already end with `--mode rpc`) or raw extra args (which the
    // connection completes). Never emit the flag twice.
    const extra = [...(this.options.piArgs ?? [])];
    const hasMode = extra.some((a, i) => a === "--mode" && extra[i + 1] === "rpc");
    const args = hasMode ? extra : [...extra, "--mode", "rpc"];
    const spawnFn = this.options.spawnFn ?? spawn;
    let proc: ChildProcess;
    try {
      proc = spawnFn(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        ...(this.options.cwd !== undefined ? { cwd: this.options.cwd } : {}),
        ...(this.options.env !== undefined ? { env: this.options.env } : {}),
      });
    } catch (error) {
      throw new PiRpcError(
        { code: "spawn-failed", ambiguous: false, stderrTail: this.stderrTail },
        `failed to spawn ${command}: ${(error as Error).message}`,
      );
    }
    this.proc = proc;
    this.attach(proc);
    const startWall = Date.now();

    // Phase 1 — OS spawn classification: resolve on `spawn`, reject on
    // `error`/early `exit`, assume success after a short grace (covers
    // fake processes in tests that emit neither), bound by the outer
    // startup timeout. Phase 1 alone cannot prove Pi is speaking RPC
    // (spawn fires before invalid args/config fail), so phase 2 probes.
    // Steady-state exit/error handlers defer to this phase while
    // `startingPhase1` is set; stdio errors still finalize immediately and
    // are reclassified below via the post-phase-1 closed check.
    type OnceCapable = { once(event: string, listener: (...args: never[]) => void): unknown; off?(event: string, listener: (...args: never[]) => void): unknown; removeListener?(event: string, listener: (...args: never[]) => void): unknown };
    const procOnce = proc as unknown as OnceCapable;
    let onSpawn: (...args: never[]) => void = () => undefined;
    let onPhaseError: (...args: never[]) => void = () => undefined;
    let onEarlyExit: (...args: never[]) => void = () => undefined;
    this.startingPhase1 = true;
    try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(grace);
        clearTimeout(outer);
        fn();
      };
      onSpawn = (): void => done(resolve);
      onPhaseError = (error: unknown): void =>
        done(() => {
          this.detachAndKill();
          const msg = (error as NodeJS.ErrnoException).code === "ENOENT"
            ? `failed to spawn ${command}: not found on PATH (${(error as Error).message})`
            : `failed to spawn ${command}: ${(error as Error).message}`;
          reject(new PiRpcError({ code: "spawn-failed", ambiguous: false }, msg));
        });
      onEarlyExit = (code: unknown, signal: unknown): void =>
        done(() => {
          this.detachAndKill();
          reject(
            new PiRpcError(
              {
                code: "startup-failed",
                ambiguous: false,
                exitCode: code as number | null,
                signal: signal as string | null,
                stderrTail: this.stderrTail,
              },
              `pi exited during startup (code=${String(code)} signal=${String(signal)})` +
                (this.stderrTail ? `: ${this.stderrTail}` : ""),
            ),
          );
        });
      const grace = setTimeout(() => done(resolve), STARTUP_GRACE_MS);
      const outer = setTimeout(
        () =>
          done(() => {
            this.detachAndKill();
            reject(
              new PiRpcError(
                {
                  code: "startup-timeout",
                  ambiguous: false,
                  timeoutMs: this.startupTimeoutMs,
                  stderrTail: this.stderrTail,
                },
                `pi did not start within ${this.startupTimeoutMs}ms`,
              ),
            );
          }),
        this.startupTimeoutMs,
      );
      // `once` keeps startup listeners out of the steady-state set; the
      // persistent exit/error handlers are attached in `attach()`.
      procOnce.once?.("spawn", onSpawn);
      procOnce.once?.("error", onPhaseError);
      procOnce.once?.("exit", onEarlyExit);
      // If the process already failed synchronously (fake `error` emitted
      // before `once` attached), the persistent handler in `attach()` will
      // have recorded it — re-check on the next tick via grace resolution.
    });
    } finally {
      this.startingPhase1 = false;
      // Phase-1 `once` listeners that never fired (e.g. `spawn` on fakes)
      // must not linger into steady state.
      try {
        if (typeof procOnce.off === "function") {
          procOnce.off("spawn", onSpawn);
          procOnce.off("error", onPhaseError);
          procOnce.off("exit", onEarlyExit);
        } else if (typeof procOnce.removeListener === "function") {
          procOnce.removeListener("spawn", onSpawn);
          procOnce.removeListener("error", onPhaseError);
          procOnce.removeListener("exit", onEarlyExit);
        }
      } catch {
        // Cleanup must not throw.
      }
    }
    // A stdio failure during phase 1 finalizes the transport immediately
    // (phase 1 only watches spawn/error/exit); reclassify for startup.
    if (this.closed) {
      throw new PiRpcError(
        {
          code: "startup-failed",
          ambiguous: false,
          exitCode: this.exitInfo?.exitCode,
          signal: this.exitInfo?.signal,
          stderrTail: this.stderrTail,
        },
        `pi transport failed during startup` + (this.stderrTail ? `: ${this.stderrTail}` : ""),
      );
    }

    // Phase 2 — RPC readiness probe (unless explicitly disabled for
    // framing-only unit tests). A bounded internal `get_state` round-trip
    // proves Pi is actually speaking RPC; an exit before/during the probe
    // becomes `startup-failed` and a silent process becomes
    // `startup-timeout`. Any well-formed response (even `success: false`)
    // proves liveness — the bridge re-reads state itself afterwards.
    if (!this.startupProbe) {
      this.started = true;
      return;
    }
    const elapsed = Date.now() - startWall;
    const remaining = this.startupTimeoutMs - elapsed;
    if (remaining <= 0) {
      this.detachAndKill();
      throw new PiRpcError(
        {
          code: "startup-timeout",
          ambiguous: false,
          timeoutMs: this.startupTimeoutMs,
          stderrTail: this.stderrTail,
        },
        `pi did not become ready within ${this.startupTimeoutMs}ms`,
      );
    }
    const probeTimeout = Math.min(
      this.startupProbeTimeoutMs ?? DEFAULT_STARTUP_PROBE_TIMEOUT_MS,
      remaining,
    );
    try {
      await this.requestRaw({ type: "get_state" }, { timeoutMs: probeTimeout });
    } catch (error) {
      if (error instanceof PiRpcError && error.code === "rejected") {
        // Pi answered (with a rejection) → the transport is live.
      } else if (
        error instanceof PiRpcError &&
        (error.code === "process-exited" || error.code === "transport-closed")
      ) {
        // handleExit() already rejected the probe as ambiguous and (for
        // unexpected death) finalized the connection; reclassify for
        // startup callers who never got a ready connection.
        throw new PiRpcError(
          {
            code: "startup-failed",
            ambiguous: false,
            exitCode: error.exitCode,
            signal: error.signal,
            stderrTail: this.stderrTail,
          },
          `pi exited before RPC readiness ` +
            `(code=${String(error.exitCode)} signal=${String(error.signal)})` +
            (this.stderrTail ? `: ${this.stderrTail}` : ""),
        );
      } else if (error instanceof PiRpcError && error.code === "request-timeout") {
        this.detachAndKill();
        throw new PiRpcError(
          {
            code: "startup-timeout",
            ambiguous: false,
            timeoutMs: probeTimeout,
            stderrTail: this.stderrTail,
          },
          `pi did not answer RPC readiness probe within ${probeTimeout}ms`,
        );
      } else if (error instanceof PiRpcError && error.code === "write-failed") {
        this.detachAndKill();
        throw new PiRpcError(
          {
            code: "startup-failed",
            ambiguous: false,
            stderrTail: this.stderrTail,
          },
          `pi transport failed before RPC readiness: ${error.message}`,
        );
      } else {
        this.detachAndKill();
        throw error;
      }
    }

    this.started = true;
  }

  private attach(proc: ChildProcess): void {
    type Eventable = {
      on(event: string, listener: (...args: never[]) => void): unknown;
      off?(event: string, listener: (...args: never[]) => void): unknown;
      removeListener?(event: string, listener: (...args: never[]) => void): unknown;
    };
    const stdin = proc.stdin as unknown as Eventable | null;
    const stdout = proc.stdout as unknown as Eventable | null;
    const stderr = proc.stderr as unknown as Eventable | null;
    const procEvents = proc as unknown as Eventable;

    const off = (
      target: {
        off?: (e: string, l: (...args: never[]) => void) => unknown;
        removeListener?: (e: string, l: (...args: never[]) => void) => unknown;
      } | null,
      event: string,
      listener: (...args: never[]) => void,
    ): void => {
      const t = target as {
        off?: (e: string, l: (...args: never[]) => void) => void;
        removeListener?: (e: string, l: (...args: never[]) => void) => void;
      } | null;
      if (!t) return;
      if (typeof t.off === "function") t.off(event, listener);
      else if (typeof t.removeListener === "function") t.removeListener(event, listener);
    };

    const onStdoutData = (chunk: unknown): void => {
      const lines = this.framer.push(chunk as Buffer);
      for (const line of lines) this.handleLine(line);
    };
    const onStdoutEnd = (): void => {
      for (const line of this.framer.finish()) this.handleLine(line);
    };
    const onStderrData = (chunk: unknown): void => {
      const text = typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
      this.stderrRaw += text;
      if (this.stderrRaw.length > this.stderrMaxBytes * 2) {
        this.stderrRaw = this.stderrRaw.slice(-this.stderrMaxBytes);
      }
    };
    // Async stream failures (e.g. EPIPE after Pi closes stdin) surface via
    // `error` events, never as synchronous `write()` throws. Without these
    // listeners they become uncaught exceptions; with them they become
    // secret-safe ambiguous transport failures (see
    // `terminateOnTransportError`). Guards inside ignore teardown races.
    const onStdinError = (error: unknown): void => {
      this.terminateOnTransportError("stdin", error);
    };
    const onStdoutError = (error: unknown): void => {
      this.terminateOnTransportError("stdout", error);
    };
    const onStderrError = (error: unknown): void => {
      this.terminateOnTransportError("stderr", error);
    };
    const onChildError = (error: unknown): void => {
      // Phase-1 startup owns child errors via its `once` listener (which
      // classifies them as `spawn-failed`); steady state must not double
      // handle. Node documents that `exit` may or may not follow `error`,
      // so steady state treats it as terminal without waiting for `exit`.
      if (this.startingPhase1) return;
      this.terminateOnTransportError("child", error);
    };
    const onExit = (code: number | null, signal: string | null): void => {
      this.handleExit(code, signal);
    };

    stdout?.on("data", onStdoutData as (...args: never[]) => void);
    stdout?.on("end", onStdoutEnd as (...args: never[]) => void);
    stderr?.on("data", onStderrData as (...args: never[]) => void);
    // `?.` capability checks: minimal fake stdins may be write-only
    // `{write, end}` objects without an emitter; sync throws in request
    // paths still classify failures for those.
    try {
      stdin?.on?.("error", onStdinError as (...args: never[]) => void);
    } catch {
      // Ignore.
    }
    try {
      stdout?.on?.("error", onStdoutError as (...args: never[]) => void);
    } catch {
      // Ignore.
    }
    try {
      stderr?.on?.("error", onStderrError as (...args: never[]) => void);
    } catch {
      // Ignore.
    }
    procEvents.on("error", onChildError as (...args: never[]) => void);
    procEvents.on("exit", onExit as (...args: never[]) => void);

    this.detachFns.push(() => off(stdout, "data", onStdoutData as (...args: never[]) => void));
    this.detachFns.push(() => off(stdout, "end", onStdoutEnd as (...args: never[]) => void));
    this.detachFns.push(() => off(stderr, "data", onStderrData as (...args: never[]) => void));
    this.detachFns.push(() => off(stdin, "error", onStdinError as (...args: never[]) => void));
    this.detachFns.push(() => off(stdout, "error", onStdoutError as (...args: never[]) => void));
    this.detachFns.push(() => off(stderr, "error", onStderrError as (...args: never[]) => void));
    this.detachFns.push(() => off(procEvents, "error", onChildError as (...args: never[]) => void));
    this.detachFns.push(() => off(procEvents, "exit", onExit as (...args: never[]) => void));
  }

  /**
   * Terminal transport failure without a process exit (async stdin/stdout/
   * stderr `error`, or a child `error` with no subsequent `exit`). Rejects
   * every in-flight request as ambiguous `transport-closed` (the write may
   * or may not have reached Pi), rejects settle waiters, notifies exit
   * listeners with synthesized facts, and funnels through the same
   * ownership release as unexpected exits — without depending on a later
   * `exit` that Node does not guarantee. Subsequent `exit`, if any, is a
   * no-op via the `closed` guard. Errors carry only the stream name + OS
   * message (never command payloads or prompt contents).
   */
  private terminateOnTransportError(source: "stdin" | "stdout" | "stderr" | "child", error: unknown): void {
    if (this.closed || this.closing) return;
    const osMessage = boundTail(error instanceof Error ? error.message : String(error), 300);
    const tail = this.stderrTail;
    const exitInfo: PiRpcCloseResult = { exitCode: null, signal: null, forced: false };
    this.exitInfo = exitInfo;
    const pendings = [...this.pending.entries()];
    this.pending.clear();
    for (const [id, entry] of pendings) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(
        new PiRpcError(
          {
            code: "transport-closed",
            command: entry.command,
            requestId: id,
            ambiguous: true,
            stderrTail: tail,
          },
          `pi transport ${source} failed before answering ${entry.command} (id=${id}): ${osMessage}` +
            (tail ? `: ${tail}` : ""),
        ),
      );
    }
    const waiters = this.settledWaiters.splice(0);
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.reject(
        new PiRpcError(
          { code: "transport-closed", command: "waitForSettled", ambiguous: false },
          `pi transport ${source} failed before agent_settled: ${osMessage}`,
        ),
      );
    }
    for (const h of [...this.exitHandlers]) {
      try {
        h(exitInfo);
      } catch {
        // Ignore.
      }
    }
    this.closed = true;
    const proc = this.proc;
    this.detachAll();
    // Best-effort kill so a still-alive child cannot leak after its stdio
    // broke; harmless when the process is already gone.
    try {
      proc?.kill("SIGKILL");
    } catch {
      // Already dead.
    }
    try {
      proc?.stdout?.destroy?.();
    } catch {
      // Ignore.
    }
    try {
      proc?.stderr?.destroy?.();
    } catch {
      // Ignore.
    }
    this.proc = null;
    this.removeAllListeners();
  }

  private detachAll(): void {
    const fns = this.detachFns.splice(0);
    for (const fn of fns) {
      try {
        fn();
      } catch {
        // Cleanup must not throw.
      }
    }
  }

  private detachAndKill(signal: NodeJS.Signals = "SIGKILL"): void {
    const proc = this.proc;
    this.detachAll();
    if (proc) {
      try {
        if (proc.exitCode === null && proc.signalCode === undefined) proc.kill(signal);
      } catch {
        // Already dead.
      }
      try {
        proc.stdout?.destroy?.();
      } catch {
        // Ignore.
      }
      try {
        proc.stderr?.destroy?.();
      } catch {
        // Ignore.
      }
    }
    this.proc = null;
  }

  // -------------------------------------------------------------------------
  // Incoming records
  // -------------------------------------------------------------------------

  private handleLine(line: string): void {
    if (line.trim() === "") return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.malformedCount += 1;
      const preview = redactLinePreview(line);
      const count = this.malformedCount;
      for (const h of [...this.malformedHandlers]) {
        try {
          h({ linePreview: preview, count });
        } catch {
          // Listener errors never break framing.
        }
      }
      return;
    }
    if (isPiResponse(value)) {
      this.handleResponse(value);
      return;
    }
    const event = value as PiServerEvent;
    for (const h of [...this.eventHandlers]) {
      try {
        h(event);
      } catch {
        // Listener errors never break framing.
      }
    }
    if (isExtensionUiRequest(event)) {
      for (const h of [...this.extensionUiHandlers]) {
        try {
          h(event);
        } catch {
          // Ignore.
        }
      }
    }
    if ((event as Record<string, unknown>)["type"] === "agent_settled") {
      const waiters = this.settledWaiters.splice(0);
      for (const w of waiters) {
        clearTimeout(w.timer);
        w.resolve();
      }
    }
  }

  private handleResponse(res: PiResponse): void {
    for (const h of [...this.responseHandlers]) {
      try {
        h(res);
      } catch {
        // Ignore.
      }
    }
    if (res.id !== undefined) {
      const entry = this.pending.get(res.id);
      if (!entry) {
        this.unmatchedCount += 1;
        return;
      }
      this.pending.delete(res.id);
      if (entry.timer) clearTimeout(entry.timer);
      entry.resolve(res);
      return;
    }
    // Id-less responses (e.g. `command: "parse"` for malformed input) have
    // no waiter by construction — every `request()` carries an id. Surface
    // them to `onResponse` listeners (done above) and count them.
    this.unmatchedCount += 1;
  }

  private closeWaiter: ((result: PiRpcCloseResult) => void) | null = null;

  private handleExit(code: number | null, signal: string | null): void {
    if (this.closed) return;
    // During close() the exit is expected: record facts and wake the
    // closer, but leave in-flight rejection + user notification to
    // finishClose() so every close-driven rejection is `transport-closed`
    // (ambiguous) and onExit fires exactly once. Only unexpected deaths
    // reject as `process-exited` here.
    if (this.closing) {
      this.exitInfo = { exitCode: code, signal, forced: this.exitInfo?.forced ?? true };
      this.closeWaiter?.(this.exitInfo);
      return;
    }
    // Record exit facts; `forced` is refined by close()/finishClose().
    this.exitInfo = { exitCode: code, signal, forced: this.exitInfo?.forced ?? false };
    const tail = this.stderrTail;
    // Every in-flight request becomes ambiguous: the write succeeded but Pi
    // died before answering, so callers cannot know if it was processed.
    const pendings = [...this.pending.entries()];
    this.pending.clear();
    for (const [id, entry] of pendings) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(
        new PiRpcError(
          {
            code: "process-exited",
            command: entry.command,
            requestId: id,
            ambiguous: true,
            exitCode: code,
            signal,
            stderrTail: tail,
          },
          `pi exited before answering ${entry.command} (id=${id}, ` +
            `code=${String(code)} signal=${String(signal)})` +
            (tail ? `: ${tail}` : ""),
        ),
      );
    }
    const waiters = this.settledWaiters.splice(0);
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.reject(
        new PiRpcError(
          {
            code: "process-exited",
            command: "waitForSettled",
            ambiguous: false,
            exitCode: code,
            signal,
            stderrTail: tail,
          },
          `pi exited before agent_settled (code=${String(code)} signal=${String(signal)})`,
        ),
      );
    }
    // Unexpected death outside close(): funnel through the same
    // finalization as close() (no leaked children/listeners) while keeping
    // the `process-exited` ambiguity semantics established above. Notify
    // user listeners first, then release process ownership + subscriptions
    // so post-mortem assertions observe a fully cleaned-up transport.
    // `close()` afterwards returns the cached exit info immediately.
    for (const h of [...this.exitHandlers]) {
      try {
        h(this.exitInfo);
      } catch {
        // Ignore.
      }
    }
    this.closed = true;
    this.detachAll();
    const proc = this.proc;
    this.proc = null;
    try {
      proc?.stdout?.destroy?.();
    } catch {
      // Ignore.
    }
    try {
      proc?.stderr?.destroy?.();
    } catch {
      // Ignore.
    }
    this.removeAllListeners();
  }

  // -------------------------------------------------------------------------
  // Subscriptions (all return an unsubscribe fn; close() removes everything)
  // -------------------------------------------------------------------------

  /** Subscribe to every async server event (non-response `s2c`). */
  onEvent(handler: PiRpcEventHandler<PiServerEvent>): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  /** Subscribe to every wire response (matched or not). */
  onResponse(handler: PiRpcEventHandler<PiResponse>): () => void {
    this.responseHandlers.add(handler);
    return () => {
      this.responseHandlers.delete(handler);
    };
  }

  /** Subscribe to `extension_ui_request` records only. */
  onExtensionUiRequest(handler: PiRpcEventHandler<PiExtensionUiRequest>): () => void {
    this.extensionUiHandlers.add(handler);
    return () => {
      this.extensionUiHandlers.delete(handler);
    };
  }

  /** Subscribe to malformed stdout lines (framing diagnostics). */
  onMalformedLine(
    handler: PiRpcEventHandler<{ linePreview: string; count: number }>,
  ): () => void {
    this.malformedHandlers.add(handler);
    return () => {
      this.malformedHandlers.delete(handler);
    };
  }

  /** Subscribe to process exit (fires once per connection). */
  onExit(handler: PiRpcEventHandler<PiRpcCloseResult>): () => void {
    this.exitHandlers.add(handler);
    return () => {
      this.exitHandlers.delete(handler);
    };
  }

  /** Remove every subscription (also done by `close()`). */
  removeAllListeners(): void {
    this.eventHandlers.clear();
    this.responseHandlers.clear();
    this.extensionUiHandlers.clear();
    this.malformedHandlers.clear();
    this.exitHandlers.clear();
  }

  // -------------------------------------------------------------------------
  // Requests
  // -------------------------------------------------------------------------

  private ensureWritable(): ChildProcess {
    const proc = this.proc;
    if (this.closed || this.closing) {
      throw new PiRpcError(
        { code: "transport-closed", ambiguous: true, stderrTail: this.stderrTail },
        "Pi RPC transport is closed",
      );
    }
    if (!proc?.stdin) {
      throw new PiRpcError(
        { code: "not-started", ambiguous: false },
        "PiRpcConnection not started; call start() first",
      );
    }
    return proc;
  }

  /**
   * Send a correlated request and resolve with the full wire response.
   *
   * Resolves on `success: true`, throws `rejected` (`ambiguous: false`) on
   * `success: false`, and throws `request-timeout` / `process-exited` /
   * `transport-closed` (`ambiguous: true`) when the outcome is unknown.
   * Responses interleaved with unrelated events correlate by `id`, never by
   * arrival order. Errors carry only the command name + id (never the full
   * payload, prompt text, or image bytes).
   */
  requestRaw(
    command: PiCommand,
    opts: PiRpcRequestOptions = {},
  ): Promise<PiResponse> {
    const proc = this.ensureWritable();
    const name = commandNameOf(command);
    const id = command.id ?? this.freshId();
    const payload = { ...command, id };
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    return new Promise<PiResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(
          new PiRpcError(
            {
              code: "request-timeout",
              command: name,
              requestId: id,
              ambiguous: true,
              timeoutMs,
              stderrTail: this.stderrTail,
            },
            `timed out after ${timeoutMs}ms waiting for ${name} (id=${id}); ` +
              `outcome is ambiguous — re-read state before retrying`,
          ),
        );
      }, timeoutMs);
      // Unref so an idle connection never holds the event loop open.
      (timer as unknown as { unref?: () => void }).unref?.();
      this.pending.set(id, {
        command: name,
        resolve,
        reject,
        timer,
      });
      try {
        proc.stdin!.write(serializeJsonLine(payload));
      } catch (error) {
        const entry = this.pending.get(id);
        if (entry) {
          this.pending.delete(id);
          if (entry.timer) clearTimeout(entry.timer);
        }
        reject(
          new PiRpcError(
            { code: "write-failed", command: name, requestId: id, ambiguous: true },
            `failed to write ${name} (id=${id}): ${(error as Error).message}`,
          ),
        );
      }
    }).then((res) => {
      if (!res.success) {
        throw rejectedError(name, res.id, res.error ?? "unknown error", this.stderrTail);
      }
      return res;
    });
  }

  /**
   * Send a correlated request and resolve with its `data` (or `undefined`
   * when Pi omits it, e.g. `prompt` accept). Rejection semantics match
   * `requestRaw`.
   */
  async request<T = unknown>(command: PiCommand, opts: PiRpcRequestOptions = {}): Promise<T> {
    const res = await this.requestRaw(command, opts);
    return res.data as T;
  }

  private freshId(): string {
    for (;;) {
      const id = this.generateId();
      if (!this.pending.has(id)) return id;
    }
  }

  /** Fire-and-forget write (no response expected, e.g. UI responses). */
  sendNotification(payload: Record<string, unknown>): void {
    const proc = this.ensureWritable();
    try {
      proc.stdin!.write(serializeJsonLine(payload));
    } catch (error) {
      throw new PiRpcError(
        {
          code: "write-failed",
          command: commandNameOf(payload),
          ambiguous: false,
        },
        `failed to write ${commandNameOf(payload)}: ${(error as Error).message}`,
      );
    }
  }

  /** Write raw bytes (malformed-input probes; tests + diagnostics only). */
  sendRaw(text: string): void {
    const proc = this.ensureWritable();
    try {
      proc.stdin!.write(text);
    } catch (error) {
      throw new PiRpcError(
        { code: "write-failed", ambiguous: true },
        `failed to write raw bytes: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Resolve when the next `agent_settled` event arrives. Always waits for a
   * *new* settle after invocation (callers tracking turns should snapshot
   * counts first). Rejects on timeout, exit, or close.
   */
  waitForSettled(timeoutMs?: number): Promise<void> {
    if (this.closed) {
      return Promise.reject(
        new PiRpcError({ code: "transport-closed", ambiguous: false }, "transport is closed"),
      );
    }
    const deadline = timeoutMs ?? this.defaultTimeoutMs;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.settledWaiters.findIndex((w) => w.resolve === resolve);
        if (idx !== -1) this.settledWaiters.splice(idx, 1);
        reject(
          new PiRpcError(
            {
              code: "request-timeout",
              command: "waitForSettled",
              ambiguous: false,
              timeoutMs: deadline,
            },
            `timed out after ${deadline}ms waiting for agent_settled`,
          ),
        );
      }, deadline);
      (timer as unknown as { unref?: () => void }).unref?.();
      this.settledWaiters.push({ resolve, reject, timer });
    });
  }

  // -------------------------------------------------------------------------
  // Typed wrappers for the protocol proven in #11.
  // -------------------------------------------------------------------------

  /**
   * Queue a user turn. Resolves on *accept* (`success: true`), not on
   * completion — await `waitForSettled()` for `agent_end`/`agent_settled`.
   * Throws `rejected` when Pi is already streaming without a
   * `streamingBehavior` (no state changed); throws ambiguous errors on
   * transport failure (re-read state before retrying).
   */
  async prompt(
    message: string,
    opts: { images?: readonly PiImageAttachment[]; streamingBehavior?: PiStreamingBehavior } & PiRpcRequestOptions = {},
  ): Promise<void> {
    const { images, streamingBehavior, timeoutMs } = opts;
    await this.request(
      {
        type: "prompt",
        message,
        ...(images !== undefined ? { images: [...images] } : {}),
        ...(streamingBehavior !== undefined ? { streamingBehavior } : {}),
      },
      timeoutMs !== undefined ? { timeoutMs } : {},
    );
  }

  /** Queue steering input (delivered before the next LLM call). */
  async steer(message: string, opts: PiRpcRequestOptions = {}): Promise<void> {
    await this.request({ type: "steer", message }, opts);
  }

  /** Queue follow-up input (delivered after settle). */
  async followUp(message: string, opts: PiRpcRequestOptions = {}): Promise<void> {
    await this.request({ type: "follow_up", message }, opts);
  }

  /** Drain both queues; resolves with the drained contents. */
  async clearQueue(opts: PiRpcRequestOptions = {}): Promise<PiClearQueueData> {
    return this.request<PiClearQueueData>({ type: "clear_queue" }, opts);
  }

  /**
   * Abort the streaming turn. The response may arrive *after*
   * `agent_settled` (proven in `abort-queue.jsonl`), so awaiting abort and
   * settle **sequentially** (`await abort(); await waitForSettled()`)
   * necessarily waits for the *next* settle and can time out. Register the
   * settle waiter **before** sending abort — or use
   * `abortAndWaitForSettled()`, which does exactly that. Esc-pattern:
   * `clearQueue()` then `abortAndWaitForSettled()`.
   */
  async abort(opts: PiRpcRequestOptions = {}): Promise<void> {
    await this.request({ type: "abort" }, opts);
  }

  /**
   * Abort and wait for the streaming turn to settle without the sequential
   * footgun: the `agent_settled` waiter is registered *before* the `abort`
   * request is sent, so an `agent_settled` that arrives before the `abort`
   * response (the proven order) still resolves. Awaits both the abort
   * response and the next settle concurrently.
   */
  async abortAndWaitForSettled(
    opts: PiRpcRequestOptions & { settleTimeoutMs?: number } = {},
  ): Promise<void> {
    const { settleTimeoutMs, ...abortOpts } = opts;
    const settled = this.waitForSettled(settleTimeoutMs);
    await this.abort(abortOpts);
    await settled;
  }

  async abortBash(opts: PiRpcRequestOptions = {}): Promise<void> {
    await this.request({ type: "abort_bash" }, opts);
  }

  async abortRetry(opts: PiRpcRequestOptions = {}): Promise<void> {
    await this.request({ type: "abort_retry" }, opts);
  }

  /** Direct out-of-band execution (streams `bash_execution_update` by id). */
  async bash(command: string, opts: PiRpcRequestOptions = {}): Promise<PiBashResult> {
    return this.request<PiBashResult>({ type: "bash", command }, opts);
  }

  async getState(opts: PiRpcRequestOptions = {}): Promise<PiState> {
    return this.request<PiState>({ type: "get_state" }, opts);
  }

  /**
   * Journal entries + current leaf. `since` is a durable cursor returning
   * strictly-after entries; unknown cursors reject (`Entry not found`).
   */
  async getEntries(since?: string, opts: PiRpcRequestOptions = {}): Promise<PiEntriesData> {
    return this.request<PiEntriesData>(
      since === undefined ? { type: "get_entries" } : { type: "get_entries", since },
      opts,
    );
  }

  async getTree(opts: PiRpcRequestOptions = {}): Promise<PiTreeData> {
    return this.request<PiTreeData>({ type: "get_tree" }, opts);
  }

  /** Active-branch flattened view (excludes pre-compaction/abandoned). */
  async getMessages(opts: PiRpcRequestOptions = {}): Promise<PiMessagesData> {
    return this.request<PiMessagesData>({ type: "get_messages" }, opts);
  }

  async getForkMessages(opts: PiRpcRequestOptions = {}): Promise<{ messages: PiForkMessage[] }> {
    return this.request<{ messages: PiForkMessage[] }>({ type: "get_fork_messages" }, opts);
  }

  /**
   * Last assistant text. Handles both shapes: `{"text": …}` and `{}` (empty
   * when no assistant response yet) → returns `null` for the latter.
   */
  async getLastAssistantText(opts: PiRpcRequestOptions = {}): Promise<string | null> {
    const data = await this.request<{ text?: unknown }>({ type: "get_last_assistant_text" }, opts);
    return typeof data?.text === "string" ? data.text : null;
  }

  async getSessionStats(opts: PiRpcRequestOptions = {}): Promise<PiSessionStats> {
    return this.request<PiSessionStats>({ type: "get_session_stats" }, opts);
  }

  async getCommands(opts: PiRpcRequestOptions = {}): Promise<{ commands: PiCommandInfo[] }> {
    return this.request<{ commands: PiCommandInfo[] }>({ type: "get_commands" }, opts);
  }

  async getAvailableModels(opts: PiRpcRequestOptions = {}): Promise<{ models: PiModel[] }> {
    return this.request<{ models: PiModel[] }>({ type: "get_available_models" }, opts);
  }

  /** Invalid `provider/modelId` rejects (`Model not found`); no mutation. */
  async setModel(provider: string, modelId: string, opts: PiRpcRequestOptions = {}): Promise<PiModel> {
    return this.request<PiModel>({ type: "set_model", provider, modelId }, opts);
  }

  /** Shape per docs (`{model,thinkingLevel,isScoped} | null`); single-model hosts return null. */
  async cycleModel(opts: PiRpcRequestOptions = {}): Promise<unknown> {
    return this.request<unknown>({ type: "cycle_model" }, opts);
  }

  async getAvailableThinkingLevels(opts: PiRpcRequestOptions = {}): Promise<{ levels: string[] }> {
    return this.request<{ levels: string[] }>({ type: "get_available_thinking_levels" }, opts);
  }

  /**
   * Pi is lenient: bogus levels succeed and fall back (no error). Callers
   * must validate via `getAvailableThinkingLevels()` first. Emits
   * `thinking_level_changed`.
   */
  async setThinkingLevel(level: string, opts: PiRpcRequestOptions = {}): Promise<void> {
    await this.request({ type: "set_thinking_level", level }, opts);
  }

  /** Emits `thinking_level_changed`; resolves with `{level}`. */
  async cycleThinkingLevel(opts: PiRpcRequestOptions = {}): Promise<{ level: string }> {
    return this.request<{ level: string }>({ type: "cycle_thinking_level" }, opts);
  }

  async setSteeringMode(mode: PiQueueMode | string, opts: PiRpcRequestOptions = {}): Promise<void> {
    await this.request({ type: "set_steering_mode", mode }, opts);
  }

  async setFollowUpMode(mode: PiQueueMode | string, opts: PiRpcRequestOptions = {}): Promise<void> {
    await this.request({ type: "set_follow_up_mode", mode }, opts);
  }

  /** Note: mutates global `settings.json` — use an isolated `PI_CODING_AGENT_DIR` in tests. */
  async setAutoCompaction(enabled: boolean, opts: PiRpcRequestOptions = {}): Promise<void> {
    await this.request({ type: "set_auto_compaction", enabled }, opts);
  }

  async setAutoRetry(enabled: boolean, opts: PiRpcRequestOptions = {}): Promise<void> {
    await this.request({ type: "set_auto_retry", enabled }, opts);
  }

  /** Rejects fail-closed on tiny sessions (`Nothing to compact`). */
  async compact(opts: PiRpcRequestOptions = {}): Promise<unknown> {
    return this.request<unknown>({ type: "compact" }, opts);
  }

  /**
   * Resume at `sessionPath`. WARNING: a missing path *succeeds* as a new
   * empty session (re-points `sessionFile` with a fresh bootstrap) — confirm
   * with the user before switching to an unverified path.
   */
  async switchSession(sessionPath: string, opts: PiRpcRequestOptions = {}): Promise<PiSessionSwitchResult> {
    return this.request<PiSessionSwitchResult>({ type: "switch_session", sessionPath }, opts);
  }

  /**
   * Fork at `entryId`: abandons the current branch and starts a new session
   * whose bootstrap parents onto the old chain (old messages disappear from
   * `get_entries`/`get_tree`). Confirm destructive use in UX.
   */
  async fork(entryId: string, opts: PiRpcRequestOptions = {}): Promise<PiForkResult> {
    return this.request<PiForkResult>({ type: "fork", entryId }, opts);
  }

  /** Fails closed until the session has been saved (needs an assistant response). */
  async clone(opts: PiRpcRequestOptions = {}): Promise<unknown> {
    return this.request<unknown>({ type: "clone" }, opts);
  }

  async newSession(opts: PiRpcRequestOptions = {}): Promise<PiSessionSwitchResult> {
    return this.request<PiSessionSwitchResult>({ type: "new_session" }, opts);
  }

  /** Emits `session_info_changed`. */
  async setSessionName(name: string, opts: PiRpcRequestOptions = {}): Promise<void> {
    await this.request({ type: "set_session_name", name }, opts);
  }

  /** Fails closed when empty (`Nothing to export yet`). */
  async exportHtml(outputPath: string, opts: PiRpcRequestOptions = {}): Promise<unknown> {
    return this.request<unknown>({ type: "export_html", outputPath }, opts);
  }

  /**
   * Reply to an `extension_ui_request` dialog. Fire-and-forget: no response
   * is expected (extension commands execute immediately, even mid-stream).
   * `cancelled: true` → the extension sees `undefined` (`false` for confirm).
   */
  respondToExtensionUi(response: PiExtensionUiResponse): void {
    this.sendNotification({ ...response });
  }

  // -------------------------------------------------------------------------
  // Close
  // -------------------------------------------------------------------------

  /**
   * Graceful close (stdin EOF → Pi exits 0), then forced (SIGTERM →
   * SIGKILL) after `graceMs`. Rejects remaining in-flight requests as
   * ambiguous `transport-closed`, removes every listener, destroys stdio,
   * and never leaves a duplicate owner. Idempotent — repeat calls return the
   * same result. Safe to call when idle (no pending) or active (pending
   * rejected as ambiguous).
   */
  async close(graceMs = CLOSE_TERM_GRACE_MS): Promise<PiRpcCloseResult> {
    if (this.closed && this.exitInfo) return this.exitInfo;
    const proc = this.proc;
    if (!proc) {
      this.closed = true;
      this.exitInfo = { exitCode: null, signal: null, forced: false };
      this.removeAllListeners();
      return this.exitInfo;
    }
    this.closing = true;
    // Dedicated closer waiter (separate from user onExit listeners so
    // handleExit-during-close wakes only the closer; finishClose fires
    // user listeners exactly once).
    const exit = new Promise<PiRpcCloseResult>((resolve) => {
      this.closeWaiter = (result: PiRpcCloseResult): void => {
        this.closeWaiter = null;
        resolve(result);
      };
      if (proc.exitCode !== null || proc.signalCode != null) {
        const cached = this.exitInfo ?? {
          exitCode: proc.exitCode,
          signal: (proc.signalCode as string | null) ?? null,
          forced: false,
        };
        setTimeout(() => this.closeWaiter?.(cached), 0);
      }
    });
    const waitExit = (timeoutMs: number): Promise<PiRpcCloseResult | null> =>
      Promise.race([
        exit.then((r) => r as PiRpcCloseResult | null),
        new Promise<null>((resolve) => {
          const t = setTimeout(() => resolve(null), timeoutMs);
          (t as unknown as { unref?: () => void }).unref?.();
        }),
      ]);

    try {
      proc.stdin?.end();
    } catch {
      // Already closed; fall through to SIGTERM below.
    }

    const stopWaiting = (): void => {
      this.closeWaiter = null;
    };

    let seen = await waitExit(graceMs);
    let forced = false;
    if (seen === null) {
      forced = true;
      try {
        proc.kill("SIGTERM");
      } catch {
        // Already exited.
      }
      // Bound every stage by the caller's grace so tests stay fast;
      // production callers pass the default 2s grace per stage.
      seen = await waitExit(graceMs);
    }
    if (seen === null) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Already exited.
      }
      seen = await waitExit(graceMs);
    }
    stopWaiting();
    if (seen !== null) {
      return this.finishClose(seen.exitCode, seen.signal, forced);
    }
    // The process ignored EOF + SIGTERM + SIGKILL (fakes/stuck children):
    // synthesize a forced close so callers never hang. Best-effort kill
    // before giving up on the OS handle.
    try {
      proc.kill("SIGKILL");
    } catch {
      // Ignore.
    }
    return this.finishClose(proc.exitCode ?? null, (proc.signalCode as string | null) ?? "SIGKILL", true);
  }

  private finishClose(
    exitCode: number | null,
    signal: string | null,
    forced: boolean,
  ): PiRpcCloseResult {
    const result: PiRpcCloseResult = { exitCode, signal, forced };
    this.exitInfo = result;
    this.closed = true;
    this.closing = false;
    // Remaining in-flight requests are ambiguous: Pi may have processed them
    // before EOF/kill, but the transport can no longer tell.
    const pendings = [...this.pending.entries()];
    this.pending.clear();
    for (const [id, entry] of pendings) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(
        new PiRpcError(
          {
            code: "transport-closed",
            command: entry.command,
            requestId: id,
            ambiguous: true,
            exitCode,
            signal,
          },
          `transport closed before answering ${entry.command} (id=${id})`,
        ),
      );
    }
    const waiters = this.settledWaiters.splice(0);
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.reject(
        new PiRpcError(
          { code: "transport-closed", command: "waitForSettled", ambiguous: false },
          "transport closed before agent_settled",
        ),
      );
    }
    this.detachAll();
    try {
      this.proc?.stdout?.destroy?.();
    } catch {
      // Ignore.
    }
    try {
      this.proc?.stderr?.destroy?.();
    } catch {
      // Ignore.
    }
    this.proc = null;
    // Fire exit handlers once (handleExit skips when `closed` during close).
    for (const h of [...this.exitHandlers]) {
      try {
        h(result);
      } catch {
        // Ignore.
      }
    }
    this.removeAllListeners();
    return result;
  }
}

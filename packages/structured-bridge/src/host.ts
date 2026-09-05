/**
 * Orca-side bridge host (SNC1.3).
 *
 * This is the generic external-adapter seam that a temporary Orca dev
 * branch vendors alongside `framing.ts` + `protocol.ts`. Orca keeps
 * ownership of journal, lease/fencing, outbox/idempotency, rendering, and
 * client synchronization; this host only transports opaque provider events
 * into Orca callbacks.
 *
 * Fail-closed contract:
 * - Missing binary, spawn failure, hello timeout, version mismatch, or
 *   `hello_error` → `available === false` with a short `reason`. The caller
 *   keeps the normal Pi TUI path untouched (see `probeSupport()`).
 * - `dispatch()` returns `accepted` only on an explicit provider
 *   `dispatch_ack{accepted}`, `rejected` only on explicit refusal
 *   (including bridge-unavailable), and `unknown` on timeout / exit /
 *   malformed ack. Unknown prompts are never auto-resent.
 *
 * Teardown: `dispose()` joins Orca teardown — bounded EOF grace → SIGTERM
 * grace → SIGKILL grace → synthetic finalization (never hangs), plus
 * listener detach and timer clear. Idempotent.
 *
 * Secret hygiene: the host never sends `env`/credentials over the bridge
 * and never includes prompt text in errors. Stderr is bounded + redacted.
 */

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import {
  assertNoCredentialFields,
  BRIDGE_PROTOCOL_VERSION,
  BridgeUnavailableError,
  createOpId,
  DEFAULT_CLOSE_GRACE_MS,
  DEFAULT_HELLO_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_STDERR_BYTES,
  redactSecretsFromText,
  validateBridgeMessage,
  type AcquiredResponse,
  type BridgeCapabilities,
  type BridgeHistoryEntry,
  type BridgeProviderEvent,
  type BridgeProviderIdentity,
  type BridgeSessionMetadata,
  type BridgeSessionOptions,
  type CancelledResponse,
  type ClosedResponse,
  type DispatchAck,
  type DispatchStatus,
  type HistoryResponse,
  type HostToProviderMessage,
  type OptionsUpdatedResponse,
  type ProviderToHostMessage,
  type SessionResponse,
} from "./protocol.js";
import { attachBridgeReader, serializeBridgeLine, type BridgeReadable } from "./framing.js";

export type SpawnFn = (
  command: string,
  args: string[],
  options: { stdio: string[]; cwd?: string; env?: NodeJS.ProcessEnv },
) => ChildProcess;

export interface BridgeHostOptions {
  /** Explicit dev-only provider command (e.g. `node`). Never from the plugin manifest. */
  bridgeCommand: string;
  bridgeArgs?: string[];
  /** Orca-selected workspace root forwarded as opaque cwd context (no secrets). */
  workspaceRoot: string;
  cwd?: string;
  /** Explicit env overlay for spawn only; never sent over the bridge. */
  env?: NodeJS.ProcessEnv;
  spawnFn?: SpawnFn;
  helloTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** EOF grace for graceful shutdown (default 2000ms). Also bounds SIGTERM/SIGKILL stages unless killGraceMs overrides. */
  closeGraceMs?: number;
  /** Grace per kill stage (SIGTERM wait, then SIGKILL wait). Defaults to closeGraceMs. Every stage is bounded; teardown never hangs. */
  killGraceMs?: number;
  maxStderrBytes?: number;
  hostVersion?: string;
}

export interface BridgeSupport {
  available: boolean;
  reason: string;
  provider?: BridgeProviderIdentity;
  capabilities?: BridgeCapabilities;
}

export interface AcquireResult {
  sessionId: string;
  resumed: boolean;
  metadata: BridgeSessionMetadata;
}

export interface DispatchOutcome {
  status: DispatchStatus;
  opId: string;
  reason?: string;
}

export interface SessionEventEnvelope {
  sessionId: string;
  opId?: string;
  event: BridgeProviderEvent;
}

export interface LifecycleEnvelope {
  kind: "provider-exit" | "provider-error" | "bridge-closed";
  message: string;
  code?: string | number | null;
  signal?: string | null;
}

interface PendingEntry {
  kind: string;
  resolve: (value: ProviderToHostMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function sanitizeReason(message: string): string {
  // Keep reasons short and free of prompt/env values: callers pass only
  // codes + opIds, never message text. Truncate defensively.
  const clean = message.replace(/[\r\n]+/g, " ").trim();
  return clean.length > 220 ? `${clean.slice(0, 217)}...` : clean;
}

export class BridgeHost {
  private proc: ChildProcess | null = null;
  private detachReader: (() => void) | null = null;
  private readonly pending = new Map<string, PendingEntry>();
  private readonly sessionListeners = new Set<(envelope: SessionEventEnvelope) => void>();
  private readonly lifecycleListeners = new Set<(envelope: LifecycleEnvelope) => void>();
  private readonly sessions = new Map<string, BridgeSessionMetadata>();
  private provider: BridgeProviderIdentity | null = null;
  private capabilities: BridgeCapabilities | null = null;
  private helloError: string | null = null;
  private spawnError: string | null = null;
  private exited: { code: number | null; signal: string | null } | null = null;
  private disposed = false;
  private starting: Promise<BridgeSupport> | null = null;
  private stderr = "";
  private readonly maxStderr: number;

  constructor(private readonly options: BridgeHostOptions) {
    if (!options.bridgeCommand || options.bridgeCommand.trim() === "") {
      throw new BridgeUnavailableError("bridge command is empty (set an explicit dev-only bridge path)", "BRIDGE_NO_COMMAND");
    }
    if (!options.workspaceRoot || options.workspaceRoot.trim() === "") {
      throw new BridgeUnavailableError("workspaceRoot is required", "BRIDGE_NO_WORKSPACE");
    }
    this.maxStderr = options.maxStderrBytes ?? MAX_STDERR_BYTES;
  }

  // -- observables -----------------------------------------------------------

  get isReady(): boolean {
    return this.provider !== null && this.proc !== null && !this.disposed && this.exited === null;
  }

  get support(): BridgeSupport {
    // Exited always wins: a dead provider is never reported ready, even if
    // identity/capabilities are still cached for diagnostics. Prefer the
    // process-error detail when an `error` raced hello (both set).
    if (this.exited) {
      const reason = this.spawnError ?? this.helloError ?? `provider-exited`;
      return { available: false, reason: sanitizeReason(reason) };
    }
    if (this.provider && this.capabilities) {
      return { available: true, reason: "bridge-ready", provider: this.provider, capabilities: this.capabilities };
    }
    const reason = this.helloError ?? this.spawnError ?? "bridge-not-started";
    return { available: false, reason: sanitizeReason(reason) };
  }

  get providerInfo(): BridgeProviderIdentity | null {
    return this.provider;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Bounded, redacted stderr snippet for diagnostics (never raw env). */
  get stderrSnippet(): string {
    return redactSecretsFromText(this.stderr, this.maxStderr);
  }

  onSessionEvent(listener: (envelope: SessionEventEnvelope) => void): () => void {
    this.sessionListeners.add(listener);
    return () => {
      this.sessionListeners.delete(listener);
    };
  }

  onLifecycle(listener: (envelope: LifecycleEnvelope) => void): () => void {
    this.lifecycleListeners.add(listener);
    return () => {
      this.lifecycleListeners.delete(listener);
    };
  }

  // -- lifecycle -------------------------------------------------------------

  /**
   * Probe structured support without throwing. Spawns the provider on first
   * call, runs hello negotiation, and reports fail-closed availability.
   * Safe to call repeatedly; leaves a ready host running on success.
   */
  async probeSupport(): Promise<BridgeSupport> {
    try {
      return await this.ensureStarted();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { available: false, reason: sanitizeReason(reason) };
    }
  }

  /** Ensure the provider is spawned + hello-negotiated. Throws fail-closed errors. */
  async ensureStarted(): Promise<BridgeSupport> {
    if (this.disposed) throw new BridgeUnavailableError("bridge host is disposed", "BRIDGE_DISPOSED");
    // A dead child never reports ready. Calling ensureStarted/probeSupport/
    // restart is the explicit restart path: drop the dead child and reset
    // exit diagnostics so the next hello starts fresh. dispatch()
    // deliberately bypasses this after exit (fail-closed, no auto-respawn).
    if (this.exited) {
      await this.abandonChildBestEffort();
      this.exited = null;
      this.helloError = null;
      this.spawnError = null;
    }
    if (this.provider && this.capabilities && !this.exited) {
      return { available: true, reason: "bridge-ready", provider: this.provider, capabilities: this.capabilities };
    }
    if (!this.starting) this.starting = this.startAndHello();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  /**
   * Explicit restart: bounded teardown of any current child (healthy, dead,
   * or failed), then fresh hello negotiation. Use after exit/failure instead
   * of relying on implicit respawn (dispatch never auto-respawns after death).
   */
  async restart(): Promise<BridgeSupport> {
    if (this.disposed) throw new BridgeUnavailableError("bridge host is disposed", "BRIDGE_DISPOSED");
    await this.abandonChildBestEffort();
    this.exited = null;
    this.helloError = null;
    this.spawnError = null;
    return this.ensureStarted();
  }

  private async startAndHello(): Promise<BridgeSupport> {
    this.spawnProvider();
    const opId = createOpId("hello");
    const helloTimeout = this.options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
    const hello: HostToProviderMessage = {
      v: BRIDGE_PROTOCOL_VERSION,
      kind: "hello",
      opId,
      host: { id: "orca", version: this.options.hostVersion ?? "0.1.0", protocol: BRIDGE_PROTOCOL_VERSION },
      workspaceRoot: this.options.workspaceRoot,
    };
    let ack: ProviderToHostMessage;
    try {
      ack = await this.sendAndWait(hello, helloTimeout);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.helloError = `hello-failed: ${reason}`;
      // Failed negotiation must not leave a resident helper when the caller
      // falls back to Pi TUI and never touches the bridge again.
      await this.abandonChildBestEffort();
      throw new BridgeUnavailableError(sanitizeReason(this.helloError), "BRIDGE_HELLO_FAILED");
    }
    if (ack.kind === "hello_error") {
      this.helloError = `provider-refused: ${ack.error.code}`;
      await this.abandonChildBestEffort();
      throw new BridgeUnavailableError(sanitizeReason(`provider-refused: ${ack.error.code}`), ack.error.code);
    }
    if (ack.kind !== "hello_ok") {
      this.helloError = `unexpected-hello-reply: ${ack.kind}`;
      await this.abandonChildBestEffort();
      throw new BridgeUnavailableError(sanitizeReason(this.helloError), "BRIDGE_HELLO_UNEXPECTED");
    }
    if (ack.provider.protocol !== BRIDGE_PROTOCOL_VERSION) {
      this.helloError = `incompatible-protocol: provider=${ack.provider.protocol} host=${BRIDGE_PROTOCOL_VERSION}`;
      await this.abandonChildBestEffort();
      throw new BridgeUnavailableError(sanitizeReason(this.helloError), "BRIDGE_INCOMPATIBLE");
    }
    this.provider = ack.provider;
    this.capabilities = ack.capabilities;
    return { available: true, reason: "bridge-ready", provider: this.provider, capabilities: this.capabilities };
  }

  /**
   * Best-effort bounded teardown of a failed/dead child without clearing the
   * diagnostic reason (helloError/spawnError/exited). Leaves the host ready
   * for an explicit restart: proc nulled, reader detached, provider cleared.
   * Never throws and never hangs (bounded SIGTERM/SIGKILL + synthetic finish).
   */
  private async abandonChildBestEffort(): Promise<void> {
    const proc = this.proc;
    if (proc) {
      try {
        await this.shutdownProcessInner(proc, "force");
      } catch {
        // Best-effort: never let cleanup throw.
      }
    }
    this.detachReader?.();
    this.detachReader = null;
    this.proc = null;
    this.provider = null;
    this.capabilities = null;
    this.sessions.clear();
    // Do not clear helloError/spawnError/exited here: support.reason needs them.
    // ensureStarted/restart reset them before a fresh spawn (see below).
  }

  private spawnProvider(): void {
    // A finalized dead child (see exit handler) leaves proc nulled so the
    // next explicit start spawns fresh. A live proc is reused.
    if (this.proc) return;
    const spawnFn: SpawnFn = this.options.spawnFn ?? ((spawn as unknown) as SpawnFn);
    const env = this.options.env ? { ...process.env, ...this.options.env } : { ...process.env };
    let proc: ChildProcess;
    try {
      proc = spawnFn(this.options.bridgeCommand, this.options.bridgeArgs ?? [], {
        stdio: ["pipe", "pipe", "pipe"],
        ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
        env,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.spawnError = `spawn-failed: ${reason}`;
      throw new BridgeUnavailableError(sanitizeReason(this.spawnError), "BRIDGE_SPAWN_FAILED");
    }
    this.proc = proc;
    proc.stderr?.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      this.stderr += text;
      if (this.stderr.length > this.maxStderr * 2) this.stderr = this.stderr.slice(-this.maxStderr);
    });
    this.detachReader = attachBridgeReader(proc.stdout as unknown as BridgeReadable, (line) => this.onLine(line));
    proc.on("error", (error: Error) => {
      this.spawnError = `process-error: ${error.message}`;
      // Terminal fail-closed finalization (same as exit): Node documents that
      // `exit` may never fire after `error`, so the exit handler cannot be
      // relied on to repair state. Invalidate provider/session ownership now;
      // if `exit` later fires on the old proc, that handler idempotently
      // refreshes `exited` with the real code/signal. Post-error dispatch
      // rejects bridge-unavailable until explicit restart (see dispatch()).
      if (!this.exited) this.exited = { code: null, signal: null };
      this.provider = null;
      this.capabilities = null;
      this.sessions.clear();
      this.detachReader?.();
      this.detachReader = null;
      this.proc = null;
      this.failAllPending(new BridgeUnavailableError(sanitizeReason(this.spawnError), "BRIDGE_PROCESS_ERROR"));
      this.emitLifecycle({ kind: "provider-error", message: sanitizeReason(this.spawnError) });
    });
    proc.on("exit", (code: number | null, signal: string | null) => {
      this.exited = { code, signal };
      // Finalize so support/ensureStarted never report stale ready and the
      // next explicit start spawns fresh. In-flight dispatches resolve
      // `unknown` (ambiguous ownership); post-exit dispatches reject as
      // bridge-unavailable without auto-respawn (see dispatch()).
      this.provider = null;
      this.capabilities = null;
      this.sessions.clear();
      this.detachReader?.();
      this.detachReader = null;
      this.proc = null;
      this.failAllPending(new BridgeUnavailableError(`provider-exited code=${code} signal=${signal}`, "BRIDGE_EXITED"));
      this.emitLifecycle({ kind: "provider-exit", message: `provider exited code=${code} signal=${signal}`, code, signal });
    });
  }

  // -- session operations ----------------------------------------------------

  async acquire(init: { resumePath?: string; sessionId?: string; options?: BridgeSessionOptions } = {}): Promise<AcquireResult> {
    await this.ensureStarted();
    const opId = createOpId("acq");
    const req: HostToProviderMessage = {
      v: BRIDGE_PROTOCOL_VERSION,
      kind: "acquire",
      opId,
      workspaceRoot: this.options.workspaceRoot,
      ...(init.resumePath ? { resumePath: init.resumePath } : {}),
      ...(init.sessionId ? { sessionId: init.sessionId } : {}),
      ...(init.options ? { options: init.options } : {}),
    };
    const res = (await this.sendAndWait(req, this.requestTimeout())) as AcquiredResponse;
    if (res.kind !== "acquired") throw new BridgeUnavailableError(`acquire failed: ${res.kind}`, "BRIDGE_ACQUIRE_FAILED");
    this.sessions.set(res.sessionId, res.metadata);
    return { sessionId: res.sessionId, resumed: res.resumed, metadata: res.metadata };
  }

  async release(sessionId: string): Promise<void> {
    if (!this.isReady) return;
    const opId = createOpId("rel");
    try {
      await this.sendAndWait(
        { v: BRIDGE_PROTOCOL_VERSION, kind: "release", opId, sessionId } satisfies HostToProviderMessage,
        this.requestTimeout(),
      );
    } catch {
      // Release is best-effort during teardown; session map is cleared regardless.
    } finally {
      this.sessions.delete(sessionId);
    }
  }

  /**
   * Dispatch one text message. Honest semantics:
   * - `accepted` only on explicit provider acceptance.
   * - `rejected` on explicit refusal *or* bridge-unavailable (definite).
   * - `unknown` on timeout/exit/malformed (ambiguous — never auto-resend).
   */
  async dispatch(req: {
    sessionId: string;
    text: string;
    images?: { data: string; mimeType: string }[];
    queue?: "reject" | "steer" | "followUp";
  }): Promise<DispatchOutcome> {
    if (this.disposed) return { status: "rejected", opId: createOpId("dsp"), reason: "bridge-disposed" };
    // Fail-closed after death: a previously healthy provider that has exited
    // is definitely unavailable. Do NOT auto-respawn here (that would turn a
    // definite rejection into an ambiguous `unknown` against a fresh provider
    // with no such session). Explicit restart() / ensureStarted() respawns.
    if (this.exited) {
      return { status: "rejected", opId: createOpId("dsp"), reason: sanitizeReason(`bridge-unavailable: provider-exited`) };
    }
    if (!this.isReady) {
      try {
        await this.ensureStarted();
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { status: "rejected", opId: createOpId("dsp"), reason: sanitizeReason(`bridge-unavailable: ${reason}`) };
      }
      // ensureStarted may have raced with an exit (respawn still pending or
      // child died during hello): re-check before writing to a dead process.
      if (this.exited || !this.isReady) {
        return { status: "rejected", opId: createOpId("dsp"), reason: sanitizeReason(`bridge-unavailable: provider-exited`) };
      }
    }
    const opId = createOpId("dsp");
    const msg: HostToProviderMessage = {
      v: BRIDGE_PROTOCOL_VERSION,
      kind: "dispatch",
      opId,
      sessionId: req.sessionId,
      message: { text: req.text, ...(req.images ? { images: req.images } : {}) },
      ...(req.queue ? { queue: req.queue } : {}),
    };
    let ack: ProviderToHostMessage;
    try {
      ack = await this.sendAndWait(msg, this.requestTimeout());
    } catch {
      // Ambiguous: the provider may still own the prompt.
      return { status: "unknown", opId, reason: "dispatch-timeout-or-exit (reconcile via history; do not auto-resend)" };
    }
    if (ack.kind !== "dispatch_ack" || ack.opId !== opId) {
      return { status: "unknown", opId, reason: `malformed-dispatch-ack: ${ack.kind} (reconcile via history)` };
    }
    const typed = ack as DispatchAck;
    if (typed.status === "accepted" || typed.status === "rejected") {
      return { status: typed.status, opId, ...(typed.reason ? { reason: sanitizeReason(typed.reason) } : {}) };
    }
    return { status: "unknown", opId, reason: sanitizeReason(typed.reason ?? "provider-unknown") };
  }

  async cancel(sessionId: string, targetOpId?: string): Promise<{ settled: boolean }> {
    await this.ensureStarted();
    const opId = createOpId("cnl");
    const res = (await this.sendAndWait(
      {
        v: BRIDGE_PROTOCOL_VERSION,
        kind: "cancel",
        opId,
        sessionId,
        ...(targetOpId ? { targetOpId } : {}),
      } satisfies HostToProviderMessage,
      this.requestTimeout(),
    )) as CancelledResponse;
    if (res.kind !== "cancelled") throw new BridgeUnavailableError(`cancel failed: ${res.kind}`, "BRIDGE_CANCEL_FAILED");
    return { settled: res.settled };
  }

  async answerPrompt(requestId: string, value: unknown, cancelled = false): Promise<void> {
    await this.ensureStarted();
    const opId = createOpId("ans");
    // answer_prompt is fire-and-forget from the host's view: the provider
    // correlates via requestId and continues the turn. Await the ack with a
    // bounded deadline but never include the value in errors.
    await this.sendAndWait(
      {
        v: BRIDGE_PROTOCOL_VERSION,
        kind: "answer_prompt",
        opId,
        requestId,
        cancelled,
        ...(cancelled ? {} : { value }),
      } satisfies HostToProviderMessage,
      this.requestTimeout(),
    );
  }

  async setOptions(sessionId: string, options: BridgeSessionOptions): Promise<BridgeSessionOptions> {
    await this.ensureStarted();
    const opId = createOpId("opt");
    const res = (await this.sendAndWait(
      { v: BRIDGE_PROTOCOL_VERSION, kind: "set_options", opId, sessionId, options } satisfies HostToProviderMessage,
      this.requestTimeout(),
    )) as OptionsUpdatedResponse;
    if (res.kind !== "options_updated") throw new BridgeUnavailableError(`set_options failed: ${res.kind}`, "BRIDGE_OPTIONS_FAILED");
    return res.options;
  }

  async getHistory(sessionId: string, cursor?: string, limit?: number): Promise<{ entries: BridgeHistoryEntry[]; nextCursor?: string; leafId?: string }> {
    await this.ensureStarted();
    const opId = createOpId("his");
    const res = (await this.sendAndWait(
      {
        v: BRIDGE_PROTOCOL_VERSION,
        kind: "get_history",
        opId,
        sessionId,
        ...(cursor ? { cursor } : {}),
        ...(limit !== undefined ? { limit } : {}),
      } satisfies HostToProviderMessage,
      this.requestTimeout(),
    )) as HistoryResponse;
    if (res.kind !== "history") throw new BridgeUnavailableError(`get_history failed: ${res.kind}`, "BRIDGE_HISTORY_FAILED");
    return { entries: res.entries, ...(res.nextCursor ? { nextCursor: res.nextCursor } : {}), ...(res.leafId ? { leafId: res.leafId } : {}) };
  }

  async getSession(sessionId: string): Promise<BridgeSessionMetadata> {
    await this.ensureStarted();
    const opId = createOpId("ses");
    const res = (await this.sendAndWait(
      { v: BRIDGE_PROTOCOL_VERSION, kind: "get_session", opId, sessionId } satisfies HostToProviderMessage,
      this.requestTimeout(),
    )) as SessionResponse;
    if (res.kind !== "session") throw new BridgeUnavailableError(`get_session failed: ${res.kind}`, "BRIDGE_SESSION_FAILED");
    this.sessions.set(sessionId, res.metadata);
    return res.metadata;
  }

  // -- teardown (joins Orca teardown) -----------------------------------------

  /**
   * Graceful (`close` + EOF→SIGTERM→SIGKILL, each bounded) or forceful
   * (SIGKILL, bounded) provider shutdown. Never hangs: every stage has a
   * hard deadline and ends with synthetic finalization.
   */
  async close(mode: "graceful" | "force" = "graceful"): Promise<{ code: number | null; signal: string | null }> {
    const proc = this.proc;
    if (!proc) return this.exited ? { ...this.exited } : { code: null, signal: null };
    // Handshake when the child is healthy, even mid-dispose (`isReady` is
    // false once `disposed` is set, but dispose still promises the bridge
    // `close` handshake before falling back to EOF/kill).
    if (mode === "graceful" && this.provider && !this.exited) {
      try {
        const opId = createOpId("cls");
        await this.sendAndWait(
          { v: BRIDGE_PROTOCOL_VERSION, kind: "close", opId, mode: "graceful" } satisfies HostToProviderMessage,
          Math.min(this.requestTimeout(), 3_000),
        );
      } catch {
        // Fall through to EOF/SIGTERM below.
      }
    }
    return this.shutdownProcess(mode);
  }

  /**
   * Join Orca teardown: close (graceful then force), detach the stdio
   * reader, clear timers/listeners, and kill the helper. Idempotent and
   * safe to call twice or after exit.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      await this.close("graceful");
    } catch {
      // Dispose never throws for transport failures.
    }
    try {
      await this.shutdownProcess("force");
    } catch {
      // Ignore — process already gone.
    }
    this.detachReader?.();
    this.detachReader = null;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new BridgeUnavailableError("bridge host disposed", "BRIDGE_DISPOSED"));
    }
    this.pending.clear();
    this.sessionListeners.clear();
    this.lifecycleListeners.clear();
    this.sessions.clear();
    this.proc = null;
  }

  // -- internals ---------------------------------------------------------------

  private requestTimeout(): number {
    return this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  private sendAndWait(message: HostToProviderMessage, timeoutMs: number): Promise<ProviderToHostMessage> {
    const proc = this.proc;
    if (!proc?.stdin) throw new BridgeUnavailableError("provider process has no stdin", "BRIDGE_NO_STDIN");
    assertNoCredentialFields(message, message.kind);
    if (typeof message.opId !== "string" || message.opId === "") {
      throw new BridgeUnavailableError(`missing opId for ${message.kind}`, "BRIDGE_NO_OP");
    }
    return new Promise<ProviderToHostMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.opId as string);
        reject(new Error(`timed out waiting for ${message.kind} opId=${message.opId}`));
      }, timeoutMs);
      this.pending.set(message.opId as string, { kind: message.kind, resolve, reject, timer });
      try {
        (proc.stdin as unknown as { write(s: string): void }).write(serializeBridgeLine(message));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(message.opId as string);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private onLine(line: string): void {
    if (line.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Malformed provider line: ignore (robustness), do not crash the host.
      // Dispatch waiters stay pending until their deadline → `unknown`.
      return;
    }
    if (validateBridgeMessage(parsed) !== null) return;
    const msg = parsed as ProviderToHostMessage;
    if (msg.kind === "session_event") {
      const envelope: SessionEventEnvelope = {
        sessionId: msg.sessionId,
        ...(msg.opId ? { opId: msg.opId } : {}),
        event: msg.event,
      };
      for (const listener of [...this.sessionListeners]) {
        try {
          listener(envelope);
        } catch {
          // Listener failures never break the bridge reader.
        }
      }
      return;
    }
    if (msg.kind === "exiting" || msg.kind === "error") {
      const isBenignAnswerAck = msg.kind === "error" && msg.error.code === "ANSWERED";
      if (!isBenignAnswerAck) {
        this.emitLifecycle({
          kind: msg.kind === "exiting" ? "provider-exit" : "provider-error",
          message: sanitizeReason(msg.kind === "exiting" ? `provider exiting: ${msg.reason}` : `provider error: ${msg.error.code}`),
          ...(msg.kind === "exiting" ? { code: msg.exit.code, signal: msg.exit.signal } : {}),
        });
      }
      const opId = msg.opId;
      if (opId && this.pending.has(opId)) {
        const entry = this.pending.get(opId);
        if (entry) {
          this.pending.delete(opId);
          clearTimeout(entry.timer);
          if (entry.kind === "dispatch") {
            const sid = msg.kind === "error" ? (msg.sessionId ?? "") : "";
            entry.resolve({ v: 1, kind: "dispatch_ack", opId, sessionId: sid, status: "unknown", reason: "provider-error" } as DispatchAck);
          } else if (entry.kind === "answer_prompt" && isBenignAnswerAck) {
            // Benign ack for answer_prompt (see provider onAnswer): the turn
            // continues via session_event; resolve so the host never hangs.
            entry.resolve(msg);
          } else {
            entry.reject(new BridgeUnavailableError(`provider error before ${entry.kind}`, "BRIDGE_PROVIDER_ERROR"));
          }
        }
      }
      return;
    }
    const opId = (msg as { opId?: string }).opId;
    if (opId && this.pending.has(opId)) {
      const entry = this.pending.get(opId);
      if (entry) {
        this.pending.delete(opId);
        clearTimeout(entry.timer);
        entry.resolve(msg);
      }
      return;
    }
    if (msg.kind === "closed") {
      const closed = msg as ClosedResponse;
      this.emitLifecycle({ kind: "bridge-closed", message: `provider closed code=${closed.exit.code}`, code: closed.exit.code, signal: closed.exit.signal });
    }
  }

  private failAllPending(error: Error): void {
    for (const [opId, entry] of [...this.pending]) {
      this.pending.delete(opId);
      clearTimeout(entry.timer);
      if (entry.kind === "dispatch") {
        entry.resolve({ v: 1, kind: "dispatch_ack", opId, sessionId: "", status: "unknown", reason: "provider-exited" } as DispatchAck);
      } else {
        entry.reject(error);
      }
    }
  }

  private emitLifecycle(envelope: LifecycleEnvelope): void {
    for (const listener of [...this.lifecycleListeners]) {
      try {
        listener(envelope);
      } catch {
        // Ignore listener failures.
      }
    }
  }

  private killGraceMs(): number {
    return this.options.killGraceMs ?? this.options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
  }

  /** Wait for one explicit proc's exit with a hard deadline; always resolves. */
  private waitForProcExit(proc: ChildProcess, timeoutMs: number): Promise<{ code: number | null; signal: string | null } | "timeout"> {
    // Fast path: already observed via the host exit handler or exitCode.
    if (this.exited) return Promise.resolve({ ...this.exited });
    if ((proc.exitCode as number | null | undefined) != null || (proc as unknown as { signalCode?: string | null }).signalCode != null) {
      return Promise.resolve({ code: proc.exitCode, signal: (proc as unknown as { signalCode?: string | null }).signalCode ?? null });
    }
    return new Promise((resolve) => {
      const onExit = (code: number | null, signal: string | null): void => {
        clearTimeout(timer);
        resolve({ code, signal });
      };
      const timer = setTimeout(() => {
        proc.off("exit", onExit);
        resolve("timeout");
      }, timeoutMs);
      proc.once("exit", onExit);
    });
  }

  /**
   * Bounded shutdown of one explicit child: EOF grace → SIGTERM grace →
   * SIGKILL grace → synthetic `{code:null,signal:null}`. Never hangs, even
   * if the helper ignores stdin EOF, SIGTERM, and SIGKILL (regression: fake
   * that swallows all three still resolves within ~3 graces).
   */
  private async shutdownProcessInner(proc: ChildProcess, mode: "graceful" | "force"): Promise<{ code: number | null; signal: string | null }> {
    const eofGrace = this.options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
    const killGrace = this.killGraceMs();
    if (mode === "graceful") {
      try {
        (proc.stdin as unknown as { end(): void }).end();
      } catch {
        // Already closed.
      }
      const eof = await this.waitForProcExit(proc, eofGrace);
      if (eof !== "timeout") return eof;
      try {
        proc.kill("SIGTERM");
      } catch {
        // Already exited.
      }
      const termed = await this.waitForProcExit(proc, killGrace);
      if (termed !== "timeout") return termed;
    }
    try {
      proc.kill("SIGKILL");
    } catch {
      // Already exited.
    }
    const killed = await this.waitForProcExit(proc, killGrace);
    if (killed !== "timeout") return killed;
    // Synthetic finalization: the helper ignored even SIGKILL (only possible
    // for swallowed-signal fakes; real SIGKILL cannot be ignored). Resolve
    // teardown instead of hanging Orca; caller nulls/detaches regardless.
    return { code: null, signal: null };
  }

  private async shutdownProcess(mode: "graceful" | "force"): Promise<{ code: number | null; signal: string | null }> {
    const proc = this.proc;
    if (!proc) return { code: null, signal: null };
    // Already observed exit (e.g. dispose runs close + force shutdown back to
    // back): return it instead of waiting for a second exit that never comes.
    if (this.exited) return { ...this.exited };
    // Loose `!= null` covers both `null` (real ChildProcess, running) and
    // `undefined` (in-memory fakes with no exitCode field).
    if ((proc.exitCode as number | null | undefined) != null || (proc as unknown as { signalCode?: string | null }).signalCode != null) {
      return { code: proc.exitCode, signal: (proc as unknown as { signalCode?: string | null }).signalCode ?? null };
    }
    return this.shutdownProcessInner(proc, mode);
  }
}

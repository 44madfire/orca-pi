/**
 * External provider side of the SNC1.3 bridge (runs out of process).
 *
 * `BridgeProvider` is the reusable base: it validates hello/protocol,
 * tracks in-memory sessions, and serializes LF-only replies. Subclasses
 * override `handleDispatch()` (streaming) and optionally acquire/options
 * hooks. The mock below proves the Orca-side seam without Pi; the Pi
 * translation lives in `pi-mapping.ts` (orca-pi owned, never in Orca core).
 *
 * Restart independence: providers keep no global/static session state —
 * every process starts empty. The host treats a restarted provider as a
 * fresh hello + acquire cycle (see host restart test).
 */

import {
  assertNoCredentialFields,
  BRIDGE_PROTOCOL_VERSION,
  validateBridgeMessage,
  type AcquireRequest,
  type BridgeCapabilities,
  type BridgeHistoryEntry,
  type BridgeProviderEvent,
  type BridgeProviderIdentity,
  type BridgeSessionMetadata,
  type BridgeSessionOptions,
  type DispatchRequest,
  type HostToProviderMessage,
  type ProviderToHostMessage,
} from "./protocol.js";
import { attachBridgeReader, serializeBridgeLine, type BridgeReadable } from "./framing.js";

export interface BridgeProviderOptions {
  providerId: string;
  providerVersion: string;
  capabilities: BridgeCapabilities;
}

export interface ProviderSession {
  metadata: BridgeSessionMetadata;
  history: BridgeHistoryEntry[];
  options: BridgeSessionOptions;
  activeOpId: string | null;
  /** FIFO of accepted steer/followUp dispatches waiting for the active turn to settle. */
  queue: DispatchRequest[];
  cancelledOps: Set<string>;
  pendingPrompt: { requestId: string; opId: string } | null;
  entryCounter: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function sessionCounter(): (prefix: string) => string {
  let n = 0;
  return (prefix: string) => {
    n += 1;
    return `${prefix}_${Date.now().toString(36)}_${n}`;
  };
}

export class BridgeProvider {
  protected readonly sessions = new Map<string, ProviderSession>();
  protected readonly newId: (prefix: string) => string = sessionCounter();
  protected send: (msg: ProviderToHostMessage) => void = () => undefined;
  private helloDone = false;

  constructor(private readonly opts: BridgeProviderOptions) {}

  get identity(): BridgeProviderIdentity {
    return { id: this.opts.providerId, version: this.opts.providerVersion, protocol: BRIDGE_PROTOCOL_VERSION };
  }

  get providerCapabilities(): BridgeCapabilities {
    return { ...this.opts.capabilities };
  }

  /** Wire the provider to raw stdio (child-process entrypoints use this). */
  run(stdin: BridgeReadable, stdout: { write(s: string): void }): () => void {
    this.send = (msg: ProviderToHostMessage) => {
      assertNoCredentialFields(msg, msg.kind);
      stdout.write(serializeBridgeLine(msg));
    };
    return attachBridgeReader(stdin, (line) => this.onLine(line));
  }

  /** In-process wiring for unit tests (no OS process). */
  attachTestTransport(send: (msg: ProviderToHostMessage) => void): void {
    this.send = (msg) => {
      assertNoCredentialFields(msg, msg.kind);
      send(msg);
    };
  }

  /** Handle one raw input line (framing already split it). */
  onLine(line: string): void {
    if (line.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.send({ v: BRIDGE_PROTOCOL_VERSION, kind: "error", error: { code: "PARSE_ERROR", message: "malformed JSON line" } });
      return;
    }
    const problem = validateBridgeMessage(parsed);
    if (problem !== null) {
      const opId = (parsed as { opId?: unknown }).opId;
      this.send({
        v: BRIDGE_PROTOCOL_VERSION,
        kind: "error",
        ...(typeof opId === "string" ? { opId } : {}),
        error: { code: "BAD_MESSAGE", message: `invalid bridge record: ${problem}` },
      });
      return;
    }
    // onMessage awaits handleDispatch: a rejected provider turn must never
    // become an unhandled rejection with a stuck activeOpId. Funnel failures
    // into a shaped turn_end/settled + error record instead.
    this.onMessage(parsed as HostToProviderMessage).catch((error: unknown) => {
      this.failMessage(parsed as HostToProviderMessage, error);
    });
  }

  /** Shaped recovery for an async provider failure (dispatch streaming). */
  protected failMessage(msg: HostToProviderMessage, error: unknown): void {
    if (msg.kind !== "dispatch") {
      this.send({
        v: BRIDGE_PROTOCOL_VERSION,
        kind: "error",
        opId: msg.opId,
        error: { code: "HANDLER_FAILED", message: `provider failed to handle ${msg.kind}` },
      });
      return;
    }
    const session = this.sessions.get(msg.sessionId);
    if (!session) {
      this.send({
        v: BRIDGE_PROTOCOL_VERSION,
        kind: "error",
        opId: msg.opId,
        sessionId: msg.sessionId,
        error: { code: "HANDLER_FAILED", message: "provider failed to handle dispatch" },
      });
      return;
    }
    this.failStream(session, msg.opId, error);
  }

  /**
   * Shaped recovery for a failed turn: error `turn_end` + `settled` (so the
   * host re-enables input) and turn completion (unsticks the session and
   * drains any queued steer/followUp). The message is a stable generic
   * string: raw exception text is never forwarded because it can carry
   * prompt fragments, credentials, or request payloads that value
   * redaction cannot reliably strip.
   */
  protected failStream(session: ProviderSession, opId: string, _error: unknown): void {
    void _error;
    this.emit(session, opId, { type: "turn_end", stopReason: "error", errorMessage: "provider dispatch failed" });
    this.emit(session, opId, { type: "settled", willRetry: false });
    this.finishTurn(session, opId);
  }

  /**
   * Clear the active turn (when it is `opId`) and start the next queued
   * steer/followUp request, if any. The single choke point for turn
   * completion: every handleDispatch return path must go through here so a
   * queued request never runs concurrently with the active turn.
   */
  protected finishTurn(session: ProviderSession, opId: string): void {
    if (session.activeOpId === opId) {
      session.activeOpId = null;
      session.metadata.isStreaming = false;
    }
    const next = session.queue.shift();
    if (!next) return;
    if (session.activeOpId !== null) return;
    session.activeOpId = next.opId;
    session.metadata.isStreaming = true;
    // Already acked accepted when queued; stream without re-acking.
    this.handleDispatch(session, next).catch((error: unknown) => {
      this.failMessage(next, error);
    });
  }

  protected async onMessage(msg: HostToProviderMessage): Promise<void> {
    switch (msg.kind) {
      case "hello":
        this.onHello(msg.opId, msg.host.protocol, msg.workspaceRoot);
        break;
      case "acquire":
        this.onAcquire(msg);
        break;
      case "release":
        this.sessions.delete(msg.sessionId);
        this.send({ v: 1, kind: "released", opId: msg.opId, sessionId: msg.sessionId });
        break;
      case "dispatch":
        await this.onDispatch(msg);
        break;
      case "cancel":
        this.onCancel(msg.opId, msg.sessionId, msg.targetOpId);
        break;
      case "answer_prompt":
        this.onAnswer(msg.opId, msg.requestId, msg.value, msg.cancelled);
        break;
      case "set_options":
        this.onSetOptions(msg.opId, msg.sessionId, msg.options);
        break;
      case "get_history":
        this.onGetHistory(msg.opId, msg.sessionId, msg.cursor, msg.limit);
        break;
      case "get_session":
        this.onGetSession(msg.opId, msg.sessionId);
        break;
      case "close":
        this.onClose(msg.opId, msg.sessionId);
        break;
    }
  }

  protected onHello(opId: string, hostProtocol: number, _workspaceRoot: string): void {
    void _workspaceRoot;
    if (hostProtocol !== BRIDGE_PROTOCOL_VERSION) {
      this.send({ v: 1, kind: "hello_error", opId, error: { code: "INCOMPATIBLE_PROTOCOL", message: `host protocol ${hostProtocol} != bridge ${BRIDGE_PROTOCOL_VERSION}` } });
      return;
    }
    this.helloDone = true;
    this.send({ v: 1, kind: "hello_ok", opId, provider: this.identity, capabilities: this.providerCapabilities });
  }

  protected requireHello(opId: string): boolean {
    if (!this.helloDone) {
      this.send({ v: 1, kind: "error", opId, error: { code: "HELLO_REQUIRED", message: "send hello first" } });
      return false;
    }
    return true;
  }

  protected onAcquire(msg: AcquireRequest): void {
    if (!this.requireHello(msg.opId)) return;
    const sessionId = msg.sessionId ?? this.newId("ses");
    const existing = this.sessions.get(sessionId);
    if (existing && msg.sessionId) {
      this.send({ v: 1, kind: "acquired", opId: msg.opId, sessionId, resumed: true, metadata: existing.metadata });
      return;
    }
    const metadata: BridgeSessionMetadata = {
      sessionId,
      providerSessionId: sessionId,
      workspaceRoot: msg.workspaceRoot,
      messageCount: 0,
      isStreaming: false,
      createdAt: nowIso(),
      ...(msg.options?.model ? { model: msg.options.model } : {}),
      ...(msg.options?.thinkingLevel ? { thinkingLevel: msg.options.thinkingLevel } : {}),
    };
    this.sessions.set(sessionId, {
      metadata,
      history: [],
      options: { ...(msg.options ?? {}) },
      activeOpId: null,
      queue: [],
      cancelledOps: new Set(),
      pendingPrompt: null,
      entryCounter: 0,
    });
    this.send({ v: 1, kind: "acquired", opId: msg.opId, sessionId, resumed: false, metadata });
  }

  /** Default: accept when idle, reject when busy unless queue steer/followUp. Subclasses stream after ack. */
  protected async onDispatch(msg: DispatchRequest): Promise<void> {
    if (!this.requireHello(msg.opId)) return;
    const session = this.sessions.get(msg.sessionId);
    if (!session) {
      this.send({ v: 1, kind: "dispatch_ack", opId: msg.opId, sessionId: msg.sessionId, status: "rejected", reason: "unknown-session" });
      return;
    }
    if (msg.message.text.trim() === "") {
      this.send({ v: 1, kind: "dispatch_ack", opId: msg.opId, sessionId: msg.sessionId, status: "rejected", reason: "empty-text" });
      return;
    }
    if (session.activeOpId) {
      if ((msg.queue ?? "reject") === "reject") {
        this.send({ v: 1, kind: "dispatch_ack", opId: msg.opId, sessionId: msg.sessionId, status: "rejected", reason: "already-streaming (use steer/followUp or cancel)" });
        return;
      }
      // Queued steer/followUp: accept now, stream FIFO after the active turn
      // settles. activeOpId keeps identifying the running turn so cancel and
      // session state never confuse the queued request with it.
      this.send({ v: 1, kind: "dispatch_ack", opId: msg.opId, sessionId: msg.sessionId, status: "accepted" });
      session.queue.push(msg);
      return;
    }
    session.activeOpId = msg.opId;
    session.metadata.isStreaming = true;
    this.send({ v: 1, kind: "dispatch_ack", opId: msg.opId, sessionId: msg.sessionId, status: "accepted" });
    await this.handleDispatch(session, msg);
  }

  /** Subclass hook: stream `session_event` records, then finish the turn (drains queued steer/followUp). Base is a no-op settle. */
  protected async handleDispatch(_session: ProviderSession, msg: DispatchRequest): Promise<void> {
    const session = this.sessions.get(msg.sessionId);
    if (!session) return;
    this.emit(session, msg.opId, { type: "turn_start" });
    this.emit(session, msg.opId, { type: "turn_end", stopReason: "stop" });
    this.emit(session, msg.opId, { type: "settled", willRetry: false });
    this.finishTurn(session, msg.opId);
  }

  protected onCancel(opId: string, sessionId: string, targetOpId?: string): void {
    if (!this.requireHello(opId)) return;
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.send({ v: 1, kind: "cancelled", opId, sessionId, targetOpId: targetOpId ?? "", settled: true });
      return;
    }
    const target = targetOpId ?? session.activeOpId ?? "";
    if (target !== "") session.cancelledOps.add(target);
    // `settled` reports actual state: cancel only marks the turn; the
    // `session_event{settled}` record arrives later. Idle (nothing streaming)
    // is already settled; anything else is not, regardless of target.
    const settled = session.activeOpId === null;
    this.send({ v: 1, kind: "cancelled", opId, sessionId, targetOpId: target, settled });
  }

  protected onAnswer(opId: string, requestId: string, value: unknown, cancelled: boolean): void {
    if (!this.requireHello(opId)) return;
    // Base provider has no pending prompts; ack via generic history-shaped close.
    // Subclasses (mock) override to resume the turn. Always ack the op so the
    // host never hangs: reuse `options_updated` shape? No — use `error`-free
    // `cancelled`-style ack via a `session_event`? The protocol has no
    // dedicated answer ack, so providers reply with an `error success=false`?
    // Simplest honest ack: echo as `closed`-free generic — send `error` only
    // on unknown request, otherwise stay silent and let the turn continue.
    // To keep host `sendAndWait` resolvable, send a minimal `options_updated`
    // is wrong. Instead the base sends a `history`-independent ack through
    // the `error` channel with a benign code the host treats as resolved?
    //
    // Resolution: the protocol routes *any* p2h record with matching `opId`
    // to the waiter, so an `error` with code ANSWERED still resolves the
    // host promise (host resolves on any opId match except session_event).
    // Document this: answer_prompt resolves with an `error{code:ANSWERED}`
    // benign ack when the request was known, `UNKNOWN_REQUEST` otherwise.
    let known = false;
    for (const session of this.sessions.values()) {
      if (session.pendingPrompt?.requestId === requestId) {
        known = true;
        // Resume first while pendingPrompt is still set (subclasses read the
        // originating opId from it), then clear so a duplicate answer reports
        // UNKNOWN_REQUEST instead of double-resuming the turn.
        this.onPromptAnswered(session, requestId, value, cancelled);
        session.pendingPrompt = null;
        break;
      }
    }
    this.send({
      v: 1,
      kind: "error",
      opId,
      error: known ? { code: "ANSWERED", message: "prompt answer recorded" } : { code: "UNKNOWN_REQUEST", message: `unknown prompt request ${requestId}` },
    });
  }

  /** Subclass hook: resume a turn after `answer_prompt`. */
  protected onPromptAnswered(_session: ProviderSession, _requestId: string, _value: unknown, _cancelled: boolean): void {
    void _session;
    void _requestId;
    void _value;
    void _cancelled;
    // Base: nothing pending.
  }

  protected onSetOptions(opId: string, sessionId: string, options: BridgeSessionOptions): void {
    if (!this.requireHello(opId)) return;
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.send({ v: 1, kind: "error", opId, sessionId, error: { code: "UNKNOWN_SESSION", message: "unknown session" } });
      return;
    }
    session.options = { ...session.options, ...options };
    if (options.model !== undefined) session.metadata.model = options.model;
    if (options.thinkingLevel !== undefined) session.metadata.thinkingLevel = options.thinkingLevel;
    this.send({ v: 1, kind: "options_updated", opId, sessionId, options: { ...session.options } });
  }

  protected onGetHistory(opId: string, sessionId: string, cursor?: string, limit?: number): void {
    if (!this.requireHello(opId)) return;
    // Wire validation normally rejects non-positive-integer limits first;
    // this explicit branch defines the semantics for direct callers too:
    // `limit` must be a positive integer, never 0/negative/fractional.
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      this.send({ v: 1, kind: "error", opId, sessionId, error: { code: "BAD_LIMIT", message: "limit must be a positive integer" } });
      return;
    }
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.send({ v: 1, kind: "error", opId, sessionId, error: { code: "UNKNOWN_SESSION", message: "unknown session" } });
      return;
    }
    const full = session.history;
    // leafId always names the session leaf (full history), never the page end.
    const leafId = full.length > 0 ? full[full.length - 1]?.id : undefined;
    let rest = full;
    if (cursor) {
      const idx = rest.findIndex((e) => e.id === cursor);
      rest = idx === -1 ? [] : rest.slice(idx + 1);
    }
    let entries = rest;
    let nextCursor: string | undefined;
    if (limit !== undefined && rest.length > limit) {
      entries = rest.slice(0, limit);
      nextCursor = entries.length > 0 ? entries[entries.length - 1]?.id : undefined;
    }
    this.send({
      v: 1,
      kind: "history",
      opId,
      sessionId,
      entries,
      ...(nextCursor ? { nextCursor } : {}),
      ...(leafId ? { leafId } : {}),
    });
  }

  protected onGetSession(opId: string, sessionId: string): void {
    if (!this.requireHello(opId)) return;
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.send({ v: 1, kind: "error", opId, sessionId, error: { code: "UNKNOWN_SESSION", message: "unknown session" } });
      return;
    }
    this.send({ v: 1, kind: "session", opId, sessionId, metadata: { ...session.metadata } });
  }

  protected onClose(opId: string, sessionId?: string): void {
    if (sessionId) this.sessions.delete(sessionId);
    this.send({ v: 1, kind: "closed", opId, ...(sessionId ? { sessionId } : {}), exit: { code: 0, signal: null } });
  }

  protected emit(session: ProviderSession, opId: string | undefined, event: BridgeProviderEvent): void {
    this.send({ v: 1, kind: "session_event", sessionId: session.metadata.sessionId, ...(opId ? { opId } : {}), event });
  }

  protected appendHistory(session: ProviderSession, entry: Omit<BridgeHistoryEntry, "id" | "timestamp"> & { id?: string }): BridgeHistoryEntry {
    session.entryCounter += 1;
    const full: BridgeHistoryEntry = {
      id: entry.id ?? `e${session.entryCounter}`,
      ...(entry.parentId ? { parentId: entry.parentId } : {}),
      role: entry.role,
      ...(entry.text !== undefined ? { text: entry.text } : {}),
      timestamp: nowIso(),
    };
    session.history.push(full);
    session.metadata.messageCount = session.history.filter((e) => e.role === "user" || e.role === "assistant").length;
    return full;
  }
}

// ---------------------------------------------------------------------------
// Mock external provider (acceptance harness).
// ---------------------------------------------------------------------------

export interface MockProviderOptions extends BridgeProviderOptions {
  /** Chunk size for fake text deltas (default 8 chars). */
  textChunkSize?: number;
  /** When true, `__prompt_select__` dispatches pause for `answer_prompt`. */
  enablePromptPause?: boolean;
}

/**
 * Deterministic fake provider for bridge acceptance:
 * - Creates real bridge sessions (`acquired`) and streams a fake response
 *   into the host's normal `session_event` flow (turn/text/settled).
 * - Honors `cancel` (aborted turn) and `answer_prompt` (prompt_request).
 * - Keeps history/options/session metadata so the host can reconcile.
 * - No Pi, no network, no secrets. Restart = new instance, empty sessions.
 */
export class MockExternalProvider extends BridgeProvider {
  private readonly chunkSize: number;
  private readonly promptPause: boolean;

  constructor(opts: Partial<MockProviderOptions> = {}) {
    super({
      providerId: opts.providerId ?? "mock",
      providerVersion: opts.providerVersion ?? "0.1.0",
      capabilities: opts.capabilities ?? {
        textStreaming: true,
        thinking: true,
        tools: true,
        images: true,
        extensionDialogs: true,
        history: true,
        options: true,
        cancel: true,
        resume: true,
      },
    });
    this.chunkSize = opts.textChunkSize ?? 8;
    this.promptPause = opts.enablePromptPause ?? true;
  }

  protected override async handleDispatch(session: ProviderSession, msg: DispatchRequest): Promise<void> {
    const opId = msg.opId;
    const text = msg.message.text;

    // Deterministic test hooks (documented in bridge-protocol.md).
    if (text === "__reject__") {
      // Already acked accepted by base `onDispatch`; correct it by ending
      // the turn as an error. Tests that need a pre-ack rejection use a
      // busy session instead. Kept for explicit error-path coverage.
      this.emit(session, opId, { type: "turn_start" });
      this.emit(session, opId, { type: "turn_end", stopReason: "error", errorMessage: "mock rejected prompt" });
      this.emit(session, opId, { type: "settled", willRetry: false });
      this.finishTurn(session, opId);
      return;
    }
    if (text === "__throw__") {
      // Deterministic async-failure hook: rejects after accept so the
      // onMessage catch path (shaped turn_end/settled, unstuck session)
      // is covered without subclassing in tests.
      throw new Error("mock handleDispatch failure");
    }

    this.appendHistory(session, { role: "user", text });
    this.emit(session, opId, { type: "turn_start" });

    if (this.promptPause && text === "__prompt_select__") {
      const requestId = `prompt_${opId}`;
      session.pendingPrompt = { requestId, opId };
      this.emit(session, opId, {
        type: "prompt_request",
        requestId,
        prompt: { kind: "select", title: "Mock choice", options: ["alpha", "beta"] },
        timeoutMs: 30_000,
      });
      // Pause: `onPromptAnswered` resumes the turn.
      return;
    }

    await this.streamFakeResponse(session, opId, `mock response for: ${text}`);
  }

  protected override onPromptAnswered(session: ProviderSession, requestId: string, value: unknown, cancelled: boolean): void {
    const pending = session.pendingPrompt;
    const opId = pending?.opId;
    if (!opId) return;
    const answer = cancelled ? "(cancelled)" : String(value ?? "(answered)");
    // Resume asynchronously; a streaming failure must still settle the turn
    // instead of becoming an unhandled rejection with a stuck session.
    this.streamFakeResponse(session, opId, `mock answered ${requestId} with ${answer}`).catch((error: unknown) => {
      this.failStream(session, opId, error);
    });
  }

  private async streamFakeResponse(session: ProviderSession, opId: string, fullText: string): Promise<void> {
    this.emit(session, opId, { type: "text_start", contentIndex: 0 });
    for (let i = 0; i < fullText.length; i += this.chunkSize) {
      if (session.cancelledOps.has(opId)) {
        this.emit(session, opId, { type: "turn_end", stopReason: "aborted", errorMessage: "cancelled by host" });
        this.emit(session, opId, { type: "settled", willRetry: false });
        session.cancelledOps.delete(opId);
        this.finishTurn(session, opId);
        return;
      }
      this.emit(session, opId, { type: "text_delta", delta: fullText.slice(i, i + this.chunkSize), contentIndex: 0 });
      // Yield so a racing `cancel` line is handled between deltas.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (session.cancelledOps.has(opId)) {
      this.emit(session, opId, { type: "turn_end", stopReason: "aborted", errorMessage: "cancelled by host" });
      this.emit(session, opId, { type: "settled", willRetry: false });
      session.cancelledOps.delete(opId);
    } else {
      this.emit(session, opId, { type: "text_end", contentIndex: 0, text: fullText });
      this.appendHistory(session, { role: "assistant", text: fullText });
      this.emit(session, opId, { type: "turn_end", stopReason: "stop" });
      this.emit(session, opId, { type: "settled", willRetry: false });
    }
    this.finishTurn(session, opId);
  }
}

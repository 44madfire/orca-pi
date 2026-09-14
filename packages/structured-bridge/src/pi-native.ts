/**
 * In-process native Pi provider (SNC1.8, orca-pi owned).
 *
 * Ports the proven external bridge provider (`pi-provider.ts` + `pi-mapping.ts`
 * + `pi-translator.ts` + `pi-history.ts` over the production SNC1.2
 * `PiRpcConnection`) into the production upstream shape: an in-process native
 * adapter with no `orca-pi` bridge/helper OS process.
 *
 * Reuse strategy (minimal behavioral change):
 * - The proven `PiBridgeProvider` class owns ALL Pi RPC, event translation,
 *   options, prompt, image, history/branch/resume, cancel/close, and error
 *   semantics. This native wrapper drives the SAME class in-process via its
 *   test transport (`attachTestTransport` + `onLine`), so every translator
 *   code path, error code (`PI_STARTUP_FAILED`, `PI_TUI_FLAG`,
 *   `UNKNOWN_MODEL`, `AMBIGUOUS_MODEL`, `UNKNOWN_THINKING_LEVEL`,
 *   `PI_OPTION_FAILED`, `PI_RESUME_*`, `PI_HISTORY_*`, `UNKNOWN_REQUEST`,
 *   `ANSWERED`), delivery verdict (`accepted`/`rejected`/`unknown`), and
 *   history cursor/leaf invariant is preserved verbatim.
 * - The only thing removed is the helper OS process (`pi-provider-cli.js`
 *   stdio child). Packaged Orca needs only the real `pi --mode rpc` child
 *   that `PiBridgeProvider` already spawns per session in the exact
 *   Orca-selected `workspaceRoot` — no second bridge process, no JSONL over
 *   stdio, no `ORCA_PI_BRIDGE_COMMAND`.
 * - The full model/thinking catalog seam that bridge v1 lacks lives here:
 *   `listModels()` / `listThinkingLevels()` call the live Pi option RPCs
 *   through the captured `PiProviderConnection`, so Orca's
 *   `AgentSessionOptionsResult.models` can carry a complete catalog instead
 *   of the honest `models:[]` temp the external adapter reports.
 *
 * Orca vendoring map (upstreamable contribution):
 * ```text
 * orca-pi (this package, stays here)          → orca (native, in-process)
 * packages/pi-rpc/src/*                       → vendored Pi RPC transport
 * packages/structured-bridge/src/pi-mapping.ts      → transplanted translation
 * packages/structured-bridge/src/pi-translator.ts   → transplanted translator
 * packages/structured-bridge/src/pi-history.ts      → transplanted history
 * packages/structured-bridge/src/pi-native.ts       → adapted to PiStructuredSessionAdapter
 * packages/structured-bridge/src/framing.ts         → NOT vendored (bridge only)
 * packages/structured-bridge/src/protocol.ts        → NOT vendored (bridge only)
 * packages/structured-bridge/src/host.ts            → NOT vendored (bridge only)
 * packages/structured-bridge/src/pi-provider-cli.js → NOT shipped (dev harness only)
 * ```
 * The Orca-side `PiStructuredSessionAdapter` implements Orca's
 * `StructuredAgentSessionAdapter` contract by delegating to this native core
 * (or its transplanted equivalent) and translating native session events into
 * Orca journal appends + Native Chat renders — the same delegation the
 * external adapter performs today, minus the bridge. Orca keeps ownership of
 * process wrappers, process identity, fencing, journal sink, option
 * persistence, structured-session records, and client capability negotiation.
 *
 * Fail-closed contract (mirrors the bridge):
 * - `supportsCreate()` returns true only for proven execution locations
 *   (local host, no WSL distro) and `agent === "pi"`. All other locations or
 *   agents fail closed to the ordinary Pi TUI path.
 * - Missing Pi binary, startup/auth/model failures, TUI-only flags, and
 *   incompatible history all surface as actionable errors — never silent
 *   divergence, never a second competing state machine.
 * - Codex/Claude provider selection is unchanged: this adapter handles only
 *   `agent === "pi"` and never claims `codex`/`claude`/`external` sessions.
 */

import { checkAcquireCompat, type PiAcquireCompat } from "./pi-compat.js";
import { PiBridgeProvider, type PiBridgeProviderOptions } from "./pi-provider.js";
import type {
  BridgeCapabilities,
  BridgeHistoryEntry,
  BridgeProviderEvent,
  BridgeSessionMetadata,
  BridgeSessionOptions,
  HostToProviderMessage,
  ProviderToHostMessage,
} from "./protocol.js";
import type { PiModel } from "@orca-pi/pi-rpc";

/** Minimal execution-location shape mirrored from Orca (no Orca import). */
export interface PiNativeLocation {
  readonly executionHostId: string;
  readonly wslDistro: string | null;
}

/** Proven local execution host id (mirrors Orca's LOCAL_EXECUTION_HOST_ID). */
export const PI_NATIVE_LOCAL_HOST_ID = "local";

/** Agent string this native adapter owns (alongside Codex/Claude). */
export const PI_NATIVE_AGENT = "pi";

export interface PiNativeAcquireInput {
  readonly workspaceRoot: string;
  readonly resumePath?: string;
  readonly sessionId?: string;
  readonly options?: BridgeSessionOptions;
  /**
   * Optional acquire-time compatibility gate (SNC1.10, plain data).
   * Enforced before the hello handshake and any Pi child creation: a
   * refused gate throws `PI_COMPAT_*` (use Pi TUI) and never starts
   * structured Pi.
   */
  readonly compat?: PiAcquireCompat;
}

export interface PiNativeAcquireResult {
  readonly sessionId: string;
  readonly resumed: boolean;
  readonly metadata: BridgeSessionMetadata;
}

export interface PiNativeDispatchInput {
  readonly sessionId: string;
  readonly text: string;
  readonly images?: Array<{ data: string; mimeType: string }>;
  readonly queue?: "reject" | "steer" | "followUp";
}

export type PiNativeDispatchResult =
  | { readonly status: "accepted"; readonly sessionId: string }
  | { readonly status: "rejected"; readonly sessionId: string; readonly reason: string }
  | { readonly status: "unknown"; readonly sessionId: string; readonly reason: string };

export interface PiNativeSessionEventEnvelope {
  readonly sessionId: string;
  readonly opId?: string;
  readonly event: BridgeProviderEvent;
}

export type PiNativeOptions = PiBridgeProviderOptions;

const PI_NATIVE_HELLO_TIMEOUT_MS = 5_000;
const PI_NATIVE_REQUEST_TIMEOUT_MS = 10_000;

function nextOpId(prefix: string, seq: { n: number }): string {
  seq.n += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq.n}`;
}

/**
 * In-process native Pi provider. Drives the proven `PiBridgeProvider`
 * without spawning a bridge helper process.
 */
export class PiNativeProvider {
  private readonly bridge: PiBridgeProvider;
  private readonly waiters = new Map<
    string,
    { kinds: ReadonlySet<string>; resolve: (msg: ProviderToHostMessage) => void }
  >();
  private readonly eventHandlers = new Set<(envelope: PiNativeSessionEventEnvelope) => void>();
  private readonly seq = { n: 0 };
  private helloOk: Promise<void> | null = null;
  private helloFailed: string | null = null;
  private disposed = false;

  constructor(opts: PiNativeOptions = {}) {
    // No connection capture here: the catalog seam reads the live Pi
    // connection per session via `bridge.getPiConnection(sessionId)`, so
    // both the default production factory and injected test factories are
    // covered without a global newest-connection heuristic.
    this.bridge = new PiBridgeProvider({ ...opts });
    this.bridge.attachTestTransport((msg) => this.handleProviderMessage(msg));
  }

  /** Proven Pi capabilities (same object the bridge advertises). */
  get capabilities(): BridgeCapabilities {
    return this.bridge.providerCapabilities;
  }

  /** Active Pi session count (diagnostics; never sent over any wire). */
  get piSessionCount(): number {
    return this.bridge.piSessionCount;
  }

  /** Only proven execution locations may create native Pi sessions. */
  supportsLocation(location: PiNativeLocation): boolean {
    return (
      location.executionHostId === PI_NATIVE_LOCAL_HOST_ID && location.wslDistro === null
    );
  }

  /** Route `pi` through the normal structured adapter router alongside Codex/Claude. */
  supportsCreate(location: PiNativeLocation, agent: string): boolean {
    if (agent !== PI_NATIVE_AGENT) return false;
    return this.supportsLocation(location);
  }

  /** Subscribe to streamed native session events (text/thinking/tools/lifecycle/prompts). */
  onSessionEvent(handler: (envelope: PiNativeSessionEventEnvelope) => void): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  /** Ensure the in-process hello handshake completed (capability negotiation). */
  async ensureHello(timeoutMs = PI_NATIVE_HELLO_TIMEOUT_MS): Promise<void> {
    if (this.helloFailed) throw new Error(this.helloFailed);
    if (!this.helloOk) {
      this.helloOk = this.doHello(timeoutMs);
    }
    await this.helloOk;
  }

  private async doHello(timeoutMs: number): Promise<void> {
    const opId = nextOpId("hello", this.seq);
    const pending = this.waitFor(opId, new Set(["hello_ok", "hello_error", "error"]), timeoutMs);
    this.send({
      v: 1,
      kind: "hello",
      opId,
      host: { id: "orca", version: "native-1.8", protocol: 1 },
      workspaceRoot: "/tmp/pi-native-hello",
    });
    const reply = await pending;
    if (reply.kind === "hello_ok") return;
    const detail =
      reply.kind === "hello_error" || reply.kind === "error"
        ? `${(reply as { error?: { code?: string; message?: string } }).error?.code ?? reply.kind}: ${(reply as { error?: { message?: string } }).error?.message ?? ""}`
        : reply.kind;
    this.helloFailed = `native Pi provider hello failed: ${detail} (fall back to Pi TUI)`;
    throw new Error(this.helloFailed);
  }

  async acquire(input: PiNativeAcquireInput): Promise<PiNativeAcquireResult> {
    if (!input.workspaceRoot || input.workspaceRoot.trim() === "") {
      throw new Error("BAD_WORKSPACE: acquire requires a non-empty workspaceRoot");
    }
    // SNC1.10 acquire-time compatibility gate: enforced before the hello
    // handshake and any Pi child creation, so a refused gate never starts
    // structured Pi (fail closed to Pi TUI with an actionable code).
    if (input.compat !== undefined) {
      const verdict = checkAcquireCompat(input.compat, this.capabilities);
      if (!verdict.allowed) {
        throw new Error(`${verdict.code}: ${verdict.reason} (use Pi TUI)`);
      }
    }
    await this.ensureHello();
    const opId = nextOpId("acq", this.seq);
    const pending = this.waitFor(opId, new Set(["acquired", "error"]), PI_NATIVE_REQUEST_TIMEOUT_MS);
    this.send({
      v: 1,
      kind: "acquire",
      opId,
      workspaceRoot: input.workspaceRoot,
      ...(input.resumePath !== undefined ? { resumePath: input.resumePath } : {}),
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(input.options !== undefined ? { options: input.options } : {}),
      // Forwarded so the inner provider enforces the same pre-spawn gate
      // (including `requireCompat` evidence) on this path too.
      ...(input.compat !== undefined ? { compat: { ...input.compat } } : {}),
    });
    const reply = await pending;
    if (reply.kind === "acquired") {
      const acquired = reply as { sessionId: string; resumed: boolean; metadata: BridgeSessionMetadata };
      return { sessionId: acquired.sessionId, resumed: acquired.resumed, metadata: { ...acquired.metadata } };
    }
    const err = reply as { error?: { code?: string; message?: string } };
    throw new Error(`${err.error?.code ?? "ACQUIRE_FAILED"}: ${err.error?.message ?? "acquire failed"}`);
  }

  async dispatch(input: PiNativeDispatchInput & { opId?: string }): Promise<PiNativeDispatchResult> {
    await this.ensureHello();
    const opId = input.opId ?? nextOpId("dsp", this.seq);
    const pending = this.waitFor(opId, new Set(["dispatch_ack", "error"]), PI_NATIVE_REQUEST_TIMEOUT_MS);
    this.send({
      v: 1,
      kind: "dispatch",
      opId,
      sessionId: input.sessionId,
      message: {
        text: input.text,
        ...(input.images && input.images.length > 0 ? { images: input.images } : {}),
      },
      ...(input.queue ? { queue: input.queue } : {}),
    });
    const reply = await pending;
    if (reply.kind === "dispatch_ack") {
      const ack = reply as { sessionId: string; status: "accepted" | "rejected" | "unknown"; reason?: string };
      // Preserve the honest delivery invariant verbatim: `accepted` only
      // when Pi definitely owns the prompt, `rejected` only for definite
      // refusal, `unknown` for ambiguous Pi prompt delivery (may have
      // landed — reconcile via history, never auto-resend). Coercing
      // `unknown` to `rejected` would let a caller retry as fresh work and
      // duplicate a landed user turn.
      if (ack.status === "accepted") return { status: "accepted", sessionId: ack.sessionId };
      if (ack.status === "unknown") {
        return { status: "unknown", sessionId: ack.sessionId, reason: ack.reason ?? "pi-prompt-ambiguous (reconcile via history; do not auto-resend)" };
      }
      return { status: "rejected", sessionId: ack.sessionId, reason: ack.reason ?? "rejected" };
    }
    const err = reply as { error?: { code?: string; message?: string }; sessionId?: string };
    // The bridge synthesizes `unknown` on the host for ambiguous delivery;
    // in-process, an `error` for the dispatch op means the same ambiguity.
    // Preserve the honest contract: never auto-resend, reconcile via history.
    return {
      status: "unknown",
      sessionId: err.sessionId ?? input.sessionId,
      reason: `${err.error?.code ?? "dispatch-error"}: ${err.error?.message ?? "ambiguous delivery (reconcile via history)"}`,
    };
  }

  async cancel(sessionId: string, targetOpId?: string): Promise<{ settled: boolean; targetOpId: string }> {
    await this.ensureHello();
    const opId = nextOpId("cnl", this.seq);
    const pending = this.waitFor(opId, new Set(["cancelled", "error"]), PI_NATIVE_REQUEST_TIMEOUT_MS);
    this.send({
      v: 1,
      kind: "cancel",
      opId,
      sessionId,
      ...(targetOpId !== undefined ? { targetOpId } : {}),
    });
    const reply = await pending;
    if (reply.kind === "cancelled") {
      const done = reply as { targetOpId: string; settled: boolean };
      return { settled: done.settled, targetOpId: done.targetOpId };
    }
    const err = reply as { error?: { code?: string; message?: string } };
    throw new Error(`${err.error?.code ?? "CANCEL_FAILED"}: ${err.error?.message ?? "cancel failed"}`);
  }

  /**
   * Answer an interactive prompt exactly once. Resolves on the benign
   * `ANSWERED` ack; throws `UNKNOWN_REQUEST` for stale/late/retired ids.
   */
  async answerPrompt(requestId: string, value?: unknown, cancelled = false): Promise<void> {
    await this.ensureHello();
    const opId = nextOpId("ans", this.seq);
    const pending = this.waitFor(opId, new Set(["error"]), PI_NATIVE_REQUEST_TIMEOUT_MS);
    this.send({
      v: 1,
      kind: "answer_prompt",
      opId,
      requestId,
      cancelled,
      ...(cancelled ? {} : { value }),
    });
    const reply = (await pending) as { error?: { code?: string; message?: string } };
    if (reply.error?.code === "ANSWERED") return;
    throw new Error(`${reply.error?.code ?? "ANSWER_FAILED"}: ${reply.error?.message ?? "answer failed"}`);
  }

  async setOptions(sessionId: string, options: BridgeSessionOptions): Promise<BridgeSessionOptions> {
    await this.ensureHello();
    const opId = nextOpId("opt", this.seq);
    const pending = this.waitFor(opId, new Set(["options_updated", "error"]), PI_NATIVE_REQUEST_TIMEOUT_MS);
    this.send({ v: 1, kind: "set_options", opId, sessionId, options });
    const reply = await pending;
    if (reply.kind === "options_updated") {
      return { ...((reply as { options: BridgeSessionOptions }).options ?? {}) };
    }
    const err = reply as { error?: { code?: string; message?: string } };
    throw new Error(`${err.error?.code ?? "OPTION_FAILED"}: ${err.error?.message ?? "set options failed"}`);
  }

  async getHistory(
    sessionId: string,
    cursor?: string,
    limit?: number,
  ): Promise<{ entries: BridgeHistoryEntry[]; nextCursor?: string; leafId?: string }> {
    await this.ensureHello();
    const opId = nextOpId("his", this.seq);
    const pending = this.waitFor(opId, new Set(["history", "error"]), PI_NATIVE_REQUEST_TIMEOUT_MS);
    this.send({
      v: 1,
      kind: "get_history",
      opId,
      sessionId,
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    const reply = await pending;
    if (reply.kind === "history") {
      const h = reply as { entries: BridgeHistoryEntry[]; nextCursor?: string; leafId?: string };
      return {
        entries: [...h.entries],
        ...(h.nextCursor !== undefined ? { nextCursor: h.nextCursor } : {}),
        ...(h.leafId !== undefined ? { leafId: h.leafId } : {}),
      };
    }
    const err = reply as { error?: { code?: string; message?: string } };
    throw new Error(`${err.error?.code ?? "HISTORY_FAILED"}: ${err.error?.message ?? "get history failed"}`);
  }

  async getSession(sessionId: string): Promise<BridgeSessionMetadata> {
    await this.ensureHello();
    const opId = nextOpId("ses", this.seq);
    const pending = this.waitFor(opId, new Set(["session", "error"]), PI_NATIVE_REQUEST_TIMEOUT_MS);
    this.send({ v: 1, kind: "get_session", opId, sessionId });
    const reply = await pending;
    if (reply.kind === "session") {
      return { ...((reply as { metadata: BridgeSessionMetadata }).metadata ?? {}) } as BridgeSessionMetadata;
    }
    const err = reply as { error?: { code?: string; message?: string } };
    throw new Error(`${err.error?.code ?? "SESSION_FAILED"}: ${err.error?.message ?? "get session failed"}`);
  }

  /**
   * Full model catalog seam (SNC1.8 — bridge v1 has no catalog response).
   * Reads the live `get_available_models` from the session's actual Pi
   * connection via `bridge.getPiConnection(sessionId)`, so both the default
   * production factory and injected test factories are covered (keyed by
   * session, never via a global newest-connection heuristic). Returns an
   * honest empty list only on minimal transports (never synthesized).
   */
  async listModels(sessionId: string, timeoutMs = 8_000): Promise<PiModel[]> {
    const conn = this.bridge.getPiConnection(sessionId);
    if (!conn || typeof conn.getAvailableModels !== "function") return [];
    try {
      const listed = await conn.getAvailableModels({ timeoutMs });
      const models = (listed?.models ?? []) as PiModel[];
      return models.map((m) => ({ ...m }));
    } catch {
      return [];
    }
  }

  /** Live thinking levels for the session's current Pi model (honest empty on minimal transports). */
  async listThinkingLevels(sessionId: string, timeoutMs = 8_000): Promise<string[]> {
    const conn = this.bridge.getPiConnection(sessionId);
    if (!conn || typeof conn.getAvailableThinkingLevels !== "function") return [];
    try {
      const listed = await conn.getAvailableThinkingLevels({ timeoutMs });
      return [...((listed?.levels ?? []) as string[])];
    } catch {
      return [];
    }
  }

  async release(sessionId: string): Promise<void> {
    await this.ensureHello();
    const opId = nextOpId("rel", this.seq);
    const pending = this.waitFor(opId, new Set(["released", "error"]), PI_NATIVE_REQUEST_TIMEOUT_MS);
    this.send({ v: 1, kind: "release", opId, sessionId });
    const reply = await pending;
    if (reply.kind === "released") {
      return;
    }
    const err = reply as { error?: { code?: string; message?: string } };
    throw new Error(`${err.error?.code ?? "RELEASE_FAILED"}: ${err.error?.message ?? "release failed"}`);
  }

  async close(sessionId?: string, mode: "graceful" | "force" = "graceful"): Promise<void> {
    await this.ensureHello();
    const opId = nextOpId("clo", this.seq);
    const pending = this.waitFor(opId, new Set(["closed", "error"]), PI_NATIVE_REQUEST_TIMEOUT_MS);
    this.send({ v: 1, kind: "close", opId, mode, ...(sessionId !== undefined ? { sessionId } : {}) });
    const reply = await pending;
    if (reply.kind === "closed") {
      return;
    }
    const err = reply as { error?: { code?: string; message?: string } };
    throw new Error(`${err.error?.code ?? "CLOSE_FAILED"}: ${err.error?.message ?? "close failed"}`);
  }

  /** Bounded teardown with no resident Pi children (joins Orca teardown). */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.waiters.clear();
    this.eventHandlers.clear();
    await this.bridge.dispose().catch(() => undefined);
  }

  private send(msg: HostToProviderMessage): void {
    // Drive the proven provider synchronously through its line handler; the
    // async `onMessage` work resolves via `handleProviderMessage` below.
    this.bridge.onLine(JSON.stringify(msg));
  }

  private waitFor(opId: string, kinds: ReadonlySet<string>, timeoutMs: number): Promise<ProviderToHostMessage> {
    // Correlated waiter only: every caller registers `waitFor()` BEFORE
    // `send()`, so the reply cannot land before subscription and no
    // reply-history buffer is needed. Deliberately unbounded-free: streaming
    // `session_event`s and `history` payloads are never retained here (they
    // go only to `eventHandlers` or the awaiting caller), so a long-lived
    // Orca process cannot grow this provider without bound.
    return new Promise<ProviderToHostMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(opId);
        reject(new Error(`TIMEOUT: native Pi provider timed out waiting for ${[...kinds].join("/")} (op ${opId})`));
      }, timeoutMs);
      this.waiters.set(opId, {
        kinds,
        resolve: (msg) => {
          clearTimeout(timer);
          this.waiters.delete(opId);
          resolve(msg);
        },
      });
    });
  }

  private handleProviderMessage(msg: ProviderToHostMessage): void {
    if (msg.kind === "session_event") {
      const envelope: PiNativeSessionEventEnvelope = {
        sessionId: (msg as { sessionId: string }).sessionId,
        ...(((msg as { opId?: string }).opId !== undefined
          ? { opId: (msg as { opId?: string }).opId! }
          : {}) as { opId?: string }),
        event: (msg as { event: BridgeProviderEvent }).event,
      };
      for (const handler of [...this.eventHandlers]) {
        try {
          handler(envelope);
        } catch {
          // A throwing subscriber must never break provider delivery.
        }
      }
      return;
    }
    const opId = (msg as { opId?: string }).opId;
    if (typeof opId === "string") {
      const waiter = this.waiters.get(opId);
      if (waiter && waiter.kinds.has(msg.kind)) {
        waiter.resolve(msg);
      }
    }
    // Provider lifecycle (`exiting`) needs no native action: per-session Pi
    // exits already surface as shaped `turn_end{error}` + `settled` plus
    // `rejected: pi-exited (reacquire)` on the next dispatch, matching the
    // bridge fail-closed semantics Orca relies on for TUI fallback.
  }
}

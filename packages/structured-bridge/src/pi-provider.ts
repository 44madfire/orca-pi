/**
 * Pi-backed external provider (SNC1.4, orca-pi owned).
 *
 * Combines the production SNC1.2 `PiRpcConnection` transport with the SNC1.3
 * external structured-session bridge to run the first real Pi structured
 * Native Chat session in Orca. This file is **never vendored into Orca core**:
 * the fork vendors only `framing.ts` + `protocol.ts` + `host.ts`
 * (provider-neutral). Everything Pi stays here plus `pi-mapping.ts`.
 *
 * Capabilities (per #14):
 * - spawn/acquire `pi --mode rpc` in the exact Orca-selected workspace/cwd;
 * - apply compatible transport-neutral resolved Pi profile configuration
 *   (callers pass a `buildPiLaunch()` spec via `resolvePiSpec`; TUI-only
 *   flags are rejected via `toPiRpcProcessSpec`; `--mode rpc` is appended
 *   idempotently; no terminal keystroke injection on the structured path);
 * - publish provider/session/process identity required by Orca's structured
 *   lease (`hello_ok{provider:{id:"pi"}}` + `acquired{metadata}` with
 *   `providerSessionId` from Pi `get_state`, `workspaceRoot`, model,
 *   thinking, counts, `isStreaming`, `createdAt`);
 * - dispatch one text message through Pi RPC (`prompt` accept = `accepted`,
 *   definite `success:false` = `rejected`, transport ambiguity = `unknown`;
 *   never auto-resend `unknown`);
 * - stream assistant text into the normal Orca structured journal/UI via
 *   `session_event` (`turn_start`/`text_*`/`turn_end`/`settled`);
 * - report turn start/settlement/idle accurately (`isStreaming` follows the
 *   active turn; `cancelled.settled` reports actual state);
 * - cancel an active turn using Pi RPC (`abort`);
 * - graceful and forced teardown with observed process exit
 *   (`PiRpcConnection.close()` + provider SIGTERM/stdin-EOF handling; no
 *   leaked Pi/helper processes or listeners);
 * - startup/auth/model failures surface as actionable structured-session
 *   failures (secret-safe, no prompt text);
 * - no terminal keystroke injection anywhere on this path.
 *
 * Delivery semantics: `accepted` only when Pi definitely owns the prompt
 * (`prompt success:true` on an idle session), `rejected` only for definite
 * provider refusal (`success:false`, empty text, unknown session, busy turn
 * including `steer`/`followUp` while streaming), `unknown` for ambiguous
 * transport/delivery outcomes (timeout, exit, malformed ack). Callers must
 * reconcile `unknown` via history before retrying; the provider never
 * auto-resends.
 *
 * Scope: SNC1.4 is basic text chat, one turn at a time. Queued delivery while
 * busy (`steer`/`followUp` accepted via Pi-owned queue) is honestly rejected
 * here and deferred to SNC1.5: proving Pi owns a future turn needs
 * user-message/`queue_update` evidence plus retry/compaction boundaries that
 * belong to the lifecycle translator — guessing from turn boundaries
 * misattributes turns and fabricates history. Thinking/tool/error/lifecycle
 * translation beyond text + turn + cancel is SNC1.5; model/thinking
 * controls, prompts, images are SNC1.6; history/branch/resume is SNC1.7.
 * `set_options` stores options and acks (Pi apply lands in SNC1.6);
 * `get_history`/`get_session` serve the live-turn journal (Pi tree
 * reconstruction lands in SNC1.7).
 */

import {
  PiRpcConnection,
  redactSecrets,
  resolvePiRpcEnv,
  toPiRpcProcessSpec,
  type PiImageAttachment,
  type PiRpcCloseOptions,
  type PiRpcConnectionOptions,
  type PiRpcCloseResult,
  type PiRpcSpawnFn,
  type PiServerEvent,
  type PiSessionStats,
  type PiState,
  type PiStreamingBehavior,
  type ResolvedPiSpecLike,
} from "@orca-pi/pi-rpc";
import {
  BRIDGE_PROTOCOL_VERSION,
  redactSecretsFromText,
  type AcquireRequest,
  type BridgeCapabilities,
  type BridgeSessionMetadata,
  type BridgeSessionOptions,
  type DispatchRequest,
  type HostToProviderMessage,
} from "./protocol.js";
import { BridgeProvider, type ProviderSession } from "./provider.js";
import {
  mapBridgeDispatchToPiPrompt,
  mapPiRecordToBridgeEvents,
  piBridgeCapabilities,
  validatePiDispatch,
} from "./pi-mapping.js";

/** Minimal Pi connection surface used by the bridge (real `PiRpcConnection` satisfies it). */
export interface PiProviderConnection {
  start(): Promise<void>;
  prompt(
    message: string,
    opts?: {
      images?: readonly PiImageAttachment[];
      streamingBehavior?: PiStreamingBehavior;
      timeoutMs?: number;
    },
  ): Promise<void>;
  abort(opts?: { timeoutMs?: number }): Promise<void>;
  close(graceMs?: number, opts?: PiRpcCloseOptions): Promise<PiRpcCloseResult>;
  onEvent(handler: (event: PiServerEvent) => void): () => void;
  onExit(handler: (info: PiRpcCloseResult) => void): () => void;
  getState(): Promise<PiState>;
  respondToExtensionUi(response: { type: "extension_ui_response"; id: string; value?: unknown; confirmed?: boolean; cancelled?: boolean }): void;
  readonly isClosed: boolean;
}

export type PiConnectionFactory = (opts: PiRpcConnectionOptions) => PiProviderConnection;

export type PiSpecResolver = (ctx: {
  workspaceRoot: string;
  sessionId: string;
  options?: BridgeSessionOptions;
}) => ResolvedPiSpecLike | Promise<ResolvedPiSpecLike>;

export interface PiBridgeProviderOptions {
  /** Bridge identity override (default `pi` / `0.1.0` / `piBridgeCapabilities()`). */
  providerId?: string;
  providerVersion?: string;
  capabilities?: BridgeCapabilities;
  /** Pi executable (default `"pi"`). Honored when `resolvePiSpec` is absent. */
  piCommand?: string;
  /** Extra argv before `--mode rpc` (should come from `buildPiLaunch()`). */
  piArgs?: readonly string[];
  /** Explicit env overlay for Pi spawn only; never sent over the bridge. */
  piEnv?: NodeJS.ProcessEnv;
  /** Low-level spawn hook for Pi children (tests/fakes). Passed to `PiRpcConnection`. */
  spawnFn?: PiRpcSpawnFn;
  /** Default per-request deadline for Pi RPC (default 30s in `PiRpcConnection`). */
  defaultTimeoutMs?: number;
  /** Spawn/startup classification window for Pi (default 15s). */
  startupTimeoutMs?: number;
  /** Grace for per-session Pi teardown (default 2000ms). */
  closeGraceMs?: number;
  /** Inject a fake Pi connection (tests). Default constructs a real `PiRpcConnection`. */
  createConnection?: PiConnectionFactory;
  /**
   * Resolve the transport-neutral Pi spec per session (e.g. via core's
   * `buildPiLaunch(profile, { projectRoot: workspaceRoot, cwd: workspaceRoot })`).
   * Must already be transport-neutral; TUI-only flags are rejected and
   * `--mode rpc` is appended idempotently via `toPiRpcProcessSpec`.
   * When absent, `{ command: piCommand ?? "pi", args: piArgs ?? [] }` is used.
   */
  resolvePiSpec?: PiSpecResolver;
}

interface PiRuntime {
  conn: PiProviderConnection;
  unsubs: Array<() => void>;
  /** Accumulated assistant text for the active turn (for `get_history`). */
  activeText: string;
  /** Pi-side session id observed via `get_state` (for lease identity). */
  piSessionId?: string;
  // SNC1.4 basic text runs one turn at a time: while a turn streams, queued
  // `steer`/`followUp` dispatches are honestly rejected (never
  // accepted-before-owned). Pi-owned queue fidelity — mode-specific delivery,
  // user-message and `queue_update` evidence, retry/compaction boundaries,
  // immediate-command classification, ordered ambiguous candidates — needs the
  // SNC1.5 lifecycle translator, so it is deferred there (see `onPiDispatch`
  // busy branch) rather than guessed from turn boundaries here.
  /**
   * Optimistic user text for an ambiguous idle `prompt` (write may have landed
   * but the response was lost). NOT journaled yet: `turn_start` (receipt proof)
   * or `turn_end` journals it first, preserving user-before-assistant order, so
   * `get_history` never fabricates a user entry Pi never received. Cleared on
   * definite refusal, successful journaling, or idle reconciliation.
   */
  pendingUserText: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeCode(text: string): string {
  // Secret-safe one-line diagnostic: single line, then both redactors (Pi RPC
  // secrets/paths plus bridge bearer/key patterns), bounded to 220 chars.
  // Never carries prompt text — callers pass only codes and safe summaries.
  const clean = text.replace(/[\r\n]+/g, " ").trim();
  return redactSecretsFromText(redactSecrets(clean), 220);
}

const DEFAULT_CLOSE_GRACE_MS = 2000;

/** Aggregate observed child exits: first signaled/non-zero result wins, then
 * unobserved `{null,null}` (unknown is preserved, never laundered to clean),
 * else clean. */
function aggregateExits(exits: Array<{ code: number | null; signal: string | null }>): { code: number | null; signal: string | null } {
  let sawUnknown = false;
  for (const exit of exits) {
    if (exit.signal !== null || (exit.code !== null && exit.code !== 0)) return { code: exit.code, signal: exit.signal };
    if (exit.code === null && exit.signal === null) sawUnknown = true;
  }
  if (sawUnknown) return { code: null, signal: null };
  return { code: 0, signal: null };
}

export class PiBridgeProvider extends BridgeProvider {
  private readonly piRuntimes = new Map<string, PiRuntime>();
  private readonly piCommand: string;
  private readonly piArgs: readonly string[];
  private readonly piEnv?: NodeJS.ProcessEnv;
  private readonly piSpawnFn?: PiRpcSpawnFn;
  private readonly defaultTimeoutMs?: number;
  private readonly startupTimeoutMs?: number;
  private readonly piCloseGraceMs: number;
  private readonly createConnection: PiConnectionFactory;
  private readonly resolvePiSpec?: PiSpecResolver;

  constructor(opts: PiBridgeProviderOptions = {}) {
    // SNC1.4 truthfulness: model/thinking controls are SNC1.6 and
    // history/branch/resume is SNC1.7, so `options`/`resume` stay false until
    // those translators land — otherwise Orca would expose controls and resume
    // paths that silently diverge from actual Pi child state.
    const snc14Capabilities: BridgeCapabilities = { ...piBridgeCapabilities(), options: false, resume: false };
    super({
      providerId: opts.providerId ?? "pi",
      providerVersion: opts.providerVersion ?? "0.1.0",
      capabilities: opts.capabilities ?? snc14Capabilities,
    });
    this.piCommand = opts.piCommand ?? "pi";
    this.piArgs = opts.piArgs ?? [];
    this.piEnv = opts.piEnv;
    this.piSpawnFn = opts.spawnFn;
    if (opts.defaultTimeoutMs !== undefined) this.defaultTimeoutMs = opts.defaultTimeoutMs;
    if (opts.startupTimeoutMs !== undefined) this.startupTimeoutMs = opts.startupTimeoutMs;
    this.piCloseGraceMs = opts.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
    this.resolvePiSpec = opts.resolvePiSpec;
    this.createConnection =
      opts.createConnection ??
      ((connOpts: PiRpcConnectionOptions): PiProviderConnection => {
        const real = new PiRpcConnection(connOpts);
        return real as unknown as PiProviderConnection;
      });
  }

  /** Active Pi runtime count (tests/diagnostics; never sent over the bridge). */
  get piSessionCount(): number {
    return this.piRuntimes.size;
  }

  protected override async onMessage(msg: HostToProviderMessage): Promise<void> {
    switch (msg.kind) {
      case "acquire":
        await this.onPiAcquire(msg);
        return;
      case "release":
        await this.onPiRelease(msg.opId, msg.sessionId);
        return;
      case "dispatch":
        await this.onPiDispatch(msg);
        return;
      case "cancel":
        this.onPiCancel(msg.opId, msg.sessionId, msg.targetOpId);
        return;
      case "close":
        await this.onPiClose(msg.opId, msg.sessionId, msg.mode);
        return;
      default:
        await super.onMessage(msg);
        return;
    }
  }

  // -- acquire: spawn pi --mode rpc in the Orca-selected workspace/cwd -----

  private async onPiAcquire(msg: AcquireRequest): Promise<void> {
    if (!this.requireHello(msg.opId)) return;
    if (!msg.workspaceRoot || msg.workspaceRoot.trim() === "") {
      this.send({
        v: BRIDGE_PROTOCOL_VERSION,
        kind: "error",
        opId: msg.opId,
        error: { code: "BAD_WORKSPACE", message: "acquire requires a non-empty workspaceRoot (Orca-selected cwd)" },
      });
      return;
    }
    const sessionId = msg.sessionId ?? this.newId("ses");
    const existing = this.sessions.get(sessionId);
    const existingRuntime = this.piRuntimes.get(sessionId);
    if (existing && msg.sessionId && existingRuntime && !existingRuntime.conn.isClosed) {
      // Explicit resume of a live Pi session: refresh lease metadata best-effort.
      await this.refreshMetadataBestEffort(sessionId);
      const current = this.sessions.get(sessionId);
      if (current) {
        this.send({ v: 1, kind: "acquired", opId: msg.opId, sessionId, resumed: true, metadata: { ...current.metadata } });
        return;
      }
    }
    if (existing && msg.sessionId && (!existingRuntime || existingRuntime.conn.isClosed)) {
      // Stale session entry whose Pi child died: drop it so a fresh Pi can
      // take the same id explicitly (restart-independence per session).
      await this.teardownPiRuntime(sessionId);
      this.sessions.delete(sessionId);
    }

    // Resolve the transport-neutral spec (profile compiler output when
    // provided), validate TUI exclusion, and append `--mode rpc`.
    let resolved: ResolvedPiSpecLike;
    try {
      resolved = this.resolvePiSpec
        ? await this.resolvePiSpec({ workspaceRoot: msg.workspaceRoot, sessionId, ...(msg.options ? { options: msg.options } : {}) })
        : { command: this.piCommand, args: [...this.piArgs, ...this.augmentArgsForOptions(msg.options)] };
    } catch (error) {
      this.send({
        v: BRIDGE_PROTOCOL_VERSION,
        kind: "error",
        opId: msg.opId,
        error: { code: "PI_SPEC_FAILED", message: this.safeSpecError(error) },
      });
      return;
    }
    // Force the exact Orca-selected workspace/cwd: the spec cwd is always
    // the acquire workspaceRoot, never the provider process cwd.
    const withCwd: ResolvedPiSpecLike = { ...resolved, cwd: msg.workspaceRoot };
    let rpcSpec: { command: string; args: readonly string[]; cwd?: string; env?: Readonly<Record<string, string>> };
    try {
      rpcSpec = toPiRpcProcessSpec(withCwd);
    } catch {
      // Stable summary only: the transport quotes the offending argv element,
      // which can embed absolute paths or arbitrary values that pattern
      // redaction cannot make safe. Details stay provider-side.
      this.send({
        v: BRIDGE_PROTOCOL_VERSION,
        kind: "error",
        opId: msg.opId,
        error: {
          code: "PI_TUI_FLAG",
          message: "Pi launch rejects TUI-only flags. Use the typed RPC commands (e.g. switch_session) instead of CLI pickers/themes.",
        },
      });
      return;
    }

    // Merge transport-neutral spec env with the explicit provider overlay
    // through the Pi RPC helper so ambient auth/config/PATH survives.
    // `spec.env` is an overlay (default `{}` from `buildPiLaunch`, never a
    // complete environment); `piEnv` wins on conflict (dev override beats
    // profile-derived config). Both ride the spawn env only, never the bridge.
    const overlay: Record<string, string | undefined> = { ...(rpcSpec.env ?? {}), ...(this.piEnv ?? {}) };
    const mergedEnv: NodeJS.ProcessEnv = resolvePiRpcEnv(overlay, process.env);
    const conn = this.createConnection({
      piCommand: rpcSpec.command,
      piArgs: [...rpcSpec.args],
      ...(rpcSpec.cwd !== undefined ? { cwd: rpcSpec.cwd } : { cwd: msg.workspaceRoot }),
      ...(mergedEnv !== undefined ? { env: mergedEnv } : {}),
      ...(this.piSpawnFn !== undefined ? { spawnFn: this.piSpawnFn } : {}),
      ...(this.defaultTimeoutMs !== undefined ? { defaultTimeoutMs: this.defaultTimeoutMs } : {}),
      ...(this.startupTimeoutMs !== undefined ? { startupTimeoutMs: this.startupTimeoutMs } : {}),
    });

    try {
      await conn.start();
    } catch (error) {
      try {
        await conn.close(0).catch(() => undefined);
      } catch {
        // Best-effort: start() already kills + detaches on failure.
      }
      this.send({
        v: BRIDGE_PROTOCOL_VERSION,
        kind: "error",
        opId: msg.opId,
        error: { code: "PI_STARTUP_FAILED", message: sanitizeCode(this.classifyStartupError(error)) },
      });
      return;
    }

    // Publish lease identity from Pi itself (`get_state`): provider session
    // id, model, thinking, counts, streaming. Failures here are actionable
    // (Pi started but is not answering RPC) — do not acquire blindly.
    let state: PiState;
    try {
      state = await conn.getState();
    } catch (error) {
      await conn.close(this.piCloseGraceMs).catch(() => undefined);
      this.send({
        v: BRIDGE_PROTOCOL_VERSION,
        kind: "error",
        opId: msg.opId,
        error: { code: "PI_STATE_FAILED", message: sanitizeCode(`Pi started but get_state failed: ${this.shortPiError(error)}`) },
      });
      return;
    }

    const piSessionId = typeof state.sessionId === "string" && state.sessionId !== "" ? state.sessionId : sessionId;
    const model = typeof state.model?.id === "string" ? state.model.id : msg.options?.model;
    const thinkingLevel = typeof state.thinkingLevel === "string" ? state.thinkingLevel : msg.options?.thinkingLevel;
    const messageCount = typeof state.messageCount === "number" ? state.messageCount : 0;
    const metadata: BridgeSessionMetadata = {
      sessionId,
      providerSessionId: piSessionId,
      workspaceRoot: msg.workspaceRoot,
      messageCount,
      isStreaming: false,
      createdAt: nowIso(),
      ...(model ? { model } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
    };
    this.sessions.set(sessionId, {
      metadata,
      history: [],
      options: { ...(msg.options ?? {}) },
      activeOpId: null,
      queue: [],
      cancelledOps: new Set<string>(),
      pendingPrompt: null,
      entryCounter: 0,
    });
    const runtime: PiRuntime = { conn, unsubs: [], activeText: "", piSessionId, pendingUserText: null };
    this.piRuntimes.set(sessionId, runtime);
    const session = this.sessions.get(sessionId);
    if (session) this.attachPiStreaming(sessionId, session, runtime);
    // Observe Pi exit so an dead child never leaves a stuck streaming turn.
    const onExit = (info: PiRpcCloseResult): void => {
      this.onPiExit(sessionId, info);
    };
    try {
      runtime.unsubs.push(conn.onExit(onExit));
    } catch {
      // Minimal fakes may omit onExit; unexpected death then surfaces as
      // ambiguous prompt/cancel failures (still honest `unknown`).
    }
    this.send({ v: 1, kind: "acquired", opId: msg.opId, sessionId, resumed: false, metadata: { ...metadata } });
  }

  /** Extra `--model`/`--thinking` from acquire options (launch-time only). */
  private augmentArgsForOptions(options?: BridgeSessionOptions): string[] {
    const extra: string[] = [];
    if (options?.model && !this.piArgs.includes("--model")) extra.push("--model", options.model);
    if (options?.thinkingLevel && !this.piArgs.includes("--thinking")) extra.push("--thinking", options.thinkingLevel);
    return extra;
  }

  /** Secret-safe Pi failure summary: `PiRpcError` messages are safe by
   * construction (command name + id + redacted tail, never prompt text), so
   * only those are quoted — foreign error text is never forwarded because it
   * can carry prompt fragments, paths, or token-like values. */
  private safePiDetail(error: unknown): string | null {
    const maybe = error as { toSecretSafeString?: unknown } | null;
    if (maybe && typeof maybe.toSecretSafeString === "function") {
      try {
        const summary = (maybe.toSecretSafeString as () => unknown)();
        if (typeof summary === "string" && summary !== "") return sanitizeCode(summary);
      } catch {
        // Fall through to code-only generic below.
      }
    }
    return null;
  }

  /** Stable summary for resolver failures: machine-readable code plus generic
   * guidance, never the exception text (`PiLaunchError` intentionally carries
   * resolved absolute paths and foreign filesystem messages that pattern
   * redaction cannot make safe). Details stay provider-side. */
  private safeSpecError(error: unknown): string {
    const code = (error as { code?: unknown })?.code;
    if (typeof code === "string" && code !== "") {
      return sanitizeCode(`Pi spec resolution failed (${code}). Check profile paths and retry.`);
    }
    return sanitizeCode("Pi spec resolution failed. Check profile configuration and retry.");
  }

  private classifyStartupError(error: unknown): string {
    const code = (error as { code?: unknown })?.code;
    const detail = this.safePiDetail(error);
    const suffix = detail ? ` ${detail}` : "";
    if (code === "spawn-failed") return `Pi executable not found or not runnable (spawn-failed). Install Pi on PATH or set an explicit Pi command.${suffix}`;
    if (code === "startup-failed") return `Pi exited during startup (startup-failed). Check auth/model/config.${suffix}`;
    if (code === "startup-timeout") return `Pi did not become ready in time (startup-timeout). Check model/auth and retry.${suffix}`;
    return `Pi failed to start.${suffix}`;
  }

  private shortPiError(error: unknown): string {
    const detail = this.safePiDetail(error);
    if (detail) return detail;
    const code = (error as { code?: unknown })?.code;
    return sanitizeCode(typeof code === "string" ? code : "pi-error");
  }

  private async refreshMetadataBestEffort(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    const runtime = this.piRuntimes.get(sessionId);
    if (!session || !runtime || runtime.conn.isClosed) return;
    try {
      const state = await runtime.conn.getState();
      if (typeof state.sessionId === "string" && state.sessionId !== "") session.metadata.providerSessionId = state.sessionId;
      if (typeof state.model?.id === "string") session.metadata.model = state.model.id;
      if (typeof state.thinkingLevel === "string") session.metadata.thinkingLevel = state.thinkingLevel;
      if (typeof state.messageCount === "number") session.metadata.messageCount = state.messageCount;
      session.metadata.isStreaming = session.activeOpId !== null;
    } catch {
      // Best-effort: keep cached lease identity rather than failing resume.
    }
  }

  // -- streaming: Pi events -> bridge session_event --------------------------
  //
  // SNC1.4 runs one turn at a time (queued delivery while busy is honestly
  // rejected; see `onPiDispatch`). Attribution therefore never guesses across
  // queued ops from turn boundaries: every streamed event carries the single
  // active dispatch op, `turn_end` journals its turn, and the authoritative Pi
  // `agent_settled` completes it. Mode-specific queued delivery, user-message
  // and `queue_update` evidence, and retry/compaction boundaries belong to the
  // SNC1.5 lifecycle translator.

  private attachPiStreaming(sessionId: string, session: ProviderSession, runtime: PiRuntime): void {
    const onEvent = (event: PiServerEvent): void => {
      const activeOpId = session.activeOpId;
      // No active turn: only forward stateless chrome that Orca can use
      // without a turn (currently none — queue_update/compaction are SNC1.5+).
      // Dialogs arriving without an active turn are still actionable: emit
      // them without an opId so Orca can answer via requestId.
      let mapped: ReturnType<typeof mapPiRecordToBridgeEvents>;
      try {
        mapped = mapPiRecordToBridgeEvents(event as unknown as Record<string, unknown>);
      } catch {
        return;
      }
      for (const bridgeEvent of mapped) {
        if (bridgeEvent.type === "text_end" && typeof bridgeEvent.text === "string") {
          // Accumulate authoritative text for history; deltas stay streaming-only.
          runtime.activeText += bridgeEvent.text;
        } else if (bridgeEvent.type === "text_delta") {
          // Deltas stream to the UI but are not journaled until text_end.
        }
        if (bridgeEvent.type === "prompt_request") {
          const currentOp = session.activeOpId ?? activeOpId ?? "";
          session.pendingPrompt = { requestId: bridgeEvent.requestId, opId: currentOp };
          this.send({
            v: 1,
            kind: "session_event",
            sessionId,
            ...(currentOp ? { opId: currentOp } : {}),
            event: bridgeEvent,
          });
          continue;
        }
        if (bridgeEvent.type === "turn_start") {
          // Authoritative receipt proof for an ambiguous idle prompt: Pi
          // started the turn, so journal the pending user now (before any
          // assistant text) so a later exit-before-`turn_end` still leaves
          // history evidence that prevents a duplicate retry.
          const currentOp = session.activeOpId ?? activeOpId;
          if (currentOp && runtime.pendingUserText !== null) {
            this.appendHistory(session, { role: "user", text: runtime.pendingUserText });
            runtime.pendingUserText = null;
            session.metadata.messageCount = session.history.filter((e) => e.role === "user" || e.role === "assistant").length;
          }
          const opForEvent = session.activeOpId ?? currentOp;
          if (!opForEvent) continue;
          this.send({ v: 1, kind: "session_event", sessionId, opId: opForEvent, event: bridgeEvent });
          continue;
        }
        if (bridgeEvent.type === "settled") {
          const currentOp = session.activeOpId ?? activeOpId;
          this.send({
            v: 1,
            kind: "session_event",
            sessionId,
            ...(currentOp ? { opId: currentOp } : {}),
            event: bridgeEvent,
          });
          if (currentOp) {
            // Fallback journaling for turns that settle without a `turn_end`
            // (robustness; the normal path journals per turn below). Pending
            // ambiguous users journal first so order stays user→assistant.
            if (runtime.pendingUserText !== null) {
              this.appendHistory(session, { role: "user", text: runtime.pendingUserText });
              runtime.pendingUserText = null;
            }
            if (runtime.activeText !== "") {
              this.appendHistory(session, { role: "assistant", text: runtime.activeText });
            }
            session.metadata.messageCount = session.history.filter((e) => e.role === "user" || e.role === "assistant").length;
            runtime.activeText = "";
            // Single-turn honesty: the settled op is still active (SNC1.4 never
            // transfers ownership mid-agent; queued delivery while busy is
            // rejected, so there is nothing to promote).
            if (session.activeOpId === currentOp) {
              this.finishTurn(session, currentOp);
              if (session.activeOpId === null) session.metadata.isStreaming = false;
            }
          }
          continue;
        }
        if (bridgeEvent.type === "turn_end") {
          const currentOp = session.activeOpId ?? activeOpId;
          this.send({
            v: 1,
            kind: "session_event",
            sessionId,
            ...(currentOp ? { opId: currentOp } : {}),
            event: bridgeEvent,
          });
          if (currentOp) {
            // Per-turn boundary: journal this turn (pending ambiguous user
            // first, then assistant) so later turns attribute correctly.
            // Tool-only turns journal nothing (SNC1.5 owns tool journaling).
            if (runtime.pendingUserText !== null) {
              this.appendHistory(session, { role: "user", text: runtime.pendingUserText });
              runtime.pendingUserText = null;
            }
            if (runtime.activeText !== "") {
              this.appendHistory(session, { role: "assistant", text: runtime.activeText });
            }
            session.metadata.messageCount = session.history.filter((e) => e.role === "user" || e.role === "assistant").length;
            runtime.activeText = "";
            // No promotion: SNC1.4 holds the single active turn until Pi's
            // authoritative `agent_settled` completes it (see above). Queued
            // delivery while busy is rejected, so multi-turn tool continuations
            // always belong to the current prompt and attribute to it.
          }
          continue;
        }
        // text_*/thinking_*/tool_*: stream with the active turn id.
        // Outside a turn (e.g. late events after settle) they are dropped
        // rather than journaled under a wrong op.
        {
          const currentOp = session.activeOpId ?? activeOpId;
          if (!currentOp) continue;
          this.send({ v: 1, kind: "session_event", sessionId, opId: currentOp, event: bridgeEvent });
        }
      }
    };
    try {
      runtime.unsubs.push(runtime.conn.onEvent(onEvent));
    } catch {
      // A connection without events cannot stream; dispatches will fail
      // honestly as `unknown` via prompt timeouts.
    }
  }

  private onPiExit(sessionId: string, info: PiRpcCloseResult): void {
    const session = this.sessions.get(sessionId);
    const runtime = this.piRuntimes.get(sessionId);
    if (!session) return;
    const activeOpId = session.activeOpId;
    session.metadata.isStreaming = false;
    // Pending ambiguous users are dropped unjournaled when Pi never proved
    // receipt (no `turn_start` arrived to journal them); already-journaled
    // turns survive in history so `unknown` reconciles without duplicates.
    if (runtime) {
      runtime.pendingUserText = null;
      runtime.activeText = "";
    }
    if (activeOpId) {
      // Pi died mid-turn: the prompt outcome is ambiguous, but the UI must
      // not stay stuck streaming. Emit a shaped error turn + settled so Orca
      // re-enables input; the dispatch outcome for the in-flight prompt was
      // already reported (`accepted` with later failure, or `unknown` when
      // the prompt itself never resolved). Never include Pi stderr text.
      this.emit(session, activeOpId, { type: "turn_end", stopReason: "error", errorMessage: "Pi process exited" });
      this.emit(session, activeOpId, { type: "settled", willRetry: false });
      // Clear without draining the queue: queued steer/followUp cannot run
      // against a dead child. Drop them so a later reacquire starts clean.
      session.queue.splice(0);
      if (session.activeOpId === activeOpId) {
        session.activeOpId = null;
        session.metadata.isStreaming = false;
      }
    }
    void info;
  }

  // -- dispatch: prompt through Pi RPC with honest accepted/rejected/unknown -

  private async onPiDispatch(msg: DispatchRequest): Promise<void> {
    if (!this.requireHello(msg.opId)) return;
    const session = this.sessions.get(msg.sessionId);
    const runtime = this.piRuntimes.get(msg.sessionId);
    if (!session || !runtime) {
      this.send({ v: 1, kind: "dispatch_ack", opId: msg.opId, sessionId: msg.sessionId, status: "rejected", reason: "unknown-session" });
      return;
    }
    if (runtime.conn.isClosed) {
      this.send({ v: 1, kind: "dispatch_ack", opId: msg.opId, sessionId: msg.sessionId, status: "rejected", reason: "pi-exited (reacquire the session)" });
      return;
    }
    const validation = validatePiDispatch(msg.message, session.options, session.metadata.model);
    if (!validation.ok) {
      this.send({ v: 1, kind: "dispatch_ack", opId: msg.opId, sessionId: msg.sessionId, status: "rejected", reason: validation.reason ?? "invalid-dispatch" });
      return;
    }
    // SNC1.4 is basic text chat: leading-`/` extension commands are handled
    // immediately by Pi (success without any turn lifecycle), which would
    // leave this single-turn provider streaming forever. Reject them honestly
    // instead of stranding the session; interactive prompts land in SNC1.6.
    if (msg.message.text.trimStart().startsWith("/")) {
      this.send({
        v: 1,
        kind: "dispatch_ack",
        opId: msg.opId,
        sessionId: msg.sessionId,
        status: "rejected",
        reason: "extension-command (interactive prompts land in SNC1.6; send plain text)",
      });
      return;
    }
    if (session.activeOpId) {
      // SNC1.4 single-turn honesty: while a turn streams, every new dispatch
      // — including `steer`/`followUp` — is honestly rejected without touching
      // Pi (definite refusal: Pi never saw it, safe to retry after idle or
      // cancel). Accepting a queued prompt would require proving Pi owns its
      // future turn across steer/followUp modes, tool-loop continuations,
      // retry/compaction, immediate-command handling, and ambiguous-queue
      // ordering — all of which need user-message/`queue_update` evidence and
      // retry/compaction boundaries owned by the SNC1.5 lifecycle translator.
      // Guessing ownership from turn boundaries misattributes turns and
      // fabricates history, so SNC1.4 declines the queue and SNC1.5 lands it.
      this.send({
        v: 1,
        kind: "dispatch_ack",
        opId: msg.opId,
        sessionId: msg.sessionId,
        status: "rejected",
        reason: "already-streaming (queued steer/followUp needs SNC1.5 lifecycle evidence; wait for idle or cancel)",
      });
      return;
    }
    // Idle: retain pending-op state BEFORE the write so an ambiguous outcome
    // (write landed but the response was lost) still attributes later Pi
    // events to this op. The user text stays pending (NOT journaled) until Pi
    // actually streams the turn (`turn_end` journals user→assistant in order),
    // so `get_history` never fabricates a turn Pi never received. Definite
    // refusal clears everything below (Pi made no change); success journals
    // immediately; ambiguity reconciles against Pi state before deciding.
    session.activeOpId = msg.opId;
    session.metadata.isStreaming = true;
    runtime.activeText = "";
    runtime.pendingUserText = msg.message.text;
    const piCmd = mapBridgeDispatchToPiPrompt(msg.opId, msg.message, msg.queue ?? "reject");
    try {
      await runtime.conn.prompt(piCmd.message, {
        ...(piCmd.images ? { images: piCmd.images } : {}),
        ...(piCmd.streamingBehavior ? { streamingBehavior: piCmd.streamingBehavior } : {}),
      });
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      const ambiguous = (error as { ambiguous?: unknown })?.ambiguous;
      // Definite refusal: Pi rejected without side effects (e.g. busy
      // without streamingBehavior). Clear the pending state and report
      // `rejected` with Pi's reason (no history entry: rejected turns leave
      // no entries per the Pi contract).
      if (code === "rejected" && ambiguous === false) {
        if (session.activeOpId === msg.opId) {
          session.activeOpId = null;
          session.metadata.isStreaming = false;
        }
        runtime.pendingUserText = null;
        const piError = (error as { piError?: unknown }).piError;
        this.send({
          v: 1,
          kind: "dispatch_ack",
          opId: msg.opId,
          sessionId: msg.sessionId,
          status: "rejected",
          reason: sanitizeCode(typeof piError === "string" && piError !== "" ? piError : "pi-rejected-prompt"),
        });
        return;
      }
      // Ambiguous: timeout/exit/close after the write may or may not have
      // landed. Do NOT journal yet. Reconcile against Pi's authoritative
      // state: when Pi is idle it never received the prompt, so clear the
      // pending turn (history stays clean, session idle, safe for the caller
      // to retry as fresh work after reconciling). When Pi is streaming (or
      // state is unreadable) keep the pending turn so late Pi events
      // attribute to `msg.opId` and `turn_end` journals user→assistant in
      // order. Report `unknown` fast; callers reconcile via history and never
      // auto-resend. A turn that already settled during the write (complete
      // landed turn before the timeout) already cleared `activeOpId` via its
      // own `turn_end`/`settled`, so only still-pending ops reconcile here.
      if (session.activeOpId === msg.opId) {
        let piStreaming: boolean | null = null;
        try {
          const state = await runtime.conn.getState();
          piStreaming = state.isStreaming === true;
        } catch {
          piStreaming = null;
        }
        if (piStreaming === false) {
          session.activeOpId = null;
          session.metadata.isStreaming = false;
          runtime.pendingUserText = null;
          runtime.activeText = "";
        }
      } else {
        runtime.pendingUserText = null;
      }
      this.send({
        v: 1,
        kind: "dispatch_ack",
        opId: msg.opId,
        sessionId: msg.sessionId,
        status: "unknown",
        reason: "pi-prompt-ambiguous (reconcile via history; do not auto-resend)",
      });
      return;
    }
    // Pi owns the prompt: journal the user turn now (confirmed) and let Pi
    // events drive `turn_start`/deltas/`turn_end`/`settled`. Clear the
    // pending marker so `turn_end` does not journal it a second time. When
    // the turn already settled during the write, `activeOpId` was cleared by
    // its own `settled` (which journaled user+assistant) — skip the duplicate.
    if (session.activeOpId === msg.opId && runtime.pendingUserText !== null) {
      this.appendHistory(session, { role: "user", text: msg.message.text });
      session.metadata.messageCount = session.history.filter((e) => e.role === "user" || e.role === "assistant").length;
      runtime.pendingUserText = null;
    } else {
      runtime.pendingUserText = null;
    }
    this.send({ v: 1, kind: "dispatch_ack", opId: msg.opId, sessionId: msg.sessionId, status: "accepted" });
  }

  /**
   * Defensive fallback for legacy base-class queue drains. The SNC1.4 Pi path
   * never enqueues (busy dispatches are rejected before touching Pi), so this
   * runs only if a subclass ever queues: execute once against Pi and settle
   * honestly without a second ack.
   */
  protected override async handleDispatch(session: ProviderSession, msg: DispatchRequest): Promise<void> {
    // Resolve the live session entry (the passed reference may be stale
    // after a provider restart in tests using the base harness).
    const live = this.sessions.get(msg.sessionId) ?? session;
    const runtime = this.piRuntimes.get(msg.sessionId);
    if (!runtime || runtime.conn.isClosed) {
      this.emit(live, msg.opId, { type: "turn_end", stopReason: "error", errorMessage: "Pi process unavailable" });
      this.emit(live, msg.opId, { type: "settled", willRetry: false });
      this.finishTurn(live, msg.opId);
      return;
    }
    const piCmd = mapBridgeDispatchToPiPrompt(msg.opId, msg.message, msg.queue ?? "followUp");
    try {
      await runtime.conn.prompt(piCmd.message, {
        ...(piCmd.images ? { images: piCmd.images } : {}),
        ...(piCmd.streamingBehavior ? { streamingBehavior: piCmd.streamingBehavior } : {}),
      });
    } catch {
      // Already acked `accepted` when queued: settle as a shaped error turn
      // (never a second ack) so the session unsticks and drains.
      this.emit(live, msg.opId, { type: "turn_end", stopReason: "error", errorMessage: "provider dispatch failed" });
      this.emit(live, msg.opId, { type: "settled", willRetry: false });
      this.finishTurn(live, msg.opId);
      return;
    }
    // Journal the queued user turn; Pi events will settle it.
    // `finishTurn` set activeOpId before calling here; keep it.
    this.appendHistory(live, { role: "user", text: msg.message.text });
    live.metadata.messageCount = live.history.filter((e) => e.role === "user" || e.role === "assistant").length;
    runtime.activeText = "";
    // Do not emit turn_start/settled here: Pi's own turn events drive them
    // through `attachPiStreaming`. If Pi never emits (crashed), `onPiExit`
    // settles the turn.
  }

  // -- cancel: abort the streaming turn via Pi RPC ---------------------------

  private onPiCancel(opId: string, sessionId: string, targetOpId?: string): void {
    if (!this.requireHello(opId)) return;
    const session = this.sessions.get(sessionId);
    const runtime = this.piRuntimes.get(sessionId);
    if (!session || !runtime) {
      this.send({ v: 1, kind: "cancelled", opId, sessionId, targetOpId: targetOpId ?? "", settled: true });
      return;
    }
    const target = targetOpId ?? session.activeOpId ?? "";
    if (target !== "") session.cancelledOps.add(target);
    const settled = session.activeOpId === null;
    this.send({ v: 1, kind: "cancelled", opId, sessionId, targetOpId: target, settled });
    // Fence the abort to the requested target: a stale cancel for a settled
    // op must never abort the currently streaming (unrelated) turn. An
    // omitted target means Esc-for-active (abort whatever streams, if anything).
    if (targetOpId !== undefined && targetOpId !== session.activeOpId) return;
    if (session.activeOpId === null || runtime.conn.isClosed) return;
    // Fire-and-forget abort: Pi's `abort` response may arrive after
    // `agent_settled` (proven in `abort-queue.jsonl`), so never block the
    // `cancelled` ack on it. Pi's own settled event re-enables input.
    runtime.conn.abort().catch(() => {
      // Abort failed (Pi already dead/closed): the exit handler settles the
      // turn. If it hasn't (fake without onExit), settle here to unblock.
      const current = this.sessions.get(sessionId);
      if (current && current.activeOpId) {
        this.emit(current, current.activeOpId, { type: "turn_end", stopReason: "aborted", errorMessage: "cancelled by host" });
        this.emit(current, current.activeOpId, { type: "settled", willRetry: false });
        const op = current.activeOpId;
        current.activeOpId = null;
        current.metadata.isStreaming = false;
        void op;
      }
    });
  }

  // -- dialogs: answer_prompt -> Pi extension_ui_response --------------------

  protected override onPromptAnswered(session: ProviderSession, requestId: string, value: unknown, cancelled: boolean): void {
    // Base `onAnswer` found the owning session via `pendingPrompt` and passed
    // it here before clearing. Resolve its sessionId by identity so the Pi
    // `extension_ui_response` goes to the correct child (one Pi per bridge
    // session; single active turn per session keeps this unambiguous).
    let ownerId: string | null = null;
    for (const [sessionId, candidate] of this.sessions) {
      if (candidate === session) {
        ownerId = sessionId;
        break;
      }
    }
    const runtime = ownerId ? this.piRuntimes.get(ownerId) : undefined;
    // Fall back to the sole runtime when identity lookup fails (single-
    // session providers in tests); never broadcast to every child.
    const target = runtime ?? (this.piRuntimes.size === 1 ? [...this.piRuntimes.values()][0] : undefined);
    if (!target) return;
    try {
      if (cancelled) {
        target.conn.respondToExtensionUi({ type: "extension_ui_response", id: requestId, cancelled: true });
      } else if (typeof value === "boolean") {
        target.conn.respondToExtensionUi({ type: "extension_ui_response", id: requestId, confirmed: value });
      } else {
        target.conn.respondToExtensionUi({ type: "extension_ui_response", id: requestId, value });
      }
    } catch {
      // Pi is gone; the turn will settle via exit handling.
    }
  }

  // -- teardown: release one session, close the provider ---------------------

  private async onPiRelease(opId: string, sessionId: string): Promise<void> {
    await this.teardownPiRuntime(sessionId);
    this.sessions.delete(sessionId);
    this.send({ v: 1, kind: "released", opId, sessionId });
  }

  private async onPiClose(opId: string, sessionId?: string, mode: "graceful" | "force" = "graceful"): Promise<void> {
    if (sessionId) {
      const exit = await this.teardownPiRuntime(sessionId, mode);
      this.sessions.delete(sessionId);
      this.send({ v: 1, kind: "closed", opId, sessionId, exit });
      return;
    }
    // Provider shutdown: bounded close of every Pi child in the requested mode,
    // then ack with the observed aggregate exit (first non-clean child wins).
    // The host follows with stdin EOF/SIGTERM/SIGKILL; the CLI also exits on
    // EOF/SIGTERM (see `pi-provider-cli.ts`) so no Pi child leaks.
    const ids = [...this.piRuntimes.keys()];
    const exits = await Promise.all(ids.map((id) => this.teardownPiRuntime(id, mode)));
    this.sessions.clear();
    this.send({ v: 1, kind: "closed", opId, exit: aggregateExits(exits) });
  }

  private async teardownPiRuntime(sessionId: string, mode: "graceful" | "force" = "graceful"): Promise<{ code: number | null; signal: string | null }> {
    const runtime = this.piRuntimes.get(sessionId);
    if (!runtime) return { code: 0, signal: null };
    this.piRuntimes.delete(sessionId);
    for (const unsub of runtime.unsubs.splice(0)) {
      try {
        unsub();
      } catch {
        // Cleanup must not throw.
      }
    }
    // Graceful runs the transport's bounded EOF→SIGTERM→SIGKILL machine with
    // the configured grace. Force is kill-first (no EOF, no SIGTERM): SIGKILL
    // immediately, then a NON-ZERO bounded observation window for the OS exit.
    // `close(0)` cannot observe a real child (all races zero-length), so force
    // callers pass a real grace. Observed results are reported as-is; anything
    // still unobserved stays `{null,null}` (unknown), never fabricated clean.
    const graceMs = this.piCloseGraceMs;
    try {
      const result =
        mode === "force"
          ? await runtime.conn.close(graceMs, { force: true })
          : await runtime.conn.close(graceMs);
      return { code: result.exitCode, signal: result.signal };
    } catch {
      // Teardown is best-effort; the host bounds kill stages regardless.
      try {
        const result =
          mode === "force"
            ? await runtime.conn.close(graceMs, { force: true })
            : await runtime.conn.close(graceMs);
        return { code: result.exitCode, signal: result.signal };
      } catch {
        // Ignore — child already gone (genuinely unobserved).
        return { code: null, signal: null };
      }
    }
  }

  /**
   * Bounded provider shutdown for signal/EOF paths (CLI `SIGTERM`/`SIGINT`/
   * stdin EOF). Closes every Pi child with observed exit, detaches listeners,
   * and clears session state without sending bridge records (stdio may already
   * be closing). The bridge `close` handshake (`onPiClose`) remains the normal
   * host-driven path; this is the fallback that guarantees no leaked `pi`
   * children when the provider process itself is asked to exit.
   */
  async dispose(): Promise<void> {
    const ids = [...this.piRuntimes.keys()];
    await Promise.all(ids.map((id) => this.teardownPiRuntime(id)));
    this.sessions.clear();
  }

  /** Best-effort session stats for diagnostics (never sent over the bridge). */
  async getPiSessionStats(sessionId: string): Promise<PiSessionStats | null> {
    const runtime = this.piRuntimes.get(sessionId);
    if (!runtime || runtime.conn.isClosed) return null;
    try {
      const conn = runtime.conn as unknown as { getSessionStats?: () => Promise<PiSessionStats> };
      if (typeof conn.getSessionStats === "function") return await conn.getSessionStats();
      return null;
    } catch {
      return null;
    }
  }
}

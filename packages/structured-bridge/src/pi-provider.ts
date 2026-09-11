/**
 * Pi-backed external provider (SNC1.4 + SNC1.5 + SNC1.6, orca-pi owned).
 *
 * Combines the production SNC1.2 `PiRpcConnection` transport with the SNC1.3
 * external structured-session bridge to run the first real Pi structured
 * Native Chat session in Orca. This file is **never vendored into Orca core**:
 * the fork vendors only `framing.ts` + `protocol.ts` + `host.ts`
 * (provider-neutral). Everything Pi stays here plus `pi-mapping.ts`.
 *
 * Capabilities (per #14 + #15 + #16):
 * - spawn/acquire `pi --mode rpc` in the exact Orca-selected workspace/cwd;
 * - apply compatible transport-neutral resolved Pi profile configuration
 *   (callers pass a `buildPiLaunch()` spec via `resolvePiSpec`; TUI-only
 *   flags are rejected via `toPiRpcProcessSpec`; `--mode rpc` is appended
 *   idempotently; no terminal keystroke injection on the structured path);
 * - publish provider/session/process identity required by Orca's structured
 *   lease (`hello_ok{provider:{id:"pi"}}` + `acquired{metadata}` with
 *   `providerSessionId` from Pi `get_state`, `workspaceRoot`, model,
 *   thinking, counts, `isStreaming`, `createdAt`);
 * - dispatch text + structured images through Pi RPC (`prompt` accept =
 *   `accepted`, definite `success:false` = `rejected`, transport ambiguity =
 *   `unknown`; never auto-resend `unknown`);
 * - stream assistant text into the normal Orca structured journal/UI via
 *   `session_event` (`turn_start`/`text_*`/`turn_end`/`settled`);
 * - SNC1.6 model/thinking controls via live Pi RPC (`get_available_models` /
 *   `set_model`, `get_available_thinking_levels` / `set_thinking_level`,
 *   `set_auto_compaction`) with provider-confirmed metadata; Orca's normal
 *   `set_options` / `get_session` persistence semantics; exact-match model
 *   refs only (`provider/modelId` or unique bare `modelId` — no fuzzy /
 *   wildcard beyond the Pi RPC contract);
 * - SNC1.6 interactive prompts: Pi `extension_ui_request` dialogs (select /
 *   confirm / input / editor) → bridge `prompt_request` with stable
 *   `requestId` identity, exactly-once `answer_prompt` → Pi
 *   `extension_ui_response`, stale/late refusal (`UNKNOWN_REQUEST`), prompt
 *   retirement on turn settle / cancel / Pi exit / release, bounded ignore
 *   of fire-and-forget / unknown UI kinds (never block, never terminate);
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
 * (`prompt success:true` on an idle session, or immediate `/` extension
 * commands that Pi handles without a turn), `rejected` only for definite
 * provider refusal (`success:false`, empty text, unknown session, busy turn
 * including `steer`/`followUp` while streaming, model-rejects-images,
 * unknown/ambiguous model/thinking refs), `unknown` for ambiguous
 * transport/delivery outcomes (timeout, exit, malformed ack). Callers must
 * reconcile `unknown` via history before retrying; the provider never
 * auto-resends.
 *
 * Scope: SNC1.4 is basic text chat, one turn at a time. Queued delivery while
 * busy (`steer`/`followUp` accepted via Pi-owned queue) is honestly rejected
 * here: proving Pi owns a future turn needs user-message/`queue_update`
 * evidence plus retry/compaction boundaries — guessing from turn boundaries
 * misattributes turns and fabricates history (SNC1.5 keeps the honest reject;
 * queue fidelity stays deferred pending that evidence). SNC1.5 owns faithful
 * thinking/tool/error/lifecycle translation (see `pi-translator.ts`): stable
 * `contentIndex`/`toolCallId` identities, cumulative-vs-delta semantics, tool
 * journaling with assistant/tool separation, abort fidelity, secret-safe error
 * shaping, and bounded unknown handling with no retained transient on settle.
 * SNC1.6 owns model/thinking controls, interactive prompts, and structured
 * images (this file + `pi-mapping.ts`); history/branch/resume is SNC1.7.
 * `set_options` applies live to Pi and acks provider-confirmed values;
 * `get_history` serves the live-turn journal (Pi tree reconstruction lands in
 * SNC1.7); `get_session` refreshes provider-confirmed model/thinking
 * best-effort. Immediate `/` extension commands run without a turn (no
 * journal entries, per the Pi contract) and stay honestly rejected while busy
 * to avoid concurrent attribution without queue evidence.
 */

import {
  PiRpcConnection,
  redactSecrets,
  resolvePiRpcEnv,
  toPiRpcProcessSpec,
  type PiImageAttachment,
  type PiModel,
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
  type AnswerPromptRequest,
  type BridgeCapabilities,
  type BridgeSessionMetadata,
  type BridgeSessionOptions,
  type DispatchRequest,
  type GetSessionRequest,
  type HostToProviderMessage,
  type SetOptionsRequest,
} from "./protocol.js";
import { BridgeProvider, type ProviderSession } from "./provider.js";
import {
  mapBridgeDispatchToPiPrompt,
  mapPiRecordToBridgeEvents,
  piBridgeCapabilities,
  validatePiDispatch,
} from "./pi-mapping.js";
import { PiTranslator } from "./pi-translator.js";

/** Minimal Pi connection surface used by the bridge (real `PiRpcConnection` satisfies it).
 *
 * SNC1.6 model/thinking controls need the live Pi option RPCs. They are
 * optional here so minimal test fakes (SNC1.4 text-only) keep working: when
 * absent, `set_options` for model/thinking/autoCompaction fails closed with
 * an actionable `PI_OPTION_UNSUPPORTED` error instead of silently diverging.
 * Production `PiRpcConnection` always implements them.
 */
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
  getAvailableModels?(): Promise<{ models: PiModel[] }>;
  setModel?(provider: string, modelId: string): Promise<PiModel>;
  getAvailableThinkingLevels?(): Promise<{ levels: string[] }>;
  setThinkingLevel?(level: string): Promise<void>;
  setAutoCompaction?(enabled: boolean): Promise<void>;
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
  /** SNC1.5 translator: accumulation, dedupe, lifecycle, journal decisions. */
  translator: PiTranslator;
  /** Pi-side session id observed via `get_state` (for lease identity). */
  piSessionId?: string;
  /**
   * SNC1.6 interactive prompts: stable `requestId` → originating dispatch
   * `opId` for every unanswered Pi dialog in this session. Exactly-once:
   * the first `answer_prompt` for a `requestId` forwards one Pi
   * `extension_ui_response` and deletes the entry; later answers for the
   * same id are stale/late refusals (`UNKNOWN_REQUEST`, never re-sent).
   * Retired on turn settle / cancel / Pi exit / release / close, so prompt
   * state never leaks across turns or acquisition fences. The base
   * `session.pendingPrompt` single slot is kept in sync (latest only) for
   * back-compat, but this map is authoritative for answers (multi-dialog
   * support; the single slot would overwrite overlapping dialogs).
   */
  pendingPrompts: Map<string, string>;
  /** Last `get_available_models` result for image-gating + model refs (best-effort cache). */
  cachedModels?: PiModel[];
  // Single-turn honesty: while a turn streams, queued `steer`/`followUp`
  // dispatches are honestly rejected (never accepted-before-owned). Pi-owned
  // queue fidelity would need user-message/`queue_update` evidence plus
  // retry/compaction boundaries — guessing from turn boundaries misattributes
  // turns and fabricates history, so the queue stays rejected (see
  // `onPiDispatch` busy branch). The SNC1.5 translator owns faithful
  // rendering of the single active turn (text/thinking/tools/lifecycle).
  /**
   * Optimistic user text for an ambiguous idle `prompt` (write may have landed
   * but the response was lost). Mirrors `translator.pendingUser` for
   * back-compat within this file: `turn_start` (receipt proof) or `turn_end`
   * journals it first, preserving user-before-assistant order, so
   * `get_history` never fabricates a user entry Pi never received. Cleared on
   * definite refusal, successful journaling, or idle reconciliation.
   *
   * SNC1.5: the translator is authoritative for pending-user state; this field
   * is kept in sync (set/cleared together) so existing branches keep working
   * while the translator owns dedupe/journal decisions.
   */
  pendingUserText: string | null;
  /**
   * Accumulated assistant text for the active turn (for `get_history`).
   * SNC1.5: mirrors `translator.currentAssistantText()` for back-compat;
   * the translator is authoritative (finals reconcile, deltas streaming-only).
   */
  activeText: string;
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
    // SNC1.6 truthfulness: model/thinking/image/prompt controls are live
    // (see `onPiSetOptions` / `onPiAnswerPrompt` / image-aware dispatch),
    // so `options` is true and Orca may expose its shared Native Chat option
    // controls with no renderer fork. History/branch/resume stays false until
    // SNC1.7 reconstructs from Pi `get_entries`/`get_tree` — otherwise Orca
    // would expose resume paths that silently diverge from Pi child state.
    const snc16Capabilities: BridgeCapabilities = { ...piBridgeCapabilities(), options: true, resume: false };
    super({
      providerId: opts.providerId ?? "pi",
      providerVersion: opts.providerVersion ?? "0.1.0",
      capabilities: opts.capabilities ?? snc16Capabilities,
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
      case "set_options":
        await this.onPiSetOptions(msg);
        return;
      case "get_session":
        await this.onPiGetSession(msg);
        return;
      case "answer_prompt":
        this.onPiAnswerPrompt(msg);
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
    const runtime: PiRuntime = {
      conn,
      unsubs: [],
      translator: new PiTranslator(),
      activeText: "",
      piSessionId,
      pendingUserText: null,
      pendingPrompts: new Map<string, string>(),
    };
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
    // SNC1.6: apply acquire-time model/thinking/autoCompaction live so the
    // acquired lease carries provider-confirmed values (launch `--model` /
    // `--thinking` args are best-effort hints; Pi RPC is authoritative).
    // Failures here are actionable (bad model/thinking ref) — close the
    // child and report `error` fail-closed so Orca stays on TUI rather than
    // exposing diverging controls. `queueMode` needs no Pi call (host-side).
    if (msg.options && (msg.options.model !== undefined || msg.options.thinkingLevel !== undefined || msg.options.autoCompaction !== undefined)) {
      const applied = await this.applyPiOptions(sessionId, msg.options);
      if (!applied.ok) {
        await this.teardownPiRuntime(sessionId).catch(() => undefined);
        this.sessions.delete(sessionId);
        this.send({
          v: BRIDGE_PROTOCOL_VERSION,
          kind: "error",
          opId: msg.opId,
          error: { code: applied.code, message: applied.message },
        });
        return;
      }
    }
    const confirmed = this.sessions.get(sessionId);
    this.send({
      v: 1,
      kind: "acquired",
      opId: msg.opId,
      sessionId,
      resumed: false,
      metadata: { ...(confirmed ? confirmed.metadata : metadata) },
    });
  }

  /** Extra `--model`/`--thinking` from acquire options (launch-time only). */
  private augmentArgsForOptions(options?: BridgeSessionOptions): string[] {
    const extra: string[] = [];
    if (options?.model && !this.piArgs.includes("--model")) extra.push("--model", options.model);
    if (options?.thinkingLevel && !this.piArgs.includes("--thinking")) extra.push("--thinking", options.thinkingLevel);
    return extra;
  }

  // -- SNC1.6 model/thinking controls (live Pi RPC, provider-confirmed) -----
  //
  // Orca's shared Native Chat option controls drive `set_options` /
  // `get_session` with Orca-normal persistence semantics: `set_options`
  // persists into `session.options` and `session.metadata` (provider-
  // confirmed), `get_session` reports the confirmed lease, and `acquire`
  // with options restores them live before `acquired`. No fuzzy/wildcard
  // beyond the Pi RPC contract: model refs are exact `provider/modelId` or
  // exact unique bare `modelId`; thinking levels must exactly match Pi's
  // live `get_available_thinking_levels` (Pi itself is lenient and would
  // silently fall back to `minimal` — the bridge fails closed instead).

  /**
   * Resolve a bridge `model` string to an exact Pi `provider` + `modelId`.
   * No fuzzy, prefix, or wildcard matching: `provider/modelId` must match
   * both fields exactly; a bare `modelId` must match exactly one catalog
   * entry (ambiguous bare ids must use the `provider/modelId` form).
   */
  private resolveModelRef(
    requested: string,
    models: readonly PiModel[],
  ): { ok: true; provider: string; modelId: string; matched: PiModel } | { ok: false; code: string; message: string } {
    const trimmed = requested.trim();
    if (trimmed === "") {
      return { ok: false, code: "UNKNOWN_MODEL", message: "unknown model: empty model ref (use provider/modelId or exact model id)" };
    }
    const slash = trimmed.indexOf("/");
    if (slash >= 0) {
      const providerPart = trimmed.slice(0, slash);
      const idPart = trimmed.slice(slash + 1);
      if (providerPart === "" || idPart === "") {
        return { ok: false, code: "UNKNOWN_MODEL", message: sanitizeCode(`unknown model: ${trimmed} (use provider/modelId or exact model id)`) };
      }
      const matched = models.find((m) => m.provider === providerPart && m.id === idPart);
      if (!matched) {
        return { ok: false, code: "UNKNOWN_MODEL", message: sanitizeCode(`unknown model: ${trimmed} (no exact provider/modelId match)`) };
      }
      return { ok: true, provider: matched.provider, modelId: matched.id, matched };
    }
    const hits = models.filter((m) => m.id === trimmed);
    if (hits.length === 0) {
      return { ok: false, code: "UNKNOWN_MODEL", message: sanitizeCode(`unknown model: ${trimmed} (no exact model id match)`) };
    }
    if (hits.length > 1) {
      const providers = hits.map((m) => m.provider).join(", ");
      return {
        ok: false,
        code: "AMBIGUOUS_MODEL",
        message: sanitizeCode(`ambiguous model: ${trimmed} matches ${hits.length} providers (${providers}); use provider/modelId`),
      };
    }
    const only = hits[0] as PiModel;
    return { ok: true, provider: only.provider, modelId: only.id, matched: only };
  }

  /** Live image-support check for the confirmed model (provider-confirmed where cached). */
  private modelSupportsImages(modelId: string | undefined, cached: readonly PiModel[] | undefined): boolean | null {
    if (!modelId) return null;
    const entry = cached?.find((m) => m.id === modelId);
    if (!entry) return null;
    const input = (entry as { input?: unknown }).input;
    if (!Array.isArray(input)) return null;
    return input.includes("image");
  }

  /**
   * Apply bridge options live to one Pi child. Updates `session.options` +
   * `session.metadata` only with provider-confirmed values (Pi RPC results
   * / live level lists / `get_state` refresh). Returns `{ok:true}` when every
   * requested field applied, else `{ok:false, code, message}` fail-closed
   * (succeeded fields stay applied — Pi mutations are not transactional —
   * but the caller reports `error`, never a diverging `options_updated`).
   */
  private async applyPiOptions(
    sessionId: string,
    options: BridgeSessionOptions,
  ): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
    const session = this.sessions.get(sessionId);
    const runtime = this.piRuntimes.get(sessionId);
    if (!session || !runtime) {
      return { ok: false, code: "UNKNOWN_SESSION", message: "unknown session" };
    }
    if (runtime.conn.isClosed) {
      return { ok: false, code: "PI_EXITED", message: "pi-exited (reacquire the session)" };
    }
    // Model: exact-ref resolution via live catalog, then Pi `set_model`.
    // Provider-confirmed `Model.id` becomes both `metadata.model` and the
    // persisted `options.model` (so Orca restores the confirmed id, not a
    // `provider/id` alias the next catalog may resolve differently).
    if (options.model !== undefined) {
      const conn = runtime.conn;
      if (typeof conn.getAvailableModels !== "function" || typeof conn.setModel !== "function") {
        return { ok: false, code: "PI_OPTION_UNSUPPORTED", message: "Pi connection does not support model operations" };
      }
      let models: PiModel[];
      try {
        const listed = await conn.getAvailableModels();
        models = [...listed.models];
        runtime.cachedModels = models;
      } catch (error) {
        return { ok: false, code: "PI_OPTION_FAILED", message: sanitizeCode(`model list failed: ${this.shortPiError(error)}`) };
      }
      const resolved = this.resolveModelRef(options.model, models);
      if (!resolved.ok) return { ok: false, code: resolved.code, message: resolved.message };
      try {
        const confirmed = await conn.setModel(resolved.provider, resolved.modelId);
        const confirmedId = typeof confirmed?.id === "string" && confirmed.id !== "" ? confirmed.id : resolved.modelId;
        session.options.model = confirmedId;
        session.metadata.model = confirmedId;
        // Refresh cached catalog entry (confirmed model may carry new caps).
        const idx = models.findIndex((m) => m.provider === resolved.provider && m.id === resolved.modelId);
        if (idx >= 0) models[idx] = confirmed;
        runtime.cachedModels = models;
      } catch (error) {
        const code = (error as { code?: unknown })?.code;
        if (code === "rejected") {
          const piError = (error as { piError?: unknown }).piError;
          return {
            ok: false,
            code: "UNKNOWN_MODEL",
            message: sanitizeCode(typeof piError === "string" && piError !== "" ? piError : `unknown model: ${options.model}`),
          };
        }
        return { ok: false, code: "PI_OPTION_FAILED", message: sanitizeCode(`set_model failed: ${this.shortPiError(error)}`) };
      }
    }
    // Thinking: exact live-level validation first (Pi is lenient and would
    // silently fall back — the bridge fails closed instead), then apply.
    if (options.thinkingLevel !== undefined) {
      const conn = runtime.conn;
      if (typeof conn.getAvailableThinkingLevels !== "function" || typeof conn.setThinkingLevel !== "function") {
        return { ok: false, code: "PI_OPTION_UNSUPPORTED", message: "Pi connection does not support thinking-level operations" };
      }
      let levels: string[];
      try {
        const listed = await conn.getAvailableThinkingLevels();
        levels = [...listed.levels];
      } catch (error) {
        return { ok: false, code: "PI_OPTION_FAILED", message: sanitizeCode(`thinking-level list failed: ${this.shortPiError(error)}`) };
      }
      if (!levels.includes(options.thinkingLevel)) {
        return {
          ok: false,
          code: "UNKNOWN_THINKING_LEVEL",
          message: sanitizeCode(`unknown thinking level: ${options.thinkingLevel} (available: ${levels.join(", ") || "none"})`),
        };
      }
      try {
        await conn.setThinkingLevel(options.thinkingLevel);
      } catch (error) {
        return { ok: false, code: "PI_OPTION_FAILED", message: sanitizeCode(`set_thinking_level failed: ${this.shortPiError(error)}`) };
      }
      // Provider-confirmed: Pi emits `thinking_level_changed` (tracked live
      // in `attachPiStreaming`); refresh via `get_state` so the lease never
      // echoes an unconfirmed request when Pi silently coerces.
      try {
        const state = await conn.getState();
        const confirmed = typeof state.thinkingLevel === "string" ? state.thinkingLevel : options.thinkingLevel;
        session.options.thinkingLevel = confirmed;
        session.metadata.thinkingLevel = confirmed;
      } catch {
        session.options.thinkingLevel = options.thinkingLevel;
        session.metadata.thinkingLevel = options.thinkingLevel;
      }
    }
    if (options.autoCompaction !== undefined) {
      const conn = runtime.conn;
      if (typeof conn.setAutoCompaction === "function") {
        try {
          await conn.setAutoCompaction(options.autoCompaction);
        } catch (error) {
          return { ok: false, code: "PI_OPTION_FAILED", message: sanitizeCode(`set_auto_compaction failed: ${this.shortPiError(error)}`) };
        }
      }
      // No live confirmation RPC for this flag: persist the requested value
      // (Pi `set_auto_compaction` is idempotent `success:true`; failures
      // above already failed closed). Note it mutates Pi global settings —
      // callers should use isolated `PI_CODING_AGENT_DIR` in tests.
      session.options.autoCompaction = options.autoCompaction;
    }
    if (options.queueMode !== undefined) {
      // Host-side queue policy only (SNC1.4 single-turn honesty preserved:
      // busy dispatches stay honestly rejected regardless of this flag).
      session.options.queueMode = options.queueMode;
    }
    return { ok: true };
  }

  private async onPiSetOptions(msg: SetOptionsRequest): Promise<void> {
    if (!this.requireHello(msg.opId)) return;
    const session = this.sessions.get(msg.sessionId);
    const runtime = this.piRuntimes.get(msg.sessionId);
    if (!session || !runtime) {
      this.send({ v: BRIDGE_PROTOCOL_VERSION, kind: "error", opId: msg.opId, sessionId: msg.sessionId, error: { code: "UNKNOWN_SESSION", message: "unknown session" } });
      return;
    }
    const applied = await this.applyPiOptions(msg.sessionId, msg.options);
    if (!applied.ok) {
      this.send({
        v: BRIDGE_PROTOCOL_VERSION,
        kind: "error",
        opId: msg.opId,
        sessionId: msg.sessionId,
        error: { code: applied.code, message: applied.message },
      });
      return;
    }
    // Orca-normal persistence: `session.options` already holds confirmed
    // values; `metadata` mirrors model/thinking for the lease. Echo the
    // persisted bag so Orca restores exactly what Pi confirmed.
    this.send({ v: BRIDGE_PROTOCOL_VERSION, kind: "options_updated", opId: msg.opId, sessionId: msg.sessionId, options: { ...session.options } });
  }

  private async onPiGetSession(msg: GetSessionRequest): Promise<void> {
    if (!this.requireHello(msg.opId)) return;
    const session = this.sessions.get(msg.sessionId);
    const runtime = this.piRuntimes.get(msg.sessionId);
    if (!session || !runtime) {
      this.send({ v: BRIDGE_PROTOCOL_VERSION, kind: "error", opId: msg.opId, sessionId: msg.sessionId, error: { code: "UNKNOWN_SESSION", message: "unknown session" } });
      return;
    }
    // Provider-confirmed lease where available: refresh model/thinking /
    // counts / streaming from Pi `get_state` best-effort. Failures keep the
    // cached lease (never fail `get_session` for a transient state read).
    await this.refreshMetadataBestEffort(msg.sessionId);
    const current = this.sessions.get(msg.sessionId);
    if (!current) {
      this.send({ v: BRIDGE_PROTOCOL_VERSION, kind: "error", opId: msg.opId, sessionId: msg.sessionId, error: { code: "UNKNOWN_SESSION", message: "unknown session" } });
      return;
    }
    this.send({ v: BRIDGE_PROTOCOL_VERSION, kind: "session", opId: msg.opId, sessionId: msg.sessionId, metadata: { ...current.metadata } });
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

  // -- streaming: Pi events -> bridge session_event (SNC1.5 translator) -------
  //
  // Single-turn honesty is preserved (queued delivery while busy is honestly
  // rejected; see `onPiDispatch`). Attribution never guesses across queued ops
  // from turn boundaries: every streamed event carries the single active
  // dispatch op, `turn_end` journals its turn via the translator, and the
  // authoritative Pi `agent_settled` completes it (translator `settle()` clears
  // ALL transient so settled turns retain nothing).
  //
  // SNC1.5 translator semantics (see `pi-translator.ts`):
  // - stable `contentIndex`/`toolCallId` identities so deltas coalesce;
  // - finals reconcile (authoritative) rather than duplicate deltas;
  // - tool stdout stays in tool events/history (never assistant prose);
  // - thinking streams separately and never journals as prose;
  // - `aborted` preserved, `toolUse` → `stop` (multi-turn continuations stay
  //   on the same op until `agent_settled`);
  // - unknown/suppressed chrome maps to `[]` and changes no state.

  /** Journal translator entries into bridge history (user → tools → assistant order). */
  private journalTranslatorEntries(
    session: ProviderSession,
    entries: Array<{ role: "user" | "assistant" | "tool"; text: string }>,
  ): void {
    for (const entry of entries) {
      // History roles mirror the translator: `tool` entries carry tool output
      // (never prose); `assistant` carries reconciled text finals (never tool
      // output); `user` carries the confirmed prompt. All three are needed so
      // `unknown`-dispatch reconciliation sees faithful evidence.
      this.appendHistory(session, { role: entry.role, text: entry.text });
    }
    if (entries.length > 0) {
      session.metadata.messageCount = session.history.filter(
        (e) => e.role === "user" || e.role === "assistant" || e.role === "tool",
      ).length;
    }
  }

  /** Keep the legacy mirrors in sync (translator is authoritative). */
  private syncRuntimeMirrors(runtime: PiRuntime): void {
    runtime.pendingUserText = runtime.translator.pendingUser;
    runtime.activeText = runtime.translator.currentAssistantText();
  }

  private attachPiStreaming(sessionId: string, session: ProviderSession, runtime: PiRuntime): void {
    const onEvent = (event: PiServerEvent): void => {
      // SNC1.6 live option tracking: Pi emits `thinking_level_changed` on
      // every `set_thinking_level` / `cycle_thinking_level` / `set_model`
      // (proven in `models-thinking.jsonl`). Update the lease immediately so
      // `get_session` reports provider-confirmed thinking even before its
      // best-effort `get_state` refresh. Never a bridge `session_event`
      // (the bridge has no option-changed event; Orca re-reads via
      // `get_session` / `options_updated`). Bounded: unknown shapes ignored.
      try {
        const raw = event as unknown as Record<string, unknown>;
        if (raw["type"] === "thinking_level_changed" && typeof raw["level"] === "string") {
          session.metadata.thinkingLevel = raw["level"] as string;
          if (session.options.thinkingLevel !== undefined) {
            session.options.thinkingLevel = raw["level"] as string;
          }
        }
      } catch {
        // Live tracking is best-effort; translator mapping below still applies.
      }
      const activeOpId = session.activeOpId;
      const hasActiveOp = (session.activeOpId ?? activeOpId) !== null;
      // No active turn: turn-scoped events must not mutate translator state
      // (P1: a late `tool_execution_end` after `agent_settled` would otherwise
      // repopulate `translator.tools`, survive `resetTurn()` on the next
      // dispatch, and leak into the next turn's history). Use the pure mapper
      // with no state change: forward only stateless dialogs (actionable via
      // requestId), drop everything else. Queue/compaction/retry/unknown
      // already map to `[]` (bounded) so they never reach here as changes.
      // Dialogs arriving without an active turn are still actionable (e.g.
      // immediate `/` extension commands, which never start a turn): track
      // them in the SNC1.6 pending map (stable identity, exactly-once) and
      // emit without an opId so Orca answers via `requestId`.
      if (!hasActiveOp) {
        let stateless: ReturnType<typeof mapPiRecordToBridgeEvents>;
        try {
          stateless = mapPiRecordToBridgeEvents(event as unknown as Record<string, unknown>);
        } catch {
          return;
        }
        for (const bridgeEvent of stateless) {
          if (bridgeEvent.type !== "prompt_request") continue;
          // Stable identity: duplicate Pi ids while pending are ignored
          // (never emit a second card for the same request).
          if (runtime.pendingPrompts.has(bridgeEvent.requestId)) continue;
          runtime.pendingPrompts.set(bridgeEvent.requestId, "");
          session.pendingPrompt = { requestId: bridgeEvent.requestId, opId: "" };
          this.send({
            v: 1,
            kind: "session_event",
            sessionId,
            event: bridgeEvent,
          });
        }
        return;
      }
      let mapped: ReturnType<PiTranslator["applyPiRecord"]>;
      try {
        mapped = runtime.translator.applyPiRecord(event as unknown as Record<string, unknown>);
      } catch {
        return;
      }
      this.syncRuntimeMirrors(runtime);
      for (const bridgeEvent of mapped) {
        if (bridgeEvent.type === "prompt_request") {
          const currentOp = session.activeOpId ?? activeOpId ?? "";
          // SNC1.6 stable identity: ignore duplicate Pi ids while pending
          // (one card per requestId; the first op wins). New ids are tracked
          // for exactly-once answers + retirement (see `onPiAnswerPrompt`).
          if (runtime.pendingPrompts.has(bridgeEvent.requestId)) continue;
          runtime.pendingPrompts.set(bridgeEvent.requestId, currentOp);
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
          // assistant/tool content) so a later exit-before-`turn_end` still
          // leaves history evidence that prevents a duplicate retry.
          const currentOp = session.activeOpId ?? activeOpId;
          if (currentOp && runtime.translator.pendingUser !== null) {
            const user = runtime.translator.pendingUser;
            if (user !== null) {
              this.appendHistory(session, { role: "user", text: user });
              runtime.translator.clearPendingUser();
              this.syncRuntimeMirrors(runtime);
              session.metadata.messageCount = session.history.filter(
                (e) => e.role === "user" || e.role === "assistant" || e.role === "tool",
              ).length;
            }
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
            // Authoritative completion: drain any remaining turn entries
            // (normal path already journaled per `turn_end`; this covers
            // settle-without-`turn_end` robustness) in user→tools→assistant
            // order, then clear ALL transient (requirement) plus per-op
            // cancel/pending-prompt state so settled turns retain nothing.
            // SNC1.6: retire every pending dialog for this op (provider
            // cancellation retirement — late answers after settle are stale
            // refusals, never forwarded to Pi).
            const entries = runtime.translator.settle();
            this.journalTranslatorEntries(session, entries);
            this.syncRuntimeMirrors(runtime);
            session.cancelledOps.delete(currentOp);
            this.retirePromptsForOp(session, runtime, currentOp);
            // Single-turn honesty: the settled op is still active (queued
            // delivery while busy is rejected, so there is nothing to
            // promote). Multi-turn tool continuations already attributed to
            // this op via per-`turn_end` drains above.
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
            // Per-turn boundary: journal this turn (pending user first, then
            // completed tools, then assistant) so later turns attribute
            // correctly. Tool-only turns journal their tool entries (SNC1.5:
            // tool stdout never becomes assistant prose). Text finals
            // reconcile (never duplicate deltas) via the translator.
            const entries = runtime.translator.drainTurnEnd();
            this.journalTranslatorEntries(session, entries);
            this.syncRuntimeMirrors(runtime);
            // No promotion: hold the single active turn until Pi's
            // authoritative `agent_settled` completes it (see above). Queued
            // delivery while busy is rejected, so multi-turn tool
            // continuations always belong to the current prompt.
          }
          continue;
        }
        // text_*/thinking_*/tool_*: stream with the active turn id.
        // Outside a turn (e.g. late events after settle) they are dropped
        // rather than journaled under a wrong op. Unknown chrome never reaches
        // here (maps to `[]` above with no state change).
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

  /** Retire every pending dialog for one op (settle/cancel). Keeps the base
   * single slot in sync (clears when it names the retired op) so legacy
   * readers never see a stale prompt. Future answers for retired ids are
   * stale refusals (`UNKNOWN_REQUEST`). */
  private retirePromptsForOp(session: ProviderSession, runtime: PiRuntime, opId: string): void {
    for (const [requestId, ownerOp] of [...runtime.pendingPrompts]) {
      if (ownerOp === opId) runtime.pendingPrompts.delete(requestId);
    }
    if (session.pendingPrompt?.opId === opId) session.pendingPrompt = null;
  }

  /** Retire every pending dialog in a session (exit/release/close fence). */
  private retireAllPrompts(session: ProviderSession, runtime: PiRuntime): void {
    runtime.pendingPrompts.clear();
    session.pendingPrompt = null;
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
    // SNC1.5: translator transient is cleared (no retained state) plus
    // per-op cancel/pending-prompt cleanup so exit leaves nothing behind.
    // SNC1.6: retire ALL pending dialogs (acquisition fence — a later
    // reacquire with the same sessionId must never answer a pre-exit
    // dialog, and Pi can never answer it either).
    if (runtime) {
      runtime.translator.resetAll();
      runtime.pendingUserText = null;
      runtime.activeText = "";
      this.retireAllPrompts(session, runtime);
      if (activeOpId) {
        session.cancelledOps.delete(activeOpId);
      }
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
    // SNC1.6 live image gating where the catalog is cached: hint-based
    // `validatePiDispatch` above stays the floor (Pi would fail late on
    // text-only models), but when `acquire`/`set_options` already cached the
    // live catalog, a text-only confirmed model rejects with the same
    // actionable code instead of relying on hints alone. History never
    // journals image bytes (user entries carry text only) — see below.
    const imageCount = msg.message.images?.length ?? 0;
    if (imageCount > 0) {
      const liveSupports = this.modelSupportsImages(session.metadata.model, runtime.cachedModels);
      if (liveSupports === false) {
        this.send({
          v: 1,
          kind: "dispatch_ack",
          opId: msg.opId,
          sessionId: msg.sessionId,
          status: "rejected",
          reason: `model-rejects-images: ${session.metadata.model ?? "unknown-model"}`,
        });
        return;
      }
    }
    const isImmediateCommand = msg.message.text.trimStart().startsWith("/");
    // SNC1.6 immediate `/` extension commands: Pi handles them without a
    // turn lifecycle (no `turn_start`/`turn_end`, no session entries per the
    // Pi contract) and may emit dialogs before the `prompt` response. They
    // run without taking the single active turn (no `activeOpId`, no
    // translator user, no history entries — image bytes never journaled).
    // While busy they stay honestly rejected (concurrent immediate + turn
    // attribution would need queue evidence; Pi-owned queue stays deferred).
    if (isImmediateCommand) {
      if (imageCount > 0) {
        this.send({
          v: 1,
          kind: "dispatch_ack",
          opId: msg.opId,
          sessionId: msg.sessionId,
          status: "rejected",
          reason: "extension-command-images-unsupported (send plain text for / commands)",
        });
        return;
      }
      if (session.activeOpId) {
        this.send({
          v: 1,
          kind: "dispatch_ack",
          opId: msg.opId,
          sessionId: msg.sessionId,
          status: "rejected",
          reason: "already-streaming (immediate / commands need an idle session; wait for idle or cancel)",
        });
        return;
      }
      // Idle immediate: direct Pi `prompt` with no turn tracking. Dialogs
      // arriving mid-call flow via the no-active-op stateless path above
      // (tracked in `pendingPrompts` with `""` op, answerable via
      // `requestId`). No translator state, no history entries.
      try {
        await runtime.conn.prompt(msg.message.text);
      } catch (error) {
        const code = (error as { code?: unknown })?.code;
        const ambiguous = (error as { ambiguous?: unknown })?.ambiguous;
        if (code === "rejected" && ambiguous === false) {
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
      this.send({ v: 1, kind: "dispatch_ack", opId: msg.opId, sessionId: msg.sessionId, status: "accepted" });
      return;
    }
    if (session.activeOpId) {
      // Single-turn honesty: while a turn streams, every new dispatch —
      // including `steer`/`followUp` — is honestly rejected without touching
      // Pi (definite refusal: Pi never saw it, safe to retry after idle or
      // cancel). Accepting a queued prompt would require proving Pi owns its
      // future turn across steer/followUp modes, tool-loop continuations,
      // retry/compaction, immediate-command handling, and ambiguous-queue
      // ordering — all needing user-message/`queue_update` evidence and
      // retry/compaction boundaries. Guessing ownership from turn boundaries
      // misattributes turns and fabricates history, so the queue stays
      // rejected; SNC1.5 keeps this honesty and owns faithful rendering of
      // the single active turn instead.
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
    // actually streams the turn (`turn_start`/`turn_end` journal user first via
    // the translator), so `get_history` never fabricates a turn Pi never
    // received. Definite refusal clears everything below (Pi made no change);
    // success journals immediately; ambiguity reconciles against Pi state.
    session.activeOpId = msg.opId;
    session.metadata.isStreaming = true;
    // Fresh agent: clear ALL prior translator state (not just per-turn text)
    // so a late event that raced `settle()` can never leak into the new turn
    // even if the no-active-op gate above missed it (defense in depth with
    // the gate; `notePendingUser` re-arms the new turn immediately after).
    runtime.translator.resetAll();
    runtime.translator.notePendingUser(msg.message.text);
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
        runtime.translator.clearPendingUser();
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
          runtime.translator.clearPendingUser();
          runtime.translator.resetTurn();
          runtime.pendingUserText = null;
          runtime.activeText = "";
        }
      } else {
        runtime.translator.clearPendingUser();
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
    // its own `settled` (which journaled user→tools→assistant) — skip the
    // duplicate. SNC1.5: translator is authoritative; mirrors kept in sync.
    if (session.activeOpId === msg.opId && runtime.translator.pendingUser !== null) {
      this.appendHistory(session, { role: "user", text: msg.message.text });
      session.metadata.messageCount = session.history.filter(
        (e) => e.role === "user" || e.role === "assistant" || e.role === "tool",
      ).length;
      runtime.translator.clearPendingUser();
      runtime.pendingUserText = null;
    } else {
      runtime.translator.clearPendingUser();
      runtime.pendingUserText = null;
    }
    this.syncRuntimeMirrors(runtime);
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
    live.metadata.messageCount = live.history.filter(
      (e) => e.role === "user" || e.role === "assistant" || e.role === "tool",
    ).length;
    runtime.translator.resetTurn();
    runtime.activeText = "";
    this.syncRuntimeMirrors(runtime);
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
    // SNC1.6 provider-cancellation retirement: a cancel for the live turn
    // retires its pending dialogs immediately (late answers after cancel are
    // stale refusals). A stale cancel for a non-live op never touches live
    // prompts or the live turn (fenced below).
    if (target !== "" && (targetOpId === undefined || targetOpId === session.activeOpId)) {
      this.retirePromptsForOp(session, runtime, target);
    }
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

  // -- dialogs: answer_prompt -> Pi extension_ui_response (SNC1.6) ------------
  //
  // Stable identity: Pi `extension_ui_request.id` is preserved verbatim as
  // bridge `prompt_request.requestId` (never synthesized). Exactly-once:
  // the first `answer_prompt` for a `requestId` forwards one Pi
  // `extension_ui_response` and deletes the map entry; later answers for the
  // same id are stale/late refusals (`UNKNOWN_REQUEST`, never re-sent to
  // Pi) — this is what lets Orca do a durable CAS and then answer once.
  // Retirement: turn settle / cancel / Pi exit / release / close clear the
  // map (acquisition fence — prompts never leak across sessions/turns).
  // Bounded unsupported kinds: fire-and-forget / unknown Pi UI methods map
  // to `[]` in `pi-mapping.ts` and never create entries, so they never block
  // and can never be answered (any answer for their ids is UNKNOWN).

  private onPiAnswerPrompt(msg: AnswerPromptRequest): void {
    if (!this.requireHello(msg.opId)) return;
    // Find the owning Pi session via the SNC1.6 pending map (multi-dialog).
    // Fall back to the base single slot for providers that never populated
    // the map (defense in depth; Pi always populates the map above).
    let ownerId: string | null = null;
    let ownerRuntime: PiRuntime | undefined;
    for (const [sessionId, runtime] of this.piRuntimes) {
      if (runtime.pendingPrompts.has(msg.requestId)) {
        ownerId = sessionId;
        ownerRuntime = runtime;
        break;
      }
    }
    if (!ownerRuntime) {
      for (const [sessionId, candidate] of this.sessions) {
        if (candidate.pendingPrompt?.requestId === msg.requestId) {
          ownerId = sessionId;
          ownerRuntime = this.piRuntimes.get(sessionId);
          break;
        }
      }
    }
    if (!ownerId || !ownerRuntime) {
      // Stale/late/unknown: never seen, already answered, or retired via
      // settle/cancel/exit/release. Refuse without touching any Pi child —
      // never broadcast to every child.
      this.send({
        v: BRIDGE_PROTOCOL_VERSION,
        kind: "error",
        opId: msg.opId,
        error: { code: "UNKNOWN_REQUEST", message: `unknown prompt request ${msg.requestId}` },
      });
      return;
    }
    const session = this.sessions.get(ownerId);
    // Exactly-once: delete before forwarding so a racing duplicate cannot
    // double-send to Pi even if `respondToExtensionUi` throws.
    ownerRuntime.pendingPrompts.delete(msg.requestId);
    if (session?.pendingPrompt?.requestId === msg.requestId) session.pendingPrompt = null;
    try {
      if (msg.cancelled) {
        ownerRuntime.conn.respondToExtensionUi({ type: "extension_ui_response", id: msg.requestId, cancelled: true });
      } else if (typeof msg.value === "boolean") {
        ownerRuntime.conn.respondToExtensionUi({ type: "extension_ui_response", id: msg.requestId, confirmed: msg.value });
      } else {
        ownerRuntime.conn.respondToExtensionUi({ type: "extension_ui_response", id: msg.requestId, value: msg.value });
      }
    } catch {
      // Pi is gone; the turn will settle via exit handling. The answer is
      // still consumed (exactly-once holds) so a retry after reacquire is
      // a fresh `requestId`, never a duplicate send.
    }
    // Benign ack so the host `answerPrompt()` promise resolves (the turn
    // continues via `session_event`; see `host.ts` benign-ANSWERED path).
    // Never echoes the value (secret-safe: answers may carry free-form text).
    this.send({
      v: BRIDGE_PROTOCOL_VERSION,
      kind: "error",
      opId: msg.opId,
      error: { code: "ANSWERED", message: "prompt answer recorded" },
    });
  }

  protected override onPromptAnswered(session: ProviderSession, requestId: string, value: unknown, cancelled: boolean): void {
    // Legacy base-class path (single-slot `pendingPrompt`). Pi sessions are
    // answered via `onPiAnswerPrompt` (map-based, exactly-once) and never
    // reach here; keep this fallback fenced to the owning/single runtime so
    // a stray base call can never broadcast to every Pi child.
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
    // Consume the map entry when present so base + map stay consistent.
    target.pendingPrompts.delete(requestId);
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

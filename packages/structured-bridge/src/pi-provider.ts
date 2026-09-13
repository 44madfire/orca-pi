/**
 * Pi-backed external provider (SNC1.4 + SNC1.5 + SNC1.6 + SNC1.7, orca-pi owned).
 *
 * Combines the production SNC1.2 `PiRpcConnection` transport with the SNC1.3
 * external structured-session bridge to run the first real Pi structured
 * Native Chat session in Orca. This file is **never vendored into Orca core**:
 * the fork vendors only `framing.ts` + `protocol.ts` + `host.ts`
 * (provider-neutral). Everything Pi stays here plus `pi-mapping.ts`.
 *
 * Capabilities (per #14 + #15 + #16 + #17):
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
 * images (this file + `pi-mapping.ts`); SNC1.7 owns history/current-branch/
 * resume (this file + `pi-history.ts`): `acquire{resumePath}` switches into
 * the Pi session file and rebuilds only root -> leaf (abandoned siblings
 * excluded) through the same mapping as live, with wholesale replace (no
 * duplication) and fail-closed diagnostics.
 * `set_options` applies live to Pi and acks provider-confirmed values;
 * `get_history` serves the rebuilt + live-appended transcript with the Pi
 * leaf (never the page end); `get_session` refreshes provider-confirmed model/thinking
 * best-effort. Immediate `/` extension commands run without a turn (no
 * journal entries, per the Pi contract) and stay honestly rejected while busy
 * to avoid concurrent attribution without queue evidence.
 */

import {
  PiRpcConnection,
  redactSecrets,
  resolvePiRpcEnv,
  toPiRpcProcessSpec,
  type PiEntriesData,
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
  type PiTreeData,
  type ResolvedPiSpecLike,
} from "@orca-pi/pi-rpc";
import {
  BRIDGE_PROTOCOL_VERSION,
  redactSecretsFromText,
  type AcquireRequest,
  type AnswerPromptRequest,
  type BridgeCapabilities,
  type BridgeHistoryEntry,
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
import { open } from "node:fs/promises";
import path from "node:path";
import {
  extractActiveBranch,
  extractActiveBranchFromTree,
  translatePiEntryToBridgeEntries,
  type PiHistoryEntryLike,
} from "./pi-history.js";

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
  getState(opts?: { timeoutMs?: number }): Promise<PiState>;
  respondToExtensionUi(response: { type: "extension_ui_response"; id: string; value?: unknown; confirmed?: boolean; cancelled?: boolean }): void;
  getAvailableModels?(opts?: { timeoutMs?: number }): Promise<{ models: PiModel[] }>;
  setModel?(provider: string, modelId: string, opts?: { timeoutMs?: number }): Promise<PiModel>;
  getAvailableThinkingLevels?(opts?: { timeoutMs?: number }): Promise<{ levels: string[] }>;
  setThinkingLevel?(level: string, opts?: { timeoutMs?: number }): Promise<void>;
  setAutoCompaction?(enabled: boolean, opts?: { timeoutMs?: number }): Promise<void>;
  /** SNC1.7 history/branch/resume RPCs (optional so SNC1.4 minimal fakes keep working). */
  getEntries?(since?: string, opts?: { timeoutMs?: number }): Promise<PiEntriesData>;
  getTree?(opts?: { timeoutMs?: number }): Promise<PiTreeData>;
  switchSession?(sessionPath: string, opts?: { timeoutMs?: number }): Promise<{ cancelled: boolean }>;
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
  /**
   * Deadline for Pi option RPCs in bridge requests (default 8000ms, must stay
   * below the host request deadline — default 10s — so provider mutations
   * complete (or fail) before Orca drops correlation; avoids late
   * options_updated after host timeout. Catalog warmup/dispatch lookups use
   * 3000ms via fetchCatalogShared (shared, bounded).
   */
  piOptionTimeoutMs?: number;
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
   * SNC1.6 interactive prompts: bridge-visible `requestId`
   * (`<sessionId>:<piId>`, see `promptPiIds`) → originating dispatch `opId`
   * for every unanswered Pi dialog in this session. Exactly-once:
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
  /**
   * Bridge-visible prompt id → originating Pi `extension_ui_request.id`.
   * Bridge ids are namespaced per session (`<sessionId>:<piId>`) because Pi
   * children are independently spawned processes whose local dialog ids
   * carry no cross-process uniqueness guarantee: two sessions may hold the
   * same Pi-local id, and the raw id alone cannot route an answer. The map
   * gives the exact reverse lookup without parsing (Pi ids may contain any
   * separator). Cleared/retired together with `pendingPrompts`.
   */
  promptPiIds: Map<string, string>;
  /**
   * SNC1.7 resume state (opaque Pi ids only, never paths — secret hygiene):
   * `piLeafId` always names the Pi session leaf (never the page end), even
   * when the leaf is a skipped non-message entry (e.g. trailing
   * `session_info`). `piChainIds` is the full active-branch id order
   * (root → leaf, including skipped non-message entries) so `get_history`
   * cursors naming skipped entries (e.g. bootstrap `thinking_level_change`)
   * still resolve to strictly-after transcript rows instead of an empty page.
   * Refreshed at acquire-resume and best-effort after each settle (background,
   * never blocking the turn); `get_history` serves the cache fast.
   */
  piLeafId?: string;
  piChainIds?: string[];
  /**
   * SNC1.7 cursor-alignment state (P1 review fix): `historyChainPos[i]`
   * parallels `session.history[i]` with that row's position in the Pi active
   * chain, or `null` for live rows not yet reconciled to Pi ids. Lets
   * `get_history(cursor=<Pi leaf>)` resolve through the chain even after live
   * turns appended synthetic ids. Reset wholesale on rebuild, appended for
   * live rows, re-keyed by `reconcileSettledTurn`.
   */
  historyChainPos: (number | null)[];
  /**
   * Synthetic live-row id sequence. Live rows are keyed `live-<n>`,
   * namespaced so they can never collide with Pi entry ids — a rebuilt Pi
   * `e5` plus a live `e5` would corrupt cursor resolution (same P1).
   */
  liveSeq: number;
  /**
   * `session.history.length` when the current op took the turn (its rows are
   * contiguous from here); cleared at settle. Lets `reconcileSettledTurn`
   * attribute exactly this op's rows for Pi re-keying.
   */
  opHistoryBase: number | null;
  /**
   * Exposed-leaf high-water marks (P1 review fix, round 2): `leafEnds` maps
   * every `leafId` ever returned by `get_history` to the transcript length it
   * was advertised with — "a cursor advertised after a page must denote the
   * end of that page". This keeps Pi-leaf cursors honest even when the rows
   * they cover are still unmapped `live-N` rows (fresh-acquire race where the
   * baseline lookup loses to the first settle, or any documented reconcile
   * mismatch that advances the leaf without re-keying). Cleared on wholesale
   * rebuild (ordinals invalidated); re-keying in place never changes lengths,
   * so recorded ends stay valid across reconciles.
   */
  leafEnds: Map<string, number>;
  /**
   * Re-key tombstones (P1 round-3 fix): `live-N` id → Pi entry id for every
   * settled row that `reconcileSettledTurn` re-keyed in place. Re-keying
   * retires the live id from the transcript, but already-returned
   * `nextCursor` values may still name it — resolving through the tombstone
   * keeps those cursors positional-stable (the Pi row never moves). Cleared
   * on wholesale rebuild (ids from the old transcript are meaningless).
   */
  rekeyedFrom: Map<string, string>;
  /** Last `get_available_models` result for image-gating + model refs (best-effort cache). */
  cachedModels?: PiModel[];
  /** Shared in-flight catalog lookup (P2: concurrent image dispatches share one Pi RPC). */
  catalogInflight?: Promise<PiModel[]> | null;
  /**
   * SNC1.6 immediate `/` command in flight (no turn). While set, the first
   * Pi dialog for this session acks `accepted` early (Pi definitely owns the
   * command and waits for an answer) so the host dispatch deadline (10s)
   * never fires while the user thinks. The `prompt` response itself arrives
   * after the answer (per `extension-ui.jsonl`) and needs no second ack.
   * Cleared on ack (accepted/rejected/unknown) or session teardown.
   */
  pendingImmediate: { opId: string; acked: boolean } | null;
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
  private readonly piOptionTimeoutMs: number;
  private readonly createConnection: PiConnectionFactory;
  private readonly resolvePiSpec?: PiSpecResolver;

  constructor(opts: PiBridgeProviderOptions = {}) {
    // SNC1.7 truthfulness: history/branch/resume is live (see `pi-history.ts`
    // + `onPiAcquire` resumePath handling below), so `resume` is true and
    // Orca may expose its shared Native Chat resume paths. `options` stays
    // true (SNC1.6 live model/thinking/prompt/image controls). Both rest on
    // provider-confirmed Pi RPC (never diverging hints).
    const snc16Capabilities: BridgeCapabilities = { ...piBridgeCapabilities(), options: true, resume: true };
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
    this.piOptionTimeoutMs = opts.piOptionTimeoutMs ?? 8000;
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

    // SNC1.7 resume: `acquire{resumePath}` restores an existing Pi session file
    // into this fresh child via typed `switch_session` (never CLI pickers),
    // then reconstructs only root -> current leaf (see `pi-history.ts`). The
    // host owns `resumePath` for handoff; the provider never echoes it back
    // (secret hygiene: no absolute paths over the bridge).
    const resumePath =
      typeof msg.resumePath === "string" && msg.resumePath.trim() !== "" ? msg.resumePath : undefined;
    if (resumePath !== undefined) {
      await this.onPiAcquireResume({ conn, sessionId, resumePath, msg });
      return;
    }

    const piSessionId = typeof state.sessionId === "string" && state.sessionId !== "" ? state.sessionId : sessionId;
    // SNC1.6: persist canonical qualified refs where the provider is known
    // (duplicate bare ids like `gpt-5.6-luna` exist under two providers in
    // the live catalog — a bare lease would not restore). `get_state` carries
    // the full `Model{provider,id}`, so qualify when both are present.
    const stateModel = state.model;
    const qualifiedStateModel =
      typeof stateModel?.id === "string" && stateModel.id !== "" && typeof stateModel?.provider === "string" && stateModel.provider !== ""
        ? `${stateModel.provider}/${stateModel.id}`
        : typeof stateModel?.id === "string"
          ? stateModel.id
          : undefined;
    const model = qualifiedStateModel ?? msg.options?.model;
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
      promptPiIds: new Map<string, string>(),
      pendingImmediate: null,
      historyChainPos: [],
      liveSeq: 0,
      opHistoryBase: null,
      leafEnds: new Map<string, number>(),
      rekeyedFrom: new Map<string, string>(),
    };
    this.piRuntimes.set(sessionId, runtime);
    const session = this.sessions.get(sessionId);
    if (session) this.attachPiStreaming(sessionId, session, runtime);
    // SNC1.6: populate the live model catalog best-effort so image gating is
    // authoritative (not hint-only) once available. Background (never blocks
    // `acquired`): a catalog read must not delay the lease or hang acquire
    // on minimal transports that never answer `get_available_models` (the
    // force-close test fakes only `get_state`). Hint checks remain the floor
    // until the cache lands; `set_model` refreshes it synchronously.
    {
      // P2: route warmup through the shared bounded lookup (3000ms real Pi
      // deadline, shared inflight) so no default-timeout 30s catalog RPC
      // remains pending alongside dispatch lookups.
      void this.fetchCatalogShared(sessionId, 3000).catch(() => null);
    }
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
    // SNC1.7: establish the Pi leaf baseline best-effort for fresh sessions
    // (bootstrap leaf when Pi is history-capable; ignored for minimal fakes
    // so SNC1.4 tests keep working). Background, never blocks `acquired`:
    // a history RPC must not delay the lease or hang acquire on minimal
    // transports. Failures never fail a fresh acquire — only `resumePath`
    // rebuilds are required (fail-closed); fresh history is empty by
    // construction. Stored as opaque ids only (never paths).
    void this.refreshPiLeafBestEffort(sessionId).catch(() => undefined);
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

  // -- SNC1.7 history/current-branch/resume (see `pi-history.ts`) -----------
  //
  // Resume = spawn a fresh `pi --mode rpc` child in the Orca-selected cwd,
  // `switch_session{resumePath}` into the existing Pi session file, apply
  // acquire-time options live (so the rebuilt leaf includes them), then
  // reconstruct only root -> current leaf (abandoned fork siblings excluded)
  // and translate through the same semantic mapping as live events. The host
  // owns `resumePath` for handoff; the provider never echoes paths back over
  // the bridge (only opaque `providerSessionId`/`leafId` cross it).
  //
  // Fail-closed (actionable, secret-safe, no prompt text or paths):
  // - missing `switch_session`/`get_entries`/`get_tree` support ->
  //   PI_RESUME_UNSUPPORTED (minimal transports stay on TUI);
  // - `switch_session` transport failure -> PI_RESUME_FAILED;
  // - empty/unavailable entries, unknown leaf, broken parent chain, or cycle
  //   -> PI_HISTORY_EMPTY / PI_HISTORY_LEAF_MISSING / PI_HISTORY_CHAIN_BROKEN
  //   / PI_HISTORY_CYCLE (never a silent truncated transcript);
  // - Pi reports messages but translation yields zero rows (unknown future
  //   roles) -> PI_HISTORY_INCOMPATIBLE.
  // A `resumePath` that names a missing file succeeds per the Pi contract as
  // a new empty session (fresh bootstrap, `messageCount: 0`): it returns
  // `acquired{resumed: false}` with empty history (honest new, not a silent
  // resume). Only a non-empty rebuilt transcript returns `resumed: true`.
  // Partial/aborted last turns recover honestly: a trailing user without a
  // following assistant stays a lone user (no fabricated completion); an
  // aborted assistant still journals its text (same as live aborts).

  private async onPiAcquireResume(ctx: {
    conn: PiProviderConnection;
    sessionId: string;
    resumePath: string;
    msg: AcquireRequest;
  }): Promise<void> {
    const { conn, sessionId, resumePath, msg } = ctx;
    const opId = msg.opId;
    if (typeof conn.switchSession !== "function") {
      await conn.close(this.piCloseGraceMs).catch(() => undefined);
      this.send({
        v: BRIDGE_PROTOCOL_VERSION,
        kind: "error",
        opId,
        error: {
          code: "PI_RESUME_UNSUPPORTED",
          message: "Pi connection does not support session resume (reacquire without resumePath or update Pi)",
        },
      });
      return;
    }
    // P1 (ChatGPT review): honor `session_before_switch` vetoes. A
    // `{cancelled:true}` switch rebinds NOTHING — Pi stays on its previous
    // session — so continuing would rebuild the WRONG history and can emit
    // `acquired{resumed:true}` for a file Pi never loaded. Fail closed.
    // P1 round-2 (ChatGPT review, verified against the Pi 0.85.1 source and
    // the on-disk `{"type":"session",...,"cwd":...}` header): `switch_session`
    // rebinds the runtime cwd to the SESSION FILE's stored cwd
    // (`SessionManager.open` → `createRuntime({cwd: getCwd()})`, with no
    // cwdOverride on the RPC path). A resumePath from another/moved workspace
    // would otherwise yield a lease claiming `workspaceRoot` while Pi tools
    // execute in the stored cwd — violating the exact-cwd invariant. Validate
    // the header BEFORE switching (the fresh child has nothing to lose yet).
    const cwdCheck = await this.checkResumePathCwd(resumePath, msg.workspaceRoot);
    if (!cwdCheck.ok) {
      await conn.close(this.piCloseGraceMs).catch(() => undefined);
      this.send({
        v: BRIDGE_PROTOCOL_VERSION,
        kind: "error",
        opId,
        error: { code: cwdCheck.code, message: cwdCheck.message },
      });
      return;
    }
    let switchCancelled = false;
    try {
      const switched = await conn.switchSession(resumePath, { timeoutMs: this.piOptionTimeoutMs });
      switchCancelled = switched?.cancelled === true;
    } catch (error) {
      await conn.close(this.piCloseGraceMs).catch(() => undefined);
      this.send({
        v: BRIDGE_PROTOCOL_VERSION,
        kind: "error",
        opId,
        error: { code: "PI_RESUME_FAILED", message: sanitizeCode(`Pi session resume failed: ${this.shortPiError(error)}`) },
      });
      return;
    }
    if (switchCancelled) {
      await conn.close(this.piCloseGraceMs).catch(() => undefined);
      this.send({
        v: BRIDGE_PROTOCOL_VERSION,
        kind: "error",
        opId,
        error: {
          code: "PI_RESUME_CANCELLED",
          message: "Pi refused the session switch (vetoed by an extension). Retry without resumePath for a fresh session or choose another session file.",
        },
      });
      return;
    }
    let state: PiState;
    try {
      state = await conn.getState({ timeoutMs: this.piOptionTimeoutMs });
    } catch (error) {
      await conn.close(this.piCloseGraceMs).catch(() => undefined);
      this.send({
        v: BRIDGE_PROTOCOL_VERSION,
        kind: "error",
        opId,
        error: { code: "PI_STATE_FAILED", message: sanitizeCode(`Pi resumed but get_state failed: ${this.shortPiError(error)}`) },
      });
      return;
    }
    const piSessionId = typeof state.sessionId === "string" && state.sessionId !== "" ? state.sessionId : sessionId;
    const stateModel = state.model;
    const qualifiedStateModel =
      typeof stateModel?.id === "string" && stateModel.id !== ""
        ? typeof stateModel?.provider === "string" && stateModel.provider !== ""
          ? `${stateModel.provider}/${stateModel.id}`
          : stateModel.id
        : undefined;
    const model = qualifiedStateModel ?? msg.options?.model;
    const thinkingLevel = typeof state.thinkingLevel === "string" ? state.thinkingLevel : msg.options?.thinkingLevel;
    const metadata: BridgeSessionMetadata = {
      sessionId,
      providerSessionId: piSessionId,
      workspaceRoot: msg.workspaceRoot,
      messageCount: 0,
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
      promptPiIds: new Map<string, string>(),
      pendingImmediate: null,
      historyChainPos: [],
      liveSeq: 0,
      opHistoryBase: null,
      leafEnds: new Map<string, number>(),
      rekeyedFrom: new Map<string, string>(),
    };
    this.piRuntimes.set(sessionId, runtime);
    const session = this.sessions.get(sessionId);
    if (session) this.attachPiStreaming(sessionId, session, runtime);
    void this.fetchCatalogShared(sessionId, 3000).catch(() => null);
    try {
      runtime.unsubs.push(conn.onExit((info) => this.onPiExit(sessionId, info)));
    } catch {
      // Minimal fakes may omit onExit (same as fresh path).
    }
    if (msg.options && (msg.options.model !== undefined || msg.options.thinkingLevel !== undefined || msg.options.autoCompaction !== undefined)) {
      const applied = await this.applyPiOptions(sessionId, msg.options);
      if (!applied.ok) {
        await this.teardownPiRuntime(sessionId).catch(() => undefined);
        this.sessions.delete(sessionId);
        this.send({
          v: BRIDGE_PROTOCOL_VERSION,
          kind: "error",
          opId,
          error: { code: applied.code, message: applied.message },
        });
        return;
      }
    }
    const rebuilt = await this.rebuildHistoryFromPi(sessionId);
    if (!rebuilt.ok) {
      await this.teardownPiRuntime(sessionId).catch(() => undefined);
      this.sessions.delete(sessionId);
      this.send({
        v: BRIDGE_PROTOCOL_VERSION,
        kind: "error",
        opId,
        error: { code: rebuilt.code, message: rebuilt.message },
      });
      return;
    }
    const current = this.sessions.get(sessionId);
    if (!current) {
      await this.teardownPiRuntime(sessionId).catch(() => undefined);
      this.send({
        v: BRIDGE_PROTOCOL_VERSION,
        kind: "error",
        opId,
        error: { code: "UNKNOWN_SESSION", message: "unknown session" },
      });
      return;
    }
    // Missing-file-creates-empty (Pi contract): empty transcript + idle Pi
    // reports a new session, not a resume — return resumed:false honestly so
    // Orca never mistakes a fresh bootstrap for restored history.
    const resumed = rebuilt.history.length > 0;
    this.send({
      v: 1,
      kind: "acquired",
      opId,
      sessionId,
      resumed,
      metadata: { ...current.metadata },
    });
  }

  /**
   * Rebuild one idle session's bridge history from Pi's active branch
   * (required path for `resumePath`; replaces wholesale — Pi is the source
   * of truth after `switch_session`, so replacement never duplicates: live
   * rows already landed in Pi converge by identical `(role, text)` order and
   * only re-id from live `eN` to stable Pi entry ids). Must only run when
   * idle (no `activeOpId`): live owns streaming turns and is never rebuilt
   * mid-turn.
   */
  /**
   * Fetch Pi's active branch (root → leaf, inclusive): flat `get_entries` +
   * leaf walk first (single RPC), `get_tree` fallback when entries are
   * unavailable or the flat chain is broken (same walk over the flattened
   * tree, so both converge). Shared by `rebuildHistoryFromPi` (fail-closed
   * resume) and `reconcileSettledTurn` (best-effort re-key). Fail-closed
   * codes distinguish empty/unavailable entries, unknown leaf, broken parent
   * chain, and cycles — never a silent truncated transcript.
   */
  private async fetchPiActiveBranch(
    conn: PiProviderConnection,
    timeoutMs: number,
  ): Promise<
    | { ok: true; branch: PiHistoryEntryLike[]; leafId: string }
    | { ok: false; code: string; message: string }
  > {
    // Both history RPCs are optional on the minimal fake surface: absent
    // history support fails closed for resume (honest PI_RESUME_UNSUPPORTED,
    // never silent empty).
    const canEntries = typeof conn.getEntries === "function";
    const canTree = typeof conn.getTree === "function";
    if (!canEntries && !canTree) {
      return { ok: false, code: "PI_RESUME_UNSUPPORTED", message: "Pi connection does not support history resume (update Pi)" };
    }
    let branch: PiHistoryEntryLike[] | null = null;
    let leafId: string | undefined;
    let entriesError: string | null = null;
    if (canEntries) {
      try {
        const bound = conn.getEntries?.bind(conn);
        if (typeof bound !== "function") throw new Error("getEntries unavailable");
        const data = await bound(undefined, { timeoutMs });
        const entries = (data?.entries ?? []) as unknown as PiHistoryEntryLike[];
        leafId = typeof data?.leafId === "string" ? (data.leafId as string) : undefined;
        if (!leafId) {
          return { ok: false, code: "PI_HISTORY_LEAF_MISSING", message: "Pi history has no current leaf (reacquire the session)" };
        }
        const active = extractActiveBranch(entries, leafId);
        if (active.ok) {
          branch = [...active.branch];
        } else {
          entriesError = active.code;
          // Fall through to tree when the flat chain is broken and tree exists.
          if (!canTree) {
            return { ok: false, code: active.code, message: active.message };
          }
        }
      } catch (error) {
        entriesError = this.shortPiError(error);
        if (!canTree) {
          return { ok: false, code: "PI_HISTORY_EMPTY", message: sanitizeCode(`Pi history unavailable: ${entriesError}`) };
        }
      }
    }
    if (branch === null && canTree) {
      try {
        const boundTree = conn.getTree?.bind(conn);
        if (typeof boundTree !== "function") throw new Error("getTree unavailable");
        const treeData = await boundTree({ timeoutMs });
        const tree = (treeData?.tree ?? []) as unknown as Parameters<typeof extractActiveBranchFromTree>[0];
        const treeLeaf = typeof treeData?.leafId === "string" ? (treeData.leafId as string) : leafId;
        if (!treeLeaf) {
          return { ok: false, code: "PI_HISTORY_LEAF_MISSING", message: "Pi history has no current leaf (reacquire the session)" };
        }
        leafId = treeLeaf;
        const active = extractActiveBranchFromTree(tree, treeLeaf);
        if (!active.ok) return { ok: false, code: active.code, message: active.message };
        branch = [...active.branch];
      } catch (error) {
        const detail = this.shortPiError(error);
        void entriesError;
        return { ok: false, code: "PI_HISTORY_EMPTY", message: sanitizeCode(`Pi history unavailable: ${detail}`) };
      }
    }
    if (branch === null || leafId === undefined) {
      return { ok: false, code: "PI_HISTORY_EMPTY", message: "Pi history is empty or unavailable (reacquire the session)" };
    }
    return { ok: true, branch, leafId };
  }

  private async rebuildHistoryFromPi(
    sessionId: string,
  ): Promise<{ ok: true; history: BridgeHistoryEntry[]; leafId: string } | { ok: false; code: string; message: string }> {
    const session = this.sessions.get(sessionId);
    const runtime = this.piRuntimes.get(sessionId);
    if (!session || !runtime) return { ok: false, code: "UNKNOWN_SESSION", message: "unknown session" };
    if (session.activeOpId !== null) {
      return { ok: false, code: "PI_HISTORY_BUSY", message: "cannot rebuild history while a turn streams (wait for idle or cancel)" };
    }
    const conn = runtime.conn;
    if (runtime.conn.isClosed) return { ok: false, code: "PI_EXITED", message: "pi-exited (reacquire the session)" };
    const fetched = await this.fetchPiActiveBranch(conn, this.piOptionTimeoutMs);
    if (!fetched.ok) return { ok: false, code: fetched.code, message: fetched.message };
    const branch = fetched.branch;
    const leafId = fetched.leafId;
    // Per-entry translation WITH chain positions (P1 cursor-alignment fix):
    // `positions[i]` is the chain index that produced `history[i]`, so later
    // `get_history(cursor=<Pi id>)` resolves through the chain even for
    // cursors naming skipped non-message entries.
    const history: BridgeHistoryEntry[] = [];
    const positions: (number | null)[] = [];
    branch.forEach((entry, chainIdx) => {
      for (const row of translatePiEntryToBridgeEntries(entry)) {
        history.push(row);
        positions.push(chainIdx);
      }
    });
    // Incompatible-shape guard: Pi reports messages on the active branch but
    // translation yields zero rows (all unknown future roles) — fail closed
    // rather than silently returning an empty transcript for a non-empty Pi
    // session.
    const branchHasMessages = branch.some((e) => e.type === "message");
    if (branchHasMessages && history.length === 0) {
      return {
        ok: false,
        code: "PI_HISTORY_INCOMPATIBLE",
        message: "Pi history uses unsupported message roles (incompatible history; update orca-pi)",
      };
    }
    // Wholesale replace (idle only, see above): stable Pi ids verbatim for
    // exact handoff metadata (`id`/`parentId`/`timestamp` + `leafId`), plus
    // their chain positions for cursor alignment. Live rows use namespaced
    // `live-N` ids (see `appendLiveRow`), so no rebuilt id can collide.
    const dropped = session.history.length;
    session.history.splice(0, dropped, ...history);
    runtime.historyChainPos.splice(0, dropped, ...positions);
    runtime.opHistoryBase = null;
    runtime.leafEnds.clear();
    runtime.rekeyedFrom.clear();
    session.entryCounter = history.length;
    session.metadata.messageCount = history.filter((e) => e.role === "user" || e.role === "assistant" || e.role === "tool").length;
    runtime.piLeafId = leafId;
    runtime.piChainIds = branch.map((e) => e.id);
    return { ok: true, history: [...history], leafId };
  }

  /**
   * Validate a resumePath's session-file header cwd against the
   * Orca-selected workspaceRoot BEFORE `switch_session` (P1 round-2 fix).
   * Reads only the first line (bounded 64 KiB — the header is one JSON
   * object) and compares canonicalized absolute paths (slash direction,
   * `.`/`..`, trailing separators; case-insensitive on Windows). Diagnostics
   * never include either path: the stored cwd is Pi-side data that must not
   * cross the bridge, and the comparison outcome alone is actionable. A
   * MISSING file is fine (Pi creates it as a new empty session on switch, so
   * acquire honestly reports `resumed:false`); anything else unreadable, a
   * header without a usable cwd, or a mismatch fails closed. Limitation
   * (documented, safe direction): exotic aliasing the normalizer cannot see
   * through (symlinked roots, 8.3 short names) fails closed as a mismatch —
   * reacquire with a directly matching file.
   */
  private async checkResumePathCwd(
    resumePath: string,
    workspaceRoot: string,
  ): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
    const unreadable = {
      ok: false as const,
      code: "PI_RESUME_FAILED",
      message: "Pi session file is unreadable or incompatible (check the path and retry without resumePath for a fresh session)",
    };
    let firstLine: string;
    try {
      const fh = await open(resumePath, "r");
      try {
        const buf = Buffer.alloc(65536);
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        const chunk = buf.toString("utf8", 0, bytesRead);
        const nl = chunk.indexOf("\n");
        firstLine = (nl === -1 ? chunk : chunk.slice(0, nl)).replace(/\r$/, "");
      } finally {
        await fh.close().catch(() => undefined);
      }
    } catch (error) {
      // Missing file: Pi creates it as a new empty session on switch (per
      // contract) — not an error here (acquire reports `resumed:false`).
      if ((error as { code?: unknown })?.code === "ENOENT") return { ok: true };
      return unreadable;
    }
    let storedCwd: unknown;
    try {
      const parsed: unknown = JSON.parse(firstLine);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("bad header");
      storedCwd = (parsed as Record<string, unknown>)["cwd"];
    } catch {
      return unreadable;
    }
    if (typeof storedCwd !== "string" || storedCwd === "") {
      return {
        ok: false,
        code: "PI_RESUME_FAILED",
        message: "Pi session file is incompatible (missing session cwd; update Pi or choose another session file)",
      };
    }
    const norm = (value: string): string => {
      const resolved = path.resolve(value);
      return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    };
    let same = false;
    try {
      same = norm(storedCwd) === norm(workspaceRoot);
    } catch {
      same = false;
    }
    if (!same) {
      return {
        ok: false,
        code: "PI_RESUME_CWD_MISMATCH",
        message: "Pi session belongs to a different workspace (resume refused; reacquire without resumePath for a fresh session or choose a session file from this workspace)",
      };
    }
    return { ok: true };
  }

  /**
   * Reconcile one settled op's live rows to Pi ids (P1 cursor-alignment fix).
   * Background, bounded, never fails the turn: fetches the active chain,
   * always advances `piLeafId`/`piChainIds`, and re-keys this op's rows
   * (`history[opHistoryBase:opEnd)`, captured synchronously at settle so a
   * racing next turn cannot widen the range) to the Pi tail's translated rows
   * when they match exactly by `(role, text)` sequence — the convergence
   * `pi-history.ts` guarantees for landed turns. On any mismatch (diverged or
   * aborted edge, chain moved under us, fetch failure) the live `live-N` rows
   * stand and only the leaf/chain advance; cursor resolution falls back to
   * ordinal order for unmapped rows (see `onGetHistory`). Never synthesizes
   * rows: an empty Pi tail with live rows (or vice versa) is a mismatch.
   */
  private async reconcileSettledTurn(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    const runtime = this.piRuntimes.get(sessionId);
    if (!session || !runtime || runtime.conn.isClosed) return;
    const conn = runtime.conn;
    if (typeof conn.getEntries !== "function" && typeof conn.getTree !== "function") {
      runtime.opHistoryBase = null;
      return;
    }
    const base = runtime.opHistoryBase;
    const end = session.history.length;
    runtime.opHistoryBase = null;
    const fetched = await this.fetchPiActiveBranch(conn, 3000);
    if (!fetched.ok) return;
    const oldLeaf = runtime.piLeafId;
    runtime.piLeafId = fetched.leafId;
    runtime.piChainIds = fetched.branch.map((e) => e.id);
    if (base === null || base === undefined || base >= end) return;
    const liveRows = session.history.slice(base, end);
    if (liveRows.length === 0) return;
    // No anchor (leaf never learned, e.g. minimal history that appeared
    // mid-session): leaf/chain learned above, rows stay live-keyed.
    if (oldLeaf === undefined) return;
    const anchorIdx = fetched.branch.findIndex((e) => e.id === oldLeaf);
    if (anchorIdx === -1) return;
    const tail = fetched.branch.slice(anchorIdx + 1);
    const expected: BridgeHistoryEntry[] = [];
    const tailPos: number[] = [];
    tail.forEach((entry, i) => {
      for (const row of translatePiEntryToBridgeEntries(entry)) {
        expected.push(row);
        tailPos.push(anchorIdx + 1 + i);
      }
    });
    if (expected.length !== liveRows.length) return;
    for (let i = 0; i < expected.length; i++) {
      const a = liveRows[i];
      const b = expected[i];
      if (!a || !b || a.role !== b.role || (a.text ?? "") !== (b.text ?? "")) return;
    }
    // Converged: re-key in place (order + content identical, Pi ids win for
    // exact handoff metadata and cursor stability). Record tombstones so
    // cursors emitted under the retired live ids keep resolving.
    for (let i = 0; i < expected.length; i++) {
      const row = expected[i];
      const prev = session.history[base + i];
      if (row !== undefined) session.history[base + i] = row;
      const pos = tailPos[i];
      if (pos !== undefined) runtime.historyChainPos[base + i] = pos;
      if (prev !== undefined && row !== undefined && prev.id !== row.id) {
        runtime.rekeyedFrom.set(prev.id, row.id);
      }
    }
  }

  /**
   * Best-effort Pi leaf/chain refresh (never fails acquire/history/session):
   * updates `piLeafId`/`piChainIds` from `get_entries` (fallback `get_tree`)
   * with a short bounded deadline. Used for the fresh-acquire baseline and as
   * a background refresh after each settle so `get_history{leafId}` stays
   * close to Pi without blocking turns on history RPCs. Minimal transports
   * without history RPCs are silently skipped (SNC1.4 back-compat).
   */
  private async refreshPiLeafBestEffort(sessionId: string): Promise<void> {
    const runtime = this.piRuntimes.get(sessionId);
    if (!runtime || runtime.conn.isClosed) return;
    const conn = runtime.conn;
    if (typeof conn.getEntries !== "function" && typeof conn.getTree !== "function") return;
    const timeoutMs = 3000;
    try {
      if (typeof conn.getEntries === "function") {
        const bound = conn.getEntries.bind(conn);
        const data = await bound(undefined, { timeoutMs });
        if (typeof data?.leafId === "string" && data.leafId !== "") {
          runtime.piLeafId = data.leafId;
          const entries = (data?.entries ?? []) as unknown as PiHistoryEntryLike[];
          const active = extractActiveBranch(entries, data.leafId);
          if (active.ok) runtime.piChainIds = active.branch.map((e) => e.id);
          return;
        }
      }
    } catch {
      // Fall through to tree.
    }
    try {
      if (typeof conn.getTree === "function") {
        const boundTree = conn.getTree.bind(conn);
        const treeData = await boundTree({ timeoutMs });
        if (typeof treeData?.leafId === "string" && treeData.leafId !== "") {
          runtime.piLeafId = treeData.leafId;
          const tree = (treeData?.tree ?? []) as unknown as Parameters<typeof extractActiveBranchFromTree>[0];
          const active = extractActiveBranchFromTree(tree, treeData.leafId);
          if (active.ok) runtime.piChainIds = active.branch.map((e) => e.id);
        }
      }
    } catch {
      // Best-effort: keep the last known leaf.
    }
  }

  /**
   * SNC1.7 `get_history`: serve the rebuilt + live-appended transcript with
   * the Pi session leaf (never the page end). Cursor resolution is ordinal,
   * in this order: (1) retired live ids translate through re-key tombstones
   * (P1 round-3 fix — re-keyed rows keep old cursors positional-stable);
   * (2) a cursor naming a previously advertised `leafId` resumes after the
   * transcript length it was advertised with (write-once: a token's meaning
   * is immutable); (3) a cursor naming a transcript row returns
   * strictly-after rows; (4) any other Pi chain id (e.g. a skipped
   * non-message entry) maps to the last row at/before that chain position.
   * Unknown cursors return an empty page (same as the base). `limit` paging
   * and `nextCursor` (last returned id) match the base. The cached Pi leaf is
   * advertised only when the transcript holds nothing beyond the state it
   * identifies (P1 round-3 fix — a stale/reused leaf is suppressed rather
   * than re-advertised with a new meaning); otherwise the transcript tail
   * (or nothing, when empty) is the cursor.
   */
  protected override onGetHistory(opId: string, sessionId: string, cursor?: string, limit?: number): void {
    if (!this.requireHello(opId)) return;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      this.send({ v: 1, kind: "error", opId, sessionId, error: { code: "BAD_LIMIT", message: "limit must be a positive integer" } });
      return;
    }
    const session = this.sessions.get(sessionId);
    const runtime = this.piRuntimes.get(sessionId);
    if (!session || !runtime) {
      this.send({ v: 1, kind: "error", opId, sessionId, error: { code: "UNKNOWN_SESSION", message: "unknown session" } });
      return;
    }
    const full = session.history;
    const pos = runtime.historyChainPos;
    const effectiveCursor = cursor ? (runtime.rekeyedFrom.get(cursor) ?? cursor) : undefined;
    let start = 0;
    if (effectiveCursor) {
      const idx = full.findIndex((e) => e.id === effectiveCursor);
      if (idx !== -1) {
        start = idx + 1;
      } else if (runtime.leafEnds.has(effectiveCursor)) {
        // Previously advertised leaf: resume after the page end it denoted
        // (recorded below when that page was returned; write-once, so the
        // meaning is immutable).
        start = Math.min(runtime.leafEnds.get(effectiveCursor) as number, full.length);
      } else {
        const chain = runtime.piChainIds;
        const chainIdx = chain ? chain.indexOf(effectiveCursor) : -1;
        if (chainIdx === -1) {
          start = full.length;
        } else {
          // Last row mapped at/before the cursor's chain position; rows
          // after it (mapped later, or unmapped live tip rows) follow.
          let ord = -1;
          for (let i = 0; i < full.length; i++) {
            const p = pos[i];
            if (p !== null && p !== undefined && p <= chainIdx) ord = i;
          }
          start = ord + 1;
        }
      }
    }
    const rest = full.slice(start);
    let entries = rest;
    let nextCursor: string | undefined;
    if (limit !== undefined && rest.length > limit) {
      entries = rest.slice(0, limit);
      nextCursor = entries.length > 0 ? entries[entries.length - 1]?.id : undefined;
    }
    // Advertise the cached Pi leaf only when the transcript holds nothing
    // beyond the state it identifies: every row must be mapped at/before the
    // leaf's chain position (unmapped tip rows are conservatively beyond).
    // Otherwise suppress it — re-advertising a stale leaf under a new
    // transcript length would give one token two meanings. Callers page with
    // `nextCursor` (row ids never move) until the leaf becomes current again.
    let leafId: string | undefined;
    const cached = runtime.piLeafId;
    if (cached !== undefined) {
      const chain = runtime.piChainIds;
      const li = chain ? chain.indexOf(cached) : -1;
      if (li !== -1) {
        let cover = 0;
        for (let i = 0; i < full.length; i++) {
          const q = pos[i];
          if (q !== null && q !== undefined && q <= li) cover = i + 1;
        }
        if (cover === full.length) leafId = cached;
      }
    }
    leafId ??= full.length > 0 ? full[full.length - 1]?.id : undefined;
    // Record advertised Pi leaves write-once (first end wins — a token's
    // meaning is immutable); transcript-tail fallbacks are positional-stable
    // by construction (rows never move) and need no record. Only complete
    // pages (no `nextCursor`) define a leaf's page end.
    if (leafId && leafId === cached && nextCursor === undefined) {
      if (!runtime.leafEnds.has(leafId)) runtime.leafEnds.set(leafId, full.length);
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

  /**
   * Shared bounded catalog lookup (P2: no pending accumulation).
   * A single in-flight `get_available_models` per session is shared by
   * concurrent image dispatches; the timeout is propagated as the real Pi
   * RPC deadline (`{timeoutMs}`) so the underlying request rejects (and
   * leaves `PiRpcConnection.pending`) after `timeoutMs`, not after the
   * 30s production default. Callers cache the result in
   * `runtime.cachedModels` on success; failures leave the cache absent
   * (hint fallback) and clear the shared slot so the next dispatch retries.
   */
  private async fetchCatalogShared(sessionId: string, timeoutMs: number): Promise<PiModel[] | null> {
    const runtime = this.piRuntimes.get(sessionId);
    if (!runtime) return null;
    if (runtime.cachedModels !== undefined) return runtime.cachedModels;
    if (runtime.catalogInflight) {
      try {
        return await runtime.catalogInflight;
      } catch {
        return null;
      }
    }
    const listModels = runtime.conn.getAvailableModels?.bind(runtime.conn);
    if (!listModels) return null;
    const inflight: Promise<PiModel[]> = (async () => {
      const listed = await listModels({ timeoutMs });
      const models = [...listed.models];
      const live = this.piRuntimes.get(sessionId);
      if (live) live.cachedModels = models;
      return models;
    })();
    runtime.catalogInflight = inflight;
    try {
      return await inflight;
    } catch {
      return null;
    } finally {
      const live = this.piRuntimes.get(sessionId);
      if (live?.catalogInflight === inflight) live.catalogInflight = null;
    }
  }

  /**
   * Live image-support check for the confirmed model (provider-confirmed
   * where cached). Accepts both bare ids and canonical `provider/modelId`
   * refs: qualified refs resolve to the exact provider entry (so duplicate
   * ids with different capabilities disambiguate); bare ids fall back to the
   * first matching entry (ambiguous bare ids should have been rejected at
   * `set_options`/`acquire` time via `AMBIGUOUS_MODEL`). Returns `null` when
   * the catalog has no entry (caller falls back to hint checks).
   */
  private modelSupportsImages(modelRef: string | undefined, cached: readonly PiModel[] | undefined): boolean | null {
    if (!modelRef) return null;
    const slash = modelRef.indexOf("/");
    let entry: PiModel | undefined;
    if (slash >= 0) {
      const providerPart = modelRef.slice(0, slash);
      const idPart = modelRef.slice(slash + 1);
      entry = cached?.find((m) => m.provider === providerPart && m.id === idPart);
    } else {
      entry = cached?.find((m) => m.id === modelRef);
    }
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
   * (the caller reports `error`, never a diverging `options_updated`).
   *
   * Two-phase discipline (PR #41 P1): VALIDATE everything before MUTATING
   * anything. Phase 1 checks transport capability — model, thinking, AND
   * autoCompaction (a real Pi settings mutation — PR #41 P2) — with no RPCs.
   * Phase 2 runs only read-only RPCs (model catalog list + ref resolution;
   * thinking-level list + membership for thinking-only requests, where the
   * current model IS the target; incumbent-model snapshot via `get_state`
   * for compound requests) and returns the first failure with zero Pi
   * mutations — so a compound request like `{model: valid, thinkingLevel:
   * bogus}` leaves both Pi and the lease untouched instead of stranding a
   * half-applied model the host never learns about. Phase 3 issues the
   * mutating RPCs and persists confirmed values; compound thinking levels
   * are re-validated target-scoped after the switch (the levels RPC
   * describes the current model only), with best-effort rollback to the
   * incumbent on mismatch. Residual risk: a *transport* failure mid-apply
   * (after an earlier field landed) can still partially apply — that path
   * also returns `error` with no `options_updated`, and the host reconciles
   * actual Pi state via `get_session` (provider-confirmed lease), never by
   * assuming the request landed.
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
    // Phase 1 — capability preflight (no RPCs): every requested field must be
    // supportable before anything is validated or mutated. Bound to const
    // locals: property-access narrowing does not survive `await`, so the
    // checks below both gate support AND keep precise callable types for
    // phases 2–3 (unbound extraction would also lose `this`).
    const conn = runtime.conn;
    const listModels = options.model !== undefined ? conn.getAvailableModels?.bind(conn) : undefined;
    const applyModel = options.model !== undefined ? conn.setModel?.bind(conn) : undefined;
    if (options.model !== undefined && (typeof listModels !== "function" || typeof applyModel !== "function")) {
      return { ok: false, code: "PI_OPTION_UNSUPPORTED", message: "Pi connection does not support model operations" };
    }
    const listLevels = options.thinkingLevel !== undefined ? conn.getAvailableThinkingLevels?.bind(conn) : undefined;
    const applyLevel = options.thinkingLevel !== undefined ? conn.setThinkingLevel?.bind(conn) : undefined;
    if (options.thinkingLevel !== undefined && (typeof listLevels !== "function" || typeof applyLevel !== "function")) {
      return { ok: false, code: "PI_OPTION_UNSUPPORTED", message: "Pi connection does not support thinking-level operations" };
    }
    // autoCompaction is a real Pi mutation (`set_auto_compaction` rewrites
    // global settings): a transport without it must fail closed, never
    // persist a synthetic success Pi never applied (PR #41 P2).
    if (options.autoCompaction !== undefined && typeof conn.setAutoCompaction !== "function") {
      return { ok: false, code: "PI_OPTION_UNSUPPORTED", message: "Pi connection does not support auto-compaction operations" };
    }
    // Phase 2 — validation via read-only RPCs (no Pi mutations): resolve the
    // model ref against the live catalog and check thinking membership.
    // Any failure here returns with Pi and the lease untouched.
    //
    // Thinking validation is model-scoped (PR #41 P1): the levels RPC
    // describes the CURRENT model, so for a compound {model, thinking}
    // request the current levels describe the WRONG model and must not
    // gate anything — target validation happens in Phase 3 after the
    // switch, with best-effort rollback below.
    let resolvedModel: { provider: string; modelId: string } | null = null;
    let listedModels: PiModel[] | null = null;
    if (options.model !== undefined) {
      // Exact-ref resolution via live catalog. Provider-confirmed canonical
      // `provider/modelId` is persisted in both `metadata.model` and
      // `options.model` (so a later restore/acquire with duplicate bare ids
      // — e.g. `gpt-5.6-luna` under `openai-codex` + `opencode-go` in the live
      // catalog — resolves without `AMBIGUOUS_MODEL`, and image-capability
      // lookup disambiguates by provider). Bare unique ids still resolve
      // (exact unique match), but persistence is always qualified for
      // restore safety.
      let models: PiModel[];
      try {
        // Defense in depth: Phase 1 already gated support; re-check at the
        // call site because narrowing does not cross `await` boundaries.
        if (typeof listModels !== "function") {
          return { ok: false, code: "PI_OPTION_FAILED", message: "model operations unavailable" };
        }
        const listed = await listModels({ timeoutMs: this.piOptionTimeoutMs });
        models = [...listed.models];
        runtime.cachedModels = models;
      } catch (error) {
        return { ok: false, code: "PI_OPTION_FAILED", message: sanitizeCode(`model list failed: ${this.shortPiError(error)}`) };
      }
      const resolved = this.resolveModelRef(options.model, models);
      if (!resolved.ok) return { ok: false, code: resolved.code, message: resolved.message };
      resolvedModel = { provider: resolved.provider, modelId: resolved.modelId };
      listedModels = models;
    }
    if (options.thinkingLevel !== undefined && resolvedModel === null) {
      // Thinking-only: the current model IS the target — exact pre-mutation
      // validation (Pi is lenient and would silently fall back; the bridge
      // fails closed instead).
      let levels: string[];
      try {
        // Defense in depth: see model list above.
        if (typeof listLevels !== "function") {
          return { ok: false, code: "PI_OPTION_FAILED", message: "thinking-level operations unavailable" };
        }
        const listed = await listLevels({ timeoutMs: this.piOptionTimeoutMs });
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
    }
    // Compound {model, thinking}: record the incumbent model (read-only)
    // for best-effort rollback if the level proves invalid on the target.
    // Absent/unreadable incumbent means rollback is unavailable — a later
    // thinking failure then keeps the switched model in the lease
    // (truthful: Pi IS on it) with `error` and `get_session` reconciliation.
    let incumbentModel: { provider: string; modelId: string } | null = null;
    if (options.thinkingLevel !== undefined && resolvedModel !== null) {
      try {
        const st = await conn.getState({ timeoutMs: this.piOptionTimeoutMs });
        if (
          typeof st.model?.id === "string" &&
          st.model.id !== "" &&
          typeof st.model?.provider === "string" &&
          st.model.provider !== ""
        ) {
          incumbentModel = { provider: st.model.provider, modelId: st.model.id };
        }
      } catch {
        incumbentModel = null;
      }
    }
    // Phase 3 — apply (mutating RPCs) only after every requested field
    // validated. A *transport* failure here can still land after an earlier
    // field applied; that path returns `error` with no `options_updated` and
    // the host reconciles via `get_session`, never by assuming success.
    if (resolvedModel !== null && listedModels !== null) {
      const rm = resolvedModel;
      const lm = listedModels;
      // Defense in depth: Phase 1 already gated support (unreachable unless
      // the conn was mutated mid-flight); fail closed, never crash.
      if (typeof applyModel !== "function") {
        return { ok: false, code: "PI_OPTION_FAILED", message: "model operations unavailable" };
      }
      try {
        const confirmed = await applyModel(rm.provider, rm.modelId, { timeoutMs: this.piOptionTimeoutMs });
        const confirmedProvider =
          typeof (confirmed as PiModel)?.provider === "string" && (confirmed as PiModel).provider !== ""
            ? (confirmed as PiModel).provider
            : rm.provider;
        const confirmedId =
          typeof confirmed?.id === "string" && confirmed.id !== "" ? confirmed.id : rm.modelId;
        const qualified = `${confirmedProvider}/${confirmedId}`;
        session.options.model = qualified;
        session.metadata.model = qualified;
        // Refresh cached catalog entry (confirmed model may carry new caps).
        const idx = lm.findIndex((m) => m.provider === rm.provider && m.id === rm.modelId);
        if (idx >= 0) lm[idx] = confirmed;
        runtime.cachedModels = lm;
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
    if (options.thinkingLevel !== undefined && applyLevel !== undefined) {
      // Compound {model, thinking}: the Phase-2 levels described the OLD
      // model — re-list (now target-scoped) and validate BEFORE mutating
      // thinking. Pi's lenient set would otherwise silently coerce a level
      // the target model rejects.
      if (resolvedModel !== null) {
        if (typeof listLevels !== "function" || typeof applyModel !== "function") {
          return { ok: false, code: "PI_OPTION_FAILED", message: "thinking-level operations unavailable" };
        }
        let targetLevels: string[];
        try {
          targetLevels = [...(await listLevels({ timeoutMs: this.piOptionTimeoutMs })).levels];
        } catch (error) {
          // Model already switched (lease truthfully persists it above);
          // report the thinking failure and let the host reconcile.
          return { ok: false, code: "PI_OPTION_FAILED", message: sanitizeCode(`thinking-level list failed: ${this.shortPiError(error)}`) };
        }
        if (!targetLevels.includes(options.thinkingLevel)) {
          const targetRef = `${resolvedModel.provider}/${resolvedModel.modelId}`;
          // Best-effort rollback to the incumbent so a failed compound
          // leaves Pi where it started. Rollback failure (or unknown
          // incumbent) keeps the switched model in the lease — truthful,
          // reconciled via `get_session`, never a diverging ack.
          if (incumbentModel !== null) {
            try {
              await applyModel(incumbentModel.provider, incumbentModel.modelId, { timeoutMs: this.piOptionTimeoutMs });
              const restored = `${incumbentModel.provider}/${incumbentModel.modelId}`;
              session.options.model = restored;
              session.metadata.model = restored;
            } catch {
              // Rollback failed: lease keeps the switched model (Pi IS on
              // it). Fall through to the thinking error below.
            }
          }
          return {
            ok: false,
            code: "UNKNOWN_THINKING_LEVEL",
            message: sanitizeCode(
              `unknown thinking level for ${targetRef}: ${options.thinkingLevel} (available: ${targetLevels.join(", ") || "none"})`,
            ),
          };
        }
      }
      // Defense in depth: see model apply above.
      if (typeof applyLevel !== "function") {
        return { ok: false, code: "PI_OPTION_FAILED", message: "thinking-level operations unavailable" };
      }
      try {
        await applyLevel(options.thinkingLevel, { timeoutMs: this.piOptionTimeoutMs });
      } catch (error) {
        return { ok: false, code: "PI_OPTION_FAILED", message: sanitizeCode(`set_thinking_level failed: ${this.shortPiError(error)}`) };
      }
      // Provider-confirmed: Pi emits `thinking_level_changed` (tracked live
      // in `attachPiStreaming`); refresh via `get_state` so the lease never
      // echoes an unconfirmed request when Pi silently coerces.
      try {
        const state = await conn.getState({ timeoutMs: this.piOptionTimeoutMs });
        const confirmed = typeof state.thinkingLevel === "string" ? state.thinkingLevel : options.thinkingLevel;
        session.options.thinkingLevel = confirmed;
        session.metadata.thinkingLevel = confirmed;
      } catch {
        session.options.thinkingLevel = options.thinkingLevel;
        session.metadata.thinkingLevel = options.thinkingLevel;
      }
    }
    if (options.autoCompaction !== undefined) {
      // Phase 1 preflight guarantees the RPC exists when requested;
      // re-check at the call site (narrowing does not cross `await`).
      // Bound: unbound extraction would lose `this` on the real connection.
      const setAC = conn.setAutoCompaction?.bind(conn);
      if (typeof setAC !== "function") {
        return { ok: false, code: "PI_OPTION_UNSUPPORTED", message: "Pi connection does not support auto-compaction operations" };
      }
      try {
        await setAC(options.autoCompaction, { timeoutMs: this.piOptionTimeoutMs });
      } catch (error) {
        return { ok: false, code: "PI_OPTION_FAILED", message: sanitizeCode(`set_auto_compaction failed: ${this.shortPiError(error)}`) };
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
      // Qualify when the provider is known (duplicate bare ids exist in the
      // live catalog); bare fallback preserves pre-SNC1.6 leases.
      if (typeof state.model?.id === "string" && state.model.id !== "") {
        session.metadata.model =
          typeof state.model?.provider === "string" && state.model.provider !== ""
            ? `${state.model.provider}/${state.model.id}`
            : state.model.id;
      }
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

  /**
   * Append one live-transcript row with a namespaced synthetic id and no
   * chain position (P1 cursor-alignment fix; see `reconcileSettledTurn`). ALL
   * live journaling funnels through here so `historyChainPos` parallels
   * `session.history` exactly. Never call the base `appendHistory` directly
   * for Pi live rows: bare `eN` ids could collide with Pi entry ids from a
   * rebuild (e.g. rebuilt Pi `e5` + live `e5`), corrupting cursor resolution.
   */
  private appendLiveRow(
    session: ProviderSession,
    runtime: PiRuntime,
    entry: { role: "user" | "assistant" | "tool"; text: string },
  ): void {
    runtime.liveSeq += 1;
    this.appendHistory(session, { id: `live-${runtime.liveSeq}`, role: entry.role, text: entry.text });
    runtime.historyChainPos.push(null);
    session.metadata.messageCount = session.history.filter(
      (e) => e.role === "user" || e.role === "assistant" || e.role === "tool",
    ).length;
  }

  /** Journal translator entries into bridge history (user → tools → assistant order). */
  private journalTranslatorEntries(
    session: ProviderSession,
    runtime: PiRuntime,
    entries: Array<{ role: "user" | "assistant" | "tool"; text: string }>,
  ): void {
    for (const entry of entries) {
      // History roles mirror the translator: `tool` entries carry tool output
      // (never prose); `assistant` carries reconciled text finals (never tool
      // output); `user` carries the confirmed prompt. All three are needed so
      // `unknown`-dispatch reconciliation sees faithful evidence.
      this.appendLiveRow(session, runtime, { role: entry.role, text: entry.text });
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
      // them in the SNC1.6 pending map (stable identity, exactly-once). When
      // an immediate `/` dispatch is pending, the first dialog proves Pi owns
      // the command — ack `accepted` early (before the `prompt` response,
      // which per `extension-ui.jsonl` arrives only after the answer) so the
      // host dispatch deadline never fires while the user thinks. Otherwise
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
          // Stable identity, namespaced per session (PR #41 P1): raw Pi ids
          // are process-local, so the bridge-visible id carries the owning
          // session. Duplicate Pi ids while pending are ignored (never emit
          // a second card for the same request).
          const piId = bridgeEvent.requestId;
          const promptId = this.bridgePromptId(sessionId, piId);
          if (runtime.pendingPrompts.has(promptId)) continue;
          const immediate = runtime.pendingImmediate;
          if (immediate && !immediate.acked) {
            // First dialog for the pending immediate command: Pi definitely
            // owns it. Attribute the dialog to the immediate op and ack
            // early; the `prompt` response (after the answer) needs no
            // second ack.
            runtime.pendingPrompts.set(promptId, immediate.opId);
            runtime.promptPiIds.set(promptId, piId);
            session.pendingPrompt = { requestId: promptId, opId: immediate.opId };
            this.send({
              v: 1,
              kind: "session_event",
              sessionId,
              opId: immediate.opId,
              event: { ...bridgeEvent, requestId: promptId },
            });
            immediate.acked = true;
            this.send({ v: 1, kind: "dispatch_ack", opId: immediate.opId, sessionId, status: "accepted" });
            continue;
          }
          runtime.pendingPrompts.set(promptId, "");
          runtime.promptPiIds.set(promptId, piId);
          session.pendingPrompt = { requestId: promptId, opId: "" };
          this.send({
            v: 1,
            kind: "session_event",
            sessionId,
            event: { ...bridgeEvent, requestId: promptId },
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
          // SNC1.6 stable identity, namespaced per session (PR #41 P1):
          // ignore duplicate Pi ids while pending (one card per namespaced
          // id; the first op wins). New ids are tracked for exactly-once
          // answers + retirement (see `onPiAnswerPrompt`).
          const piId = bridgeEvent.requestId;
          const promptId = this.bridgePromptId(sessionId, piId);
          if (runtime.pendingPrompts.has(promptId)) continue;
          runtime.pendingPrompts.set(promptId, currentOp);
          runtime.promptPiIds.set(promptId, piId);
          session.pendingPrompt = { requestId: promptId, opId: currentOp };
          this.send({
            v: 1,
            kind: "session_event",
            sessionId,
            ...(currentOp ? { opId: currentOp } : {}),
            event: { ...bridgeEvent, requestId: promptId },
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
              this.appendLiveRow(session, runtime, { role: "user", text: user });
              runtime.translator.clearPendingUser();
              this.syncRuntimeMirrors(runtime);
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
            this.journalTranslatorEntries(session, runtime, entries);
            this.syncRuntimeMirrors(runtime);
            session.cancelledOps.delete(currentOp);
            this.retirePromptsForOp(session, runtime, currentOp);
            // Single-turn honesty: the settled op is still active (queued
            // delivery while busy is rejected, so there is nothing to
            // promote). Multi-turn tool continuations already attributed to
            // this op via per-`turn_end` drains above.
            if (session.activeOpId === currentOp) {
              this.finishTurn(session, currentOp);
              if (session.activeOpId === null) {
                session.metadata.isStreaming = false;
                // SNC1.7: background settle reconciliation (never blocks the
                // turn): advances the cached Pi leaf/chain and re-keys this
                // op's live rows to Pi ids when they converge (P1 fix).
                // Failures keep live ids and the last known leaf.
                void this.reconcileSettledTurn(sessionId).catch(() => undefined);
              }
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
            this.journalTranslatorEntries(session, runtime, entries);
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
      if (ownerOp === opId) {
        runtime.pendingPrompts.delete(requestId);
        runtime.promptPiIds.delete(requestId);
      }
    }
    if (session.pendingPrompt?.opId === opId) session.pendingPrompt = null;
  }

  /** Retire every pending dialog in a session (exit/release/close fence). */
  private retireAllPrompts(session: ProviderSession, runtime: PiRuntime): void {
    runtime.pendingPrompts.clear();
    runtime.promptPiIds.clear();
    session.pendingPrompt = null;
    runtime.pendingImmediate = null;
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
      runtime.opHistoryBase = null;
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
    // SNC1.6 image gating: the live Pi catalog is authoritative when cached
    // (`acquire` populates it best-effort; `set_model` refreshes it). Hint
    // checks in `validatePiDispatch` stay only as a fallback when capability
    // metadata is unavailable — otherwise hint-miss image-capable models
    // (e.g. `minimax-m3`, `qwen3.8-flash`, `kimi-k2.6` in the live catalog)
    // would be wrongly rejected before the authoritative check runs.
    // History never journals image bytes (user entries carry text only).
    const imageCount = msg.message.images?.length ?? 0;
    // P1-3 race: when images are present but the background acquire catalog
    // has not landed yet (cache absent), await a bounded live lookup before
    // issuing a negative hint verdict — otherwise a hint-miss image-capable
    // model (e.g. minimax-m3) dispatched immediately post-acquire is falsely
    // rejected. Bounded (3s) so a hung catalog never pushes dispatch past
    // the host deadline; failures fall back to hints (floor).
    if (imageCount > 0 && runtime.cachedModels === undefined) {
      // Bounded shared lookup (P2): real {timeoutMs:3000} propagates to Pi
      // so no 30s pending accumulates; concurrent dispatches share one RPC.
      await this.fetchCatalogShared(msg.sessionId, 3000);
    }
    const liveSupports =
      imageCount > 0 ? this.modelSupportsImages(session.metadata.model, runtime.cachedModels) : null;
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
    // When the live catalog confirms image support, bypass the static hint
    // (pass `model: undefined` so only text/thinking/mime are validated).
    // When the catalog is silent (`null`) or there are no images, validate
    // normally (hints remain the floor for uncached models).
    const validation =
      liveSupports === true
        ? validatePiDispatch(msg.message, session.options, undefined)
        : validatePiDispatch(msg.message, session.options, session.metadata.model);
    if (!validation.ok) {
      this.send({ v: 1, kind: "dispatch_ack", opId: msg.opId, sessionId: msg.sessionId, status: "rejected", reason: validation.reason ?? "invalid-dispatch" });
      return;
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
      // (tracked in `pendingPrompts`). No translator state, no history.
      // SNC1.6 early-ownership ack: the real `extension-ui.jsonl` ordering is
      // `prompt` → `extension_ui_request` → `extension_ui_response` →
      // `prompt` response, so awaiting the `prompt` response before acking
      // would hit the host dispatch deadline (10s) whenever the user takes
      // >10s to answer. Instead the first dialog acks `accepted` early (see
      // stateless path above — Pi definitely owns the command and waits for
      // an answer); the trailing `prompt` response needs no second ack.
      // No-dialog immediates ack on `prompt` success (fast, no user wait).
      runtime.pendingImmediate = { opId: msg.opId, acked: false };
      const clearImmediate = (): void => {
        if (runtime.pendingImmediate?.opId === msg.opId) runtime.pendingImmediate = null;
      };
      try {
        await runtime.conn.prompt(msg.message.text);
      } catch (error) {
        if (runtime.pendingImmediate?.opId === msg.opId && runtime.pendingImmediate.acked) {
          // Already accepted via the early dialog ack: Pi owned the command;
          // the late transport failure needs no second ack (the turn
          // continues via `session_event` prompts, never a stuck dispatch).
          clearImmediate();
          return;
        }
        clearImmediate();
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
      // `prompt` succeeded: ack unless the early dialog path already did.
      if (runtime.pendingImmediate?.opId === msg.opId && runtime.pendingImmediate.acked) {
        clearImmediate();
        return;
      }
      clearImmediate();
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
    runtime.opHistoryBase = session.history.length;
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
      this.appendLiveRow(session, runtime, { role: "user", text: msg.message.text });
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
    runtime.opHistoryBase = live.history.length;
    this.appendLiveRow(live, runtime, { role: "user", text: msg.message.text });
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
  // Stable identity, namespaced per session (PR #41 P1): the bridge-visible
  // `prompt_request.requestId` is `<sessionId>:<piId>` (see `bridgePromptId`),
  // never the raw Pi id. Pi children are independently spawned processes
  // whose `extension_ui_request.id` values carry no cross-process uniqueness
  // guarantee, so a raw id alone cannot route an answer: two sessions may
  // hold the same Pi-local id. The per-runtime `promptPiIds` map retains the
  // original Pi id for `extension_ui_response` (exact reverse lookup, no
  // parsing). Exactly-once: the first `answer_prompt` for a bridge id
  // forwards one Pi `extension_ui_response` and deletes the map entries;
  // later answers for the same id are stale/late refusals (`UNKNOWN_REQUEST`,
  // never re-sent to Pi) — this is what lets Orca do a durable CAS and then
  // answer once. Retirement: turn settle / cancel / Pi exit / release / close
  // clear the maps (acquisition fence — prompts never leak across
  // sessions/turns). Bounded unsupported kinds: fire-and-forget / unknown Pi
  // UI methods map to `[]` in `pi-mapping.ts` and never create entries, so
  // they never block and can never be answered (any answer for their ids is
  // UNKNOWN).

  /**
   * Bridge-visible prompt id for a Pi dialog in a session. Deterministic
   * (same Pi id re-emitted while pending maps to the same bridge id, so
   * duplicates stay ignored) and unique across sessions sharing one
   * provider process. The Pi id travels in `promptPiIds`, never parsed out.
   */
  private bridgePromptId(sessionId: string, piId: string): string {
    return `${sessionId}:${piId}`;
  }

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
    // double-send to Pi even if `respondToExtensionUi` throws. Resolve the
    // originating Pi-local id via the namespace map (never parse it out of
    // the bridge id); fall back to the raw id only for entries predating
    // the namespace (defense in depth, e.g. hot-restarted providers).
    const piId = ownerRuntime.promptPiIds.get(msg.requestId) ?? msg.requestId;
    ownerRuntime.pendingPrompts.delete(msg.requestId);
    ownerRuntime.promptPiIds.delete(msg.requestId);
    if (session?.pendingPrompt?.requestId === msg.requestId) session.pendingPrompt = null;
    try {
      if (msg.cancelled) {
        ownerRuntime.conn.respondToExtensionUi({ type: "extension_ui_response", id: piId, cancelled: true });
      } else if (typeof msg.value === "boolean") {
        ownerRuntime.conn.respondToExtensionUi({ type: "extension_ui_response", id: piId, confirmed: msg.value });
      } else {
        ownerRuntime.conn.respondToExtensionUi({ type: "extension_ui_response", id: piId, value: msg.value });
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
    // Consume the map entries when present so base + map stay consistent.
    // Resolve the Pi-local id through the owning runtime's namespace map.
    const piId = target.promptPiIds.get(requestId) ?? requestId;
    target.pendingPrompts.delete(requestId);
    target.promptPiIds.delete(requestId);
    try {
      if (cancelled) {
        target.conn.respondToExtensionUi({ type: "extension_ui_response", id: piId, cancelled: true });
      } else if (typeof value === "boolean") {
        target.conn.respondToExtensionUi({ type: "extension_ui_response", id: piId, confirmed: value });
      } else {
        target.conn.respondToExtensionUi({ type: "extension_ui_response", id: piId, value });
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

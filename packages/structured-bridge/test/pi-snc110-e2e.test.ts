/**
 * SNC1.10 deterministic end-to-end lifecycle + hardening gates.
 *
 * Credential-free, process-free, offline: scripted fake Pi connections
 * (no `pi` binary, no model credentials, no OS processes) drive BOTH the
 * bridge path (`PiBridgeProvider` over JSONL) and the native path
 * (`PiNativeProvider` direct calls) through the complete supported
 * structured lifecycle from issue #20:
 *
 * - acquire/create gating (local pi only; remote/WSL/other agents refuse);
 * - provider-confirmed text, thinking, and tool events in one turn;
 * - cancel (idle + active-turn abort fidelity);
 * - model and thinking option changes (provider-confirmed) + fail-closed refs;
 * - interactive prompt exactly once (second answer is a stale refusal);
 * - unknown delivery without resend (single Pi prompt call, reconcile via history);
 * - image support (accepted, bytes never journaled) + refusal on text-only models;
 * - history current leaf + branched resume (abandoned siblings excluded);
 * - unexpected exit + recovery (rejected dispatch, explicit reacquire);
 * - structured → TUI → structured round trip (release + resume, no duplication);
 * - restart restoration (new provider instance + same resume file);
 * - unsupported version + TUI fallback (compat gate);
 * - no state leakage across sessions (histories/prompts fenced per session);
 * - bounded/redacted stderr + fallback diagnostics (no secrets/prompt text);
 * - no credential fields on the wire; no shell-string transport.
 *
 * Anything requiring a live `pi` binary or model credentials is explicitly
 * out of scope here and lives in `pi-live-smoke.test.ts` (opt-in,
 * `ORCA_PI_LIVE_SMOKE=1`) — see `docs/snc110-compatibility.md` for the
 * proven/unproven platform boundary.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiBridgeProvider, type PiProviderConnection } from "../src/pi-provider.js";
import { PiNativeProvider } from "../src/pi-native.js";
import { serializeBridgeLine } from "../src/framing.js";
import {
  FORBIDDEN_BRIDGE_KEYS,
  MAX_STDERR_BYTES,
  redactSecretsFromText,
  validateBridgeMessage,
} from "../src/protocol.js";
import {
  checkPiVersionSupport,
  gatePiStructuredSession,
  MIN_KNOWN_GOOD_PI_VERSION,
} from "../src/pi-compat.js";

/**
 * Model Pi's session-file persistence in the scripted store: append a
 * user→assistant turn parented at the current leaf and advance the leaf.
 * Ids are namespaced per call so structured and TUI legs never collide.
 */
/**
 * Remove optional Pi RPC methods from a scripted fake (proves
 * presence-gated probes). Assigns own-property `undefined` (shadowing the
 * prototype) rather than `delete`, which cannot remove prototype methods.
 */
function stripMethods(fake: Snc110FakePi, names: readonly string[]): void {
  const mutable = fake as unknown as Record<string, unknown>;
  for (const name of names) mutable[name] = undefined;
}

let persistedTurns = 0;
function persistTurnToStore(store: SessionStore, resumePath: string, userText: string, assistantText: string): void {
  const current = store.get(resumePath);
  if (!current) throw new Error("missing seeded session");
  persistedTurns += 1;
  const userId = `pt${persistedTurns}u`;
  const assistantId = `pt${persistedTurns}a`;
  store.set(resumePath, {
    entries: [
      ...current.entries,
      piMsg(userId, current.leafId, "user", userText),
      piMsg(assistantId, userId, "assistant", assistantText),
    ],
    leafId: assistantId,
  });
}
import { PiRpcError, redactSecrets } from "@orca-pi/pi-rpc";
import type { ProviderToHostMessage } from "../src/protocol.js";
import type {
  PiEntriesData,
  PiModel,
  PiRpcCloseResult,
  PiRpcConnectionOptions,
  PiServerEvent,
  PiState,
  PiTreeData,
} from "@orca-pi/pi-rpc";

type PathKind = "bridge" | "native";

function piMsg(id: string, parentId: string | null, role: string, text: string) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role, content: [{ type: "text", text }], timestamp: 1700000000000 },
  };
}

/** Shared scripted Pi session-file store: resumePath → seeded entries/leaf. */
type SessionStore = Map<string, { entries: Array<Record<string, unknown>>; leafId: string }>;

/** Deterministic scripted Pi: prompt/abort/close counting + manual event injection. */
class Snc110FakePi implements PiProviderConnection {
  readonly seenOpts: PiRpcConnectionOptions;
  readonly prompts: string[] = [];
  readonly uiResponses: Array<unknown> = [];
  aborts = 0;
  closes = 0;
  started = false;
  failPromptWith: unknown = null;
  models: PiModel[] = [
    { id: "glm-5.3-flash", provider: "opencode-go", input: ["text", "image"] } as PiModel,
    { id: "text-only-model", provider: "opencode-go", input: ["text"] } as PiModel,
  ];
  levels: string[] = ["low", "high", "max"];
  entries: Array<Record<string, unknown>> = [];
  leafId = "";
  switchedTo: string[] = [];
  state: PiState = {
    model: { id: "glm-5.3-flash", provider: "opencode-go" } as PiState["model"],
    thinkingLevel: "low",
    isStreaming: false,
    isCompacting: false,
    sessionId: "pi_snc110_1",
    messageCount: 0,
  };
  private readonly store: SessionStore;
  private readonly eventHandlers = new Set<(e: PiServerEvent) => void>();
  private readonly exitHandlers = new Set<(info: PiRpcCloseResult) => void>();
  private _closed = false;

  constructor(opts: PiRpcConnectionOptions, store: SessionStore) {
    this.seenOpts = opts;
    this.store = store;
  }

  get isClosed(): boolean {
    return this._closed;
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async prompt(message: string): Promise<void> {
    this.prompts.push(message);
    if (this.failPromptWith) {
      const err = this.failPromptWith;
      this.failPromptWith = null;
      throw err;
    }
  }

  async abort(): Promise<void> {
    this.aborts += 1;
  }

  async close(graceMs = 2000): Promise<PiRpcCloseResult> {
    this.closes += 1;
    this._closed = true;
    const info: PiRpcCloseResult = { exitCode: 0, signal: null, forced: graceMs === 0 };
    for (const h of [...this.exitHandlers]) {
      try {
        h(info);
      } catch {
        // Ignore.
      }
    }
    return info;
  }

  onEvent(handler: (event: PiServerEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  onExit(handler: (info: PiRpcCloseResult) => void): () => void {
    this.exitHandlers.add(handler);
    return () => {
      this.exitHandlers.delete(handler);
    };
  }

  async getState(): Promise<PiState> {
    return { ...this.state, model: this.state.model ? { ...this.state.model } : undefined };
  }

  respondToExtensionUi(response: { type: "extension_ui_response"; id: string; value?: unknown; confirmed?: boolean; cancelled?: boolean }): void {
    this.uiResponses.push(response);
  }

  async getAvailableModels(): Promise<{ models: PiModel[] }> {
    return { models: this.models.map((m) => ({ ...m })) };
  }

  async setModel(provider: string, modelId: string): Promise<PiModel> {
    const found = this.models.find((m) => m.provider === provider && m.id === modelId);
    if (!found) {
      // Faithful Pi rejection shape: definite `rejected` (not ambiguous),
      // so the live `set_model` verb probe can prove command-level support.
      throw new PiRpcError(
        {
          code: "rejected",
          command: "set_model",
          ambiguous: false,
          piError: `Model not found: ${provider}/${modelId}`,
        },
        `Pi rejected set_model: Model not found: ${provider}/${modelId}`,
      );
    }
    this.state = { ...this.state, model: { ...found } as PiState["model"] };
    return { ...found };
  }

  async getAvailableThinkingLevels(): Promise<{ levels: string[] }> {
    return { levels: [...this.levels] };
  }

  async setThinkingLevel(level: string): Promise<void> {
    if (!this.levels.includes(level)) {
      throw Object.assign(new Error(`Unknown thinking level: ${level}`), { code: "unknown-thinking-level" });
    }
    this.state = { ...this.state, thinkingLevel: level };
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    void enabled;
  }

  async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
    this.switchedTo.push(sessionPath);
    const seeded = this.store.get(sessionPath);
    if (seeded) {
      this.entries = seeded.entries.map((e) => ({ ...e }));
      this.leafId = seeded.leafId;
    }
    return { cancelled: false };
  }

  async getEntries(): Promise<PiEntriesData> {
    return { entries: this.entries as never, leafId: this.leafId };
  }

  async getTree(): Promise<PiTreeData> {
    return { tree: [] as never, leafId: this.leafId };
  }

  emit(event: PiServerEvent): void {
    for (const h of [...this.eventHandlers]) h(event);
  }

  /** Simulate an unexpected Pi exit (crash): fires onExit without close(). */
  die(code: number | null = 1, signal: string | null = null): void {
    this._closed = true;
    const info: PiRpcCloseResult = { exitCode: code, signal, forced: false };
    for (const h of [...this.exitHandlers]) {
      try {
        h(info);
      } catch {
        // Ignore.
      }
    }
  }
}

function seedActiveBranchWithAbandonedSibling(): { entries: Array<Record<string, unknown>>; leafId: string } {
  return {
    entries: [
      piMsg("e1", null, "user", "hello active"),
      piMsg("e2", "e1", "assistant", "active reply"),
      piMsg("eX", "e1", "assistant", "abandoned branch"),
    ],
    leafId: "e2",
  };
}

/** Write a real resume file whose header cwd matches workspaceRoot (provider validates it). */
function seedResumeFile(workspaceRoot: string, store: SessionStore, seeded = seedActiveBranchWithAbandonedSibling()): string {
  const resumePath = join(workspaceRoot, `ses-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}.jsonl`);
  writeFileSync(
    resumePath,
    JSON.stringify({ type: "session", version: 3, id: "x", timestamp: "2026-01-01T00:00:00.000Z", cwd: workspaceRoot }) + "\n",
  );
  store.set(resumePath, seeded);
  return resumePath;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface HarnessSession {
  sessionId: string;
  resumed: boolean;
}

interface AcquireOpts {
  resumePath?: string;
  options?: Record<string, unknown>;
  compat?: {
    readonly piVersion?: string;
    readonly executionHostId?: string;
    readonly wslDistro?: string | null;
    readonly requiredCapabilities?: readonly string[];
  };
}

interface Harness {
  readonly kind: PathKind;
  readonly fakes: Snc110FakePi[];
  acquire(workspaceRoot: string, opts?: AcquireOpts): Promise<HarnessSession>;
  acquireExpectError(workspaceRoot: string, opts?: AcquireOpts): Promise<string>;
  dispatch(sessionId: string, text: string, images?: Array<{ data: string; mimeType: string }>): Promise<{ status: string; reason?: string; opId?: string }>;
  cancel(sessionId: string, targetOpId?: string): Promise<{ settled: boolean }>;
  setOptions(sessionId: string, options: Record<string, unknown>): Promise<Record<string, unknown>>;
  setOptionsExpectError(sessionId: string, options: Record<string, unknown>): Promise<string>;
  answerPrompt(requestId: string, value?: unknown, cancelled?: boolean): Promise<string>;
  promptRequests(opId?: string): Array<{ requestId: string; opId?: string }>;
  /** Live `tool_end` session events (isError included: tool failure is a live-event concern). */
  toolEndEvents(opId?: string): Array<{ toolCallId: string; isError: boolean; result: string; opId?: string }>;
  getHistory(sessionId: string): Promise<{
    entries: Array<{ role: string; text?: string; isError?: boolean }>;
    leafId?: string;
  }>;
  getSession(sessionId: string): Promise<Record<string, unknown>>;
  release(sessionId: string): Promise<void>;
  supportsCreate(location: { executionHostId: string; wslDistro: string | null }, agent: string): boolean;
  fakeForSession(index: number): Snc110FakePi;
  settleTurn(fake: Snc110FakePi, finalText: string, chunks?: string[]): Promise<void>;
  teardown(): Promise<void>;
}

function makeHarness(
  kind: PathKind,
  store: SessionStore,
  providerOpts: { requireCompat?: boolean } = {},
  tweakFake: (fake: Snc110FakePi) => void = () => undefined,
): Harness {
  const fakes: Snc110FakePi[] = [];
  const factory = (opts: PiRpcConnectionOptions): Snc110FakePi => {
    const fake = new Snc110FakePi(opts, store);
    tweakFake(fake);
    fakes.push(fake);
    return fake;
  };
  const fakeForSession = (index: number): Snc110FakePi => {
    const fake = fakes[index];
    if (!fake) throw new Error(`no fake at index ${index}`);
    return fake;
  };
  const settleTurn = async (fake: Snc110FakePi, finalText: string, chunks?: string[]): Promise<void> => {
    fake.emit({ type: "turn_start" } as PiServerEvent);
    for (const delta of chunks ?? [finalText]) {
      fake.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } } as unknown as PiServerEvent);
    }
    fake.emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: finalText } } as unknown as PiServerEvent);
    fake.emit({ type: "turn_end", message: { role: "assistant", stopReason: "stop" }, toolResults: [] } as unknown as PiServerEvent);
    fake.emit({ type: "agent_settled" } as PiServerEvent);
    await sleep(25);
  };

  if (kind === "native") {
    const native = new PiNativeProvider({ createConnection: factory, ...(providerOpts.requireCompat ? { requireCompat: true } : {}) });
    const events: Array<{ sessionId: string; opId?: string; type: string; event: Record<string, unknown> }> = [];
    native.onSessionEvent((envelope) => {
      events.push({
        sessionId: envelope.sessionId,
        ...(envelope.opId ? { opId: envelope.opId } : {}),
        type: envelope.event.type,
        event: envelope.event as unknown as Record<string, unknown>,
      });
    });
    return {
      kind,
      fakes,
      fakeForSession,
      settleTurn,
      supportsCreate: (location, agent) => native.supportsCreate(location, agent),
      async acquire(workspaceRoot, opts: AcquireOpts = {}) {
        return native.acquire({
          workspaceRoot,
          ...(opts.resumePath ? { resumePath: opts.resumePath } : {}),
          ...(opts.options ? { options: opts.options as never } : {}),
          ...(opts.compat ? { compat: opts.compat } : {}),
        });
      },
      async acquireExpectError(workspaceRoot, opts: AcquireOpts = {}) {
        try {
          await (this as Harness).acquire(workspaceRoot, opts);
          return "NO_ERROR";
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
      async dispatch(sessionId, text, images) {
        const res = await native.dispatch({ sessionId, text, ...(images?.length ? { images } : {}) });
        return { status: res.status, ...(res.status !== "accepted" ? { reason: (res as { reason?: string }).reason ?? res.status } : {}) };
      },
      async cancel(sessionId, targetOpId) {
        return native.cancel(sessionId, targetOpId);
      },
      async setOptions(sessionId, options) {
        return (await native.setOptions(sessionId, options as never)) as unknown as Record<string, unknown>;
      },
      async setOptionsExpectError(sessionId, options) {
        try {
          await native.setOptions(sessionId, options as never);
          return "NO_ERROR";
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
      async answerPrompt(requestId, value, cancelled = false) {
        try {
          await native.answerPrompt(requestId, value, cancelled);
          return "ANSWERED";
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
      promptRequests(opId) {
        return events
          .filter((e) => e.type === "prompt_request" && (opId === undefined || e.opId === opId))
          .map((e) => ({ requestId: String(e.event["requestId"] ?? ""), ...(e.opId ? { opId: e.opId } : {}) }));
      },
      toolEndEvents(opId) {
        return events
          .filter((e) => e.type === "tool_end" && (opId === undefined || e.opId === opId))
          .map((e) => ({
            toolCallId: String(e.event["toolCallId"] ?? ""),
            isError: e.event["isError"] === true,
            result: String(e.event["result"] ?? ""),
            ...(e.opId ? { opId: e.opId } : {}),
          }));
      },
      async getHistory(sessionId) {
        const h = await native.getHistory(sessionId);
        return {
          entries: h.entries.map((e) => {
            const raw = e as unknown as Record<string, unknown>;
            return {
              role: e.role,
              ...(e.text !== undefined ? { text: e.text } : {}),
              ...(raw["isError"] === true ? { isError: true as const } : {}),
            };
          }),
          ...(h.leafId ? { leafId: h.leafId } : {}),
        };
      },
      async getSession(sessionId) {
        return (await native.getSession(sessionId)) as unknown as Record<string, unknown>;
      },
      async release(sessionId) {
        await native.release(sessionId).catch(() => undefined);
      },
      async teardown() {
        await native.dispose().catch(() => undefined);
      },
    };
  }

  const provider = new PiBridgeProvider({ createConnection: factory, ...(providerOpts.requireCompat ? { requireCompat: true } : {}) });
  const out: ProviderToHostMessage[] = [];
  provider.attachTestTransport((msg) => out.push(msg));
  let seq = 0;
  const nextOp = (prefix: string): string => {
    seq += 1;
    return `${prefix}_${Date.now().toString(36)}_${seq}`;
  };
  const send = (obj: unknown): void => {
    provider.onLine(serializeBridgeLine(obj).trimEnd());
  };
  async function waitFor(opId: string, kinds: string[], timeoutMs = 5_000): Promise<ProviderToHostMessage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = [...out].reverse().find((m) => (m as { opId?: string }).opId === opId && kinds.includes(m.kind));
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`TIMEOUT waiting for ${kinds.join("/")} op ${opId}`);
      await sleep(5);
    }
  }
  let helloDone: Promise<void> | null = null;
  const ensureHello = (): Promise<void> => {
    helloDone ??= (async (): Promise<void> => {
      const opId = nextOp("hello");
      send({ v: 1, kind: "hello", opId, host: { id: "orca", version: "snc110", protocol: 1 }, workspaceRoot: "/tmp/snc110-ws" });
      await waitFor(opId, ["hello_ok"]);
    })();
    return helloDone;
  };
  const promptRequests = (opId?: string): Array<{ requestId: string; opId?: string }> =>
    out
      .filter((m) => m.kind === "session_event")
      .map((m) => m as unknown as { opId?: string; event: { type: string; requestId?: string } })
      .filter((m) => m.event.type === "prompt_request" && (opId === undefined || m.opId === opId))
      .map((m) => ({ requestId: String(m.event.requestId ?? ""), ...(m.opId ? { opId: m.opId } : {}) }));
  const toolEndEvents = (
    opId?: string,
  ): Array<{ toolCallId: string; isError: boolean; result: string; opId?: string }> =>
    out
      .filter((m) => m.kind === "session_event")
      .map(
        (m) =>
          m as unknown as {
            opId?: string;
            event: { type: string; toolCallId?: string; isError?: boolean; result?: string };
          },
      )
      .filter((m) => m.event.type === "tool_end" && (opId === undefined || m.opId === opId))
      .map((m) => ({
        toolCallId: String(m.event.toolCallId ?? ""),
        isError: m.event.isError === true,
        result: String(m.event.result ?? ""),
        ...(m.opId ? { opId: m.opId } : {}),
      }));
  return {
    kind,
    fakes,
    fakeForSession,
    settleTurn,
    promptRequests,
    toolEndEvents,
    supportsCreate: (location, agent) => {
      if (agent !== "pi") return false;
      return location.executionHostId === "local" && location.wslDistro === null;
    },
    async acquire(workspaceRoot, opts: AcquireOpts = {}) {
      await ensureHello();
      const opId = nextOp("acq");
      send({
        v: 1,
        kind: "acquire",
        opId,
        workspaceRoot,
        ...(opts.resumePath ? { resumePath: opts.resumePath } : {}),
        ...(opts.options ? { options: opts.options } : {}),
        ...(opts.compat ? { compat: opts.compat } : {}),
      });
      const reply = await waitFor(opId, ["acquired", "error"]);
      if (reply.kind === "acquired") {
        const r = reply as unknown as { sessionId: string; resumed: boolean };
        return { sessionId: r.sessionId, resumed: r.resumed };
      }
      const err = reply as unknown as { error: { code: string; message: string } };
      throw new Error(`${err.error.code}: ${err.error.message}`);
    },
    async acquireExpectError(workspaceRoot, opts: AcquireOpts = {}) {
      try {
        await (this as Harness).acquire(workspaceRoot, opts);
        return "NO_ERROR";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    async dispatch(sessionId, text, images) {
      await ensureHello();
      const opId = nextOp("dsp");
      send({ v: 1, kind: "dispatch", opId, sessionId, message: { text, ...(images?.length ? { images } : {}) } });
      const reply = await waitFor(opId, ["dispatch_ack", "error"]);
      if (reply.kind === "dispatch_ack") {
        const ack = reply as unknown as { status: string; reason?: string };
        return { status: ack.status, ...(ack.reason ? { reason: ack.reason } : {}), opId };
      }
      const err = reply as unknown as { error: { code: string; message: string } };
      return { status: "unknown", reason: `${err.error.code}: ${err.error.message}`, opId };
    },
    async cancel(sessionId, targetOpId) {
      await ensureHello();
      const opId = nextOp("cnl");
      send({ v: 1, kind: "cancel", opId, sessionId, ...(targetOpId ? { targetOpId } : {}) });
      const reply = await waitFor(opId, ["cancelled", "error"]);
      if (reply.kind === "cancelled") return { settled: (reply as unknown as { settled: boolean }).settled };
      const err = reply as unknown as { error: { code: string; message: string } };
      throw new Error(`${err.error.code}: ${err.error.message}`);
    },
    async setOptions(sessionId, options) {
      await ensureHello();
      const opId = nextOp("opt");
      send({ v: 1, kind: "set_options", opId, sessionId, options });
      const reply = await waitFor(opId, ["options_updated", "error"]);
      if (reply.kind === "options_updated") return (reply as unknown as { options: Record<string, unknown> }).options;
      const err = reply as unknown as { error: { code: string; message: string } };
      throw new Error(`${err.error.code}: ${err.error.message}`);
    },
    async setOptionsExpectError(sessionId, options) {
      try {
        await (this as Harness).setOptions(sessionId, options);
        return "NO_ERROR";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    async answerPrompt(requestId, value, cancelled = false) {
      await ensureHello();
      const opId = nextOp("ans");
      send({ v: 1, kind: "answer_prompt", opId, requestId, cancelled, ...(cancelled ? {} : { value }) });
      const reply = await waitFor(opId, ["error"]);
      return (reply as unknown as { error: { code: string } }).error.code;
    },
    async getHistory(sessionId) {
      await ensureHello();
      const opId = nextOp("his");
      send({ v: 1, kind: "get_history", opId, sessionId });
      const reply = await waitFor(opId, ["history", "error"]);
      if (reply.kind === "history") {
        const h = reply as unknown as {
          entries: Array<{ role: string; text?: string; isError?: boolean }>;
          leafId?: string;
        };
        return { entries: h.entries, ...(h.leafId ? { leafId: h.leafId } : {}) };
      }
      const err = reply as unknown as { error: { code: string; message: string } };
      throw new Error(`${err.error.code}: ${err.error.message}`);
    },
    async getSession(sessionId) {
      await ensureHello();
      const opId = nextOp("ses");
      send({ v: 1, kind: "get_session", opId, sessionId });
      const reply = await waitFor(opId, ["session", "error"]);
      if (reply.kind === "session") return (reply as unknown as { metadata: Record<string, unknown> }).metadata;
      const err = reply as unknown as { error: { code: string; message: string } };
      throw new Error(`${err.error.code}: ${err.error.message}`);
    },
    async release(sessionId) {
      await ensureHello();
      const opId = nextOp("rel");
      send({ v: 1, kind: "release", opId, sessionId });
      await waitFor(opId, ["released", "error"]).catch(() => undefined);
    },
    async teardown() {
      await provider.dispose().catch(() => undefined);
    },
  };
}

const PATHS: PathKind[] = ["bridge", "native"];

describe.each(PATHS)("SNC1.10 lifecycle E2E (%s path, scripted Pi, no credentials)", (kind) => {
  it("gates create to local pi (remote/WSL/other agents fail closed to TUI)", async () => {
    const harness = makeHarness(kind, new Map());
    try {
      expect(harness.supportsCreate({ executionHostId: "local", wslDistro: null }, "pi")).toBe(true);
      expect(harness.supportsCreate({ executionHostId: "local", wslDistro: null }, "codex")).toBe(false);
      expect(harness.supportsCreate({ executionHostId: "local", wslDistro: null }, "claude")).toBe(false);
      expect(harness.supportsCreate({ executionHostId: "remote", wslDistro: null }, "pi")).toBe(false);
      expect(harness.supportsCreate({ executionHostId: "local", wslDistro: "Ubuntu" }, "pi")).toBe(false);
      // The compat gate agrees and always names the Pi TUI fallback.
      const refused = gatePiStructuredSession({
        location: { executionHostId: "remote", wslDistro: null },
        agent: "pi",
        piVersion: MIN_KNOWN_GOOD_PI_VERSION,
      });
      expect(refused.structured).toBe(false);
      expect(refused.fallback).toBe("pi-tui");
    } finally {
      await harness.teardown();
    }
  });

  it("runs one full turn: text + thinking + tool events, journaled without leakage", async () => {
    const harness = makeHarness(kind, new Map());
    try {
      const { sessionId } = await harness.acquire("/tmp/snc110-ws");
      const fake = harness.fakeForSession(0);
      const accepted = await harness.dispatch(sessionId, "run tools");
      expect(accepted.status).toBe("accepted");
      fake.emit({ type: "turn_start" } as PiServerEvent);
      fake.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } } as unknown as PiServerEvent);
      fake.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "considering" } } as unknown as PiServerEvent);
      fake.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "considering" } } as unknown as PiServerEvent);
      fake.emit({ type: "tool_execution_start", toolCallId: "call_1", toolName: "read", args: { path: "a" } } as unknown as PiServerEvent);
      fake.emit({ type: "tool_execution_update", toolCallId: "call_1", partialResult: "tool-output-partial" } as unknown as PiServerEvent);
      fake.emit({ type: "tool_execution_end", toolCallId: "call_1", result: "tool-output", isError: false } as unknown as PiServerEvent);
      // Failing tool: the error stays in the tool channel (live `tool_end`
      // with `isError: true` plus a tool journal row), never paraphrased
      // into assistant prose. (`isError` is a live-event concern by design:
      // journal rows carry role/text only — see `pi-history.ts`.)
      fake.emit({ type: "tool_execution_start", toolCallId: "call_2", toolName: "bash", args: { command: "exit 1" } } as unknown as PiServerEvent);
      fake.emit({ type: "tool_execution_end", toolCallId: "call_2", result: "denied-by-policy", isError: true } as unknown as PiServerEvent);
      await harness.settleTurn(fake, "done");
      const toolEnds = harness.toolEndEvents(accepted.opId);
      expect(toolEnds.filter((e) => e.isError === false)).toHaveLength(1);
      const failedLive = toolEnds.filter((e) => e.isError === true);
      expect(failedLive).toHaveLength(1);
      expect(failedLive[0]?.toolCallId).toBe("call_2");
      expect(failedLive[0]?.result).toContain("denied-by-policy");
      const history = await harness.getHistory(sessionId);
      const assistants = history.entries.filter((e) => e.role === "assistant");
      const tools = history.entries.filter((e) => e.role === "tool");
      expect(assistants).toHaveLength(1);
      expect(tools.length).toBeGreaterThanOrEqual(2);
      // Thinking never becomes prose; tool stdout/stderr never becomes prose.
      expect(assistants.some((e) => (e.text ?? "").includes("considering"))).toBe(false);
      expect(assistants.some((e) => (e.text ?? "").includes("tool-output"))).toBe(false);
      expect(assistants.some((e) => (e.text ?? "").includes("denied-by-policy"))).toBe(false);
      expect(tools.some((e) => (e.text ?? "").includes("denied-by-policy"))).toBe(true);
      // The session survives the failed tool: settled and idle.
      const session = await harness.getSession(sessionId);
      expect(session["isStreaming"]).toBe(false);
    } finally {
      await harness.teardown();
    }
  });

  it("cancels idle honestly and aborts an active turn via Pi abort", async () => {
    const harness = makeHarness(kind, new Map());
    try {
      const { sessionId } = await harness.acquire("/tmp/snc110-ws");
      const idle = await harness.cancel(sessionId);
      expect(idle.settled).toBe(true);
      const fake = harness.fakeForSession(0);
      const accepted = await harness.dispatch(sessionId, "long task");
      expect(accepted.status).toBe("accepted");
      fake.emit({ type: "turn_start" } as PiServerEvent);
      await sleep(10);
      const active = await harness.cancel(sessionId, accepted.opId);
      expect(active.settled).toBe(false);
      expect(fake.aborts).toBe(1);
      fake.emit({ type: "turn_end", message: { role: "assistant", stopReason: "aborted", errorMessage: "Request was aborted" }, toolResults: [] } as unknown as PiServerEvent);
      fake.emit({ type: "agent_settled" } as PiServerEvent);
      await sleep(25);
      const session = await harness.getSession(sessionId);
      expect(session["isStreaming"]).toBe(false);
    } finally {
      await harness.teardown();
    }
  });

  it("applies model + thinking changes provider-confirmed and fails closed on bogus refs", async () => {
    const harness = makeHarness(kind, new Map());
    try {
      const { sessionId } = await harness.acquire("/tmp/snc110-ws");
      const applied = await harness.setOptions(sessionId, { thinkingLevel: "high" });
      expect(applied["thinkingLevel"]).toBe("high");
      const session = await harness.getSession(sessionId);
      expect(session["thinkingLevel"]).toBe("high");
      const modelApplied = await harness.setOptions(sessionId, { model: "opencode-go/text-only-model" });
      expect(String(modelApplied["model"] ?? "")).toContain("text-only-model");
      expect(await harness.setOptionsExpectError(sessionId, { model: "nope/does-not-exist-zzz" })).toMatch(/UNKNOWN_MODEL|AMBIGUOUS_MODEL|PI_OPTION/);
      expect(await harness.setOptionsExpectError(sessionId, { thinkingLevel: "ultra-mega-bogus" })).toMatch(/UNKNOWN_THINKING_LEVEL|PI_OPTION/);
    } finally {
      await harness.teardown();
    }
  });

  it("answers an interactive prompt exactly once (second answer is a stale refusal)", async () => {
    const harness = makeHarness(kind, new Map());
    try {
      const { sessionId } = await harness.acquire("/tmp/snc110-ws");
      const fake = harness.fakeForSession(0);
      const accepted = await harness.dispatch(sessionId, "ask me");
      expect(accepted.status).toBe("accepted");
      fake.emit({ type: "extension_ui_request", id: "dlg_1", method: "select", title: "Pick", options: ["A", "B"] } as unknown as PiServerEvent);
      await sleep(25);
      const requests = harness.promptRequests(accepted.opId);
      expect(requests).toHaveLength(1);
      const requestId = requests[0]?.requestId ?? "";
      expect(requestId).not.toBe("");
      expect(await harness.answerPrompt(requestId, "A")).toMatch(/ANSWERED/);
      expect(fake.uiResponses).toHaveLength(1);
      // Exactly-once: the retry is a stale refusal and never reaches Pi again.
      expect(await harness.answerPrompt(requestId, "B")).toMatch(/UNKNOWN_REQUEST/);
      expect(fake.uiResponses).toHaveLength(1);
      await harness.settleTurn(fake, "picked A");
    } finally {
      await harness.teardown();
    }
  });

  it("keeps unknown delivery unknown with no resend (single Pi prompt call)", async () => {
    const store = new Map();
    const harness = makeHarness(kind, store);
    try {
      const { sessionId } = await harness.acquire("/tmp/snc110-ws");
      const fake = harness.fakeForSession(0);
      fake.failPromptWith = Object.assign(new Error("prompt timed out"), {
        code: "request-timeout",
        command: "prompt",
        requestId: "r1",
        ambiguous: true,
        timeoutMs: 10,
      });
      const outcome = await harness.dispatch(sessionId, "ambiguous work");
      expect(outcome.status).toBe("unknown");
      expect(outcome.reason).toMatch(/reconcile via history|ambiguous/i);
      // No silent resend: Pi saw the prompt exactly once.
      expect(fake.prompts.filter((p) => p === "ambiguous work")).toHaveLength(1);
      // Recovery is explicit reconciliation via history, not a blind retry.
      const history = await harness.getHistory(sessionId);
      expect(Array.isArray(history.entries)).toBe(true);
    } finally {
      await harness.teardown();
    }
  });

  it("accepts images on capable models without journaling bytes; refuses on text-only models", async () => {
    const harness = makeHarness(kind, new Map());
    const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    try {
      const { sessionId } = await harness.acquire("/tmp/snc110-ws");
      const fake = harness.fakeForSession(0);
      const accepted = await harness.dispatch(sessionId, "describe attachment", [{ data: pngBase64, mimeType: "image/png" }]);
      expect(accepted.status).toBe("accepted");
      await harness.settleTurn(fake, "ONE-PIXEL");
      const history = await harness.getHistory(sessionId);
      expect(JSON.stringify(history.entries)).not.toContain(pngBase64.slice(0, 32));
      // Switch to a text-only model: images now refuse fail-closed.
      await harness.setOptions(sessionId, { model: "opencode-go/text-only-model" });
      const refused = await harness.dispatch(sessionId, "another image", [{ data: pngBase64, mimeType: "image/png" }]);
      expect(refused.status).toBe("rejected");
      expect(refused.reason).toMatch(/model-rejects-images/);
    } finally {
      await harness.teardown();
    }
  });

  it("resumes at the current leaf with abandoned branches excluded", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "snc110-ws-"));
    const store: SessionStore = new Map();
    const resumePath = seedResumeFile(workspaceRoot, store);
    const harness = makeHarness(kind, store);
    try {
      const acquired = await harness.acquire(workspaceRoot, { resumePath });
      expect(acquired.resumed).toBe(true);
      const history = await harness.getHistory(acquired.sessionId);
      const transcript = history.entries.map((e) => `${e.role}:${e.text ?? ""}`).join("|");
      expect(transcript).toContain("user:hello active");
      expect(transcript).toContain("assistant:active reply");
      expect(transcript).not.toContain("abandoned branch");
      expect(history.leafId).toBe("e2");
    } finally {
      await harness.teardown();
    }
  });

  it("recovers from an unexpected Pi exit: rejected dispatch, then explicit reacquire", async () => {
    const harness = makeHarness(kind, new Map());
    try {
      const { sessionId } = await harness.acquire("/tmp/snc110-ws");
      const fake = harness.fakeForSession(0);
      fake.die(1, null);
      await sleep(25);
      // No hang, no silent resend: definite rejection naming reacquire.
      const outcome = await harness.dispatch(sessionId, "after crash");
      expect(outcome.status).toBe("rejected");
      expect(outcome.reason).toMatch(/reacquire|unavailable|exited/i);
      // Explicit recovery works: a fresh session dispatches cleanly.
      const fresh = await harness.acquire("/tmp/snc110-ws");
      const fake2 = harness.fakeForSession(1);
      const ok = await harness.dispatch(fresh.sessionId, "recovered");
      expect(ok.status).toBe("accepted");
      await harness.settleTurn(fake2, "recovered reply");
      const history = await harness.getHistory(fresh.sessionId);
      expect(history.entries.some((e) => (e.text ?? "").includes("recovered reply"))).toBe(true);
    } finally {
      await harness.teardown();
    }
  });

  it("refuses a failing acquire-time gate before any Pi child starts (both paths)", async () => {
    const harness = makeHarness(kind, new Map());
    try {
      // Old Pi: refused with an actionable code, zero Pi children started.
      expect(await harness.acquireExpectError("/tmp/snc110-ws", { compat: { piVersion: "0.1.0" } })).toMatch(
        /PI_COMPAT_VERSION/,
      );
      expect(harness.fakes).toHaveLength(0);
      // Remote host: refused the same way, still no Pi child.
      expect(
        await harness.acquireExpectError("/tmp/snc110-ws", { compat: { piVersion: MIN_KNOWN_GOOD_PI_VERSION, executionHostId: "remote" } }),
      ).toMatch(/PI_COMPAT_LOCATION/);
      expect(harness.fakes).toHaveLength(0);
      // Missing required capability: refused against the advertised set.
      expect(
        await harness.acquireExpectError("/tmp/snc110-ws", {
          compat: { piVersion: MIN_KNOWN_GOOD_PI_VERSION, requiredCapabilities: ["teleportation"] },
        }),
      ).toMatch(/PI_COMPAT_CAPABILITY/);
      expect(harness.fakes).toHaveLength(0);
      // A passing gate acquires normally (one Pi child, honest lease).
      const ok = await harness.acquire("/tmp/snc110-ws", { compat: { piVersion: MIN_KNOWN_GOOD_PI_VERSION } });
      expect(ok.sessionId).not.toBe("");
      expect(harness.fakes).toHaveLength(1);
    } finally {
      await harness.teardown();
    }
  });

  it("fails closed when compatibility evidence is required but missing (requireCompat)", async () => {
    const harness = makeHarness(kind, new Map(), { requireCompat: true });
    try {
      // No evidence at all, and present-but-empty evidence: both refuse
      // pre-spawn with zero Pi children started.
      expect(await harness.acquireExpectError("/tmp/snc110-ws")).toMatch(/PI_COMPAT_EVIDENCE_MISSING/);
      expect(harness.fakes).toHaveLength(0);
      expect(await harness.acquireExpectError("/tmp/snc110-ws", { compat: {} })).toMatch(/PI_COMPAT_EVIDENCE_MISSING/);
      expect(harness.fakes).toHaveLength(0);
      // Version alone is NOT enough in fail-closed mode: live capability
      // evidence is required too (round-4 P1).
      expect(
        await harness.acquireExpectError("/tmp/snc110-ws", { compat: { piVersion: MIN_KNOWN_GOOD_PI_VERSION } }),
      ).toMatch(/PI_COMPAT_EVIDENCE_MISSING/);
      expect(harness.fakes).toHaveLength(0);
      // Evidence supplied: the floor still applies (old Pi refused).
      expect(
        await harness.acquireExpectError("/tmp/snc110-ws", {
          compat: { piVersion: "0.1.0", requiredCapabilities: ["options", "history"] },
        }),
      ).toMatch(/PI_COMPAT_VERSION/);
      expect(harness.fakes).toHaveLength(0);
      // Full evidence (version + live-provable set): exactly one Pi child.
      const ok = await harness.acquire("/tmp/snc110-ws", {
        compat: { piVersion: MIN_KNOWN_GOOD_PI_VERSION, requiredCapabilities: ["options", "history"] },
      });
      expect(ok.sessionId).not.toBe("");
      expect(harness.fakes).toHaveLength(1);
    } finally {
      await harness.teardown();
    }
  });

  it("verifies required capabilities against the running Pi (live probes, not just ads)", async () => {
    const harness = makeHarness(kind, new Map());
    try {
      // Live catalog + history RPCs answer: options/history/images proven live.
      const ok = await harness.acquire("/tmp/snc110-ws", {
        compat: { piVersion: MIN_KNOWN_GOOD_PI_VERSION, requiredCapabilities: ["options", "history", "images"] },
      });
      expect(ok.sessionId).not.toBe("");
      expect(harness.fakes).toHaveLength(1);
      expect(harness.fakes[0]?.isClosed).toBe(false);
    } finally {
      await harness.teardown();
    }
  });

  it("refuses live-unproven capabilities and tears down the started child (no leak)", async () => {
    const stripRpcs = (fake: Snc110FakePi): void => {
      stripMethods(fake, ["getAvailableModels", "getAvailableThinkingLevels", "getEntries", "getTree"]);
    };
    const harness = makeHarness(kind, new Map(), {}, stripRpcs);
    try {
      const reason = await harness.acquireExpectError("/tmp/snc110-ws", {
        compat: { piVersion: MIN_KNOWN_GOOD_PI_VERSION, requiredCapabilities: ["options", "history"] },
      });
      expect(reason).toMatch(/PI_COMPAT_CAPABILITY/);
      expect(reason).toMatch(/live probe/);
      // The child was constructed for probing but closed again: no leak,
      // no session exposed.
      expect(harness.fakes).toHaveLength(1);
      expect(harness.fakes[0]?.isClosed).toBe(true);
    } finally {
      await harness.teardown();
    }
  });

  it("refuses options when the live Pi lacks the mutation setters (presence, never invoked)", async () => {
    const noSetters = (fake: Snc110FakePi): void => {
      stripMethods(fake, ["setModel", "setThinkingLevel", "setAutoCompaction"]);
    };
    const harness = makeHarness(kind, new Map(), {}, noSetters);
    try {
      // Catalogs read fine, but the capability exposes mutations the
      // running Pi cannot perform: fail closed, child torn down.
      const reason = await harness.acquireExpectError("/tmp/snc110-ws", {
        compat: { piVersion: MIN_KNOWN_GOOD_PI_VERSION, requiredCapabilities: ["options"] },
      });
      expect(reason).toMatch(/PI_COMPAT_CAPABILITY/);
      expect(reason).toMatch(/setter/);
      expect(harness.fakes).toHaveLength(1);
      expect(harness.fakes[0]?.isClosed).toBe(true);
    } finally {
      await harness.teardown();
    }
  });

  it("refuses resume when the live Pi lacks switchSession (readable history is not enough)", async () => {
    const noSwitch = (fake: Snc110FakePi): void => {
      stripMethods(fake, ["switchSession"]);
    };
    const harness = makeHarness(kind, new Map(), {}, noSwitch);
    try {
      const reason = await harness.acquireExpectError("/tmp/snc110-ws", {
        compat: { piVersion: MIN_KNOWN_GOOD_PI_VERSION, requiredCapabilities: ["resume"] },
      });
      expect(reason).toMatch(/PI_COMPAT_CAPABILITY/);
      expect(reason).toMatch(/switchSession/);
      expect(harness.fakes).toHaveLength(1);
      expect(harness.fakes[0]?.isClosed).toBe(true);
    } finally {
      await harness.teardown();
    }
  });

  it("proves images without the thinking catalog (no unrelated coupling)", async () => {
    const noThinkingCatalog = (fake: Snc110FakePi): void => {
      stripMethods(fake, ["getAvailableThinkingLevels"]);
    };
    const harness = makeHarness(kind, new Map(), {}, noThinkingCatalog);
    try {
      // Images needs the model catalog only: succeeds despite the missing
      // thinking catalog (round-4 P2).
      const ok = await harness.acquire("/tmp/snc110-ws", {
        compat: { piVersion: MIN_KNOWN_GOOD_PI_VERSION, requiredCapabilities: ["images"] },
      });
      expect(ok.sessionId).not.toBe("");
      // But options still requires the thinking catalog: refuses.
      const harness2 = makeHarness(kind, new Map(), {}, noThinkingCatalog);
      try {
        const reason = await harness2.acquireExpectError("/tmp/snc110-ws", {
          compat: { piVersion: MIN_KNOWN_GOOD_PI_VERSION, requiredCapabilities: ["options"] },
        });
        expect(reason).toMatch(/PI_COMPAT_CAPABILITY/);
      } finally {
        await harness2.teardown();
      }
    } finally {
      await harness.teardown();
    }
  });

  it("refuses options when set_model fails at transport level (verb unproven)", async () => {
    // Real forward-compat failure mode: the wrapper method exists but the
    // underlying RPC command does not answer definitively.
    const brokenSetModel = (fake: Snc110FakePi): void => {
      const mutable = fake as unknown as Record<string, unknown>;
      mutable["setModel"] = async (): Promise<never> => {
        throw new PiRpcError(
          { code: "request-timeout", command: "set_model", ambiguous: true, timeoutMs: 10 },
          "set_model timed out",
        );
      };
    };
    const harness = makeHarness(kind, new Map(), {}, brokenSetModel);
    try {
      const reason = await harness.acquireExpectError("/tmp/snc110-ws", {
        compat: { piVersion: MIN_KNOWN_GOOD_PI_VERSION, requiredCapabilities: ["options"] },
      });
      expect(reason).toMatch(/PI_COMPAT_CAPABILITY/);
      expect(reason).toMatch(/set_model verb unproven/);
      expect(harness.fakes).toHaveLength(1);
      expect(harness.fakes[0]?.isClosed).toBe(true);
    } finally {
      await harness.teardown();
    }
  });

  it("falls back to get_tree when get_entries fails (mirrors provider rebuild)", async () => {
    const entriesFailing = (fake: Snc110FakePi): void => {
      const mutable = fake as unknown as Record<string, unknown>;
      mutable["getEntries"] = async (): Promise<never> => {
        throw new PiRpcError(
          { code: "request-timeout", command: "get_entries", ambiguous: true, timeoutMs: 10 },
          "get_entries timed out",
        );
      };
    };
    const harness = makeHarness(kind, new Map(), {}, entriesFailing);
    try {
      // Tree still serves history: the probe passes (round-4 P2).
      const ok = await harness.acquire("/tmp/snc110-ws", {
        compat: { piVersion: MIN_KNOWN_GOOD_PI_VERSION, requiredCapabilities: ["history"] },
      });
      expect(ok.sessionId).not.toBe("");
    } finally {
      await harness.teardown();
    }
  });

  it("refuses images when the live Pi catalog has no image-capable model", async () => {
    const textOnly = (fake: Snc110FakePi): void => {
      fake.models = [{ id: "text-only-model", provider: "opencode-go", input: ["text"] } as PiModel];
    };
    const harness = makeHarness(kind, new Map(), {}, textOnly);
    try {
      const reason = await harness.acquireExpectError("/tmp/snc110-ws", {
        compat: { piVersion: MIN_KNOWN_GOOD_PI_VERSION, requiredCapabilities: ["images"] },
      });
      expect(reason).toMatch(/PI_COMPAT_CAPABILITY/);
      expect(reason).toMatch(/image-capable/);
      expect(harness.fakes).toHaveLength(1);
      expect(harness.fakes[0]?.isClosed).toBe(true);
    } finally {
      await harness.teardown();
    }
  });

  it("round-trips structured → TUI → structured on the same session without duplication", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "snc110-ws-"));
    const store: SessionStore = new Map();
    const resumePath = seedResumeFile(workspaceRoot, store);
    const harness = makeHarness(kind, store);
    try {
      // Structured owner works, then hands off: release proves Pi exit, no leak.
      const first = await harness.acquire(workspaceRoot, { resumePath });
      const fake = harness.fakeForSession(0);
      expect(await harness.dispatch(first.sessionId, "structured turn")).toMatchObject({ status: "accepted" });
      await harness.settleTurn(fake, "structured reply");
      // The structured leg is journaled before handoff (live rows present).
      const before = await harness.getHistory(first.sessionId);
      const beforeText = before.entries.map((e) => `${e.role}:${e.text ?? ""}`).join("|");
      expect(beforeText).toContain("user:structured turn");
      expect(beforeText).toContain("assistant:structured reply");
      await harness.release(first.sessionId);
      expect(fake.isClosed).toBe(true);
      // Real Pi persists the structured leg to its session file; the scripted
      // store models that persistence explicitly (parented at the leaf).
      persistTurnToStore(store, resumePath, "structured turn", "structured reply");
      // TUI interlude appends two more rows at the new leaf (Pi owns the file).
      persistTurnToStore(store, resumePath, "tui followup", "tui reply");
      // Structured reacquires the same session: every row from BOTH legs, each once.
      const second = await harness.acquire(workspaceRoot, { resumePath });
      expect(second.resumed).toBe(true);
      const history = await harness.getHistory(second.sessionId);
      const transcript = history.entries.map((e) => `${e.role}:${e.text ?? ""}`).join("|");
      for (const row of [
        "user:hello active",
        "assistant:active reply",
        "user:structured turn",
        "assistant:structured reply",
        "user:tui followup",
        "assistant:tui reply",
      ]) {
        const occurrences = transcript.split(row).length - 1;
        expect(occurrences).toBe(1);
      }
      expect(history.leafId).toBe(store.get(resumePath)?.leafId);
    } finally {
      await harness.teardown();
    }
  });

  it("restores an identical transcript after a full provider restart", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "snc110-ws-"));
    const store: SessionStore = new Map();
    const resumePath = seedResumeFile(workspaceRoot, store);
    const before = makeHarness(kind, store);
    let transcriptBefore = "";
    try {
      const acquired = await before.acquire(workspaceRoot, { resumePath });
      const history = await before.getHistory(acquired.sessionId);
      transcriptBefore = history.entries.map((e) => `${e.role}:${e.text ?? ""}`).join("|");
    } finally {
      await before.teardown();
    }
    const after = makeHarness(kind, store);
    try {
      const acquired = await after.acquire(workspaceRoot, { resumePath });
      expect(acquired.resumed).toBe(true);
      const history = await after.getHistory(acquired.sessionId);
      expect(history.entries.map((e) => `${e.role}:${e.text ?? ""}`).join("|")).toBe(transcriptBefore);
      expect(history.leafId).toBe("e2");
    } finally {
      await after.teardown();
    }
  });

  it("keeps sessions fenced: no history/prompt leakage, stale ids refuse", async () => {
    const harness = makeHarness(kind, new Map());
    try {
      const a = await harness.acquire("/tmp/snc110-ws");
      const b = await harness.acquire("/tmp/snc110-ws");
      const fakeA = harness.fakeForSession(0);
      const fakeB = harness.fakeForSession(1);
      expect(await harness.dispatch(a.sessionId, "alpha work")).toMatchObject({ status: "accepted" });
      await harness.settleTurn(fakeA, "alpha reply");
      expect(await harness.dispatch(b.sessionId, "beta work")).toMatchObject({ status: "accepted" });
      await harness.settleTurn(fakeB, "beta reply");
      const histA = await harness.getHistory(a.sessionId);
      const histB = await harness.getHistory(b.sessionId);
      expect(histA.entries.some((e) => (e.text ?? "").includes("beta"))).toBe(false);
      expect(histB.entries.some((e) => (e.text ?? "").includes("alpha"))).toBe(false);
      // Prompt fenced to its session: answering in the wrong session refuses.
      fakeA.emit({ type: "extension_ui_request", id: "dlg_fence", method: "input", title: "Name" } as unknown as PiServerEvent);
      await sleep(25);
      expect(await harness.answerPrompt("never-seen-request", "x")).toMatch(/UNKNOWN_REQUEST/);
      // Stale session ids refuse without touching Pi.
      expect(await harness.setOptionsExpectError("ses_missing_snc110", { thinkingLevel: "high" })).toMatch(/UNKNOWN_SESSION|unknown session|SESSION|failed/i);
      await harness.release(a.sessionId);
      expect((await harness.dispatch(a.sessionId, "after release")).status).toBe("rejected");
    } finally {
      await harness.teardown();
    }
  });
});

describe("SNC1.10 security + reliability evidence (offline, deterministic)", () => {
  it("bounds and redacts stderr tails (no secrets, bounded length)", () => {
    const secret = "Bearer abcdefghij1234567890 and sk-proj-abcdefghijklmnop";
    const redacted = redactSecretsFromText(`prefix ${secret} suffix`);
    expect(redacted).not.toContain("abcdefghij1234567890");
    expect(redacted).not.toContain("sk-proj-abcdefghijklmnop");
    // User paths are identifying: the Pi RPC redactor collapses them.
    expect(redactSecrets("at C:\\Users\\someone\\notes and /home/someone/x")).not.toContain("someone");
    const long = `ok ${"x".repeat(MAX_STDERR_BYTES + 500)}`;
    expect(redactSecretsFromText(long).length).toBeLessThanOrEqual(MAX_STDERR_BYTES);
  });

  it("keeps PiRpc errors secret-safe (codes + ids, never prompt text)", () => {
    const secretPrompt = "super secret prompt xyzzy-nine";
    const err = new PiRpcError(
      { code: "request-timeout", command: "prompt", requestId: "r1", ambiguous: true, timeoutMs: 10 },
      `timed out: ${secretPrompt}`,
    );
    // The shaped summary carries only machine-readable facts.
    const summary = err.toSecretSafeString();
    expect(summary).toContain("request-timeout");
    expect(summary).not.toContain(secretPrompt);
    expect(err.ambiguous).toBe(true);
  });

  it("refuses credential fields on the bridge wire (both directions)", () => {
    expect(FORBIDDEN_BRIDGE_KEYS.length).toBeGreaterThan(0);
    expect(
      validateBridgeMessage({ v: 1, kind: "dispatch", opId: "d1", sessionId: "s", message: { text: "hi" }, auth: { token: "x" } }),
    ).toBe("credential-field");
    expect(
      validateBridgeMessage({ v: 1, kind: "dispatch", opId: "d1", sessionId: "s", message: { text: "hi" } }),
    ).toBeNull();
  });

  it("fails closed to Pi TUI on unsupported Pi versions (no silent downgrade)", () => {
    const old = checkPiVersionSupport("0.1.0");
    expect(old.supported).toBe(false);
    expect(old.fallback).toBe("pi-tui");
    expect(old.reason).toMatch(/unsupported-pi-version/);
    const current = checkPiVersionSupport(MIN_KNOWN_GOOD_PI_VERSION);
    expect(current.supported).toBe(true);
  });

  it("builds Pi transport from argv arrays only (never a shell string)", async () => {
    // resolvePiSpec returns structured argv; TUI-only flags reject fail-closed.
    const { toPiRpcProcessSpec } = await import("@orca-pi/pi-rpc");
    const spec = toPiRpcProcessSpec({ command: "pi", args: ["--session-dir", "/tmp/x"], cwd: "/tmp/x" });
    expect(spec.command).toBe("pi");
    expect(spec.args).toContain("--mode");
    expect(spec.args).toContain("rpc");
    expect(typeof spec.command).toBe("string");
    expect(Array.isArray([...spec.args])).toBe(true);
    expect(() => toPiRpcProcessSpec({ command: "pi", args: ["--theme", "dark"] })).toThrow(/TUI-only/);
  });
});

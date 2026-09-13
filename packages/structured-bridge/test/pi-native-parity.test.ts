/**
 * SNC1.8 native parity tests: the SAME conformance suite against the bridge
 * path and the native in-process path.
 *
 * Parity requirement (from #18): run the same conformance suite against
 * bridge and native paths for basic dispatch/streaming,
 * thinking/tools/errors/lifecycle, options/prompts/images,
 * history/current-branch restore, cancel/close/error classification —
 * plus the SNC1.8 additions that close ChatGPT round-1 gaps: ambiguous
 * delivery preserves `unknown`, images + successful option apply, resume
 * rebuilds only the active branch, and the session-event boundary streams
 * lifecycle (not only provider-internal history).
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiBridgeProvider, type PiProviderConnection } from "../src/pi-provider.js";
import { PiNativeProvider } from "../src/pi-native.js";
import {
  PI_CONFORMANCE_SCENARIOS,
  runPiConformanceSuite,
  type PiConformanceDriver,
} from "../src/pi-conformance.js";
import { serializeBridgeLine } from "../src/framing.js";
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

function piMsg(id: string, parentId: string | null, role: string, text: string) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role, content: [{ type: "text", text }], timestamp: 1700000000000 },
  };
}

/** Deterministic fake Pi with options + history + ambiguous-failure support. */
class ParityFakePi implements PiProviderConnection {
  readonly seenOpts: PiRpcConnectionOptions;
  readonly prompts: Array<{ message: string }> = [];
  readonly uiResponses: Array<unknown> = [];
  aborts = 0;
  started = false;
  /** When set, the next `prompt()` throws it (ambiguous vs definite refusal). */
  failPromptWith: unknown = null;
  models: PiModel[] = [
    { id: "glm-5.3-flash", provider: "opencode-go", input: ["text", "image"] } as PiModel,
    { id: "text-only-model", provider: "opencode-go", input: ["text"] } as PiModel,
  ];
  levels: string[] = ["low", "high", "max"];
  switchedTo: string[] = [];
  entries: Array<Record<string, unknown>> = [];
  leafId = "";
  state: PiState = {
    model: { id: "glm-5.3-flash", provider: "opencode-go" } as PiState["model"],
    thinkingLevel: "low",
    isStreaming: false,
    isCompacting: false,
    sessionId: "pi_parity_1",
    messageCount: 0,
  };
  private readonly eventHandlers = new Set<(e: PiServerEvent) => void>();
  private readonly exitHandlers = new Set<(info: PiRpcCloseResult) => void>();
  private _closed = false;

  constructor(opts: PiRpcConnectionOptions) {
    this.seenOpts = opts;
  }

  get isClosed(): boolean {
    return this._closed;
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async prompt(message: string): Promise<void> {
    this.prompts.push({ message });
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
      throw Object.assign(new Error(`Model not found: ${provider}/${modelId}`), { code: "model-not-found" });
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
}

function seedActiveBranchWithAbandonedSibling(fake: ParityFakePi): void {
  fake.entries = [
    piMsg("e1", null, "user", "hello active"),
    piMsg("e2", "e1", "assistant", "active reply"),
    // Abandoned fork sibling off e1 (must never render when leaf is e2).
    piMsg("eX", "e1", "assistant", "abandoned branch"),
  ];
  fake.leafId = "e2";
  fake.state = { ...fake.state, messageCount: 2 };
}

function seedResumeDir(): { dir: string; resumePath: string } {
  const dir = mkdtempSync(join(tmpdir(), "snc18-resume-"));
  const resumePath = join(dir, "ses.jsonl");
  writeFileSync(
    resumePath,
    JSON.stringify({ type: "session", version: 3, id: "x", timestamp: "2026-01-01T00:00:00.000Z", cwd: dir }) + "\n",
  );
  return { dir, resumePath };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Bridge driver: JSONL through PiBridgeProvider (the proven SNC1.4–SNC1.7 path). */
function makeBridgeDriver(): PiConformanceDriver & { fakes: ParityFakePi[] } {
  const fakes: ParityFakePi[] = [];
  const provider = new PiBridgeProvider({
    createConnection: (opts) => {
      const fake = new ParityFakePi(opts);
      fakes.push(fake);
      return fake;
    },
  });
  const out: ProviderToHostMessage[] = [];
  provider.attachTestTransport((msg) => out.push(msg));
  let seq = 0;
  const nextOp = (prefix: string): string => {
    seq += 1;
    return `${prefix}_${Date.now().toString(36)}_${seq}`;
  };
  const send = (obj: unknown): void => {
    provider.onLine(typeof obj === "string" ? obj : serializeBridgeLine(obj).trimEnd());
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
  async function hello(): Promise<void> {
    const opId = nextOp("hello");
    send({ v: 1, kind: "hello", opId, host: { id: "orca", version: "parity", protocol: 1 }, workspaceRoot: "/tmp/ws" });
    await waitFor(opId, ["hello_ok"]);
  }
  let helloDone: Promise<void> | null = null;
  const ensureHello = (): Promise<void> => {
    helloDone ??= hello();
    return helloDone;
  };
  const fakeFor = (): ParityFakePi => {
    const fake = fakes[fakes.length - 1];
    if (!fake) throw new Error("no fake Pi for session");
    return fake;
  };

  return {
    label: "bridge",
    fakes,
    supportsCreate: (location, agent) => {
      if (agent !== "pi") return false;
      return location.executionHostId === "local" && location.wslDistro === null;
    },
    async acquire(input) {
      await ensureHello();
      const opId = nextOp("acq");
      send({ v: 1, kind: "acquire", opId, workspaceRoot: input.workspaceRoot, ...(input.resumePath ? { resumePath: input.resumePath } : {}), ...(input.options ? { options: input.options } : {}) });
      const reply = await waitFor(opId, ["acquired", "error"]);
      if (reply.kind === "acquired") {
        const r = reply as unknown as { sessionId: string; resumed: boolean; metadata: import("../src/protocol.js").BridgeSessionMetadata };
        return { sessionId: r.sessionId, resumed: r.resumed, metadata: r.metadata };
      }
      const err = reply as unknown as { error: { code: string; message: string } };
      throw new Error(`${err.error.code}: ${err.error.message}`);
    },
    async dispatch(input) {
      await ensureHello();
      const opId = nextOp("dsp");
      send({ v: 1, kind: "dispatch", opId, sessionId: input.sessionId, message: { text: input.text, ...(input.images?.length ? { images: input.images } : {}) } });
      const reply = await waitFor(opId, ["dispatch_ack", "error"]);
      if (reply.kind === "dispatch_ack") {
        const ack = reply as unknown as { status: string; reason?: string };
        return { status: ack.status, ...(ack.reason ? { reason: ack.reason } : {}) };
      }
      const err = reply as unknown as { error: { code: string; message: string } };
      return { status: "unknown", reason: `${err.error.code}: ${err.error.message}` };
    },
    async streamText(_sessionId, chunks, finalText) {
      const fake = fakeFor();
      fake.emit({ type: "turn_start" } as PiServerEvent);
      fake.emit({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } } as unknown as PiServerEvent);
      for (const delta of chunks) {
        fake.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } } as unknown as PiServerEvent);
      }
      fake.emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: finalText } } as unknown as PiServerEvent);
      fake.emit({ type: "turn_end", message: { role: "assistant", stopReason: "stop" }, toolResults: [] } as unknown as PiServerEvent);
      fake.emit({ type: "agent_settled" } as PiServerEvent);
      await sleep(20);
    },
    async streamThinking() {
      const fake = fakeFor();
      fake.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } } as unknown as PiServerEvent);
      fake.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "considering" } } as unknown as PiServerEvent);
      fake.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "considering" } } as unknown as PiServerEvent);
      await sleep(10);
    },
    async streamToolSuccess(_sessionId, toolCallId, toolName) {
      const fake = fakeFor();
      fake.emit({ type: "tool_execution_start", toolCallId, toolName, args: { path: "a" } } as unknown as PiServerEvent);
      fake.emit({ type: "tool_execution_update", toolCallId, partialResult: "tool-output-partial" } as unknown as PiServerEvent);
      fake.emit({ type: "tool_execution_end", toolCallId, result: "tool-output", isError: false } as unknown as PiServerEvent);
      await sleep(10);
    },
    async streamTurnError() {
      const fake = fakeFor();
      fake.emit({ type: "turn_start" } as PiServerEvent);
      fake.emit({ type: "turn_end", message: { role: "assistant", stopReason: "error", errorMessage: "provider dispatch failed" }, toolResults: [] } as unknown as PiServerEvent);
      fake.emit({ type: "agent_settled" } as PiServerEvent);
      await sleep(20);
    },
    async cancel(sessionId) {
      await ensureHello();
      const opId = nextOp("cnl");
      send({ v: 1, kind: "cancel", opId, sessionId });
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
      if (reply.kind === "options_updated") return (reply as unknown as { options: import("../src/protocol.js").BridgeSessionOptions }).options;
      const err = reply as unknown as { error: { code: string; message: string } };
      throw new Error(`${err.error.code}: ${err.error.message}`);
    },
    async setOptionsExpectError(sessionId, options) {
      try {
        await (this as PiConformanceDriver).setOptions(sessionId, options);
        return "NO_ERROR";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    async answerPromptExpectError(requestId) {
      await ensureHello();
      const opId = nextOp("ans");
      send({ v: 1, kind: "answer_prompt", opId, requestId, cancelled: false, value: "x" });
      const reply = await waitFor(opId, ["error"]);
      const err = reply as unknown as { error: { code: string; message: string } };
      return `${err.error.code}: ${err.error.message}`;
    },
    async getHistory(sessionId) {
      await ensureHello();
      const opId = nextOp("his");
      send({ v: 1, kind: "get_history", opId, sessionId });
      const reply = await waitFor(opId, ["history", "error"]);
      if (reply.kind === "history") {
        const h = reply as unknown as { entries: import("../src/protocol.js").BridgeHistoryEntry[]; leafId?: string };
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
      if (reply.kind === "session") return (reply as unknown as { metadata: import("../src/protocol.js").BridgeSessionMetadata }).metadata;
      const err = reply as unknown as { error: { code: string; message: string } };
      throw new Error(`${err.error.code}: ${err.error.message}`);
    },
    async listModels() {
      return [];
    },
    async listThinkingLevels() {
      return [];
    },
    async dispatchExpectRejected(sessionId, text) {
      await ensureHello();
      const opId = nextOp("dsp");
      send({ v: 1, kind: "dispatch", opId, sessionId, message: { text } });
      const reply = await waitFor(opId, ["dispatch_ack", "error"]);
      if (reply.kind === "dispatch_ack") {
        const ack = reply as unknown as { status: string; reason?: string };
        if (ack.status === "rejected") return ack.reason ?? "rejected";
        return `UNEXPECTED_${ack.status}`;
      }
      const err = reply as unknown as { error: { code: string; message: string } };
      return `${err.error.code}: ${err.error.message}`;
    },
    async dispatchImage(sessionId, text) {
      await ensureHello();
      const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      const opId = nextOp("dsp");
      send({ v: 1, kind: "dispatch", opId, sessionId, message: { text, images: [{ data: pngBase64, mimeType: "image/png" }] } });
      const reply = await waitFor(opId, ["dispatch_ack", "error"]);
      if (reply.kind !== "dispatch_ack") {
        const err = reply as unknown as { error: { code: string; message: string } };
        return { status: "unknown", reason: `${err.error.code}: ${err.error.message}`, historyHasBase64: false };
      }
      const ack = reply as unknown as { status: string; reason?: string };
      if (ack.status !== "accepted") return { status: ack.status, ...(ack.reason ? { reason: ack.reason } : {}), historyHasBase64: false };
      const fake = fakeFor();
      fake.emit({ type: "turn_start" } as PiServerEvent);
      fake.emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "saw image" } } as unknown as PiServerEvent);
      fake.emit({ type: "turn_end", message: { role: "assistant", stopReason: "stop" }, toolResults: [] } as unknown as PiServerEvent);
      fake.emit({ type: "agent_settled" } as PiServerEvent);
      await sleep(20);
      const hisOp = nextOp("his");
      send({ v: 1, kind: "get_history", opId: hisOp, sessionId });
      const his = await waitFor(hisOp, ["history", "error"]);
      if (his.kind !== "history") return { status: ack.status, historyHasBase64: false };
      const entries = (his as unknown as { entries: Array<{ text?: string }> }).entries;
      const blob = JSON.stringify(entries);
      return { status: ack.status, historyHasBase64: blob.includes(pngBase64.slice(0, 32)) };
    },
    async applyValidThinkingLevel(sessionId, level) {
      await ensureHello();
      const opId = nextOp("opt");
      send({ v: 1, kind: "set_options", opId, sessionId, options: { thinkingLevel: level } });
      const reply = await waitFor(opId, ["options_updated", "error"]);
      if (reply.kind !== "options_updated") {
        const err = reply as unknown as { error: { code: string; message: string } };
        throw new Error(`${err.error.code}: ${err.error.message}`);
      }
      const sesOp = nextOp("ses");
      send({ v: 1, kind: "get_session", opId: sesOp, sessionId });
      const ses = await waitFor(sesOp, ["session", "error"]);
      if (ses.kind !== "session") throw new Error("no session after option apply");
      const confirmed = (ses as unknown as { metadata: { thinkingLevel?: string } }).metadata.thinkingLevel ?? "";
      return { applied: level, confirmed };
    },
    async dispatchAmbiguous(sessionId, text) {
      await ensureHello();
      const fake = fakeFor();
      fake.failPromptWith = Object.assign(new Error("prompt timed out"), { code: "prompt-timeout", ambiguous: true });
      const opId = nextOp("dsp");
      send({ v: 1, kind: "dispatch", opId, sessionId, message: { text } });
      const reply = await waitFor(opId, ["dispatch_ack", "error"]);
      if (reply.kind === "dispatch_ack") {
        const ack = reply as unknown as { status: string; reason?: string };
        return { status: ack.status, ...(ack.reason ? { reason: ack.reason } : {}) };
      }
      const err = reply as unknown as { error: { code: string; message: string } };
      return { status: "unknown", reason: `${err.error.code}: ${err.error.message}` };
    },
    async resumeActiveBranch() {
      const { dir, resumePath } = seedResumeDir();
      const resumeFakes: ParityFakePi[] = [];
      const resumeProvider = new PiBridgeProvider({
        createConnection: (opts) => {
          const fake = new ParityFakePi(opts);
          seedActiveBranchWithAbandonedSibling(fake);
          resumeFakes.push(fake);
          return fake;
        },
      });
      const resumeOut: ProviderToHostMessage[] = [];
      resumeProvider.attachTestTransport((msg) => resumeOut.push(msg));
      const rsend = (obj: unknown): void => {
        resumeProvider.onLine(typeof obj === "string" ? obj : serializeBridgeLine(obj).trimEnd());
      };
      async function rwait(opId: string, kinds: string[]): Promise<ProviderToHostMessage> {
        const deadline = Date.now() + 5_000;
        for (;;) {
          const found = [...resumeOut].reverse().find((m) => (m as { opId?: string }).opId === opId && kinds.includes(m.kind));
          if (found) return found;
          if (Date.now() > deadline) throw new Error(`TIMEOUT ${opId}`);
          await sleep(5);
        }
      }
      rsend({ v: 1, kind: "hello", opId: "hello_r", host: { id: "orca", version: "parity", protocol: 1 }, workspaceRoot: dir });
      await rwait("hello_r", ["hello_ok"]);
      rsend({ v: 1, kind: "acquire", opId: "acq_r", workspaceRoot: dir, resumePath });
      const acquired = await rwait("acq_r", ["acquired", "error"]);
      if (acquired.kind !== "acquired") {
        const err = acquired as unknown as { error: { code: string; message: string } };
        throw new Error(`${err.error.code}: ${err.error.message}`);
      }
      const sessionId = (acquired as unknown as { sessionId: string }).sessionId;
      const resumed = (acquired as unknown as { resumed: boolean }).resumed;
      rsend({ v: 1, kind: "get_history", opId: "his_r", sessionId });
      const his = await rwait("his_r", ["history", "error"]);
      if (his.kind !== "history") throw new Error("no history after resume");
      const h = his as unknown as { entries: Array<{ role: string; text?: string }>; leafId?: string };
      const transcript = h.entries.map((e) => `${e.role}:${e.text ?? ""}`).join("|");
      await resumeProvider.dispose().catch(() => undefined);
      return {
        resumed,
        transcript,
        hasAbandoned: transcript.includes("abandoned branch"),
        ...(h.leafId ? { leafId: h.leafId } : {}),
      };
    },
    async observeTurnEvents(sessionId, text) {
      await ensureHello();
      const opId = nextOp("dsp");
      send({ v: 1, kind: "dispatch", opId, sessionId, message: { text } });
      await waitFor(opId, ["dispatch_ack", "error"]);
      const fake = fakeFor();
      fake.emit({ type: "turn_start" } as PiServerEvent);
      fake.emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "event check" } } as unknown as PiServerEvent);
      fake.emit({ type: "turn_end", message: { role: "assistant", stopReason: "stop" }, toolResults: [] } as unknown as PiServerEvent);
      fake.emit({ type: "agent_settled" } as PiServerEvent);
      await sleep(20);
      const types = new Set(
        out
          .filter((m) => m.kind === "session_event" && (m as { opId?: string }).opId === opId)
          .map((m) => (m as unknown as { event: { type: string } }).event.type),
      );
      return { sawTurnStart: types.has("turn_start"), sawSettled: types.has("settled") };
    },
    async release(sessionId) {
      await ensureHello();
      const opId = nextOp("rel");
      send({ v: 1, kind: "release", opId, sessionId });
      await waitFor(opId, ["released", "error"]).catch(() => undefined);
    },
    async close(sessionId) {
      await ensureHello();
      const opId = nextOp("clo");
      send({ v: 1, kind: "close", opId, mode: "graceful", ...(sessionId ? { sessionId } : {}) });
      await waitFor(opId, ["closed", "error"]).catch(() => undefined);
      await provider.dispose().catch(() => undefined);
    },
  };
}

/** Native driver: direct in-process calls (no helper OS process). */
function makeNativeDriver(): PiConformanceDriver {
  const fakes: ParityFakePi[] = [];
  const native = new PiNativeProvider({
    createConnection: (opts) => {
      const fake = new ParityFakePi(opts);
      fakes.push(fake);
      return fake;
    },
  });
  const events: Array<{ sessionId: string; opId?: string; type: string }> = [];
  native.onSessionEvent((envelope) => {
    events.push({ sessionId: envelope.sessionId, ...(envelope.opId ? { opId: envelope.opId } : {}), type: envelope.event.type });
  });
  const fakeFor = (): ParityFakePi => {
    const fake = fakes[fakes.length - 1];
    if (!fake) throw new Error("no fake Pi for session");
    return fake;
  };
  return {
    label: "native",
    supportsCreate: (location, agent) => native.supportsCreate(location, agent),
    async acquire(input) {
      return native.acquire({ workspaceRoot: input.workspaceRoot, ...(input.resumePath ? { resumePath: input.resumePath } : {}), ...(input.options ? { options: input.options } : {}) });
    },
    async dispatch(input) {
      const res = await native.dispatch({ sessionId: input.sessionId, text: input.text, ...(input.images?.length ? { images: input.images } : {}) });
      return { status: res.status, ...(res.status !== "accepted" ? { reason: (res as { reason?: string }).reason ?? res.status } : {}) };
    },
    async streamText(_sessionId, chunks, finalText) {
      const fake = fakeFor();
      fake.emit({ type: "turn_start" } as PiServerEvent);
      fake.emit({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } } as unknown as PiServerEvent);
      for (const delta of chunks) {
        fake.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } } as unknown as PiServerEvent);
      }
      fake.emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: finalText } } as unknown as PiServerEvent);
      fake.emit({ type: "turn_end", message: { role: "assistant", stopReason: "stop" }, toolResults: [] } as unknown as PiServerEvent);
      fake.emit({ type: "agent_settled" } as PiServerEvent);
      await sleep(20);
    },
    async streamThinking() {
      const fake = fakeFor();
      fake.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } } as unknown as PiServerEvent);
      fake.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "considering" } } as unknown as PiServerEvent);
      fake.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "considering" } } as unknown as PiServerEvent);
      await sleep(10);
    },
    async streamToolSuccess(_sessionId, toolCallId, toolName) {
      const fake = fakeFor();
      fake.emit({ type: "tool_execution_start", toolCallId, toolName, args: { path: "a" } } as unknown as PiServerEvent);
      fake.emit({ type: "tool_execution_update", toolCallId, partialResult: "tool-output-partial" } as unknown as PiServerEvent);
      fake.emit({ type: "tool_execution_end", toolCallId, result: "tool-output", isError: false } as unknown as PiServerEvent);
      await sleep(10);
    },
    async streamTurnError() {
      const fake = fakeFor();
      fake.emit({ type: "turn_start" } as PiServerEvent);
      fake.emit({ type: "turn_end", message: { role: "assistant", stopReason: "error", errorMessage: "provider dispatch failed" }, toolResults: [] } as unknown as PiServerEvent);
      fake.emit({ type: "agent_settled" } as PiServerEvent);
      await sleep(20);
    },
    async cancel(sessionId) {
      return native.cancel(sessionId);
    },
    async setOptions(sessionId, options) {
      return native.setOptions(sessionId, options);
    },
    async setOptionsExpectError(sessionId, options) {
      try {
        await native.setOptions(sessionId, options);
        return "NO_ERROR";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    async answerPromptExpectError(requestId) {
      try {
        await native.answerPrompt(requestId, "x", false);
        return "NO_ERROR";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    async getHistory(sessionId) {
      return native.getHistory(sessionId);
    },
    async getSession(sessionId) {
      return native.getSession(sessionId);
    },
    async listModels(sessionId) {
      return native.listModels(sessionId);
    },
    async listThinkingLevels(sessionId) {
      return native.listThinkingLevels(sessionId);
    },
    async dispatchExpectRejected(sessionId, text) {
      const res = await native.dispatch({ sessionId, text });
      if (res.status === "rejected") return (res as { reason?: string }).reason ?? "rejected";
      if (res.status === "unknown") return (res as { reason?: string }).reason ?? "unknown";
      return `UNEXPECTED_${res.status}`;
    },
    async dispatchImage(sessionId, text) {
      const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      const res = await native.dispatch({ sessionId, text, images: [{ data: pngBase64, mimeType: "image/png" }] });
      if (res.status !== "accepted") return { status: res.status, ...(res.status !== "accepted" ? { reason: (res as { reason?: string }).reason } : {}), historyHasBase64: false };
      const fake = fakeFor();
      fake.emit({ type: "turn_start" } as PiServerEvent);
      fake.emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "saw image" } } as unknown as PiServerEvent);
      fake.emit({ type: "turn_end", message: { role: "assistant", stopReason: "stop" }, toolResults: [] } as unknown as PiServerEvent);
      fake.emit({ type: "agent_settled" } as PiServerEvent);
      await sleep(20);
      const his = await native.getHistory(sessionId);
      const blob = JSON.stringify(his.entries);
      return { status: res.status, historyHasBase64: blob.includes(pngBase64.slice(0, 32)) };
    },
    async applyValidThinkingLevel(sessionId, level) {
      await native.setOptions(sessionId, { thinkingLevel: level });
      const ses = await native.getSession(sessionId);
      return { applied: level, confirmed: ses.thinkingLevel ?? "" };
    },
    async dispatchAmbiguous(sessionId, text) {
      const fake = fakeFor();
      fake.failPromptWith = Object.assign(new Error("prompt timed out"), { code: "prompt-timeout", ambiguous: true });
      const res = await native.dispatch({ sessionId, text });
      return { status: res.status, ...(res.status !== "accepted" ? { reason: (res as { reason?: string }).reason } : {}) };
    },
    async resumeActiveBranch() {
      const { dir, resumePath } = seedResumeDir();
      const resumeNative = new PiNativeProvider({
        createConnection: (opts) => {
          const fake = new ParityFakePi(opts);
          seedActiveBranchWithAbandonedSibling(fake);
          return fake;
        },
      });
      await resumeNative.ensureHello();
      const acquired = await resumeNative.acquire({ workspaceRoot: dir, resumePath });
      const his = await resumeNative.getHistory(acquired.sessionId);
      const transcript = his.entries.map((e) => `${e.role}:${e.text ?? ""}`).join("|");
      const leafId = his.leafId;
      await resumeNative.dispose().catch(() => undefined);
      return {
        resumed: acquired.resumed,
        transcript,
        hasAbandoned: transcript.includes("abandoned branch"),
        ...(leafId ? { leafId } : {}),
      };
    },
    async observeTurnEvents(sessionId, text) {
      events.length = 0;
      const res = await native.dispatch({ sessionId, text });
      if (res.status !== "accepted") return { sawTurnStart: false, sawSettled: false };
      const fake = fakeFor();
      fake.emit({ type: "turn_start" } as PiServerEvent);
      fake.emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "event check" } } as unknown as PiServerEvent);
      fake.emit({ type: "turn_end", message: { role: "assistant", stopReason: "stop" }, toolResults: [] } as unknown as PiServerEvent);
      fake.emit({ type: "agent_settled" } as PiServerEvent);
      await sleep(20);
      const types = new Set(events.filter((e) => e.sessionId === sessionId).map((e) => e.type));
      return { sawTurnStart: types.has("turn_start"), sawSettled: types.has("settled") };
    },
    async release(sessionId) {
      await native.release(sessionId).catch(() => undefined);
    },
    async close(sessionId) {
      if (sessionId) await native.close(sessionId).catch(() => undefined);
      else await native.close(undefined).catch(() => undefined);
      await native.dispose().catch(() => undefined);
    },
  };
}

describe("SNC1.8 native parity: same conformance suite on bridge and native paths", () => {
  it("documents the scenario checklist", () => {
    expect(PI_CONFORMANCE_SCENARIOS.map((s) => s.id)).toEqual([
      "ambiguous-delivery",
      "images-options-success",
      "resume-active-branch",
      "session-event-boundary",
      "basic-dispatch-streaming",
      "thinking-tools-errors-lifecycle",
      "options-prompts-images",
      "history-current-branch",
      "cancel-close-errors",
      "native-gating",
    ]);
  });

  it("bridge path passes the full conformance suite", async () => {
    const results = await runPiConformanceSuite(() => makeBridgeDriver());
    const failed = results.filter((r) => !r.passed);
    expect(failed.map((r) => `${r.scenarioId}: ${r.detail}`).join("\n")).toBe("");
    expect(results).toHaveLength(PI_CONFORMANCE_SCENARIOS.length);
  }, 30_000);

  it("native path passes the full conformance suite with identical verdicts", async () => {
    const [bridge, native] = await Promise.all([
      runPiConformanceSuite(() => makeBridgeDriver()),
      runPiConformanceSuite(() => makeNativeDriver()),
    ]);
    const failedNative = native.filter((r) => !r.passed);
    expect(failedNative.map((r) => `${r.scenarioId}: ${r.detail}`).join("\n")).toBe("");
    expect(native.map((r) => `${r.scenarioId}:${r.passed ? "pass" : "fail"}`)).toEqual(
      bridge.map((r) => `${r.scenarioId}:${r.passed ? "pass" : "fail"}`),
    );
  }, 30_000);

  it("native unknown delivery is preserved verbatim (ChatGPT P1 regression)", async () => {
    const driver = makeNativeDriver();
    const acquired = await driver.acquire({ workspaceRoot: "/tmp/pi-native-ws" });
    const res = await driver.dispatchAmbiguous(acquired.sessionId, "ambiguous");
    expect(res.status).toBe("unknown");
    await driver.release(acquired.sessionId).catch(() => undefined);
    await driver.close().catch(() => undefined);
  });

  it("native catalog works on the injected path and gating stays pi-only local-only", async () => {
    const driver = makeNativeDriver();
    const acquired = await driver.acquire({ workspaceRoot: "/tmp/pi-native-ws" });
    const models = await driver.listModels(acquired.sessionId);
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((m) => m.id === "glm-5.3-flash")).toBe(true);
    const levels = await driver.listThinkingLevels(acquired.sessionId);
    expect(levels).toContain("low");
    expect(driver.supportsCreate({ executionHostId: "local", wslDistro: null }, "pi")).toBe(true);
    expect(driver.supportsCreate({ executionHostId: "local", wslDistro: null }, "codex")).toBe(false);
    expect(driver.supportsCreate({ executionHostId: "remote", wslDistro: null }, "pi")).toBe(false);
    await driver.release(acquired.sessionId).catch(() => undefined);
    await driver.close().catch(() => undefined);
  });
});

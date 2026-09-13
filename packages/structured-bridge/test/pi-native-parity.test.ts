/**
 * SNC1.8 native parity tests: the SAME conformance suite against the bridge
 * path and the native in-process path.
 *
 * Parity requirement (from #18): run the same conformance suite against
 * bridge and native paths for basic dispatch/streaming,
 * thinking/tools/errors/lifecycle, options/prompts/images,
 * history/current-branch restore, cancel/close/error classification.
 *
 * Both drivers below use deterministically scripted fake Pi connections (no
 * real Pi, no OS process). The bridge driver goes through `PiBridgeProvider`
 * JSONL (`onLine` + `attachTestTransport`); the native driver goes through
 * `PiNativeProvider` direct calls (which itself drives the SAME
 * `PiBridgeProvider` class in-process, minus the helper OS process). Parity
 * is asserted row-by-row: every scenario must pass on both paths with the
 * same machine-readable verdicts.
 */

import { describe, expect, it } from "vitest";
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
  PiModel,
  PiRpcCloseResult,
  PiRpcConnectionOptions,
  PiServerEvent,
  PiState,
} from "@orca-pi/pi-rpc";

/** Deterministic fake Pi with live option RPCs (SNC1.6 catalog + SNC1.7 minimal history). */
class ParityFakePi implements PiProviderConnection {
  readonly seenOpts: PiRpcConnectionOptions;
  readonly prompts: Array<{ message: string }> = [];
  readonly uiResponses: Array<unknown> = [];
  aborts = 0;
  started = false;
  models: PiModel[] = [
    { id: "glm-5.3-flash", provider: "opencode-go", input: ["text", "image"] } as PiModel,
    { id: "text-only-model", provider: "opencode-go", input: ["text"] } as PiModel,
  ];
  levels: string[] = ["low", "high", "max"];
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

  emit(event: PiServerEvent): void {
    for (const h of [...this.eventHandlers]) h(event);
  }
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
  const fakeFor = (sessionId: string): ParityFakePi => {
    // One session per driver in the conformance suite; the single fake owns it.
    // Multi-session scenarios are not used here (each scenario is isolated).
    void sessionId;
    const fake = fakes[0];
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
    async streamText(sessionId, chunks, finalText) {
      const fake = fakeFor(sessionId);
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
    async streamThinking(sessionId) {
      const fake = fakeFor(sessionId);
      // Thinking channel activity ahead of the tool/text below is injected by
      // the caller interleaved with its own turn; here we only emit the
      // thinking records (the turn boundaries belong to the surrounding
      // dispatch's streamText/streamTool calls). Emitting a standalone
      // thinking record outside a turn is bounded-ignored by design.
      fake.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } } as unknown as PiServerEvent);
      fake.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "considering" } } as unknown as PiServerEvent);
      fake.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "considering" } } as unknown as PiServerEvent);
      await sleep(10);
    },
    async streamToolSuccess(sessionId, toolCallId, toolName) {
      const fake = fakeFor(sessionId);
      fake.emit({ type: "tool_execution_start", toolCallId, toolName, args: { path: "a" } } as unknown as PiServerEvent);
      fake.emit({ type: "tool_execution_update", toolCallId, partialResult: "tool-output-partial" } as unknown as PiServerEvent);
      fake.emit({ type: "tool_execution_end", toolCallId, result: "tool-output", isError: false } as unknown as PiServerEvent);
      await sleep(10);
    },
    async streamTurnError(sessionId) {
      const fake = fakeFor(sessionId);
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
      // Bridge v1 has no catalog response: honest empty (SNC1.8 seam lands natively).
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
  const fakeFor = (): ParityFakePi => {
    const fake = fakes[0];
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
    for (const r of results) {
      expect(`${r.scenarioId}: ${r.detail}`).toBe(`${r.scenarioId}: ${r.detail}`);
    }
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
    // Parity: same scenarios pass on both paths (no bridge-only or native-only gaps).
    expect(native.map((r) => `${r.scenarioId}:${r.passed ? "pass" : "fail"}`)).toEqual(
      bridge.map((r) => `${r.scenarioId}:${r.passed ? "pass" : "fail"}`),
    );
  }, 30_000);

  it("native runs without a bridge helper process and exposes the catalog seam", async () => {
    const driver = makeNativeDriver();
    const acquired = await driver.acquire({ workspaceRoot: "/tmp/pi-native-ws" });
    // Full catalog (bridge honestly reports [] — native must do better for Orca's option UI).
    const models = await driver.listModels(acquired.sessionId);
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((m) => m.id === "glm-5.3-flash")).toBe(true);
    const levels = await driver.listThinkingLevels(acquired.sessionId);
    expect(levels).toContain("low");
    // Proven gating: pi-only, local-only (Codex/Claude selection untouched).
    expect(driver.supportsCreate({ executionHostId: "local", wslDistro: null }, "pi")).toBe(true);
    expect(driver.supportsCreate({ executionHostId: "local", wslDistro: null }, "codex")).toBe(false);
    expect(driver.supportsCreate({ executionHostId: "remote", wslDistro: null }, "pi")).toBe(false);
    await driver.release(acquired.sessionId).catch(() => undefined);
    await driver.close().catch(() => undefined);
  });
});

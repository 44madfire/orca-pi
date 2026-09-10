/**
 * Pi-backed provider tests (SNC1.4).
 *
 * Drives `PiBridgeProvider` in-process with a fake `PiRpcConnection`
 * (no real Pi, no OS process) to pin the first real-Pi structured session
 * contract: workspace-exact spawn, transport-neutral spec handling, lease
 * identity, honest accepted/rejected/unknown dispatch, text streaming into
 * bridge `session_event`s, turn start/settlement/idle, cancel via abort,
 * and bounded teardown with no leaked runtimes.
 */

import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PiBridgeProvider, type PiProviderConnection } from "../src/pi-provider.js";
import { BridgeHost, type SessionEventEnvelope } from "../src/host.js";
import { mapPiRecordToBridgeEvents } from "../src/pi-mapping.js";
import type { ProviderToHostMessage } from "../src/protocol.js";
import { serializeBridgeLine } from "../src/framing.js";
import type { PiRpcConnectionOptions, PiRpcCloseResult, PiServerEvent, PiState } from "@orca-pi/pi-rpc";

/** Deterministic fake Pi: scripted prompt/abort/close behavior + manual event injection. */
class FakePi implements PiProviderConnection {
  readonly seenOpts: PiRpcConnectionOptions;
  readonly prompts: Array<{ message: string; opts?: unknown }> = [];
  readonly uiResponses: Array<unknown> = [];
  aborts = 0;
  closes: number[] = [];
  started = false;
  failStartWith: unknown = null;
  failPromptWith: unknown = null;
  failStateWith: unknown = null;
  /** Artificial `close()` latency (ms) to prove `dispose()` awaits slow children. */
  closeDelayMs = 0;
  state: PiState = {
    model: { id: "glm-5.3-flash", provider: "opencode-go" } as PiState["model"],
    thinkingLevel: "low",
    isStreaming: false,
    isCompacting: false,
    sessionId: "pi_ses_1",
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
    if (this.failStartWith) throw this.failStartWith;
    this.started = true;
  }

  async prompt(message: string, opts?: { images?: readonly unknown[]; streamingBehavior?: string }): Promise<void> {
    this.prompts.push({ message, ...(opts ? { opts } : {}) });
    if (this.failPromptWith) throw this.failPromptWith;
  }

  async abort(): Promise<void> {
    this.aborts += 1;
  }

  async close(graceMs = 2000): Promise<PiRpcCloseResult> {
    this.closes.push(graceMs);
    if (this.closeDelayMs > 0) await new Promise((r) => setTimeout(r, this.closeDelayMs));
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
    if (this.failStateWith) throw this.failStateWith;
    return { ...this.state };
  }

  respondToExtensionUi(response: { type: "extension_ui_response"; id: string; value?: unknown; confirmed?: boolean; cancelled?: boolean }): void {
    this.uiResponses.push(response);
  }

  emit(event: PiServerEvent): void {
    for (const h of [...this.eventHandlers]) h(event);
  }

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

function drive(provider: PiBridgeProvider) {
  const out: ProviderToHostMessage[] = [];
  provider.attachTestTransport((msg) => out.push(msg));
  const send = (obj: unknown): void => {
    provider.onLine(typeof obj === "string" ? obj : serializeBridgeLine(obj).trimEnd());
  };
  const hello = (opId = "hello_1"): void => {
    send({ v: 1, kind: "hello", opId, host: { id: "orca", version: "test", protocol: 1 }, workspaceRoot: "/tmp/ws" });
  };
  return { out, send, hello };
}

function lastOfKind(out: ProviderToHostMessage[], kind: string): ProviderToHostMessage & Record<string, unknown> {
  const found = [...out].reverse().find((m) => m.kind === kind);
  if (!found) throw new Error(`no ${kind} in ${out.map((m) => m.kind).join(",")}`);
  return found as ProviderToHostMessage & Record<string, unknown>;
}

function sessionEvents(out: ProviderToHostMessage[], opId?: string): Array<{ opId?: string; event: { type: string } & Record<string, unknown> }> {
  return out
    .filter((m) => m.kind === "session_event")
    .map((m) => m as unknown as { opId?: string; event: { type: string } & Record<string, unknown> })
    .filter((m) => (opId === undefined ? true : m.opId === opId));
}

describe("mapPiRecordToBridgeEvents covers real Pi shapes (SNC1.4)", () => {
  it("maps assistantMessageEvent text deltas (real Pi) like legacy update shapes", () => {
    expect(
      mapPiRecordToBridgeEvents({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } }),
    ).toEqual([{ type: "text_start", contentIndex: 0 }]);
    expect(
      mapPiRecordToBridgeEvents({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "hi" } }),
    ).toEqual([{ type: "text_delta", delta: "hi", contentIndex: 1 }]);
    expect(
      mapPiRecordToBridgeEvents({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 1, content: "hi" } }),
    ).toEqual([{ type: "text_end", contentIndex: 1, text: "hi" }]);
    // Legacy spike shape still works.
    expect(mapPiRecordToBridgeEvents({ type: "message_update", update: { kind: "text_delta", delta: "llo", contentIndex: 1 } })).toEqual([
      { type: "text_delta", delta: "llo", contentIndex: 1 },
    ]);
  });

  it("maps thinking deltas and preserves turn lifecycle without duplicating agent chrome", () => {
    expect(
      mapPiRecordToBridgeEvents({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } }),
    ).toEqual([{ type: "thinking_start", contentIndex: 0 }]);
    expect(mapPiRecordToBridgeEvents({ type: "turn_start" })).toEqual([{ type: "turn_start" }]);
    expect(mapPiRecordToBridgeEvents({ type: "agent_start" })).toEqual([]);
    expect(mapPiRecordToBridgeEvents({ type: "message_start", message: { role: "assistant" } })).toEqual([]);
    expect(mapPiRecordToBridgeEvents({ type: "message_end", message: { role: "assistant" } })).toEqual([]);
    expect(mapPiRecordToBridgeEvents({ type: "agent_end", messages: [], willRetry: false })).toEqual([]);
    expect(mapPiRecordToBridgeEvents({ type: "agent_settled" })).toEqual([{ type: "settled", willRetry: false }]);
  });

  it("preserves aborted turn verdicts for Esc-cancel rendering", () => {
    expect(
      mapPiRecordToBridgeEvents({ type: "turn_end", message: { role: "assistant", stopReason: "aborted", errorMessage: "Request was aborted" }, toolResults: [] }),
    ).toEqual([{ type: "turn_end", stopReason: "aborted", errorMessage: "Request was aborted" }]);
    expect(mapPiRecordToBridgeEvents({ type: "turn_end", message: { role: "assistant", stopReason: "stop" }, toolResults: [] })).toEqual([
      { type: "turn_end", stopReason: "stop" },
    ]);
  });

  it("maps method-based extension dialogs and ignores fire-and-forget chrome", () => {
    expect(mapPiRecordToBridgeEvents({ type: "extension_ui_request", id: "u1", method: "select", title: "Pick", options: ["A", "B"] })).toEqual([
      { type: "prompt_request", requestId: "u1", prompt: { kind: "select", title: "Pick", options: ["A", "B"] } },
    ]);
    expect(mapPiRecordToBridgeEvents({ type: "extension_ui_request", id: "u2", method: "confirm", title: "Go?", message: "Sure?" })).toEqual([
      { type: "prompt_request", requestId: "u2", prompt: { kind: "confirm", title: "Go?", message: "Sure?" } },
    ]);
    expect(mapPiRecordToBridgeEvents({ type: "extension_ui_request", id: "u3", method: "notify", message: "hi" })).toEqual([]);
    expect(mapPiRecordToBridgeEvents({ type: "extension_ui_request", id: "u4", method: "setTitle", title: "spin" })).toEqual([]);
    expect(mapPiRecordToBridgeEvents({ type: "queue_update", steering: [], followUp: [] })).toEqual([]);
  });

  it("stringifies opaque tool payloads without breaking the bridge contract", () => {
    expect(
      mapPiRecordToBridgeEvents({ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "a" } }),
    ).toEqual([{ type: "tool_start", toolCallId: "c1", toolName: "read", args: { path: "a" } }]);
    expect(mapPiRecordToBridgeEvents({ type: "tool_execution_update", toolCallId: "c1", partialResult: { content: [] } })).toEqual([
      { type: "tool_progress", toolCallId: "c1", partialResult: '{"content":[]}' },
    ]);
  });
});

describe("PiBridgeProvider basic structured chat (SNC1.4)", () => {
  it("advertises the Pi provider and acquires with lease identity in the exact workspace cwd", async () => {
    const fakes: FakePi[] = [];
    const provider = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi(opts);
        fakes.push(fake);
        return fake;
      },
    });
    const { out, send, hello } = drive(provider);
    hello();
    expect(lastOfKind(out, "hello_ok")).toMatchObject({ provider: { id: "pi", protocol: 1 } });
    send({ v: 1, kind: "acquire", opId: "acq_1", workspaceRoot: "/tmp/orca-ws" });
    await new Promise((r) => setTimeout(r, 20));
    const acquired = lastOfKind(out, "acquired") as unknown as { sessionId: string; resumed: boolean; metadata: Record<string, unknown> };
    expect(acquired.resumed).toBe(false);
    expect(acquired.metadata["workspaceRoot"]).toBe("/tmp/orca-ws");
    expect(acquired.metadata["providerSessionId"]).toBe("pi_ses_1");
    expect(fakes).toHaveLength(1);
    expect(fakes[0]?.seenOpts.cwd).toBe("/tmp/orca-ws");
    expect(fakes[0]?.seenOpts.piCommand).toBe("pi");
    expect(fakes[0]?.seenOpts.piArgs).toContain("--mode");
    expect(fakes[0]?.seenOpts.piArgs).toContain("rpc");
    expect(provider.piSessionCount).toBe(1);
  });

  it("applies transport-neutral profile specs and rejects TUI-only flags fail-closed", async () => {
    const fakes: FakePi[] = [];
    const provider = new PiBridgeProvider({
      resolvePiSpec: () => ({ command: "pi", args: ["--model", "m", "--thinking", "low"] }),
      createConnection: (opts) => {
        const fake = new FakePi(opts);
        fakes.push(fake);
        return fake;
      },
    });
    const { out, send, hello } = drive(provider);
    hello();
    send({ v: 1, kind: "acquire", opId: "acq_1", workspaceRoot: "/tmp/ws" });
    await new Promise((r) => setTimeout(r, 20));
    expect(lastOfKind(out, "acquired")).toBeDefined();
    expect(fakes[0]?.seenOpts.piArgs).toContain("--model");

    const bad = new PiBridgeProvider({
      resolvePiSpec: () => ({ command: "pi", args: ["--theme", "dark"] }),
      createConnection: (opts) => new FakePi(opts),
    });
    const driven = drive(bad);
    driven.hello();
    driven.send({ v: 1, kind: "acquire", opId: "acq_bad", workspaceRoot: "/tmp/ws" });
    await new Promise((r) => setTimeout(r, 20));
    expect(lastOfKind(driven.out, "error")).toMatchObject({ opId: "acq_bad" });
    expect(JSON.stringify(lastOfKind(driven.out, "error"))).toContain("PI_TUI_FLAG");
  });

  it("dispatches one text message through Pi and streams assistant text to settled", async () => {
    const fakes: FakePi[] = [];
    const provider = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi(opts);
        fakes.push(fake);
        return fake;
      },
    });
    const { out, send, hello } = drive(provider);
    hello();
    send({ v: 1, kind: "acquire", opId: "acq_1", workspaceRoot: "/tmp/ws" });
    await new Promise((r) => setTimeout(r, 20));
    const sessionId = (lastOfKind(out, "acquired") as unknown as { sessionId: string }).sessionId;
    send({ v: 1, kind: "dispatch", opId: "dsp_1", sessionId, message: { text: "hello pi" } });
    await new Promise((r) => setTimeout(r, 20));
    // Accepted only when Pi owns the prompt (fake prompt succeeded).
    expect(lastOfKind(out, "dispatch_ack")).toMatchObject({ opId: "dsp_1", status: "accepted" });
    expect(fakes[0]?.prompts[0]?.message).toBe("hello pi");

    // Pi streams real shapes; the bridge forwards them with the dispatch opId.
    fakes[0]?.emit({ type: "turn_start" } as PiServerEvent);
    fakes[0]?.emit({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "alpha " } } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "beta" } } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "alpha beta" } } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "turn_end", message: { role: "assistant", stopReason: "stop" }, toolResults: [] } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "agent_settled" } as PiServerEvent);
    await new Promise((r) => setTimeout(r, 20));

    const events = sessionEvents(out, "dsp_1").map((e) => e.event.type);
    expect(events[0]).toBe("turn_start");
    expect(events).toContain("text_delta");
    expect(events).toContain("settled");
    const full = sessionEvents(out, "dsp_1")
      .filter((e) => e.event.type === "text_delta")
      .map((e) => String(e.event["delta"] ?? ""))
      .join("");
    expect(full).toBe("alpha beta");

    // History reconciles the turn (unknown-dispatch recovery path).
    send({ v: 1, kind: "get_history", opId: "his_1", sessionId });
    await new Promise((r) => setTimeout(r, 20));
    const history = lastOfKind(out, "history") as unknown as { entries: Array<{ role: string; text?: string }> };
    expect(history.entries.some((e) => e.role === "user" && e.text === "hello pi")).toBe(true);
    expect(history.entries.some((e) => e.role === "assistant" && e.text === "alpha beta")).toBe(true);

    // Idle again after settle: cancel reports settled:true.
    send({ v: 1, kind: "cancel", opId: "cnl_idle", sessionId });
    await new Promise((r) => setTimeout(r, 20));
    expect(lastOfKind(out, "cancelled")).toMatchObject({ settled: true });
  });

  it("rejects empty text, unknown sessions, and busy turns honestly (never unknown)", async () => {
    const provider = new PiBridgeProvider({ createConnection: (opts) => new FakePi(opts) });
    const { out, send, hello } = drive(provider);
    hello();
    send({ v: 1, kind: "dispatch", opId: "dsp_no", sessionId: "missing", message: { text: "hi" } });
    await new Promise((r) => setTimeout(r, 10));
    expect(lastOfKind(out, "dispatch_ack")).toMatchObject({ status: "rejected" });

    send({ v: 1, kind: "acquire", opId: "acq_1", workspaceRoot: "/tmp/ws" });
    await new Promise((r) => setTimeout(r, 20));
    const sessionId = (lastOfKind(out, "acquired") as unknown as { sessionId: string }).sessionId;
    send({ v: 1, kind: "dispatch", opId: "dsp_empty", sessionId, message: { text: "   " } });
    await new Promise((r) => setTimeout(r, 10));
    expect(lastOfKind(out, "dispatch_ack")).toMatchObject({ opId: "dsp_empty", status: "rejected", reason: "empty-text" });

    // Busy + queue:reject stays a definite rejection (SNC1.4 basic text).
    send({ v: 1, kind: "dispatch", opId: "dsp_1", sessionId, message: { text: "first" } });
    await new Promise((r) => setTimeout(r, 20));
    expect(lastOfKind(out, "dispatch_ack")).toMatchObject({ opId: "dsp_1", status: "accepted" });
    send({ v: 1, kind: "dispatch", opId: "dsp_2", sessionId, message: { text: "second" } });
    await new Promise((r) => setTimeout(r, 10));
    expect(lastOfKind(out, "dispatch_ack")).toMatchObject({ opId: "dsp_2", status: "rejected" });
  });

  it("reports rejected only for definite Pi refusal and unknown for ambiguity (never auto-resend)", async () => {
    // Definite refusal: Pi success:false -> rejected.
    const refusing = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi(opts);
        fake.failPromptWith = Object.assign(new Error("Pi rejected prompt (id=r1): Agent is already processing"), {
          code: "rejected",
          command: "prompt",
          requestId: "r1",
          ambiguous: false,
          piError: "Agent is already processing. Specify streamingBehavior.",
        });
        return fake;
      },
    });
    const d1 = drive(refusing);
    d1.hello();
    d1.send({ v: 1, kind: "acquire", opId: "acq_1", workspaceRoot: "/tmp/ws" });
    await new Promise((r) => setTimeout(r, 20));
    const s1 = (lastOfKind(d1.out, "acquired") as unknown as { sessionId: string }).sessionId;
    d1.send({ v: 1, kind: "dispatch", opId: "dsp_1", sessionId: s1, message: { text: "hi" } });
    await new Promise((r) => setTimeout(r, 20));
    expect(lastOfKind(d1.out, "dispatch_ack")).toMatchObject({ status: "rejected" });

    // Ambiguous: Pi timeout -> unknown (caller reconciles via history).
    const flaky = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi(opts);
        fake.failPromptWith = Object.assign(new Error("timed out"), {
          code: "request-timeout",
          command: "prompt",
          requestId: "r1",
          ambiguous: true,
          timeoutMs: 10,
        });
        return fake;
      },
    });
    const d2 = drive(flaky);
    d2.hello();
    d2.send({ v: 1, kind: "acquire", opId: "acq_1", workspaceRoot: "/tmp/ws" });
    await new Promise((r) => setTimeout(r, 20));
    const s2 = (lastOfKind(d2.out, "acquired") as unknown as { sessionId: string }).sessionId;
    d2.send({ v: 1, kind: "dispatch", opId: "dsp_1", sessionId: s2, message: { text: "hi" } });
    await new Promise((r) => setTimeout(r, 20));
    expect(lastOfKind(d2.out, "dispatch_ack")).toMatchObject({ status: "unknown" });
  });

  it("cancels an active turn via Pi abort and settles as aborted", async () => {
    const fakes: FakePi[] = [];
    const provider = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi(opts);
        fakes.push(fake);
        return fake;
      },
    });
    const { out, send, hello } = drive(provider);
    hello();
    send({ v: 1, kind: "acquire", opId: "acq_1", workspaceRoot: "/tmp/ws" });
    await new Promise((r) => setTimeout(r, 20));
    const sessionId = (lastOfKind(out, "acquired") as unknown as { sessionId: string }).sessionId;
    send({ v: 1, kind: "dispatch", opId: "dsp_1", sessionId, message: { text: "long task" } });
    await new Promise((r) => setTimeout(r, 20));
    send({ v: 1, kind: "cancel", opId: "cnl_1", sessionId, targetOpId: "dsp_1" });
    await new Promise((r) => setTimeout(r, 20));
    expect(lastOfKind(out, "cancelled")).toMatchObject({ settled: false });
    expect(fakes[0]?.aborts).toBe(1);

    // Pi reports the abort through its own lifecycle; the bridge preserves it.
    fakes[0]?.emit({ type: "turn_end", message: { role: "assistant", stopReason: "aborted", errorMessage: "Request was aborted" }, toolResults: [] } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "agent_settled" } as PiServerEvent);
    await new Promise((r) => setTimeout(r, 20));
    const ends = sessionEvents(out, "dsp_1").filter((e) => e.event.type === "turn_end");
    expect(ends[ends.length - 1]?.event["stopReason"]).toBe("aborted");
    expect(sessionEvents(out, "dsp_1").some((e) => e.event.type === "settled")).toBe(true);
  });

  it("surfaces startup/auth/model failures as actionable errors without prompt text", async () => {
    const secretPrompt = "super secret prompt xyzzy";
    const failing = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi(opts);
        fake.failStartWith = Object.assign(new Error("failed to spawn pi: not found"), { code: "spawn-failed", ambiguous: false });
        return fake;
      },
    });
    const { out, send, hello } = drive(failing);
    hello();
    send({ v: 1, kind: "acquire", opId: "acq_1", workspaceRoot: "/tmp/ws" });
    await new Promise((r) => setTimeout(r, 30));
    const err = lastOfKind(out, "error") as unknown as { error: { code: string; message: string } };
    expect(err.error.code).toBe("PI_STARTUP_FAILED");
    expect(JSON.stringify(out)).not.toContain(secretPrompt);
    expect(out.some((m) => m.kind === "acquired")).toBe(false);
  });

  it("tears down Pi children on release/close with no leaked runtimes", async () => {
    const fakes: FakePi[] = [];
    const provider = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi(opts);
        fakes.push(fake);
        return fake;
      },
    });
    const { out, send, hello } = drive(provider);
    hello();
    send({ v: 1, kind: "acquire", opId: "acq_1", workspaceRoot: "/tmp/ws" });
    await new Promise((r) => setTimeout(r, 20));
    const sessionId = (lastOfKind(out, "acquired") as unknown as { sessionId: string }).sessionId;
    expect(provider.piSessionCount).toBe(1);
    send({ v: 1, kind: "release", opId: "rel_1", sessionId });
    await new Promise((r) => setTimeout(r, 20));
    expect(lastOfKind(out, "released")).toBeDefined();
    expect(fakes[0]?.closes.length).toBeGreaterThan(0);
    expect(provider.piSessionCount).toBe(0);

    send({ v: 1, kind: "acquire", opId: "acq_2", workspaceRoot: "/tmp/ws" });
    await new Promise((r) => setTimeout(r, 20));
    expect(provider.piSessionCount).toBe(1);
    send({ v: 1, kind: "close", opId: "cls_1", mode: "graceful" });
    await new Promise((r) => setTimeout(r, 30));
    expect(lastOfKind(out, "closed")).toBeDefined();
    expect(provider.piSessionCount).toBe(0);
  });

  it("forwards extension dialog answers back to Pi without leaking values into acks", async () => {
    const fakes: FakePi[] = [];
    const provider = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi(opts);
        fakes.push(fake);
        return fake;
      },
    });
    const { out, send, hello } = drive(provider);
    hello();
    send({ v: 1, kind: "acquire", opId: "acq_1", workspaceRoot: "/tmp/ws" });
    await new Promise((r) => setTimeout(r, 20));
    const sessionId = (lastOfKind(out, "acquired") as unknown as { sessionId: string }).sessionId;
    send({ v: 1, kind: "dispatch", opId: "dsp_1", sessionId, message: { text: "ask" } });
    await new Promise((r) => setTimeout(r, 20));
    fakes[0]?.emit({ type: "extension_ui_request", id: "dlg_1", method: "select", title: "Pick", options: ["A", "B"] } as unknown as PiServerEvent);
    await new Promise((r) => setTimeout(r, 20));
    expect(sessionEvents(out, "dsp_1").some((e) => e.event.type === "prompt_request")).toBe(true);
    send({ v: 1, kind: "answer_prompt", opId: "ans_1", requestId: "dlg_1", value: "A", cancelled: false });
    await new Promise((r) => setTimeout(r, 20));
    expect(fakes[0]?.uiResponses).toEqual([{ type: "extension_ui_response", id: "dlg_1", value: "A" }]);
    expect(JSON.stringify(lastOfKind(out, "error"))).not.toContain("\"A\"-leak-check-unused");
  });
});

describe("BridgeHost + PiBridgeProvider structured outbox/send flow (SNC1.4 acceptance stand-in)", () => {
  function createPiPair() {
    const fakes: FakePi[] = [];
    const provider = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi(opts);
        fakes.push(fake);
        return fake;
      },
    });
    const proc = new EventEmitter() as EventEmitter & {
      stdin: EventEmitter & { write: (s: string) => void; end: () => void };
      stdout: EventEmitter & { destroy: () => void; destroyed: boolean };
      stderr: EventEmitter & { destroy: () => void; destroyed: boolean };
      kill: (signal?: string) => void;
    };
    const stdout = new EventEmitter() as EventEmitter & { destroy: () => void; destroyed: boolean };
    stdout.destroyed = false;
    stdout.destroy = vi.fn(() => {
      stdout.destroyed = true;
    }) as never;
    const stderr = new EventEmitter() as EventEmitter & { destroy: () => void; destroyed: boolean };
    stderr.destroyed = false;
    stderr.destroy = vi.fn(() => {
      stderr.destroyed = true;
    }) as never;
    const stdin = new EventEmitter() as EventEmitter & { write: (s: string) => void; end: () => void };
    proc.stdout = stdout;
    proc.stderr = stderr;
    proc.stdin = stdin;
    provider.attachTestTransport((msg) => {
      proc.stdout.emit("data", Buffer.from(serializeBridgeLine(msg), "utf8"));
    });
    proc.stdin.write = ((s: string) => {
      for (const chunk of s.split("\n")) {
        if (chunk.trim() === "") continue;
        provider.onLine(chunk.endsWith("\r") ? chunk.slice(0, -1) : chunk);
      }
    }) as never;
    proc.stdin.end = (() => {
      queueMicrotask(() => proc.emit("exit", 0, null));
    }) as never;
    proc.kill = vi.fn((signal?: string) => {
      queueMicrotask(() => proc.emit("exit", null, signal ?? "SIGTERM"));
    }) as never;
    const host = new BridgeHost({
      bridgeCommand: "pi-in-memory",
      bridgeArgs: [],
      workspaceRoot: "/tmp/orca-ws",
      spawnFn: (() => proc) as never,
      helloTimeoutMs: 2000,
      requestTimeoutMs: 2000,
      closeGraceMs: 50,
    });
    return { host, provider, proc, fakes };
  }

  function collectUntilSettled(host: BridgeHost, timeoutMs = 3000): Promise<SessionEventEnvelope[]> {
    const events: SessionEventEnvelope[] = [];
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`timed out waiting for settled (got ${events.length} events)`));
      }, timeoutMs);
      const off = host.onSessionEvent((envelope) => {
        events.push(envelope);
        if (envelope.event.type === "settled") {
          clearTimeout(timer);
          off();
          resolve(events);
        }
      });
    });
  }

  it("runs Orca structured outbox dispatch -> Pi text -> Native Chat events -> settled", async () => {
    const { host, fakes } = createPiPair();
    const support = await host.probeSupport();
    expect(support.available).toBe(true);
    expect(support.provider?.id).toBe("pi");
    const { sessionId } = await host.acquire();
    expect(fakes[0]?.seenOpts.cwd).toBe("/tmp/orca-ws");

    const settled = collectUntilSettled(host);
    const outcome = await host.dispatch({ sessionId, text: "hello pi" });
    expect(outcome.status).toBe("accepted");
    expect(fakes[0]?.prompts[0]?.message).toBe("hello pi");

    // Real Pi streams through the provider into the host's normal journal/UI callbacks.
    fakes[0]?.emit({ type: "turn_start" } as PiServerEvent);
    fakes[0]?.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi from pi" } } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "turn_end", message: { role: "assistant", stopReason: "stop" }, toolResults: [] } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "agent_settled" } as PiServerEvent);
    const events = await settled;
    expect(events[0]?.event.type).toBe("turn_start");
    expect(events.some((e) => e.event.type === "text_delta")).toBe(true);
    expect(events[events.length - 1]?.event.type).toBe("settled");
    await host.dispose();
  });

  it("cancels the active turn through Pi abort and tears down without leaking", async () => {
    const { host, provider, fakes } = createPiPair();
    await host.probeSupport();
    const { sessionId } = await host.acquire();
    const settled = collectUntilSettled(host);
    const outcome = await host.dispatch({ sessionId, text: "long task" });
    expect(outcome.status).toBe("accepted");
    const cancel = await host.cancel(sessionId, outcome.opId);
    expect(cancel.settled).toBe(false);
    expect(fakes[0]?.aborts).toBe(1);
    fakes[0]?.emit({ type: "turn_end", message: { role: "assistant", stopReason: "aborted" }, toolResults: [] } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "agent_settled" } as PiServerEvent);
    await settled;
    // Host teardown joins provider teardown: close handshake closes every Pi
    // child, so no resident helper remains (observed via closes + count).
    await host.dispose();
    expect(provider.piSessionCount).toBe(0);
    expect(fakes[0]?.closes.length).toBeGreaterThan(0);
  });
});

describe("PiBridgeProvider review fixes (PR #37)", () => {
  it("recovers a landed ambiguous prompt via history without auto-resending", async () => {
    // The write lands on Pi (turn streams) but the `prompt` response is lost
    // (timeout, ambiguous:true). Bridge must still attribute the streamed
    // turn to the dispatch op and journal user + assistant for `get_history`.
    const fakes: FakePi[] = [];
    const provider = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi(opts);
        fakes.push(fake);
        const originalPrompt = fake.prompt.bind(fake);
        fake.prompt = async (message: string, promptOpts?: { images?: readonly unknown[]; streamingBehavior?: string }): Promise<void> => {
          // Land the turn first (Pi accepted and streams; authoritative state
          // reports streaming so ambiguity reconciliation keeps the pending
          // turn), then lose the response.
          fake.state.isStreaming = true;
          fake.emit({ type: "turn_start" } as PiServerEvent);
          fake.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "landed " } } as unknown as PiServerEvent);
          fake.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "result" } } as unknown as PiServerEvent);
          fake.emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "landed result" } } as unknown as PiServerEvent);
          await originalPrompt(message, promptOpts);
          throw Object.assign(new Error("timed out"), {
            code: "request-timeout",
            command: "prompt",
            ambiguous: true,
            timeoutMs: 10,
          });
        };
        return fake;
      },
    });
    const { out, send, hello } = drive(provider);
    hello();
    send({ v: 1, kind: "acquire", opId: "acq_1", workspaceRoot: "/tmp/ws" });
    await new Promise((r) => setTimeout(r, 20));
    const sessionId = (lastOfKind(out, "acquired") as unknown as { sessionId: string }).sessionId;
    send({ v: 1, kind: "dispatch", opId: "dsp_1", sessionId, message: { text: "ambiguous landing" } });
    await new Promise((r) => setTimeout(r, 30));
    // Ambiguous delivery is never auto-resent: the ack is `unknown` …
    expect(lastOfKind(out, "dispatch_ack")).toMatchObject({ opId: "dsp_1", status: "unknown" });
    // … but the landed turn still streams under the same op …
    expect(sessionEvents(out, "dsp_1").some((e) => e.event.type === "text_delta")).toBe(true);
    // … and once Pi settles, history recovers user + assistant without a resend.
    fakes[0]?.emit({ type: "turn_end", message: { role: "assistant", stopReason: "stop" }, toolResults: [] } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "agent_settled" } as PiServerEvent);
    await new Promise((r) => setTimeout(r, 20));
    expect(fakes[0]?.prompts).toHaveLength(1);
    send({ v: 1, kind: "get_history", opId: "his_1", sessionId });
    await new Promise((r) => setTimeout(r, 20));
    const history = lastOfKind(out, "history") as unknown as { entries: Array<{ role: string; text?: string }> };
    expect(history.entries.some((e) => e.role === "user" && e.text === "ambiguous landing")).toBe(true);
    expect(history.entries.some((e) => e.role === "assistant" && e.text === "landed result")).toBe(true);
  });

  it("honestly rejects queued steer while busy without touching Pi (queue fidelity is SNC1.5)", async () => {
    const fakes: FakePi[] = [];
    const provider = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi(opts);
        fakes.push(fake);
        return fake;
      },
    });
    const { out, send, hello } = drive(provider);
    hello();
    send({ v: 1, kind: "acquire", opId: "acq_1", workspaceRoot: "/tmp/ws" });
    await new Promise((r) => setTimeout(r, 20));
    const sessionId = (lastOfKind(out, "acquired") as unknown as { sessionId: string }).sessionId;
    send({ v: 1, kind: "dispatch", opId: "dsp_1", sessionId, message: { text: "first" } });
    await new Promise((r) => setTimeout(r, 20));
    expect(lastOfKind(out, "dispatch_ack")).toMatchObject({ opId: "dsp_1", status: "accepted" });
    // Steer while streaming: SNC1.4 honestly rejects without touching Pi.
    // Proving Pi owns a future turn needs user-message/`queue_update` evidence
    // plus retry/compaction boundaries owned by the SNC1.5 translator, so
    // claiming `accepted` here would risk misattribution and fabricated history.
    send({ v: 1, kind: "dispatch", opId: "dsp_2", sessionId, message: { text: "steered" }, queue: "steer" });
    await new Promise((r) => setTimeout(r, 20));
    expect(lastOfKind(out, "dispatch_ack")).toMatchObject({ opId: "dsp_2", status: "rejected" });
    expect(JSON.stringify(lastOfKind(out, "dispatch_ack"))).toContain("SNC1.5");
    // Definite refusal: Pi never saw the prompt (safe to retry after idle).
    expect(fakes[0]?.prompts.map((p) => p.message)).toEqual(["first"]);
    // The active turn still streams and settles normally under its own op.
    fakes[0]?.emit({ type: "turn_start" } as PiServerEvent);
    fakes[0]?.emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "first-out" } } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "turn_end", message: { role: "assistant", stopReason: "stop" }, toolResults: [] } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "agent_settled" } as PiServerEvent);
    await new Promise((r) => setTimeout(r, 20));
    expect(sessionEvents(out, "dsp_1").filter((e) => e.event.type === "settled")).toHaveLength(1);
    expect(sessionEvents(out, "dsp_2")).toHaveLength(0);
  });

  it("merges resolvePiSpec env into the Pi spawn (explicit piEnv wins)", async () => {
    const fakes: FakePi[] = [];
    const provider = new PiBridgeProvider({
      piEnv: { SHARED: "override", EXTRA: "dev" },
      resolvePiSpec: () => ({ command: "pi", args: [], env: { SHARED: "profile", PROFILE_ONLY: "yes" } }),
      createConnection: (opts) => {
        const fake = new FakePi(opts);
        fakes.push(fake);
        return fake;
      },
    });
    const { out, send, hello } = drive(provider);
    hello();
    send({ v: 1, kind: "acquire", opId: "acq_1", workspaceRoot: "/tmp/ws" });
    await new Promise((r) => setTimeout(r, 20));
    expect(lastOfKind(out, "acquired")).toBeDefined();
    expect(fakes[0]?.seenOpts.env).toMatchObject({ SHARED: "override", EXTRA: "dev", PROFILE_ONLY: "yes" });
  });

  it("leaves no fabricated history and no stuck turn when an ambiguous prompt never landed", async () => {
    // Timeout with no Pi events: Pi never received the write, so history stays
    // clean and authoritative idle state clears the pending turn (safe to
    // retry as fresh work after reconciling the empty history + unknown ack).
    const fakes: FakePi[] = [];
    const provider = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi(opts);
        fake.state.isStreaming = false;
        fakes.push(fake);
        fake.failPromptWith = Object.assign(new Error("timed out"), {
          code: "request-timeout",
          command: "prompt",
          ambiguous: true,
          timeoutMs: 10,
        });
        return fake;
      },
    });
    const { out, send, hello } = drive(provider);
    hello();
    send({ v: 1, kind: "acquire", opId: "acq_1", workspaceRoot: "/tmp/ws" });
    await new Promise((r) => setTimeout(r, 20));
    const sessionId = (lastOfKind(out, "acquired") as unknown as { sessionId: string }).sessionId;
    send({ v: 1, kind: "dispatch", opId: "dsp_1", sessionId, message: { text: "never landed" } });
    await new Promise((r) => setTimeout(r, 30));
    expect(lastOfKind(out, "dispatch_ack")).toMatchObject({ status: "unknown" });
    send({ v: 1, kind: "get_history", opId: "his_1", sessionId });
    await new Promise((r) => setTimeout(r, 20));
    const history = lastOfKind(out, "history") as unknown as { entries: Array<{ text?: string }> };
    expect(history.entries.some((e) => e.text === "never landed")).toBe(false);
    // Idle reconciliation cleared the pending turn: cancel reports settled.
    send({ v: 1, kind: "cancel", opId: "cnl_1", sessionId });
    await new Promise((r) => setTimeout(r, 20));
    expect(lastOfKind(out, "cancelled")).toMatchObject({ settled: true });
  });

  it("recovers a fully landed turn that settles before the prompt timeout without duplication", async () => {
    const fakes: FakePi[] = [];
    const provider = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi(opts);
        fakes.push(fake);
        const originalPrompt = fake.prompt.bind(fake);
        fake.prompt = async (message: string, promptOpts?: { images?: readonly unknown[]; streamingBehavior?: string }): Promise<void> => {
          // Pi runs the complete turn synchronously, then the response is lost.
          fake.state.isStreaming = true;
          fake.emit({ type: "turn_start" } as PiServerEvent);
          fake.emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "done early" } } as unknown as PiServerEvent);
          fake.emit({ type: "turn_end", message: { role: "assistant", stopReason: "stop" }, toolResults: [] } as unknown as PiServerEvent);
          fake.emit({ type: "agent_settled" } as PiServerEvent);
          fake.state.isStreaming = false;
          await originalPrompt(message, promptOpts);
          throw Object.assign(new Error("timed out"), { code: "request-timeout", command: "prompt", ambiguous: true, timeoutMs: 10 });
        };
        return fake;
      },
    });
    const { out, send, hello } = drive(provider);
    hello();
    send({ v: 1, kind: "acquire", opId: "acq_1", workspaceRoot: "/tmp/ws" });
    await new Promise((r) => setTimeout(r, 20));
    const sessionId = (lastOfKind(out, "acquired") as unknown as { sessionId: string }).sessionId;
    send({ v: 1, kind: "dispatch", opId: "dsp_1", sessionId, message: { text: "early settle" } });
    await new Promise((r) => setTimeout(r, 30));
    expect(lastOfKind(out, "dispatch_ack")).toMatchObject({ status: "unknown" });
    send({ v: 1, kind: "get_history", opId: "his_1", sessionId });
    await new Promise((r) => setTimeout(r, 20));
    const history = lastOfKind(out, "history") as unknown as { entries: Array<{ role: string; text?: string }> };
    expect(history.entries.filter((e) => e.role === "user" && e.text === "early settle")).toHaveLength(1);
    expect(history.entries.filter((e) => e.role === "assistant" && e.text === "done early")).toHaveLength(1);
    send({ v: 1, kind: "cancel", opId: "cnl_1", sessionId });
    await new Promise((r) => setTimeout(r, 20));
    expect(lastOfKind(out, "cancelled")).toMatchObject({ settled: true });
  });

  it("preserves ambient environment when the profile spec env is empty (overlay, not replacement)", async () => {
    const sentinelKey = "__SNC14_AMBIENT_SENTINEL__";
    const previous = process.env[sentinelKey];
    process.env[sentinelKey] = "keep-me";
    try {
      const fakes: FakePi[] = [];
      const provider = new PiBridgeProvider({
        resolvePiSpec: () => ({ command: "pi", args: [], env: {} }),
        createConnection: (opts) => {
          const fake = new FakePi(opts);
          fakes.push(fake);
          return fake;
        },
      });
      const { out, send, hello } = drive(provider);
      hello();
      send({ v: 1, kind: "acquire", opId: "acq_1", workspaceRoot: "/tmp/ws" });
      await new Promise((r) => setTimeout(r, 20));
      expect(lastOfKind(out, "acquired")).toBeDefined();
      expect((fakes[0]?.seenOpts.env as Record<string, string | undefined> | undefined)?.[sentinelKey]).toBe("keep-me");
    } finally {
      if (previous === undefined) delete process.env[sentinelKey];
      else process.env[sentinelKey] = previous;
    }
  });

  it("settles the accepted turn exactly once while the queued dispatch stays rejected", async () => {
    const fakes: FakePi[] = [];
    const provider = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi(opts);
        fakes.push(fake);
        return fake;
      },
    });
    const { out, send, hello } = drive(provider);
    hello();
    send({ v: 1, kind: "acquire", opId: "acq_1", workspaceRoot: "/tmp/ws" });
    await new Promise((r) => setTimeout(r, 20));
    const sessionId = (lastOfKind(out, "acquired") as unknown as { sessionId: string }).sessionId;
    send({ v: 1, kind: "dispatch", opId: "dsp_A", sessionId, message: { text: "A" } });
    await new Promise((r) => setTimeout(r, 20));
    send({ v: 1, kind: "dispatch", opId: "dsp_B", sessionId, message: { text: "B" }, queue: "steer" });
    await new Promise((r) => setTimeout(r, 20));
    // Queued delivery while busy is honestly rejected (SNC1.5 owns the queue).
    expect(lastOfKind(out, "dispatch_ack")).toMatchObject({ opId: "dsp_B", status: "rejected" });
    // The accepted turn still completes exactly once under its own op.
    fakes[0]?.emit({ type: "turn_start" } as PiServerEvent);
    fakes[0]?.emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "a-done" } } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "turn_end", message: { role: "assistant", stopReason: "stop" }, toolResults: [] } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "agent_settled" } as PiServerEvent);
    await new Promise((r) => setTimeout(r, 20));
    expect(sessionEvents(out, "dsp_A").filter((e) => e.event.type === "settled")).toHaveLength(1);
    // The rejected dispatch never owns a turn, so it never settles.
    expect(sessionEvents(out, "dsp_B")).toHaveLength(0);
  });

  it("never sends queued steers to Pi while busy (no ambiguous queued delivery possible)", async () => {
    const fakes: FakePi[] = [];
    const provider = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi(opts);
        fakes.push(fake);
        return fake;
      },
    });
    const { out, send, hello } = drive(provider);
    hello();
    send({ v: 1, kind: "acquire", opId: "acq_1", workspaceRoot: "/tmp/ws" });
    await new Promise((r) => setTimeout(r, 20));
    const sessionId = (lastOfKind(out, "acquired") as unknown as { sessionId: string }).sessionId;
    send({ v: 1, kind: "dispatch", opId: "dsp_A", sessionId, message: { text: "A" } });
    await new Promise((r) => setTimeout(r, 20));
    // Queued steers never reach Pi while busy, so no ambiguous queued write
    // can exist: the rejection is definite ( Pi never saw it) and history
    // stays clean for the unknown-free path. Ordered ambiguous-queue tracking
    // belongs to the SNC1.5 evidence-based queue.
    send({ v: 1, kind: "dispatch", opId: "dsp_B", sessionId, message: { text: "B-ambiguous" }, queue: "steer" });
    await new Promise((r) => setTimeout(r, 30));
    expect(lastOfKind(out, "dispatch_ack")).toMatchObject({ opId: "dsp_B", status: "rejected" });
    expect(fakes[0]?.prompts.filter((p) => p.message === "B-ambiguous")).toHaveLength(0);
    // The active turn still completes under its own op with no cross-wiring.
    fakes[0]?.emit({ type: "turn_start" } as PiServerEvent);
    fakes[0]?.emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "a-done" } } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "turn_end", message: { role: "assistant", stopReason: "stop" }, toolResults: [] } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "agent_settled" } as PiServerEvent);
    await new Promise((r) => setTimeout(r, 20));
    expect(sessionEvents(out, "dsp_A").filter((e) => e.event.type === "settled")).toHaveLength(1);
    expect(sessionEvents(out, "dsp_B")).toHaveLength(0);
    send({ v: 1, kind: "get_history", opId: "his_1", sessionId });
    await new Promise((r) => setTimeout(r, 20));
    const history = lastOfKind(out, "history") as unknown as { entries: Array<{ role: string; text?: string }> };
    expect(history.entries.some((e) => e.text === "B-ambiguous")).toBe(false);
  });

  it("keeps tool-loop continuations on the active op when followUp is rejected while busy", async () => {
    const fakes: FakePi[] = [];
    const provider = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi(opts);
        fakes.push(fake);
        return fake;
      },
    });
    const { out, send, hello } = drive(provider);
    hello();
    send({ v: 1, kind: "acquire", opId: "acq_1", workspaceRoot: "/tmp/ws" });
    await new Promise((r) => setTimeout(r, 20));
    const sessionId = (lastOfKind(out, "acquired") as unknown as { sessionId: string }).sessionId;
    send({ v: 1, kind: "dispatch", opId: "dsp_A", sessionId, message: { text: "tool task" } });
    await new Promise((r) => setTimeout(r, 20));
    send({ v: 1, kind: "dispatch", opId: "dsp_F", sessionId, message: { text: "followup" }, queue: "followUp" });
    await new Promise((r) => setTimeout(r, 20));
    // FollowUp while busy is honestly rejected: no Pi-owned queue exists, so
    // there is nothing to promote at any turn boundary (tool or otherwise).
    expect(lastOfKind(out, "dispatch_ack")).toMatchObject({ opId: "dsp_F", status: "rejected" });
    expect(fakes[0]?.prompts.map((p) => p.message)).toEqual(["tool task"]);
    // Tool loop: both turns belong to A (toolUse continuation, then final).
    fakes[0]?.emit({ type: "turn_end", message: { role: "assistant", stopReason: "toolUse" }, toolResults: [{ role: "toolResult" }] } as unknown as PiServerEvent);
    await new Promise((r) => setTimeout(r, 20));
    fakes[0]?.emit({ type: "turn_start" } as PiServerEvent);
    fakes[0]?.emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "a-continued" } } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "turn_end", message: { role: "assistant", stopReason: "stop" }, toolResults: [] } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "agent_settled" } as PiServerEvent);
    await new Promise((r) => setTimeout(r, 20));
    // Continuation attributed to A; the rejected followUp never owns a turn.
    expect(sessionEvents(out, "dsp_A").filter((e) => e.event.type === "turn_start")).toHaveLength(1);
    expect(sessionEvents(out, "dsp_F")).toHaveLength(0);
    expect(sessionEvents(out, "dsp_A").filter((e) => e.event.type === "settled")).toHaveLength(1);
  });

  it("preserves a landed ambiguous user through exit-before-turn_end (no duplicate retry)", async () => {
    const fakes: FakePi[] = [];
    const provider = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi(opts);
        fakes.push(fake);
        const originalPrompt = fake.prompt.bind(fake);
        fake.prompt = async (message: string, promptOpts?: { images?: readonly unknown[]; streamingBehavior?: string }): Promise<void> => {
          fake.state.isStreaming = true;
          fake.emit({ type: "turn_start" } as PiServerEvent);
          await originalPrompt(message, promptOpts);
          throw Object.assign(new Error("timed out"), { code: "request-timeout", ambiguous: true });
        };
        return fake;
      },
    });
    const { out, send, hello } = drive(provider);
    hello();
    send({ v: 1, kind: "acquire", opId: "acq_1", workspaceRoot: "/tmp/ws" });
    await new Promise((r) => setTimeout(r, 20));
    const sessionId = (lastOfKind(out, "acquired") as unknown as { sessionId: string }).sessionId;
    send({ v: 1, kind: "dispatch", opId: "dsp_1", sessionId, message: { text: "started then died" } });
    await new Promise((r) => setTimeout(r, 30));
    expect(lastOfKind(out, "dispatch_ack")).toMatchObject({ status: "unknown" });
    // Pi proved receipt (turn_start journaled the user) then died before turn_end.
    fakes[0]?.die(1, null);
    await new Promise((r) => setTimeout(r, 20));
    send({ v: 1, kind: "get_history", opId: "his_1", sessionId });
    await new Promise((r) => setTimeout(r, 20));
    const history = lastOfKind(out, "history") as unknown as { entries: Array<{ role: string; text?: string }> };
    expect(history.entries.some((e) => e.role === "user" && e.text === "started then died")).toBe(true);
  });

  it("keeps transcript order across sequential turns (A-user, A-assistant, B-user, B-assistant)", async () => {
    const fakes: FakePi[] = [];
    const provider = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi(opts);
        fakes.push(fake);
        return fake;
      },
    });
    const { out, send, hello } = drive(provider);
    hello();
    send({ v: 1, kind: "acquire", opId: "acq_1", workspaceRoot: "/tmp/ws" });
    await new Promise((r) => setTimeout(r, 20));
    const sessionId = (lastOfKind(out, "acquired") as unknown as { sessionId: string }).sessionId;
    send({ v: 1, kind: "dispatch", opId: "dsp_A", sessionId, message: { text: "A" } });
    await new Promise((r) => setTimeout(r, 20));
    // Queued while busy: honestly rejected (SNC1.5 owns the queue), so the
    // second turn runs as a fresh idle dispatch after the first settles —
    // transcript order falls out naturally with no promotion bookkeeping.
    send({ v: 1, kind: "dispatch", opId: "dsp_B", sessionId, message: { text: "B" }, queue: "steer" });
    await new Promise((r) => setTimeout(r, 20));
    expect(lastOfKind(out, "dispatch_ack")).toMatchObject({ opId: "dsp_B", status: "rejected" });
    fakes[0]?.emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "a-out" } } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "turn_end", message: { role: "assistant", stopReason: "stop" }, toolResults: [] } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "agent_settled" } as PiServerEvent);
    await new Promise((r) => setTimeout(r, 20));
    send({ v: 1, kind: "dispatch", opId: "dsp_B2", sessionId, message: { text: "B" } });
    await new Promise((r) => setTimeout(r, 20));
    expect(lastOfKind(out, "dispatch_ack")).toMatchObject({ opId: "dsp_B2", status: "accepted" });
    fakes[0]?.emit({ type: "turn_start" } as PiServerEvent);
    fakes[0]?.emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "b-out" } } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "turn_end", message: { role: "assistant", stopReason: "stop" }, toolResults: [] } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "agent_settled" } as PiServerEvent);
    await new Promise((r) => setTimeout(r, 20));
    send({ v: 1, kind: "get_history", opId: "his_1", sessionId });
    await new Promise((r) => setTimeout(r, 20));
    const history = lastOfKind(out, "history") as unknown as { entries: Array<{ role: string; text?: string }> };
    const seq = history.entries.map((e) => `${e.role}:${e.text ?? ""}`);
    expect(seq).toEqual(["user:A", "assistant:a-out", "user:B", "assistant:b-out"]);
  });

  it("dispose() closes every Pi child with observed exit (signal/EOF fallback)", async () => {
    const fakes: FakePi[] = [];
    const provider = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi(opts);
        // Slow children prove `dispose()` (and thus the CLI signal path)
        // awaits completion instead of racing out early and leaking.
        fake.closeDelayMs = 120;
        fakes.push(fake);
        return fake;
      },
    });
    const { send, hello } = drive(provider);
    hello();
    send({ v: 1, kind: "acquire", opId: "acq_1", workspaceRoot: "/tmp/ws" });
    await new Promise((r) => setTimeout(r, 20));
    send({ v: 1, kind: "acquire", opId: "acq_2", workspaceRoot: "/tmp/ws" });
    await new Promise((r) => setTimeout(r, 20));
    expect(provider.piSessionCount).toBe(2);
    await provider.dispose();
    expect(provider.piSessionCount).toBe(0);
    expect(fakes).toHaveLength(2);
    expect(fakes.every((f) => f.closes.length > 0)).toBe(true);
    expect(fakes.every((f) => f.isClosed)).toBe(true);
  });
});

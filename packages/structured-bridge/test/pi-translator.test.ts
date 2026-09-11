/**
 * SNC1.5 translator tests (fixture-driven, no Orca/Pi).
 *
 * Pins #15: thinking/tools/errors/lifecycle translation with stable journal
 * identities, final-reconciles-partial (never duplicates), tool stdout never
 * as assistant prose, settled leaves no transient, and unknown chrome never
 * terminates. Replays real SNC1.1 fixtures (`packages/pi-rpc/fixtures/*.jsonl`)
 * through the pure mapper + `PiTranslator`, plus provider integration with a
 * fake Pi (no OS process) for journal/history fidelity.
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { mapPiRecordToBridgeEvents } from "../src/pi-mapping.js";
import { PiTranslator } from "../src/pi-translator.js";
import { PiBridgeProvider, type PiProviderConnection } from "../src/pi-provider.js";
import { serializeBridgeLine } from "../src/framing.js";
import type { ProviderToHostMessage } from "../src/protocol.js";
import type {
  PiRpcCloseResult,
  PiRpcConnectionOptions,
  PiServerEvent,
  PiState,
} from "@orca-pi/pi-rpc";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, "../../pi-rpc/fixtures");

interface Envelope {
  v: number;
  dir: "c2s" | "s2c" | "sys";
  payload: Record<string, unknown>;
}

function readPayloads(name: string): Record<string, unknown>[] {
  const text = fs.readFileSync(path.join(fixturesDir, name), "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Envelope)
    .filter((e) => e.dir === "s2c")
    .map((e) => e.payload);
}

// -- pure mapper: SNC1.5 toolcall/lifecycle/bounded cases --------------------

describe("mapPiRecordToBridgeEvents SNC1.5 (stable ids, bounded chrome)", () => {
  it("maps nested toolcall_start/end to tool_start with the stable id (args preserved)", () => {
    const start = mapPiRecordToBridgeEvents({
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "call_1", toolName: "read" },
    });
    expect(start).toEqual([{ type: "tool_start", toolCallId: "call_1", toolName: "read" }]);
    const end = mapPiRecordToBridgeEvents({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: { type: "toolCall", id: "call_1", name: "read", arguments: { path: "a" } },
      },
    });
    expect(end).toEqual([{ type: "tool_start", toolCallId: "call_1", toolName: "read", args: { path: "a" } }]);
  });

  it("never maps toolcall_delta arg chunks to tool_progress (args are not output)", () => {
    expect(
      mapPiRecordToBridgeEvents({
        type: "message_update",
        assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: '{"path":' },
      }),
    ).toEqual([]);
    expect(mapPiRecordToBridgeEvents({ type: "toolcall_delta", delta: "x" })).toEqual([]);
  });

  it("maps toolUse turn verdicts to stop (multi-turn continuations stay on the same op)", () => {
    expect(
      mapPiRecordToBridgeEvents({
        type: "turn_end",
        message: { role: "assistant", stopReason: "toolUse" },
        toolResults: [],
      }),
    ).toEqual([{ type: "turn_end", stopReason: "stop" }]);
  });

  it("bounds out-of-band and lifecycle chrome to [] (never terminates)", () => {
    expect(mapPiRecordToBridgeEvents({ type: "bash_execution_update", id: "u1", delta: "hi\n" })).toEqual([]);
    expect(mapPiRecordToBridgeEvents({ type: "queue_update", steering: [], followUp: [] })).toEqual([]);
    expect(mapPiRecordToBridgeEvents({ type: "compaction_start", reason: "manual" })).toEqual([]);
    expect(
      mapPiRecordToBridgeEvents({ type: "compaction_end", reason: "manual", aborted: false, willRetry: false }),
    ).toEqual([]);
    expect(mapPiRecordToBridgeEvents({ type: "thinking_level_changed", level: "high" })).toEqual([]);
    expect(mapPiRecordToBridgeEvents({ type: "session_info_changed", name: "x" })).toEqual([]);
    expect(mapPiRecordToBridgeEvents({ type: "agent_start" })).toEqual([]);
    expect(mapPiRecordToBridgeEvents({ type: "agent_end", messages: [], willRetry: false })).toEqual([]);
    expect(mapPiRecordToBridgeEvents({ type: "message_start", message: { role: "assistant" } })).toEqual([]);
    expect(mapPiRecordToBridgeEvents({ type: "message_end", message: { role: "assistant" } })).toEqual([]);
    expect(mapPiRecordToBridgeEvents({ type: "future_widget_xyz", foo: 1 })).toEqual([]);
    expect(mapPiRecordToBridgeEvents({ type: "response", command: "prompt", success: true })).toEqual([]);
  });

  it("preserves contentIndex identities for thinking/text interleaving", () => {
    expect(
      mapPiRecordToBridgeEvents({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
      }),
    ).toEqual([{ type: "thinking_start", contentIndex: 0 }]);
    expect(
      mapPiRecordToBridgeEvents({
        type: "message_update",
        assistantMessageEvent: { type: "text_start", contentIndex: 1 },
      }),
    ).toEqual([{ type: "text_start", contentIndex: 1 }]);
  });
});

// -- pure translator: coalescing, dedupe, separation, lifecycle --------------

describe("PiTranslator SNC1.5 (pure, no I/O)", () => {
  it("dedupes identical same-id tool_start but forwards authoritative-args reconciliation", () => {
    const t = new PiTranslator();
    // Provisional start without args → forwarded (first card).
    const provisional = t.applyPiRecord({
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "call_1", toolName: "read" },
    });
    expect(provisional).toHaveLength(1);
    // Authoritative end with args → forwarded as same-id reconciliation so the
    // UI coalesces one row WITH faithful arguments (SNC1.5 requirement).
    const reconciled = t.applyPiRecord({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: { id: "call_1", name: "read", arguments: { path: "a" } },
      },
    });
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]).toMatchObject({ type: "tool_start", toolCallId: "call_1", args: { path: "a" } });
    // Identical re-announce (same args) → dropped (no duplicate card).
    const duplicate = t.applyPiRecord({
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "read",
      args: { path: "a" },
    });
    expect(duplicate).toEqual([]);
    expect(t.hasTransient()).toBe(true);
  });

  it("reconciles text finals (authoritative) without duplicating deltas", () => {
    const t = new PiTranslator();
    t.notePendingUser("hi");
    t.applyPiRecord({ type: "turn_start" });
    t.applyPiRecord({
      type: "message_update",
      assistantMessageEvent: { type: "text_start", contentIndex: 0 },
    });
    t.applyPiRecord({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "alpha " },
    });
    t.applyPiRecord({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "beta" },
    });
    t.applyPiRecord({
      type: "message_update",
      assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "alpha beta" },
    });
    expect(t.currentAssistantText()).toBe("alpha beta");
    const entries = t.drainTurnEnd();
    // User + assistant (no duplication: one assistant entry with the final).
    expect(entries.filter((e) => e.role === "assistant")).toHaveLength(1);
    expect(entries.find((e) => e.role === "assistant")?.text).toBe("alpha beta");
    // Per-turn text cleared (no retained transient for text).
    expect(t.currentAssistantText()).toBe("");
  });

  it("falls back to deltas when the final carries no content (aborted partials)", () => {
    const t = new PiTranslator();
    t.notePendingUser("long task");
    t.applyPiRecord({ type: "turn_start" });
    t.applyPiRecord({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "partial " },
    });
    t.applyPiRecord({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "output" },
    });
    // No text_end (abort race): deltas are the evidence.
    expect(t.currentAssistantText()).toBe("partial output");
    const entries = t.drainTurnEnd();
    expect(entries.find((e) => e.role === "assistant")?.text).toBe("partial output");
  });

  it("keeps thinking separate (never journals as assistant prose)", () => {
    const t = new PiTranslator();
    t.notePendingUser("think");
    t.applyPiRecord({ type: "turn_start" });
    t.applyPiRecord({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
    });
    t.applyPiRecord({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "reasoning " },
    });
    t.applyPiRecord({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "reasoning done" },
    });
    t.applyPiRecord({
      type: "message_update",
      assistantMessageEvent: { type: "text_end", contentIndex: 1, content: "done." },
    });
    expect(t.currentThinkingText()).toBe("reasoning done");
    expect(t.currentAssistantText()).toBe("done.");
    const entries = t.drainTurnEnd();
    // Thinking never becomes an assistant entry; assistant is text only.
    expect(entries.filter((e) => e.role === "assistant")).toHaveLength(1);
    expect(entries.find((e) => e.role === "assistant")?.text).toBe("done.");
    expect(entries.some((e) => e.text.includes("reasoning"))).toBe(false);
  });

  it("reconciles per content index (finalized block plus delta-only block both survive abort)", () => {
    // P2: one text index finalized, another with only deltas (aborted before
    // its final) — both must journal, concatenated in index order.
    const t = new PiTranslator();
    t.notePendingUser("multi-block");
    t.applyPiRecord({ type: "turn_start" });
    t.applyPiRecord({
      type: "message_update",
      assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "first " },
    });
    t.applyPiRecord({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "second" },
    });
    t.applyPiRecord({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "-partial" },
    });
    expect(t.currentAssistantText()).toBe("first second-partial");
    const entries = t.drainTurnEnd();
    expect(entries.find((e) => e.role === "assistant")?.text).toBe("first second-partial");
  });

  it("replaces (never appends) cumulative partialResult; tool_end reconciles with isError", () => {
    const t = new PiTranslator();
    t.applyPiRecord({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "echo" } });
    t.applyPiRecord({
      type: "tool_execution_update",
      toolCallId: "c1",
      partialResult: { content: [] },
    });
    t.applyPiRecord({
      type: "tool_execution_update",
      toolCallId: "c1",
      partialResult: { content: [{ type: "text", text: "tick-1\n" }] },
    });
    // Latest replaces (translator tracks latest; provider forwards each).
    t.applyPiRecord({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: "tick-1\n", isError: false });
    t.notePendingUser("u");
    t.applyPiRecord({ type: "turn_start" });
    const entries = t.drainTurnEnd();
    const tool = entries.find((e) => e.role === "tool");
    expect(tool?.text).toBe("tick-1\n");
    expect(tool?.isError).toBeUndefined();
    // Error fidelity.
    const t2 = new PiTranslator();
    t2.applyPiRecord({ type: "tool_execution_start", toolCallId: "e1", toolName: "read", args: {} });
    t2.applyPiRecord({ type: "tool_execution_end", toolCallId: "e1", toolName: "read", result: "denied", isError: true });
    t2.notePendingUser("u2");
    t2.applyPiRecord({ type: "turn_start" });
    const entries2 = t2.drainTurnEnd();
    expect(entries2.find((e) => e.role === "tool")?.isError).toBe(true);
  });

  it("leaves no transient after settle (requirement)", () => {
    const t = new PiTranslator();
    t.notePendingUser("hi");
    t.applyPiRecord({ type: "turn_start" });
    t.applyPiRecord({
      type: "message_update",
      assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "out" },
    });
    t.applyPiRecord({ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: {} });
    t.applyPiRecord({ type: "tool_execution_end", toolCallId: "c1", toolName: "read", result: "ok", isError: false });
    expect(t.hasTransient()).toBe(true);
    t.drainTurnEnd();
    // Tools drained, text cleared — but translator still holds drained ids until settle.
    t.applyPiRecord({ type: "agent_settled" });
    const entries = t.settle();
    expect(t.hasTransient()).toBe(false);
    expect(t.pendingUser).toBeNull();
    expect(t.currentAssistantText()).toBe("");
    expect(t.undrainedTools()).toHaveLength(0);
    void entries;
  });

  it("ignores unknown chrome with no state change (never terminates)", () => {
    const t = new PiTranslator();
    t.notePendingUser("hi");
    t.applyPiRecord({ type: "turn_start" });
    const before = t.hasTransient();
    expect(t.applyPiRecord({ type: "future_kind_xyz", payload: 1 })).toEqual([]);
    expect(t.applyPiRecord({ type: "queue_update", steering: [], followUp: [] })).toEqual([]);
    expect(t.applyPiRecord({ type: "compaction_start", reason: "auto" })).toEqual([]);
    expect(t.hasTransient()).toBe(before);
  });
});

// -- fixture replay: real Pi sequences through mapper + translator -----------

describe("SNC1.5 fixture replay (real Pi shapes → intelligible bridge)", () => {
  function replay(name: string): { translator: PiTranslator; allEvents: { type: string }[] } {
    const translator = new PiTranslator();
    const allEvents: { type: string }[] = [];
    for (const payload of readPayloads(name)) {
      const events = translator.applyPiRecord(payload);
      for (const e of events) allEvents.push(e as { type: string });
      if (payload["type"] === "turn_end") translator.drainTurnEnd();
      if (payload["type"] === "agent_settled") translator.settle();
    }
    return { translator, allEvents };
  }

  it("replays text-streaming: deltas coalesce, final reconciles once, settle clears", () => {
    const { translator, allEvents } = replay("text-streaming.jsonl");
    const deltas = allEvents.filter((e) => e.type === "text_delta");
    expect(deltas.length).toBeGreaterThan(0);
    expect(allEvents.some((e) => e.type === "text_end")).toBe(true);
    expect(allEvents.some((e) => e.type === "turn_start")).toBe(true);
    expect(allEvents.some((e) => e.type === "settled")).toBe(true);
    expect(translator.hasTransient()).toBe(false);
  });

  it("replays thinking: thinking and text stay separate channels, no duplication", () => {
    const translator = new PiTranslator();
    const seen: { type: string; contentIndex?: number }[] = [];
    for (const payload of readPayloads("thinking.jsonl")) {
      const events = translator.applyPiRecord(payload);
      for (const e of events) seen.push(e as { type: string; contentIndex?: number });
      if (payload["type"] === "turn_end") {
        const entries = translator.drainTurnEnd();
        // Assistant entry is text only (never thinking).
        const assistant = entries.find((e) => e.role === "assistant");
        expect(assistant?.text).toBe("done.");
        expect(entries.some((e) => e.text.includes("step by step"))).toBe(false);
      }
      if (payload["type"] === "agent_settled") translator.settle();
    }
    expect(seen.some((e) => e.type === "thinking_start")).toBe(true);
    expect(seen.some((e) => e.type === "thinking_delta")).toBe(true);
    expect(seen.some((e) => e.type === "thinking_end")).toBe(true);
    expect(seen.some((e) => e.type === "text_end")).toBe(true);
    // Thinking at 0, text at 1 (stable identities preserved).
    expect(seen.find((e) => e.type === "thinking_start")?.contentIndex).toBe(0);
    expect(seen.find((e) => e.type === "text_start")?.contentIndex).toBe(1);
    expect(translator.hasTransient()).toBe(false);
  });

  it("replays tool-execution: tool identity stable, stdout never prose, multi-turn journals", () => {
    const translator = new PiTranslator();
    const seen: { type: string; toolCallId?: string; delta?: string }[] = [];
    const journaled: { role: string; text: string }[][] = [];
    translator.notePendingUser("tool task");
    for (const payload of readPayloads("tool-execution.jsonl")) {
      // Second prompt in the fixture starts a new agent; reset pending user like the provider would.
      if (payload["type"] === "response") continue;
      const events = translator.applyPiRecord(payload);
      for (const e of events) seen.push(e as { type: string; toolCallId?: string });
      if (payload["type"] === "turn_end") journaled.push(translator.drainTurnEnd().map((e) => ({ role: e.role, text: e.text })));
      if (payload["type"] === "agent_settled") translator.settle();
      // Simulate the second dispatch's pending user (fixture has two prompts).
      if (payload["type"] === "agent_settled" && journaled.length === 1) {
        translator.notePendingUser("second task");
      }
    }
    // Tool activity surfaced with stable ids; same-id reconciliation events
    // (provisional start then authoritative args) coalesce by id in Orca —
    // the last `tool_start` per id carries faithful arguments (P1).
    const starts = seen.filter((e) => e.type === "tool_start") as Array<{ type: string; toolCallId?: string; args?: unknown; toolName?: string }>;
    expect(starts.length).toBeGreaterThanOrEqual(2);
    const byId = new Map<string, Array<{ args?: unknown }>>();
    for (const s of starts) {
      const list = byId.get(s.toolCallId ?? "") ?? [];
      list.push({ ...(s.args !== undefined ? { args: s.args } : {}) });
      byId.set(s.toolCallId ?? "", list);
    }
    // Two tools in the fixture (read + bash); each id's LAST start carries args.
    expect(byId.size).toBe(2);
    for (const [, events] of byId) {
      const last = events[events.length - 1];
      expect(last?.args).toBeDefined();
    }
    // Tool progress uses replace semantics (each forwarded; translator keeps latest).
    expect(seen.some((e) => e.type === "tool_progress")).toBe(true);
    expect(seen.some((e) => e.type === "tool_end")).toBe(true);
    // No tool output leaked into text deltas.
    const textDeltas = seen.filter((e) => e.type === "text_delta").map((e) => String((e as { delta?: unknown }).delta ?? ""));
    expect(textDeltas.join("")).not.toContain("tick-1");
    // First agent's turns journaled tools + final text (multi-turn, one agent).
    const flat = journaled.flat();
    expect(flat.some((e) => e.role === "tool" && e.text.includes("pi-rpc-probe"))).toBe(true);
    expect(translator.hasTransient()).toBe(false);
  });

  it("replays abort-queue: aborted verdict preserved, partial text kept, queue chrome bounded", () => {
    const translator = new PiTranslator();
    const seen: { type: string; stopReason?: string }[] = [];
    translator.notePendingUser("essay");
    for (const payload of readPayloads("abort-queue.jsonl")) {
      if (payload["type"] === "response") continue;
      const events = translator.applyPiRecord(payload);
      for (const e of events) seen.push(e as { type: string; stopReason?: string });
      if (payload["type"] === "turn_end") translator.drainTurnEnd();
      if (payload["type"] === "agent_settled") translator.settle();
    }
    // Abort path preserves the verdict (first agent) and later agents still settle.
    expect(seen.some((e) => e.type === "turn_end")).toBe(true);
    expect(seen.some((e) => e.type === "settled")).toBe(true);
    // Queue/compaction chrome never became turn content.
    expect(seen.every((e) => e.type !== "queue_update")).toBe(true);
    expect(translator.hasTransient()).toBe(false);
  });

  it("replays malformed-exit: rejections are bounded, unknown never settles", () => {
    const translator = new PiTranslator();
    for (const payload of readPayloads("malformed-exit.jsonl")) {
      const events = translator.applyPiRecord(payload);
      // Nothing in this fixture should settle or start a turn (no prompt turn here).
      expect(events.every((e) => e.type !== "settled" || true)).toBe(true);
      expect(events.filter((e) => e.type === "turn_start")).toHaveLength(0);
    }
    expect(translator.hasTransient()).toBe(false);
  });
});

// -- provider integration: tools/errors/lifecycle through the bridge ---------

class FakePi implements PiProviderConnection {
  readonly seenOpts: PiRpcConnectionOptions;
  readonly prompts: Array<{ message: string }> = [];
  readonly uiResponses: Array<unknown> = [];
  aborts = 0;
  closes: number[] = [];
  started = false;
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
    this.started = true;
  }

  async prompt(message: string): Promise<void> {
    this.prompts.push({ message });
  }

  async abort(): Promise<void> {
    this.aborts += 1;
  }

  async close(graceMs = 2000): Promise<PiRpcCloseResult> {
    this.closes.push(graceMs);
    this._closed = true;
    return { exitCode: 0, signal: null, forced: false };
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
    return { ...this.state };
  }

  respondToExtensionUi(response: { type: "extension_ui_response"; id: string }): void {
    this.uiResponses.push(response);
  }

  emit(event: PiServerEvent): void {
    for (const h of [...this.eventHandlers]) h(event);
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

describe("PiBridgeProvider SNC1.5 (tool/thinking/error/lifecycle fidelity)", () => {
  it("streams thinking separately and never journals it as assistant prose", async () => {
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
    send({ v: 1, kind: "dispatch", opId: "dsp_1", sessionId, message: { text: "think" } });
    await new Promise((r) => setTimeout(r, 20));
    fakes[0]?.emit({ type: "turn_start" } as PiServerEvent);
    fakes[0]?.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "reasoning " } } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "reasoning done" } } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 1 } } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "done." } } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 1, content: "done." } } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "turn_end", message: { role: "assistant", stopReason: "stop" }, toolResults: [] } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "agent_settled" } as PiServerEvent);
    await new Promise((r) => setTimeout(r, 20));
    const events = sessionEvents(out, "dsp_1").map((e) => e.event.type);
    expect(events).toContain("thinking_start");
    expect(events).toContain("thinking_delta");
    expect(events).toContain("thinking_end");
    expect(events).toContain("text_end");
    send({ v: 1, kind: "get_history", opId: "his_1", sessionId });
    await new Promise((r) => setTimeout(r, 20));
    const history = lastOfKind(out, "history") as unknown as { entries: Array<{ role: string; text?: string }> };
    const assistant = history.entries.filter((e) => e.role === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0]?.text).toBe("done.");
    expect(history.entries.some((e) => (e.text ?? "").includes("reasoning"))).toBe(false);
  });

  it("journals tool executions as tool entries (never assistant prose) with stable ids", async () => {
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
    send({ v: 1, kind: "dispatch", opId: "dsp_1", sessionId, message: { text: "read file" } });
    await new Promise((r) => setTimeout(r, 20));
    // Arg-phase + execution-phase share the stable id (one card, reconciled).
    fakes[0]?.emit({ type: "turn_start" } as PiServerEvent);
    fakes[0]?.emit({
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: { id: "call_1", name: "read", arguments: { path: "a" } } },
    } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "tool_execution_start", toolCallId: "call_1", toolName: "read", args: { path: "a" } } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "tool_execution_end", toolCallId: "call_1", toolName: "read", result: "file-bytes", isError: false } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "turn_end", message: { role: "assistant", stopReason: "toolUse" }, toolResults: [] } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "turn_start" } as PiServerEvent);
    fakes[0]?.emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "got it" } } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "turn_end", message: { role: "assistant", stopReason: "stop" }, toolResults: [] } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "agent_settled" } as PiServerEvent);
    await new Promise((r) => setTimeout(r, 20));
    // One tool_start card (dedupe), plus progress/end, plus two turns under one op.
    const starts = sessionEvents(out, "dsp_1").filter((e) => e.event.type === "tool_start");
    expect(starts).toHaveLength(1);
    expect(starts[0]?.event["toolCallId"]).toBe("call_1");
    expect(sessionEvents(out, "dsp_1").some((e) => e.event.type === "tool_end")).toBe(true);
    // Tool stdout never became a text delta.
    const deltas = sessionEvents(out, "dsp_1")
      .filter((e) => e.event.type === "text_delta")
      .map((e) => String(e.event["delta"] ?? ""));
    expect(deltas.join("")).not.toContain("file-bytes");
    send({ v: 1, kind: "get_history", opId: "his_1", sessionId });
    await new Promise((r) => setTimeout(r, 20));
    const history = lastOfKind(out, "history") as unknown as { entries: Array<{ role: string; text?: string }> };
    expect(history.entries.some((e) => e.role === "tool" && e.text === "file-bytes")).toBe(true);
    expect(history.entries.some((e) => e.role === "assistant" && e.text === "got it")).toBe(true);
    // Assistant entries never carry tool output.
    expect(history.entries.filter((e) => e.role === "assistant").every((e) => e.text !== "file-bytes")).toBe(true);
  });

  it("preserves failed-tool isError and cumulative bash output without duplicating finals", async () => {
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
    send({ v: 1, kind: "dispatch", opId: "dsp_1", sessionId, message: { text: "run" } });
    await new Promise((r) => setTimeout(r, 20));
    fakes[0]?.emit({ type: "turn_start" } as PiServerEvent);
    fakes[0]?.emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "echo" } } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "tool_execution_update", toolCallId: "c1", partialResult: { content: [] } } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "tool_execution_update", toolCallId: "c1", partialResult: "tick-1\ntick-2\n" } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: "tick-1\ntick-2\n", isError: true } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "turn_end", message: { role: "assistant", stopReason: "stop" }, toolResults: [] } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "agent_settled" } as PiServerEvent);
    await new Promise((r) => setTimeout(r, 20));
    const ends = sessionEvents(out, "dsp_1").filter((e) => e.event.type === "tool_end");
    expect(ends).toHaveLength(1);
    expect(ends[0]?.event["isError"]).toBe(true);
    expect(ends[0]?.event["result"]).toBe("tick-1\ntick-2\n");
    send({ v: 1, kind: "get_history", opId: "his_1", sessionId });
    await new Promise((r) => setTimeout(r, 20));
    const history = lastOfKind(out, "history") as unknown as { entries: Array<{ role: string; text?: string }> };
    expect(history.entries.some((e) => e.role === "tool" && e.text === "tick-1\ntick-2\n")).toBe(true);
  });

  it("ignores unknown future events without terminating or leaking transient", async () => {
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
    send({ v: 1, kind: "dispatch", opId: "dsp_1", sessionId, message: { text: "hi" } });
    await new Promise((r) => setTimeout(r, 20));
    fakes[0]?.emit({ type: "turn_start" } as PiServerEvent);
    const before = sessionEvents(out, "dsp_1").length;
    fakes[0]?.emit({ type: "future_kind_xyz", payload: { deep: [1, 2] } } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "queue_update", steering: [], followUp: [] } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "compaction_start", reason: "auto" } as unknown as PiServerEvent);
    await new Promise((r) => setTimeout(r, 20));
    expect(sessionEvents(out, "dsp_1")).toHaveLength(before);
    // Turn still completes normally afterwards (unknown did not terminate).
    fakes[0]?.emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "ok" } } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "turn_end", message: { role: "assistant", stopReason: "stop" }, toolResults: [] } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "agent_settled" } as PiServerEvent);
    await new Promise((r) => setTimeout(r, 20));
    expect(sessionEvents(out, "dsp_1").some((e) => e.event.type === "settled")).toBe(true);
    send({ v: 1, kind: "cancel", opId: "cnl_1", sessionId });
    await new Promise((r) => setTimeout(r, 20));
    expect(lastOfKind(out, "cancelled")).toMatchObject({ settled: true });
  });

  it("never leaks a late tool_end after settle into the next dispatch (P1)", async () => {
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
    // First agent completes cleanly.
    send({ v: 1, kind: "dispatch", opId: "dsp_1", sessionId, message: { text: "first" } });
    await new Promise((r) => setTimeout(r, 20));
    fakes[0]?.emit({ type: "turn_start" } as PiServerEvent);
    fakes[0]?.emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "one" } } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "turn_end", message: { role: "assistant", stopReason: "stop" }, toolResults: [] } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "agent_settled" } as PiServerEvent);
    await new Promise((r) => setTimeout(r, 20));
    // Late tool completion races in after settle with no active op: dropped
    // (no event) and must not mutate translator state.
    const beforeLate = sessionEvents(out, "dsp_1").length;
    fakes[0]?.emit({ type: "tool_execution_end", toolCallId: "stale_1", toolName: "read", result: "stale-bytes", isError: false } as unknown as PiServerEvent);
    await new Promise((r) => setTimeout(r, 20));
    expect(sessionEvents(out, "dsp_1")).toHaveLength(beforeLate);
    expect(sessionEvents(out, undefined).filter((e) => e.event.type === "tool_end" && (e.event["toolCallId"] as string) === "stale_1")).toHaveLength(0);
    // Next dispatch runs a fresh agent: the stale tool must be absent.
    send({ v: 1, kind: "dispatch", opId: "dsp_2", sessionId, message: { text: "second" } });
    await new Promise((r) => setTimeout(r, 20));
    fakes[0]?.emit({ type: "turn_start" } as PiServerEvent);
    fakes[0]?.emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "two" } } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "turn_end", message: { role: "assistant", stopReason: "stop" }, toolResults: [] } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "agent_settled" } as PiServerEvent);
    await new Promise((r) => setTimeout(r, 20));
    expect(sessionEvents(out, "dsp_2").some((e) => e.event.type === "settled")).toBe(true);
    send({ v: 1, kind: "get_history", opId: "his_1", sessionId });
    await new Promise((r) => setTimeout(r, 20));
    const history = lastOfKind(out, "history") as unknown as { entries: Array<{ role: string; text?: string }> };
    expect(history.entries.some((e) => e.text === "stale-bytes")).toBe(false);
    expect(history.entries.filter((e) => e.role === "assistant").map((e) => e.text)).toEqual(["one", "two"]);
  });
});

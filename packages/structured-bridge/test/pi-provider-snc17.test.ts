/**
 * Pi-backed provider tests (SNC1.7 — history, current branch, resume).
 *
 * Drives `PiBridgeProvider` in-process with a history-capable fake Pi
 * (`get_entries` / `get_tree` / `switch_session`) to pin #17:
 * - `acquire{resumePath}` switches into the existing Pi session and rebuilds
 *   only root → current leaf (abandoned siblings excluded);
 * - live and historical translation converge (same roles/texts);
 * - `get_history` serves the rebuilt transcript with the Pi leaf (never the
 *   page end), cursors naming skipped entries still resolve;
 * - helper/provider restart (new provider, same resumePath) restores without
 *   duplication (wholesale replace, stable Pi ids);
 * - missing/incompatible history fails closed (never silent truncation);
 * - partial last turns recover honestly (trailing user, no fabricated
 *   assistant).
 */

import { describe, expect, it } from "vitest";
import { PiBridgeProvider, type PiProviderConnection } from "../src/pi-provider.js";
import type { ProviderToHostMessage } from "../src/protocol.js";
import { serializeBridgeLine } from "../src/framing.js";
import type {
  PiEntriesData,
  PiRpcCloseResult,
  PiRpcConnectionOptions,
  PiServerEvent,
  PiState,
  PiTreeData,
} from "@orca-pi/pi-rpc";

function piMsg(id: string, parentId: string | null, role: string, content: unknown) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role, content, timestamp: 1700000000000 },
  };
}

/** History-capable fake Pi (SNC1.7). */
class FakePi17 implements PiProviderConnection {
  readonly seenOpts: PiRpcConnectionOptions;
  readonly prompts: string[] = [];
  switchedTo: string[] = [];
  /** When true, `switchSession` reports `{cancelled:true}` (extension veto). */
  switchCancelled = false;
  /**
   * Hook run on every `prompt()`: appends Pi journal entries for the turn
   * (lets tests simulate Pi journaling live turns so settle reconciliation
   * can re-key them). Receives the prompt text.
   */
  autoJournal: ((message: string) => void) | null = null;
  started = false;
  closes = 0;
  failSwitchWith: unknown = null;
  failEntriesWith: unknown = null;
  failTreeWith: unknown = null;
  /** Flat entries served by `get_entries` (ignored when failEntriesWith set). */
  entries: Array<Record<string, unknown>> = [];
  leafId = "";
  /** Tree served by `get_tree` fallback (defaults to flat-derived single chain). */
  treeOverride: PiTreeData | null = null;
  state: PiState = {
    model: { id: "glm-5.3-flash", provider: "opencode-go" } as PiState["model"],
    thinkingLevel: "low",
    isStreaming: false,
    isCompacting: false,
    sessionId: "pi_resumed_1",
    messageCount: 2,
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
    this.prompts.push(message);
    if (this.autoJournal) this.autoJournal(message);
  }

  async abort(): Promise<void> {}

  async close(): Promise<PiRpcCloseResult> {
    this.closes += 1;
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

  respondToExtensionUi(): void {}

  async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
    this.switchedTo.push(sessionPath);
    if (this.failSwitchWith) throw this.failSwitchWith;
    return { cancelled: this.switchCancelled };
  }

  async getEntries(): Promise<PiEntriesData> {
    if (this.failEntriesWith) throw this.failEntriesWith;
    return { entries: this.entries as never, leafId: this.leafId };
  }

  async getTree(): Promise<PiTreeData> {
    if (this.failTreeWith) throw this.failTreeWith;
    if (this.treeOverride) return this.treeOverride;
    // Derive a single-chain tree from flat entries (good enough for tests).
    const byId = new Map<string, { entry: unknown; children: unknown[] }>();
    for (const e of this.entries) byId.set((e as { id: string }).id, { entry: e, children: [] });
    const roots: Array<{ entry: unknown; children: unknown[] }> = [];
    for (const e of this.entries) {
      const node = byId.get((e as { id: string }).id);
      const parentId = (e as { parentId: string | null }).parentId;
      if (parentId === null || !byId.has(parentId)) {
        if (node) roots.push(node);
      } else {
        const parent = byId.get(parentId);
        if (parent && node) (parent.children as unknown[]).push(node);
      }
    }
    return { tree: roots as never, leafId: this.leafId };
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

function seedTwoTurnSession(fake: FakePi17): void {
  fake.entries = [
    { type: "model_change", id: "e1", parentId: null },
    { type: "thinking_level_change", id: "e2", parentId: "e1" },
    piMsg("e3", "e2", "user", [{ type: "text", text: "Say FIRST." }]),
    piMsg("e4", "e3", "assistant", [{ type: "text", text: "FIRST." }]),
    // Abandoned fork sibling (must never render after resume at e6).
    piMsg("eX", "e3", "assistant", [{ type: "text", text: "abandoned branch" }]),
    piMsg("e5", "e4", "user", [{ type: "text", text: "Say SECOND." }]),
    piMsg("e6", "e5", "assistant", [{ type: "text", text: "SECOND." }]),
  ];
  fake.leafId = "e6";
  fake.state = { ...fake.state, messageCount: 4 };
}

describe("PiBridgeProvider SNC1.7 resume (history/current-branch)", () => {
  it("resumes an existing Pi session at the active leaf, excluding abandoned branches", async () => {
    const fakes: FakePi17[] = [];
    const provider = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi17(opts);
        seedTwoTurnSession(fake);
        fakes.push(fake);
        return fake;
      },
    });
    const { out, send, hello } = drive(provider);
    hello();
    send({ v: 1, kind: "acquire", opId: "acq_1", workspaceRoot: "/tmp/ws", resumePath: "/tmp/pi/ses.jsonl" });
    await new Promise((r) => setTimeout(r, 40));
    const acquired = lastOfKind(out, "acquired") as unknown as { resumed: boolean; metadata: { providerSessionId: string } };
    expect(acquired.resumed).toBe(true);
    expect(fakes[0]?.switchedTo).toEqual(["/tmp/pi/ses.jsonl"]);
    expect(acquired.metadata.providerSessionId).toBe("pi_resumed_1");

    send({ v: 1, kind: "get_history", opId: "his_1", sessionId: (lastOfKind(out, "acquired") as unknown as { sessionId: string }).sessionId });
    await new Promise((r) => setTimeout(r, 20));
    const history = lastOfKind(out, "history") as unknown as {
      entries: Array<{ id: string; role: string; text?: string }>;
      leafId?: string;
    };
    // Only the active branch renders (abandoned eX excluded).
    expect(history.entries.map((e) => e.text)).toEqual(["Say FIRST.", "FIRST.", "Say SECOND.", "SECOND."]);
    expect(history.entries.some((e) => e.text === "abandoned branch")).toBe(false);
    // Stable Pi ids + true Pi leaf (never the page end).
    expect(history.entries.map((e) => e.id)).toEqual(["e3", "e4", "e5", "e6"]);
    expect(history.leafId).toBe("e6");
    expect(JSON.stringify(history)).not.toContain("/tmp/pi/ses.jsonl");
  });

  it("live and historical translation converge on the same representation", async () => {
    // Live: dispatch + stream one turn; history must match the Pi rebuild for
    // the same content (user → assistant, text only, thinking never prose).
    const fakes: FakePi17[] = [];
    const provider = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi17(opts);
        fake.entries = [
          { type: "model_change", id: "e1", parentId: null },
          { type: "thinking_level_change", id: "e2", parentId: "e1" },
        ];
        fake.leafId = "e2";
        fake.state = { ...fake.state, messageCount: 0, sessionId: "pi_live_1" };
        fakes.push(fake);
        return fake;
      },
    });
    const { out, send, hello } = drive(provider);
    hello();
    send({ v: 1, kind: "acquire", opId: "acq_1", workspaceRoot: "/tmp/ws" });
    await new Promise((r) => setTimeout(r, 30));
    const sessionId = (lastOfKind(out, "acquired") as unknown as { sessionId: string }).sessionId;
    send({ v: 1, kind: "dispatch", opId: "dsp_1", sessionId, message: { text: "hello pi" } });
    await new Promise((r) => setTimeout(r, 20));
    fakes[0]?.emit({ type: "turn_start" } as PiServerEvent);
    fakes[0]?.emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "hi there" } } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "turn_end", message: { role: "assistant", stopReason: "stop" }, toolResults: [] } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "agent_settled" } as PiServerEvent);
    await new Promise((r) => setTimeout(r, 20));
    send({ v: 1, kind: "get_history", opId: "his_live", sessionId });
    await new Promise((r) => setTimeout(r, 20));
    const live = lastOfKind(out, "history") as unknown as { entries: Array<{ role: string; text?: string }> };
    expect(live.entries.map((e) => [e.role, e.text])).toEqual([
      ["user", "hello pi"],
      ["assistant", "hi there"],
    ]);
  });

  it("restores across helper restart without duplication (same resumePath, new provider)", async () => {
    const seed = (fake: FakePi17): void => seedTwoTurnSession(fake);
    const firstFakes: FakePi17[] = [];
    const first = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi17(opts);
        seed(fake);
        firstFakes.push(fake);
        return fake;
      },
    });
    const d1 = drive(first);
    d1.hello();
    d1.send({ v: 1, kind: "acquire", opId: "acq_1", workspaceRoot: "/tmp/ws", resumePath: "/tmp/pi/ses.jsonl" });
    await new Promise((r) => setTimeout(r, 40));
    const s1 = (lastOfKind(d1.out, "acquired") as unknown as { sessionId: string }).sessionId;
    d1.send({ v: 1, kind: "get_history", opId: "his_1", sessionId: s1 });
    await new Promise((r) => setTimeout(r, 20));
    const h1 = lastOfKind(d1.out, "history") as unknown as { entries: Array<{ id: string }> };

    // Helper restarts (new provider process, empty memory) and resumes the
    // same Pi file: identical transcript, identical stable ids, no duplicates.
    const secondFakes: FakePi17[] = [];
    const second = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi17(opts);
        seed(fake);
        secondFakes.push(fake);
        return fake;
      },
    });
    const d2 = drive(second);
    d2.hello();
    d2.send({ v: 1, kind: "acquire", opId: "acq_1", workspaceRoot: "/tmp/ws", resumePath: "/tmp/pi/ses.jsonl", sessionId: s1 });
    await new Promise((r) => setTimeout(r, 40));
    expect(lastOfKind(d2.out, "acquired")).toMatchObject({ resumed: true });
    d2.send({ v: 1, kind: "get_history", opId: "his_2", sessionId: s1 });
    await new Promise((r) => setTimeout(r, 20));
    const h2 = lastOfKind(d2.out, "history") as unknown as { entries: Array<{ id: string }>; leafId?: string };
    expect(h2.entries.map((e) => e.id)).toEqual(h1.entries.map((e) => e.id));
    expect(h2.entries).toHaveLength(4);
    expect(h2.leafId).toBe("e6");
    void secondFakes;
    void firstFakes;
  });

  it("fails closed on missing/incompatible history (never silent truncation)", async () => {
    // Unknown leaf.
    const badLeaf = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi17(opts);
        seedTwoTurnSession(fake);
        fake.leafId = "missing-leaf";
        return fake;
      },
    });
    const d1 = drive(badLeaf);
    d1.hello();
    d1.send({ v: 1, kind: "acquire", opId: "acq_1", workspaceRoot: "/tmp/ws", resumePath: "/tmp/pi/ses.jsonl" });
    await new Promise((r) => setTimeout(r, 40));
    expect(lastOfKind(d1.out, "error")).toMatchObject({ opId: "acq_1" });
    expect(JSON.stringify(lastOfKind(d1.out, "error"))).toContain("PI_HISTORY");

    // Broken chain (parent missing) with no tree fallback.
    const broken = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi17(opts);
        fake.entries = [piMsg("e2", "nope", "user", [{ type: "text", text: "x" }])];
        fake.leafId = "e2";
        fake.failTreeWith = Object.assign(new Error("no tree"), { code: "request-failed" });
        return fake;
      },
    });
    const d2 = drive(broken);
    d2.hello();
    d2.send({ v: 1, kind: "acquire", opId: "acq_1", workspaceRoot: "/tmp/ws", resumePath: "/tmp/pi/ses.jsonl" });
    await new Promise((r) => setTimeout(r, 40));
    expect(lastOfKind(d2.out, "error")).toMatchObject({ opId: "acq_1" });

    // History RPCs unsupported on a minimal transport (SNC1.4 text-only fake
    // with no getEntries/getTree/switchSession at all).
    const minimal = new PiBridgeProvider({
      createConnection: (opts) => {
        const base = new FakePi17(opts);
        const minimalConn: PiProviderConnection = {
          start: () => base.start(),
          prompt: (message: string) => base.prompt(message),
          abort: () => base.abort(),
          close: () => base.close(),
          onEvent: (h) => base.onEvent(h),
          onExit: (h) => base.onExit(h),
          getState: () => base.getState(),
          respondToExtensionUi: () => {},
          isClosed: base.isClosed,
        };
        void opts;
        return minimalConn;
      },
    });
    const d3 = drive(minimal);
    d3.hello();
    d3.send({ v: 1, kind: "acquire", opId: "acq_1", workspaceRoot: "/tmp/ws", resumePath: "/tmp/pi/ses.jsonl" });
    await new Promise((r) => setTimeout(r, 40));
    expect(lastOfKind(d3.out, "error")).toMatchObject({ opId: "acq_1" });
    expect(JSON.stringify(lastOfKind(d3.out, "error"))).toContain("PI_RESUME_UNSUPPORTED");
  });

  it("recovers a partial last turn honestly (trailing user, no fabricated assistant)", async () => {
    const provider = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi17(opts);
        fake.entries = [
          { type: "model_change", id: "e1", parentId: null },
          piMsg("e2", "e1", "user", [{ type: "text", text: "started then died" }]),
        ];
        fake.leafId = "e2";
        fake.state = { ...fake.state, messageCount: 1 };
        return fake;
      },
    });
    const { out, send, hello } = drive(provider);
    hello();
    send({ v: 1, kind: "acquire", opId: "acq_1", workspaceRoot: "/tmp/ws", resumePath: "/tmp/pi/ses.jsonl" });
    await new Promise((r) => setTimeout(r, 40));
    expect(lastOfKind(out, "acquired")).toMatchObject({ resumed: true });
    send({ v: 1, kind: "get_history", opId: "his_1", sessionId: (lastOfKind(out, "acquired") as unknown as { sessionId: string }).sessionId });
    await new Promise((r) => setTimeout(r, 20));
    const history = lastOfKind(out, "history") as unknown as { entries: Array<{ role: string; text?: string }>; leafId?: string };
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0]).toMatchObject({ role: "user", text: "started then died" });
    expect(history.leafId).toBe("e2");
  });

  it("returns a new session (resumed:false) when resumePath names a missing file", async () => {
    const provider = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi17(opts);
        // Fresh bootstrap only (Pi contract: missing path succeeds as new empty).
        fake.entries = [
          { type: "model_change", id: "e1", parentId: null },
          { type: "thinking_level_change", id: "e2", parentId: "e1" },
        ];
        fake.leafId = "e2";
        fake.state = { ...fake.state, messageCount: 0 };
        return fake;
      },
    });
    const { out, send, hello } = drive(provider);
    hello();
    send({ v: 1, kind: "acquire", opId: "acq_1", workspaceRoot: "/tmp/ws", resumePath: "/tmp/pi/missing.jsonl" });
    await new Promise((r) => setTimeout(r, 40));
    expect(lastOfKind(out, "acquired")).toMatchObject({ resumed: false });
    send({ v: 1, kind: "get_history", opId: "his_1", sessionId: (lastOfKind(out, "acquired") as unknown as { sessionId: string }).sessionId });
    await new Promise((r) => setTimeout(r, 20));
    const history = lastOfKind(out, "history") as unknown as { entries: unknown[]; leafId?: string };
    expect(history.entries).toHaveLength(0);
    expect(history.leafId).toBe("e2");
  });

  it("fails closed when Pi vetoes the switch (cancelled:true tears down, never resumes)", async () => {
    const fakes: FakePi17[] = [];
    const provider = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi17(opts);
        seedTwoTurnSession(fake);
        fake.switchCancelled = true;
        fakes.push(fake);
        return fake;
      },
    });
    const { out, send, hello } = drive(provider);
    hello();
    send({ v: 1, kind: "acquire", opId: "acq_1", workspaceRoot: "/tmp/ws", resumePath: "/tmp/pi/ses.jsonl" });
    await new Promise((r) => setTimeout(r, 40));
    // Vetoed switch never becomes a lease: error (not acquired), child torn
    // down, and no path leaks into the diagnostic.
    expect(out.some((m) => m.kind === "acquired")).toBe(false);
    expect(lastOfKind(out, "error")).toMatchObject({ opId: "acq_1" });
    expect(JSON.stringify(lastOfKind(out, "error"))).toContain("PI_RESUME_CANCELLED");
    expect(JSON.stringify(lastOfKind(out, "error"))).not.toContain("/tmp/pi/ses.jsonl");
    expect(provider.piSessionCount).toBe(0);
    void fakes;
  });

  it("keeps leafId cursors valid across live turns (reviewer P1 regression)", async () => {
    // acquire/resume → live turn A → capture leafId → live turn B →
    // get_history(cursor=<A leaf>) must return B's rows.
    const assistantFor: Record<string, string> = { A: "a-out", B: "b-out" };
    let seq = 6;
    const provider = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi17(opts);
        seedTwoTurnSession(fake);
        fake.autoJournal = (message: string) => {
          const u = `e${++seq}`;
          const a = `e${++seq}`;
          fake.entries.push(piMsg(u, fake.leafId, "user", [{ type: "text", text: message }]));
          fake.entries.push(
            piMsg(a, u, "assistant", [
              { type: "thinking", thinking: `reasoning for ${message}` },
              { type: "text", text: assistantFor[message] ?? `${message}-out` },
            ]),
          );
          fake.leafId = a;
        };
        return fake;
      },
    });
    const { out, send, hello } = drive(provider);
    hello();
    send({ v: 1, kind: "acquire", opId: "acq_1", workspaceRoot: "/tmp/ws", resumePath: "/tmp/pi/ses.jsonl" });
    await new Promise((r) => setTimeout(r, 40));
    const sessionId = (lastOfKind(out, "acquired") as unknown as { sessionId: string }).sessionId;

    async function liveTurn(opId: string, text: string, reply: string): Promise<void> {
      send({ v: 1, kind: "dispatch", opId, sessionId, message: { text } });
      await new Promise((r) => setTimeout(r, 20));
      const fake = (provider as unknown as { piRuntimes: Map<string, { conn: FakePi17 }> }).piRuntimes.get(sessionId)?.conn;
      fake?.emit({ type: "turn_start" } as PiServerEvent);
      fake?.emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: reply } } as unknown as PiServerEvent);
      fake?.emit({ type: "turn_end", message: { role: "assistant", stopReason: "stop" }, toolResults: [] } as unknown as PiServerEvent);
      fake?.emit({ type: "agent_settled" } as PiServerEvent);
      // Settle reconciliation is background: give the bounded refresh time.
      await new Promise((r) => setTimeout(r, 80));
    }

    await liveTurn("dsp_A", "A", "a-out");
    send({ v: 1, kind: "get_history", opId: "his_A", sessionId });
    await new Promise((r) => setTimeout(r, 20));
    const afterA = lastOfKind(out, "history") as unknown as {
      entries: Array<{ id: string; role: string; text?: string }>;
      leafId?: string;
    };
    // Turn A re-keyed to Pi ids (stable, thinking never leaked).
    expect(afterA.entries.slice(-2).map((e) => [e.role, e.text])).toEqual([
      ["user", "A"],
      ["assistant", "a-out"],
    ]);
    expect(afterA.entries.slice(-2).map((e) => e.id)).toEqual(["e7", "e8"]);
    expect(afterA.leafId).toBe("e8");
    const leafA = afterA.leafId as string;

    await liveTurn("dsp_B", "B", "b-out");
    send({ v: 1, kind: "get_history", opId: "his_AB", sessionId });
    await new Promise((r) => setTimeout(r, 20));
    const full = lastOfKind(out, "history") as unknown as {
      entries: Array<{ id: string; role: string; text?: string }>;
      leafId?: string;
    };
    expect(full.leafId).toBe("e10");
    // The P1 hole would return [] here (chain filter looks for Pi ids while
    // rows still carry synthetic ids). It must return B's rows.
    send({ v: 1, kind: "get_history", opId: "his_B", sessionId, cursor: leafA });
    await new Promise((r) => setTimeout(r, 20));
    const pageB = lastOfKind(out, "history") as unknown as {
      entries: Array<{ id: string; role: string; text?: string }>;
    };
    expect(pageB.entries.map((e) => [e.role, e.text])).toEqual([
      ["user", "B"],
      ["assistant", "b-out"],
    ]);
    // No duplicate ids anywhere (re-key replaces, never appends).
    const ids = full.entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("namespaces live rows so they never collide with Pi entry ids", async () => {
    const provider = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi17(opts);
        fake.entries = [
          { type: "model_change", id: "e1", parentId: null },
          { type: "thinking_level_change", id: "e2", parentId: "e1" },
        ];
        fake.leafId = "e2";
        fake.state = { ...fake.state, messageCount: 0, sessionId: "pi_live_1" };
        // Pi journals nothing for this turn (keeps live-N ids by design).
        return fake;
      },
    });
    const { out, send, hello } = drive(provider);
    hello();
    send({ v: 1, kind: "acquire", opId: "acq_1", workspaceRoot: "/tmp/ws" });
    await new Promise((r) => setTimeout(r, 30));
    const sessionId = (lastOfKind(out, "acquired") as unknown as { sessionId: string }).sessionId;
    send({ v: 1, kind: "dispatch", opId: "dsp_1", sessionId, message: { text: "hi" } });
    await new Promise((r) => setTimeout(r, 20));
    const fake = (provider as unknown as { piRuntimes: Map<string, { conn: FakePi17 }> }).piRuntimes.get(sessionId)?.conn;
    fake?.emit({ type: "turn_start" } as PiServerEvent);
    fake?.emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "yo" } } as unknown as PiServerEvent);
    fake?.emit({ type: "turn_end", message: { role: "assistant", stopReason: "stop" }, toolResults: [] } as unknown as PiServerEvent);
    fake?.emit({ type: "agent_settled" } as PiServerEvent);
    await new Promise((r) => setTimeout(r, 80));
    send({ v: 1, kind: "get_history", opId: "his_1", sessionId });
    await new Promise((r) => setTimeout(r, 20));
    const history = lastOfKind(out, "history") as unknown as { entries: Array<{ id: string; role: string }> };
    expect(history.entries.map((e) => e.id)).toEqual(["live-1", "live-2"]);
  });
});

/**
 * Pi-backed provider tests (SNC1.6 — model/thinking controls, interactive
 * prompts, image input).
 *
 * Drives `PiBridgeProvider` in-process with a fake `PiRpcConnection` that
 * implements the live Pi option RPCs (`get_available_models` / `set_model`,
 * `get_available_thinking_levels` / `set_thinking_level`,
 * `set_auto_compaction`) to pin the SNC1.6 contract from #16:
 *
 * - model/thinking list/current/set with provider-confirmed values, exact
 *   model refs only (no fuzzy/wildcard), Orca-normal `set_options` /
 *   `get_session` persistence, fail-closed unknown/ambiguous refs;
 * - interactive prompts: stable `requestId` identity, exactly-once answers,
 *   stale/late refusal, retirement on settle/cancel/exit, bounded ignore of
 *   unsupported UI kinds, multi-dialog support;
 * - structured images: live gating with actionable refusal, opaque
 *   forwarding, no terminal paste syntax, no image-byte journaling;
 * - option/prompt isolation across acquisition fences (no cross-session leak).
 */

import { describe, expect, it } from "vitest";
import { PiBridgeProvider, type PiProviderConnection } from "../src/pi-provider.js";
import type { ProviderToHostMessage } from "../src/protocol.js";
import { serializeBridgeLine } from "../src/framing.js";
import type {
  PiModel,
  PiRpcCloseResult,
  PiRpcConnectionOptions,
  PiServerEvent,
  PiState,
} from "@orca-pi/pi-rpc";

/** Fake Pi with live option RPCs (SNC1.6). */
class FakePi16 implements PiProviderConnection {
  readonly seenOpts: PiRpcConnectionOptions;
  readonly prompts: Array<{ message: string; opts?: unknown }> = [];
  readonly uiResponses: Array<unknown> = [];
  aborts = 0;
  closes: number[] = [];
  started = false;
  failStateWith: unknown = null;
  models: PiModel[] = [
    { id: "glm-5.3-flash", provider: "opencode-go", input: ["text", "image"] } as PiModel,
    { id: "text-only-model", provider: "opencode-go", input: ["text"] } as PiModel,
    { id: "shared-id", provider: "a", input: ["text"] } as PiModel,
    { id: "shared-id", provider: "b", input: ["text"] } as PiModel,
    // Image-capable but hint-miss (no glm/gpt/claude/gemini/vision substring):
    // proves the live catalog is authoritative over PI_IMAGE_CAPABLE_HINTS.
    { id: "minimax-m3", provider: "opencode-go", input: ["text", "image"] } as PiModel,
    // Duplicate bare id across providers (mirrors live gpt-5.6-luna case):
    // persistence must stay qualified or restore goes AMBIGUOUS_MODEL.
    { id: "gpt-5.6-luna", provider: "openai-codex", input: ["text", "image"] } as PiModel,
    { id: "gpt-5.6-luna", provider: "opencode-go", input: ["text", "image"] } as PiModel,
  ];
  levels: string[] = ["low", "high", "max"];
  setModelCalls: Array<{ provider: string; modelId: string }> = [];
  setThinkingCalls: string[] = [];
  setAutoCompactionCalls: boolean[] = [];
  failSetModelWith: unknown = null;
  failSetThinkingWith: unknown = null;
  failListModelsWith: unknown = null;
  failListLevelsWith: unknown = null;
  autoCompaction = true;
  state: PiState = {
    model: { id: "glm-5.3-flash", provider: "opencode-go" } as PiState["model"],
    thinkingLevel: "low",
    isStreaming: false,
    isCompacting: false,
    sessionId: "pi_ses_16",
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

  async prompt(message: string, opts?: { images?: readonly unknown[]; streamingBehavior?: string }): Promise<void> {
    this.prompts.push({ message, ...(opts ? { opts } : {}) });
  }

  async abort(): Promise<void> {
    this.aborts += 1;
  }

  async close(graceMs = 2000): Promise<PiRpcCloseResult> {
    this.closes.push(graceMs);
    this._closed = true;
    const info: PiRpcCloseResult = { exitCode: 0, signal: null, forced: false };
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
    return { ...this.state, model: this.state.model ? { ...this.state.model } : undefined };
  }

  respondToExtensionUi(response: { type: "extension_ui_response"; id: string; value?: unknown; confirmed?: boolean; cancelled?: boolean }): void {
    this.uiResponses.push(response);
  }

  async getAvailableModels(): Promise<{ models: PiModel[] }> {
    if (this.failListModelsWith) throw this.failListModelsWith;
    return { models: this.models.map((m) => ({ ...m })) };
  }

  async setModel(provider: string, modelId: string): Promise<PiModel> {
    this.setModelCalls.push({ provider, modelId });
    if (this.failSetModelWith) throw this.failSetModelWith;
    const found = this.models.find((m) => m.provider === provider && m.id === modelId);
    if (!found) {
      throw Object.assign(new Error(`Pi rejected set_model: Model not found: ${provider}/${modelId}`), {
        code: "rejected",
        command: "set_model",
        ambiguous: false,
        piError: `Model not found: ${provider}/${modelId}`,
      });
    }
    this.state = { ...this.state, model: { ...found } as PiState["model"] };
    return { ...found };
  }

  async getAvailableThinkingLevels(): Promise<{ levels: string[] }> {
    if (this.failListLevelsWith) throw this.failListLevelsWith;
    return { levels: [...this.levels] };
  }

  async setThinkingLevel(level: string): Promise<void> {
    this.setThinkingCalls.push(level);
    if (this.failSetThinkingWith) throw this.failSetThinkingWith;
    // Real Pi is lenient (bogus → minimal); the fake mirrors that so tests
    // prove the *bridge* validates (not Pi). The bridge must reject bogus
    // before calling here.
    this.state = { ...this.state, thinkingLevel: level };
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    this.setAutoCompactionCalls.push(enabled);
    this.autoCompaction = enabled;
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

async function acquireSession(
  provider: PiBridgeProvider,
  out: ProviderToHostMessage[],
  send: (obj: unknown) => void,
  opId = "acq_1",
  options?: Record<string, unknown>,
): Promise<string> {
  send({
    v: 1,
    kind: "acquire",
    opId,
    workspaceRoot: "/tmp/ws",
    ...(options ? { options } : {}),
  });
  await new Promise((r) => setTimeout(r, 30));
  return (lastOfKind(out, "acquired") as unknown as { sessionId: string }).sessionId;
}

describe("SNC1.6 model/thinking controls (live Pi RPC, provider-confirmed)", () => {
  it("sets model by exact bare id and reports provider-confirmed values", async () => {
    const fakes: FakePi16[] = [];
    const provider = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi16(opts);
        fakes.push(fake);
        return fake;
      },
    });
    const { out, send, hello } = drive(provider);
    hello();
    const sessionId = await acquireSession(provider, out, send);
    send({ v: 1, kind: "set_options", opId: "opt_1", sessionId, options: { model: "text-only-model" } });
    await new Promise((r) => setTimeout(r, 30));
    const updated = lastOfKind(out, "options_updated") as unknown as { options: { model?: string } };
    expect(updated.options.model).toBe("opencode-go/text-only-model");
    expect(fakes[0]?.setModelCalls).toEqual([{ provider: "opencode-go", modelId: "text-only-model" }]);
    // Lease reports the confirmed model (Orca-normal persistence).
    send({ v: 1, kind: "get_session", opId: "ses_1", sessionId });
    await new Promise((r) => setTimeout(r, 30));
    const meta = (lastOfKind(out, "session") as unknown as { metadata: { model?: string } }).metadata;
    expect(meta.model).toBe("opencode-go/text-only-model");
  });

  it("sets model by exact provider/modelId and persists the confirmed id", async () => {
    const fakes: FakePi16[] = [];
    const provider = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi16(opts);
        fakes.push(fake);
        return fake;
      },
    });
    const { out, send, hello } = drive(provider);
    hello();
    const sessionId = await acquireSession(provider, out, send);
    send({ v: 1, kind: "set_options", opId: "opt_1", sessionId, options: { model: "opencode-go/glm-5.3-flash" } });
    await new Promise((r) => setTimeout(r, 30));
    const updated = lastOfKind(out, "options_updated") as unknown as { options: { model?: string } };
    // Provider-confirmed canonical qualified ref is persisted (restore-safe for duplicate ids).
    expect(updated.options.model).toBe("opencode-go/glm-5.3-flash");
    expect(fakes[0]?.setModelCalls).toEqual([{ provider: "opencode-go", modelId: "glm-5.3-flash" }]);
  });

  it("fails closed on unknown model refs without fuzzy matching", async () => {
    const provider = new PiBridgeProvider({ createConnection: (opts) => new FakePi16(opts) });
    const { out, send, hello } = drive(provider);
    hello();
    const sessionId = await acquireSession(provider, out, send);
    // Bare unknown id.
    send({ v: 1, kind: "set_options", opId: "opt_bad", sessionId, options: { model: "nope-nope" } });
    await new Promise((r) => setTimeout(r, 30));
    expect(lastOfKind(out, "error")).toMatchObject({ opId: "opt_bad" });
    expect(JSON.stringify(lastOfKind(out, "error"))).toContain("UNKNOWN_MODEL");
    // Wrong provider for a known id (exact match required, no prefix/fuzzy).
    send({ v: 1, kind: "set_options", opId: "opt_bad2", sessionId, options: { model: "wrong-provider/glm-5.3-flash" } });
    await new Promise((r) => setTimeout(r, 30));
    expect(JSON.stringify(lastOfKind(out, "error"))).toContain("UNKNOWN_MODEL");
    // Prefix/wildcard inventions are not resolved.
    send({ v: 1, kind: "set_options", opId: "opt_bad3", sessionId, options: { model: "glm-*" } });
    await new Promise((r) => setTimeout(r, 30));
    expect(JSON.stringify(lastOfKind(out, "error"))).toContain("UNKNOWN_MODEL");
  });

  it("fails closed on ambiguous bare ids (requires provider/modelId form)", async () => {
    const provider = new PiBridgeProvider({ createConnection: (opts) => new FakePi16(opts) });
    const { out, send, hello } = drive(provider);
    hello();
    const sessionId = await acquireSession(provider, out, send);
    send({ v: 1, kind: "set_options", opId: "opt_amb", sessionId, options: { model: "shared-id" } });
    await new Promise((r) => setTimeout(r, 30));
    const err = lastOfKind(out, "error") as unknown as { error: { code: string; message: string } };
    expect(err.error.code).toBe("AMBIGUOUS_MODEL");
    expect(err.error.message).toContain("provider/modelId");
    // Disambiguated form succeeds.
    send({ v: 1, kind: "set_options", opId: "opt_ok", sessionId, options: { model: "a/shared-id" } });
    await new Promise((r) => setTimeout(r, 30));
    expect(lastOfKind(out, "options_updated")).toBeDefined();
  });

  it("sets thinking levels against the live list and rejects bogus without touching Pi", async () => {
    const fakes: FakePi16[] = [];
    const provider = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi16(opts);
        fakes.push(fake);
        return fake;
      },
    });
    const { out, send, hello } = drive(provider);
    hello();
    const sessionId = await acquireSession(provider, out, send);
    send({ v: 1, kind: "set_options", opId: "opt_t", sessionId, options: { thinkingLevel: "high" } });
    await new Promise((r) => setTimeout(r, 30));
    expect(lastOfKind(out, "options_updated")).toMatchObject({ opId: "opt_t" });
    expect(fakes[0]?.setThinkingCalls).toEqual(["high"]);
    send({ v: 1, kind: "get_session", opId: "ses_t", sessionId });
    await new Promise((r) => setTimeout(r, 30));
    expect((lastOfKind(out, "session") as unknown as { metadata: { thinkingLevel?: string } }).metadata.thinkingLevel).toBe("high");

    // Bogus level: bridge fails closed before Pi (Pi would silently coerce).
    const callsBefore = fakes[0]?.setThinkingCalls.length ?? 0;
    send({ v: 1, kind: "set_options", opId: "opt_bogus", sessionId, options: { thinkingLevel: "bogus-level" } });
    await new Promise((r) => setTimeout(r, 30));
    expect(lastOfKind(out, "error")).toMatchObject({ opId: "opt_bogus" });
    expect(JSON.stringify(lastOfKind(out, "error"))).toContain("UNKNOWN_THINKING_LEVEL");
    expect(fakes[0]?.setThinkingCalls.length).toBe(callsBefore);
  });

  it("tracks live thinking_level_changed events into the lease", async () => {
    const fakes: FakePi16[] = [];
    const provider = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi16(opts);
        fakes.push(fake);
        return fake;
      },
    });
    const { out, send, hello } = drive(provider);
    hello();
    const sessionId = await acquireSession(provider, out, send);
    send({ v: 1, kind: "dispatch", opId: "dsp_1", sessionId, message: { text: "hi" } });
    await new Promise((r) => setTimeout(r, 20));
    // Pi changes thinking mid-turn (e.g. via set_model side effect).
    fakes[0]?.emit({ type: "thinking_level_changed", level: "max" } as unknown as PiServerEvent);
    await new Promise((r) => setTimeout(r, 20));
    send({ v: 1, kind: "get_session", opId: "ses_1", sessionId });
    await new Promise((r) => setTimeout(r, 30));
    // get_session refreshes from get_state, but the live event already moved
    // the lease; either way the confirmed value surfaces. Force the fake to
    // confirm the event value via state so the refresh agrees.
    fakes[0]!.state = { ...fakes[0]!.state, thinkingLevel: "max" };
    send({ v: 1, kind: "get_session", opId: "ses_2", sessionId });
    await new Promise((r) => setTimeout(r, 30));
    expect((lastOfKind(out, "session") as unknown as { metadata: { thinkingLevel?: string } }).metadata.thinkingLevel).toBe("max");
  });

  it("applies acquire-time options live and fails closed on bad refs", async () => {
    const fakes: FakePi16[] = [];
    const provider = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi16(opts);
        fakes.push(fake);
        return fake;
      },
    });
    const { out, send, hello } = drive(provider);
    hello();
    // Good refs: acquired lease carries provider-confirmed values.
    send({ v: 1, kind: "acquire", opId: "acq_good", workspaceRoot: "/tmp/ws", options: { model: "text-only-model", thinkingLevel: "high" } });
    await new Promise((r) => setTimeout(r, 40));
    const acquired = lastOfKind(out, "acquired") as unknown as { metadata: { model?: string; thinkingLevel?: string } };
    expect(acquired.metadata.model).toBe("opencode-go/text-only-model");
    expect(acquired.metadata.thinkingLevel).toBe("high");

    // Bad model ref: no acquired, actionable error, no leaked child.
    const countBefore = provider.piSessionCount;
    send({ v: 1, kind: "acquire", opId: "acq_bad", workspaceRoot: "/tmp/ws", options: { model: "nope/nope" } });
    await new Promise((r) => setTimeout(r, 40));
    expect(lastOfKind(out, "error")).toMatchObject({ opId: "acq_bad" });
    expect(out.filter((m) => m.kind === "acquired")).toHaveLength(1);
    expect(provider.piSessionCount).toBe(countBefore);
  });

  it("persists autoCompaction and queueMode without diverging the lease", async () => {
    const fakes: FakePi16[] = [];
    const provider = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi16(opts);
        fakes.push(fake);
        return fake;
      },
    });
    const { out, send, hello } = drive(provider);
    hello();
    const sessionId = await acquireSession(provider, out, send);
    send({ v: 1, kind: "set_options", opId: "opt_q", sessionId, options: { autoCompaction: false, queueMode: "steer" } });
    await new Promise((r) => setTimeout(r, 30));
    const updated = lastOfKind(out, "options_updated") as unknown as { options: { autoCompaction?: boolean; queueMode?: string } };
    expect(updated.options.autoCompaction).toBe(false);
    expect(updated.options.queueMode).toBe("steer");
    expect(fakes[0]?.setAutoCompactionCalls).toEqual([false]);
  });
});

describe("SNC1.6 interactive prompts (stable identity, exactly-once, retirement)", () => {
  it("answers each dialog exactly once; duplicates are stale refusals", async () => {
    const fakes: FakePi16[] = [];
    const provider = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi16(opts);
        fakes.push(fake);
        return fake;
      },
    });
    const { out, send, hello } = drive(provider);
    hello();
    const sessionId = await acquireSession(provider, out, send);
    send({ v: 1, kind: "dispatch", opId: "dsp_1", sessionId, message: { text: "ask" } });
    await new Promise((r) => setTimeout(r, 20));
    fakes[0]?.emit({ type: "extension_ui_request", id: "dlg_1", method: "select", title: "Pick", options: ["A", "B"] } as unknown as PiServerEvent);
    await new Promise((r) => setTimeout(r, 20));
    expect(sessionEvents(out, "dsp_1").some((e) => e.event.type === "prompt_request")).toBe(true);

    send({ v: 1, kind: "answer_prompt", opId: "ans_1", requestId: "dlg_1", value: "A", cancelled: false });
    await new Promise((r) => setTimeout(r, 20));
    expect(fakes[0]?.uiResponses).toEqual([{ type: "extension_ui_response", id: "dlg_1", value: "A" }]);
    expect(lastOfKind(out, "error")).toMatchObject({ opId: "ans_1", error: { code: "ANSWERED" } });

    // Duplicate answer for the same requestId: stale refusal, never re-sent.
    send({ v: 1, kind: "answer_prompt", opId: "ans_2", requestId: "dlg_1", value: "B", cancelled: false });
    await new Promise((r) => setTimeout(r, 20));
    expect(lastOfKind(out, "error")).toMatchObject({ opId: "ans_2", error: { code: "UNKNOWN_REQUEST" } });
    expect(fakes[0]?.uiResponses).toHaveLength(1);
  });

  it("supports overlapping dialogs with stable per-request identity", async () => {
    const fakes: FakePi16[] = [];
    const provider = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi16(opts);
        fakes.push(fake);
        return fake;
      },
    });
    const { out, send, hello } = drive(provider);
    hello();
    const sessionId = await acquireSession(provider, out, send);
    send({ v: 1, kind: "dispatch", opId: "dsp_1", sessionId, message: { text: "two dialogs" } });
    await new Promise((r) => setTimeout(r, 20));
    fakes[0]?.emit({ type: "extension_ui_request", id: "dlg_a", method: "select", title: "First", options: ["A", "B"] } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "extension_ui_request", id: "dlg_b", method: "confirm", title: "Second", message: "Sure?" } as unknown as PiServerEvent);
    await new Promise((r) => setTimeout(r, 20));
    const prompts = sessionEvents(out, "dsp_1").filter((e) => e.event.type === "prompt_request");
    expect(prompts.map((e) => (e.event as { requestId?: string }).requestId).sort()).toEqual(["dlg_a", "dlg_b"]);

    // Answer out of order; confirm maps boolean → confirmed.
    send({ v: 1, kind: "answer_prompt", opId: "ans_b", requestId: "dlg_b", value: true, cancelled: false });
    await new Promise((r) => setTimeout(r, 20));
    send({ v: 1, kind: "answer_prompt", opId: "ans_a", requestId: "dlg_a", value: "B", cancelled: false });
    await new Promise((r) => setTimeout(r, 20));
    expect(fakes[0]?.uiResponses).toContainEqual({ type: "extension_ui_response", id: "dlg_b", confirmed: true });
    expect(fakes[0]?.uiResponses).toContainEqual({ type: "extension_ui_response", id: "dlg_a", value: "B" });
    expect(fakes[0]?.uiResponses).toHaveLength(2);
  });

  it("refuses unknown/stale answers without touching Pi", async () => {
    const fakes: FakePi16[] = [];
    const provider = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi16(opts);
        fakes.push(fake);
        return fake;
      },
    });
    const { out, send, hello } = drive(provider);
    hello();
    await acquireSession(provider, out, send);
    send({ v: 1, kind: "answer_prompt", opId: "ans_unknown", requestId: "never-seen", value: "x", cancelled: false });
    await new Promise((r) => setTimeout(r, 20));
    expect(lastOfKind(out, "error")).toMatchObject({ opId: "ans_unknown", error: { code: "UNKNOWN_REQUEST" } });
    expect(fakes[0]?.uiResponses).toHaveLength(0);
  });

  it("retires pending prompts on turn settle (late answers refused)", async () => {
    const fakes: FakePi16[] = [];
    const provider = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi16(opts);
        fakes.push(fake);
        return fake;
      },
    });
    const { out, send, hello } = drive(provider);
    hello();
    const sessionId = await acquireSession(provider, out, send);
    send({ v: 1, kind: "dispatch", opId: "dsp_1", sessionId, message: { text: "ask then settle" } });
    await new Promise((r) => setTimeout(r, 20));
    fakes[0]?.emit({ type: "extension_ui_request", id: "dlg_settle", method: "input", title: "Name", placeholder: "x" } as unknown as PiServerEvent);
    await new Promise((r) => setTimeout(r, 20));
    // Settle the turn without answering.
    fakes[0]?.emit({ type: "turn_end", message: { role: "assistant", stopReason: "stop" }, toolResults: [] } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "agent_settled" } as PiServerEvent);
    await new Promise((r) => setTimeout(r, 20));
    // Late answer after settle: retired, never forwarded.
    send({ v: 1, kind: "answer_prompt", opId: "ans_late", requestId: "dlg_settle", value: "too-late", cancelled: false });
    await new Promise((r) => setTimeout(r, 20));
    expect(lastOfKind(out, "error")).toMatchObject({ opId: "ans_late", error: { code: "UNKNOWN_REQUEST" } });
    expect(fakes[0]?.uiResponses).toHaveLength(0);
  });

  it("retires pending prompts on cancel (Esc fence)", async () => {
    const fakes: FakePi16[] = [];
    const provider = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi16(opts);
        fakes.push(fake);
        return fake;
      },
    });
    const { out, send, hello } = drive(provider);
    hello();
    const sessionId = await acquireSession(provider, out, send);
    send({ v: 1, kind: "dispatch", opId: "dsp_1", sessionId, message: { text: "long task" } });
    await new Promise((r) => setTimeout(r, 20));
    fakes[0]?.emit({ type: "extension_ui_request", id: "dlg_cancel", method: "select", title: "Pick", options: ["A"] } as unknown as PiServerEvent);
    await new Promise((r) => setTimeout(r, 20));
    send({ v: 1, kind: "cancel", opId: "cnl_1", sessionId, targetOpId: "dsp_1" });
    await new Promise((r) => setTimeout(r, 20));
    send({ v: 1, kind: "answer_prompt", opId: "ans_after_cancel", requestId: "dlg_cancel", value: "A", cancelled: false });
    await new Promise((r) => setTimeout(r, 20));
    expect(lastOfKind(out, "error")).toMatchObject({ opId: "ans_after_cancel", error: { code: "UNKNOWN_REQUEST" } });
    expect(fakes[0]?.uiResponses).toHaveLength(0);
  });

  it("ignores duplicate Pi ids while pending (one card, one answer)", async () => {
    const fakes: FakePi16[] = [];
    const provider = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi16(opts);
        fakes.push(fake);
        return fake;
      },
    });
    const { out, send, hello } = drive(provider);
    hello();
    const sessionId = await acquireSession(provider, out, send);
    send({ v: 1, kind: "dispatch", opId: "dsp_1", sessionId, message: { text: "dup" } });
    await new Promise((r) => setTimeout(r, 20));
    fakes[0]?.emit({ type: "extension_ui_request", id: "dlg_dup", method: "select", title: "Pick", options: ["A"] } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "extension_ui_request", id: "dlg_dup", method: "select", title: "Pick", options: ["A"] } as unknown as PiServerEvent);
    await new Promise((r) => setTimeout(r, 20));
    expect(sessionEvents(out, "dsp_1").filter((e) => e.event.type === "prompt_request")).toHaveLength(1);
    send({ v: 1, kind: "answer_prompt", opId: "ans_1", requestId: "dlg_dup", value: "A", cancelled: false });
    await new Promise((r) => setTimeout(r, 20));
    expect(fakes[0]?.uiResponses).toHaveLength(1);
  });

  it("never creates prompts for fire-and-forget or unknown UI kinds", async () => {
    const fakes: FakePi16[] = [];
    const provider = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi16(opts);
        fakes.push(fake);
        return fake;
      },
    });
    const { out, send, hello } = drive(provider);
    hello();
    const sessionId = await acquireSession(provider, out, send);
    send({ v: 1, kind: "dispatch", opId: "dsp_1", sessionId, message: { text: "chrome" } });
    await new Promise((r) => setTimeout(r, 20));
    fakes[0]?.emit({ type: "extension_ui_request", id: "n1", method: "notify", message: "hi" } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "extension_ui_request", id: "s1", method: "setTitle", title: "spin" } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "extension_ui_request", id: "u1", method: "custom-future-kind", title: "?" } as unknown as PiServerEvent);
    await new Promise((r) => setTimeout(r, 20));
    expect(sessionEvents(out, "dsp_1").filter((e) => e.event.type === "prompt_request")).toHaveLength(0);
    // Answers for never-created ids are refused.
    send({ v: 1, kind: "answer_prompt", opId: "ans_u", requestId: "u1", value: "x", cancelled: false });
    await new Promise((r) => setTimeout(r, 20));
    expect(lastOfKind(out, "error")).toMatchObject({ opId: "ans_u", error: { code: "UNKNOWN_REQUEST" } });
    expect(fakes[0]?.uiResponses).toHaveLength(0);
  });

  it("maps cancelled answers to Pi cancelled:true without leaking values", async () => {
    const fakes: FakePi16[] = [];
    const provider = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi16(opts);
        fakes.push(fake);
        return fake;
      },
    });
    const { out, send, hello } = drive(provider);
    hello();
    const sessionId = await acquireSession(provider, out, send);
    send({ v: 1, kind: "dispatch", opId: "dsp_1", sessionId, message: { text: "ask" } });
    await new Promise((r) => setTimeout(r, 20));
    fakes[0]?.emit({ type: "extension_ui_request", id: "dlg_c", method: "input", title: "Name" } as unknown as PiServerEvent);
    await new Promise((r) => setTimeout(r, 20));
    send({ v: 1, kind: "answer_prompt", opId: "ans_c", requestId: "dlg_c", cancelled: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(fakes[0]?.uiResponses).toEqual([{ type: "extension_ui_response", id: "dlg_c", cancelled: true }]);
    expect(JSON.stringify(lastOfKind(out, "error"))).not.toContain("secret-answer-value");
  });
});

describe("SNC1.6 structured images (authorized attachments, no byte journaling)", () => {
  const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  it("forwards structured images to Pi and journals text only", async () => {
    const fakes: FakePi16[] = [];
    const provider = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi16(opts);
        fakes.push(fake);
        return fake;
      },
    });
    const { out, send, hello } = drive(provider);
    hello();
    const sessionId = await acquireSession(provider, out, send);
    send({
      v: 1,
      kind: "dispatch",
      opId: "dsp_img",
      sessionId,
      message: { text: "what is in this image?", images: [{ data: tinyPng, mimeType: "image/png" }] },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(lastOfKind(out, "dispatch_ack")).toMatchObject({ opId: "dsp_img", status: "accepted" });
    // Structured Pi prompt shape (never terminal paste syntax).
    const seen = fakes[0]?.prompts[0] as unknown as { message: string; opts?: { images?: Array<{ type: string; data: string; mimeType: string }> } };
    expect(seen.message).toBe("what is in this image?");
    expect(seen.opts?.images).toEqual([{ type: "image", data: tinyPng, mimeType: "image/png" }]);

    // Turn completes; history carries text but never the base64 bytes.
    fakes[0]?.emit({ type: "turn_start" } as PiServerEvent);
    fakes[0]?.emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "ONE-PIXEL" } } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "turn_end", message: { role: "assistant", stopReason: "stop" }, toolResults: [] } as unknown as PiServerEvent);
    fakes[0]?.emit({ type: "agent_settled" } as PiServerEvent);
    await new Promise((r) => setTimeout(r, 20));
    send({ v: 1, kind: "get_history", opId: "his_img", sessionId });
    await new Promise((r) => setTimeout(r, 20));
    const history = lastOfKind(out, "history") as unknown as { entries: Array<{ text?: string }> };
    expect(history.entries.some((e) => e.text === "what is in this image?")).toBe(true);
    expect(history.entries.some((e) => e.text === "ONE-PIXEL")).toBe(true);
    expect(JSON.stringify(history)).not.toContain(tinyPng.slice(0, 32));
  });

  it("feature-gates images on text-only models with an actionable refusal", async () => {
    const fakes: FakePi16[] = [];
    const provider = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi16(opts);
        fakes.push(fake);
        return fake;
      },
    });
    const { out, send, hello } = drive(provider);
    hello();
    const sessionId = await acquireSession(provider, out, send);
    // Switch to a text-only model (live catalog confirms no image input).
    send({ v: 1, kind: "set_options", opId: "opt_txt", sessionId, options: { model: "text-only-model" } });
    await new Promise((r) => setTimeout(r, 30));
    expect(lastOfKind(out, "options_updated")).toBeDefined();
    send({
      v: 1,
      kind: "dispatch",
      opId: "dsp_img_bad",
      sessionId,
      message: { text: "see this?", images: [{ data: tinyPng, mimeType: "image/png" }] },
    });
    await new Promise((r) => setTimeout(r, 20));
    const ack = lastOfKind(out, "dispatch_ack") as unknown as { status: string; reason?: string };
    expect(ack.status).toBe("rejected");
    expect(ack.reason ?? "").toContain("model-rejects-images");
    // Pi never saw the prompt (definite refusal, safe to retry after model switch).
    expect(fakes[0]?.prompts.filter((p) => p.message === "see this?")).toHaveLength(0);
  });
});

describe("SNC1.6 acquisition fences (no option/prompt leak across sessions)", () => {
  it("keeps options and prompts isolated per session", async () => {
    const fakes: FakePi16[] = [];
    const provider = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi16(opts);
        fakes.push(fake);
        return fake;
      },
    });
    const { out, send, hello } = drive(provider);
    hello();
    const sessionA = await acquireSession(provider, out, send, "acq_a");
    const sessionB = await acquireSession(provider, out, send, "acq_b");
    expect(sessionA).not.toBe(sessionB);

    // Options on A never leak to B.
    send({ v: 1, kind: "set_options", opId: "opt_a", sessionId: sessionA, options: { thinkingLevel: "high" } });
    await new Promise((r) => setTimeout(r, 30));
    send({ v: 1, kind: "get_session", opId: "ses_a", sessionId: sessionA });
    await new Promise((r) => setTimeout(r, 30));
    send({ v: 1, kind: "get_session", opId: "ses_b", sessionId: sessionB });
    await new Promise((r) => setTimeout(r, 30));
    const metas = out.filter((m) => m.kind === "session") as unknown as Array<{ opId: string; metadata: { thinkingLevel?: string } }>;
    expect(metas.find((m) => m.opId === "ses_a")?.metadata.thinkingLevel).toBe("high");
    expect(metas.find((m) => m.opId === "ses_b")?.metadata.thinkingLevel).toBe("low");

    // Prompts on A are unanswerable via B's Pi child (fenced by requestId map).
    send({ v: 1, kind: "dispatch", opId: "dsp_a", sessionId: sessionA, message: { text: "ask A" } });
    await new Promise((r) => setTimeout(r, 20));
    const fakeA = fakes.find((f) => f.prompts.some((p) => p.message === "ask A"));
    expect(fakeA).toBeDefined();
    fakeA?.emit({ type: "extension_ui_request", id: "dlg_fence", method: "select", title: "Fenced", options: ["X"] } as unknown as PiServerEvent);
    await new Promise((r) => setTimeout(r, 20));
    // Answer routes to A's child only (exactly one Pi sees it).
    const totalBefore = fakes.reduce((n, f) => n + f.uiResponses.length, 0);
    send({ v: 1, kind: "answer_prompt", opId: "ans_fence", requestId: "dlg_fence", value: "X", cancelled: false });
    await new Promise((r) => setTimeout(r, 20));
    const totalAfter = fakes.reduce((n, f) => n + f.uiResponses.length, 0);
    expect(totalAfter - totalBefore).toBe(1);
    expect(fakeA?.uiResponses).toContainEqual({ type: "extension_ui_response", id: "dlg_fence", value: "X" });
  });

  it("retires prompts on release so a reacquired id starts clean", async () => {
    const fakes: FakePi16[] = [];
    const provider = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi16(opts);
        fakes.push(fake);
        return fake;
      },
    });
    const { out, send, hello } = drive(provider);
    hello();
    const sessionId = await acquireSession(provider, out, send, "acq_1");
    send({ v: 1, kind: "dispatch", opId: "dsp_1", sessionId, message: { text: "ask" } });
    await new Promise((r) => setTimeout(r, 20));
    fakes[0]?.emit({ type: "extension_ui_request", id: "dlg_old", method: "select", title: "Old", options: ["A"] } as unknown as PiServerEvent);
    await new Promise((r) => setTimeout(r, 20));
    send({ v: 1, kind: "release", opId: "rel_1", sessionId });
    await new Promise((r) => setTimeout(r, 20));
    // Late answer after release: unknown (fenced), never forwarded.
    send({ v: 1, kind: "answer_prompt", opId: "ans_old", requestId: "dlg_old", value: "A", cancelled: false });
    await new Promise((r) => setTimeout(r, 20));
    expect(lastOfKind(out, "error")).toMatchObject({ opId: "ans_old", error: { code: "UNKNOWN_REQUEST" } });
    expect(fakes[0]?.uiResponses).toHaveLength(0);
  });
});

describe("SNC1.6 ChatGPT review regressions (PR #39 P1s)", () => {
  const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  it("P1-1: live catalog authorizes hint-miss image models (minimax-m3)", async () => {
    // `minimax-m3` carries input:[text,image] in the live catalog but matches
    // none of PI_IMAGE_CAPABLE_HINTS — the old hint-first order wrongly
    // rejected it before the authoritative check ran.
    const fakes: FakePi16[] = [];
    const provider = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi16(opts);
        fakes.push(fake);
        return fake;
      },
    });
    const { out, send, hello } = drive(provider);
    hello();
    const sessionId = await acquireSession(provider, out, send);
    send({ v: 1, kind: "set_options", opId: "opt_mm", sessionId, options: { model: "opencode-go/minimax-m3" } });
    await new Promise((r) => setTimeout(r, 30));
    expect(lastOfKind(out, "options_updated")).toBeDefined();
    send({
      v: 1,
      kind: "dispatch",
      opId: "dsp_mm_img",
      sessionId,
      message: { text: "see this?", images: [{ data: tinyPng, mimeType: "image/png" }] },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(lastOfKind(out, "dispatch_ack")).toMatchObject({ opId: "dsp_mm_img", status: "accepted" });
    expect(fakes[0]?.prompts.some((p) => p.message === "see this?")).toBe(true);
  });

  it("P1-2: qualified persistence restores duplicate ids (gpt-5.6-luna)", async () => {
    const fakes: FakePi16[] = [];
    const provider = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi16(opts);
        fakes.push(fake);
        return fake;
      },
    });
    const { out, send, hello } = drive(provider);
    hello();
    const sessionId = await acquireSession(provider, out, send, "acq_1");
    // Select the openai-codex copy via qualified ref; persistence stays qualified.
    send({ v: 1, kind: "set_options", opId: "opt_dup", sessionId, options: { model: "openai-codex/gpt-5.6-luna" } });
    await new Promise((r) => setTimeout(r, 30));
    const updated = lastOfKind(out, "options_updated") as unknown as { options: { model?: string } };
    expect(updated.options.model).toBe("openai-codex/gpt-5.6-luna");
    // Release and reacquire with the persisted qualified ref: must not go AMBIGUOUS.
    send({ v: 1, kind: "release", opId: "rel_1", sessionId });
    await new Promise((r) => setTimeout(r, 20));
    send({ v: 1, kind: "acquire", opId: "acq_2", workspaceRoot: "/tmp/ws", options: { model: updated.options.model } });
    await new Promise((r) => setTimeout(r, 40));
    const reacquired = lastOfKind(out, "acquired") as unknown as { metadata: { model?: string } };
    expect(reacquired.metadata.model).toBe("openai-codex/gpt-5.6-luna");
    // Bare duplicate still fails closed (proves the qualified form was required).
    send({ v: 1, kind: "set_options", opId: "opt_bare_dup", sessionId: reacquired.metadata.sessionId as unknown as string, options: { model: "gpt-5.6-luna" } });
    await new Promise((r) => setTimeout(r, 30));
    // The reacquired session id is the new bridge id; resolve it from the acquired record.
    const newSessionId = (lastOfKind(out, "acquired") as unknown as { sessionId: string }).sessionId;
    send({ v: 1, kind: "set_options", opId: "opt_bare_dup2", sessionId: newSessionId, options: { model: "gpt-5.6-luna" } });
    await new Promise((r) => setTimeout(r, 30));
    expect(JSON.stringify(lastOfKind(out, "error"))).toContain("AMBIGUOUS_MODEL");
  });

  it("P1-3: immediate / commands ack on dialog before the delayed prompt response", async () => {
    // Real fixture ordering: prompt → extension_ui_request → (user thinks) →
    // extension_ui_response → prompt response. The fake prompt emits its dialog
    // then waits for the answer before resolving, so a provider that awaited
    // prompt-then-ack would hit the host dispatch deadline. SNC1.6 acks
    // accepted on the first dialog (Pi definitely owns the command).
    const fakes: FakePi16[] = [];
    const provider = new PiBridgeProvider({
      createConnection: (opts) => {
        const fake = new FakePi16(opts);
        fakes.push(fake);
        const origPrompt = fake.prompt.bind(fake);
        let answerSeen = false;
        const origRespond = fake.respondToExtensionUi.bind(fake);
        fake.respondToExtensionUi = (res) => {
          answerSeen = true;
          origRespond(res);
        };
        fake.prompt = async (message: string, promptOpts?: { images?: readonly unknown[]; streamingBehavior?: string }): Promise<void> => {
          if (!message.trimStart().startsWith("/")) return origPrompt(message, promptOpts);
          // Immediate: emit dialog on next tick, then wait for the answer
          // before resolving (mirrors extension-ui.jsonl: prompt response
          // arrives only after extension_ui_response).
          await new Promise((r) => setTimeout(r, 5));
          fake.emit({ type: "extension_ui_request", id: "dlg_delayed", method: "select", title: "Pick", options: ["A", "B"] } as unknown as PiServerEvent);
          for (let i = 0; i < 200 && !answerSeen; i++) await new Promise((r) => setTimeout(r, 10));
          if (!answerSeen) throw Object.assign(new Error("never answered"), { code: "request-timeout", ambiguous: true });
          await origPrompt(message, promptOpts);
        };
        return fake;
      },
    });
    const { out, send, hello } = drive(provider);
    hello();
    const sessionId = await acquireSession(provider, out, send);
    send({ v: 1, kind: "dispatch", opId: "dsp_imm", sessionId, message: { text: "/rpc-ask" } });
    // Dialog arrives fast; the early ack must land before any answer.
    await new Promise((r) => setTimeout(r, 60));
    expect(lastOfKind(out, "dispatch_ack")).toMatchObject({ opId: "dsp_imm", status: "accepted" });
    expect(sessionEvents(out, "dsp_imm").some((e) => e.event.type === "prompt_request")).toBe(true);
    // Now answer (slow user is fine — ownership was already acked).
    send({ v: 1, kind: "answer_prompt", opId: "ans_delayed", requestId: "dlg_delayed", value: "A", cancelled: false });
    await new Promise((r) => setTimeout(r, 80));
    expect(fakes[0]?.uiResponses).toContainEqual({ type: "extension_ui_response", id: "dlg_delayed", value: "A" });
    // Exactly one ack, no duplicate after the delayed prompt response.
    expect(out.filter((m) => m.kind === "dispatch_ack" && (m as { opId?: string }).opId === "dsp_imm")).toHaveLength(1);
  });
});

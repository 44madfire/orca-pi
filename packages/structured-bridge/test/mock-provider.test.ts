import { describe, expect, it } from "vitest";
import { MockExternalProvider } from "../src/provider.js";
import type { ProviderToHostMessage } from "../src/protocol.js";
import { serializeBridgeLine } from "../src/framing.js";

/** Drive a provider in-process and collect its replies. */
function drive(provider: MockExternalProvider) {
  const out: ProviderToHostMessage[] = [];
  provider.attachTestTransport((msg) => out.push(msg));
  const send = (obj: unknown) => provider.onLine(typeof obj === "string" ? obj : serializeBridgeLine(obj).trimEnd());
  const hello = (opId = "hello_1") => {
    send({ v: 1, kind: "hello", opId, host: { id: "orca", version: "test", protocol: 1 }, workspaceRoot: "/tmp/ws" });
  };
  return { out, send, hello };
}

function lastOfKind(out: ProviderToHostMessage[], kind: string): ProviderToHostMessage & Record<string, unknown> {
  const found = [...out].reverse().find((m) => m.kind === kind);
  if (!found) throw new Error(`no ${kind} in ${out.map((m) => m.kind).join(",")}`);
  return found as ProviderToHostMessage & Record<string, unknown>;
}

describe("MockExternalProvider (SNC1.3)", () => {
  it("requires hello first (fail-closed)", () => {
    const provider = new MockExternalProvider();
    const { out, send } = drive(provider);
    send({ v: 1, kind: "acquire", opId: "acq_1", workspaceRoot: "/tmp/ws" });
    expect(lastOfKind(out, "error")).toMatchObject({ error: { code: "HELLO_REQUIRED" } });
  });

  it("refuses incompatible host protocol", () => {
    const provider = new MockExternalProvider();
    const { out, send } = drive(provider);
    send({ v: 1, kind: "hello", opId: "hello_1", host: { id: "orca", version: "t", protocol: 2 }, workspaceRoot: "/tmp/ws" });
    expect(lastOfKind(out, "error")).toMatchObject({ error: { code: "BAD_MESSAGE" } });
  });

  it("acquires isolated sessions with metadata", () => {
    const provider = new MockExternalProvider();
    const { out, hello, send } = drive(provider);
    hello();
    expect(lastOfKind(out, "hello_ok")).toMatchObject({ provider: { id: "mock" } });
    send({ v: 1, kind: "acquire", opId: "acq_1", workspaceRoot: "/tmp/ws", options: { model: "m" } });
    const acquired = lastOfKind(out, "acquired") as unknown as { sessionId: string; resumed: boolean; metadata: { model?: string } };
    expect(acquired.resumed).toBe(false);
    expect(acquired.metadata.model).toBe("m");
    // Re-acquire with the same id resumes.
    send({ v: 1, kind: "acquire", opId: "acq_2", workspaceRoot: "/tmp/ws", sessionId: acquired.sessionId });
    expect(lastOfKind(out, "acquired")).toMatchObject({ resumed: true });
  });

  it("rejects empty dispatches and unknown sessions honestly", () => {
    const provider = new MockExternalProvider();
    const { out, hello, send } = drive(provider);
    hello();
    send({ v: 1, kind: "dispatch", opId: "dsp_1", sessionId: "nope", message: { text: "hi" } });
    expect(lastOfKind(out, "dispatch_ack")).toMatchObject({ status: "rejected" });
    send({ v: 1, kind: "acquire", opId: "acq_1", workspaceRoot: "/tmp/ws" });
    const sessionId = (lastOfKind(out, "acquired") as unknown as { sessionId: string }).sessionId;
    send({ v: 1, kind: "dispatch", opId: "dsp_2", sessionId, message: { text: "   " } });
    expect(lastOfKind(out, "dispatch_ack")).toMatchObject({ status: "rejected", reason: "empty-text" });
  });

  it("reports malformed JSON without crashing", () => {
    const provider = new MockExternalProvider();
    const { out, send, hello } = drive(provider);
    send("not-json{{{");
    expect(lastOfKind(out, "error")).toMatchObject({ error: { code: "PARSE_ERROR" } });
    hello();
    expect(lastOfKind(out, "hello_ok")).toBeDefined();
  });

  it("recovers a failed turn with shaped turn_end/settled and unsticks the session", async () => {
    const provider = new MockExternalProvider();
    const { out, hello, send } = drive(provider);
    hello();
    send({ v: 1, kind: "acquire", opId: "acq_1", workspaceRoot: "/tmp/ws" });
    const sessionId = (lastOfKind(out, "acquired") as unknown as { sessionId: string }).sessionId;
    send({ v: 1, kind: "dispatch", opId: "dsp_1", sessionId, message: { text: "__throw__" } });
    expect(lastOfKind(out, "dispatch_ack")).toMatchObject({ status: "accepted" });
    // The async rejection must surface as protocol events, not an unhandled rejection.
    await new Promise((r) => setTimeout(r, 30));
    const events = out.filter((m) => m.kind === "session_event").map((m) => (m as unknown as { event: { type: string; stopReason?: string } }).event);
    expect(events.map((e) => e.type)).toEqual(["turn_end", "settled"]);
    expect(events[0]).toMatchObject({ stopReason: "error" });
    // The session is unstuck: the next dispatch is accepted, not busy-rejected.
    send({ v: 1, kind: "dispatch", opId: "dsp_2", sessionId, message: { text: "after failure" } });
    expect(lastOfKind(out, "dispatch_ack")).toMatchObject({ opId: "dsp_2", status: "accepted" });
  });

  it("queues busy steer/followUp FIFO without concurrent turns", async () => {
    const provider = new MockExternalProvider({ textChunkSize: 4 });
    const { out, hello, send } = drive(provider);
    hello();
    send({ v: 1, kind: "acquire", opId: "acq_1", workspaceRoot: "/tmp/ws" });
    const sessionId = (lastOfKind(out, "acquired") as unknown as { sessionId: string }).sessionId;
    send({ v: 1, kind: "dispatch", opId: "dsp_1", sessionId, message: { text: "first " + "x".repeat(48) } });
    send({ v: 1, kind: "dispatch", opId: "dsp_2", sessionId, message: { text: "steered" }, queue: "steer" });
    expect(lastOfKind(out, "dispatch_ack")).toMatchObject({ opId: "dsp_2", status: "accepted" });
    // Poll for both turns to settle (chunked streaming yields per delta).
    const deadline = Date.now() + 5000;
    for (;;) {
      const settled = out.filter(
        (m) => m.kind === "session_event" && (m as unknown as { event: { type: string } }).event.type === "settled",
      );
      if (settled.length >= 2 || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const stream = out
      .filter((m) => m.kind === "session_event")
      .map((m) => m as unknown as { opId?: string; event: { type: string } });
    const firstSettledAt = stream.findIndex((m) => m.opId === "dsp_1" && m.event.type === "settled");
    const secondStartAt = stream.findIndex((m) => m.opId === "dsp_2" && m.event.type === "turn_start");
    expect(firstSettledAt).toBeGreaterThanOrEqual(0);
    expect(secondStartAt).toBeGreaterThan(firstSettledAt);
    // No interleaving: every first-turn delta precedes the queued turn start.
    const stray = stream.findIndex((m, i) => m.opId === "dsp_1" && m.event.type === "text_delta" && i > secondStartAt);
    expect(stray).toBe(-1);
    expect(stream.filter((m) => m.opId === "dsp_2" && m.event.type === "settled")).toHaveLength(1);
  });

  it("reports cancel settled state honestly (active vs idle)", async () => {
    const provider = new MockExternalProvider({ textChunkSize: 2 });
    const { out, hello, send } = drive(provider);
    hello();
    send({ v: 1, kind: "acquire", opId: "acq_1", workspaceRoot: "/tmp/ws" });
    const sessionId = (lastOfKind(out, "acquired") as unknown as { sessionId: string }).sessionId;
    send({ v: 1, kind: "dispatch", opId: "dsp_1", sessionId, message: { text: "long " + "y".repeat(64) } });
    // Cancelling the streaming turn marks it: not yet settled (settled event follows).
    send({ v: 1, kind: "cancel", opId: "cnl_1", sessionId, targetOpId: "dsp_1" });
    expect(lastOfKind(out, "cancelled")).toMatchObject({ settled: false });
    await new Promise((r) => setTimeout(r, 50));
    // Idle session: already settled.
    send({ v: 1, kind: "cancel", opId: "cnl_2", sessionId });
    expect(lastOfKind(out, "cancelled")).toMatchObject({ settled: true });
  });

  it("paginates history with nextCursor and a stable leafId", async () => {
    const provider = new MockExternalProvider({ textChunkSize: 64 });
    const { out, hello, send } = drive(provider);
    hello();
    send({ v: 1, kind: "acquire", opId: "acq_1", workspaceRoot: "/tmp/ws" });
    const sessionId = (lastOfKind(out, "acquired") as unknown as { sessionId: string }).sessionId;
    send({ v: 1, kind: "dispatch", opId: "dsp_1", sessionId, message: { text: "one" } });
    await new Promise((r) => setTimeout(r, 30));
    send({ v: 1, kind: "dispatch", opId: "dsp_2", sessionId, message: { text: "two" } });
    await new Promise((r) => setTimeout(r, 30));
    send({ v: 1, kind: "get_history", opId: "his_1", sessionId, limit: 3 });
    const page1 = lastOfKind(out, "history") as unknown as { entries: { id: string }[]; nextCursor?: string; leafId?: string };
    expect(page1.entries).toHaveLength(3);
    expect(page1.nextCursor).toBe(page1.entries[2]?.id);
    const leaf = page1.leafId;
    expect(leaf).toBeTruthy();
    send({ v: 1, kind: "get_history", opId: "his_2", sessionId, cursor: page1.nextCursor });
    const page2 = lastOfKind(out, "history") as unknown as { entries: { id: string }[]; nextCursor?: string; leafId?: string };
    expect(page2.entries).toHaveLength(1);
    expect(page2.nextCursor).toBeUndefined();
    expect(page2.leafId).toBe(leaf);
    // Untruncated history carries no cursor but the same leaf.
    send({ v: 1, kind: "get_history", opId: "his_3", sessionId });
    const full = lastOfKind(out, "history") as unknown as { entries: { id: string }[]; nextCursor?: string; leafId?: string };
    expect(full.entries).toHaveLength(4);
    expect(full.nextCursor).toBeUndefined();
    expect(full.leafId).toBe(leaf);
  });

  it("keeps no global state across instances (restart independence)", async () => {
    const first = new MockExternalProvider();
    const d1 = drive(first);
    d1.hello();
    d1.send({ v: 1, kind: "acquire", opId: "acq_1", workspaceRoot: "/tmp/ws" });
    const sessionId = (lastOfKind(d1.out, "acquired") as unknown as { sessionId: string }).sessionId;

    const second = new MockExternalProvider();
    const d2 = drive(second);
    d2.hello("hello_2");
    d2.send({ v: 1, kind: "dispatch", opId: "dsp_1", sessionId, message: { text: "stale" } });
    expect(lastOfKind(d2.out, "dispatch_ack")).toMatchObject({ status: "rejected", reason: "unknown-session" });
  });
});

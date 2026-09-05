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

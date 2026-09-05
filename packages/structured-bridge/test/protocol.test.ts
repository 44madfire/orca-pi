import { describe, expect, it } from "vitest";
import {
  BRIDGE_PROTOCOL_VERSION,
  createOpId,
  findCredentialField,
  isBridgeMessage,
  redactSecretsFromText,
  validateBridgeMessage,
  __resetOpCounterForTests,
} from "../src/protocol.js";
import {
  mapBridgeDispatchToPiPrompt,
  mapPiRecordToBridgeEvents,
  piBridgeCapabilities,
  validatePiDispatch,
} from "../src/pi-mapping.js";

describe("bridge protocol validation (SNC1.3)", () => {
  it("accepts well-formed hello/dispatch/session_event", () => {
    expect(
      isBridgeMessage({ v: 1, kind: "hello", opId: "hello_1", host: { id: "orca", version: "0.1.0", protocol: 1 }, workspaceRoot: "/tmp/ws" }),
    ).toBe(true);
    expect(
      isBridgeMessage({ v: 1, kind: "dispatch", opId: "dsp_1", sessionId: "ses_1", message: { text: "hi" } }),
    ).toBe(true);
    expect(
      isBridgeMessage({ v: 1, kind: "session_event", sessionId: "ses_1", opId: "dsp_1", event: { type: "text_delta", delta: "hi" } }),
    ).toBe(true);
  });

  it("rejects bad versions, unknown kinds, and missing opIds fail-closed", () => {
    expect(validateBridgeMessage({ v: 2, kind: "hello", opId: "x", host: { protocol: 2 } })).toBe("bad-version");
    expect(validateBridgeMessage({ v: 1, kind: "teleport", opId: "x" })).toBe("unknown-kind");
    expect(validateBridgeMessage({ v: 1, kind: "dispatch", sessionId: "s", message: { text: "hi" } })).toBe("missing-opId");
    expect(validateBridgeMessage({ v: 1, kind: "dispatch", opId: "x", sessionId: "s", message: {} })).toBe("dispatch-missing-text");
    expect(validateBridgeMessage({ v: 1, kind: "hello", opId: "x", host: { protocol: 2 } })).toBe("hello-bad-protocol");
  });

  it("forbids credential/environment fields on the wire", () => {
    for (const key of ["env", "auth", "apiKey", "token", "credentials", "processEnv", "secret"]) {
      expect(findCredentialField({ v: 1, kind: "hello", opId: "x", [key]: "value" })).not.toBeNull();
      expect(validateBridgeMessage({ v: 1, kind: "hello", opId: "x", host: { protocol: 1 }, [key]: "shh" })).toBe("credential-field");
    }
    expect(findCredentialField({ v: 1, kind: "dispatch", nested: { bearerToken: "x" } })).not.toBeNull();
    expect(findCredentialField({ v: 1, kind: "dispatch", opId: "x", message: { text: "hello" } })).toBeNull();
  });

  it("creates unique operation ids", () => {
    __resetOpCounterForTests();
    const a = createOpId("dsp");
    const b = createOpId("dsp");
    expect(a).not.toBe(b);
    expect(a.startsWith("dsp_")).toBe(true);
  });

  it("redacts secret-like values and bounds diagnostics", () => {
    expect(redactSecretsFromText("bearer abcdefghijklmnop", 100)).toContain("[redacted]");
    expect(redactSecretsFromText("sk-proj-abcdefghijklmnopqr", 100)).toContain("[redacted]");
    expect(redactSecretsFromText("plain diagnostic", 100)).toBe("plain diagnostic");
    expect(redactSecretsFromText("x".repeat(1000), 10)).toHaveLength(10);
  });
});

describe("Pi mapping stays out of the generic core (SNC1.3)", () => {
  it("advertises image support per model (client-side gate)", () => {
    expect(piBridgeCapabilities("opencode-go/glm-5.3-flash").images).toBe(true);
    expect(piBridgeCapabilities("deepseek-v4-flash").images).toBe(false);
  });

  it("rejects Pi-lenient inputs early (bogus thinking, bad images)", () => {
    expect(validatePiDispatch({ text: "  " }).ok).toBe(false);
    expect(validatePiDispatch({ text: "hi" }, { thinkingLevel: "bogus" }).ok).toBe(false);
    expect(validatePiDispatch({ text: "hi" }, { thinkingLevel: "high" }).ok).toBe(true);
    expect(validatePiDispatch({ text: "hi", images: [{ data: "eA==", mimeType: "image/png" }] }, {}, "deepseek-v4-flash").ok).toBe(false);
    expect(validatePiDispatch({ text: "hi", images: [{ data: "eA==", mimeType: "image/png" }] }, {}, "opencode-go/glm-5.3-flash").ok).toBe(true);
    expect(validatePiDispatch({ text: "hi", images: [{ data: "", mimeType: "image/png" }] }).ok).toBe(false);
  });

  it("maps bridge queue to Pi streamingBehavior without credentials", () => {
    expect(mapBridgeDispatchToPiPrompt("dsp_1", { text: "hi" })).toEqual({ type: "prompt", id: "dsp_1", message: "hi" });
    expect(mapBridgeDispatchToPiPrompt("dsp_2", { text: "hi" }, "steer")).toMatchObject({ streamingBehavior: "steer" });
    expect(mapBridgeDispatchToPiPrompt("dsp_3", { text: "hi" }, "followUp")).toMatchObject({ streamingBehavior: "followUp" });
    const withImage = mapBridgeDispatchToPiPrompt("dsp_4", { text: "see", images: [{ data: "eA==", mimeType: "image/png" }] });
    expect(withImage.images).toEqual([{ type: "image", data: "eA==", mimeType: "image/png" }]);
  });

  it("maps Pi records to bridge events and ignores fire-and-forget UI", () => {
    expect(mapPiRecordToBridgeEvents({ type: "agent_settled" })).toEqual([{ type: "settled", willRetry: false }]);
    expect(mapPiRecordToBridgeEvents({ type: "text_delta", delta: "he", contentIndex: 1 })).toEqual([
      { type: "text_delta", delta: "he", contentIndex: 1 },
    ]);
    expect(
      mapPiRecordToBridgeEvents({ type: "message_update", update: { kind: "text_delta", delta: "llo", contentIndex: 1 } }),
    ).toEqual([{ type: "text_delta", delta: "llo", contentIndex: 1 }]);
    expect(mapPiRecordToBridgeEvents({ type: "tool_execution_update", toolCallId: "call_1", partialResult: "tick" })).toEqual([
      { type: "tool_progress", toolCallId: "call_1", partialResult: "tick" },
    ]);
    // Spinner title / notify / unknown futures never become streamed events.
    expect(mapPiRecordToBridgeEvents({ type: "extension_ui_request", id: "u1", kind: "setTitle", title: "spin" })).toEqual([]);
    expect(mapPiRecordToBridgeEvents({ type: "extension_ui_request", id: "u2", kind: "notify", message: "hi" })).toEqual([]);
    expect(mapPiRecordToBridgeEvents({ type: "response", command: "get_state", success: true })).toEqual([]);
    expect(mapPiRecordToBridgeEvents({ type: "some_future_event", data: 1 })).toEqual([]);
    // Dialogs map to prompt_request for Orca options UI.
    expect(
      mapPiRecordToBridgeEvents({ type: "extension_ui_request", id: "u3", kind: "select", prompt: { kind: "select", title: "Pick", options: ["a"] } }),
    ).toEqual([{ type: "prompt_request", requestId: "u3", prompt: { kind: "select", title: "Pick", options: ["a"] } }]);
    expect(BRIDGE_PROTOCOL_VERSION).toBe(1);
  });
});

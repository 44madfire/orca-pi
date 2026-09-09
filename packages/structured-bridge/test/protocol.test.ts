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

  it("redacts every secret occurrence, not just the first per kind", () => {
    const twoBearers = "bearer abcdefghijklmnop then bearer qrstuvwxyz123456";
    const redactedBearers = redactSecretsFromText(twoBearers, 200);
    expect(redactedBearers).not.toContain("abcdefghijklmnop");
    expect(redactedBearers).not.toContain("qrstuvwxyz123456");
    const twoKeys = "sk-proj-abcdefghijklmnopqr and sk-1234567890abcdef";
    const redactedKeys = redactSecretsFromText(twoKeys, 200);
    expect(redactedKeys).not.toContain("abcdefghijklmnopqr");
    expect(redactedKeys).not.toContain("1234567890abcdef");
    const mixed = "bearer abcdefghijklmnop sk-proj-abcdefghijklmnopqr bearer qrstuvwxyz123456";
    expect(redactSecretsFromText(mixed, 200)).not.toMatch(/[A-Za-z0-9]{16}/);
  });

  it("validates every wire variant's required payload fields", () => {
    // Malformed hello_ok (the reported crash): accepted opId alone is not enough.
    expect(validateBridgeMessage({ v: 1, kind: "hello_ok", opId: "x" })).toBe("hello_ok-missing-provider");
    expect(validateBridgeMessage({ v: 1, kind: "hello_ok", opId: "x", provider: { id: "p", version: "v", protocol: 1 } })).toBe(
      "hello_ok-missing-capabilities",
    );
    // Host → provider variants.
    expect(
      validateBridgeMessage({ v: 1, kind: "hello", opId: "x", host: { id: "orca", version: "t", protocol: 1 } }),
    ).toBe("hello-missing-workspaceRoot");
    expect(validateBridgeMessage({ v: 1, kind: "hello", opId: "x", host: { protocol: 1 }, workspaceRoot: "/w" })).toBe(
      "hello-bad-protocol",
    );
    expect(validateBridgeMessage({ v: 1, kind: "acquire", opId: "x" })).toBe("acquire-missing-workspaceRoot");
    expect(validateBridgeMessage({ v: 1, kind: "release", opId: "x" })).toBe("release-missing-sessionId");
    expect(validateBridgeMessage({ v: 1, kind: "dispatch", opId: "x", message: { text: "hi" } })).toBe("dispatch-missing-sessionId");
    expect(validateBridgeMessage({ v: 1, kind: "cancel", opId: "x" })).toBe("cancel-missing-sessionId");
    expect(validateBridgeMessage({ v: 1, kind: "answer_prompt", opId: "x", requestId: "r" })).toBe("answer_prompt-missing-cancelled");
    expect(validateBridgeMessage({ v: 1, kind: "answer_prompt", opId: "x", cancelled: false })).toBe("answer_prompt-missing-requestId");
    expect(validateBridgeMessage({ v: 1, kind: "set_options", opId: "x", sessionId: "s" })).toBe("set_options-missing-options");
    expect(validateBridgeMessage({ v: 1, kind: "get_history", opId: "x" })).toBe("get_history-missing-sessionId");
    expect(validateBridgeMessage({ v: 1, kind: "get_session", opId: "x" })).toBe("get_session-missing-sessionId");
    expect(validateBridgeMessage({ v: 1, kind: "close", opId: "x", mode: "eventually" })).toBe("close-missing-mode");
    // Provider → host variants.
    expect(validateBridgeMessage({ v: 1, kind: "hello_error", opId: "x" })).toBe("hello_error-missing-error");
    expect(validateBridgeMessage({ v: 1, kind: "acquired", opId: "x", sessionId: "s", resumed: true })).toBe("acquired-missing-metadata");
    expect(validateBridgeMessage({ v: 1, kind: "released", opId: "x" })).toBe("released-missing-sessionId");
    expect(validateBridgeMessage({ v: 1, kind: "dispatch_ack", opId: "x", sessionId: "s", status: "maybe" })).toBe("dispatch_ack-missing-status");
    expect(validateBridgeMessage({ v: 1, kind: "cancelled", opId: "x", sessionId: "s", targetOpId: "t" })).toBe("cancelled-missing-settled");
    expect(validateBridgeMessage({ v: 1, kind: "options_updated", opId: "x", sessionId: "s" })).toBe("options_updated-missing-options");
    expect(validateBridgeMessage({ v: 1, kind: "history", opId: "x", sessionId: "s" })).toBe("history-missing-entries");
    expect(validateBridgeMessage({ v: 1, kind: "session", opId: "x", sessionId: "s" })).toBe("session-missing-metadata");
    expect(validateBridgeMessage({ v: 1, kind: "session_event", sessionId: "s", event: { noType: true } })).toBe("event-missing-event");
    expect(validateBridgeMessage({ v: 1, kind: "closed", opId: "x" })).toBe("closed-missing-exit");
    expect(validateBridgeMessage({ v: 1, kind: "exiting", exit: { code: 0, signal: null } })).toBe("exiting-missing-reason");
    expect(validateBridgeMessage({ v: 1, kind: "error", error: { code: "X" } })).toBe("error-missing-error");
  });

  it("validates required inner fields downstream code relies on", () => {
    const caps = {
      textStreaming: true,
      thinking: true,
      tools: true,
      images: true,
      extensionDialogs: true,
      history: true,
      options: true,
      cancel: true,
      resume: true,
    };
    const provider = { id: "p", version: "v", protocol: 1 };
    // Empty capabilities must not read as available: every flag is required.
    expect(validateBridgeMessage({ v: 1, kind: "hello_ok", opId: "x", provider, capabilities: {} })).toBe(
      "hello_ok-bad-capabilities",
    );
    expect(validateBridgeMessage({ v: 1, kind: "hello_ok", opId: "x", provider, capabilities: { ...caps, tools: "yes" } })).toBe(
      "hello_ok-bad-capabilities",
    );
    expect(validateBridgeMessage({ v: 1, kind: "hello_ok", opId: "x", provider, capabilities: caps })).toBeNull();
    // Session metadata inner fields.
    const meta = { sessionId: "s", workspaceRoot: "/w", messageCount: 0, isStreaming: false, createdAt: "t" };
    expect(validateBridgeMessage({ v: 1, kind: "acquired", opId: "x", sessionId: "s", resumed: false, metadata: {} })).toBe(
      "acquired-bad-metadata",
    );
    expect(validateBridgeMessage({ v: 1, kind: "acquired", opId: "x", sessionId: "s", resumed: false, metadata: meta })).toBeNull();
    expect(validateBridgeMessage({ v: 1, kind: "session", opId: "x", sessionId: "s", metadata: { sessionId: "s" } })).toBe(
      "session-bad-metadata",
    );
    // History entry identity + role.
    expect(
      validateBridgeMessage({ v: 1, kind: "history", opId: "x", sessionId: "s", entries: [{ id: "e1", role: "wizard" }] }),
    ).toBe("history-bad-entry");
    expect(
      validateBridgeMessage({ v: 1, kind: "history", opId: "x", sessionId: "s", entries: [{ role: "user" }] }),
    ).toBe("history-bad-entry");
    expect(
      validateBridgeMessage({ v: 1, kind: "history", opId: "x", sessionId: "s", entries: [{ id: "e1", role: "user" }] }),
    ).toBeNull();
    // Event payloads the renderer correlates on.
    expect(validateBridgeMessage({ v: 1, kind: "session_event", sessionId: "s", event: { type: "text_delta" } })).toBe(
      "event-bad-text_delta",
    );
    expect(
      validateBridgeMessage({ v: 1, kind: "session_event", sessionId: "s", event: { type: "tool_end", toolCallId: "c" } }),
    ).toBe("event-bad-tool_end");
    expect(validateBridgeMessage({ v: 1, kind: "session_event", sessionId: "s", event: { type: "turn_end", stopReason: "maybe" } })).toBe(
      "event-bad-turn_end",
    );
    expect(
      validateBridgeMessage({
        v: 1,
        kind: "session_event",
        sessionId: "s",
        event: { type: "prompt_request", requestId: "r", prompt: { kind: "select", title: "Pick", options: ["a"] } },
      }),
    ).toBeNull();
    // Unknown event types never become trusted listener state.
    expect(validateBridgeMessage({ v: 1, kind: "session_event", sessionId: "s", event: { type: "bogus" } })).toBe(
      "event-unknown-type",
    );
    // Prompt unions: each kind's required fields, unknown kinds rejected.
    const promptCases: Array<{ prompt: unknown; valid: boolean }> = [
      { prompt: { kind: "select", title: "Pick", options: ["a", "b"] }, valid: true },
      { prompt: { kind: "select" }, valid: false },
      { prompt: { kind: "select", title: "Pick", options: [] }, valid: false },
      { prompt: { kind: "select", title: "Pick", options: [42] }, valid: false },
      { prompt: { kind: "confirm", title: "Sure?", message: "Really" }, valid: true },
      { prompt: { kind: "confirm", title: "Sure?" }, valid: false },
      { prompt: { kind: "input", title: "Name" }, valid: true },
      { prompt: { kind: "input", title: "Name", placeholder: 7 }, valid: false },
      { prompt: { kind: "editor", title: "Edit", prefill: "x" }, valid: true },
      { prompt: { kind: "wizard" }, valid: false },
    ];
    for (const { prompt, valid } of promptCases) {
      expect(
        validateBridgeMessage({ v: 1, kind: "session_event", sessionId: "s", event: { type: "prompt_request", requestId: "r", prompt } }),
      ).toBe(valid ? null : "event-bad-prompt_request");
    }
    // Options bags: shared string/enum/boolean shapes.
    expect(validateBridgeMessage({ v: 1, kind: "set_options", opId: "x", sessionId: "s", options: { thinkingLevel: 42 } })).toBe(
      "set_options-bad-options",
    );
    expect(
      validateBridgeMessage({ v: 1, kind: "set_options", opId: "x", sessionId: "s", options: { queueMode: "eventually" } }),
    ).toBe("set_options-bad-options");
    expect(
      validateBridgeMessage({
        v: 1,
        kind: "set_options",
        opId: "x",
        sessionId: "s",
        options: { model: "m", thinkingLevel: "high", queueMode: "steer", autoCompaction: true },
      }),
    ).toBeNull();
    // Dispatch queue enum.
    expect(
      validateBridgeMessage({ v: 1, kind: "dispatch", opId: "x", sessionId: "s", message: { text: "hi" }, queue: "typo" }),
    ).toBe("dispatch-bad-queue");
    expect(
      validateBridgeMessage({ v: 1, kind: "dispatch", opId: "x", sessionId: "s", message: { text: "hi" }, queue: "followUp" }),
    ).toBeNull();
    // Exit blocks and limits.
    expect(validateBridgeMessage({ v: 1, kind: "closed", opId: "x", exit: { code: "zero", signal: null } })).toBe("closed-missing-exit");
    for (const limit of [0, -1, 1.5, "3", NaN]) {
      expect(validateBridgeMessage({ v: 1, kind: "get_history", opId: "x", sessionId: "s", limit })).toBe("get_history-bad-limit");
    }
    expect(validateBridgeMessage({ v: 1, kind: "get_history", opId: "x", sessionId: "s", limit: 3 })).toBeNull();
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

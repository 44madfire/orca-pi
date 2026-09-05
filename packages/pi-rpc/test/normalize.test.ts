import { describe, expect, it } from "vitest";
import { assertLfOnlyJsonl, assertSecretFreeLine, createRecordNormalizer, normalizeRecord } from "../src/normalize.js";

describe("fixture normalization + secret hygiene", () => {
  it("replaces volatile ids/timestamps/paths while preserving shape", () => {
    const out = normalizeRecord({
      sessionId: "01a0720e-101d-738c-9804-d59995b84b29",
      leafId: "bc4d9642",
      timestamp: "2026-09-05T14:52:58.330Z",
      epoch: 1788619977010,
      sessionFile: "C:\\Users\\someone\\AppData\\Local\\Temp\\pi-rpc-x\\sessions\\a.jsonl",
      nested: { id: "8252cf90", parentId: "329506df", toolCallId: "call_90eb177fe4494c41a85183d7" },
      usage: { input: 1513, output: 5 },
      sentAt: 1788619977010,
      stamp: { timestamp: 1788619977010 },
    }) as Record<string, unknown>;
    expect(out["sessionId"]).toBe("<SESSION_1>");
    expect(out["leafId"]).toBe("<ENTRY_1>");
    // Numeric epoch-ms under a timestamp key becomes the fixed sentinel…
    expect((out["stamp"] as Record<string, unknown>)["timestamp"]).toBe(1700000000000);
    // …while other numbers (usage, unrelated keys) stay raw.
    expect((out as Record<string, unknown>)["sentAt"]).toBe(1788619977010);
    expect(out["usage"]).toEqual({ input: 1513, output: 5 });
    expect(JSON.stringify(out)).not.toContain("01a0720e");
    expect(JSON.stringify(out)).not.toContain("C:\\Users");
  });

  it("preserves identity: same raw id maps to the same alias across records", () => {
    const n = createRecordNormalizer();
    const first = n.normalize({ id: "8252cf90", parentId: null }) as Record<string, unknown>;
    const second = n.normalize({ id: "bc4d9642", parentId: "8252cf90" }) as Record<string, unknown>;
    const leaf = n.normalize({ leafId: "bc4d9642" }) as Record<string, unknown>;
    expect(first["id"]).toBe("<ENTRY_1>");
    expect(second["id"]).toBe("<ENTRY_2>");
    // parentId points at the first entry's alias; leafId names the second.
    expect(second["parentId"]).toBe(first["id"]);
    expect(leaf["leafId"]).toBe(second["id"]);
  });

  it("correlates tool calls and extension UI ids across frames", () => {
    const n = createRecordNormalizer();
    const start = n.normalize({ toolCallId: "call_90eb177fe4494c41a85183d7" }) as Record<string, unknown>;
    const end = n.normalize({ toolCallId: "call_90eb177fe4494c41a85183d7" }) as Record<string, unknown>;
    expect(start["toolCallId"]).toBe("<CALL_1>");
    expect(end["toolCallId"]).toBe(start["toolCallId"]);
    const req = n.normalize({ type: "extension_ui_request", id: "340054b6-dc0f-42f5-b5a6-7a9400a2301f", method: "select" }) as Record<string, unknown>;
    const res = n.normalize({ type: "extension_ui_response", id: "340054b6-dc0f-42f5-b5a6-7a9400a2301f", value: "Apple" }) as Record<string, unknown>;
    expect(req["id"]).toBe("<EXT_UI_1>");
    expect(res["id"]).toBe(req["id"]);
  });

  it("fails closed on token-like secrets", () => {
    expect(() => assertSecretFreeLine('{"access":"eyJhbGciOiJSUzI1NiJ9"}', "t")).toThrow();
    expect(() => assertSecretFreeLine('{"refresh":"rt.1.AACzzz"}', "t")).toThrow();
    expect(() => assertSecretFreeLine("bearer abcdefghijklmnop123", "t")).toThrow();
    expect(() => assertSecretFreeLine('{"ok":true}', "t")).not.toThrow();
  });

  it("fails on any raw Windows user path, even beside placeholders", () => {
    expect(() => assertSecretFreeLine('{"a":"<SESSION_FILE>","b":"C:\\Users\\someone\\x"}', "t")).toThrow(/Windows path/);
    expect(() => assertSecretFreeLine('{"a":"C:\\Users\\someone\\x"}', "t")).toThrow(/Windows path/);
    expect(() => assertSecretFreeLine('{"a":"<SESSION_FILE>"}', "t")).not.toThrow();
  });

  it("enforces LF-only valid JSONL", () => {
    expect(() => assertLfOnlyJsonl('{"a":1}\r\n{"b":2}\n', "t")).toThrow(/LF-only/);
    expect(() => assertLfOnlyJsonl('{"a":1}\nnot-json\n', "t")).toThrow(/invalid JSON/);
    expect(() => assertLfOnlyJsonl('{"a":1}\n', "t")).not.toThrow();
  });
});

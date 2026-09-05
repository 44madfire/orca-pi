import { describe, expect, it } from "vitest";
import { assertLfOnlyJsonl, assertSecretFreeLine, normalizeRecord } from "../src/normalize.js";

describe("fixture normalization + secret hygiene", () => {
  it("replaces volatile ids/timestamps/paths while preserving shape", () => {
    const out = normalizeRecord({
      sessionId: "01a0720e-101d-738c-9804-d59995b84b29",
      leafId: "bc4d9642",
      timestamp: "2026-09-05T14:52:58.330Z",
      epoch: 1788619977010,
      sessionFile: "C:\\Users\\jeffr\\AppData\\Local\\Temp\\pi-rpc-x\\sessions\\a.jsonl",
      nested: { id: "8252cf90", parentId: "329506df", toolCallId: "call_90eb177fe4494c41a85183d7" },
      usage: { input: 1513, output: 5 },
    }) as Record<string, unknown>;
    expect(out["sessionId"]).toBe("<SESSION_ID>");
    expect(out["leafId"]).toBe("<LEAF_ID>");
    expect(out["usage"]).toEqual({ input: 1513, output: 5 });
    expect(JSON.stringify(out)).not.toContain("01a0720e");
    expect(JSON.stringify(out)).not.toContain("C:\\Users");
  });

  it("fails closed on token-like secrets", () => {
    expect(() => assertSecretFreeLine('{"access":"eyJhbGciOiJSUzI1NiJ9"}', "t")).toThrow();
    expect(() => assertSecretFreeLine('{"refresh":"rt.1.AACzzz"}', "t")).toThrow();
    expect(() => assertSecretFreeLine("bearer abcdefghijklmnop123", "t")).toThrow();
    expect(() => assertSecretFreeLine('{"ok":true}', "t")).not.toThrow();
  });

  it("enforces LF-only valid JSONL", () => {
    expect(() => assertLfOnlyJsonl('{"a":1}\r\n{"b":2}\n', "t")).toThrow(/LF-only/);
    expect(() => assertLfOnlyJsonl('{"a":1}\nnot-json\n', "t")).toThrow(/invalid JSON/);
    expect(() => assertLfOnlyJsonl('{"a":1}\n', "t")).not.toThrow();
  });
});

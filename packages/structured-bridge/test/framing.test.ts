import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import {
  attachBridgeReader,
  BridgeFramer,
  serializeBridgeLine,
  splitBridgeLines,
} from "../src/framing.js";

// U+2028/U+2029 as escapes (never literals: literals break regex literals in some parsers).
const LS = "\u2028";
const PS = "\u2029";

describe("bridge LF-only framing (SNC1.3)", () => {
  it("serializes with LF only (never CRLF)", () => {
    expect(serializeBridgeLine({ v: 1, kind: "hello" })).toBe('{"v":1,"kind":"hello"}\n');
    expect(serializeBridgeLine({ a: 1 })).not.toContain("\r");
  });

  it("splits on LF only and preserves U+2028/U+2029 inside strings", () => {
    const record = JSON.stringify({ v: 1, kind: "dispatch", message: { text: "A\u2028B\u2029C\n" } });
    const text = `${record}\n${JSON.stringify({ v: 1, kind: "session_event" })}\n`;
    const { lines, rest } = splitBridgeLines(text);
    expect(rest).toBe("");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ kind: "dispatch" });
    // A readline-style split on U+2028/U+2029 would produce >2 records.
    const sep = new RegExp("\r?\n|" + LS + "|" + PS);
    expect(text.split(sep).length).toBeGreaterThan(2);
  });

  it("keeps U+2028/U+2029 intact when chunks split mid-record", () => {
    const line = JSON.stringify({ v: 1, delta: "A\u2028B\u2029C" });
    const bytes = Buffer.from(`${line}\n`, "utf8");
    const lsByte = Buffer.from(LS, "utf8")[0] as number;
    const lsStart = bytes.indexOf(lsByte);
    expect(lsStart).toBeGreaterThan(0);
    for (const cut of [lsStart + 1, lsStart + 2]) {
      const framer = new BridgeFramer();
      expect(framer.push(bytes.subarray(0, cut))).toEqual([]);
      const rest = framer.push(bytes.subarray(cut));
      expect(rest).toHaveLength(1);
      expect(JSON.parse(rest[0] as string)).toEqual({ v: 1, delta: "A\u2028B\u2029C" });
      expect(rest[0]).not.toContain("�");
    }
  });

  it("tolerates CRLF input by stripping one trailing CR", () => {
    const { lines, rest } = splitBridgeLines('{"a":1}\r\n{"b":2}\r\n');
    expect(rest).toBe("");
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("buffers incomplete tails across pushes and flushes on finish", () => {
    const framer = new BridgeFramer();
    expect(framer.push('{"a":')).toEqual([]);
    expect(framer.push('1}\n{"b":2')).toEqual(['{"a":1}']);
    expect(framer.finish()).toEqual(['{"b":2']);
    expect(framer.finish()).toEqual([]);
  });

  it("attachBridgeReader never splits on U+2028/U+2029", () => {
    const stream = new EventEmitter() as EventEmitter & {
      on(event: string, listener: (...args: never[]) => void): unknown;
      off(event: string, listener: (...args: never[]) => void): unknown;
    };
    const seen: string[] = [];
    const detach = attachBridgeReader(stream as never, (line) => seen.push(line));
    const payload = JSON.stringify({ v: 1, delta: "A\u2028B\u2029C" });
    stream.emit("data", Buffer.from(`${payload}\n`, "utf8"));
    expect(seen).toHaveLength(1);
    expect(JSON.parse(seen[0] as string)).toEqual({ v: 1, delta: "A\u2028B\u2029C" });
    stream.emit("data", Buffer.from('{"ok":true}\r\n', "utf8"));
    expect(seen[1]).toBe('{"ok":true}');
    detach();
    stream.emit("data", Buffer.from('{"late":true}\n', "utf8"));
    expect(seen).toHaveLength(2);
  });
});

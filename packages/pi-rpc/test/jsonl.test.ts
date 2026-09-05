import { describe, expect, it } from "vitest";
import { attachJsonlReader, JsonlFramer, serializeJsonLine, splitJsonLines } from "../src/jsonl.js";
import { EventEmitter } from "node:events";

describe("strict LF-only JSONL framing (SNC1.1)", () => {
  it("serializes with LF only (never CRLF)", () => {
    expect(serializeJsonLine({ type: "get_state" })).toBe('{"type":"get_state"}\n');
    expect(serializeJsonLine({ a: 1 })).not.toContain("\r");
  });

  it("splits on LF only and preserves U+2028/U+2029 inside strings", () => {
    const record = JSON.stringify({ type: "bash_execution_update", delta: "A\u2028B\u2029C\n" });
    const text = `${record}\n${JSON.stringify({ type: "response" })}\n`;
    const { lines, rest } = splitJsonLines(text);
    expect(rest).toBe("");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string)).toEqual({ type: "bash_execution_update", delta: "A\u2028B\u2029C\n" });
    // A readline-style split on U+2028/U+2029 would produce >2 records.
    const naive = text.split(/\r?\n|\u2028|\u2029/);
    expect(naive.length).toBeGreaterThan(2);
  });

  it("keeps U+2028/U+2029 intact when chunks split mid-record", () => {
    const framer = new JsonlFramer();
    const line = JSON.stringify({ delta: "A\u2028B\u2029C" });
    const bytes = Buffer.from(`${line}\n`, "utf8");
    const mid = bytes.indexOf(Buffer.from([0xe2, 0x80])[0] as unknown as number);
    void mid;
    // Split the byte stream at an arbitrary point inside the multibyte run.
    const cut = 20;
    const first = framer.push(bytes.subarray(0, cut));
    expect(first).toEqual([]);
    const second = framer.push(bytes.subarray(cut));
    expect(second).toHaveLength(1);
    expect(JSON.parse(second[0] as string)).toEqual({ delta: "A\u2028B\u2029C" });
  });

  it("tolerates CRLF input by stripping one trailing CR", () => {
    const { lines, rest } = splitJsonLines('{"a":1}\r\n{"b":2}\r\n');
    expect(rest).toBe("");
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("buffers incomplete tails across pushes and flushes on finish", () => {
    const framer = new JsonlFramer();
    expect(framer.push('{"a":')).toEqual([]);
    expect(framer.push("1}\n{\"b\":2")).toEqual(['{"a":1}']);
    expect(framer.finish()).toEqual(['{"b":2']);
    expect(framer.finish()).toEqual([]);
  });

  it("attachJsonlReader never splits on U+2028/U+2029 (strict LF reader)", () => {
    const stream = new EventEmitter() as EventEmitter & {
      on(event: string, listener: (...args: never[]) => void): unknown;
      off(event: string, listener: (...args: never[]) => void): unknown;
    };
    const seen: string[] = [];
    const detach = attachJsonlReader(
      stream as unknown as NodeJS.ReadableStream & {
        on(event: string, listener: (...args: never[]) => void): unknown;
        off(event: string, listener: (...args: never[]) => void): unknown;
      },
      (line) => seen.push(line),
    );
    const payload = JSON.stringify({ delta: "A\u2028B\u2029C" });
    stream.emit("data", Buffer.from(`${payload}\n`, "utf8"));
    expect(seen).toHaveLength(1);
    expect(JSON.parse(seen[0] as string)).toEqual({ delta: "A\u2028B\u2029C" });
    // CRLF tolerance on the streaming path.
    stream.emit("data", Buffer.from('{"ok":true}\r\n', "utf8"));
    expect(seen[1]).toBe('{"ok":true}');
    detach();
  });
});

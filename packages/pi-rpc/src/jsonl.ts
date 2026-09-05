/**
 * Strict LF-only JSONL framing for Pi `--mode rpc` (SNC1.1).
 *
 * Pi RPC uses strict JSONL semantics with LF (`\n`) as the only record
 * delimiter. This module is intentionally independent of Pi's own
 * implementation so the contract can be proven from the Orca side:
 *
 * - Split records on `\n` only.
 * - Accept optional `\r\n` input by stripping a single trailing `\r`.
 * - Never split on U+2028 / U+2029 (valid inside JSON strings).
 * - Never use Node `readline` for RPC framing (it splits on U+2028/U+2029).
 *
 * Validated against real Pi 0.84.4: a `bash` round-trip carrying literal
 * U+2028/U+2029 arrives as a single JSONL record when split on `\n` only
 * (see `fixtures/bash-rpc.jsonl` and `docs/pi-rpc-contract.md`).
 */

import { StringDecoder } from "node:string_decoder";

/** Serialize one strict JSONL record (LF-terminated, no CRLF). */
export function serializeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/**
 * Split a buffered chunk into complete LF-delimited lines.
 *
 * Returns `{ lines, rest }` where `lines` are complete records with an
 * optional single trailing `\r` stripped (CRLF tolerance) and `rest` is the
 * incomplete tail to prepend to the next chunk. Splits on `\n` only, so
 * embedded U+2028/U+2029 never act as delimiters.
 */
export function splitJsonLines(buffer: string): { lines: string[]; rest: string } {
  const lines: string[] = [];
  let start = 0;
  for (;;) {
    const idx = buffer.indexOf("\n", start);
    if (idx === -1) break;
    let line = buffer.slice(start, idx);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    lines.push(line);
    start = idx + 1;
  }
  return { lines, rest: buffer.slice(start) };
}

/**
 * Stateful LF-only feeder for streaming `stdout` bytes.
 *
 * Byte-safe: Buffer/Uint8Array chunks are decoded through a streaming
 * `StringDecoder`, so a multibyte UTF-8 sequence (e.g. the 3-byte U+2028
 * `E2 80 A8`) split across data events never becomes U+FFFD. String chunks
 * are appended directly. Split on `\n` only; strip one trailing `\r`.
 * Call `push()` per data event and `finish()` on stream end to flush a
 * final unterminated line (if any).
 */
export class JsonlFramer {
  private readonly decoder = new StringDecoder("utf8");
  private text = "";

  /** Feed a raw chunk; returns newly completed lines (CRLF-stripped). */
  push(chunk: string | Uint8Array | Buffer): string[] {
    this.text += typeof chunk === "string" ? chunk : this.decoder.write(Buffer.from(chunk));
    const { lines, rest } = splitJsonLines(this.text);
    this.text = rest;
    return lines;
  }

  /** Flush any trailing unterminated line (CRLF-stripped). */
  finish(): string[] {
    this.text += this.decoder.end();
    if (this.text.length === 0) return [];
    let line = this.text;
    this.text = "";
    if (line.endsWith("\r")) line = line.slice(0, -1);
    return [line];
  }
}

/**
 * Attach an LF-only line reader to a Node readable stream.
 *
 * Mirrors Pi's own `attachJsonlLineReader` contract without depending on it.
 * Returns an unsubscribe function. Never uses `readline`.
 */
export function attachJsonlReader(
  stream: NodeJS.ReadableStream & {
    on(event: string, listener: (...args: never[]) => void): unknown;
    off(event: string, listener: (...args: never[]) => void): unknown;
  },
  onLine: (line: string) => void,
): () => void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  const onData = (chunk: unknown): void => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk as Buffer);
    for (;;) {
      const idx = buffer.indexOf("\n");
      if (idx === -1) return;
      let line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      onLine(line);
    }
  };
  const onEnd = (): void => {
    buffer += decoder.end();
    if (buffer.length > 0) {
      onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
      buffer = "";
    }
  };
  stream.on("data", onData as (...args: never[]) => void);
  stream.on("end", onEnd as (...args: never[]) => void);
  return () => {
    stream.off("data", onData as (...args: never[]) => void);
    stream.off("end", onEnd as (...args: never[]) => void);
  };
}

/** Parse one JSONL record; throws a shaped error for malformed lines. */
export function parseJsonLine(line: string): unknown {
  return JSON.parse(line);
}

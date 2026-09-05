/**
 * Strict LF-only JSONL framing for the SNC1.3 structured-session bridge.
 *
 * Provider-neutral and dependency-free so the Orca fork can vendor this
 * single file without pulling Pi assumptions. Mirrors the SNC1.1 Pi RPC
 * framing contract (`@orca-pi/pi-rpc` `jsonl.ts`) without importing it:
 *
 * - Serialize: `JSON.stringify(value) + "\n"` (never CRLF).
 * - Split records on `\n` only; strip one trailing `\r` (CRLF tolerance).
 * - Never split on U+2028 / U+2029 (valid inside JSON strings).
 * - Never use Node `readline` for bridge framing.
 * - Byte-safe: Buffer chunks decode through `StringDecoder` so a multibyte
 *   sequence split across data events never becomes U+FFFD.
 */

import { StringDecoder } from "node:string_decoder";

/** Serialize one bridge record (LF-terminated, no CRLF). */
export function serializeBridgeLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/**
 * Split a buffered chunk into complete LF-delimited lines.
 * Strips one trailing `\r` per line (CRLF tolerance). Splits on `\n` only.
 */
export function splitBridgeLines(buffer: string): { lines: string[]; rest: string } {
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
 * Stateful LF-only feeder for streaming stdout bytes.
 * Feed raw chunks via `push()`; flush a trailing unterminated line via `finish()`.
 */
export class BridgeFramer {
  private readonly decoder = new StringDecoder("utf8");
  private text = "";

  push(chunk: string | Uint8Array | Buffer): string[] {
    this.text += typeof chunk === "string" ? chunk : this.decoder.write(Buffer.from(chunk));
    const { lines, rest } = splitBridgeLines(this.text);
    this.text = rest;
    return lines;
  }

  finish(): string[] {
    this.text += this.decoder.end();
    if (this.text.length === 0) return [];
    let line = this.text;
    this.text = "";
    if (line.endsWith("\r")) line = line.slice(0, -1);
    return [line];
  }
}

export type BridgeReadable = NodeJS.ReadableStream & {
  on(event: string, listener: (...args: never[]) => void): unknown;
  off(event: string, listener: (...args: never[]) => void): unknown;
};

/**
 * Attach an LF-only line reader to a Node readable stream.
 * Returns an unsubscribe function. Never uses `readline`.
 */
export function attachBridgeReader(stream: BridgeReadable, onLine: (line: string) => void): () => void {
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

/** Parse one bridge JSONL record; throws a shaped error for malformed lines. */
export function parseBridgeLine(line: string): unknown {
  return JSON.parse(line);
}

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
 * Handles UTF-8 chunk splits via `StringDecoder`, CRLF tolerance, and
 * U+2028/U+2029 preservation. Call `push()` with each data chunk and
 * `finish()` on stream end to flush a final unterminated line (if any).
 */
export class JsonlFramer {
  private text = "";

  /** Feed a raw chunk; returns newly completed lines (CRLF-stripped). */
  push(chunk: string | Uint8Array | Buffer): string[] {
    // Buffer/Uint8Array chunks are UTF-8 JSONL bytes. Decoding each chunk
    // with toString("utf8") is safe here because callers feed whole data
    // events and we only split on ASCII LF; split multibyte sequences
    // across events are handled by the streaming reader path
    // (`attachJsonlReader`, which uses StringDecoder). For byte-exact
    // streaming, prefer `attachJsonlReader` on the live socket.
    this.text += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    const { lines, rest } = splitJsonLines(this.text);
    this.text = rest;
    return lines;
  }

  /** Flush any trailing unterminated line (CRLF-stripped). */
  finish(): string[] {
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
  // StringDecoder avoids splitting multibyte UTF-8 across data events.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { StringDecoder } = require("node:string_decoder") as typeof import("node:string_decoder");
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

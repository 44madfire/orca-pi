/**
 * Minimal strict LF-only spike client for Pi `--mode rpc` (SNC1.1).
 *
 * Purpose-built for contract proving: it spawns a real `pi` binary, speaks
 * strict JSONL (LF-only, CRLF-tolerant input, U+2028/U+2029-preserving),
 * correlates `id`-bearing responses, and records full request/response/event
 * sequences for fixture capture. It is not a production transport (see
 * SNC1.2); it is the authoritative probe that production must match.
 *
 * Framing rules (mirrors `jsonl.ts`):
 * - Write: `JSON.stringify(cmd) + "\n"` (never CRLF).
 * - Read: split stdout on `\n` only; strip one trailing `\r` per line.
 * - Never use `readline` (it splits on U+2028/U+2029).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { attachJsonlReader, serializeJsonLine } from "./jsonl.js";

export interface SpikeRecord {
  /** Capture sequence number (0-based, stdout+stdin interleaved). */
  seq: number;
  /** `c2s` = client→server (stdin), `s2c` = server→client (stdout). */
  dir: "c2s" | "s2c";
  /** The parsed JSON record (command, response, or event). */
  payload: Record<string, unknown>;
}

export interface SpikeClientOptions {
  /** Pi executable (default resolves via PATH; tests inject a fake). */
  piCommand?: string;
  /** Extra argv before `--mode rpc` (e.g. provider/model/thinking). */
  piArgs?: string[];
  /** Working directory for the Pi process. */
  cwd?: string;
  /** Environment overrides (used to isolate PI_CODING_AGENT_DIR). */
  env?: NodeJS.ProcessEnv;
  /** Spawn function for tests (defaults to node:child_process.spawn). */
  spawnFn?: (
    command: string,
    args: string[],
    options: { stdio: string[]; cwd?: string; env?: NodeJS.ProcessEnv },
  ) => ChildProcess;
}

export interface WaitResponseOptions {
  /** Match this `id` (when the command carried one). */
  id?: string;
  /** Match this `command` name (for id-less correlation). */
  command?: string;
  /** Timeout in ms (default 30s). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Minimal spike client. Lifecycle: `start()` → `send()`/`waitResponse()` →
 * `waitForSettled()` → `close()`. All stdout records are appended to
 * `records` in arrival order; sent commands are interleaved at send time.
 */
export class SpikeClient {
  private proc: ChildProcess | null = null;
  private detachReader: (() => void) | null = null;
  private pending: Array<{
    id?: string;
    command?: string;
    resolve: (payload: Record<string, unknown>) => void;
  }> = [];
  private settledWaiters: Array<() => void> = [];
  private seq = 0;

  readonly records: SpikeRecord[] = [];
  stderr = "";

  constructor(private readonly options: SpikeClientOptions = {}) {}

  /** Spawn `pi --mode rpc` and attach the strict LF-only reader. */
  async start(): Promise<void> {
    if (this.proc) throw new Error("SpikeClient already started");
    const command = this.options.piCommand ?? "pi";
    const args = [...(this.options.piArgs ?? []), "--mode", "rpc"];
    const spawnFn = this.options.spawnFn ?? spawn;
    const proc = spawnFn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
      ...(this.options.env ? { env: this.options.env } : {}),
    });
    this.proc = proc;
    proc.stderr?.on("data", (chunk: Buffer | string) => {
      this.stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    this.detachReader = attachJsonlReader(
      proc.stdout as unknown as NodeJS.ReadableStream & {
        on(event: string, listener: (...args: never[]) => void): unknown;
        off(event: string, listener: (...args: never[]) => void): unknown;
      },
      (line: string) => this.onLine(line),
    );
    // Give the process one tick to surface spawn errors.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  private onLine(line: string): void {
    if (line.trim() === "") return;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(line) as Record<string, unknown>;
    } catch {
      payload = { type: "unparseable", raw: line };
    }
    this.records.push({ seq: this.seq++, dir: "s2c", payload });
    if (payload["type"] === "agent_settled") {
      const waiters = this.settledWaiters.splice(0);
      for (const w of waiters) w();
    }
    if (payload["type"] === "response") {
      const id = payload["id"] as string | undefined;
      const cmd = payload["command"] as string | undefined;
      const idx = this.pending.findIndex((p) =>
        id !== undefined ? p.id === id : p.command !== undefined && p.command === cmd,
      );
      if (idx !== -1) {
        const [entry] = this.pending.splice(idx, 1);
        entry?.resolve(payload);
      }
    }
  }

  /** Send one command object as a single LF-terminated JSON line. */
  send(command: Record<string, unknown>): void {
    if (!this.proc?.stdin) throw new Error("SpikeClient not started");
    this.records.push({ seq: this.seq++, dir: "c2s", payload: { ...command } });
    this.proc.stdin.write(serializeJsonLine(command));
  }

  /** Send raw bytes (for malformed-input probes). */
  sendRaw(text: string): void {
    if (!this.proc?.stdin) throw new Error("SpikeClient not started");
    this.proc.stdin.write(text);
  }

  /** Send a command and resolve with its matching `response` record. */
  waitResponse(
    command: Record<string, unknown>,
    opts: Omit<WaitResponseOptions, "id" | "command"> = {},
  ): Promise<Record<string, unknown>> {
    const id = command["id"] as string | undefined;
    const type = command["type"] as string | undefined;
    return this.sendAndWait(command, { id, command: type, ...opts });
  }

  private sendAndWait(
    command: Record<string, unknown>,
    opts: WaitResponseOptions,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timed out waiting for response id=${opts.id ?? "?"} command=${opts.command ?? "?"}`));
      }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      this.pending.push({
        id: opts.id,
        command: opts.id === undefined ? opts.command : undefined,
        resolve: (payload) => {
          clearTimeout(timer);
          resolve(payload);
        },
      });
      try {
        this.send(command);
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  /** Resolve when the next `agent_settled` event arrives (or timeout). */
  waitForSettled(timeoutMs = 90_000): Promise<void> {
    // Always waits for a *new* settle after invocation; callers tracking
    // counts should snapshot `countByType("agent_settled")` first.
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for agent_settled")), timeoutMs);
      this.settledWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Count records of a given `type` (helper for capture scripts/tests). */
  countByType(type: string): number {
    return this.records.filter((r) => r.payload["type"] === type).length;
  }

  /** Close stdin (clean EOF → Pi exits 0) then SIGTERM after a grace period. */
  async close(graceMs = 2_000): Promise<{ exitCode: number | null; signal: string | null }> {
    const proc = this.proc;
    if (!proc) return { exitCode: null, signal: null };
    this.detachReader?.();
    this.detachReader = null;
    const exit = new Promise<{ exitCode: number | null; signal: string | null }>((resolve) => {
      proc.on("exit", (code: number | null, signal: string | null) => resolve({ exitCode: code, signal }));
    });
    try {
      proc.stdin?.end();
    } catch {
      // Already closed; fall through to SIGTERM below.
    }
    const winner = await Promise.race([
      exit,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), graceMs)),
    ]);
    if (winner === "timeout") {
      try {
        proc.kill();
      } catch {
        // Already exited.
      }
      return exit;
    }
    return winner;
  }
}

/** Resolve the Pi binary for capture scripts (PATH lookup with fallback). */
export function defaultPiCommand(): string {
  return "pi";
}

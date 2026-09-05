/**
 * Fixture replay for the production transport (SNC1.2).
 *
 * Replays every SNC1.1 fixture (`fixtures/*.jsonl`) through a live
 * `PiRpcConnection` with a fake process: each `c2s` command becomes a real
 * correlated `request()` (or fire-and-forget UI response / raw probe) and
 * each `s2c` record is fed as stdout bytes. Asserts accepted/rejected
 * outcomes match the recorded `success` flags, extension-UI correlations
 * hold, and session-tree/leaf invariants survive the transport.
 */

import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import { PiRpcConnection } from "../src/connection.js";
import type { PiRpcSpawnFn } from "../src/connection.js";
import type { PiResponse } from "../src/protocol.js";
import { splitJsonLines } from "../src/jsonl.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, "../fixtures");

const FIXTURES = [
  "startup-idle.jsonl",
  "text-streaming.jsonl",
  "thinking.jsonl",
  "tool-execution.jsonl",
  "bash-rpc.jsonl",
  "abort-queue.jsonl",
  "state-tree.jsonl",
  "models-thinking.jsonl",
  "images.jsonl",
  "extension-ui.jsonl",
  "resume-branch.jsonl",
  "malformed-exit.jsonl",
];

interface Envelope {
  v: number;
  dir: "c2s" | "s2c" | "sys";
  payload: Record<string, unknown>;
}

function readEnvelopes(name: string): Envelope[] {
  const text = fs.readFileSync(path.join(fixturesDir, name), "utf8");
  const { lines } = splitJsonLines(text);
  return lines.map((l) => JSON.parse(l) as Envelope);
}

function createHarness() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const written: string[] = [];
  const proc = new EventEmitter() as EventEmitter & {
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    stdout: typeof stdout;
    stderr: typeof stderr;
    kill: ReturnType<typeof vi.fn>;
    exitCode: number | null;
    signalCode?: string | null;
  };
  const stdin = {
    write: vi.fn((s: string) => {
      written.push(s);
      return true;
    }),
    end: vi.fn(() => {
      setTimeout(() => {
        if (proc.exitCode === null) {
          proc.exitCode = 0;
          proc.emit("exit", 0, null);
        }
      }, 0);
      return undefined;
    }),
  };
  proc.stdin = stdin;
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.kill = vi.fn(() => {
    setTimeout(() => {
      if (proc.exitCode === null) {
        proc.emit("exit", null, "SIGTERM");
      }
    }, 0);
    return true;
  });
  proc.exitCode = null;
  const spawnFn = vi.fn(() => proc as unknown as ChildProcess) as unknown as PiRpcSpawnFn;
  return { spawnFn, proc, stdout, written };
}

describe("PiRpcConnection fixture replay (all #11 fixtures)", () => {
  for (const name of FIXTURES) {
    it(`replays ${name} with matching accepted/rejected outcomes`, async () => {
      const envelopes = readEnvelopes(name);
      const h = createHarness();
      const conn = new PiRpcConnection({ spawnFn: h.spawnFn, defaultTimeoutMs: 5_000 });
      await conn.start();

      const events: Record<string, unknown>[] = [];
      const responses: PiResponse[] = [];
      const uiRequests: Record<string, unknown>[] = [];
      conn.onEvent((e) => events.push(e as Record<string, unknown>));
      conn.onResponse((r) => responses.push(r));
      conn.onExtensionUiRequest((r) => uiRequests.push(r as unknown as Record<string, unknown>));

      const pending: Array<{ id: string; promise: Promise<unknown> }> = [];
      const settledOutcomes: Array<{ ok: boolean; error?: string }> = [];

      for (const env of envelopes) {
        if (env.dir === "sys") continue; // harness lifecycle notes, not Pi output
        if (env.dir === "c2s") {
          const p = env.payload;
          if ("raw" in p) {
            conn.sendRaw(p["raw"] as string);
            continue;
          }
          if (p["type"] === "extension_ui_response") {
            conn.respondToExtensionUi(
              p as unknown as { type: "extension_ui_response"; id: string },
            );
            continue;
          }
          const promise = (conn.request(p as { type: string; id?: string }) as Promise<unknown>).then(
            (data) => ({ ok: true as const, data }),
            (error: Error) => ({ ok: false as const, error: (error as Error).message }),
          );
          pending.push({ id: String(p["id"] ?? ""), promise });
          settledOutcomes.push({ ok: true }); // placeholder, replaced below
          void settledOutcomes;
        } else {
          // Feed one record at a time (also exercises single-line framing).
          h.stdout.emit("data", Buffer.from(`${JSON.stringify(env.payload)}\n`, "utf8"));
        }
      }

      const results = await Promise.all(pending.map((p) => p.promise));
      // Every recorded s2c response with an id must have a matching c2s.
      const s2cById = new Map<string, Record<string, unknown>>();
      for (const env of envelopes) {
        if (env.dir === "s2c" && env.payload["type"] === "response" && typeof env.payload["id"] === "string") {
          s2cById.set(env.payload["id"] as string, env.payload);
        }
      }
      expect(pending.length).toBe(s2cById.size);
      for (let i = 0; i < pending.length; i++) {
        const id = pending[i]?.id as string;
        const recorded = s2cById.get(id);
        expect(recorded, `${name} id=${id}`).toBeDefined();
        const result = results[i] as { ok: boolean };
        if ((recorded as { success: boolean }).success) {
          expect(result.ok, `${name} id=${id} should accept`).toBe(true);
        } else {
          expect(result.ok, `${name} id=${id} should reject`).toBe(false);
        }
      }

      // Extension-UI correlation: every response matches a prior request.
      const uiById = new Map<string, Record<string, unknown>>();
      for (const env of envelopes) {
        if (env.dir === "s2c" && env.payload["type"] === "extension_ui_request") {
          uiById.set(String(env.payload["id"]), env.payload);
        }
      }
      if (uiById.size > 0) {
        expect(uiRequests.length).toBe(uiById.size);
        for (const seen of uiRequests) {
          expect(uiById.has(String(seen["id"])), `${name} UI id=${String(seen["id"])}`).toBe(true);
        }
      }

      await conn.close(200);
      expect(conn.pendingCount).toBe(0);
    });
  }

  it("replays fragmented multi-record chunks for a full fixture", async () => {
    const envelopes = readEnvelopes("text-streaming.jsonl");
    const h = createHarness();
    const conn = new PiRpcConnection({ spawnFn: h.spawnFn, defaultTimeoutMs: 5_000 });
    await conn.start();

    const s2cPayloads = envelopes.filter((e) => e.dir === "s2c").map((e) => e.payload);
    const c2sCommands = envelopes.filter(
      (e) => e.dir === "c2s" && !("raw" in e.payload) && e.payload["type"] !== "extension_ui_response",
    );

    const pending = c2sCommands.map((e) =>
      (conn.request(e.payload as { type: string; id?: string }) as Promise<unknown>).then(
        () => true,
        () => false,
      ),
    );
    // Concatenate all s2c records and split into odd fragments.
    const blob = s2cPayloads.map((p) => `${JSON.stringify(p)}\n`).join("");
    const bytes = Buffer.from(blob, "utf8");
    let offset = 0;
    for (const size of [1, 2, 5, 13, 64, 1024]) {
      if (offset >= bytes.length) break;
      h.stdout.emit("data", bytes.subarray(offset, Math.min(bytes.length, offset + size)));
      offset += size;
    }
    if (offset < bytes.length) h.stdout.emit("data", bytes.subarray(offset));
    const results = await Promise.all(pending);
    expect(results).toEqual([true, true]);
    await conn.close(200);
  });

  it("keeps state-tree coherent through the transport (entries/leaf/tree)", async () => {
    const envelopes = readEnvelopes("state-tree.jsonl");
    const h = createHarness();
    const conn = new PiRpcConnection({ spawnFn: h.spawnFn, defaultTimeoutMs: 5_000 });
    await conn.start();
    const byId = new Map<string, PiResponse>();
    conn.onResponse((r) => {
      if (r.id) byId.set(r.id, r);
    });
    const pending: Array<Promise<unknown>> = [];
    for (const env of envelopes) {
      if (env.dir === "sys") continue;
      if (env.dir === "c2s") {
        pending.push(
          (conn.request(env.payload as { type: string }) as Promise<unknown>).then(
            () => null,
            () => null,
          ),
        );
      } else {
        h.stdout.emit("data", Buffer.from(`${JSON.stringify(env.payload)}\n`, "utf8"));
      }
    }
    await Promise.all(pending);
    const entries = (byId.get("st3")?.data as { entries: Array<{ id: string; parentId: string | null }>; leafId: string });
    expect(entries.entries[0]?.parentId).toBeNull();
    for (let i = 1; i < entries.entries.length; i++) {
      expect(entries.entries[i]?.parentId).toBe(entries.entries[i - 1]?.id);
    }
    expect(entries.leafId).toBe(entries.entries[entries.entries.length - 1]?.id);
    const tree = byId.get("st5")?.data as { leafId: string };
    expect(tree.leafId).toBe(entries.leafId);
    await conn.close(200);
  });
});

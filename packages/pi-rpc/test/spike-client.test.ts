import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { SpikeClient } from "../src/spike-client.js";
import { serializeJsonLine } from "../src/jsonl.js";

function fakeSpawn(outputs: string[]) {
  const stdout = new EventEmitter();
  const written: string[] = [];
  const stdin = { write: vi.fn((s: string) => void written.push(s)), end: vi.fn() };
  const proc = new EventEmitter() as EventEmitter & {
    stdin: typeof stdin;
    stdout: typeof stdout;
    stderr: EventEmitter;
    kill: () => void;
  };
  proc.stdin = stdin;
  proc.stdout = stdout;
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  const spawnFn = vi.fn(() => proc as unknown as import("node:child_process").ChildProcess);
  return {
    spawnFn,
    proc,
    stdout,
    written,
    emitLines: (lines: string[] = outputs) => {
      for (const line of lines) stdout.emit("data", Buffer.from(line + "\n", "utf8"));
    },
    emitRaw: (chunk: string) => stdout.emit("data", Buffer.from(chunk, "utf8")),
  };
}

describe("SpikeClient (strict LF-only probe)", () => {
  it("writes LF-only commands and correlates id-bearing responses", async () => {
    const fake = fakeSpawn([]);
    const client = new SpikeClient({ piArgs: ["--no-session", "--offline"], spawnFn: fake.spawnFn });
    await client.start();
    expect(fake.spawnFn).toHaveBeenCalledOnce();
    const [, args] = fake.spawnFn.mock.calls[0] as [string, string[]];
    expect(args).toContain("--mode");
    expect(args).toContain("rpc");

    const pending = client.waitResponse({ id: "s1", type: "get_state" });
    expect(fake.written).toHaveLength(1);
    expect(fake.written[0]).toBe(serializeJsonLine({ id: "s1", type: "get_state" }));
    expect(fake.written[0]).not.toContain("\r");

    fake.emitLines(['{"id":"s1","type":"response","command":"get_state","success":true,"data":{}}']);
    await expect(pending).resolves.toMatchObject({ command: "get_state", success: true });
    expect(client.records.filter((r) => r.dir === "s2c")).toHaveLength(1);
  });

  it("preserves literal U+2028/U+2029 as one record (no readline split)", async () => {
    const fake = fakeSpawn([]);
    const client = new SpikeClient({ spawnFn: fake.spawnFn });
    await client.start();
    const payload = JSON.stringify({ type: "bash_execution_update", id: "u1", delta: "A\u2028B\u2029C\n" });
    // Deliver the record split across two chunks inside the multibyte run.
    const bytes = Buffer.from(payload + "\n", "utf8");
    fake.emitRaw(bytes.subarray(0, 25).toString("utf8"));
    fake.emitRaw(bytes.subarray(25).toString("utf8"));
    const s2c = client.records.filter((r) => r.dir === "s2c");
    expect(s2c).toHaveLength(1);
    expect(s2c[0]?.payload).toMatchObject({ type: "bash_execution_update", id: "u1" });
  });

  it("resolves waitForSettled on agent_settled and closes via EOF", async () => {
    const fake = fakeSpawn([]);
    const client = new SpikeClient({ spawnFn: fake.spawnFn });
    await client.start();
    const settled = client.waitForSettled(1000);
    fake.emitLines(['{"type":"agent_settled"}']);
    await expect(settled).resolves.toBeUndefined();
    const closed = client.close(50);
    fake.proc.emit("exit", 0, null);
    await expect(closed).resolves.toMatchObject({ exitCode: 0 });
  });
});

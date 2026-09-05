/**
 * Production Pi RPC connection tests (SNC1.2).
 *
 * Covers strict LF-only framing, fragmented/multi-record chunks,
 * U+2028/U+2029 survival, interleaved responses, timeout/process-exit/
 * malformed-line cases, close idle/active, secret-safe errors, and listener/
 * process cleanup. Fixture replay lives in `fixtures-replay.test.ts`; the
 * optional real-Pi smoke test is `smoke.test.ts` (gated by PI_RPC_SMOKE=1).
 */

import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { PiRpcConnection } from "../src/connection.js";
import { PiRpcError } from "../src/errors.js";
import { serializeJsonLine } from "../src/jsonl.js";

interface FakeProc {
  spawnFn: ReturnType<typeof vi.fn>;
  proc: EventEmitter & {
    stdin: EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    stdout: EventEmitter & { destroy?: () => void };
    stderr: EventEmitter & { destroy?: () => void };
    kill: ReturnType<typeof vi.fn>;
    exitCode: number | null;
    signalCode: string | null | undefined;
  };
  stdin: EventEmitter;
  stdout: EventEmitter;
  stderr: EventEmitter;
  written: string[];
  emitStdout: (text: string | Buffer) => void;
  emitStderr: (text: string) => void;
  emitExit: (code: number | null, signal: string | null) => void;
  emitStdinError: (error: Error) => void;
  emitChildError: (error: Error) => void;
}

function createFakeProc(): FakeProc {
  const stdout = new EventEmitter() as EventEmitter & { destroy?: () => void };
  const stderr = new EventEmitter() as EventEmitter & { destroy?: () => void };
  const stdinEmitter = new EventEmitter();
  const written: string[] = [];
  const stdin = stdinEmitter as EventEmitter & {
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  stdin.write = vi.fn((s: string) => {
    written.push(typeof s === "string" ? s : (s as Buffer).toString("utf8"));
    return true;
  }) as unknown as ReturnType<typeof vi.fn>;
  stdin.end = vi.fn(() => {
    // Simulate Pi's clean EOF → exit 0 on the next tick (like real Pi).
    setTimeout(() => {
      const p = proc as unknown as EventEmitter & { exitCode: number | null };
      if (p.exitCode === null) {
        p.exitCode = 0;
        proc.emit("exit", 0, null);
      }
    }, 0);
    return undefined;
  }) as unknown as ReturnType<typeof vi.fn>;
  stdout.destroy = vi.fn();
  stderr.destroy = vi.fn();
  const proc = new EventEmitter() as FakeProc["proc"];
  proc.stdin = stdin;
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.kill = vi.fn(() => {
    setTimeout(() => {
      const p = proc as unknown as EventEmitter & { exitCode: number | null };
      if (p.exitCode === null) {
        p.exitCode = null;
        proc.emit("exit", null, "SIGTERM");
      }
    }, 0);
    return true;
  }) as unknown as FakeProc["proc"]["kill"];
  proc.exitCode = null;
  proc.signalCode = undefined;
  const spawnFn = vi.fn(() => proc as unknown as ChildProcess);
  return {
    spawnFn,
    proc,
    stdin: stdinEmitter,
    stdout,
    stderr,
    written,
    emitStdout: (text: string | Buffer) => {
      stdout.emit("data", typeof text === "string" ? Buffer.from(text, "utf8") : text);
    },
    emitStderr: (text: string) => {
      stderr.emit("data", Buffer.from(text, "utf8"));
    },
    emitExit: (code: number | null, signal: string | null) => {
      (proc as unknown as { exitCode: number | null }).exitCode = code;
      proc.emit("exit", code, signal);
    },
    emitStdinError: (error: Error) => {
      stdinEmitter.emit("error", error);
    },
    emitChildError: (error: Error) => {
      proc.emit("error", error);
    },
  };
}

async function startedConnection(
  fake: FakeProc,
  opts: ConstructorParameters<typeof PiRpcConnection>[0] = {},
): Promise<PiRpcConnection> {
  // Framing/correlation unit tests skip the RPC readiness probe (they test
  // transport behavior in isolation); dedicated startup tests below enable
  // the probe explicitly.
  const conn = new PiRpcConnection({ spawnFn: fake.spawnFn, startupProbe: false, ...opts });
  await conn.start();
  return conn;
}

describe("PiRpcConnection transport", () => {
  it("spawns pi --mode rpc and writes LF-only commands", async () => {
    const fake = createFakeProc();
    const conn = await startedConnection(fake, { piArgs: ["--offline"] });
    expect(fake.spawnFn).toHaveBeenCalledOnce();
    const [command, args] = fake.spawnFn.mock.calls[0] as [string, string[]];
    expect(command).toBe("pi");
    expect(args).toEqual(["--offline", "--mode", "rpc"]);

    const pending = conn.request({ type: "get_state" });
    expect(fake.written).toHaveLength(1);
    const line = fake.written[0] as string;
    expect(line.endsWith("\n")).toBe(true);
    expect(line).not.toContain("\r");
    expect(JSON.parse(line)).toMatchObject({ type: "get_state" });

    fake.emitStdout(
      serializeJsonLine({ id: JSON.parse(line).id, type: "response", command: "get_state", success: true, data: {} }),
    );
    await expect(pending).resolves.toEqual({});
    await conn.close();
  });

  it("correlates responses by id when interleaved with unrelated events", async () => {
    const fake = createFakeProc();
    const conn = await startedConnection(fake);
    const events: unknown[] = [];
    conn.onEvent((e) => events.push(e));

    const p1 = conn.request({ id: "a1", type: "get_state" });
    const p2 = conn.request({ id: "a2", type: "get_entries" });
    // Unrelated events arrive between the two responses (like abort-queue:
    // abort response arrives after agent_settled).
    fake.emitStdout(serializeJsonLine({ type: "agent_start" }));
    fake.emitStdout(serializeJsonLine({ type: "agent_settled" }));
    fake.emitStdout(
      serializeJsonLine({ id: "a2", type: "response", command: "get_entries", success: true, data: { entries: [], leafId: "x" } }),
    );
    fake.emitStdout(serializeJsonLine({ type: "queue_update", steering: [], followUp: [] }));
    fake.emitStdout(
      serializeJsonLine({ id: "a1", type: "response", command: "get_state", success: true, data: { isStreaming: false } }),
    );
    await expect(p2).resolves.toEqual({ entries: [], leafId: "x" });
    await expect(p1).resolves.toEqual({ isStreaming: false });
    expect(events.map((e) => (e as { type: string }).type)).toEqual([
      "agent_start",
      "agent_settled",
      "queue_update",
    ]);
    await conn.close();
  });

  it("handles fragmented and multi-record stdout chunks", async () => {
    const fake = createFakeProc();
    const conn = await startedConnection(fake);
    const seen: string[] = [];
    conn.onEvent((e) => seen.push((e as { type: string }).type));

    const p1 = conn.request({ id: "f1", type: "get_state" });
    const p2 = conn.request({ id: "f2", type: "get_entries" });
    const r1 = serializeJsonLine({ id: "f1", type: "response", command: "get_state", success: true, data: { ok: 1 } });
    const ev = serializeJsonLine({ type: "agent_settled" });
    const r2 = serializeJsonLine({ id: "f2", type: "response", command: "get_entries", success: true, data: { ok: 2 } });
    const blob = `${r1}${ev}${r2}`;
    // Split into awkward fragments (1-byte, mid-record, multi-record).
    const bytes = Buffer.from(blob, "utf8");
    for (const cut of [1, 7, bytes.length - 3]) {
      void cut;
    }
    fake.emitStdout(bytes.subarray(0, 1));
    fake.emitStdout(bytes.subarray(1, 7));
    fake.emitStdout(bytes.subarray(7));
    await expect(p1).resolves.toEqual({ ok: 1 });
    await expect(p2).resolves.toEqual({ ok: 2 });
    expect(seen).toEqual(["agent_settled"]);
    await conn.close();
  });

  it("preserves literal U+2028/U+2029 split across chunks (no readline split)", async () => {
    const fake = createFakeProc();
    const conn = await startedConnection(fake);
    const deltas: string[] = [];
    conn.onEvent((e) => {
      const ev = e as { type?: string; delta?: string };
      if (ev.type === "bash_execution_update" && typeof ev.delta === "string") deltas.push(ev.delta);
    });
    const p = conn.request({ id: "u9", type: "bash", command: "echo x" });
    const payload = JSON.stringify({ type: "bash_execution_update", id: "u9", delta: "A B C\n" });
    const bytes = Buffer.from(`${payload}\n`, "utf8");
    // U+2028 is 3 bytes (E2 80 A8); cut after byte 1 of that sequence.
    const lsByte = Buffer.from(" ", "utf8")[0] as number;
    const lsStart = bytes.indexOf(lsByte);
    expect(lsStart).toBeGreaterThan(0);
    fake.emitStdout(bytes.subarray(0, lsStart + 1));
    fake.emitStdout(bytes.subarray(lsStart + 1));
    expect(deltas).toEqual(["A B C\n"]);
    expect(deltas[0]).not.toContain("�");
    fake.emitStdout(
      serializeJsonLine({ id: "u9", type: "response", command: "bash", success: true, data: { output: "x", exitCode: 0, cancelled: false, truncated: false } }),
    );
    await expect(p).resolves.toMatchObject({ exitCode: 0 });
    await conn.close();
  });

  it("tolerates CRLF input by stripping one trailing CR", async () => {
    const fake = createFakeProc();
    const conn = await startedConnection(fake);
    const p = conn.request({ id: "c1", type: "get_state" });
    fake.emitStdout('{"id":"c1","type":"response","command":"get_state","success":true,"data":{}}\r\n');
    await expect(p).resolves.toEqual({});
    await conn.close();
  });

  it("rejects with secret-safe rejected (ambiguous:false) on success:false", async () => {
    const fake = createFakeProc();
    const conn = await startedConnection(fake);
    const secretMessage = "Reply with sk-proj-abcdefghijklmnop123456 and bearer abcdefghijklmnop123";
    const p = conn.request({ type: "prompt", message: secretMessage });
    const writtenId = (JSON.parse(fake.written[0] as string) as { id: string }).id;
    fake.emitStdout(
      serializeJsonLine({
        id: writtenId,
        type: "response",
        command: "prompt",
        success: false,
        error: "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
      }),
    );
    const error = await p.then(
      () => null,
      (e) => e as PiRpcError,
    );
    expect(error).toBeInstanceOf(PiRpcError);
    expect(error?.code).toBe("rejected");
    expect(error?.ambiguous).toBe(false);
    expect(error?.command).toBe("prompt");
    // Secret-safe: the prompt text and token-like secrets never appear.
    expect(String(error?.message)).not.toContain("sk-proj");
    expect(String(error?.message)).not.toContain(secretMessage.slice(0, 20));
    expect(error?.toSecretSafeString()).toContain("rejected");
    await conn.close();
  });

  it("times out with ambiguous request-timeout and redacted stderr", async () => {
    const fake = createFakeProc();
    const conn = await startedConnection(fake, { defaultTimeoutMs: 40 });
    fake.emitStderr("starting pi with bearer abcdefghijklmnop1234567890\n");
    const error = await conn.request({ id: "t1", type: "get_state" }).then(
      () => null,
      (e) => e as PiRpcError,
    );
    expect(error?.code).toBe("request-timeout");
    expect(error?.ambiguous).toBe(true);
    expect(error?.timeoutMs).toBe(40);
    expect(error?.stderrTail ?? "").not.toContain("abcdefghijklmnop");
    expect(error?.stderrTail ?? "").toContain("[REDACTED]");
    await conn.close();
  });

  it("rejects in-flight requests as ambiguous process-exited with exit facts", async () => {
    const fake = createFakeProc();
    const conn = await startedConnection(fake);
    const p = conn.request({ id: "e1", type: "prompt", message: "hello" });
    fake.emitStderr("FATAL: something broke\n");
    fake.emitExit(1, null);
    const error = await p.then(
      () => null,
      (e) => e as PiRpcError,
    );
    expect(error?.code).toBe("process-exited");
    expect(error?.ambiguous).toBe(true);
    expect(error?.exitCode).toBe(1);
    expect(error?.stderrTail).toContain("FATAL");
    // Further requests fail fast after unexpected death.
    await expect(conn.request({ type: "get_state" })).rejects.toMatchObject({ code: "transport-closed" });
    await conn.close();
  });

  it("surfaces malformed stdout lines without breaking correlation", async () => {
    const fake = createFakeProc();
    const conn = await startedConnection(fake);
    const malformed: Array<{ linePreview: string; count: number }> = [];
    conn.onMalformedLine((info) => malformed.push(info));
    const p = conn.request({ id: "m1", type: "get_state" });
    fake.emitStdout("not-json-at-all\n");
    expect(malformed).toHaveLength(1);
    expect(conn.malformedLineCount).toBe(1);
    fake.emitStdout(
      serializeJsonLine({ id: "m1", type: "response", command: "get_state", success: true, data: { ok: true } }),
    );
    await expect(p).resolves.toEqual({ ok: true });
    await conn.close();
  });

  it("counts id-less parse responses as unmatched without hanging", async () => {
    const fake = createFakeProc();
    const conn = await startedConnection(fake);
    const responses: unknown[] = [];
    conn.onResponse((r) => responses.push(r));
    conn.sendRaw("not-json\n");
    fake.emitStdout(
      serializeJsonLine({ type: "response", command: "parse", success: false, error: "Failed to parse command" }),
    );
    expect(conn.unmatchedResponseCount).toBe(1);
    expect(responses).toHaveLength(1);
    await conn.close();
  });

  it("waitForSettled resolves on the next agent_settled, not a past one", async () => {
    const fake = createFakeProc();
    const conn = await startedConnection(fake, { defaultTimeoutMs: 500 });
    fake.emitStdout(serializeJsonLine({ type: "agent_settled" }));
    const waiter = conn.waitForSettled(500);
    // A stale settle must not resolve the new waiter.
    let resolved = false;
    void waiter.then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(false);
    fake.emitStdout(serializeJsonLine({ type: "agent_settled" }));
    await expect(waiter).resolves.toBeUndefined();
    await conn.close();
  });

  it("waitForSettled rejects on timeout", async () => {
    const fake = createFakeProc();
    const conn = await startedConnection(fake);
    await expect(conn.waitForSettled(30)).rejects.toMatchObject({ code: "request-timeout" });
    await conn.close();
  });

  it("prompt accept resolves on response; completion needs waitForSettled", async () => {
    const fake = createFakeProc();
    const conn = await startedConnection(fake);
    const accept = conn.prompt("Say hi");
    const writtenId = (JSON.parse(fake.written[0] as string) as { id: string }).id;
    fake.emitStdout(serializeJsonLine({ id: writtenId, type: "response", command: "prompt", success: true }));
    await expect(accept).resolves.toBeUndefined();
    // Completion still requires the settle event (not the accept response).
    const settled = conn.waitForSettled(500);
    fake.emitStdout(serializeJsonLine({ type: "agent_start" }));
    fake.emitStdout(serializeJsonLine({ type: "agent_settled" }));
    await expect(settled).resolves.toBeUndefined();
    await conn.close();
  });

  it("getLastAssistantText handles both {text} and {} shapes", async () => {
    const fake = createFakeProc();
    const conn = await startedConnection(fake);
    const p1 = conn.getLastAssistantText();
    const id1 = (JSON.parse(fake.written[0] as string) as { id: string }).id;
    fake.emitStdout(
      serializeJsonLine({ id: id1, type: "response", command: "get_last_assistant_text", success: true, data: { text: "hi" } }),
    );
    await expect(p1).resolves.toBe("hi");
    const p2 = conn.getLastAssistantText();
    const id2 = (JSON.parse(fake.written[1] as string) as { id: string }).id;
    fake.emitStdout(
      serializeJsonLine({ id: id2, type: "response", command: "get_last_assistant_text", success: true, data: {} }),
    );
    await expect(p2).resolves.toBeNull();
    await conn.close();
  });

  it("extension UI responses are fire-and-forget writes (no pending)", async () => {
    const fake = createFakeProc();
    const conn = await startedConnection(fake);
    const seen: unknown[] = [];
    conn.onExtensionUiRequest((r) => seen.push(r));
    fake.emitStdout(
      serializeJsonLine({ type: "extension_ui_request", id: "ex1", method: "select", title: "Pick", options: ["A"] }),
    );
    expect(seen).toHaveLength(1);
    conn.respondToExtensionUi({ type: "extension_ui_response", id: "ex1", value: "A" });
    expect(fake.written).toHaveLength(1);
    expect(JSON.parse(fake.written[0] as string)).toEqual({
      type: "extension_ui_response",
      id: "ex1",
      value: "A",
    });
    expect(conn.pendingCount).toBe(0);
    await conn.close();
  });

  it("close on an idle session is graceful (EOF, not forced)", async () => {
    const fake = createFakeProc();
    const conn = await startedConnection(fake);
    const result = await conn.close(1000);
    expect(result.exitCode).toBe(0);
    expect(result.forced).toBe(false);
    expect(fake.proc.stdin.end).toHaveBeenCalled();
    expect(conn.isClosed).toBe(true);
    // Idempotent.
    await expect(conn.close()).resolves.toEqual(result);
  });

  it("close on an active session rejects pending as ambiguous and cleans up", async () => {
    const fake = createFakeProc();
    // Never auto-exit: override stdin.end to hang so close must force-kill.
    (fake.proc.stdin.end as ReturnType<typeof vi.fn>).mockImplementation(() => undefined);
    const conn = await startedConnection(fake);
    const events: unknown[] = [];
    const off = conn.onEvent((e) => events.push(e));
    void off;
    const pending = conn.request({ id: "z1", type: "get_state" }, { timeoutMs: 10_000 });
    const result = await conn.close(30);
    expect(result.forced).toBe(true);
    const error = await pending.then(
      () => null,
      (e) => e as PiRpcError,
    );
    expect(error?.code).toBe("transport-closed");
    expect(error?.ambiguous).toBe(true);
    expect(conn.pendingCount).toBe(0);
    // Listener/process cleanup: stdio destroyed, subscriptions cleared.
    expect(fake.proc.stdout.destroy).toHaveBeenCalled();
    // New requests fail fast after close.
    await expect(conn.request({ type: "get_state" })).rejects.toMatchObject({ code: "transport-closed" });
    void events;
  });

  it("close removes process listeners (no leaked children/listeners)", async () => {
    const fake = createFakeProc();
    const conn = await startedConnection(fake);
    const before = fake.proc.listenerCount("exit") + fake.stdout.listenerCount("data");
    expect(before).toBeGreaterThan(0);
    await conn.close(500);
    expect(fake.proc.listenerCount("exit")).toBe(0);
    expect(fake.stdout.listenerCount("data")).toBe(0);
    expect(fake.stderr.listenerCount("data")).toBe(0);
    expect(conn.pendingCount).toBe(0);
  });

  it("stderr tail is bounded and redacted", async () => {
    const fake = createFakeProc();
    const conn = await startedConnection(fake, { stderrMaxBytes: 100 });
    fake.emitStderr(`${"x".repeat(500)} bearer abcdefghijklmnop1234567890 ${"y".repeat(10)}\n`);
    expect(conn.stderrTail.length).toBeLessThanOrEqual(4_000 + 50);
    expect(conn.stderrTail).not.toContain("abcdefghijklmnop");
    expect(conn.stderrTail).toContain("[REDACTED]");
    await conn.close();
  });

  it("start classifies spawn failure without leaking the child", async () => {
    const failingSpawn = vi.fn(() => {
      throw new Error("spawn pi ENOENT");
    });
    const conn = new PiRpcConnection({ spawnFn: failingSpawn as unknown as PiRpcConnection["constructor"] extends never ? never : import("../src/connection.js").PiRpcSpawnFn });
    const error = await conn.start().then(
      () => null,
      (e) => e as PiRpcError,
    );
    expect(error?.code).toBe("spawn-failed");
    expect(conn.isStarted).toBe(false);
  });

  it("start rejects double-start and closed-restart", async () => {
    const fake = createFakeProc();
    const conn = await startedConnection(fake);
    await expect(conn.start()).rejects.toMatchObject({ code: "already-started" });
    await conn.close();
    await expect(conn.start()).rejects.toMatchObject({ code: "already-closed" });
  });
});

describe("PiRpcConnection startup probe (readiness gating)", () => {
  it("start() proves RPC readiness with a get_state round-trip", async () => {
    const fake = createFakeProc();
    const conn = new PiRpcConnection({
      spawnFn: fake.spawnFn,
      startupProbe: true,
      startupProbeTimeoutMs: 1000,
    });
    const starting = conn.start();
    // The first write must be the internal readiness probe.
    await new Promise((r) => setTimeout(r, 60));
    expect(fake.written).toHaveLength(1);
    const probe = JSON.parse(fake.written[0] as string) as { id: string; type: string };
    expect(probe.type).toBe("get_state");
    fake.emitStdout(
      serializeJsonLine({ id: probe.id, type: "response", command: "get_state", success: true, data: {} }),
    );
    await expect(starting).resolves.toBeUndefined();
    expect(conn.isStarted).toBe(true);
    await conn.close(200);
  });

  it("start() rejects startup-failed when Pi emits spawn then exits 1 before answering", async () => {
    const fake = createFakeProc();
    const conn = new PiRpcConnection({
      spawnFn: fake.spawnFn,
      startupProbe: true,
      startupProbeTimeoutMs: 1000,
    });
    const starting = conn.start();
    await new Promise((r) => setTimeout(r, 60));
    expect(fake.written).toHaveLength(1); // probe was sent
    // Invalid args/config: OS spawn succeeded, then Pi dies non-zero.
    fake.emitStderr("FATAL: bad args\n");
    fake.emitExit(1, null);
    const error = await starting.then(
      () => null,
      (e) => e as PiRpcError,
    );
    expect(error?.code).toBe("startup-failed");
    expect(error?.exitCode).toBe(1);
    expect(error?.stderrTail).toContain("FATAL");
    expect(conn.isStarted).toBe(false);
  });

  it("start() rejects startup-timeout when Pi stays silent", async () => {
    const fake = createFakeProc();
    const conn = new PiRpcConnection({
      spawnFn: fake.spawnFn,
      startupProbe: true,
      startupProbeTimeoutMs: 40,
      startupTimeoutMs: 500,
    });
    const error = await conn.start().then(
      () => null,
      (e) => e as PiRpcError,
    );
    expect(error?.code).toBe("startup-timeout");
    expect(conn.isStarted).toBe(false);
  });

  it("even a rejected get_state probe proves liveness", async () => {
    const fake = createFakeProc();
    const conn = new PiRpcConnection({
      spawnFn: fake.spawnFn,
      startupProbe: true,
      startupProbeTimeoutMs: 1000,
    });
    const starting = conn.start();
    await new Promise((r) => setTimeout(r, 60));
    const probe = JSON.parse(fake.written[0] as string) as { id: string };
    fake.emitStdout(
      serializeJsonLine({ id: probe.id, type: "response", command: "get_state", success: false, error: "weird" }),
    );
    await expect(starting).resolves.toBeUndefined();
    expect(conn.isStarted).toBe(true);
    await conn.close(200);
  });
});

describe("PiRpcConnection unexpected-exit cleanup", () => {
  it("releases stdio/process refs/subscriptions after unexpected death", async () => {
    const fake = createFakeProc();
    const conn = new PiRpcConnection({ spawnFn: fake.spawnFn, startupProbe: false });
    await conn.start();
    const events: unknown[] = [];
    conn.onEvent((e) => events.push(e));
    conn.onResponse(() => undefined);
    conn.onExtensionUiRequest(() => undefined);
    const exits: unknown[] = [];
    conn.onExit((r) => exits.push(r));
    // In-flight request becomes ambiguous process-exited.
    const pending = conn.request({ id: "u1", type: "get_state" }, { timeoutMs: 5000 });
    fake.emitExit(1, null);
    const error = await pending.then(
      () => null,
      (e) => e as PiRpcError,
    );
    expect(error?.code).toBe("process-exited");
    expect(error?.ambiguous).toBe(true);
    expect(exits).toHaveLength(1);
    // Full cleanup assertions: no leaked children/listeners.
    expect(conn.isClosed).toBe(true);
    expect(conn.pendingCount).toBe(0);
    expect(fake.proc.listenerCount("exit")).toBe(0);
    expect(fake.stdout.listenerCount("data")).toBe(0);
    expect(fake.stderr.listenerCount("data")).toBe(0);
    expect(fake.proc.stdout.destroy).toHaveBeenCalled();
    expect(fake.proc.stderr.destroy).toHaveBeenCalled();
    // Subscriptions released: new events do not reach old handlers.
    fake.emitStdout(serializeJsonLine({ type: "agent_settled" }));
    expect(events).toHaveLength(0);
    // close() after unexpected death returns the cached exit info fast.
    const result = await conn.close(200);
    expect(result.exitCode).toBe(1);
    void events;
  });
});

describe("PiRpcConnection abort sequencing", () => {
  it("abortAndWaitForSettled resolves when settle arrives before the abort response", async () => {
    const fake = createFakeProc();
    const conn = new PiRpcConnection({ spawnFn: fake.spawnFn, startupProbe: false });
    await conn.start();
    const done = conn.abortAndWaitForSettled({ timeoutMs: 1000, settleTimeoutMs: 1000 });
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.written).toHaveLength(1);
    const abortId = (JSON.parse(fake.written[0] as string) as { id: string }).id;
    // Proven order: agent_settled first, abort response after.
    fake.emitStdout(serializeJsonLine({ type: "agent_settled" }));
    fake.emitStdout(serializeJsonLine({ id: abortId, type: "response", command: "abort", success: true }));
    await expect(done).resolves.toBeUndefined();
    await conn.close(200);
  });
});

describe("PiRpcConnection async stream/child failures", () => {
  it("async stdin error rejects in-flight as ambiguous transport-closed with full cleanup", async () => {
    const fake = createFakeProc();
    const conn = new PiRpcConnection({ spawnFn: fake.spawnFn, startupProbe: false });
    await conn.start();
    const exits: unknown[] = [];
    conn.onExit((r) => exits.push(r));
    // Secret-bearing prompt in flight: the failure must stay secret-safe.
    const pending = conn.request(
      { type: "prompt", message: "secret sk-proj-abcdefghijklmnop123456" },
      { timeoutMs: 5000 },
    );
    fake.emitStdinError(new Error("write EPIPE"));
    const error = await pending.then(
      () => null,
      (e) => e as PiRpcError,
    );
    expect(error?.code).toBe("transport-closed");
    expect(error?.ambiguous).toBe(true);
    expect(String(error?.message)).toContain("stdin");
    expect(String(error?.message)).not.toContain("sk-proj");
    expect(exits).toHaveLength(1);
    // Terminal path: no leaked children/listeners, fail-fast afterwards.
    expect(conn.isClosed).toBe(true);
    expect(conn.pendingCount).toBe(0);
    expect(fake.proc.listenerCount("exit")).toBe(0);
    expect(fake.stdout.listenerCount("data")).toBe(0);
    expect(fake.stdin.listenerCount("error")).toBe(0);
    await expect(conn.request({ type: "get_state" })).rejects.toMatchObject({ code: "transport-closed" });
    const result = await conn.close(200);
    expect(result.exitCode).toBeNull();
  });

  it("child error with no subsequent exit still terminates the transport", async () => {
    const fake = createFakeProc();
    const conn = new PiRpcConnection({ spawnFn: fake.spawnFn, startupProbe: false });
    await conn.start();
    const pending = conn.request({ id: "k1", type: "get_state" }, { timeoutMs: 5000 });
    const settled = conn.waitForSettled(5000);
    // Node documents `exit` may never follow `error`: do not emit exit.
    fake.emitChildError(new Error("spawn EACCES"));
    const error = await pending.then(
      () => null,
      (e) => e as PiRpcError,
    );
    expect(error?.code).toBe("transport-closed");
    expect(error?.ambiguous).toBe(true);
    await expect(settled).rejects.toMatchObject({ code: "transport-closed" });
    expect(conn.isClosed).toBe(true);
    expect(conn.pendingCount).toBe(0);
    expect(fake.proc.listenerCount("exit")).toBe(0);
    expect(fake.proc.listenerCount("error")).toBe(0);
    // Late `exit`, if the OS ever delivers one, is a no-op (no double fire).
    const exits: unknown[] = [];
    conn.onExit((r) => exits.push(r));
    fake.emitExit(1, null);
    expect(exits).toHaveLength(0);
  });
});

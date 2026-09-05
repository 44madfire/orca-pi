import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { BridgeHost, type SessionEventEnvelope } from "../src/host.js";
import { MockExternalProvider } from "../src/provider.js";
import { serializeBridgeLine } from "../src/framing.js";
import { BRIDGE_PROTOCOL_VERSION } from "../src/protocol.js";

/** Minimal ChildProcess stand-in for BridgeHost tests. */
function createFakeProc() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: { write: (s: string) => void; end: () => void };
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: (signal?: string) => void;
    killedWith: (string | undefined)[];
    stdinEnded: boolean;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killedWith = [];
  proc.stdinEnded = false;
  proc.stdin = {
    write: () => undefined,
    end: () => {
      proc.stdinEnded = true;
    },
  };
  proc.kill = vi.fn((signal?: string) => {
    proc.killedWith.push(signal);
    queueMicrotask(() => proc.emit("exit", null, signal ?? "SIGTERM"));
  }) as never;
  return proc;
}

/** Wire a BridgeHost to an in-process MockExternalProvider (no OS process). */
function createMockPair(providerOpts: ConstructorParameters<typeof MockExternalProvider>[0] = {}) {
  const provider = new MockExternalProvider(providerOpts);
  const proc = createFakeProc();
  const written: string[] = [];
  provider.attachTestTransport((msg) => {
    proc.stdout.emit("data", Buffer.from(serializeBridgeLine(msg), "utf8"));
  });
  // Host stdin → provider lines (may contain several LF records per write).
  proc.stdin.write = ((s: string) => {
    written.push(s);
    for (const chunk of s.split("\n")) {
      if (chunk.trim() === "") continue;
      provider.onLine(chunk.endsWith("\r") ? chunk.slice(0, -1) : chunk);
    }
  }) as never;
  const host = new BridgeHost({
    bridgeCommand: "mock-in-memory",
    bridgeArgs: [],
    workspaceRoot: "/tmp/ws",
    spawnFn: (() => proc) as never,
    helloTimeoutMs: 2000,
    requestTimeoutMs: 2000,
    closeGraceMs: 50,
  });
  // stdin.end → provider sees EOF: emit exiting then process exit 0.
  const realEnd = proc.stdin.end.bind(proc.stdin);
  proc.stdin.end = (() => {
    realEnd();
    queueMicrotask(() => proc.emit("exit", 0, null));
  }) as never;
  return { host, provider, proc, written };
}

/** Collect session events until `settled` (or timeout). */
function collectUntilSettled(host: BridgeHost, timeoutMs = 3000): Promise<SessionEventEnvelope[]> {
  const events: SessionEventEnvelope[] = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timed out waiting for settled (got ${events.length} events)`));
    }, timeoutMs);
    const off = host.onSessionEvent((envelope) => {
      events.push(envelope);
      if (envelope.event.type === "settled") {
        clearTimeout(timer);
        off();
        resolve(events);
      }
    });
  });
}

describe("BridgeHost + MockExternalProvider (SNC1.3 acceptance)", () => {
  it("negotiates hello and reports structured support", async () => {
    const { host } = createMockPair();
    const support = await host.probeSupport();
    expect(support.available).toBe(true);
    expect(support.provider?.id).toBe("mock");
    expect(support.capabilities?.textStreaming).toBe(true);
    expect(host.isReady).toBe(true);
    await host.dispose();
  });

  it("acquires a session and streams a fake response into host callbacks (Native Chat stand-in)", async () => {
    const { host } = createMockPair();
    await host.probeSupport();
    const { sessionId, resumed } = await host.acquire();
    expect(resumed).toBe(false);
    expect(sessionId).toMatch(/^ses_/);

    const settled = collectUntilSettled(host);
    const outcome = await host.dispatch({ sessionId, text: "hello" });
    expect(outcome.status).toBe("accepted");
    const events = await settled;
    const kinds = events.map((e) => e.event.type);
    expect(kinds[0]).toBe("turn_start");
    expect(kinds).toContain("text_delta");
    expect(kinds[kinds.length - 1]).toBe("settled");
    const full = events
      .filter((e) => e.event.type === "text_delta")
      .map((e) => (e.event as { delta: string }).delta)
      .join("");
    expect(full).toContain("mock response for: hello");
    // History reconciles the turn (unknown-dispatch recovery path).
    const history = await host.getHistory(sessionId);
    expect(history.entries.some((e) => e.role === "user" && e.text === "hello")).toBe(true);
    expect(history.entries.some((e) => e.role === "assistant" && e.text?.includes("mock response"))).toBe(true);
    await host.dispose();
  });

  it("preserves literal U+2028/U+2029 in dispatch text as one turn", async () => {
    const { host } = createMockPair();
    await host.probeSupport();
    const { sessionId } = await host.acquire();
    const settled = collectUntilSettled(host);
    const outcome = await host.dispatch({ sessionId, text: "A\u2028B\u2029C" });
    expect(outcome.status).toBe("accepted");
    const events = await settled;
    const full = events
      .filter((e) => e.event.type === "text_delta")
      .map((e) => (e.event as { delta: string }).delta)
      .join("");
    expect(full).toContain("A\u2028B\u2029C");
    await host.dispose();
  });

  it("rejects honestly when the session is busy (default queue=reject)", async () => {
    const { host } = createMockPair({ textChunkSize: 4 });
    await host.probeSupport();
    const { sessionId } = await host.acquire();
    const firstSettled = collectUntilSettled(host);
    const first = await host.dispatch({ sessionId, text: "first " + "x".repeat(64) });
    expect(first.status).toBe("accepted");
    // While the first turn streams, a second bare dispatch must reject (not queue silently).
    const second = await host.dispatch({ sessionId, text: "second" });
    expect(second.status).toBe("rejected");
    expect(second.reason).toMatch(/already-streaming/);
    await firstSettled;
    await host.dispose();
  });

  it("reports unknown (never auto-resends) on dispatch timeout", async () => {
    const proc = createFakeProc();
    // Answer hello immediately, then hang every dispatch so the deadline expires.
    proc.stdin.write = ((s: string) => {
      for (const line of s.split("\n")) {
        if (line.trim() === "") continue;
        const msg = JSON.parse(line) as { opId: string; kind: string };
        if (msg.kind === "hello") {
          proc.stdout.emit(
            "data",
            Buffer.from(
              serializeBridgeLine({ v: 1, kind: "hello_ok", opId: msg.opId, provider: { id: "hung", version: "0", protocol: 1 }, capabilities: { textStreaming: true, thinking: false, tools: false, images: false, extensionDialogs: false, history: false, options: false, cancel: false, resume: false } }),
              "utf8",
            ),
          );
        }
        // dispatch and everything else: hang (no reply) → host synthesizes unknown.
      }
    }) as never;
    const host = new BridgeHost({
      bridgeCommand: "hung-provider",
      bridgeArgs: [],
      workspaceRoot: "/tmp/ws",
      spawnFn: (() => proc) as never,
      helloTimeoutMs: 1000,
      requestTimeoutMs: 120,
      closeGraceMs: 20,
    });
    const support = await host.probeSupport();
    expect(support.available).toBe(true);
    const outcome = await host.dispatch({ sessionId: "ses_missing", text: "hi" });
    expect(outcome.status).toBe("unknown");
    expect(outcome.reason).toMatch(/do not auto-resend/);
    await host.dispose();
  });

  it("fails closed on missing binary: TUI fallback stays available", async () => {
    const host = new BridgeHost({
      bridgeCommand: "definitely-missing-bridge-binary-xyz",
      bridgeArgs: [],
      workspaceRoot: "/tmp/ws",
      spawnFn: (() => {
        const error = new Error("spawn ENOENT") as Error & { code: string };
        error.code = "ENOENT";
        throw error;
      }) as never,
      helloTimeoutMs: 300,
      requestTimeoutMs: 300,
    });
    const support = await host.probeSupport();
    expect(support.available).toBe(false);
    expect(support.reason.length).toBeGreaterThan(0);
    // Dispatch while unavailable is a definite rejection (fall back to TUI), not unknown.
    const outcome = await host.dispatch({ sessionId: "ses_1", text: "hi" });
    expect(outcome.status).toBe("rejected");
    expect(outcome.reason).toMatch(/bridge-unavailable/);
    await host.dispose();
  });

  it("fails closed on incompatible protocol (hello_error / bad version)", async () => {
    const proc = createFakeProc();
    proc.stdin.write = ((s: string) => {
      for (const line of s.split("\n")) {
        if (line.trim() === "") continue;
        const msg = JSON.parse(line) as { opId: string; kind: string };
        if (msg.kind === "hello") {
          proc.stdout.emit(
            "data",
            Buffer.from(serializeBridgeLine({ v: 1, kind: "hello_error", opId: msg.opId, error: { code: "INCOMPATIBLE_PROTOCOL", message: "need v2" } }), "utf8"),
          );
        }
      }
    }) as never;
    const host = new BridgeHost({
      bridgeCommand: "incompatible-provider",
      bridgeArgs: [],
      workspaceRoot: "/tmp/ws",
      spawnFn: (() => proc) as never,
      helloTimeoutMs: 1000,
      requestTimeoutMs: 1000,
      closeGraceMs: 20,
    });
    const support = await host.probeSupport();
    expect(support.available).toBe(false);
    expect(support.reason).toMatch(/provider-refused|incompatible/i);
    await host.dispose();
  });

  it("cancels an active turn (aborted turn_end + settled)", async () => {
    const { host } = createMockPair({ textChunkSize: 2 });
    await host.probeSupport();
    const { sessionId } = await host.acquire();
    const settled = collectUntilSettled(host);
    const outcome = await host.dispatch({ sessionId, text: "long " + "y".repeat(200) });
    expect(outcome.status).toBe("accepted");
    await host.cancel(sessionId, outcome.opId);
    const events = await settled;
    const turnEnd = events.find((e) => e.event.type === "turn_end")?.event as { stopReason: string } | undefined;
    expect(turnEnd?.stopReason).toBe("aborted");
    await host.dispose();
  });

  it("answers an options dialog via answer_prompt and resumes the turn", async () => {
    const { host } = createMockPair();
    await host.probeSupport();
    const { sessionId } = await host.acquire();
    let requestId: string | null = null;
    const seenRequest = new Promise<void>((resolve) => {
      const off = host.onSessionEvent((envelope) => {
        if (envelope.event.type === "prompt_request") {
          requestId = (envelope.event as { requestId: string }).requestId;
          off();
          resolve();
        }
      });
    });
    const settled = collectUntilSettled(host);
    const outcome = await host.dispatch({ sessionId, text: "__prompt_select__" });
    expect(outcome.status).toBe("accepted");
    await seenRequest;
    expect(requestId).toMatch(/prompt_/);
    await host.answerPrompt(requestId as string, "alpha");
    const events = await settled;
    const full = events
      .filter((e) => e.event.type === "text_delta")
      .map((e) => (e.event as { delta: string }).delta)
      .join("");
    expect(full).toContain("alpha");
    await host.dispose();
  });

  it("round-trips options/history/session metadata", async () => {
    const { host } = createMockPair();
    await host.probeSupport();
    const { sessionId } = await host.acquire({ options: { model: "mock-model", thinkingLevel: "low" } });
    const updated = await host.setOptions(sessionId, { thinkingLevel: "high" });
    expect(updated.thinkingLevel).toBe("high");
    const meta = await host.getSession(sessionId);
    expect(meta.sessionId).toBe(sessionId);
    expect(meta.thinkingLevel).toBe("high");
    const settled = collectUntilSettled(host);
    await host.dispatch({ sessionId, text: "meta check" });
    await settled;
    const history = await host.getHistory(sessionId, undefined, 1);
    expect(history.entries).toHaveLength(1);
    await host.release(sessionId);
    await host.dispose();
  });

  it("restarts independently: new provider starts empty, old sessions are gone", async () => {
    const first = createMockPair();
    await first.host.probeSupport();
    const acquired = await first.host.acquire();
    const settled = collectUntilSettled(first.host);
    await first.host.dispatch({ sessionId: acquired.sessionId, text: "before restart" });
    await settled;
    await first.host.dispose();

    const second = createMockPair();
    const support = await second.host.probeSupport();
    expect(support.available).toBe(true);
    // Old session ids do not survive restarts.
    const outcome = await second.host.dispatch({ sessionId: acquired.sessionId, text: "stale" });
    expect(outcome.status).toBe("rejected");
    expect(outcome.reason).toMatch(/unknown-session/);
    const fresh = await second.host.acquire();
    const settled2 = collectUntilSettled(second.host);
    const ok = await second.host.dispatch({ sessionId: fresh.sessionId, text: "after restart" });
    expect(ok.status).toBe("accepted");
    await settled2;
    await second.host.dispose();
  });

  it("dispose joins teardown: no leaked listeners, processes, or pending timers", async () => {
    const { host, proc } = createMockPair();
    await host.probeSupport();
    const sessionListener = vi.fn();
    const lifecycleListener = vi.fn();
    const offSession = host.onSessionEvent(sessionListener);
    host.onLifecycle(lifecycleListener);
    offSession();
    await host.dispose();
    await host.dispose(); // idempotent
    expect(host.pendingCount).toBe(0);
    // Graceful path EOFs stdin; a clean provider exit needs no SIGTERM, while
    // a hung provider falls back to kill (covered by the timeout test).
    expect(proc.stdinEnded).toBe(true);
    expect(host.isReady).toBe(false);
  });

  it("never sends credentials/environment over the bridge and redacts stderr", async () => {
    const { host, proc, written } = createMockPair();
    await host.probeSupport();
    proc.stderr.emit("data", Buffer.from("note bearer abcdefghijklmnop sk-proj-abcdefghijklmnopqr\n", "utf8"));
    const { sessionId } = await host.acquire();
    const settled = collectUntilSettled(host);
    await host.dispatch({ sessionId, text: "secret-free check" });
    await settled;
    expect(host.stderrSnippet).toContain("[redacted]");
    expect(host.stderrSnippet).not.toContain("abcdefghijklmnopqr");
    for (const chunk of written) {
      for (const line of chunk.split("\n")) {
        if (line.trim() === "") continue;
        expect(line).not.toContain('"env"');
        expect(line).not.toContain("apiKey");
        expect(line).not.toContain("processEnv");
        expect(JSON.parse(line)).toMatchObject({ v: BRIDGE_PROTOCOL_VERSION });
      }
    }
    await host.dispose();
  });

  it("ignores malformed provider lines without crashing (waiter deadline → unknown)", async () => {
    const proc = createFakeProc();
    let helloOp = "";
    proc.stdin.write = ((s: string) => {
      for (const line of s.split("\n")) {
        if (line.trim() === "") continue;
        const msg = JSON.parse(line) as { opId: string; kind: string };
        if (msg.kind === "hello") {
          helloOp = msg.opId;
          proc.stdout.emit("data", Buffer.from("not-json{{{\n", "utf8"));
          proc.stdout.emit(
            "data",
            Buffer.from(serializeBridgeLine({ v: 1, kind: "hello_ok", opId: helloOp, provider: { id: "sloppy", version: "0", protocol: 1 }, capabilities: { textStreaming: true, thinking: false, tools: false, images: false, extensionDialogs: false, history: false, options: false, cancel: false, resume: false } }), "utf8"),
          );
        } else if (msg.kind === "dispatch") {
          proc.stdout.emit("data", Buffer.from("garbage-line\n", "utf8"));
          // Never ack → host deadline synthesizes unknown.
        }
      }
    }) as never;
    const host = new BridgeHost({
      bridgeCommand: "sloppy-provider",
      bridgeArgs: [],
      workspaceRoot: "/tmp/ws",
      spawnFn: (() => proc) as never,
      helloTimeoutMs: 1000,
      requestTimeoutMs: 150,
      closeGraceMs: 20,
    });
    const support = await host.probeSupport();
    expect(support.available).toBe(true);
    const outcome = await host.dispatch({ sessionId: "ses_1", text: "hi" });
    expect(outcome.status).toBe("unknown");
    await host.dispose();
  });

  it("teardown is bounded when the helper ignores EOF, SIGTERM, and SIGKILL", async () => {
    const proc = createFakeProc();
    // Swallow everything: EOF never exits, signals never exit.
    proc.stdin.end = (() => {
      proc.stdinEnded = true;
    }) as never;
    proc.kill = (vi.fn((signal?: string) => {
      proc.killedWith.push(signal);
      // Intentionally never emits exit: simulates a hung helper.
    }) as never);
    proc.stdin.write = ((s: string) => {
      for (const line of s.split("\n")) {
        if (line.trim() === "") continue;
        const msg = JSON.parse(line) as { opId: string; kind: string };
        if (msg.kind === "hello") {
          proc.stdout.emit(
            "data",
            Buffer.from(
              serializeBridgeLine({ v: 1, kind: "hello_ok", opId: msg.opId, provider: { id: "hung", version: "0", protocol: 1 }, capabilities: { textStreaming: true, thinking: false, tools: false, images: false, extensionDialogs: false, history: false, options: false, cancel: false, resume: false } }),
              "utf8",
            ),
          );
        }
      }
    }) as never;
    const host = new BridgeHost({
      bridgeCommand: "hung-helper",
      bridgeArgs: [],
      workspaceRoot: "/tmp/ws",
      spawnFn: (() => proc) as never,
      helloTimeoutMs: 1000,
      requestTimeoutMs: 500,
      closeGraceMs: 20,
      killGraceMs: 20,
    });
    expect((await host.probeSupport()).available).toBe(true);
    // Graceful must still resolve (~EOF+TERM+KILL graces) and attempt both signals.
    const closed = await host.close("graceful");
    expect(closed).toEqual({ code: null, signal: null });
    expect(proc.killedWith).toContain("SIGTERM");
    expect(proc.killedWith).toContain("SIGKILL");
    // Force is likewise bounded (single SIGKILL grace + synthetic finish).
    const forced = await host.close("force");
    expect(forced).toEqual({ code: null, signal: null });
    // Dispose joins teardown without hanging and clears waiters.
    await host.dispose();
    expect(host.pendingCount).toBe(0);
    expect(host.isReady).toBe(false);
  });

  it("provider exit finalizes support fail-closed until explicit restart", async () => {
    const procs: ReturnType<typeof createFakeProc>[] = [];
    let spawns = 0;
    const spawnFn = (() => {
      spawns += 1;
      const proc = createFakeProc();
      procs.push(proc);
      proc.stdin.write = ((s: string) => {
        for (const line of s.split("\n")) {
          if (line.trim() === "") continue;
          const msg = JSON.parse(line) as { opId: string; kind: string; sessionId?: string; message?: { text?: string } };
          if (msg.kind === "hello") {
            proc.stdout.emit(
              "data",
              Buffer.from(
                serializeBridgeLine({ v: 1, kind: "hello_ok", opId: msg.opId, provider: { id: "flappy", version: "0", protocol: 1 }, capabilities: { textStreaming: true, thinking: false, tools: false, images: false, extensionDialogs: false, history: false, options: false, cancel: false, resume: false } }),
                "utf8",
              ),
            );
          } else if (msg.kind === "acquire") {
            proc.stdout.emit(
              "data",
              Buffer.from(
                serializeBridgeLine({ v: 1, kind: "acquired", opId: msg.opId, sessionId: "ses_1", resumed: false, metadata: { sessionId: "ses_1", workspaceRoot: "/tmp/ws", messageCount: 0, isStreaming: false, createdAt: new Date().toISOString() } }),
                "utf8",
              ),
            );
          } else if (msg.kind === "dispatch") {
            proc.stdout.emit(
              "data",
              Buffer.from(
                serializeBridgeLine({ v: 1, kind: "dispatch_ack", opId: msg.opId, sessionId: msg.sessionId ?? "ses_1", status: "accepted" }),
                "utf8",
              ),
            );
          } else if (msg.kind === "close") {
            proc.stdout.emit(
              "data",
              Buffer.from(
                serializeBridgeLine({ v: 1, kind: "closed", opId: msg.opId, exit: { code: 0, signal: null } }),
                "utf8",
              ),
            );
          }
        }
      }) as never;
      return proc;
    }) as never;
    const host = new BridgeHost({
      bridgeCommand: "flappy-provider",
      bridgeArgs: [],
      workspaceRoot: "/tmp/ws",
      spawnFn,
      helloTimeoutMs: 1000,
      requestTimeoutMs: 1000,
      closeGraceMs: 20,
      killGraceMs: 20,
    });
    expect((await host.probeSupport()).available).toBe(true);
    expect(spawns).toBe(1);
    // Crash the previously healthy provider.
    procs[0]?.emit("exit", 1, null);
    // Let the exit handler run.
    await new Promise((r) => setTimeout(r, 10));
    expect(host.support.available).toBe(false);
    expect(host.isReady).toBe(false);
    // Post-exit dispatch is definitely unavailable (rejected), not ambiguous
    // `unknown`, and must not implicitly respawn.
    const outcome = await host.dispatch({ sessionId: "ses_1", text: "after crash" });
    expect(outcome.status).toBe("rejected");
    expect(outcome.reason).toMatch(/bridge-unavailable/);
    expect(spawns).toBe(1);
    // Explicit restart respawns and serves again.
    expect((await host.restart()).available).toBe(true);
    expect(spawns).toBe(2);
    const reacquired = await host.acquire();
    expect(reacquired.sessionId).toBe("ses_1");
    await host.dispose();
  });

  it("process error without exit finalizes fail-closed until explicit restart", async () => {
    const procs: ReturnType<typeof createFakeProc>[] = [];
    let spawns = 0;
    const spawnFn = (() => {
      spawns += 1;
      const proc = createFakeProc();
      procs.push(proc);
      proc.stdin.write = ((s: string) => {
        for (const line of s.split("\n")) {
          if (line.trim() === "") continue;
          const msg = JSON.parse(line) as { opId: string; kind: string };
          if (msg.kind === "hello") {
            proc.stdout.emit(
              "data",
              Buffer.from(
                serializeBridgeLine({ v: 1, kind: "hello_ok", opId: msg.opId, provider: { id: "erratic", version: "0", protocol: 1 }, capabilities: { textStreaming: true, thinking: false, tools: false, images: false, extensionDialogs: false, history: false, options: false, cancel: false, resume: false } }),
                "utf8",
              ),
            );
          } else if (msg.kind === "acquire") {
            proc.stdout.emit(
              "data",
              Buffer.from(
                serializeBridgeLine({ v: 1, kind: "acquired", opId: msg.opId, sessionId: "ses_1", resumed: false, metadata: { sessionId: "ses_1", workspaceRoot: "/tmp/ws", messageCount: 0, isStreaming: false, createdAt: new Date().toISOString() } }),
                "utf8",
              ),
            );
          } else if (msg.kind === "close") {
            proc.stdout.emit(
              "data",
              Buffer.from(
                serializeBridgeLine({ v: 1, kind: "closed", opId: msg.opId, exit: { code: 0, signal: null } }),
                "utf8",
              ),
            );
          }
        }
      }) as never;
      return proc;
    }) as never;
    const host = new BridgeHost({
      bridgeCommand: "erratic-provider",
      bridgeArgs: [],
      workspaceRoot: "/tmp/ws",
      spawnFn,
      helloTimeoutMs: 1000,
      requestTimeoutMs: 1000,
      closeGraceMs: 20,
      killGraceMs: 20,
    });
    const lifecycle: string[] = [];
    host.onLifecycle((e) => lifecycle.push(e.kind));
    expect((await host.probeSupport()).available).toBe(true);
    expect(spawns).toBe(1);
    // Terminal process error with NO subsequent exit (Node does not guarantee
    // exit after error): must still finalize like an exit.
    procs[0]?.emit("error", new Error("EPIPE: broken pipe"));
    await new Promise((r) => setTimeout(r, 10));
    expect(host.support.available).toBe(false);
    expect(host.support.reason).toMatch(/process-error/);
    expect(host.isReady).toBe(false);
    expect(lifecycle).toContain("provider-error");
    const outcome = await host.dispatch({ sessionId: "ses_1", text: "after error" });
    expect(outcome.status).toBe("rejected");
    expect(outcome.reason).toMatch(/bridge-unavailable/);
    expect(spawns).toBe(1);
    // Explicit restart respawns and serves again.
    expect((await host.restart()).available).toBe(true);
    expect(spawns).toBe(2);
    const reacquired = await host.acquire();
    expect(reacquired.sessionId).toBe("ses_1");
    await host.dispose();
  });

  it("failed hello tears down the helper instead of leaving it resident", async () => {
    const procs: ReturnType<typeof createFakeProc>[] = [];
    let spawns = 0;
    const spawnFn = (() => {
      spawns += 1;
      const proc = createFakeProc();
      procs.push(proc);
      proc.stdin.write = ((s: string) => {
        for (const line of s.split("\n")) {
          if (line.trim() === "") continue;
          const msg = JSON.parse(line) as { opId: string; kind: string };
          if (msg.kind === "hello") {
            proc.stdout.emit(
              "data",
              Buffer.from(serializeBridgeLine({ v: 1, kind: "hello_error", opId: msg.opId, error: { code: "INCOMPATIBLE_PROTOCOL", message: "need v2" } }), "utf8"),
            );
          }
        }
      }) as never;
      return proc;
    }) as never;
    const host = new BridgeHost({
      bridgeCommand: "incompatible-provider",
      bridgeArgs: [],
      workspaceRoot: "/tmp/ws",
      spawnFn,
      helloTimeoutMs: 1000,
      requestTimeoutMs: 1000,
      closeGraceMs: 20,
      killGraceMs: 20,
    });
    expect((await host.probeSupport()).available).toBe(false);
    expect(spawns).toBe(1);
    // Failed negotiation must have torn down the child (bounded SIGKILL path).
    expect(procs[0]?.killedWith).toContain("SIGKILL");
    // A later explicit probe retries fresh instead of reusing the dead child.
    expect((await host.probeSupport()).available).toBe(false);
    expect(spawns).toBe(2);
    expect(procs[1]?.killedWith).toContain("SIGKILL");
    await host.dispose();
  });

  it("drives a real external OS process and restarts it independently", async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const cli = path.resolve(here, "../dist/mock-provider-cli.js");
    if (!fs.existsSync(cli)) {
      // Built by `npm run build` (CI builds before tests). Fail loudly so a
      // missing build never masquerades as a passing bridge.
      expect.unreachable(`mock provider CLI not built: ${cli} (run npm run build)`);
    }
    const makeHost = () =>
      new BridgeHost({
        bridgeCommand: process.execPath,
        bridgeArgs: [cli],
        workspaceRoot: "/tmp/ws",
        helloTimeoutMs: 5000,
        requestTimeoutMs: 5000,
        closeGraceMs: 500,
      });
    const first = makeHost();
    const support = await first.probeSupport();
    expect(support.available).toBe(true);
    const { sessionId } = await first.acquire();
    const settled = collectUntilSettled(first, 8000);
    const outcome = await first.dispatch({ sessionId, text: "real process hello" });
    expect(outcome.status).toBe("accepted");
    const events = await settled;
    expect(events.some((e) => e.event.type === "settled")).toBe(true);
    await first.dispose();

    const second = makeHost();
    expect((await second.probeSupport()).available).toBe(true);
    const fresh = await second.acquire();
    const settled2 = collectUntilSettled(second, 8000);
    const secondOutcome = await second.dispatch({ sessionId: fresh.sessionId, text: "after restart" });
    expect(secondOutcome.status).toBe("accepted");
    await settled2;
    await second.dispose();
  }, 20000);
});

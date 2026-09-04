import { describe, expect, it } from "vitest";
import type { OrcaCli } from "../src/orca/orca-cli.js";
import { OrcaCommandError } from "../src/orca/orca-cli-process.js";
import {
  getCompactStatus,
  sendCompactMessage,
  spawnCompactWorker,
  stopCompact,
  waitCompact,
} from "../src/orchestration/operations.js";
import { CompactOrchestrationError } from "../src/orchestration/types.js";

/** Minimal fake OrcaCli for compact operations (spawn + reads). */
function makeFakeOrca(overrides?: Partial<OrcaCli>): OrcaCli & { calls: string[] } {
  const calls: string[] = [];
  const base: OrcaCli = {
    async resolveRunId() {
      calls.push("resolveRunId");
      return undefined;
    },
    async createTask() {
      calls.push("createTask");
      return { taskId: "task_new" };
    },
    async createWorktree(input) {
      calls.push(`createWorktree:${input.name}`);
      return { id: `repo::/wt/${input.name}`, path: `/wt/${input.name}` };
    },
    async resolveWorktree(selector: string) {
      calls.push(`resolveWorktree:${selector}`);
      return { id: `repo::/wt/${selector}`, path: `/wt/${selector}` };
    },
    async resolveTerminalWorktree(handle: string) {
      calls.push(`resolveTerminalWorktree:${handle}`);
      return { id: "repo::/wt/coordinator", path: "/wt/coordinator" };
    },
    async createTerminal() {
      calls.push("createTerminal");
      return { handle: "term_created" };
    },
    async waitForTerminal(handle: string) {
      calls.push(`waitForTerminal:${handle}`);
    },
    async attachWorker(input) {
      calls.push(`attachWorker:${input.taskId}`);
      return { taskId: input.taskId, dispatchId: "dispatch_1", terminalHandle: input.terminalHandle };
    },
    async closeTerminal(handle: string) {
      calls.push(`closeTerminal:${handle}`);
    },
    async showWorker(dispatchId: string) {
      calls.push(`showWorker:${dispatchId}`);
      return { dispatchId, taskId: "task_1", workerState: "ready", terminalHandle: "term_1", raw: {} };
    },
    async listWorkers() {
      calls.push("listWorkers");
      return { entries: [], raw: {} };
    },
    async showDispatch(taskId: string) {
      calls.push(`showDispatch:${taskId}`);
      return { taskId, dispatchId: "dispatch_1", taskStatus: "dispatched", raw: {} };
    },
    async listTasks() {
      calls.push("listTasks");
      return { entries: [], raw: {} };
    },
    async sendToDispatch(input) {
      calls.push(`sendToDispatch:${input.dispatchId}`);
      return { raw: { sent: true } };
    },
    async stopWorker(dispatchId: string) {
      calls.push(`stopWorker:${dispatchId}`);
      return { raw: { stopped: true }, alreadyStopped: false };
    },
  };
  return Object.assign(base, overrides ?? {}, { calls });
}

describe("spawnCompactWorker selects the correct profile", () => {
  it("resolves scout and returns a supervised receipt without duplicating orchestration state", async () => {
    const orca = makeFakeOrca();
    const receipt = await spawnCompactWorker({
      orca,
      profileName: "scout",
      task: { spec: "Map auth flow" },
      projectRoot: "/repo/p",
      skipMappingPersist: true,
    });
    expect(receipt.profileName).toBe("scout");
    expect(receipt.taskId).toBe("task_new");
    expect(receipt.dispatchId).toBe("dispatch_1");
    expect(receipt.terminalHandle).toBe("term_created");
    expect(orca.calls).toContain("createTask");
    expect(orca.calls).toContain("attachWorker:task_new");
  });

  it("unknown profiles fail pre-launch with no Orca effects", async () => {
    const orca = makeFakeOrca();
    const error = await spawnCompactWorker({
      orca,
      profileName: "nope",
      task: { spec: "work" },
      projectRoot: "/repo/p",
      skipMappingPersist: true,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CompactOrchestrationError);
    expect((error as CompactOrchestrationError).code).toBe("unknown-profile");
    expect(orca.calls).toEqual([]);
  });
});

describe("getCompactStatus uses Orca state, not terminal text", () => {
  it("reads a single worker via worker-show + dispatch-show", async () => {
    const orca = makeFakeOrca();
    const receipt = await getCompactStatus({ orca, worker: "dispatch_1" });
    expect(receipt.kind).toBe("worker");
    expect(receipt.status?.dispatchId).toBe("dispatch_1");
    expect(receipt.status?.settled).toBe(false);
  });

  it("reads a task via dispatch-show", async () => {
    const orca = makeFakeOrca();
    const receipt = await getCompactStatus({ orca, taskId: "task_1" });
    expect(receipt.kind).toBe("task");
    expect(receipt.status?.taskId).toBe("task_1");
  });

  it("bare status tolerates run_required for tasks (workers still answer)", async () => {
    const orca = makeFakeOrca({
      async listTasks() {
        throw new OrcaCommandError({
          code: "run_required",
          message: "No Run is bound",
          executable: "orca",
          args: [],
          diagnostics: "run_required",
        });
      },
    });
    const receipt = await getCompactStatus({ orca });
    expect(receipt.kind).toBe("list");
    expect(receipt.workers).toEqual([]);
    expect(receipt.tasks).toBeUndefined();
  });
});

describe("waitCompact success/timeout/failed", () => {
  it("returns completed when the task reports completed", async () => {
    const orca = makeFakeOrca({
      async showWorker(dispatchId: string) {
        return { dispatchId, taskId: "task_1", workerState: "ready", terminalHandle: "term_1", raw: {} };
      },
      async showDispatch(taskId: string) {
        return { taskId, dispatchId: "dispatch_1", taskStatus: "completed", raw: {} };
      },
    });
    const receipt = await waitCompact({
      orca,
      worker: "dispatch_1",
      timeoutMs: 5_000,
      pollIntervalMs: 1,
      sleep: async () => undefined,
      now: (() => {
        let t = 0;
        return () => (t += 10);
      })(),
    });
    expect(receipt.outcome).toBe("completed");
    expect(receipt.timedOut).toBe(false);
  });

  it("returns failed when the task reports failed", async () => {
    const orca = makeFakeOrca({
      async showDispatch(taskId: string) {
        return { taskId, dispatchId: "dispatch_1", taskStatus: "failed", raw: {} };
      },
    });
    const receipt = await waitCompact({
      orca,
      taskId: "task_1",
      timeoutMs: 5_000,
      pollIntervalMs: 1,
      sleep: async () => undefined,
      now: (() => {
        let t = 0;
        return () => (t += 10);
      })(),
    });
    expect(receipt.outcome).toBe("failed");
  });

  it("returns timeout when the deadline passes while running", async () => {
    const orca = makeFakeOrca();
    let now = 0;
    const receipt = await waitCompact({
      orca,
      worker: "dispatch_1",
      timeoutMs: 50,
      pollIntervalMs: 10,
      sleep: async (ms: number) => {
        now += ms;
      },
      now: () => now,
    });
    expect(receipt.outcome).toBe("timeout");
    expect(receipt.timedOut).toBe(true);
  });
});

describe("stopCompact idempotency", () => {
  it("first stop fences, second stop reports alreadyStopped without failing", async () => {
    let stops = 0;
    const orca = makeFakeOrca({
      async stopWorker(dispatchId: string) {
        stops += 1;
        return { raw: {}, alreadyStopped: stops > 1, ...(stops > 1 ? {} : {}) , dispatchId } as unknown as { raw: unknown; alreadyStopped: boolean };
      },
    });
    const first = await stopCompact({ orca, worker: "dispatch_1" });
    expect(first.stopped).toBe(true);
    expect(first.alreadyStopped).toBe(false);
    const second = await stopCompact({ orca, worker: "dispatch_1" });
    expect(second.stopped).toBe(true);
    expect(second.alreadyStopped).toBe(true);
  });

  it("distinguishes terminal stop from Task completion (task status observed, never set)", async () => {
    const orca = makeFakeOrca({
      async showDispatch(taskId: string) {
        return { taskId, dispatchId: "dispatch_1", taskStatus: "dispatched", raw: {} };
      },
    });
    const receipt = await stopCompact({ orca, worker: "dispatch_1" });
    expect(receipt.taskStatus).toBe("dispatched");
    expect(receipt.summary).toContain("Orca owns completion");
  });
});

describe("sendCompactMessage preserves provenance", () => {
  it("delivers follow-up mail without worker_done semantics", async () => {
    const orca = makeFakeOrca();
    const receipt = await sendCompactMessage({ orca, worker: "dispatch_1", message: "Prefer X" });
    expect(receipt.dispatchId).toBe("dispatch_1");
    expect(receipt.delivered).toBe(true);
    expect(orca.calls).toContain("sendToDispatch:dispatch_1");
  });

  it("rejects empty messages pre-send", async () => {
    const orca = makeFakeOrca();
    await expect(sendCompactMessage({ orca, worker: "dispatch_1", message: "  " })).rejects.toMatchObject({
      name: "CompactOrchestrationError",
    });
    expect(orca.calls).not.toContain("sendToDispatch:dispatch_1");
  });
});

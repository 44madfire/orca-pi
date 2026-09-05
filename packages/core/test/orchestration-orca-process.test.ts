import { describe, expect, it } from "vitest";
import { createOrcaCliProcess, OrcaCommandError } from "../src/orca/orca-cli-process.js";
import type { CommandResult, ProcessRunner } from "../src/runner.js";

function ok(stdout: string): CommandResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function fakeRunner(
  handler: (executable: string, args: readonly string[]) => CommandResult,
): ProcessRunner {
  return {
    async run(executable: string, args: readonly string[]) {
      return handler(executable, args);
    },
  };
}

function envelope(result: unknown): string {
  return JSON.stringify({ id: "x", ok: true, result });
}

describe("compact Orca process argv (JEF-9)", () => {
  it("showWorker calls worker-show --dispatch --json", async () => {
    const seen: string[][] = [];
    const runner = fakeRunner((_exe, args) => {
      seen.push([...args]);
      return ok(
        envelope({
          dispatch: { id: "dispatch_1", task_id: "task_1", status: "dispatched" },
          worker: { state: "running", stage: "executing", agent_terminal_handle: "term_1" },
        }),
      );
    });
    const shown = await createOrcaCliProcess(runner).showWorker("dispatch_1");
    expect(seen[0]).toEqual(["orchestration", "worker-show", "--dispatch", "dispatch_1", "--json"]);
    expect(shown).toMatchObject({
      dispatchId: "dispatch_1",
      taskId: "task_1",
      dispatchStatus: "dispatched",
      workerState: "running",
      terminalHandle: "term_1",
    });
    expect(shown.workerState).not.toBe(shown.dispatchStatus);
  });

  it("listWorkers calls worker-list --json (plus --run when given)", async () => {
    const seen: string[][] = [];
    const runner = fakeRunner((_exe, args) => {
      seen.push([...args]);
      return ok(envelope({ workers: [], counts: {} }));
    });
    const orca = createOrcaCliProcess(runner);
    await orca.listWorkers();
    expect(seen[0]).toEqual(["orchestration", "worker-list", "--json"]);
    await orca.listWorkers({ runId: "run_1" });
    expect(seen[1]).toEqual(["orchestration", "worker-list", "--run", "run_1", "--json"]);
  });

  it("showDispatch calls dispatch-show --task --json", async () => {
    const seen: string[][] = [];
    const runner = fakeRunner((_exe, args) => {
      seen.push([...args]);
      return ok(envelope({ dispatch: { id: "d1", task_id: "t1", status: "dispatched" } }));
    });
    const parsed = await createOrcaCliProcess(runner).showDispatch("t1");
    expect(seen[0]).toEqual(["orchestration", "dispatch-show", "--task", "t1", "--json"]);
    expect(parsed).toMatchObject({ taskId: "t1", dispatchId: "d1", dispatchStatus: "dispatched" });
    expect(parsed.taskStatus).toBeUndefined();
  });

  it("listTasks calls task-list --json", async () => {
    const seen: string[][] = [];
    const runner = fakeRunner((_exe, args) => {
      seen.push([...args]);
      return ok(envelope({ tasks: [{ id: "task_1", status: "completed" }] }));
    });
    const listed = await createOrcaCliProcess(runner).listTasks({ runId: "run_1" });
    expect(seen[0]).toEqual(["orchestration", "task-list", "--run", "run_1", "--json"]);
    expect(listed.entries[0]).toMatchObject({ taskId: "task_1", status: "completed" });
  });

  it("sendToDispatch calls send --to dispatch:<id> (never worker_done/heartbeat)", async () => {
    const seen: string[][] = [];
    const runner = fakeRunner((_exe, args) => {
      seen.push([...args]);
      return ok(envelope({ sent: true }));
    });
    const orca = createOrcaCliProcess(runner);
    await orca.sendToDispatch({ dispatchId: "d1", subject: "Hi", body: "Follow-up" });
    expect(seen[0]).toContain("dispatch:d1");
    expect(seen[0]).not.toContain("--type");
    await expect(
      orca.sendToDispatch({ dispatchId: "d1", subject: "x", body: "y", type: "worker_done" }),
    ).rejects.toMatchObject({ name: "OrcaCommandError", code: "compact-send-forbidden-type" });
  });

  it("stopWorker is idempotent for stale dispatches", async () => {
    const stopped = fakeRunner(() => ok(envelope({ stopped: true })));
    expect((await createOrcaCliProcess(stopped).stopWorker("d1")).alreadyStopped).toBe(false);
    const stale = fakeRunner(() => ({
      stdout: JSON.stringify({ ok: false, error: { code: "dispatch_not_found", message: "gone" } }),
      stderr: "",
      exitCode: 1,
    }));
    const result = await createOrcaCliProcess(stale).stopWorker("d1");
    expect(result.alreadyStopped).toBe(true);
    const failed = fakeRunner(() => ({
      stdout: JSON.stringify({ ok: false, error: { code: "boom", message: "nope" } }),
      stderr: "",
      exitCode: 1,
    }));
    await expect(createOrcaCliProcess(failed).stopWorker("d1")).rejects.toBeInstanceOf(
      OrcaCommandError,
    );
  });
});

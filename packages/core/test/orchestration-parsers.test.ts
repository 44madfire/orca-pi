import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  isSettledTaskStatus,
  isSettledWorkerState,
  isSuccessfulTaskStatus,
  parseDispatchShowJson,
  parseSendJson,
  parseTaskListJson,
  parseWorkerListJson,
  parseWorkerShowJson,
  parseWorkerStopJson,
} from "../src/orchestration/orchestration-parsers.js";

const here = dirname(fileURLToPath(import.meta.url));

function fixture(name: string): string {
  return readFileSync(join(here, "fixtures", "orca", name), "utf8");
}

function envelope(result: unknown): string {
  return JSON.stringify({ id: "x", ok: true, result });
}

describe("parseWorkerShowJson (current Orca contract)", () => {
  it("keeps dispatch.status and worker.state separate (running fixture)", () => {
    const parsed = parseWorkerShowJson(fixture("worker-show-running.json"), "dispatch_abc");
    expect(parsed).toMatchObject({
      dispatchId: "dispatch_abc",
      taskId: "task_123",
      dispatchStatus: "dispatched",
      workerState: "running",
      terminalHandle: "term_xyz",
    });
    // The Dispatch status must never masquerade as worker state.
    expect(parsed.workerState).not.toBe(parsed.dispatchStatus);
    expect(parsed.stage).toBe("executing");
  });

  it("reads settled worker state (succeeded fixture)", () => {
    const parsed = parseWorkerShowJson(fixture("worker-show-succeeded.json"), "dispatch_abc");
    expect(parsed.workerState).toBe("succeeded");
    expect(parsed.dispatchStatus).toBe("completed");
    expect(isSettledWorkerState(parsed.workerState)).toBe(true);
  });

  it("falls back to the requested dispatch id when the payload omits it", () => {
    const parsed = parseWorkerShowJson(envelope({}), "dispatch_fallback");
    expect(parsed.dispatchId).toBe("dispatch_fallback");
  });

  it("throws on malformed/ok:false envelopes", () => {
    expect(() => parseWorkerShowJson("{{{", "d")).toThrowError();
    expect(() =>
      parseWorkerShowJson(JSON.stringify({ ok: false, error: { code: "x", message: "y" } }), "d"),
    ).toThrowError();
  });
});

describe("parseWorkerListJson (current Orca contract)", () => {
  it("reads direct workerState/dispatchStatus/agentTerminalHandle rows (fixture)", () => {
    const { entries } = parseWorkerListJson(fixture("worker-list.json"));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      dispatchId: "dispatch_1",
      taskId: "task_1",
      workerState: "running",
      dispatchStatus: "dispatched",
      terminalHandle: "term_1",
      terminalState: "active",
    });
    expect(entries[1]).toMatchObject({ workerState: "succeeded", dispatchStatus: "completed" });
  });

  it("parses empty lists", () => {
    expect(parseWorkerListJson(envelope({ workers: [] })).entries).toEqual([]);
  });
});

describe("parseDispatchShowJson (current Orca contract)", () => {
  it("reads dispatch identity/status only — no taskStatus from dispatch-show alone", () => {
    const parsed = parseDispatchShowJson(fixture("dispatch-show.json"), "task_1");
    expect(parsed).toMatchObject({
      taskId: "task_1",
      dispatchId: "dispatch_1",
      dispatchStatus: "dispatched",
    });
    // dispatch-show carries no authoritative Task status; callers fall back to task-list.
    expect(parsed.taskStatus).toBeUndefined();
    expect(parsed.workerState).toBeUndefined();
  });

  it("handles dispatch:null (no attempt yet)", () => {
    const parsed = parseDispatchShowJson(fixture("dispatch-show-null.json"), "task_9");
    expect(parsed.taskId).toBe("task_9");
    expect(parsed.dispatchId).toBeUndefined();
    expect(parsed.taskStatus).toBeUndefined();
  });
});

describe("parseTaskListJson (authoritative Task status)", () => {
  it("reads task rows from the fixture", () => {
    const { entries } = parseTaskListJson(fixture("task-list.json"));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ taskId: "task_1", status: "dispatched" });
    expect(entries[1]).toMatchObject({ taskId: "task_2", status: "completed" });
  });

  it("skips id-less rows", () => {
    const { entries } = parseTaskListJson(
      envelope({ tasks: [{ id: "task_1", status: "completed" }, { nonsense: true }] }),
    );
    expect(entries).toHaveLength(1);
  });
});

describe("parseSendJson / parseWorkerStopJson", () => {
  it("accepts ok envelopes and keeps raw", () => {
    expect(parseSendJson(envelope({ sent: true })).raw).toMatchObject({ sent: true });
    expect(parseWorkerStopJson(envelope({ stopped: true })).raw).toMatchObject({ stopped: true });
  });
});

describe("settled helpers (Orca-state only, never terminal text)", () => {
  it("classifies task statuses", () => {
    expect(isSettledTaskStatus("completed")).toBe(true);
    expect(isSettledTaskStatus("failed")).toBe(true);
    expect(isSettledTaskStatus("blocked")).toBe(true);
    expect(isSettledTaskStatus("dispatched")).toBe(false);
    expect(isSettledTaskStatus("pending")).toBe(false);
    expect(isSuccessfulTaskStatus("completed")).toBe(true);
    expect(isSuccessfulTaskStatus("failed")).toBe(false);
  });

  it("classifies current worker states (succeeded/failed/stopped/abandoned)", () => {
    expect(isSettledWorkerState("succeeded")).toBe(true);
    expect(isSettledWorkerState("failed")).toBe(true);
    expect(isSettledWorkerState("stopped")).toBe(true);
    expect(isSettledWorkerState("abandoned")).toBe(true);
    expect(isSettledWorkerState("running")).toBe(false);
    expect(isSettledWorkerState("ready")).toBe(false);
  });
});

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

function envelope(result: unknown): string {
  return JSON.stringify({ id: "x", ok: true, result });
}

describe("parseWorkerShowJson", () => {
  it("reads dispatch/task/terminal/state with fallbacks", () => {
    const parsed = parseWorkerShowJson(
      envelope({
        dispatch: { id: "dispatch_1", taskId: "task_1", state: "ready", terminalHandle: "term_1" },
      }),
      "dispatch_1",
    );
    expect(parsed).toMatchObject({
      dispatchId: "dispatch_1",
      taskId: "task_1",
      workerState: "ready",
      terminalHandle: "term_1",
    });
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

describe("parseWorkerListJson", () => {
  it("parses empty and populated lists", () => {
    expect(parseWorkerListJson(envelope({ workers: [] })).entries).toEqual([]);
    const { entries } = parseWorkerListJson(
      envelope({ workers: [{ dispatchId: "d1", taskId: "t1", terminalHandle: "h1" }] }),
    );
    expect(entries[0]).toMatchObject({ dispatchId: "d1", taskId: "t1", terminalHandle: "h1" });
  });
});

describe("parseDispatchShowJson", () => {
  it("reads task/dispatch/state", () => {
    const parsed = parseDispatchShowJson(
      envelope({ task: { id: "task_9", status: "dispatched" }, dispatch: { id: "dispatch_9" } }),
      "task_9",
    );
    expect(parsed).toMatchObject({ taskId: "task_9", dispatchId: "dispatch_9", taskStatus: "dispatched" });
  });
});

describe("parseTaskListJson", () => {
  it("reads task rows and skips id-less rows", () => {
    const { entries } = parseTaskListJson(
      envelope({ tasks: [{ id: "task_1", status: "completed" }, { nonsense: true }] }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ taskId: "task_1", status: "completed" });
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

  it("classifies worker states", () => {
    expect(isSettledWorkerState("stopped")).toBe(true);
    expect(isSettledWorkerState("failed")).toBe(true);
    expect(isSettledWorkerState("ready")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  ORCA_JSON_SNIPPET_LIMIT,
  OrcaJsonParseError,
  parseDispatchJson,
  parseRunCurrentJson,
  parseTaskCreateJson,
  parseTerminalCreateJson,
  parseWorktreeCreateJson,
  parseWorktreeShowJson,
} from "../src/orca/json-parsers.js";

function envelope(result: unknown): string {
  return JSON.stringify({ id: "test", ok: true, result });
}

describe("parseTaskCreateJson", () => {
  it("reads result.task.id", () => {
    expect(parseTaskCreateJson(envelope({ task: { id: "task_123" } }))).toMatchObject({
      taskId: "task_123",
    });
  });

  it("tolerates legacy/alternate shapes", () => {
    expect(parseTaskCreateJson(envelope({ taskId: "task_abc" }))).toMatchObject({
      taskId: "task_abc",
    });
    expect(parseTaskCreateJson(envelope({ id: "task_top" }))).toMatchObject({
      taskId: "task_top",
    });
    expect(
      parseTaskCreateJson(envelope({ task: { taskId: "task_nested" } })),
    ).toMatchObject({ taskId: "task_nested" });
  });

  it("carries runId when present", () => {
    expect(
      parseTaskCreateJson(envelope({ task: { id: "t1" }, run: { id: "run_1" } })),
    ).toMatchObject({ taskId: "t1", runId: "run_1" });
  });

  it("throws actionable error when task id is missing", () => {
    expect(() => parseTaskCreateJson(envelope({ task: {} }))).toThrowError(
      OrcaJsonParseError,
    );
  });

  it("throws on malformed JSON with truncated snippet", () => {
    const bad = "not json{{{";
    try {
      parseTaskCreateJson(bad);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(OrcaJsonParseError);
      const parseError = error as OrcaJsonParseError;
      expect(parseError.context).toBe("task-create");
      expect(parseError.snippet.length).toBeLessThanOrEqual(
        ORCA_JSON_SNIPPET_LIMIT + 20,
      );
    }
  });

  it("throws on ok:false envelopes", () => {
    const payload = JSON.stringify({
      ok: false,
      error: { code: "run_required", message: "No Run is bound." },
    });
    expect(() => parseTaskCreateJson(payload)).toThrowError(OrcaJsonParseError);
  });
});

describe("parseTerminalCreateJson", () => {
  it("reads result.terminal.handle", () => {
    expect(
      parseTerminalCreateJson(envelope({ terminal: { handle: "term_abc" } })),
    ).toMatchObject({ handle: "term_abc" });
  });

  it("tolerates alternate handle shapes", () => {
    expect(parseTerminalCreateJson(envelope({ handle: "term_1" }))).toMatchObject({
      handle: "term_1",
    });
    expect(
      parseTerminalCreateJson(envelope({ terminalHandle: "term_2" })),
    ).toMatchObject({ handle: "term_2" });
    expect(
      parseTerminalCreateJson(envelope({ agentTerminalHandle: "term_3" })),
    ).toMatchObject({ handle: "term_3" });
    expect(
      parseTerminalCreateJson(envelope({ startupTerminal: { handle: "term_4" } })),
    ).toMatchObject({ handle: "term_4" });
  });

  it("throws when no handle is present", () => {
    expect(() => parseTerminalCreateJson(envelope({}))).toThrowError(
      OrcaJsonParseError,
    );
  });
});

describe("parseWorktreeCreateJson / parseWorktreeShowJson", () => {
  it("reads result.worktree.id with path metadata", () => {
    expect(
      parseWorktreeCreateJson(
        envelope({ worktree: { id: "repo::/path", path: "/path", displayName: "W" } }),
      ),
    ).toMatchObject({ id: "repo::/path", path: "/path", displayName: "W" });
  });

  it("tolerates top-level worktreeId", () => {
    expect(parseWorktreeShowJson(envelope({ worktreeId: "repo::/x" }))).toMatchObject({
      id: "repo::/x",
    });
  });

  it("throws when worktree id is missing", () => {
    expect(() => parseWorktreeShowJson(envelope({ worktree: {} }))).toThrowError(
      OrcaJsonParseError,
    );
  });
});

describe("parseRunCurrentJson", () => {
  it("returns runId when a Run is bound", () => {
    expect(
      parseRunCurrentJson(envelope({ run: { id: "run_123" } })),
    ).toMatchObject({ runId: "run_123" });
  });

  it("returns empty when no Run is bound (run:null)", () => {
    expect(parseRunCurrentJson(envelope({ run: null }))).toEqual({});
  });
});

describe("parseDispatchJson", () => {
  const fallback = { taskId: "task_1", terminalHandle: "term_1" };

  it("reads nested dispatch id", () => {
    expect(
      parseDispatchJson(envelope({ dispatch: { id: "dispatch_9" } }), fallback),
    ).toMatchObject({ taskId: "task_1", terminalHandle: "term_1", dispatchId: "dispatch_9" });
  });

  it("tolerates top-level dispatchId", () => {
    expect(
      parseDispatchJson(envelope({ dispatchId: "d_top" }), fallback),
    ).toMatchObject({ dispatchId: "d_top" });
  });

  it("leaves dispatchId undefined when Orca reports none (unsupervised inject)", () => {
    // dispatch --inject keeps operator terminals unsupervised: success without
    // a worker_dispatches row must still yield a usable receipt.
    const receipt = parseDispatchJson(envelope({ ok: true }), fallback);
    expect(receipt.taskId).toBe("task_1");
    expect(receipt.dispatchId).toBeUndefined();
  });

  it("propagates unsupervised flags", () => {
    expect(
      parseDispatchJson(envelope({ dispatch: { id: "d1", unsupervised: true } }), fallback)
        .unsupervised,
    ).toBe(true);
    expect(
      parseDispatchJson(envelope({ supervised: false }), fallback).unsupervised,
    ).toBe(true);
  });
});

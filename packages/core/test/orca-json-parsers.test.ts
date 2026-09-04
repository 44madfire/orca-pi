import { describe, expect, it } from "vitest";
import {
  isOutcomeUnknownState,
  ORCA_JSON_SNIPPET_LIMIT,
  OrcaJsonParseError,
  parseRunCurrentJson,
  parseTaskCreateJson,
  parseTerminalCreateJson,
  parseTerminalShowJson,
  parseWorkerStartAttemptJson,
  parseWorkerStartJson,
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

describe("isOutcomeUnknownState", () => {
  it("matches outcome_unknown case-insensitively", () => {
    expect(isOutcomeUnknownState("outcome_unknown")).toBe(true);
    expect(isOutcomeUnknownState("Outcome_Unknown")).toBe(true);
    expect(isOutcomeUnknownState("unknown")).toBe(true);
  });

  it("rejects ready/failed/other states", () => {
    expect(isOutcomeUnknownState("ready")).toBe(false);
    expect(isOutcomeUnknownState("failed")).toBe(false);
    expect(isOutcomeUnknownState(undefined)).toBe(false);
    expect(isOutcomeUnknownState("")).toBe(false);
  });
});

describe("parseWorkerStartAttemptJson (lenient, non-zero exits)", () => {
  it("extracts the full structured subset from an outcome_unknown receipt", () => {
    const attempt = parseWorkerStartAttemptJson(
      envelope({
        dispatchId: "dispatch_7",
        state: "outcome_unknown",
        failedStage: "prompt",
        effects: { created: ["terminal"] },
        residualResources: { terminals: ["term_x"] },
        nextCommands: ["orca orchestration worker-show --dispatch dispatch_7 --json"],
      }),
    );
    expect(attempt).toMatchObject({
      dispatchId: "dispatch_7",
      state: "outcome_unknown",
      failedStage: "prompt",
    });
    expect(attempt.effects).toEqual({ created: ["terminal"] });
    expect(attempt.residualResources).toEqual({ terminals: ["term_x"] });
    expect(attempt.nextCommands).toEqual([
      "orca orchestration worker-show --dispatch dispatch_7 --json",
    ]);
  });

  it("returns {} for ok:false and malformed payloads (no classification possible)", () => {
    expect(
      parseWorkerStartAttemptJson(
        JSON.stringify({ ok: false, error: { code: "x", message: "y" } }),
      ),
    ).toEqual({});
    expect(parseWorkerStartAttemptJson("{{{not json")).toEqual({});
    expect(parseWorkerStartAttemptJson(envelope({ ready: true }))).toEqual({});
  });
});

describe("parseTerminalShowJson", () => {
  it("reads the terminal worktree binding", () => {
    expect(
      parseTerminalShowJson(
        envelope({
          terminal: { handle: "term_1", worktreeId: "repo::/wt/a", worktreePath: "/wt/a" },
        }),
      ),
    ).toMatchObject({ id: "repo::/wt/a", path: "/wt/a" });
  });

  it("throws when the worktree binding is missing", () => {
    expect(() => parseTerminalShowJson(envelope({ terminal: {} }))).toThrowError(
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

describe("parseWorkerStartJson (supervised attach)", () => {
  const fallback = { taskId: "task_1", terminalHandle: "term_1" };

  it("reads the current worker-start shape (ready + dispatch + worker handle)", () => {
    const receipt = parseWorkerStartJson(
      envelope({
        ready: true,
        dispatch: { id: "dispatch_9" },
        worker: { agent_terminal_handle: "term_1" },
        setup: { status: "running" },
      }),
      fallback,
    );
    expect(receipt).toMatchObject({
      taskId: "task_1",
      terminalHandle: "term_1",
      dispatchId: "dispatch_9",
    });
  });

  it("tolerates alternate dispatch-id shapes", () => {
    expect(
      parseWorkerStartJson(envelope({ ready: true, dispatchId: "d_top" }), fallback),
    ).toMatchObject({ dispatchId: "d_top" });
    expect(
      parseWorkerStartJson(
        envelope({ dispatch: { dispatchId: "d_nested" } }),
        fallback,
      ),
    ).toMatchObject({ dispatchId: "d_nested" });
    expect(
      parseWorkerStartJson(
        envelope({ worker: { dispatch_id: "d_worker" } }),
        fallback,
      ),
    ).toMatchObject({ dispatchId: "d_worker" });
  });

  it("fails when the dispatch id is missing (never a supervised receipt)", () => {
    expect(() => parseWorkerStartJson(envelope({ ready: true }), fallback)).toThrowError(
      OrcaJsonParseError,
    );
    expect(() =>
      parseWorkerStartJson(envelope({ ok: true }), fallback),
    ).toThrowError(OrcaJsonParseError);
  });

  it("accepts an explicit ready state", () => {
    expect(
      parseWorkerStartJson(
        envelope({ state: "ready", dispatch: { id: "d1" } }),
        fallback,
      ),
    ).toMatchObject({ dispatchId: "d1" });
  });

  it("fails on non-ready state", () => {
    expect(() =>
      parseWorkerStartJson(
        envelope({ ready: false, dispatch: { id: "d1" } }),
        fallback,
      ),
    ).toThrowError(OrcaJsonParseError);
    expect(() =>
      parseWorkerStartJson(
        envelope({ stage: "failed", dispatch: { id: "d1" } }),
        fallback,
      ),
    ).toThrowError(OrcaJsonParseError);
    expect(() =>
      parseWorkerStartJson(
        envelope({ state: "outcome_unknown", dispatch: { id: "d1" } }),
        fallback,
      ),
    ).toThrowError(OrcaJsonParseError);
  });

  it("rejects unsupervised markers (dispatch --inject is not supervised)", () => {
    expect(() =>
      parseWorkerStartJson(
        envelope({ dispatch: { id: "d1", unsupervised: true } }),
        fallback,
      ),
    ).toThrowError(OrcaJsonParseError);
    expect(() =>
      parseWorkerStartJson(
        envelope({ dispatch: { id: "d1" }, supervised: false }),
        fallback,
      ),
    ).toThrowError(OrcaJsonParseError);
  });
});

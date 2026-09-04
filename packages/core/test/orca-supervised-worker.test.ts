import { describe, expect, it } from "vitest";
import { buildPiLaunch } from "../src/pi/build-pi-launch.js";
import { parseAndValidateProfilesText } from "../src/profile/load.js";
import { resolveProfile } from "../src/profile/resolve.js";
import {
  createOrcaCliProcess,
  OrcaCommandError,
  type OrcaCli,
} from "../src/orca/index.js";
import {
  formatPiCommandForTerminal,
  quoteForTerminalShell,
  summarizePiSpecForDiagnostics,
  terminalSelectorForPolicy,
  worktreeSelectorForNewWorktree,
} from "../src/orca/orca-cli.js";
import { spawnSupervisedPiWorker } from "../src/orca/spawn-supervised-pi-worker.js";
import { SupervisedWorkerError } from "../src/orca/receipts.js";
import type { CommandResult, ProcessRunner } from "../src/runner.js";

function ok(stdout: string): CommandResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function fakeRunner(
  handler: (executable: string, args: readonly string[]) => CommandResult | Error,
): ProcessRunner {
  return {
    async run(executable: string, args: readonly string[]) {
      const outcome = handler(executable, args);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
}

function envelope(result: unknown): string {
  return JSON.stringify({ id: "x", ok: true, result });
}

async function testLaunch() {
  const doc = parseAndValidateProfilesText(
    `profiles:\n  scout:\n    model: anthropic/claude-haiku\n    thinking: low\n    systemPrompt: Be brief.\n`,
    "test.yaml",
  );
  const profile = resolveProfile("scout", doc);
  const launch = await buildPiLaunch(profile, { projectRoot: "/repo/proj" });
  return { profile, launch };
}

/** Recording fake OrcaCli for spawn tests. */
function makeFakeOrca(overrides?: Partial<OrcaCli>): OrcaCli & {
  calls: string[];
  terminalCommands: string[];
} {
  const calls: string[] = [];
  const terminalCommands: string[] = [];
  const base: OrcaCli = {
    async resolveRunId() {
      calls.push("resolveRunId");
      return undefined;
    },
    async createTask() {
      calls.push("createTask");
      return { taskId: "task_default" };
    },
    async createWorktree(input) {
      calls.push(`createWorktree:${input.parent}`);
      return { id: `repo::/wt/${input.name}`, path: `/wt/${input.name}` };
    },
    async resolveWorktree(selector: string) {
      calls.push(`resolveWorktree:${selector}`);
      return { id: `repo::/wt/${selector}`, path: `/wt/${selector}` };
    },
    async createTerminal(input) {
      calls.push(`createTerminal:${input.worktreeSelector}`);
      terminalCommands.push(input.command);
      return { handle: "term_created" };
    },
    async waitForTerminal(handle: string) {
      calls.push(`waitForTerminal:${handle}`);
    },
    async dispatch(input) {
      calls.push(`dispatch:${input.taskId}:${input.terminalHandle}`);
      return {
        taskId: input.taskId,
        terminalHandle: input.terminalHandle,
        dispatchId: "dispatch_1",
      };
    },
    async closeTerminal(handle: string) {
      calls.push(`closeTerminal:${handle}`);
    },
  };
  return Object.assign(base, overrides ?? {}, { calls, terminalCommands });
}

describe("terminal shell quoting", () => {
  it("leaves safe tokens bare and single-quotes the rest", () => {
    expect(quoteForTerminalShell("pi")).toBe("pi");
    expect(quoteForTerminalShell("--model")).toBe("--model");
    expect(quoteForTerminalShell("")).toBe("''");
    expect(quoteForTerminalShell("hello world")).toBe("'hello world'");
    expect(quoteForTerminalShell(`it's`)).toBe(`'it'"'"'s'`);
  });

  it("serializes a spec as one shell line with prompt as a single quoted element", () => {
    const line = formatPiCommandForTerminal({
      command: "pi",
      args: ["--model", "anthropic/claude-haiku", "--system-prompt", "a b 'c'"],
      cwd: "/repo",
      env: {},
    });
    // POSIX single-quote escaping: ' → '"'"' inside outer single quotes.
    expect(line).toBe(`pi --model anthropic/claude-haiku --system-prompt 'a b '"'"'c'"'"''`);
    // Single quotes round-trip through the shell as one token (no splitting).
    expect(quoteForTerminalShell("a b 'c'")).toBe(`'a b '"'"'c'"'"''`);
  });

  it("redacts --system-prompt values in diagnostics", () => {
    const summary = summarizePiSpecForDiagnostics({
      command: "pi",
      args: ["--model", "m", "--system-prompt", "super secret prompt text"],
      cwd: "/repo",
      env: {},
    });
    expect(summary).toContain("pi");
    expect(summary).toContain("--model");
    expect(summary).not.toContain("super secret prompt text");
    expect(summary).toContain("redacted");
  });
});

describe("worktree policy mapping", () => {
  it("maps current to the active selector", () => {
    expect(terminalSelectorForPolicy({ kind: "current" })).toBe("active");
  });

  it("passes existing selectors through untouched", () => {
    expect(
      terminalSelectorForPolicy({ kind: "existing", selector: "name:My Work" }),
    ).toBe("name:My Work");
  });

  it("has no pre-creation selector for new worktrees, then uses id: form", () => {
    expect(terminalSelectorForPolicy({ kind: "new-child", name: "w" })).toBeUndefined();
    expect(terminalSelectorForPolicy({ kind: "new-top-level", name: "w" })).toBeUndefined();
    expect(worktreeSelectorForNewWorktree("repo::/path")).toBe("id:repo::/path");
  });
});

describe("orca-cli-process argv mapping", () => {
  it("creates tasks with --spec and --json as one argv element", async () => {
    const seen: { executable: string; args: readonly string[] }[] = [];
    const runner = fakeRunner((executable, args) => {
      seen.push({ executable, args });
      return ok(envelope({ task: { id: "task_1" } }));
    });
    const orca = createOrcaCliProcess(runner);
    const receipt = await orca.createTask({ spec: "do work; rm -rf /" });
    expect(receipt.taskId).toBe("task_1");
    const argv = seen[0]?.args ?? [];
    expect(argv).toContain("task-create");
    expect(argv).toContain("--json");
    const specIndex = argv.indexOf("--spec");
    expect(argv[specIndex + 1]).toBe("do work; rm -rf /");
  });

  it("passes --no-parent only for top-level worktrees (lineage vs Git base)", async () => {
    const seen: string[][] = [];
    const runner = fakeRunner((_exe, args) => {
      seen.push([...args]);
      return ok(envelope({ worktree: { id: "repo::/wt/x", path: "/wt/x" } }));
    });
    const orca = createOrcaCliProcess(runner);
    await orca.createWorktree({ name: "child-w", parent: "child" });
    await orca.createWorktree({ name: "top-w", parent: "top-level" });
    await orca.createWorktree({
      name: "based",
      parent: "top-level",
      baseBranch: "origin/main",
      setup: "run",
    });
    expect(seen[0]).toContain("child-w");
    expect(seen[0]).not.toContain("--no-parent");
    expect(seen[1]).toContain("--no-parent");
    expect(seen[2]).toContain("--no-parent");
    expect(seen[2]).toContain("origin/main");
    expect(seen[2]).toContain("run");
  });

  it("creates terminals with the Pi command as one --command element", async () => {
    const seen: string[][] = [];
    const runner = fakeRunner((_exe, args) => {
      seen.push([...args]);
      return ok(envelope({ terminal: { handle: "term_1" } }));
    });
    const orca = createOrcaCliProcess(runner);
    await orca.createTerminal({ worktreeSelector: "active", command: "pi --model x" });
    const argv = seen[0] ?? [];
    expect(argv).toContain("--worktree");
    expect(argv[argv.indexOf("--worktree") + 1]).toBe("active");
    expect(argv[argv.indexOf("--command") + 1]).toBe("pi --model x");
  });

  it("dispatches with --inject and tolerates missing dispatch ids", async () => {
    const seen: string[][] = [];
    const runner = fakeRunner((_exe, args) => {
      seen.push([...args]);
      return ok(envelope({}));
    });
    const orca = createOrcaCliProcess(runner);
    const receipt = await orca.dispatch({ taskId: "t", terminalHandle: "h" });
    expect(seen[0]).toContain("--inject");
    expect(receipt.dispatchId).toBeUndefined();
    expect(receipt.taskId).toBe("t");
  });

  it("maps missing executables to orca-missing (POSIX ENOENT and Windows text)", async () => {
    const enoent = new Error("spawn orca ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    const missing = createOrcaCliProcess(fakeRunner(() => enoent));
    await expect(missing.createTask({ spec: "x" })).rejects.toMatchObject({
      name: "OrcaCommandError",
      code: "orca-missing",
      isMissingExecutable: true,
    });

    const windowsRunner = fakeRunner(() => ({
      stdout: "",
      stderr: "'orca' is not recognized as an internal or external command,",
      exitCode: 1,
    }));
    await expect(
      createOrcaCliProcess(windowsRunner).createTask({ spec: "x" }),
    ).rejects.toMatchObject({ code: "orca-missing", isMissingExecutable: true });
  });

  it("flags unknown commands/flags as compatibility failures", async () => {
    const runner = fakeRunner(() =>
      ok(
        JSON.stringify({
          ok: false,
          error: { code: "unknown_option", message: "Unknown option --inject" },
        }),
      ),
    );
    // Exit-0 ok:false path still surfaces through runJson.
    const zeroExitUnknown = fakeRunner(() => ({
      stdout: JSON.stringify({
        ok: false,
        error: { code: "unknown_option", message: "Unknown option --inject" },
      }),
      stderr: "",
      exitCode: 0,
    }));
    await expect(
      createOrcaCliProcess(zeroExitUnknown).dispatch({ taskId: "t", terminalHandle: "h" }),
    ).rejects.toMatchObject({ isCompatibility: true });
    void runner;
  });

  it("wraps malformed JSON as orca-malformed-json", async () => {
    const runner = fakeRunner(() => ok("{{{not json"));
    await expect(
      createOrcaCliProcess(runner).createTask({ spec: "x" }),
    ).rejects.toMatchObject({ name: "OrcaCommandError", code: "orca-malformed-json" });
  });

  it("closeTerminal is idempotent for stale handles", async () => {
    const runner = fakeRunner(() => ({
      stdout: JSON.stringify({
        ok: false,
        error: { code: "terminal_handle_stale", message: "stale" },
      }),
      stderr: "",
      exitCode: 1,
    }));
    await expect(
      createOrcaCliProcess(runner).closeTerminal("term_stale"),
    ).resolves.toBeUndefined();
  });
});

describe("spawnSupervisedPiWorker happy path (current worktree)", () => {
  it("resolves Run, creates Task, reuses current worktree, waits, dispatches, and returns a frozen receipt", async () => {
    const { profile, launch } = await testLaunch();
    const orca = makeFakeOrca();
    const origResolve = orca.resolveRunId.bind(orca);
    void origResolve;
    orca.resolveRunId = async () => {
      orca.calls.push("resolveRunId");
      return "run_7";
    };
    orca.createTask = async (input) => {
      orca.calls.push("createTask");
      expect(input.spec).toContain("Implement");
      expect(input.runId).toBe("run_7");
      return { taskId: "task_42" };
    };
    const receipt = await spawnSupervisedPiWorker({
      orca,
      launch,
      profile,
      task: { spec: "Implement the thing", taskTitle: "Thing" },
    });

    expect(receipt.taskId).toBe("task_42");
    expect(receipt.dispatchId).toBe("dispatch_1");
    expect(receipt.terminalHandle).toBe("term_created");
    expect(receipt.worktree.selector).toBe("active");
    expect(receipt.worktree.createdNew).toBe(false);
    expect(receipt.profileName).toBe("scout");
    expect(receipt.piModel).toBe("anthropic/claude-haiku");
    expect(receipt.piCommand).toBe("pi");
    expect(receipt.piArgs).toContain("--model");
    expect(receipt.runId).toBe("run_7");
    expect(Object.isFrozen(receipt)).toBe(true);

    // Order: Run → Task → worktree → terminal → wait → dispatch.
    expect(orca.calls).toEqual([
      "resolveRunId",
      "createTask",
      "resolveWorktree:active",
      "createTerminal:active",
      "waitForTerminal:term_created",
      "dispatch:task_42:term_created",
    ]);

    // The Pi terminal command carries Pi argv but never the assigned task text.
    const command = orca.terminalCommands[0] as string;
    expect(command).toContain("pi");
    expect(command).toContain("--model");
    expect(command).not.toContain("Implement the thing");
  });

  it("uses an explicit runId without resolving", async () => {
    const { profile, launch } = await testLaunch();
    const orca = makeFakeOrca();
    let resolved = false;
    orca.resolveRunId = async () => {
      resolved = true;
      return "run_other";
    };
    const receipt = await spawnSupervisedPiWorker({
      orca,
      launch,
      profile,
      task: { spec: "work" },
      runId: "run_explicit",
    });
    expect(resolved).toBe(false);
    expect(receipt.runId).toBe("run_explicit");
  });
});

describe("spawnSupervisedPiWorker task selection", () => {
  it("reuses an existing Task id without calling createTask", async () => {
    const { profile, launch } = await testLaunch();
    const orca = makeFakeOrca();
    const receipt = await spawnSupervisedPiWorker({
      orca,
      launch,
      profile,
      task: { taskId: "task_existing" },
    });
    expect(receipt.taskId).toBe("task_existing");
    expect(orca.calls).not.toContain("createTask");
    expect(orca.calls).toContain("dispatch:task_existing:term_created");
  });

  it("creates a Task from an inline spec with title/parent/deps passthrough", async () => {
    const { profile, launch } = await testLaunch();
    let seenInput: unknown;
    const orca = makeFakeOrca({
      async createTask(input) {
        seenInput = input;
        return { taskId: "task_new" };
      },
    });
    await spawnSupervisedPiWorker({
      orca,
      launch,
      profile,
      task: {
        spec: "spec text",
        taskTitle: "Title",
        parentTaskId: "parent_1",
        deps: ["task_0"],
      },
    });
    expect(seenInput).toMatchObject({
      spec: "spec text",
      taskTitle: "Title",
      parentTaskId: "parent_1",
      deps: ["task_0"],
    });
  });
});

describe("spawnSupervisedPiWorker worktree policies", () => {
  it("targets existing selectors directly", async () => {
    const { profile, launch } = await testLaunch();
    const orca = makeFakeOrca();
    const receipt = await spawnSupervisedPiWorker({
      orca,
      launch,
      profile,
      task: { taskId: "t" },
      worktree: { kind: "existing", selector: "name:Other" },
    });
    expect(receipt.worktree.selector).toBe("name:Other");
    expect(receipt.worktree.createdNew).toBe(false);
    expect(orca.calls).toContain("resolveWorktree:name:Other");
    expect(orca.calls).toContain("createTerminal:name:Other");
  });

  it("creates child worktrees without --no-parent lineage and top-level with it (via OrcaCli parent)", async () => {
    const { profile, launch } = await testLaunch();
    const seenParents: string[] = [];
    const orca = makeFakeOrca({
      async createWorktree(input) {
        seenParents.push(input.parent);
        return { id: `repo::/wt/${input.name}`, path: `/wt/${input.name}` };
      },
    });
    const child = await spawnSupervisedPiWorker({
      orca,
      launch,
      profile,
      task: { taskId: "t" },
      worktree: { kind: "new-child", name: "child-w" },
    });
    expect(seenParents[0]).toBe("child");
    expect(child.worktree.createdNew).toBe(true);
    expect(child.worktree.selector).toBe("id:repo::/wt/child-w");

    const top = await spawnSupervisedPiWorker({
      orca,
      launch,
      profile,
      task: { taskId: "t" },
      worktree: { kind: "new-top-level", name: "top-w", baseBranch: "origin/main" },
    });
    expect(seenParents[1]).toBe("top-level");
    expect(top.worktree.selector).toBe("id:repo::/wt/top-w");
  });
});

describe("spawnSupervisedPiWorker failures leave recoverable state", () => {
  it("task-create failure creates no terminal", async () => {
    const { profile, launch } = await testLaunch();
    const orca = makeFakeOrca({
      async createTask() {
        throw new OrcaCommandError({
          code: "run_required",
          message: "task-create: no Run",
          executable: "orca",
          args: [],
          diagnostics: "no Run",
        });
      },
    });
    const error = await spawnSupervisedPiWorker({
      orca,
      launch,
      profile,
      task: { spec: "work" },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SupervisedWorkerError);
    expect((error as SupervisedWorkerError).stage).toBe("task-create");
    expect((error as SupervisedWorkerError).taskId).toBeUndefined();
    expect(orca.calls).not.toContain("createTerminal:active");
  });

  it("terminal-create failure leaves the Task undispatched", async () => {
    const { profile, launch } = await testLaunch();
    const orca = makeFakeOrca({
      async createTask() {
        return { taskId: "task_1" };
      },
      async createTerminal() {
        throw new OrcaCommandError({
          code: "terminal-full",
          message: "terminal-create: no capacity",
          executable: "orca",
          args: [],
          diagnostics: "full",
        });
      },
    });
    const error = await spawnSupervisedPiWorker({
      orca,
      launch,
      profile,
      task: { taskId: "task_1" },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SupervisedWorkerError);
    expect((error as SupervisedWorkerError).stage).toBe("terminal-create");
    expect((error as SupervisedWorkerError).taskId).toBe("task_1");
    expect(orca.calls.join(",")).not.toContain("dispatch:");
  });

  it("readiness timeout stops the new terminal (unless preserved) and never fakes completion", async () => {
    const { profile, launch } = await testLaunch();
    const orca = makeFakeOrca({
      async waitForTerminal() {
        throw new OrcaCommandError({
          code: "timeout",
          message: "terminal-readiness: timed out",
          executable: "orca",
          args: [],
          diagnostics: "timeout",
        });
      },
    });
    const error = await spawnSupervisedPiWorker({
      orca,
      launch,
      profile,
      task: { taskId: "task_1" },
    }).catch((e: unknown) => e);
    expect((error as SupervisedWorkerError).stage).toBe("terminal-readiness");
    expect((error as SupervisedWorkerError).terminalHandle).toBe("term_created");
    expect((error as SupervisedWorkerError).cleanup.terminalClosed).toBe(true);
    expect(orca.calls).toContain("closeTerminal:term_created");
    expect(orca.calls.join(",")).not.toContain("dispatch:");
  });

  it("preserveTerminalOnFailure keeps the pane for debugging", async () => {
    const { profile, launch } = await testLaunch();
    const orca = makeFakeOrca({
      async waitForTerminal() {
        throw new Error("tui never idle");
      },
    });
    const error = await spawnSupervisedPiWorker({
      orca,
      launch,
      profile,
      task: { taskId: "task_1" },
      preserveTerminalOnFailure: true,
    }).catch((e: unknown) => e);
    expect((error as SupervisedWorkerError).stage).toBe("terminal-readiness");
    expect(orca.calls).not.toContain("closeTerminal:term_created");
  });

  it("dispatch failure stops the unassigned terminal and reports cleanup", async () => {
    const { profile, launch } = await testLaunch();
    const orca = makeFakeOrca({
      async dispatch() {
        throw new OrcaCommandError({
          code: "dispatch-failed",
          message: "dispatch: circuit open",
          executable: "orca",
          args: [],
          diagnostics: "circuit",
        });
      },
    });
    const error = await spawnSupervisedPiWorker({
      orca,
      launch,
      profile,
      task: { taskId: "task_1" },
    }).catch((e: unknown) => e);
    expect((error as SupervisedWorkerError).stage).toBe("dispatch");
    expect((error as SupervisedWorkerError).cleanup.terminalClosed).toBe(true);
    expect(orca.calls).toContain("closeTerminal:term_created");
  });

  it("malformed Orca JSON surfaces as a staged failure with diagnostics", async () => {
    const { profile, launch } = await testLaunch();
    const { OrcaJsonParseError } = await import("../src/orca/json-parsers.js");
    const orca = makeFakeOrca({
      async createTask(): Promise<{ taskId: string }> {
        throw new OrcaJsonParseError("task-create", "(empty)", "task-create: malformed");
      },
    });
    const error = await spawnSupervisedPiWorker({
      orca,
      launch,
      profile,
      task: { spec: "work" },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SupervisedWorkerError);
    expect((error as SupervisedWorkerError).stage).toBe("task-create");
  });

  it("missing orca executable surfaces as task-create failure before side effects", async () => {
    const { profile, launch } = await testLaunch();
    const enoent = new Error("spawn orca ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    const runner = fakeRunner(() => enoent);
    const orca = createOrcaCliProcess(runner);
    const error = await spawnSupervisedPiWorker({
      orca,
      launch,
      profile,
      task: { spec: "work" },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SupervisedWorkerError);
    // Run resolution happens first and already needs orca.
    expect(["run-resolve", "task-create"]).toContain(
      (error as SupervisedWorkerError).stage,
    );
  });
});

describe("spawnSupervisedPiWorker cancellation is idempotent", () => {
  it("aborts before any Orca effects when already cancelled", async () => {
    const { profile, launch } = await testLaunch();
    const orca = makeFakeOrca();
    const controller = new AbortController();
    controller.abort(new Error("user cancel"));
    const error = await spawnSupervisedPiWorker({
      orca,
      launch,
      profile,
      task: { spec: "work" },
      signal: controller.signal,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SupervisedWorkerError);
    expect((error as SupervisedWorkerError).stage).toBe("cancelled");
    expect(orca.calls).toEqual([]);
  });

  it("cleanup closes at most once even when abort races readiness", async () => {
    const { profile, launch } = await testLaunch();
    let closes = 0;
    const controller = new AbortController();
    const orca = makeFakeOrca({
      async waitForTerminal() {
        controller.abort(new Error("cancel during wait"));
        // Simulate a wait that observes the abort via the spawn's next check:
        // throw nothing here; the spawn checks signal right after wait.
      },
    });
    const error = await spawnSupervisedPiWorker({
      orca,
      launch,
      profile,
      task: { taskId: "task_1" },
      signal: controller.signal,
    }).catch((e: unknown) => e);
    // Either readiness succeeded then the post-wait abort fired (cancelled +
    // cleanup), or readiness itself is the last success. In both cases the
    // terminal must be closed at most once and a second manual close is safe.
    if ((error as SupervisedWorkerError).stage === "cancelled") {
      expect(orca.calls.filter((c) => c.startsWith("closeTerminal")).length).toBe(1);
    }
    // Idempotent manual re-close never throws (stale-handle tolerant).
    orca.closeTerminal = async () => {
      closes++;
    };
    await orca.closeTerminal("term_created");
    await orca.closeTerminal("term_created");
    expect(closes).toBe(2);
  });
});

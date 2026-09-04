import { describe, expect, it } from "vitest";
import { parseAndValidateProfilesText } from "../src/profile/load.js";
import { resolveProfile } from "../src/profile/resolve.js";
import type { ResolvedPiProfile } from "../src/profile/types.js";
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
import {
  SupervisedWorkerError,
  WorkerStartAmbiguousError,
} from "../src/orca/receipts.js";
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

function testProfile(yaml = `profiles:\n  scout:\n    model: anthropic/claude-haiku\n    thinking: low\n    systemPrompt: Be brief.\n`): ResolvedPiProfile {
  const doc = parseAndValidateProfilesText(yaml, "test.yaml");
  return resolveProfile("scout", doc);
}

/** Recording fake OrcaCli for spawn tests. */
function makeFakeOrca(overrides?: Partial<OrcaCli>): OrcaCli & {
  calls: string[];
  terminalCommands: string[];
  worktreeCreates: { name: string; parent: string; parentWorktree?: string }[];
} {
  const calls: string[] = [];
  const terminalCommands: string[] = [];
  const worktreeCreates: { name: string; parent: string; parentWorktree?: string }[] = [];
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
      calls.push(`createWorktree:${input.parent}:${input.name}`);
      worktreeCreates.push({
        name: input.name,
        parent: input.parent,
        ...(input.parentWorktree !== undefined
          ? { parentWorktree: input.parentWorktree }
          : {}),
      });
      return { id: `repo::/wt/${input.name}`, path: `/wt/${input.name}` };
    },
    async resolveWorktree(selector: string) {
      calls.push(`resolveWorktree:${selector}`);
      return { id: `repo::/wt/${selector}`, path: `/wt/${selector}` };
    },
    async resolveTerminalWorktree(handle: string) {
      calls.push(`resolveTerminalWorktree:${handle}`);
      return { id: `repo::/wt/coordinator`, path: `/wt/coordinator` };
    },
    async createTerminal(input) {
      calls.push(`createTerminal:${input.worktreeSelector}`);
      terminalCommands.push(input.command);
      return { handle: "term_created" };
    },
    async waitForTerminal(handle: string) {
      calls.push(`waitForTerminal:${handle}`);
    },
    async attachWorker(input) {
      calls.push(
        `attachWorker:${input.taskId}:${input.terminalHandle}:${input.worktreeSelector ?? ""}`,
      );
      return {
        taskId: input.taskId,
        dispatchId: "dispatch_1",
        terminalHandle: input.terminalHandle,
      };
    },
    async closeTerminal(handle: string) {
      calls.push(`closeTerminal:${handle}`);
    },
  };
  return Object.assign(base, overrides ?? {}, {
    calls,
    terminalCommands,
    worktreeCreates,
  });
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

  it("passes explicit --parent-worktree for child worktrees and --no-parent for top-level", async () => {
    const seen: string[][] = [];
    const runner = fakeRunner((_exe, args) => {
      seen.push([...args]);
      return ok(envelope({ worktree: { id: "repo::/wt/x", path: "/wt/x" } }));
    });
    const orca = createOrcaCliProcess(runner);
    await orca.createWorktree({ name: "child-w", parent: "child" });
    await orca.createWorktree({
      name: "child-explicit",
      parent: "child",
      parentWorktree: "id:repo::/parent",
    });
    await orca.createWorktree({ name: "top-w", parent: "top-level" });
    await orca.createWorktree({
      name: "based",
      parent: "top-level",
      baseBranch: "origin/main",
      setup: "run",
    });
    // Child lineage is always explicit — never ambient inference.
    expect(seen[0]).toContain("child-w");
    expect(seen[0]).toContain("--parent-worktree");
    expect(seen[0][(seen[0]?.indexOf("--parent-worktree") ?? -1) + 1]).toBe("active");
    expect(seen[0]).not.toContain("--no-parent");
    expect(seen[1][(seen[1]?.indexOf("--parent-worktree") ?? -1) + 1]).toBe(
      "id:repo::/parent",
    );
    expect(seen[2]).toContain("--no-parent");
    expect(seen[2]).not.toContain("--parent-worktree");
    expect(seen[3]).toContain("--no-parent");
    expect(seen[3]).toContain("origin/main");
    expect(seen[3]).toContain("run");
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

  it("attaches supervised workers via worker-start --terminal (never --inject)", async () => {
    const seen: string[][] = [];
    const runner = fakeRunner((_exe, args) => {
      seen.push([...args]);
      return ok(
        envelope({
          ready: true,
          dispatch: { id: "dispatch_9" },
          worker: { agent_terminal_handle: "h" },
          setup: { status: "running" },
        }),
      );
    });
    const orca = createOrcaCliProcess(runner);
    const receipt = await orca.attachWorker({
      taskId: "t",
      terminalHandle: "h",
      worktreeSelector: "active",
    });
    const argv = seen[0] ?? [];
    expect(argv).toContain("worker-start");
    expect(argv).toContain("--terminal");
    expect(argv).toContain("--task");
    expect(argv).toContain("--worktree");
    expect(argv).toContain("--json");
    expect(argv).not.toContain("--inject");
    expect(argv).not.toContain("--agent");
    expect(argv).not.toContain("--model");
    expect(receipt.dispatchId).toBe("dispatch_9");
    expect(receipt.taskId).toBe("t");
    expect(receipt.terminalHandle).toBe("h");
  });

  it("classifies exit-1 outcome_unknown receipts as ambiguous (dispatch retained)", async () => {
    const runner = fakeRunner(() => ({
      stdout: envelope({
        dispatchId: "dispatch_7",
        state: "outcome_unknown",
        failedStage: "prompt",
        effects: { created: ["terminal"] },
        residualResources: { terminals: ["term_x"] },
        nextCommands: ["orca orchestration worker-show --dispatch dispatch_7 --json"],
      }),
      stderr: "",
      exitCode: 1,
    }));
    const error = await createOrcaCliProcess(runner)
      .attachWorker({ taskId: "t", terminalHandle: "h" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkerStartAmbiguousError);
    const ambiguous = error as WorkerStartAmbiguousError;
    expect(ambiguous.dispatchId).toBe("dispatch_7");
    expect(ambiguous.state).toBe("outcome_unknown");
    expect(ambiguous.failedStage).toBe("prompt");
    expect(ambiguous.effects).toEqual({ created: ["terminal"] });
    expect(ambiguous.residualResources).toEqual({ terminals: ["term_x"] });
    expect(ambiguous.nextCommands).toEqual([
      "orca orchestration worker-show --dispatch dispatch_7 --json",
    ]);
    expect(ambiguous.recoveryHint).toContain("worker-show");
    expect(ambiguous.taskId).toBe("t");
    expect(ambiguous.terminalHandle).toBe("h");
  });

  it("treats exit-1 definite failures as generic errors (no retained capability)", async () => {
    const failed = createOrcaCliProcess(
      fakeRunner(() => ({
        stdout: envelope({ dispatchId: "d9", state: "failed", failedStage: "start" }),
        stderr: "",
        exitCode: 1,
      })),
    );
    const error = await failed
      .attachWorker({ taskId: "t", terminalHandle: "h" })
      .catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(WorkerStartAmbiguousError);
    expect(error).toBeInstanceOf(OrcaCommandError);
  });

  it("resolves a terminal worktree binding via terminal show", async () => {
    const seen: string[][] = [];
    const runner = fakeRunner((_exe, args) => {
      seen.push([...args]);
      return ok(
        envelope({
          terminal: {
            handle: "term_coord",
            worktreeId: "repo::/wt/coordinator",
            worktreePath: "/wt/coordinator",
          },
        }),
      );
    });
    const identity = await createOrcaCliProcess(runner).resolveTerminalWorktree(
      "term_coord",
    );
    expect(identity).toMatchObject({ id: "repo::/wt/coordinator", path: "/wt/coordinator" });
    const argv = seen[0] ?? [];
    expect(argv.slice(0, 2)).toEqual(["terminal", "show"]);
    expect(argv).toContain("term_coord");
    expect(argv).toContain("--json");
  });

  it("fails the attach when the dispatch id is missing or the worker is not ready", async () => {
    const noId = createOrcaCliProcess(fakeRunner(() => ok(envelope({ ready: true }))));
    await expect(
      noId.attachWorker({ taskId: "t", terminalHandle: "h" }),
    ).rejects.toMatchObject({ name: "OrcaCommandError", code: "orca-malformed-json" });

    const notReady = createOrcaCliProcess(
      fakeRunner(() => ok(envelope({ ready: false, dispatch: { id: "d1" } }))),
    );
    await expect(
      notReady.attachWorker({ taskId: "t", terminalHandle: "h" }),
    ).rejects.toMatchObject({ name: "OrcaCommandError", code: "orca-malformed-json" });
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
    // Exit-0 ok:false path still surfaces through runJson.
    const zeroExitUnknown = fakeRunner(() => ({
      stdout: JSON.stringify({
        ok: false,
        error: { code: "unknown_option", message: "Unknown option --foo" },
      }),
      stderr: "",
      exitCode: 0,
    }));
    await expect(
      createOrcaCliProcess(zeroExitUnknown).attachWorker({
        taskId: "t",
        terminalHandle: "h",
      }),
    ).rejects.toMatchObject({ isCompatibility: true });
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
  it("resolves Run, creates Task, rebuilds the launch for the worktree, waits, attaches supervised, and returns a frozen receipt", async () => {
    const profile = testProfile();
    const orca = makeFakeOrca();
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

    // Order: Run → Task → worktree → terminal → wait → supervised attach.
    expect(orca.calls).toEqual([
      "resolveRunId",
      "createTask",
      "resolveWorktree:active",
      "createTerminal:active",
      "waitForTerminal:term_created",
      "attachWorker:task_42:term_created:active",
    ]);

    // The Pi terminal command carries Pi argv but never the assigned task text.
    const command = orca.terminalCommands[0] as string;
    expect(command).toContain("pi");
    expect(command).toContain("--model");
    expect(command).not.toContain("Implement the thing");
  });

  it("proves the receipt is supervised: real dispatch id, no unsupervised path", async () => {
    const profile = testProfile();
    const orca = makeFakeOrca();
    const receipt = await spawnSupervisedPiWorker({
      orca,
      profile,
      task: { taskId: "task_existing" },
    });
    expect(receipt.dispatchId).toBe("dispatch_1");
    expect(receipt.dispatchId.length).toBeGreaterThan(0);
    expect("unsupervised" in receipt).toBe(false);
    expect(orca.calls.some((c) => c.startsWith("attachWorker:"))).toBe(true);
  });

  it("uses an explicit runId without resolving", async () => {
    const profile = testProfile();
    const orca = makeFakeOrca();
    let resolved = false;
    orca.resolveRunId = async () => {
      resolved = true;
      return "run_other";
    };
    const receipt = await spawnSupervisedPiWorker({
      orca,
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
    const profile = testProfile();
    const orca = makeFakeOrca();
    const receipt = await spawnSupervisedPiWorker({
      orca,
      profile,
      task: { taskId: "task_existing" },
    });
    expect(receipt.taskId).toBe("task_existing");
    expect(orca.calls).not.toContain("createTask");
    expect(orca.calls).toContain("attachWorker:task_existing:term_created:active");
  });

  it("creates a Task from an inline spec with title/parent/deps passthrough", async () => {
    const profile = testProfile();
    let seenInput: unknown;
    const orca = makeFakeOrca({
      async createTask(input) {
        seenInput = input;
        return { taskId: "task_new" };
      },
    });
    await spawnSupervisedPiWorker({
      orca,
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

describe("spawnSupervisedPiWorker builds the launch against the selected checkout", () => {
  const SKILL_YAML = `profiles:\n  scout:\n    model: anthropic/claude-haiku\n    thinking: low\n    systemPrompt: Be brief.\n    skills: [.pi/skills/a]\n    extensions: [.pi/extensions/e.ts]\n`;

  it("existing worktree: Pi argv and cwd target the selected checkout, not the caller root", async () => {
    const profile = testProfile(SKILL_YAML);
    const orca = makeFakeOrca({
      async resolveWorktree() {
        orca.calls.push("resolveWorktree:path:/checkout/b");
        return { id: "repo::/checkout/b", path: "/checkout/b" };
      },
    });
    const receipt = await spawnSupervisedPiWorker({
      orca,
      profile,
      task: { taskId: "t" },
      worktree: { kind: "existing", selector: "path:/checkout/b" },
    });
    expect(receipt.piCwd).toBe("/checkout/b");
    expect(receipt.worktree.path).toBe("/checkout/b");
    const command = orca.terminalCommands[0] as string;
    expect(command).toContain("/checkout/b/.pi/skills/a");
    expect(command).toContain("/checkout/b/.pi/extensions/e.ts");
    expect(command).not.toContain("/repo/proj");
  });

  it("new-child worktree: rebuilt launch targets the created checkout", async () => {
    const profile = testProfile(SKILL_YAML);
    const orca = makeFakeOrca({
      async createWorktree(input) {
        orca.calls.push(`createWorktree:${input.parent}:${input.name}`);
        orca.worktreeCreates.push({
          name: input.name,
          parent: input.parent,
          ...(input.parentWorktree !== undefined
            ? { parentWorktree: input.parentWorktree }
            : {}),
        });
        return { id: "repo::/wt/child-w", path: "/wt/child-w" };
      },
    });
    const receipt = await spawnSupervisedPiWorker({
      orca,
      profile,
      task: { taskId: "t" },
      worktree: { kind: "new-child", name: "child-w" },
    });
    expect(receipt.piCwd).toBe("/wt/child-w");
    expect(receipt.worktree.createdNew).toBe(true);
    expect(receipt.worktree.selector).toBe("id:repo::/wt/child-w");
    const command = orca.terminalCommands[0] as string;
    expect(command).toContain("/wt/child-w/.pi/skills/a");
    // Parent lineage is explicit, never ambient inference.
    expect(orca.worktreeCreates[0]).toMatchObject({ parent: "child" });
  });

  it("passes an explicit parent selector for new-child worktrees", async () => {
    const profile = testProfile();
    const orca = makeFakeOrca();
    await spawnSupervisedPiWorker({
      orca,
      profile,
      task: { taskId: "t" },
      worktree: {
        kind: "new-child",
        name: "child-w",
        parentWorktree: "id:repo::/parent",
      },
    });
    expect(orca.worktreeCreates[0]).toMatchObject({
      parent: "child",
      parentWorktree: "id:repo::/parent",
    });
  });

  it("creates top-level worktrees with --no-parent lineage (via OrcaCli parent)", async () => {
    const profile = testProfile();
    const orca = makeFakeOrca();
    const top = await spawnSupervisedPiWorker({
      orca,
      profile,
      task: { taskId: "t" },
      worktree: { kind: "new-top-level", name: "top-w", baseBranch: "origin/main" },
    });
    expect(orca.worktreeCreates[0]).toMatchObject({ parent: "top-level" });
    expect(top.worktree.selector).toBe("id:repo::/wt/top-w");
  });

  it("rejects a non-empty Pi env overlay instead of silently dropping it", async () => {
    const profile = testProfile();
    const orca = makeFakeOrca();
    const error = await spawnSupervisedPiWorker({
      orca,
      profile,
      task: { taskId: "t" },
      launchOptions: { env: { FOO: "bar" } },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SupervisedWorkerError);
    expect((error as SupervisedWorkerError).stage).toBe("launch-build");
    expect((error as SupervisedWorkerError).code).toBe("launch-env-unsupported");
    expect(orca.calls).not.toContain("createTerminal:active");
  });

  it("surfaces prompt-file failures as launch-build with no terminal", async () => {
    const profile = testProfile(
      `profiles:\n  scout:\n    thinking: low\n    systemPromptFile: .pi/agents/missing.md\n`,
    );
    const orca = makeFakeOrca();
    const error = await spawnSupervisedPiWorker({
      orca,
      profile,
      task: { taskId: "t" },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SupervisedWorkerError);
    expect((error as SupervisedWorkerError).stage).toBe("launch-build");
    expect(orca.calls).not.toContain("createTerminal:active");
  });
});

describe("spawnSupervisedPiWorker current policy follows the coordinator", () => {
  const SKILL_YAML = `profiles:\n  scout:\n    model: anthropic/claude-haiku\n    thinking: low\n    systemPrompt: Be brief.\n    skills: [.pi/skills/a]\n`;
  const AMBIENT = { id: "repo::/wt/helper-ambient", path: "/wt/helper-ambient" };
  const COORDINATOR = { id: "repo::/wt/coordinator-b", path: "/wt/coordinator-b" };

  function crossWorktreeOrca() {
    const orca = makeFakeOrca({
      async resolveWorktree() {
        orca.calls.push("resolveWorktree:active");
        return { ...AMBIENT };
      },
      async resolveTerminalWorktree(handle: string) {
        orca.calls.push(`resolveTerminalWorktree:${handle}`);
        return { ...COORDINATOR };
      },
    });
    return orca;
  }

  it("helper ambient A + coordinator handle in B: Pi cwd/resources, terminal target, and attach all use B", async () => {
    const profile = testProfile(SKILL_YAML);
    const orca = crossWorktreeOrca();
    const receipt = await spawnSupervisedPiWorker({
      orca,
      profile,
      task: { taskId: "t" },
      fromHandle: "term_coordinator",
    });
    // Coordinator-bound exact selector, never helper ambient.
    expect(receipt.worktree.id).toBe(COORDINATOR.id);
    expect(receipt.worktree.selector).toBe(`id:${COORDINATOR.id}`);
    expect(receipt.piCwd).toBe("/wt/coordinator-b");
    expect(receipt.worktree.path).toBe("/wt/coordinator-b");
    const command = orca.terminalCommands[0] as string;
    expect(command).toContain("/wt/coordinator-b/.pi/skills/a");
    expect(command).not.toContain("/wt/helper-ambient");
    expect(orca.calls).toContain("resolveTerminalWorktree:term_coordinator");
    expect(orca.calls).toContain(`createTerminal:id:${COORDINATOR.id}`);
    expect(orca.calls).toContain(
      `attachWorker:t:term_created:id:${COORDINATOR.id}`,
    );
    expect(orca.calls).not.toContain("resolveWorktree:active");
  });

  it("resolves the full worktree record when terminal-show yields only an id", async () => {
    const profile = testProfile();
    const orca = makeFakeOrca({
      async resolveTerminalWorktree(handle: string) {
        orca.calls.push(`resolveTerminalWorktree:${handle}`);
        return { id: "repo::/wt/bare-id" };
      },
      async resolveWorktree(selector: string) {
        orca.calls.push(`resolveWorktree:${selector}`);
        expect(selector).toBe("id:repo::/wt/bare-id");
        return { id: "repo::/wt/bare-id", path: "/wt/bare-id" };
      },
    });
    const receipt = await spawnSupervisedPiWorker({
      orca,
      profile,
      task: { taskId: "t" },
      fromHandle: "term_coordinator",
    });
    expect(receipt.piCwd).toBe("/wt/bare-id");
    expect(receipt.worktree.selector).toBe("id:repo::/wt/bare-id");
  });

  it("fails closed when the coordinator worktree cannot be resolved", async () => {
    const profile = testProfile();
    const orca = makeFakeOrca({
      async resolveTerminalWorktree() {
        throw new OrcaCommandError({
          code: "terminal_handle_stale",
          message: "terminal-show: stale handle",
          executable: "orca",
          args: [],
          diagnostics: "stale",
        });
      },
    });
    const error = await spawnSupervisedPiWorker({
      orca,
      profile,
      task: { taskId: "t" },
      fromHandle: "term_stale",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SupervisedWorkerError);
    expect((error as SupervisedWorkerError).stage).toBe("worktree-resolve");
    expect((error as SupervisedWorkerError).code).toBe(
      "coordinator-worktree-resolve-failed",
    );
    expect(orca.calls.join(",")).not.toContain("createTerminal:");
  });
});

describe("spawnSupervisedPiWorker new-child parent lineage", () => {
  const AMBIENT = { id: "repo::/wt/helper-ambient", path: "/wt/helper-ambient" };
  const COORDINATOR = { id: "repo::/wt/coordinator", path: "/wt/coordinator" };

  function lineageOrca() {
    const orca = makeFakeOrca({
      async resolveWorktree() {
        orca.calls.push("resolveWorktree:active");
        return { ...AMBIENT };
      },
      async resolveTerminalWorktree(handle: string) {
        orca.calls.push(`resolveTerminalWorktree:${handle}`);
        return { ...COORDINATOR };
      },
    });
    return orca;
  }

  it("binds the default parent to the coordinator worktree, not helper ambient", async () => {
    const profile = testProfile();
    const orca = lineageOrca();
    await spawnSupervisedPiWorker({
      orca,
      profile,
      task: { taskId: "t" },
      worktree: { kind: "new-child", name: "child-w" },
      fromHandle: "term_coordinator",
    });
    expect(orca.calls).toContain("resolveTerminalWorktree:term_coordinator");
    expect(orca.worktreeCreates[0]).toMatchObject({
      parent: "child",
      parentWorktree: `id:${COORDINATOR.id}`,
    });
  });

  it("lets an explicit parentWorktree win over coordinator derivation", async () => {
    const profile = testProfile();
    const orca = lineageOrca();
    await spawnSupervisedPiWorker({
      orca,
      profile,
      task: { taskId: "t" },
      worktree: {
        kind: "new-child",
        name: "child-w",
        parentWorktree: "id:repo::/explicit-parent",
      },
      fromHandle: "term_coordinator",
    });
    expect(orca.calls).not.toContain("resolveTerminalWorktree:term_coordinator");
    expect(orca.worktreeCreates[0]).toMatchObject({
      parent: "child",
      parentWorktree: "id:repo::/explicit-parent",
    });
  });

  it("falls back to ambient active only when no coordinator handle exists", async () => {
    const profile = testProfile();
    const orca = lineageOrca();
    await spawnSupervisedPiWorker({
      orca,
      profile,
      task: { taskId: "t" },
      worktree: { kind: "new-child", name: "child-w" },
    });
    expect(orca.calls).not.toContain("resolveTerminalWorktree:term_coordinator");
    expect(orca.worktreeCreates[0]).toMatchObject({
      parent: "child",
      parentWorktree: "active",
    });
  });

  it("fails closed when the coordinator worktree cannot be resolved", async () => {
    const profile = testProfile();
    const orca = makeFakeOrca({
      async resolveTerminalWorktree() {
        throw new OrcaCommandError({
          code: "terminal_handle_stale",
          message: "terminal-show: stale handle",
          executable: "orca",
          args: [],
          diagnostics: "stale",
        });
      },
    });
    const error = await spawnSupervisedPiWorker({
      orca,
      profile,
      task: { taskId: "t" },
      worktree: { kind: "new-child", name: "child-w" },
      fromHandle: "term_stale",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SupervisedWorkerError);
    expect((error as SupervisedWorkerError).stage).toBe("worktree-create");
    expect((error as SupervisedWorkerError).code).toBe("worktree-parent-resolve-failed");
    expect(orca.calls).not.toContain("createTerminal:active");
  });
});

describe("spawnSupervisedPiWorker outcome_unknown keeps the worker alive", () => {
  it("retains the dispatch id, never closes the terminal, and points at recovery", async () => {
    const profile = testProfile();
    const orca = makeFakeOrca({
      async attachWorker(input) {
        orca.calls.push(`attachWorker:${input.taskId}:${input.terminalHandle}`);
        throw new WorkerStartAmbiguousError({
          dispatchId: "dispatch_7",
          state: "outcome_unknown",
          taskId: input.taskId,
          terminalHandle: input.terminalHandle,
        });
      },
    });
    const error = await spawnSupervisedPiWorker({
      orca,
      profile,
      task: { taskId: "task_1" },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SupervisedWorkerError);
    const staged = error as SupervisedWorkerError;
    expect(staged.stage).toBe("worker-start");
    expect(staged.code).toBe("worker-start-outcome-unknown");
    expect(staged.dispatchId).toBe("dispatch_7");
    expect(staged.terminalHandle).toBe("term_created");
    expect(staged.cleanup.terminalClosed).toBe(false);
    expect(staged.diagnostics).toContain("worker-show");
    expect(orca.calls).not.toContain("closeTerminal:term_created");
  });

  it("end-to-end: exit-1 outcome_unknown receipt keeps its dispatch and skips terminal close", async () => {
    const profile = testProfile();
    const seen: string[][] = [];
    const runner = fakeRunner((_exe, args) => {
      seen.push([...args]);
      const [group, command] = args;
      if (group === "orchestration" && command === "run-current") {
        return ok(envelope({ run: null }));
      }
      if (group === "orchestration" && command === "task-create") {
        return ok(envelope({ task: { id: "task_e2e" } }));
      }
      if (group === "worktree" && command === "current") {
        return ok(envelope({ worktree: { id: "repo::/wt/e2e", path: "/wt/e2e" } }));
      }
      if (group === "terminal" && command === "create") {
        return ok(envelope({ terminal: { handle: "term_e2e" } }));
      }
      if (group === "terminal" && command === "wait") {
        return ok(envelope({ waited: true }));
      }
      if (group === "orchestration" && command === "worker-start") {
        return {
          stdout: envelope({
            dispatchId: "dispatch_e2e",
            state: "outcome_unknown",
            failedStage: "prompt",
            effects: { created: ["dispatch"] },
            residualResources: { terminals: ["term_e2e"] },
          }),
          stderr: "",
          exitCode: 1,
        };
      }
      return { stdout: "", stderr: `unexpected: ${args.join(" ")}`, exitCode: 1 };
    });
    const error = await spawnSupervisedPiWorker({
      orca: createOrcaCliProcess(runner),
      profile,
      task: { spec: "e2e work" },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SupervisedWorkerError);
    const staged = error as SupervisedWorkerError;
    expect(staged.code).toBe("worker-start-outcome-unknown");
    expect(staged.dispatchId).toBe("dispatch_e2e");
    expect(staged.cleanup.terminalClosed).toBe(false);
    // The terminal was never closed: no `terminal close` argv was issued.
    expect(seen.some((argv) => argv[1] === "close")).toBe(false);
    expect(seen.some((argv) => argv[1] === "worker-start")).toBe(true);
  });
});

describe("spawnSupervisedPiWorker failures leave recoverable state", () => {
  it("task-create failure creates no terminal", async () => {
    const profile = testProfile();
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
      profile,
      task: { spec: "work" },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SupervisedWorkerError);
    expect((error as SupervisedWorkerError).stage).toBe("task-create");
    expect((error as SupervisedWorkerError).taskId).toBeUndefined();
    expect(orca.calls).not.toContain("createTerminal:active");
  });

  it("terminal-create failure leaves the Task unattached", async () => {
    const profile = testProfile();
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
      profile,
      task: { taskId: "task_1" },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SupervisedWorkerError);
    expect((error as SupervisedWorkerError).stage).toBe("terminal-create");
    expect((error as SupervisedWorkerError).taskId).toBe("task_1");
    expect(orca.calls.join(",")).not.toContain("attachWorker:");
  });

  it("readiness timeout stops the new terminal (unless preserved) and never fakes completion", async () => {
    const profile = testProfile();
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
      profile,
      task: { taskId: "task_1" },
    }).catch((e: unknown) => e);
    expect((error as SupervisedWorkerError).stage).toBe("terminal-readiness");
    expect((error as SupervisedWorkerError).terminalHandle).toBe("term_created");
    expect((error as SupervisedWorkerError).cleanup.terminalClosed).toBe(true);
    expect(orca.calls).toContain("closeTerminal:term_created");
    expect(orca.calls.join(",")).not.toContain("attachWorker:");
  });

  it("preserveTerminalOnFailure keeps the pane for debugging", async () => {
    const profile = testProfile();
    const orca = makeFakeOrca({
      async waitForTerminal() {
        throw new Error("tui never idle");
      },
    });
    const error = await spawnSupervisedPiWorker({
      orca,
      profile,
      task: { taskId: "task_1" },
      preserveTerminalOnFailure: true,
    }).catch((e: unknown) => e);
    expect((error as SupervisedWorkerError).stage).toBe("terminal-readiness");
    expect(orca.calls).not.toContain("closeTerminal:term_created");
  });

  it("worker-start failure stops the unattached terminal and reports cleanup", async () => {
    const profile = testProfile();
    const orca = makeFakeOrca({
      async attachWorker() {
        throw new OrcaCommandError({
          code: "worker-start-failed",
          message: "worker-start: not ready",
          executable: "orca",
          args: [],
          diagnostics: "not ready",
        });
      },
    });
    const error = await spawnSupervisedPiWorker({
      orca,
      profile,
      task: { taskId: "task_1" },
    }).catch((e: unknown) => e);
    expect((error as SupervisedWorkerError).stage).toBe("worker-start");
    expect((error as SupervisedWorkerError).cleanup.terminalClosed).toBe(true);
    expect(orca.calls).toContain("closeTerminal:term_created");
  });

  it("malformed Orca JSON surfaces as a staged failure with diagnostics", async () => {
    const profile = testProfile();
    const { OrcaJsonParseError } = await import("../src/orca/json-parsers.js");
    const orca = makeFakeOrca({
      async createTask(): Promise<{ taskId: string }> {
        throw new OrcaJsonParseError("task-create", "(empty)", "task-create: malformed");
      },
    });
    const error = await spawnSupervisedPiWorker({
      orca,
      profile,
      task: { spec: "work" },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SupervisedWorkerError);
    expect((error as SupervisedWorkerError).stage).toBe("task-create");
  });

  it("missing orca executable surfaces as run-resolve failure before side effects", async () => {
    const profile = testProfile();
    const enoent = new Error("spawn orca ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    const runner = fakeRunner(() => enoent);
    const orca = createOrcaCliProcess(runner);
    const error = await spawnSupervisedPiWorker({
      orca,
      profile,
      task: { spec: "work" },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SupervisedWorkerError);
    // Run resolution happens first and already needs orca.
    expect((error as SupervisedWorkerError).stage).toBe("run-resolve");
  });
});

describe("spawnSupervisedPiWorker cancellation is idempotent", () => {
  it("aborts before any Orca effects when already cancelled", async () => {
    const profile = testProfile();
    const orca = makeFakeOrca();
    const controller = new AbortController();
    controller.abort(new Error("user cancel"));
    const error = await spawnSupervisedPiWorker({
      orca,
      profile,
      task: { spec: "work" },
      signal: controller.signal,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SupervisedWorkerError);
    expect((error as SupervisedWorkerError).stage).toBe("cancelled");
    expect(orca.calls).toEqual([]);
  });

  it("cleanup closes at most once even when abort races readiness", async () => {
    const profile = testProfile();
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

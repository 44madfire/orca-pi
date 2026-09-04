import { describe, expect, it } from "vitest";
import { run, type CliDeps } from "../src/main.js";
import type { CommandResult, OrcaCli } from "@orca-pi/core";

function memFs(files: Record<string, string> = {}): Pick<typeof import("node:fs/promises"), "readFile" | "stat"> {
  return {
    async readFile(path: unknown) {
      const key = String(path);
      if (Object.hasOwn(files, key)) return files[key]!;
      const error = new Error(`ENOENT: no such file ${key}`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    },
    async stat(path: unknown) {
      const key = String(path);
      if (Object.hasOwn(files, key)) return { isFile: () => true } as unknown as import("node:fs").Stats;
      const error = new Error(`ENOENT: no such file ${key}`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    },
  };
}

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
      return {
        dispatchId,
        taskId: "task_1",
        dispatchStatus: "dispatched",
        workerState: "running",
        terminalHandle: "term_1",
        raw: {},
      };
    },
    async listWorkers() {
      calls.push("listWorkers");
      return { entries: [], raw: {} };
    },
    async showDispatch(taskId: string) {
      calls.push(`showDispatch:${taskId}`);
      return { taskId, dispatchId: "dispatch_1", dispatchStatus: "dispatched", raw: {} };
    },
    async listTasks() {
      calls.push("listTasks");
      return { entries: [{ taskId: "task_1", status: "dispatched" }], raw: {} };
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

function makeDeps(orca?: OrcaCli, files: Record<string, string> = {}): { deps: CliDeps; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const runner = {
    async run(): Promise<CommandResult> {
      throw new Error("orchestration CLI tests use injected orca fake, never spawn");
    },
  };
  const deps: CliDeps = {
    runner,
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => err.push(text),
    version: "0.1.0-test",
    projectRoot: "/repo/p",
    env: {},
    homedir: "/home/u",
    fs: memFs(files),
    userConfigPathOverride: "/home/u/.pi/agent/profiles.yaml",
    projectConfigPathOverride: "/repo/p/.pi/profiles.yaml",
    ...(orca !== undefined ? { orca } : {}),
    mappingFs: {
      async readFile(): Promise<string> {
        const error = new Error("ENOENT") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      },
      async writeFile(): Promise<void> {
        return undefined;
      },
      async mkdir(): Promise<void> {
        return undefined;
      },
    },
  };
  return { deps, out, err };
}

describe("orca-pi spawn parser", () => {
  it("requires a profile and exactly one of --task/--task-id", async () => {
    const { deps, err } = makeDeps(makeFakeOrca());
    expect((await run(["spawn"], deps)).exitCode).toBe(2);
    expect(err.join("")).toContain("requires a profile");
    const second = makeDeps(makeFakeOrca());
    expect((await run(["spawn", "scout"], second.deps)).exitCode).toBe(2);
    expect(second.err.join("")).toContain("--task");
    const third = makeDeps(makeFakeOrca());
    expect(
      (await run(["spawn", "scout", "--task", "a", "--task-id", "task_1"], third.deps)).exitCode,
    ).toBe(2);
  });

  it("rejects unknown flags with exit 2", async () => {
    const { deps, err } = makeDeps(makeFakeOrca());
    expect((await run(["spawn", "scout", "--task", "x", "--frobnicate"], deps)).exitCode).toBe(2);
    expect(err.join("")).toContain("unknown spawn option");
  });

  it("rejects new-child without --name pre-launch", async () => {
    const orca = makeFakeOrca();
    const { deps, err } = makeDeps(orca);
    const result = await run(["spawn", "scout", "--task", "work", "--worktree", "new-child"], deps);
    expect(result.exitCode).toBe(2);
    expect(err.join("")).toContain("--name");
    expect(orca.calls).toEqual([]);
  });

  it("unknown profiles fail pre-launch with no Orca effects", async () => {
    const orca = makeFakeOrca();
    const { deps, err } = makeDeps(orca);
    const result = await run(["spawn", "nope", "--task", "work"], deps);
    expect(result.exitCode).toBe(1);
    expect(err.join("")).toContain('Unknown Pi profile "nope"');
    expect(orca.calls).toEqual([]);
  });

  it("spawn selects the requested profile and returns a JSON receipt", async () => {
    const orca = makeFakeOrca();
    const { deps, out } = makeDeps(orca);
    const result = await run(["spawn", "scout", "--task", "Map auth", "--json"], deps);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(out.join("")) as { profileName: string; dispatchId: string; taskId: string };
    expect(parsed.profileName).toBe("scout");
    expect(parsed.dispatchId).toBe("dispatch_1");
    expect(parsed.taskId).toBe("task_new");
    // Snapshot the stable receipt keys (Orca owns lifecycle; receipt carries identities).
    expect(Object.keys(parsed).sort()).toEqual(
      expect.arrayContaining(["dispatchId", "piArgs", "piCommand", "profileName", "taskId", "terminalHandle", "worktree"]),
    );
  });

  it("spawn --task-id reuses an existing task without createTask", async () => {
    const orca = makeFakeOrca();
    const { deps, out } = makeDeps(orca);
    const result = await run(["spawn", "worker", "--task-id", "task_existing", "--json"], deps);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(out.join(""))).toMatchObject({ taskId: "task_existing" });
    expect(orca.calls).not.toContain("createTask");
  });
});

describe("orca-pi status/send/wait/stop parsers", () => {
  it("status rejects --worker+--task together", async () => {
    const { deps, err } = makeDeps(makeFakeOrca());
    expect((await run(["status", "--worker", "d", "--task", "t"], deps)).exitCode).toBe(2);
    expect(err.join("")).toContain("mutually exclusive");
  });

  it("status --json returns a stable worker receipt", async () => {
    const { deps, out } = makeDeps(makeFakeOrca());
    const result = await run(["status", "--worker", "dispatch_1", "--json"], deps);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(out.join(""))).toMatchObject({ kind: "worker" });
  });

  it("bare status --json returns a list sweep", async () => {
    const { deps, out } = makeDeps(makeFakeOrca());
    const result = await run(["status", "--json"], deps);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(out.join(""))).toMatchObject({ kind: "list" });
  });

  it("send requires --worker and --message", async () => {
    const { deps, err } = makeDeps(makeFakeOrca());
    expect((await run(["send", "--worker", "d"], deps)).exitCode).toBe(2);
    expect(err.join("")).toContain("--message");
    expect((await run(["send", "--message", "hi"], deps)).exitCode).toBe(2);
  });

  it("send rejects worker_done/heartbeat types (provenance)", async () => {
    const { deps, err } = makeDeps(makeFakeOrca());
    expect(
      (await run(["send", "--worker", "d", "--message", "hi", "--type", "worker_done"], deps)).exitCode,
    ).toBe(2);
    expect(err.join("")).toContain("worker signal");
  });

  it("send --json delivers follow-up mail", async () => {
    const orca = makeFakeOrca();
    const { deps, out } = makeDeps(orca);
    const result = await run(["send", "--worker", "dispatch_1", "--message", "Prefer X", "--json"], deps);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(out.join(""))).toMatchObject({ dispatchId: "dispatch_1", delivered: true });
  });

  it("wait requires exactly one target and validates --timeout", async () => {
    const { deps } = makeDeps(makeFakeOrca());
    expect((await run(["wait"], deps)).exitCode).toBe(2);
    expect((await run(["wait", "--worker", "d", "--task", "t"], deps)).exitCode).toBe(2);
    const bad = makeDeps(makeFakeOrca());
    expect((await run(["wait", "--worker", "d", "--timeout", "bogus"], bad.deps)).exitCode).toBe(2);
    expect(bad.err.join("")).toContain("--timeout");
  });

  it("stop requires --worker and is idempotent JSON", async () => {
    const { deps, err } = makeDeps(makeFakeOrca());
    expect((await run(["stop"], deps)).exitCode).toBe(2);
    expect(err.join("")).toContain("--worker");
    const orca = makeFakeOrca({
      async stopWorker(dispatchId: string) {
        return { raw: {}, alreadyStopped: true, dispatchId } as unknown as { raw: unknown; alreadyStopped: boolean };
      },
    });
    const second = makeDeps(orca);
    const result = await run(["stop", "--worker", "dispatch_1", "--json"], second.deps);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(second.out.join(""))).toMatchObject({ alreadyStopped: true });
  });
});

describe("orchestration help and top-level usage", () => {
  it("appears in --help and supports per-command --help", async () => {
    const { deps, out } = makeDeps(makeFakeOrca());
    await run(["--help"], deps);
    expect(out.join("")).toContain("orca-pi spawn");
    expect(out.join("")).toContain("orca-pi status");
    expect(out.join("")).toContain("orca-pi wait");
    for (const cmd of ["spawn", "status", "send", "wait", "stop"] as const) {
      const h = makeDeps(makeFakeOrca());
      expect((await run([cmd, "--help"], h.deps)).exitCode).toBe(0);
    }
  });
});

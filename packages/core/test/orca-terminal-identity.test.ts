import { describe, expect, it } from "vitest";
import { parseAndValidateProfilesText } from "../src/profile/load.js";
import { resolveProfile } from "../src/profile/resolve.js";
import type { ResolvedPiProfile } from "../src/profile/types.js";
import type { OrcaCli } from "../src/orca/orca-cli.js";
import { spawnSupervisedPiWorker } from "../src/orca/spawn-supervised-pi-worker.js";

function profileFor(name: "worker" | "reviewer" | "scout"): ResolvedPiProfile {
  const yaml =
    name === "worker"
      ? `profiles:\n  worker:\n    thinking: high\n    systemPrompt: w\n    tools: [read, bash, edit]\n    githubIdentity: worker\n`
      : name === "reviewer"
        ? `profiles:\n  reviewer:\n    thinking: high\n    systemPrompt: r\n    tools: [read, bash]\n    githubIdentity: reviewer\n`
        : `profiles:\n  scout:\n    thinking: low\n    systemPrompt: s\n    tools: [read]\n`;
  const doc = parseAndValidateProfilesText(yaml, "test.yaml");
  return resolveProfile(name, doc);
}

function makeFakeOrca(): OrcaCli & { terminalCommands: string[]; calls: string[] } {
  const terminalCommands: string[] = [];
  const calls: string[] = [];
  const base: OrcaCli = {
    async resolveRunId() {
      return undefined;
    },
    async createTask() {
      return { taskId: "task_1" };
    },
    async createWorktree(input) {
      return { id: `repo::/wt/${input.name}`, path: `/wt/${input.name}` };
    },
    async resolveWorktree(selector: string) {
      calls.push(`resolveWorktree:${selector}`);
      return { id: `repo::/wt/${selector}`, path: `/wt/${selector}` };
    },
    async resolveTerminalWorktree() {
      return { id: "repo::/wt/c", path: "/wt/c" };
    },
    async createTerminal(input) {
      terminalCommands.push(input.command);
      return { handle: "term_1" };
    },
    async waitForTerminal() {},
    async attachWorker(input) {
      return { taskId: input.taskId, dispatchId: "dispatch_1", terminalHandle: input.terminalHandle };
    },
    async closeTerminal() {},
    async showWorker(dispatchId: string) {
      return { dispatchId, raw: {} };
    },
    async listWorkers() {
      return { entries: [], raw: {} };
    },
    async showDispatch(taskId: string) {
      return { taskId, raw: {} };
    },
    async listTasks() {
      return { entries: [], raw: {} };
    },
    async sendToDispatch() {
      return { raw: {} };
    },
    async stopWorker() {
      return { raw: {}, alreadyStopped: false };
    },
  };
  return Object.assign(base, { terminalCommands, calls });
}

describe("spawn propagates githubIdentity per-terminal (no global mutation)", () => {
  it("worker launch prefixes ORCA_PI_GITHUB_IDENTITY and records receipt", async () => {
    const orca = makeFakeOrca();
    const receipt = await spawnSupervisedPiWorker({
      orca,
      profile: profileFor("worker"),
      task: { taskId: "task_1" },
    });
    expect(receipt.githubIdentity).toBe("worker");
    expect(receipt.profileName).toBe("worker");
    expect(orca.terminalCommands[0]).toContain("ORCA_PI_GITHUB_IDENTITY=worker");
    expect(orca.terminalCommands[0]).toContain("ORCA_PI_PROFILE=worker");
    expect(orca.terminalCommands[0]).toContain("pi");
    // No secret values in the terminal command or receipt.
    expect(JSON.stringify(receipt)).not.toMatch(/ghs_|ghp_|BEGIN.*PRIVATE KEY/);
    expect(orca.terminalCommands[0]).not.toMatch(/ghs_|ghp_/);
  });

  it("reviewer launch prefixes reviewer identity", async () => {
    const orca = makeFakeOrca();
    const receipt = await spawnSupervisedPiWorker({
      orca,
      profile: profileFor("reviewer"),
      task: { taskId: "task_1" },
    });
    expect(receipt.githubIdentity).toBe("reviewer");
    expect(orca.terminalCommands[0]).toContain("ORCA_PI_GITHUB_IDENTITY=reviewer");
  });

  it("cross-role override fails closed before any Orca effects", async () => {
    const orca = makeFakeOrca();
    const error = await spawnSupervisedPiWorker({
      orca,
      profile: profileFor("reviewer"),
      task: { taskId: "task_1" },
      githubIdentityOverride: "worker",
    }).catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe("invalid-github-identity");
    expect(String((error as Error).message)).toMatch(/authoritative|cannot select worker/i);
    expect(orca.calls).toEqual([]);
    expect(orca.terminalCommands).toEqual([]);
  });

  it("matching override passes", async () => {
    const orca = makeFakeOrca();
    const receipt = await spawnSupervisedPiWorker({
      orca,
      profile: profileFor("worker"),
      task: { taskId: "task_1" },
      githubIdentityOverride: "worker",
    });
    expect(receipt.githubIdentity).toBe("worker");
  });
});

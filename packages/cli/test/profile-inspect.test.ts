import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run, type CliDeps } from "../src/main.js";
import type { CommandResult, ProcessRunner } from "@orca-pi/core";

function makeDeps(cwd?: string): { deps: CliDeps; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const runner: ProcessRunner = {
    async run(): Promise<CommandResult> {
      throw new Error("profile inspect must never spawn processes");
    },
  };
  const deps: CliDeps = {
    runner,
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => err.push(text),
    version: "0.1.0-test",
    ...(cwd !== undefined ? { cwd } : {}),
  };
  return { deps, out, err };
}

function makeProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "orca-pi-inspect-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return dir;
}

describe("orca-pi profile inspect", () => {
  it("prints redacted resolved config/argv without launching Pi", async () => {
    const dir = makeProject({
      ".pi/profiles.yaml": `profiles:\n  scout:\n    model: anthropic/claude-haiku\n    thinking: low\n    tools: [read, grep]\n    skills: [.pi/skills/repo-search]\n`,
    });
    const { deps, out, err } = makeDeps(dir);
    const result = await run(
      ["profile", "inspect", "scout", "--project-root", dir],
      deps,
    );
    expect(result.exitCode).toBe(0);
    expect(err.join("")).toBe("");
    const text = out.join("");
    expect(text).toContain("scout");
    expect(text).toContain("--model");
    expect(text).toContain("--thinking");
    expect(text).toContain("--no-skills");
    expect(text).toContain("DO NOT EXECUTE");
  });

  it("supports --json with full structured spec", async () => {
    const dir = makeProject({
      ".pi/profiles.yaml": `profiles:\n  worker:\n    model: anthropic/claude-sonnet\n    thinking: high\n    systemPrompt: hello\n`,
    });
    const { deps, out } = makeDeps(dir);
    const result = await run(
      ["profile", "inspect", "worker", "--project-root", dir, "--json"],
      deps,
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(out.join("")) as {
      profile: { name: string };
      spec: { command: string; args: string[]; cwd: string };
    };
    expect(parsed.profile.name).toBe("worker");
    expect(parsed.spec.command).toBe("pi");
    expect(parsed.spec.args).toContain("--model");
    expect(parsed.spec.cwd).toBe(dir);
  });

  it("resolves prompt files against projectRoot and preserves --cwd", async () => {
    const dir = makeProject({
      ".pi/profiles.yaml": `profiles:\n  scout:\n    model: anthropic/claude-haiku\n    systemPromptFile: .pi/agents/scout.md\n`,
      ".pi/agents/scout.md": "You are a scout.",
    });
    const { deps, out } = makeDeps(dir);
    const result = await run(
      ["profile", "inspect", "scout", "--project-root", dir, "--cwd", "/tmp/worktree-1", "--json"],
      deps,
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(out.join("")) as { spec: { cwd: string; args: string[] } };
    expect(parsed.spec.cwd).toBe("/tmp/worktree-1");
    const index = parsed.spec.args.indexOf("--system-prompt");
    expect(parsed.spec.args[index + 1]).toBe("You are a scout.");
  });

  it("fails with exit 1 and actionable message for unknown profiles", async () => {
    const dir = makeProject({
      ".pi/profiles.yaml": `profiles:\n  scout:\n    model: anthropic/claude-haiku\n`,
    });
    const { deps, err } = makeDeps(dir);
    const result = await run(
      ["profile", "inspect", "scouts", "--project-root", dir],
      deps,
    );
    expect(result.exitCode).toBe(1);
    expect(err.join("")).toContain("Unknown Pi profile");
  });

  it("fails with exit 1 for missing prompt files", async () => {
    const dir = makeProject({
      ".pi/profiles.yaml": `profiles:\n  ghost:\n    model: anthropic/claude-haiku\n    systemPromptFile: .pi/agents/missing.md\n`,
    });
    const { deps, err } = makeDeps(dir);
    const result = await run(
      ["profile", "inspect", "ghost", "--project-root", dir],
      deps,
    );
    expect(result.exitCode).toBe(1);
    expect(err.join("")).toContain("missing prompt file");
  });

  it("rejects missing names and unknown flags with exit 2", async () => {
    const { deps: d1, err: e1 } = makeDeps();
    expect((await run(["profile", "inspect"], d1)).exitCode).toBe(2);
    expect(e1.join("")).toContain("requires a profile name");

    const { deps: d2, err: e2 } = makeDeps();
    expect((await run(["profile", "inspect", "x", "--bogus"], d2)).exitCode).toBe(2);
    expect(e2.join("")).toContain("unknown profile inspect option");
  });
});

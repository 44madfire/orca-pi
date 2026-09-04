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
  const dir = mkdtempSync(join(tmpdir(), "orca-pi-ctx-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return dir;
}

describe("orca-pi profile inspect --context-summary", () => {
  it("prints a context summary alongside inspect output", async () => {
    const dir = makeProject({});
    const { deps, out, err } = makeDeps(dir);
    const result = await run(
      ["profile", "inspect", "scout", "--project-root", dir, "--context-summary"],
      deps,
    );
    expect(result.exitCode).toBe(0);
    expect(err.join("")).toBe("");
    const text = out.join("");
    expect(text).toContain("context summary");
    expect(text).toContain("prompt:");
    expect(text).toContain("tools:");
    expect(text).toContain("estimates, not provider billing");
    // Full inspect still follows for context.
    expect(text).toContain("profile: scout");
  });

  it("resolves builtins on fresh installs with no config files", async () => {
    const dir = makeProject({});
    const { deps, out } = makeDeps(dir);
    for (const name of ["scout", "worker", "reviewer"]) {
      const result = await run(["profile", "inspect", name, "--project-root", dir], deps);
      expect(result.exitCode).toBe(0);
    }
    expect(out.join("")).toContain("scout");
  });

  it("includes contextSummary in --json --context-summary output", async () => {
    const dir = makeProject({});
    const { deps, out } = makeDeps(dir);
    const result = await run(
      ["profile", "inspect", "reviewer", "--project-root", dir, "--json", "--context-summary"],
      deps,
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(out.join("")) as {
      profile: { name: string };
      contextSummary: { profileName: string; toolCount: number; promptChars: number };
    };
    expect(parsed.profile.name).toBe("reviewer");
    expect(parsed.contextSummary.profileName).toBe("reviewer");
    expect(parsed.contextSummary.toolCount).toBe(5);
    expect(parsed.contextSummary.promptChars).toBeGreaterThan(100);
  });

  it("omits contextSummary from --json without the flag", async () => {
    const dir = makeProject({});
    const { deps, out } = makeDeps(dir);
    const result = await run(
      ["profile", "inspect", "scout", "--project-root", dir, "--json"],
      deps,
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(out.join("")) as Record<string, unknown>;
    expect("contextSummary" in parsed).toBe(false);
  });
});

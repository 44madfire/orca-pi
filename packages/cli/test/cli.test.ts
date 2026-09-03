import { describe, expect, it } from "vitest";
import { run, type CliDeps } from "../src/main.js";
import type { CommandResult, ProcessRunner } from "@orca-pi/core";

function makeDeps(handler: (exe: string, args: readonly string[]) => CommandResult | Error): {
  deps: CliDeps;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  const runner: ProcessRunner = {
    async run(executable: string, args: readonly string[]) {
      const outcome = handler(executable, args);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
  const deps: CliDeps = {
    runner,
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => err.push(text),
    version: "0.1.0-test",
  };
  return { deps, out, err };
}

function ok(stdout: string): CommandResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function enoent(executable: string): Error {
  const error = new Error(`spawn ${executable} ENOENT`) as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return error;
}

describe("orca-pi --version", () => {
  it("prints the injected version", async () => {
    const { deps, out } = makeDeps(() => ok(""));
    const result = await run(["--version"], deps);
    expect(result.exitCode).toBe(0);
    expect(out.join("")).toContain("0.1.0-test");
  });

  it("rejects extra arguments with exit 2", async () => {
    const { deps, err } = makeDeps(() => ok(""));
    const result = await run(["--version", "extra"], deps);
    expect(result.exitCode).toBe(2);
    expect(err.join("")).toContain("takes no arguments");
  });
});

describe("orca-pi --help", () => {
  it("prints usage with exit 0", async () => {
    const { deps, out } = makeDeps(() => ok(""));
    const result = await run(["--help"], deps);
    expect(result.exitCode).toBe(0);
    expect(out.join("")).toContain("orca-pi doctor");
  });
});

describe("orca-pi doctor", () => {
  it("exits 0 and prints versions when both CLIs exist", async () => {
    const { deps, out } = makeDeps((executable, args) => {
      if (executable === "pi") return ok("0.84.4");
      if (args[0] === "--version") return ok("Usage: orca");
      return ok(JSON.stringify({ result: { runtime: { appVersion: "1.4.196" } } }));
    });
    const result = await run(["doctor"], deps);
    expect(result.exitCode).toBe(0);
    expect(out.join("")).toContain("ok orca 1.4.196");
    expect(out.join("")).toContain("ok pi 0.84.4");
  });

  it("supports --json output", async () => {
    const { deps, out } = makeDeps((executable, args) => {
      if (executable === "pi") return ok("0.84.4");
      if (args[0] === "--version") return ok("Usage: orca");
      return ok(JSON.stringify({ result: { runtime: { appVersion: "1.4.196" } } }));
    });
    const result = await run(["doctor", "--json"], deps);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(out.join("")) as { ok: boolean; orca: { version: string } };
    expect(parsed.ok).toBe(true);
    expect(parsed.orca.version).toBe("1.4.196");
  });

  it("exits non-zero with actionable errors when CLIs are missing", async () => {
    const { deps, out, err } = makeDeps((executable) => enoent(executable));
    const result = await run(["doctor"], deps);
    expect(result.exitCode).toBe(1);
    expect(out.join("")).toContain("missing orca");
    expect(out.join("")).toContain("missing pi");
    expect(out.join("") + err.join("")).toContain("PATH");
  });

  it("rejects unknown doctor flags with exit 2", async () => {
    const { deps, err } = makeDeps(() => ok(""));
    const result = await run(["doctor", "--mutate"], deps);
    expect(result.exitCode).toBe(2);
    expect(err.join("")).toContain("unknown doctor option");
  });
});

describe("unknown commands", () => {
  it("exits 2 with usage on stderr", async () => {
    const { deps, err } = makeDeps(() => ok(""));
    const result = await run(["launch"], deps);
    expect(result.exitCode).toBe(2);
    expect(err.join("")).toContain("unknown command");
  });
});

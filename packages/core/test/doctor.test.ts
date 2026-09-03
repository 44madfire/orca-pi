import { describe, expect, it } from "vitest";
import {
  doctor,
  formatDoctorReport,
  parseOrcaStatusJson,
  parseVersionFromText,
  type CommandResult,
  type ProcessRunner,
} from "../src/index.js";

/** In-memory fake runner — no real processes are spawned. */
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

function ok(stdout: string): CommandResult {
  return { stdout, stderr: "", exitCode: 0 };
}

describe("parseVersionFromText", () => {
  it("extracts plain semver", () => {
    expect(parseVersionFromText("0.84.4")).toBe("0.84.4");
    expect(parseVersionFromText("pi 0.84.4\n")).toBe("0.84.4");
  });

  it("extracts the first version from usage text", () => {
    expect(parseVersionFromText("orca\n\nUsage: orca 1.4.196")).toBe("1.4.196");
  });

  it("returns undefined when no version is present", () => {
    expect(parseVersionFromText("Usage: orca <command>")).toBeUndefined();
    expect(parseVersionFromText("")).toBeUndefined();
  });
});

describe("parseOrcaStatusJson", () => {
  it("reads result.runtime.appVersion", () => {
    const text = JSON.stringify({ result: { runtime: { appVersion: "1.4.196" } } });
    expect(parseOrcaStatusJson(text)).toBe("1.4.196");
  });

  it("returns undefined for malformed or incomplete payloads", () => {
    expect(parseOrcaStatusJson("not json")).toBeUndefined();
    expect(parseOrcaStatusJson(JSON.stringify({ result: {} }))).toBeUndefined();
    expect(parseOrcaStatusJson(JSON.stringify({}))).toBeUndefined();
  });
});

describe("doctor", () => {
  it("reports versions when both CLIs are present", async () => {
    const runner = fakeRunner((executable, args) => {
      if (executable === "pi") return ok("0.84.4");
      if (executable === "orca" && args[0] === "--version") return ok("Usage: orca <command>");
      return ok(JSON.stringify({ result: { runtime: { appVersion: "1.4.196" } } }));
    });
    const report = await doctor(runner);
    expect(report.ok).toBe(true);
    expect(report.pi).toMatchObject({ found: true, version: "0.84.4" });
    expect(report.orca).toMatchObject({ found: true, version: "1.4.196" });
    expect(formatDoctorReport(report)).toContain("ok orca 1.4.196");
    expect(formatDoctorReport(report)).toContain("ok pi 0.84.4");
  });

  it("prefers orca --version when it yields a version", async () => {
    const runner = fakeRunner((executable) => {
      if (executable === "pi") return ok("pi 0.84.4");
      return ok("orca 1.5.0");
    });
    const report = await doctor(runner);
    expect(report.orca.version).toBe("1.5.0");
    expect(report.ok).toBe(true);
  });

  it("reports actionable errors and ok=false when executables are missing", async () => {
    const notFound = (executable: string) => {
      const error = new Error(`spawn ${executable} ENOENT`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      return error;
    };
    const runner = fakeRunner((executable) => notFound(executable));
    const report = await doctor(runner);
    expect(report.ok).toBe(false);
    expect(report.orca.found).toBe(false);
    expect(report.pi.found).toBe(false);
    expect(report.orca.detail).toContain("not found on PATH");
    expect(report.orca.detail).toContain("onorca.dev");
    expect(report.pi.detail).toContain("not found on PATH");
    expect(report.pi.detail).toContain("pi-mono");
    expect(formatDoctorReport(report)).toContain("missing orca");
    expect(formatDoctorReport(report)).toContain("missing pi");
  });

  it("flags a non-zero pi exit as not found with output context", async () => {
    const runner = fakeRunner((executable, args) => {
      if (executable === "pi") return { stdout: "", stderr: "boom", exitCode: 1 };
      if (executable === "orca" && args[0] === "--version") return ok("Usage: orca");
      return ok(JSON.stringify({ result: { runtime: { appVersion: "1.4.196" } } }));
    });
    const report = await doctor(runner);
    expect(report.ok).toBe(false);
    expect(report.pi.found).toBe(false);
    expect(report.pi.detail).toContain("exited with code 1");
    expect(report.orca.found).toBe(true);
  });

  it("normalizes Windows cmd.exe 'not recognized' output to not-found", async () => {
    const runner = fakeRunner(() => ({
      stdout: "",
      stderr: "'pi' is not recognized as an internal or external command,",
      exitCode: 1,
    }));
    const report = await doctor(runner);
    expect(report.ok).toBe(false);
    expect(report.pi.detail).toContain("not found on PATH");
    expect(report.orca.detail).toContain("not found on PATH");
  });

  it("never shells out beyond --version and status --json", async () => {
    const seen: string[] = [];
    const runner = fakeRunner((executable, args) => {
      seen.push(`${executable} ${args.join(" ")}`);
      if (executable === "pi") return ok("0.84.4");
      if (args[0] === "--version") return ok("no version here");
      return ok(JSON.stringify({ result: { runtime: { appVersion: "1.4.196" } } }));
    });
    await doctor(runner);
    expect(seen.sort()).toEqual(["orca --version", "orca status --json", "pi --version"].sort());
  });
});

#!/usr/bin/env node
/**
 * `orca-pi` companion CLI (OP1.1 scaffold + OP1.2 profiles + OP1.3 launcher).
 *
 * Owns profile loading, deterministic Pi argv construction (JEF-7), and
 * calls to the public `orca` CLI. The thin Orca plugin shell delegates to
 * this binary so orchestration logic never depends on the plugin worker's
 * capability model (see README.md and docs/ORCA_PLUGIN_API.md).
 *
 * The testable entry is `run()` — it takes injected I/O and a runner so unit
 * tests never spawn real processes. The Node bootstrap at the bottom wires
 * the real `createNodeRunner()` and `process` streams.
 */
import {
  buildPiLaunch,
  createNodeRunner,
  doctor,
  formatDoctorReport,
  formatPiInspect,
  loadMergedProfiles,
  ORCA_PI_VERSION,
  resolveProfile,
  type ProcessRunner,
} from "@orca-pi/core";

export interface CliDeps {
  runner: ProcessRunner;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  version?: string;
  /**
   * Default project root for `profile inspect` (tests inject a temp dir).
   * Defaults to `process.cwd()` when omitted.
   */
  cwd?: string;
}

export interface CliResult {
  exitCode: number;
}

const USAGE = `orca-pi — companion CLI for the Orca–Pi integration

Usage:
  orca-pi --version | -V
  orca-pi --help | -h
  orca-pi doctor [--json]
  orca-pi profile inspect <name> [--project-root <path>] [--cwd <path>] [--user-config <path>] [--project-config <path>] [--json] [--show-prompt]

Commands:
  doctor        Verify \`orca\` and \`pi\` are on PATH and report versions (read-only).
  profile       Inspect resolved Pi agent profiles and their deterministic Pi argv (read-only, never launches Pi).
`;

const PROFILE_INSPECT_USAGE = `usage: orca-pi profile inspect <name> [--project-root <path>] [--cwd <path>] [--user-config <path>] [--project-config <path>] [--json] [--show-prompt]
`;

function usage(deps: CliDeps): CliResult {
  deps.stdout(`${USAGE}\nversion ${deps.version ?? ORCA_PI_VERSION}\n`);
  return { exitCode: 0 };
}

async function runDoctor(
  args: readonly string[],
  deps: CliDeps,
): Promise<CliResult> {
  const asJson = args.includes("--json");
  const unknown = args.filter((arg) => arg !== "--json");
  if (unknown.length > 0) {
    deps.stderr(`error: unknown doctor option(s): ${unknown.join(", ")}\n`);
    deps.stderr("usage: orca-pi doctor [--json]\n");
    return { exitCode: 2 };
  }
  const report = await doctor(deps.runner);
  if (asJson) {
    deps.stdout(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    deps.stdout(`${formatDoctorReport(report)}\n`);
  }
  return { exitCode: report.ok ? 0 : 1 };
}

function defaultProjectRoot(deps: CliDeps): string {
  if (deps.cwd !== undefined && deps.cwd.length > 0) return deps.cwd;
  try {
    return process.cwd();
  } catch {
    return ".";
  }
}

async function runProfileInspect(
  args: readonly string[],
  deps: CliDeps,
): Promise<CliResult> {
  let name: string | undefined;
  let projectRoot: string | undefined;
  let cwd: string | undefined;
  let userConfigPath: string | undefined;
  let projectConfigPath: string | undefined;
  let asJson = false;
  let showPrompt = false;

  let i = 0;
  if (args[i] === "--help" || args[i] === "-h") {
    deps.stdout(PROFILE_INSPECT_USAGE);
    return { exitCode: 0 };
  }
  if (i < args.length && !args[i]?.startsWith("-")) {
    name = args[i];
    i++;
  }
  while (i < args.length) {
    const arg = args[i] as string;
    if (arg === "--json") {
      asJson = true;
      i++;
    } else if (arg === "--show-prompt") {
      showPrompt = true;
      i++;
    } else if (arg === "--project-root") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("-")) {
        deps.stderr(`error: --project-root requires a path value\n`);
        deps.stderr(PROFILE_INSPECT_USAGE);
        return { exitCode: 2 };
      }
      projectRoot = value;
      i += 2;
    } else if (arg === "--cwd") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("-")) {
        deps.stderr(`error: --cwd requires a path value\n`);
        deps.stderr(PROFILE_INSPECT_USAGE);
        return { exitCode: 2 };
      }
      cwd = value;
      i += 2;
    } else if (arg === "--user-config") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("-")) {
        deps.stderr(`error: --user-config requires a path value\n`);
        deps.stderr(PROFILE_INSPECT_USAGE);
        return { exitCode: 2 };
      }
      userConfigPath = value;
      i += 2;
    } else if (arg === "--project-config") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("-")) {
        deps.stderr(`error: --project-config requires a path value\n`);
        deps.stderr(PROFILE_INSPECT_USAGE);
        return { exitCode: 2 };
      }
      projectConfigPath = value;
      i += 2;
    } else if (arg === "--help" || arg === "-h") {
      deps.stdout(PROFILE_INSPECT_USAGE);
      return { exitCode: 0 };
    } else {
      deps.stderr(`error: unknown profile inspect option: ${arg}\n`);
      deps.stderr(PROFILE_INSPECT_USAGE);
      return { exitCode: 2 };
    }
  }

  if (name === undefined) {
    deps.stderr(`error: profile inspect requires a profile name\n`);
    deps.stderr(PROFILE_INSPECT_USAGE);
    return { exitCode: 2 };
  }

  const resolvedProjectRoot = projectRoot ?? defaultProjectRoot(deps);
  const resolvedCwd = cwd ?? resolvedProjectRoot;

  try {
    const merged = await loadMergedProfiles({
      projectRoot: resolvedProjectRoot,
      ...(userConfigPath !== undefined ? { userConfigPath } : {}),
      ...(projectConfigPath !== undefined ? { projectConfigPath } : {}),
    });
    const resolved = resolveProfile(name, merged);
    const launch = await buildPiLaunch(resolved, {
      projectRoot: resolvedProjectRoot,
      cwd: resolvedCwd,
    });
    if (asJson) {
      deps.stdout(
        `${JSON.stringify(
          {
            profile: resolved,
            promptSource: launch.promptSource,
            ...(launch.promptFileRelativePath !== undefined
              ? { promptFileRelativePath: launch.promptFileRelativePath }
              : {}),
            ...(launch.promptFileAbsolutePath !== undefined
              ? { promptFileAbsolutePath: launch.promptFileAbsolutePath }
              : {}),
            promptTransport: launch.promptTransport,
            ...(launch.promptTempPath !== undefined
              ? { promptTempPath: launch.promptTempPath }
              : {}),
            ...(launch.promptText !== undefined ? { promptText: launch.promptText } : {}),
            spec: launch.spec,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      // Display-only formatter — never executed. Execution always uses
      // `launch.spec.args` structurally (see build-pi-launch.ts).
      deps.stdout(`${formatPiInspect(resolved, launch, { showFullPrompt: showPrompt })}\n`);
    }
    return { exitCode: 0 };
  } catch (error) {
    deps.stderr(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return { exitCode: 1 };
  }
}

async function runProfile(
  args: readonly string[],
  deps: CliDeps,
): Promise<CliResult> {
  const [subcommand, ...rest] = args;
  if (subcommand === undefined || subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    deps.stdout(
      `orca-pi profile — inspect resolved Pi agent profiles (read-only, never launches Pi).\n\n${PROFILE_INSPECT_USAGE}`,
    );
    return { exitCode: 0 };
  }
  if (subcommand === "inspect") {
    return await runProfileInspect(rest, deps);
  }
  deps.stderr(`error: unknown profile subcommand: ${subcommand}\n`);
  deps.stderr(PROFILE_INSPECT_USAGE);
  return { exitCode: 2 };
}

/** Testable CLI entry. Never calls `process.exit` — returns an exit code. */
export async function run(
  argv: readonly string[],
  deps: CliDeps,
): Promise<CliResult> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    return usage(deps);
  }
  if (command === "--version" || command === "-V" || command === "version") {
    if (rest.length > 0) {
      deps.stderr(`error: --version takes no arguments\n`);
      return { exitCode: 2 };
    }
    deps.stdout(`${deps.version ?? ORCA_PI_VERSION}\n`);
    return { exitCode: 0 };
  }
  if (command === "doctor") {
    return await runDoctor(rest, deps);
  }
  if (command === "profile") {
    return await runProfile(rest, deps);
  }
  deps.stderr(`error: unknown command: ${command}\n`);
  deps.stderr(`${USAGE}`);
  return { exitCode: 2 };
}

// Node bootstrap — only runs when executed as a binary, not under test.
const isMain = (() => {
  try {
    const entry = process.argv[1] ?? "";
    return entry.endsWith("main.js") || entry.endsWith("orca-pi");
  } catch {
    return false;
  }
})();

if (isMain) {
  const deps: CliDeps = {
    runner: createNodeRunner(),
    stdout: (text: string) => process.stdout.write(text),
    stderr: (text: string) => process.stderr.write(text),
    version: ORCA_PI_VERSION,
  };
  run(process.argv.slice(2), deps)
    .then((result) => {
      process.exitCode = result.exitCode;
    })
    .catch((error) => {
      process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}

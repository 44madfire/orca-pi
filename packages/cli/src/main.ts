#!/usr/bin/env node
/**
 * `orca-pi` companion CLI (OP1.1 scaffold).
 *
 * Owns profile loading (future), Pi argv construction (future), and calls to
 * the public `orca` CLI. The thin Orca plugin shell delegates to this binary
 * so orchestration logic never depends on the plugin worker's capability
 * model (see README.md and docs/ORCA_PLUGIN_API.md).
 *
 * The testable entry is `run()` — it takes injected I/O and a runner so unit
 * tests never spawn real processes. The Node bootstrap at the bottom wires
 * the real `createNodeRunner()` and `process` streams.
 */
import {
  createNodeRunner,
  doctor,
  formatDoctorReport,
  ORCA_PI_VERSION,
  type ProcessRunner,
} from "@orca-pi/core";

export interface CliDeps {
  runner: ProcessRunner;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  version?: string;
}

export interface CliResult {
  exitCode: number;
}

const USAGE = `orca-pi — companion CLI for the Orca–Pi integration

Usage:
  orca-pi --version | -V
  orca-pi --help | -h
  orca-pi doctor [--json]

Commands:
  doctor        Verify \`orca\` and \`pi\` are on PATH and report versions (read-only).
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

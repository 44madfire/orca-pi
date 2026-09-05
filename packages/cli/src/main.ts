#!/usr/bin/env node
/**
 * `orca-pi` companion CLI (OP1.1 scaffold + OP1.2 profiles + OP1.3 launcher
 * + OP1.6 / JEF-10 defaults + OP1.7 UX + OP1.5 / JEF-9 compact orchestration).
 *
 * Owns profile loading, deterministic Pi argv construction (JEF-7), profile
 * management UX (JEF-11: list/show/inspect/validate/path with provenance),
 * and calls to the public `orca` CLI. The thin Orca plugin shell delegates
 * to this binary so orchestration logic never depends on the plugin worker's
 * capability model (see README.md and docs/ORCA_PLUGIN_API.md).
 *
 * The testable entry is `run()` — it takes injected I/O and a runner so unit
 * tests never spawn real processes. The Node bootstrap at the bottom wires
 * the real `createNodeRunner()` and `process` streams.
 *
 * JEF-7/JEF-11 wiring: `profile inspect` presentation lives in
 * `./commands/profiles.js` (JEF-11); the production launch preview is wired
 * here as the default `getLaunchPreview` via JEF-7's `buildPiLaunch` +
 * `formatPiInspect` (async: prompt-file I/O). Tests may inject a stub
 * provider instead. JEF-11 never builds argv itself.
 */
import {
  buildPiLaunch,
  createNodeRunner,
  doctor,
  formatDoctorReport,
  formatPiInspect,
  ORCA_PI_VERSION,
  type LaunchPreviewProvider,
  type ProcessRunner,
  type ResolvedPiProfile,
} from "@orca-pi/core";
import { runGithubCommand } from "./commands/github.js";
import { runProfilesCommand } from "./commands/profiles.js";
import { runOrchestrationCommand } from "./commands/orchestration.js";

export interface CliDeps {
  runner: ProcessRunner;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fetchFn?: import("@orca-pi/core").GithubFetchFn;
  version?: string;
  /** Project root for profile lookup (defaults to `process.cwd()`). */
  projectRoot?: string;
  /**
   * Legacy alias for `projectRoot` (JEF-7 tests inject a temp dir via `cwd`).
   * `projectRoot` wins when both are set.
   */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  osHomedir?: () => string;
  fs?: Pick<typeof import("node:fs/promises"), "readFile" | "stat">;
  /**
   * JEF-7 seam override. Defaults to the production build+format helper
   * below; tests inject stubs. May be async (prompt-file I/O).
   */
  getLaunchPreview?: LaunchPreviewProvider;
  userConfigPathOverride?: string;
  projectConfigPathOverride?: string;
  /**
   * JEF-9 seam: injectable Orca boundary (fake in tests, process-backed in
   * prod via `createOrcaCliProcess(runner)`). When omitted, orchestration
   * commands build one from `runner`.
   */
  orca?: import("@orca-pi/core").OrcaCli;
  /** Override the Orca executable name (default "orca"). */
  orcaExecutable?: string;
  /** Injectable worker-mapping file store (tests); defaults to node:fs. */
  mappingFs?: import("@orca-pi/core").MappingFs;
}

export interface CliResult {
  exitCode: number;
}

const USAGE = `orca-pi — companion CLI for the Orca–Pi integration

Usage:
  orca-pi --version | -V
  orca-pi --help | -h
  orca-pi doctor [--json]
  orca-pi profiles list [--json]
  orca-pi profile show <name> [--json] [--show-prompt]
  orca-pi profile inspect <name> [--project-root <path>] [--cwd <path>] [--user-config <path>] [--project-config <path>] [--json] [--show-prompt] [--context-summary]
  orca-pi profile validate [<name>] [--json]
  orca-pi profile path [--project|--user] [--json]
  orca-pi spawn <profile> (--task <spec> | --task-id <id>) [--worktree <policy>] [--identity <name>] [--json]
  orca-pi status [--worker <handle>|--task <id>] [--json]
  orca-pi send --worker <handle> --message <text> [--json]
  orca-pi wait (--worker <handle>|--task <id>) [--timeout <duration>] [--json]
  orca-pi stop --worker <handle> [--json]
  orca-pi github auth status [--identity <name>] [--profile <name>] [--json]
  orca-pi github review [--identity reviewer] [--profile <name>] --pr <url|number> --verdict <approve|request-changes|comment> --body <text|@file> [--repo <owner/repo>] [--json]
  orca-pi github check start|complete [--identity reviewer] [--profile <name>] --repo <owner/repo> --sha <sha> ...
  orca-pi github doctor [--repo <owner/repo>] [--ambient <login>] [--json]
  orca-pi github identity doctor [--repo <owner/repo>] [--json]
  orca-pi github setup --identity <name> [--repo <owner/repo>] [--json]
  orca-pi github mint --identity <name> [--json]
  orca-pi github exec [--identity <name>] [--profile <name>] -- <command...>
  orca-pi github setup-git --identity worker [--path <repo-path>] [--json]

Commands:
  doctor        Verify \`orca\` and \`pi\` are on PATH and report versions (read-only).
  profiles      List Pi role profiles (effective model/thinking/tools/skills).
  profile       Show/inspect/validate one profile or locate config files (inspect includes deterministic Pi argv, read-only, never launches Pi).
  spawn         Launch a role-specialized Orca-supervised Pi worker (Orca owns Task/Dispatch/worktree).
  status        Inspect worker/task state via Orca (never terminal-text inference).
  send          Send coordinator follow-up mail to one worker (structured inbox, not injection).
  wait          Wait for worker/task settlement with bounded polling/backoff/timeout.
  stop          Fence one worker terminal idempotently (never marks the Task complete).
  github        Distinct GitHub identities: formal PR reviews + orca-pi/agent-review check (reviewer App; human merges).

Profile config is authoritative (builtins < user/global < project); the UI never
creates a second store. show/inspect redact large prompt bodies unless
--show-prompt is given. Choose profiles by role (scout, worker, reviewer);
Orca owns Tasks/Dispatches/worktrees and completion.
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
  if (deps.projectRoot !== undefined && deps.projectRoot.length > 0) {
    return deps.projectRoot;
  }
  if (deps.cwd !== undefined && deps.cwd.length > 0) return deps.cwd;
  try {
    return process.cwd();
  } catch {
    return ".";
  }
}

/**
 * Production JEF-7 launch-preview provider (JEF-7 owns the implementation;
 * JEF-11 consumes it through the `LaunchPreviewProvider` seam).
 *
 * Builds the deterministic launch (async: may read `systemPromptFile`
 * against `projectRoot`) and renders it with the redacted display-only
 * formatter. Returns the preview string plus the structured launch fields
 * JEF-7's `--json` contract requires (`spec`, prompt provenance/transport).
 * Display output must never be executed — launchers use `spec.args`
 * structurally.
 */
export const productionGetLaunchPreview: LaunchPreviewProvider = async (
  resolved: ResolvedPiProfile,
  context: { projectRoot: string; cwd: string; showFullPrompt: boolean },
) => {
  const launch = await buildPiLaunch(resolved, {
    projectRoot: context.projectRoot,
    cwd: context.cwd,
  });
  return {
    preview: formatPiInspect(resolved, launch, {
      showFullPrompt: context.showFullPrompt,
    }),
    spec: launch.spec,
    promptSource: launch.promptSource,
    ...(launch.promptFileRelativePath !== undefined
      ? { promptFileRelativePath: launch.promptFileRelativePath }
      : {}),
    ...(launch.promptFileAbsolutePath !== undefined
      ? { promptFileAbsolutePath: launch.promptFileAbsolutePath }
      : {}),
    ...(launch.promptTransport !== undefined
      ? { promptTransport: launch.promptTransport }
      : {}),
    ...(launch.promptTempPath !== undefined
      ? { promptTempPath: launch.promptTempPath }
      : {}),
    ...(launch.promptText !== undefined ? { promptText: launch.promptText } : {}),
  };
};

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
  if (
    command === "spawn" ||
    command === "status" ||
    command === "send" ||
    command === "wait" ||
    command === "stop"
  ) {
    return await runOrchestrationCommand(command, rest, {
      stdout: deps.stdout,
      stderr: deps.stderr,
      projectRoot: defaultProjectRoot(deps),
      runner: deps.runner,
      ...(deps.orca !== undefined ? { orca: deps.orca } : {}),
      ...(deps.orcaExecutable !== undefined ? { orcaExecutable: deps.orcaExecutable } : {}),
      ...(deps.env !== undefined ? { env: deps.env } : {}),
      ...(deps.homedir !== undefined ? { homedir: deps.homedir } : {}),
      ...(deps.osHomedir !== undefined ? { osHomedir: deps.osHomedir } : {}),
      ...(deps.fs !== undefined ? { fs: deps.fs } : {}),
      ...(deps.mappingFs !== undefined ? { mappingFs: deps.mappingFs } : {}),
      ...(deps.userConfigPathOverride !== undefined
        ? { userConfigPathOverride: deps.userConfigPathOverride }
        : {}),
      ...(deps.projectConfigPathOverride !== undefined
        ? { projectConfigPathOverride: deps.projectConfigPathOverride }
        : {}),
    });
  }
  if (command === "github") {
    return await runGithubCommand(rest, {
      stdout: deps.stdout,
      stderr: deps.stderr,
      ...(deps.env !== undefined ? { env: deps.env } : {}),
      ...(deps.fs !== undefined ? { fs: deps.fs } : {}),
      ...(deps.fetchFn !== undefined ? { fetchFn: deps.fetchFn } : {}),
      projectRoot: defaultProjectRoot(deps),
      ...(deps.homedir !== undefined ? { homedir: deps.homedir } : {}),
      ...(deps.osHomedir !== undefined ? { osHomedir: deps.osHomedir } : {}),
      ...(deps.userConfigPathOverride !== undefined ? { userConfigPathOverride: deps.userConfigPathOverride } : {}),
      ...(deps.projectConfigPathOverride !== undefined ? { projectConfigPathOverride: deps.projectConfigPathOverride } : {}),
      runner: deps.runner,
    });
  }
  if (command === "profile" || command === "profiles") {
    return await runProfilesCommand(rest, {
      stdout: deps.stdout,
      stderr: deps.stderr,
      projectRoot: defaultProjectRoot(deps),
      ...(deps.env !== undefined ? { env: deps.env } : {}),
      ...(deps.homedir !== undefined ? { homedir: deps.homedir } : {}),
      ...(deps.osHomedir !== undefined ? { osHomedir: deps.osHomedir } : {}),
      ...(deps.fs !== undefined ? { fs: deps.fs } : {}),
      getLaunchPreview: deps.getLaunchPreview ?? productionGetLaunchPreview,
      ...(deps.userConfigPathOverride !== undefined
        ? { userConfigPathOverride: deps.userConfigPathOverride }
        : {}),
      ...(deps.projectConfigPathOverride !== undefined
        ? { projectConfigPathOverride: deps.projectConfigPathOverride }
        : {}),
    });
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

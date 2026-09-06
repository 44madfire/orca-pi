/**
 * Compact Pi-facing orchestration commands (OP1.5 / JEF-9).
 *
 * Thin CLI over `@orca-pi/core` orchestration operations:
 *
 * ```text
 * orca-pi spawn <profile> --task <spec> | --task-id <id> [--worktree ...] [--json]
 * orca-pi status [--worker <handle>|--task <id>] [--json]
 * orca-pi send --worker <handle> --message <text> [--json]
 * orca-pi wait --worker <handle>|--task <id> [--timeout <duration>] [--json]
 * orca-pi stop --worker <handle> [--json]
 * ```
 *
 * All commands are thin wrappers: profile resolution happens pre-launch
 * (unknown profiles fail before any Orca effects), Orca owns
 * Tasks/Dispatches/worktrees and completion, and terminal output is never
 * used as a status/completion authority. `--json` prints stable
 * machine-readable receipts; human output stays concise.
 */

import {
  CompactOrchestrationError,
  createOrcaCliProcess,
  formatTimeoutMs,
  getCompactStatus,
  parseTimeoutToMs,
  parseWorktreeFlag,
  sendCompactMessage,
  spawnCompactWorker,
  stopCompact,
  TimeoutParseError,
  waitCompact,
  WorktreeFlagError,
  DEFAULT_WAIT_TIMEOUT_MS,
  type OrcaCli,
} from "@orca-pi/core";
import { SupervisedWorkerError } from "@orca-pi/core";
import { OrcaCommandError } from "@orca-pi/core";

export interface OrchestrationCommandDeps {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  projectRoot: string;
  runner: import("@orca-pi/core").ProcessRunner;
  orca?: OrcaCli;
  orcaExecutable?: string;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  osHomedir?: () => string;
  fs?: Pick<typeof import("node:fs/promises"), "readFile" | "stat">;
  mappingFs?: import("@orca-pi/core").MappingFs;
  userConfigPathOverride?: string;
  projectConfigPathOverride?: string;
}

export interface OrchestrationCommandResult {
  exitCode: number;
}

export const ORCHESTRATION_USAGE = `orca-pi orchestration — compact Pi-facing worker lifecycle (Orca owns Tasks/Dispatches)

Usage:
  orca-pi spawn <profile> (--task <spec> | --task-id <id>) [--task-title <title>] [--parent <task-id>] [--deps <json-array>] [--worktree current|new-child|new-top-level|<selector>] [--name <worktree-name>] [--parent-worktree <selector>] [--base-branch <ref>] [--setup run|skip|inherit] [--from <handle>] [--run <run-id>] [--title <terminal-title>] [--identity <name>] [--json]
  orca-pi status [--worker <dispatch|terminal-handle>|--task <task-id>] [--run <run-id>] [--from <handle>] [--json]
  orca-pi send --worker <dispatch|terminal-handle> --message <text> [--subject <text>] [--from <handle>] [--run <run-id>] [--json]
  orca-pi wait (--worker <dispatch|terminal-handle>|--task <task-id>) [--timeout <duration>] [--run <run-id>] [--from <handle>] [--json]
  orca-pi stop --worker <dispatch|terminal-handle> [--from <handle>] [--json]

Worktree policy: current (default, coordinator checkout) | new-child/new-top-level (require --name) | existing selector (active, id:..., name:..., path:...).
Timeouts: 500ms, 30s, 5m, 1h (plain numbers mean seconds; default wait ${formatTimeoutMs(DEFAULT_WAIT_TIMEOUT_MS)}).
Profiles: choose by role (scout, worker, reviewer); model/tool/skill settings stay in profile config.
Orca is authoritative for completion/status — never use terminal output as completion authority.
`;

const SPAWN_USAGE =
  "usage: orca-pi spawn <profile> (--task <spec> | --task-id <id>) [--task-title <title>] [--parent <task-id>] [--deps <json-array>] [--worktree <policy>] [--name <name>] [--parent-worktree <selector>] [--base-branch <ref>] [--setup run|skip|inherit] [--from <handle>] [--run <run-id>] [--title <title>] [--json]\n";
const STATUS_USAGE = "usage: orca-pi status [--worker <handle>|--task <task-id>] [--run <run-id>] [--from <handle>] [--json]\n";
const SEND_USAGE = "usage: orca-pi send --worker <handle> --message <text> [--subject <text>] [--from <handle>] [--run <run-id>] [--json]\n";
const WAIT_USAGE = "usage: orca-pi wait (--worker <handle>|--task <task-id>) [--timeout <duration>] [--run <run-id>] [--from <handle>] [--json]\n";
const STOP_USAGE = "usage: orca-pi stop --worker <handle> [--from <handle>] [--json]\n";

function isHelpFlag(arg: string): boolean {
  return arg === "--help" || arg === "-h" || arg === "help";
}

function getOrca(deps: OrchestrationCommandDeps): OrcaCli {
  if (deps.orca) return deps.orca;
  return createOrcaCliProcess(deps.runner, {
    ...(deps.orcaExecutable !== undefined ? { executable: deps.orcaExecutable } : {}),
  });
}

function formatSpawnHuman(receipt: {
  profileName: string;
  taskId: string;
  dispatchId: string;
  terminalHandle: string;
  worktree: { id: string; selector: string; createdNew: boolean; path?: string };
  piModel?: string;
  runId?: string;
  githubIdentity?: string;
}): string {
  const lines = [
    `spawned ${receipt.profileName} worker`,
    `  task: ${receipt.taskId}`,
    `  dispatch: ${receipt.dispatchId} (use as --worker)`,
    `  terminal: ${receipt.terminalHandle}`,
    `  worktree: ${receipt.worktree.id} (${receipt.worktree.selector}${receipt.worktree.createdNew ? ", created new" : ""})`,
  ];
  if (receipt.piModel) lines.push(`  model: ${receipt.piModel}`);
  if (receipt.githubIdentity) lines.push(`  github: ${receipt.githubIdentity} (ORCA_PI_GITHUB_IDENTITY, per-terminal; no --identity repeat needed)`);
  if (receipt.runId) lines.push(`  run: ${receipt.runId}`);
  if (receipt.worktree.path) lines.push(`  path: ${receipt.worktree.path}`);
  return lines.join("\n");
}

function formatStatusHuman(receipt: import("@orca-pi/core").CompactStatusReceipt): string {
  if (receipt.kind === "list") {
    const workers = receipt.workers ?? [];
    const tasks = receipt.tasks;
    const lines: string[] = [];
    if (workers.length === 0) {
      lines.push("no supervised workers (Orca worker-list is empty)");
    } else {
      lines.push(`workers (${workers.length}):`);
      for (const w of workers) {
        const stateBits = [
          w.taskStatus ? `task ${w.taskStatus}` : null,
          w.dispatchStatus ? `dispatch ${w.dispatchStatus}` : null,
          w.workerState ? `worker ${w.workerState}` : null,
        ].filter((bit): bit is string => bit !== null);
        lines.push(
          `  ${w.dispatchId ?? w.terminalHandle ?? "(unknown)"} · task ${w.taskId ?? "?"} (${stateBits.join(", ") || "state unknown"}) · terminal ${w.terminalHandle ?? "?"} · ${w.settled ? "settled" : "running"}`,
        );
      }
    }
    if (tasks === undefined) {
      lines.push("(tasks unavailable: no Run bound — bind with Orca run-create/run-use for task scope)");
    } else if (tasks.length === 0) {
      lines.push("tasks: none");
    } else {
      lines.push(`tasks (${tasks.length}):`);
      for (const t of tasks) {
        lines.push(`  ${t.taskId} (${t.status ?? "status unknown"})${t.specTruncated ? ` — ${t.specTruncated.slice(0, 80)}` : ""}`);
      }
    }
    lines.push("Orca is authoritative for completion/status.");
    return lines.join("\n");
  }
  const s = receipt.status;
  if (!s) return "status unknown (Orca returned no state)";
  return `${receipt.kind} ${s.dispatchId ?? s.taskId ?? ""}: ${s.summary}\nOrca is authoritative for completion/status.`;
}

function errorMessage(error: unknown): string {
  if (error instanceof CompactOrchestrationError) return error.message;
  if (error instanceof WorktreeFlagError) return error.message;
  if (error instanceof TimeoutParseError) return error.message;
  if (error instanceof SupervisedWorkerError) {
    const parts = [error.message];
    if (error.taskId) parts.push(`(task ${error.taskId})`);
    if (error.dispatchId) parts.push(`(dispatch ${error.dispatchId})`);
    return parts.join(" ");
  }
  if (error instanceof OrcaCommandError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function parseDepsFlag(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new Error(`Invalid --deps "": expected a JSON array like ["task_1"].`);
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error("not an array");
    for (const entry of parsed) {
      if (typeof entry !== "string" || entry.length === 0) {
        throw new Error("deps must be non-empty strings");
      }
    }
    return [...(parsed as string[])];
  } catch (error) {
    throw new Error(
      `Invalid --deps "${raw}": expected a JSON array like ["task_1"] (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
}

async function runSpawn(args: readonly string[], deps: OrchestrationCommandDeps): Promise<OrchestrationCommandResult> {
  let profile: string | undefined;
  let taskSpec: string | undefined;
  let taskId: string | undefined;
  let taskTitle: string | undefined;
  let parent: string | undefined;
  let depsJson: string | undefined;
  let worktree = "current";
  let name: string | undefined;
  let parentWorktree: string | undefined;
  let baseBranch: string | undefined;
  let setup: string | undefined;
  let fromHandle: string | undefined;
  let runId: string | undefined;
  let title: string | undefined;
  let identityOverride: string | undefined;
  let asJson = false;
  const unknown: string[] = [];
  const takeValue = (flag: string, index: number): { value?: string; consumed: number } => {
    const value = args[index + 1];
    if (value === undefined || value.startsWith("-")) {
      unknown.push(`${flag} requires a value`);
      return { consumed: 1 };
    }
    return { value, consumed: 2 };
  };
  for (let i = 0; i < args.length; ) {
    const arg = args[i] as string;
    if (arg === "--json") { asJson = true; i += 1; }
    else if (arg === "--task") { const t = takeValue(arg, i); if (t.value !== undefined) taskSpec = t.value; i += t.consumed; }
    else if (arg === "--task-id") { const t = takeValue(arg, i); if (t.value !== undefined) taskId = t.value; i += t.consumed; }
    else if (arg === "--task-title") { const t = takeValue(arg, i); if (t.value !== undefined) taskTitle = t.value; i += t.consumed; }
    else if (arg === "--parent") { const t = takeValue(arg, i); if (t.value !== undefined) parent = t.value; i += t.consumed; }
    else if (arg === "--deps") { const t = takeValue(arg, i); if (t.value !== undefined) depsJson = t.value; i += t.consumed; }
    else if (arg === "--worktree") { const t = takeValue(arg, i); if (t.value !== undefined) worktree = t.value; i += t.consumed; }
    else if (arg === "--name") { const t = takeValue(arg, i); if (t.value !== undefined) name = t.value; i += t.consumed; }
    else if (arg === "--parent-worktree") { const t = takeValue(arg, i); if (t.value !== undefined) parentWorktree = t.value; i += t.consumed; }
    else if (arg === "--base-branch") { const t = takeValue(arg, i); if (t.value !== undefined) baseBranch = t.value; i += t.consumed; }
    else if (arg === "--setup") { const t = takeValue(arg, i); if (t.value !== undefined) setup = t.value; i += t.consumed; }
    else if (arg === "--from") { const t = takeValue(arg, i); if (t.value !== undefined) fromHandle = t.value; i += t.consumed; }
    else if (arg === "--run") { const t = takeValue(arg, i); if (t.value !== undefined) runId = t.value; i += t.consumed; }
    else if (arg === "--title") { const t = takeValue(arg, i); if (t.value !== undefined) title = t.value; i += t.consumed; }
    else if (arg === "--identity") { const t = takeValue(arg, i); if (t.value !== undefined) identityOverride = t.value; i += t.consumed; }
    else if (isHelpFlag(arg)) { deps.stdout(`${ORCHESTRATION_USAGE}`); return { exitCode: 0 }; }
    else if (arg.startsWith("--")) { unknown.push(arg); i += 1; }
    else if (profile === undefined) { profile = arg; i += 1; }
    else { unknown.push(arg); i += 1; }
  }
  if (unknown.length > 0) {
    deps.stderr(`error: unknown spawn option(s): ${unknown.join(", ")}\n`);
    deps.stderr(SPAWN_USAGE);
    return { exitCode: 2 };
  }
  if (!profile) {
    deps.stderr(`error: spawn requires a profile (scout, worker, or reviewer)\n`);
    deps.stderr(SPAWN_USAGE);
    return { exitCode: 2 };
  }
  if ((taskSpec === undefined) === (taskId === undefined)) {
    deps.stderr(`error: spawn requires exactly one of --task <spec> or --task-id <id>\n`);
    deps.stderr(SPAWN_USAGE);
    return { exitCode: 2 };
  }
  let parsedDeps: readonly string[] | undefined;
  if (depsJson !== undefined) {
    try {
      parsedDeps = parseDepsFlag(depsJson);
    } catch (error) {
      deps.stderr(`error: ${error instanceof Error ? error.message : String(error)}\n`);
      deps.stderr(SPAWN_USAGE);
      return { exitCode: 2 };
    }
  }
  let worktreePolicy: import("@orca-pi/core").WorktreePolicy;
  try {
    worktreePolicy = parseWorktreeFlag({
      worktree,
      ...(name !== undefined ? { name } : {}),
      ...(parentWorktree !== undefined ? { parentWorktree } : {}),
      ...(baseBranch !== undefined ? { baseBranch } : {}),
      ...(setup !== undefined ? { setup } : {}),
    });
  } catch (error) {
    deps.stderr(`error: ${errorMessage(error)}\n`);
    deps.stderr(SPAWN_USAGE);
    return { exitCode: 2 };
  }
  try {
    const task =
      taskId !== undefined
        ? { taskId: taskId.trim() }
        : {
            spec: (taskSpec as string).trim(),
            ...(taskTitle !== undefined ? { taskTitle: taskTitle.trim() } : {}),
            ...(parent !== undefined ? { parentTaskId: parent.trim() } : {}),
            ...(parsedDeps !== undefined ? { deps: parsedDeps } : {}),
          };
    if ("spec" in task && (task as { spec: string }).spec.length === 0) {
      deps.stderr(`error: --task must be non-empty\n`);
      deps.stderr(SPAWN_USAGE);
      return { exitCode: 2 };
    }
    if ("taskId" in task && (task as { taskId: string }).taskId.length === 0) {
      deps.stderr(`error: --task-id must be non-empty\n`);
      deps.stderr(SPAWN_USAGE);
      return { exitCode: 2 };
    }
    const receipt = await spawnCompactWorker({
      orca: getOrca(deps),
      profileName: profile,
      ...(identityOverride !== undefined ? { githubIdentityOverride: identityOverride } : {}),
      task,
      worktree: worktreePolicy,
      projectRoot: deps.projectRoot,
      ...(runId !== undefined ? { runId } : {}),
      ...(fromHandle !== undefined ? { fromHandle } : {}),
      ...(title !== undefined ? { terminalTitle: title } : {}),
      ...(deps.env !== undefined ? { env: deps.env } : {}),
      ...(deps.homedir !== undefined ? { homedir: deps.homedir } : {}),
      ...(deps.osHomedir !== undefined ? { osHomedir: deps.osHomedir } : {}),
      ...(deps.fs !== undefined ? { fs: deps.fs } : {}),
      ...(deps.mappingFs !== undefined ? { mappingFs: deps.mappingFs } : {}),
      ...(deps.userConfigPathOverride !== undefined ? { userConfigPath: deps.userConfigPathOverride } : {}),
      ...(deps.projectConfigPathOverride !== undefined ? { projectConfigPath: deps.projectConfigPathOverride } : {}),
    });
    if (asJson) {
      deps.stdout(`${JSON.stringify(receipt, null, 2)}\n`);
    } else {
      deps.stdout(`${formatSpawnHuman(receipt)}\n`);
    }
    return { exitCode: 0 };
  } catch (error) {
    if (error instanceof CompactOrchestrationError && error.code === "unknown-profile") {
      deps.stderr(`error: ${error.message}\n`);
      return { exitCode: 1 };
    }
    deps.stderr(`error: ${errorMessage(error)}\n`);
    return { exitCode: 1 };
  }
}

async function runStatus(args: readonly string[], deps: OrchestrationCommandDeps): Promise<OrchestrationCommandResult> {
  let worker: string | undefined;
  let taskId: string | undefined;
  let runId: string | undefined;
  let fromHandle: string | undefined;
  let asJson = false;
  const unknown: string[] = [];
  const takeValue = (flag: string, index: number): { value?: string; consumed: number } => {
    const value = args[index + 1];
    if (value === undefined || value.startsWith("-")) {
      unknown.push(`${flag} requires a value`);
      return { consumed: 1 };
    }
    return { value, consumed: 2 };
  };
  for (let i = 0; i < args.length; ) {
    const arg = args[i] as string;
    if (arg === "--json") { asJson = true; i += 1; }
    else if (arg === "--worker") { const t = takeValue(arg, i); if (t.value !== undefined) worker = t.value; i += t.consumed; }
    else if (arg === "--task") { const t = takeValue(arg, i); if (t.value !== undefined) taskId = t.value; i += t.consumed; }
    else if (arg === "--run") { const t = takeValue(arg, i); if (t.value !== undefined) runId = t.value; i += t.consumed; }
    else if (arg === "--from") { const t = takeValue(arg, i); if (t.value !== undefined) fromHandle = t.value; i += t.consumed; }
    else if (isHelpFlag(arg)) { deps.stdout(`${ORCHESTRATION_USAGE}`); return { exitCode: 0 }; }
    else if (arg.startsWith("--")) { unknown.push(arg); i += 1; }
    else { unknown.push(arg); i += 1; }
  }
  if (unknown.length > 0) {
    deps.stderr(`error: unknown status option(s): ${unknown.join(", ")}\n`);
    deps.stderr(STATUS_USAGE);
    return { exitCode: 2 };
  }
  if (worker !== undefined && taskId !== undefined) {
    deps.stderr(`error: --worker and --task are mutually exclusive; pass exactly one\n`);
    deps.stderr(STATUS_USAGE);
    return { exitCode: 2 };
  }
  try {
    const receipt = await getCompactStatus({
      orca: getOrca(deps),
      ...(worker !== undefined ? { worker } : {}),
      ...(taskId !== undefined ? { taskId } : {}),
      ...(runId !== undefined ? { runId } : {}),
      ...(fromHandle !== undefined ? { fromHandle } : {}),
      projectRoot: deps.projectRoot,
      ...(deps.mappingFs !== undefined ? { mappingFs: deps.mappingFs } : {}),
    });
    if (asJson) {
      deps.stdout(`${JSON.stringify(receipt, null, 2)}\n`);
    } else {
      deps.stdout(`${formatStatusHuman(receipt)}\n`);
    }
    return { exitCode: 0 };
  } catch (error) {
    deps.stderr(`error: ${errorMessage(error)}\n`);
    return { exitCode: 1 };
  }
}

async function runSend(args: readonly string[], deps: OrchestrationCommandDeps): Promise<OrchestrationCommandResult> {
  let worker: string | undefined;
  let message: string | undefined;
  let subject: string | undefined;
  let type: string | undefined;
  let runId: string | undefined;
  let fromHandle: string | undefined;
  let asJson = false;
  const unknown: string[] = [];
  const takeValue = (flag: string, index: number): { value?: string; consumed: number } => {
    const value = args[index + 1];
    if (value === undefined || (value.startsWith("-") && flag !== "--message" && flag !== "--subject")) {
      unknown.push(`${flag} requires a value`);
      return { consumed: 1 };
    }
    return { value, consumed: 2 };
  };
  for (let i = 0; i < args.length; ) {
    const arg = args[i] as string;
    if (arg === "--json") { asJson = true; i += 1; }
    else if (arg === "--worker") { const t = takeValue(arg, i); if (t.value !== undefined) worker = t.value; i += t.consumed; }
    else if (arg === "--message" || arg === "--body") { const t = takeValue(arg, i); if (t.value !== undefined) message = t.value; i += t.consumed; }
    else if (arg === "--subject") { const t = takeValue(arg, i); if (t.value !== undefined) subject = t.value; i += t.consumed; }
    else if (arg === "--type") { const t = takeValue(arg, i); if (t.value !== undefined) type = t.value; i += t.consumed; }
    else if (arg === "--run") { const t = takeValue(arg, i); if (t.value !== undefined) runId = t.value; i += t.consumed; }
    else if (arg === "--from") { const t = takeValue(arg, i); if (t.value !== undefined) fromHandle = t.value; i += t.consumed; }
    else if (isHelpFlag(arg)) { deps.stdout(`${ORCHESTRATION_USAGE}`); return { exitCode: 0 }; }
    else if (arg.startsWith("--")) { unknown.push(arg); i += 1; }
    else { unknown.push(arg); i += 1; }
  }
  if (unknown.length > 0) {
    deps.stderr(`error: unknown send option(s): ${unknown.join(", ")}\n`);
    deps.stderr(SEND_USAGE);
    return { exitCode: 2 };
  }
  if (!worker) {
    deps.stderr(`error: send requires --worker <dispatch|terminal-handle>\n`);
    deps.stderr(SEND_USAGE);
    return { exitCode: 2 };
  }
  if (message === undefined) {
    deps.stderr(`error: send requires --message <text>\n`);
    deps.stderr(SEND_USAGE);
    return { exitCode: 2 };
  }
  if (type !== undefined) {
    const lowered = type.trim().toLowerCase();
    if (lowered === "worker_done" || lowered === "heartbeat") {
      deps.stderr(`error: --type "${type}" is a Dispatch-scoped worker signal and cannot be sent by the coordinator; omit --type for a normal follow-up\n`);
      deps.stderr(SEND_USAGE);
      return { exitCode: 2 };
    }
  }
  try {
    const receipt = await sendCompactMessage({
      orca: getOrca(deps),
      worker,
      message,
      ...(subject !== undefined ? { subject } : {}),
      ...(type !== undefined ? { type } : {}),
      ...(runId !== undefined ? { runId } : {}),
      ...(fromHandle !== undefined ? { fromHandle } : {}),
      projectRoot: deps.projectRoot,
      ...(deps.mappingFs !== undefined ? { mappingFs: deps.mappingFs } : {}),
    });
    if (asJson) {
      deps.stdout(`${JSON.stringify(receipt, null, 2)}\n`);
    } else {
      deps.stdout(`delivered to dispatch ${receipt.dispatchId} (subject: ${receipt.subject})\n`);
    }
    return { exitCode: 0 };
  } catch (error) {
    deps.stderr(`error: ${errorMessage(error)}\n`);
    return { exitCode: 1 };
  }
}

async function runWait(args: readonly string[], deps: OrchestrationCommandDeps): Promise<OrchestrationCommandResult> {
  let worker: string | undefined;
  let taskId: string | undefined;
  let timeoutRaw: string | undefined;
  let runId: string | undefined;
  let fromHandle: string | undefined;
  let asJson = false;
  const unknown: string[] = [];
  const takeValue = (flag: string, index: number): { value?: string; consumed: number } => {
    const value = args[index + 1];
    if (value === undefined || value.startsWith("-")) {
      unknown.push(`${flag} requires a value`);
      return { consumed: 1 };
    }
    return { value, consumed: 2 };
  };
  for (let i = 0; i < args.length; ) {
    const arg = args[i] as string;
    if (arg === "--json") { asJson = true; i += 1; }
    else if (arg === "--worker") { const t = takeValue(arg, i); if (t.value !== undefined) worker = t.value; i += t.consumed; }
    else if (arg === "--task") { const t = takeValue(arg, i); if (t.value !== undefined) taskId = t.value; i += t.consumed; }
    else if (arg === "--timeout") { const t = takeValue(arg, i); if (t.value !== undefined) timeoutRaw = t.value; i += t.consumed; }
    else if (arg === "--run") { const t = takeValue(arg, i); if (t.value !== undefined) runId = t.value; i += t.consumed; }
    else if (arg === "--from") { const t = takeValue(arg, i); if (t.value !== undefined) fromHandle = t.value; i += t.consumed; }
    else if (isHelpFlag(arg)) { deps.stdout(`${ORCHESTRATION_USAGE}`); return { exitCode: 0 }; }
    else if (arg.startsWith("--")) { unknown.push(arg); i += 1; }
    else { unknown.push(arg); i += 1; }
  }
  if (unknown.length > 0) {
    deps.stderr(`error: unknown wait option(s): ${unknown.join(", ")}\n`);
    deps.stderr(WAIT_USAGE);
    return { exitCode: 2 };
  }
  if ((worker === undefined) === (taskId === undefined)) {
    deps.stderr(`error: wait requires exactly one of --worker <handle> or --task <id>\n`);
    deps.stderr(WAIT_USAGE);
    return { exitCode: 2 };
  }
  let timeoutMs: number | undefined;
  if (timeoutRaw !== undefined) {
    try {
      timeoutMs = parseTimeoutToMs(timeoutRaw);
    } catch (error) {
      deps.stderr(`error: ${errorMessage(error)}\n`);
      deps.stderr(WAIT_USAGE);
      return { exitCode: 2 };
    }
  }
  try {
    const receipt = await waitCompact({
      orca: getOrca(deps),
      ...(worker !== undefined ? { worker } : {}),
      ...(taskId !== undefined ? { taskId } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(runId !== undefined ? { runId } : {}),
      ...(fromHandle !== undefined ? { fromHandle } : {}),
      projectRoot: deps.projectRoot,
      ...(deps.mappingFs !== undefined ? { mappingFs: deps.mappingFs } : {}),
    });
    if (asJson) {
      deps.stdout(`${JSON.stringify(receipt, null, 2)}\n`);
    } else {
      deps.stdout(`${receipt.outcome}: ${receipt.summary}\n`);
    }
    return { exitCode: receipt.outcome === "completed" ? 0 : 1 };
  } catch (error) {
    deps.stderr(`error: ${errorMessage(error)}\n`);
    return { exitCode: 1 };
  }
}

async function runStop(args: readonly string[], deps: OrchestrationCommandDeps): Promise<OrchestrationCommandResult> {
  let worker: string | undefined;
  let fromHandle: string | undefined;
  let asJson = false;
  const unknown: string[] = [];
  const takeValue = (flag: string, index: number): { value?: string; consumed: number } => {
    const value = args[index + 1];
    if (value === undefined || value.startsWith("-")) {
      unknown.push(`${flag} requires a value`);
      return { consumed: 1 };
    }
    return { value, consumed: 2 };
  };
  for (let i = 0; i < args.length; ) {
    const arg = args[i] as string;
    if (arg === "--json") { asJson = true; i += 1; }
    else if (arg === "--worker") { const t = takeValue(arg, i); if (t.value !== undefined) worker = t.value; i += t.consumed; }
    else if (arg === "--from") { const t = takeValue(arg, i); if (t.value !== undefined) fromHandle = t.value; i += t.consumed; }
    else if (isHelpFlag(arg)) { deps.stdout(`${ORCHESTRATION_USAGE}`); return { exitCode: 0 }; }
    else if (arg.startsWith("--")) { unknown.push(arg); i += 1; }
    else { unknown.push(arg); i += 1; }
  }
  if (unknown.length > 0) {
    deps.stderr(`error: unknown stop option(s): ${unknown.join(", ")}\n`);
    deps.stderr(STOP_USAGE);
    return { exitCode: 2 };
  }
  if (!worker) {
    deps.stderr(`error: stop requires --worker <dispatch|terminal-handle>\n`);
    deps.stderr(STOP_USAGE);
    return { exitCode: 2 };
  }
  try {
    const receipt = await stopCompact({
      orca: getOrca(deps),
      worker,
      projectRoot: deps.projectRoot,
      ...(deps.mappingFs !== undefined ? { mappingFs: deps.mappingFs } : {}),
      ...(fromHandle !== undefined ? { fromHandle } : {}),
    });
    if (asJson) {
      deps.stdout(`${JSON.stringify(receipt, null, 2)}\n`);
    } else {
      deps.stdout(`${receipt.summary}\n`);
    }
    return { exitCode: 0 };
  } catch (error) {
    deps.stderr(`error: ${errorMessage(error)}\n`);
    return { exitCode: 1 };
  }
}

/**
 * Route compact orchestration commands. `argv` is everything after the
 * command word (`spawn`/`status`/`send`/`wait`/`stop`).
 */
export async function runOrchestrationCommand(
  command: string,
  argv: readonly string[],
  deps: OrchestrationCommandDeps,
): Promise<OrchestrationCommandResult> {
  if (command === "spawn") return await runSpawn(argv, deps);
  if (command === "status") return await runStatus(argv, deps);
  if (command === "send") return await runSend(argv, deps);
  if (command === "wait") return await runWait(argv, deps);
  if (command === "stop") return await runStop(argv, deps);
  deps.stderr(`error: unknown orchestration command: ${command}\n`);
  deps.stderr(`${ORCHESTRATION_USAGE}`);
  return { exitCode: 2 };
}

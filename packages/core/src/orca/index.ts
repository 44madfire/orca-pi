/**
 * Orca supervised-worker barrel (OP1.4 / JEF-8).
 *
 * Adapter that turns a resolved Pi process specification into a real
 * Orca-supervised worker using only public `orca ... --json` contracts.
 */
export {
  DEFAULT_READINESS_TIMEOUT_MS,
  formatPiCommandForTerminal,
  quoteForTerminalShell,
  summarizePiSpecForDiagnostics,
  terminalSelectorForPolicy,
  worktreeSelectorForNewWorktree,
  type ListTasksInput,
  type OrcaCli,
  type SendToDispatchInput,
  type TaskCreateInput,
  type TerminalCreateInput,
  type WorkerAttachInput,
  type WorktreeCreateInput,
} from "./orca-cli.js";
export {
  createOrcaCliProcess,
  OrcaCommandError,
  type OrcaCliProcessOptions,
} from "./orca-cli-process.js";
export {
  isOutcomeUnknownState,
  ORCA_JSON_SNIPPET_LIMIT,
  OrcaJsonParseError,
  parseRunCurrentJson,
  parseTaskCreateJson,
  parseTerminalCreateJson,
  parseTerminalShowJson,
  parseWorkerStartAttemptJson,
  parseWorkerStartJson,
  parseWorktreeCreateJson,
  parseWorktreeShowJson,
} from "./json-parsers.js";
export {
  freezeSupervisedWorkerReceipt,
  SupervisedWorkerError,
  WorkerStartAmbiguousError,
  type SupervisedWorkerReceipt,
  type SupervisedWorkerStage,
  type TaskReceipt,
  type TerminalReceipt,
  type WorkerAttachReceipt,
  type WorkerStartAttempt,
  type WorktreeIdentity,
  type WorktreePolicy,
  type WorktreeReceipt,
  type WorktreeSetupPolicy,
} from "./receipts.js";
export {
  spawnSupervisedPiWorker,
  type SpawnLaunchOptions,
  type SpawnSupervisedPiWorkerOptions,
  type SpawnTaskSelection,
} from "./spawn-supervised-pi-worker.js";

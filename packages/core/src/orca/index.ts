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
  type DispatchInput,
  type OrcaCli,
  type TaskCreateInput,
  type TerminalCreateInput,
  type WorktreeCreateInput,
} from "./orca-cli.js";
export {
  createOrcaCliProcess,
  OrcaCommandError,
  type OrcaCliProcessOptions,
} from "./orca-cli-process.js";
export {
  ORCA_JSON_SNIPPET_LIMIT,
  OrcaJsonParseError,
  parseDispatchJson,
  parseRunCurrentJson,
  parseTaskCreateJson,
  parseTerminalCreateJson,
  parseWorktreeCreateJson,
  parseWorktreeShowJson,
} from "./json-parsers.js";
export {
  freezeSupervisedWorkerReceipt,
  SupervisedWorkerError,
  type DispatchReceipt,
  type SupervisedWorkerReceipt,
  type SupervisedWorkerStage,
  type TaskReceipt,
  type TerminalReceipt,
  type WorktreeIdentity,
  type WorktreePolicy,
  type WorktreeReceipt,
  type WorktreeSetupPolicy,
} from "./receipts.js";
export {
  spawnSupervisedPiWorker,
  type SpawnSupervisedPiWorkerOptions,
  type SpawnTaskSelection,
} from "./spawn-supervised-pi-worker.js";

/**
 * Compact Pi-facing orchestration barrel (OP1.5 / JEF-9).
 *
 * Thin wrappers over profile/launcher/Orca adapters: the coordinator picks a
 * role profile, Orca owns Tasks/Dispatches/worktrees and completion, and this
 * layer only carries Orca's identities with stable JSON receipts.
 */
export {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  MAX_POLL_INTERVAL_MS,
  MAX_TIMEOUT_MS,
  TimeoutParseError,
  formatTimeoutMs,
  parseTimeoutToMs,
} from "./timeout.js";
export {
  WorktreeFlagError,
  parseWorktreeFlag,
  type WorktreeFlagOptions,
} from "./worktree-flag.js";
export {
  getWorkerMappingPath,
  loadWorkerMappings,
  recordWorkerMapping,
  resolveMapping,
  WORKER_MAPPING_DIRNAME,
  WORKER_MAPPING_FILENAME,
  type MappingFs,
  type WorkerMappingEntry,
  type WorkerMappingTable,
} from "./mapping-store.js";
export {
  getCompactStatus,
  resolveWorkerToDispatch,
  sendCompactMessage,
  spawnCompactWorker,
  stopCompact,
  waitCompact,
  type SendOperationOptions,
  type StatusOperationOptions,
  type StopOperationOptions,
  type WaitOperationOptions,
  type OperationProfileOptions,
  type SpawnOperationOptions,
} from "./operations.js";
export {
  isSettledTaskStatus,
  isSettledWorkerState,
  isSuccessfulTaskStatus,
  parseDispatchShowJson,
  parseSendJson,
  parseTaskListJson,
  parseWorkerListJson,
  parseWorkerShowJson,
  parseWorkerStopJson,
  type ParsedDispatchShow,
  type ParsedTaskListEntry,
  type ParsedWorkerListEntry,
  type ParsedWorkerShow,
} from "./orchestration-parsers.js";
export type {
  ListTasksInput,
  SendToDispatchInput,
} from "../orca/orca-cli.js";
export {
  CompactOrchestrationError,
  freezeCompact,
  type CompactSendReceipt,
  type CompactSpawnOptions,
  type CompactSpawnReceipt,
  type CompactStatusReceipt,
  type CompactStopReceipt,
  type CompactTaskSelection,
  type CompactWaitOutcome,
  type CompactWaitReceipt,
  type CompactWorkerStatus,
  type WaitTarget,
  type WorkerSelector,
  type WorktreePolicy,
} from "./types.js";

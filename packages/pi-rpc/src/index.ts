/**
 * `@orca-pi/pi-rpc` barrel (SNC1.1 contract proofs + SNC1.2 production transport).
 *
 * Real-Pi RPC contract proofs: strict LF-only JSONL framing, a minimal
 * spike client, fixture normalization/validation, and baseline metadata —
 * plus the production `PiRpcConnection` process transport, typed protocol,
 * secret-safe errors, and transport-neutral launch helpers.
 *
 * Pi-only: this package never imports Orca journal/session types. The
 * SNC1.3 bridge owns Pi → Orca translation.
 */
export {
  attachJsonlReader,
  JsonlFramer,
  parseJsonLine,
  serializeJsonLine,
  splitJsonLines,
} from "./jsonl.js";
export {
  defaultPiCommand,
  SpikeClient,
  type SpikeClientOptions,
  type SpikeRecord,
  type WaitResponseOptions,
} from "./spike-client.js";
export {
  assertLfOnlyJsonl,
  assertSecretFreeLine,
  createRecordNormalizer,
  normalizeRecord,
  PLACEHOLDERS,
} from "./normalize.js";
export {
  collectBaseline,
  isPiBaseline,
  type BaselineModelSummary,
  type PiBaseline,
} from "./baseline.js";
export {
  PiRpcConnection,
  type PiRpcCloseResult,
  type PiRpcConnectionOptions,
  type PiRpcEventHandler,
  type PiRpcRequestOptions,
  type PiRpcSpawnFn,
} from "./connection.js";
export {
  PiRpcError,
  STDERR_TAIL_MAX_CHARS,
  boundTail,
  redactLinePreview,
  redactSecrets,
  redactStderrTail,
  rejectedError,
  type PiRpcErrorCode,
  type PiRpcErrorDetails,
} from "./errors.js";
export {
  buildPiRpcLaunch,
  resolvePiRpcEnv,
  TUI_ONLY_FLAGS,
  type PiRpcLaunchOptions,
  type PiRpcLaunchProfile,
  type PiRpcProcessSpec,
} from "./launch.js";
export {
  isExtensionUiDialog,
  isExtensionUiFireAndForget,
  isExtensionUiRequest,
  isPiResponse,
  isPiResponseFailure,
  isPiResponseSuccess,
  type PiAgentEndEvent,
  type PiBashExecutionUpdateEvent,
  type PiBashResult,
  type PiClearQueueData,
  type PiCommand,
  type PiCommandBase,
  type PiCommandInfo,
  type PiCompactionEndEvent,
  type PiCompactionStartEvent,
  type PiEntriesData,
  type PiEventBase,
  type PiExtensionUiMethod,
  type PiExtensionUiRequest,
  type PiExtensionUiResponse,
  type PiForkMessage,
  type PiForkResult,
  type PiImageAttachment,
  type PiMessage,
  type PiMessageEndEvent,
  type PiMessageStartEvent,
  type PiMessageUpdateEvent,
  type PiMessagesData,
  type PiModel,
  type PiPromptCommand,
  type PiQueueMode,
  type PiResponse,
  type PiResponseFailure,
  type PiResponseSuccess,
  type PiServerEvent,
  type PiServerMessage,
  type PiSessionStats,
  type PiSessionSwitchResult,
  type PiState,
  type PiStreamingBehavior,
  type PiToolExecutionEndEvent,
  type PiToolExecutionStartEvent,
  type PiToolExecutionUpdateEvent,
  type PiBashCommand,
  type PiEntry,
  type PiLastAssistantTextData,
  type PiQueueCommand,
  type PiQueueUpdateEvent,
  type PiSessionInfoChangedEvent,
  type PiThinkingLevelChangedEvent,
  type PiTreeData,
  type PiTreeNode,
  type PiTurnEndEvent,
} from "./protocol.js";

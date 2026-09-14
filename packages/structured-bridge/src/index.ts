/**
 * `@orca-pi/structured-bridge` barrel (SNC1.3 + SNC1.4 + SNC1.5 + SNC1.6 + SNC1.7 + SNC1.8).
 *
 * Hot-swappable external structured-session bridge: versioned local IPC
 * (Orca-side host + external provider + mock) plus Pi-specific translation
 * (`pi-mapping.ts`), the SNC1.4 Pi-backed provider + SNC1.5 translator +
 * SNC1.6 model/thinking/prompt/image controls (`pi-provider.ts`)
 * kept strictly separate from the provider-neutral core (the Orca fork
 * vendors only `framing.ts` + `protocol.ts` + `host.ts`).
 */
export {
  attachBridgeReader,
  BridgeFramer,
  parseBridgeLine,
  serializeBridgeLine,
  splitBridgeLines,
} from "./framing.js";
export {
  assertNoCredentialFields,
  BRIDGE_DEV_COMMAND_ENV,
  BRIDGE_PROTOCOL_VERSION,
  BridgeProtocolError,
  BridgeTimeoutError,
  BridgeUnavailableError,
  createOpId,
  DEFAULT_CLOSE_GRACE_MS,
  DEFAULT_HELLO_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  findCredentialField,
  FORBIDDEN_BRIDGE_KEYS,
  isBridgeMessage,
  MAX_STDERR_BYTES,
  redactSecretsFromText,
  validateBridgeMessage,
  __resetOpCounterForTests,
  type AcquireRequest,
  type BridgeCapabilities,
  type BridgeDispatchMessage,
  type BridgeErrorEvent,
  type BridgeHistoryEntry,
  type BridgeHostIdentity,
  type BridgeImage,
  type BridgeProviderEvent,
  type BridgeProviderIdentity,
  type BridgeSessionMetadata,
  type BridgeSessionOptions,
  type CancelledResponse,
  type DispatchAck,
  type DispatchStatus,
  type HistoryResponse,
  type HostToProviderKind,
  type HostToProviderMessage,
  type ProviderToHostKind,
  type ProviderToHostMessage,
  type SessionEvent,
} from "./protocol.js";
export {
  BridgeHost,
  type AcquireResult,
  type BridgeHostOptions,
  type BridgeSupport,
  type DispatchOutcome,
  type LifecycleEnvelope,
  type SessionEventEnvelope,
  type SpawnFn,
} from "./host.js";
export {
  BridgeProvider,
  MockExternalProvider,
  type BridgeProviderOptions,
  type MockProviderOptions,
  type ProviderSession,
} from "./provider.js";
export {
  PiBridgeProvider,
  type PiBridgeProviderOptions,
  type PiConnectionFactory,
  type PiProviderConnection,
  type PiSpecResolver,
} from "./pi-provider.js";
export {
  mapBridgeDispatchToPiPrompt,
  mapPiRecordToBridgeEvents,
  PI_KNOWN_THINKING_LEVELS,
  piBridgeCapabilities,
  validatePiDispatch,
  type PiDispatchValidation,
  type PiPromptCommand,
} from "./pi-mapping.js";
export {
  PiTranslator,
  type BridgeTranslatorEvent,
  type TranslatorJournalEntry,
  type TranslatorToolState,
} from "./pi-translator.js";
export {
  extractActiveBranch,
  extractActiveBranchFromTree,
  extractPiTextContent,
  translatePiBranchToBridgeHistory,
  translatePiEntryToBridgeEntries,
  type ActiveBranchResult,
  type HistoryReconstructionError,
  type PiHistoryEntryLike,
  type PiHistoryTreeNodeLike,
} from "./pi-history.js";
export {
  PiNativeProvider,
  PI_NATIVE_AGENT,
  PI_NATIVE_LOCAL_HOST_ID,
  type PiNativeAcquireInput,
  type PiNativeAcquireResult,
  type PiNativeDispatchInput,
  type PiNativeDispatchResult,
  type PiNativeLocation,
  type PiNativeOptions,
  type PiNativeSessionEventEnvelope,
} from "./pi-native.js";
export {
  runPiConformanceSuite,
  type PiConformanceDriver,
  type PiConformanceResult,
  type PiConformanceScenario,
} from "./pi-conformance.js";
export {
  checkAcquireCompat,
  checkPiLocationSupport,
  checkPiVersionSupport,
  comparePiVersions,
  formatPiVersion,
  gatePiStructuredSession,
  MIN_KNOWN_GOOD_PI_VERSION,
  negotiatePiCapabilities,
  parsePiVersion,
  PI_COMPAT_AGENT,
  PI_COMPAT_LOCAL_HOST_ID,
  PI_RPC_PROTOCOL_VERSION,
  PI_TUI_FALLBACK,
  type ParsedPiVersion,
  type PiAcquireCompat,
  type PiAcquireCompatVerdict,
  type PiCapabilityNegotiation,
  type PiCompatLocation,
  type PiLocationSupport,
  type PiProbedCapabilities,
  type PiStructuredGate,
  type PiStructuredGateInput,
  type PiVersionSupport,
} from "./pi-compat.js";

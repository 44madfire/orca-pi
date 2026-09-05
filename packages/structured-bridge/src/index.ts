/**
 * `@orca-pi/structured-bridge` barrel (SNC1.3).
 *
 * Hot-swappable external structured-session bridge: versioned local IPC
 * (Orca-side host + external provider + mock) plus Pi-specific translation
 * kept strictly separate from the provider-neutral core.
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
export { BridgeProvider, MockExternalProvider, type BridgeProviderOptions, type MockProviderOptions } from "./provider.js";
export {
  mapBridgeDispatchToPiPrompt,
  mapPiRecordToBridgeEvents,
  PI_KNOWN_THINKING_LEVELS,
  piBridgeCapabilities,
  validatePiDispatch,
  type PiDispatchValidation,
  type PiPromptCommand,
} from "./pi-mapping.js";

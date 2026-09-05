/**
 * Versioned local IPC protocol for the SNC1.3 external structured-session bridge.
 *
 * Provider-neutral core: this file knows about neither Pi RPC semantics nor
 * Orca journal/lease/outbox types. Pi assumptions live in `pi-mapping.ts`
 * (orca-pi owned); Orca session ownership stays in the Orca fork. The Orca
 * fork vendors `framing.ts` + this file + `host.ts` as a small temporary
 * dev branch — no public plugin-manifest widening.
 *
 * Transport: strict LF-only JSONL over the provider child's stdio
 * (see `framing.ts`). Every record carries `v: 1`.
 *
 * Directions:
 * - h2p (host → provider): hello, acquire, release, dispatch, cancel,
 *   answer_prompt, set_options, get_history, get_session, close.
 * - p2h (provider → host): hello_ok, hello_error, acquired, released,
 *   dispatch_ack, cancelled, options_updated, history, session,
 *   session_event, closed, exiting, error.
 *
 * Operation IDs: every h2p request carries a host-generated `opId`
 * (see `createOpId()`). Provider responses echo it. Streaming
 * `session_event` records for a turn carry the originating `opId` so the
 * host can correlate text/thinking/tool deltas without guessing.
 *
 * Dispatch honesty: `dispatch_ack.status` is `accepted` only when the
 * provider definitely owns the prompt, `rejected` only for definite
 * refusal, and `unknown` is never sent by the provider — the host
 * synthesizes `unknown` on timeout/exit/malformed ack and never
 * auto-resends (caller must reconcile via history before retrying).
 *
 * Secret hygiene: no `env`, credentials, tokens, or absolute user paths
 * cross the bridge. `FORBIDDEN_BRIDGE_KEYS` + `assertNoCredentialFields()`
 * enforce this on both sides; `redactSecretsFromText()` bounds stderr
 * diagnostics.
 */

export const BRIDGE_PROTOCOL_VERSION = 1;

/** Explicit dev-only configuration key (never the public plugin manifest). */
export const BRIDGE_DEV_COMMAND_ENV = "ORCA_PI_BRIDGE_COMMAND";

/** Default timeouts (ms). Host options may override. */
export const DEFAULT_HELLO_TIMEOUT_MS = 5_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_CLOSE_GRACE_MS = 2_000;
export const MAX_STDERR_BYTES = 8_192;

/** Keys that must never appear in any bridge record (either direction). */
export const FORBIDDEN_BRIDGE_KEYS = Object.freeze([
  "env",
  "processEnv",
  "process_env",
  "auth",
  "credentials",
  "apiKey",
  "api_key",
  "apikey",
  "token",
  "refreshToken",
  "refresh_token",
  "bearer",
  "secret",
  "secrets",
  "password",
] as const);

export type ForbiddenBridgeKey = (typeof FORBIDDEN_BRIDGE_KEYS)[number];

/** Host → provider request kinds. */
export type HostToProviderKind =
  | "hello"
  | "acquire"
  | "release"
  | "dispatch"
  | "cancel"
  | "answer_prompt"
  | "set_options"
  | "get_history"
  | "get_session"
  | "close";

/** Provider → host response/event kinds. */
export type ProviderToHostKind =
  | "hello_ok"
  | "hello_error"
  | "acquired"
  | "released"
  | "dispatch_ack"
  | "cancelled"
  | "options_updated"
  | "history"
  | "session"
  | "session_event"
  | "closed"
  | "exiting"
  | "error";

export interface BridgeHostIdentity {
  /** Always `"orca"` for the dev bridge; kept generic for upstreaming. */
  id: string;
  version: string;
  protocol: number;
}

export interface BridgeProviderIdentity {
  /** e.g. `"mock"`, `"pi"`. Provider-neutral: any id is accepted. */
  id: string;
  version: string;
  protocol: number;
}

export interface BridgeCapabilities {
  textStreaming: boolean;
  thinking: boolean;
  tools: boolean;
  images: boolean;
  extensionDialogs: boolean;
  history: boolean;
  options: boolean;
  cancel: boolean;
  resume: boolean;
}

export interface BridgeSessionOptions {
  model?: string;
  thinkingLevel?: string;
  /** Queue policy for dispatches that arrive while a turn is active. */
  queueMode?: "reject" | "steer" | "followUp";
  autoCompaction?: boolean;
}

export interface BridgeSessionMetadata {
  sessionId: string;
  /** Opaque provider-side session id (e.g. Pi `sessionId`); may equal sessionId for mock. */
  providerSessionId?: string;
  workspaceRoot: string;
  model?: string;
  thinkingLevel?: string;
  messageCount: number;
  isStreaming: boolean;
  createdAt: string;
}

export interface BridgeHistoryEntry {
  id: string;
  parentId?: string;
  role: "user" | "assistant" | "tool" | "system";
  text?: string;
  timestamp: string;
}

export interface BridgeImage {
  /** Base64 payload (opaque; preserved verbatim). */
  data: string;
  mimeType: string;
}

export interface BridgeDispatchMessage {
  text: string;
  images?: BridgeImage[];
}

/** Streaming / lifecycle events delivered as `session_event` payloads. */
export type BridgeProviderEvent =
  | { type: "turn_start" }
  | { type: "text_start"; contentIndex?: number }
  | { type: "text_delta"; delta: string; contentIndex?: number }
  | { type: "text_end"; contentIndex?: number; text?: string }
  | { type: "thinking_start"; contentIndex?: number }
  | { type: "thinking_delta"; delta: string; contentIndex?: number }
  | { type: "thinking_end"; contentIndex?: number; thinking?: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; args?: unknown }
  | { type: "tool_progress"; toolCallId: string; partialResult: string }
  | { type: "tool_end"; toolCallId: string; result: string; isError: boolean }
  | { type: "turn_end"; stopReason: "stop" | "aborted" | "error"; errorMessage?: string }
  | { type: "settled"; willRetry?: boolean }
  | {
      type: "prompt_request";
      requestId: string;
      prompt:
        | { kind: "select"; title: string; options: string[] }
        | { kind: "confirm"; title: string; message: string }
        | { kind: "input"; title: string; placeholder?: string }
        | { kind: "editor"; title: string; prefill?: string };
      timeoutMs?: number;
    }
  | { type: "error"; code: string; message: string };

// ---------------------------------------------------------------------------
// Wire records (every record carries `v`).
// ---------------------------------------------------------------------------

export interface BridgeWireBase {
  v: number;
  kind: string;
  opId?: string;
}

export interface HelloRequest extends BridgeWireBase {
  kind: "hello";
  opId: string;
  host: BridgeHostIdentity;
  workspaceRoot: string;
}

export interface AcquireRequest extends BridgeWireBase {
  kind: "acquire";
  opId: string;
  workspaceRoot: string;
  resumePath?: string;
  sessionId?: string;
  options?: BridgeSessionOptions;
}

export interface ReleaseRequest extends BridgeWireBase {
  kind: "release";
  opId: string;
  sessionId: string;
}

export interface DispatchRequest extends BridgeWireBase {
  kind: "dispatch";
  opId: string;
  sessionId: string;
  message: BridgeDispatchMessage;
  queue?: "reject" | "steer" | "followUp";
}

export interface CancelRequest extends BridgeWireBase {
  kind: "cancel";
  opId: string;
  sessionId: string;
  targetOpId?: string;
}

export interface AnswerPromptRequest extends BridgeWireBase {
  kind: "answer_prompt";
  opId: string;
  requestId: string;
  cancelled: boolean;
  value?: unknown;
}

export interface SetOptionsRequest extends BridgeWireBase {
  kind: "set_options";
  opId: string;
  sessionId: string;
  options: BridgeSessionOptions;
}

export interface GetHistoryRequest extends BridgeWireBase {
  kind: "get_history";
  opId: string;
  sessionId: string;
  cursor?: string;
  limit?: number;
}

export interface GetSessionRequest extends BridgeWireBase {
  kind: "get_session";
  opId: string;
  sessionId: string;
}

export interface CloseRequest extends BridgeWireBase {
  kind: "close";
  opId: string;
  mode: "graceful" | "force";
  sessionId?: string;
}

export type HostToProviderMessage =
  | HelloRequest
  | AcquireRequest
  | ReleaseRequest
  | DispatchRequest
  | CancelRequest
  | AnswerPromptRequest
  | SetOptionsRequest
  | GetHistoryRequest
  | GetSessionRequest
  | CloseRequest;

export interface HelloOk extends BridgeWireBase {
  kind: "hello_ok";
  opId: string;
  provider: BridgeProviderIdentity;
  capabilities: BridgeCapabilities;
}

export interface HelloError extends BridgeWireBase {
  kind: "hello_error";
  opId: string;
  error: { code: string; message: string };
}

export interface AcquiredResponse extends BridgeWireBase {
  kind: "acquired";
  opId: string;
  sessionId: string;
  resumed: boolean;
  metadata: BridgeSessionMetadata;
}

export interface ReleasedResponse extends BridgeWireBase {
  kind: "released";
  opId: string;
  sessionId: string;
}

export type DispatchStatus = "accepted" | "rejected" | "unknown";

export interface DispatchAck extends BridgeWireBase {
  kind: "dispatch_ack";
  opId: string;
  sessionId: string;
  status: DispatchStatus;
  reason?: string;
}

export interface CancelledResponse extends BridgeWireBase {
  kind: "cancelled";
  opId: string;
  sessionId: string;
  targetOpId: string;
  settled: boolean;
}

export interface OptionsUpdatedResponse extends BridgeWireBase {
  kind: "options_updated";
  opId: string;
  sessionId: string;
  options: BridgeSessionOptions;
}

export interface HistoryResponse extends BridgeWireBase {
  kind: "history";
  opId: string;
  sessionId: string;
  entries: BridgeHistoryEntry[];
  nextCursor?: string;
  leafId?: string;
}

export interface SessionResponse extends BridgeWireBase {
  kind: "session";
  opId: string;
  sessionId: string;
  metadata: BridgeSessionMetadata;
}

export interface SessionEvent extends BridgeWireBase {
  kind: "session_event";
  sessionId: string;
  opId?: string;
  event: BridgeProviderEvent;
}

export interface ClosedResponse extends BridgeWireBase {
  kind: "closed";
  opId: string;
  sessionId?: string;
  exit: { code: number | null; signal: string | null };
}

export interface ExitingEvent extends BridgeWireBase {
  kind: "exiting";
  exit: { code: number | null; signal: string | null };
  reason: string;
}

export interface BridgeErrorEvent extends BridgeWireBase {
  kind: "error";
  opId?: string;
  sessionId?: string;
  error: { code: string; message: string };
}

export type ProviderToHostMessage =
  | HelloOk
  | HelloError
  | AcquiredResponse
  | ReleasedResponse
  | DispatchAck
  | CancelledResponse
  | OptionsUpdatedResponse
  | HistoryResponse
  | SessionResponse
  | SessionEvent
  | ClosedResponse
  | ExitingEvent
  | BridgeErrorEvent;

const H2P_KINDS: ReadonlySet<string> = new Set([
  "hello",
  "acquire",
  "release",
  "dispatch",
  "cancel",
  "answer_prompt",
  "set_options",
  "get_history",
  "get_session",
  "close",
]);

const P2H_KINDS: ReadonlySet<string> = new Set([
  "hello_ok",
  "hello_error",
  "acquired",
  "released",
  "dispatch_ack",
  "cancelled",
  "options_updated",
  "history",
  "session",
  "session_event",
  "closed",
  "exiting",
  "error",
]);

let opCounter = 0;

/**
 * Create a unique operation id for one h2p request.
 * Unique per host process; echoed by every provider response for that op.
 */
export function createOpId(prefix = "op"): string {
  opCounter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}_${opCounter}_${rand}`;
}

/** Reset the op counter (tests only). */
export function __resetOpCounterForTests(): void {
  opCounter = 0;
}

function hasForbiddenKey(value: unknown, seen: string[] = []): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = hasForbiddenKey(item, seen);
      if (hit) return hit;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const lower = k.toLowerCase().replace(/[_-]/g, "");
      for (const forbidden of FORBIDDEN_BRIDGE_KEYS) {
        const f = forbidden.toLowerCase().replace(/[_-]/g, "");
        if (lower === f || lower.endsWith(f)) return [...seen, k].join(".");
      }
      const hit = hasForbiddenKey(v, [...seen, k]);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Fail-closed credential guard. Returns the offending key path, or null.
 * Both host and provider call this before sending *and* after receiving.
 */
export function findCredentialField(value: unknown): string | null {
  return hasForbiddenKey(value);
}

/** Throw a `BridgeProtocolError` when credential fields are present. */
export function assertNoCredentialFields(value: unknown, where: string): void {
  const hit = findCredentialField(value);
  if (hit) throw new BridgeProtocolError(`refusing to send ${where}: forbidden credential field "${hit}"`);
}

/**
 * Validate the shape of one parsed bridge record.
 * Returns null when valid, otherwise a short machine-readable reason
 * (never includes prompt text or environment values).
 */
export function validateBridgeMessage(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "not-an-object";
  const v = value as Record<string, unknown>;
  if (v["v"] !== BRIDGE_PROTOCOL_VERSION) return "bad-version";
  if (typeof v["kind"] !== "string") return "missing-kind";
  const kind = v["kind"] as string;
  const known = H2P_KINDS.has(kind) || P2H_KINDS.has(kind);
  if (!known) return "unknown-kind";
  const needsOp = new Set([
    "hello",
    "acquire",
    "release",
    "dispatch",
    "cancel",
    "answer_prompt",
    "set_options",
    "get_history",
    "get_session",
    "close",
    "hello_ok",
    "hello_error",
    "acquired",
    "released",
    "dispatch_ack",
    "cancelled",
    "options_updated",
    "history",
    "session",
    "closed",
  ]);
  if (needsOp.has(kind) && typeof v["opId"] !== "string") return "missing-opId";
  if (findCredentialField(value) !== null) return "credential-field";
  switch (kind) {
    case "dispatch": {
      const msg = (v["message"] ?? null) as { text?: unknown } | null;
      if (!msg || typeof msg.text !== "string") return "dispatch-missing-text";
      break;
    }
    case "session_event": {
      if (typeof v["sessionId"] !== "string") return "event-missing-sessionId";
      if (v["event"] === null || typeof v["event"] !== "object") return "event-missing-event";
      break;
    }
    case "hello": {
      const host = v["host"] as { protocol?: unknown } | undefined;
      if (!host || host.protocol !== BRIDGE_PROTOCOL_VERSION) return "hello-bad-protocol";
      break;
    }
    default:
      break;
  }
  return null;
}

/** True when the value is a well-formed bridge record with no credential fields. */
export function isBridgeMessage(value: unknown): boolean {
  return validateBridgeMessage(value) === null;
}

const SECRET_VALUE_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "bearer", re: /bearer\s+[A-Za-z0-9\-._~+/=]{16,}/i },
  { name: "api-key", re: /sk-(?:proj-)?[A-Za-z0-9\-_]{16,}/ },
  { name: "oauth", re: /ya29\.[A-Za-z0-9\-_]{16,}|xox[bpas]-[A-Za-z0-9\-_]{8,}/ },
];

/**
 * Redact secret-like values from diagnostics (bounded stderr snippets,
 * error strings). Never throws; returns a redacted copy. Prompt text is
 * *not* redacted here — callers must avoid putting prompt text into
 * diagnostics at all (see `sanitizeErrorForDisplay` in `host.ts`).
 */
export function redactSecretsFromText(text: string, limit = MAX_STDERR_BYTES): string {
  let out = text;
  for (const p of SECRET_VALUE_PATTERNS) out = out.replace(p.re, "[redacted]");
  if (out.length > limit) out = out.slice(-limit);
  return out;
}

/** Error for local protocol violations (never carries prompt/env values). */
export class BridgeProtocolError extends Error {
  readonly code: string;
  constructor(message: string, code = "BRIDGE_PROTOCOL") {
    super(message);
    this.name = "BridgeProtocolError";
    this.code = code;
  }
}

/** Error for unavailable/incompatible bridges (fail-closed, fall back to TUI). */
export class BridgeUnavailableError extends Error {
  readonly code: string;
  constructor(message: string, code = "BRIDGE_UNAVAILABLE") {
    super(message);
    this.name = "BridgeUnavailableError";
    this.code = code;
  }
}

/** Error for bounded-deadline expiry (dispatch maps these to `unknown`). */
export class BridgeTimeoutError extends Error {
  readonly code = "BRIDGE_TIMEOUT";
  constructor(message: string) {
    super(message);
    this.name = "BridgeTimeoutError";
  }
}

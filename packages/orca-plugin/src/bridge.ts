/**
 * Versioned typed panel↔bridge protocol (UI1.2).
 *
 * Narrow, versioned bridge contract owned by Orca-Pi:
 *
 * ```text
 * Panel
 *   ↕ typed request/response (this module)
 * Orca-Pi plugin bridge (bridge-host.ts / worker.ts)
 *   ↕
 * Orca-Pi application/config services (@orca-pi/core)
 * ```
 *
 * The panel never scrapes terminal output or YAML. All mutations are typed
 * allowlisted operations (never shell strings). No second profile store is
 * introduced — the bridge reads/writes only the authoritative YAML via the
 * UI1.1 core mutation service.
 *
 * Transport note (see docs/ORCA_PLUGIN_API.md): current Orca Host API v0
 * exposes only `workspace.readContext` / `terminal.sendText` /
 * `notifications.show` to panels and `storage` / `secrets` / `settings` /
 * `events.subscribe` to workers — no general/scoped `process:exec` or
 * filesystem API, and no panel↔bridge seam. The native structured
 * worker/host path therefore cannot serve live profile/config data without
 * a second store (forbidden). The current transport is the `orca-pi bridge`
 * CLI sidecar (one versioned request per call; the invocation itself is the
 * seam handshake); the production target beyond it is a narrow, generic,
 * upstreamable Orca core scoped-exec/plugin-service seam (no Pi-specific
 * policy in Orca core). `terminal.sendText` is only a clearly-labeled
 * degraded fallback for explicit user actions and never the primary
 * architecture. `workspace.readContext` supplies branch/display
 * name/terminal identity only — never filesystem paths, so absolute
 * project roots arrive via the seam/sidecar injection.
 *
 * This module is pure (no I/O, no `node:` imports) so panels, workers, and
 * tests share one validator. `bridge-host.ts` implements the dispatcher
 * over `@orca-pi/core`; `worker.ts` binds it to the Orca worker lifecycle.
 */

export const BRIDGE_PROTOCOL_VERSION = 1;
export const BRIDGE_VERSION = "1.0.0";

/** Upstream Host API this bridge was audited against (see docs/ORCA_PLUGIN_API.md). */
export const BRIDGE_TARGET_ORCA_APP_VERSION = "1.4.196";
export const BRIDGE_TARGET_PLUGIN_API = 1;
export const BRIDGE_UPSTREAM_COMMIT = "9aa0f7e77d366c23a3cc8de2da32ae550d397dc0";

/**
 * Machine-readable bridge error codes. The five required by UI1.2 are
 * `validation`, `conflict`, `unsupported`, `auth/setup`, `internal`;
 * `not-found` / `already-exists` are narrow refinements of `validation`
 * failures that let the UI distinguish "create vs update" without parsing
 * messages. Every error carries a human `message`; `field` / `retryable` /
 * `detail` are machine hints.
 */
export type BridgeErrorCode =
  | "validation"
  | "conflict"
  | "unsupported"
  | "auth/setup"
  | "internal"
  | "not-found"
  | "already-exists";

/** Closed machine-readable error code set (mirrors `BridgeErrorCode`). */
export const BRIDGE_ERROR_CODES: readonly BridgeErrorCode[] = [
  "validation",
  "conflict",
  "unsupported",
  "auth/setup",
  "internal",
  "not-found",
  "already-exists",
] as const;

export type BridgeOperation =
  | "bridge.capabilities"
  | "worktree.context"
  | "profiles.list"
  | "profile.read"
  | "profile.validate"
  | "profile.mutate"
  | "launch.preview"
  | "orchestration.get"
  | "orchestration.set"
  | "github.status"
  | "github.doctor"
  | "diagnostics.doctor";

export const BRIDGE_OPERATIONS: readonly BridgeOperation[] = [
  "bridge.capabilities",
  "worktree.context",
  "profiles.list",
  "profile.read",
  "profile.validate",
  "profile.mutate",
  "launch.preview",
  "orchestration.get",
  "orchestration.set",
  "github.status",
  "github.doctor",
  "diagnostics.doctor",
] as const;

/** Read-only operations safe in degraded mode (no writes, no secrets). */
export const BRIDGE_READ_OPERATIONS: readonly BridgeOperation[] = [
  "bridge.capabilities",
  "worktree.context",
  "profiles.list",
  "profile.read",
  "profile.validate",
  "launch.preview",
  "orchestration.get",
  "github.status",
  "github.doctor",
  "diagnostics.doctor",
] as const;

/** Mutating operations — require explicit worktree/project scope. */
export const BRIDGE_WRITE_OPERATIONS: readonly BridgeOperation[] = [
  "profile.mutate",
  "orchestration.set",
] as const;

/** Explicit worktree/session identity captured at submission (race-safe). */
export interface BridgeWorktreeScope {
  /** Explicit project root (absolute preferred; never inferred at execution). */
  projectRoot: string;
  /** Explicit Orca worktree id when known (e.g. `repo::/path`). */
  worktreeId?: string;
  /** Explicit terminal id for degraded `terminal.sendText` targeting. */
  terminalId?: string;
}

export interface BridgeRequest {
  protocolVersion: number;
  /** Stable caller-chosen correlation id, echoed on every response. */
  requestId: string;
  operation: BridgeOperation;
  /** Explicit scope. Required for writes; recommended for reads. */
  worktree?: BridgeWorktreeScope;
  params?: unknown;
}

export interface BridgeError {
  code: BridgeErrorCode;
  message: string;
  field?: string;
  retryable?: boolean;
  detail?: string;
}

export type BridgeResponse =
  | {
      protocolVersion: number;
      requestId: string;
      ok: true;
      result: unknown;
    }
  | {
      protocolVersion: number;
      requestId: string;
      ok: false;
      error: BridgeError;
    };

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_PROJECT_ROOT_LENGTH = 1024;
const MAX_WORKTREE_ID_LENGTH = 1024;
const MAX_TERMINAL_ID_LENGTH = 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalize a project root for cross-platform scope comparison.
 * Preserves `\\wsl.localhost\...` and drive-letter prefixes as opaque
 * roots; collapses backslashes to slashes, trims trailing slashes (except
 * a bare drive root like `C:/`), and rejects NUL/control characters.
 * Never touches the filesystem and never resolves against `process.cwd()`.
 */
export function normalizeProjectRoot(root: string): string {
  const trimmed = root.trim();
  let normalized = trimmed.replace(/\\/g, "/");
  // Preserve UNC `//wsl.localhost/...` prefix while collapsing duplicate
  // slashes elsewhere.
  const isUnc = normalized.startsWith("//");
  normalized = normalized.replace(/\/+/g, "/");
  if (isUnc) normalized = `/${normalized}`;
  if (normalized.length > 1 && normalized.endsWith("/")) {
    // Preserve roots whose trailing slash is load-bearing: POSIX `/` is
    // already excluded by length, but a bare Windows drive root (`C:/`)
    // must keep its slash to stay absolute per `isAbsoluteProjectRoot`.
    if (!/^[A-Za-z]:\/$/.test(normalized)) {
      normalized = normalized.replace(/\/+$/, "");
    }
  }
  return normalized;
}

/** True when `root` looks like an absolute project scope (POSIX, drive-letter, or UNC/WSL). */
export function isAbsoluteProjectRoot(root: string): boolean {
  if (typeof root !== "string") return false;
  const trimmed = root.trim();
  if (trimmed.length === 0) return false;
  const normalized = trimmed.replace(/\\/g, "/");
  if (normalized.startsWith("/")) return true;
  if (/^[A-Za-z]:\//.test(normalized)) return true;
  if (/^\\\\/.test(trimmed)) return true;
  return false;
}

function validateWorktreeScope(
  worktree: unknown,
  operation: BridgeOperation,
  errors: string[],
): BridgeWorktreeScope | undefined {
  const requiresScope =
    operation === "profile.mutate" || operation === "orchestration.set";
  if (worktree === undefined) {
    if (requiresScope) {
      errors.push(
        `worktree.projectRoot is required for "${operation}" (explicit scope captured at submission — delayed requests must never be redirected by focus changes).`,
      );
    }
    return undefined;
  }
  if (!isRecord(worktree)) {
    errors.push(`worktree must be an object when present (got ${typeof worktree}).`);
    return undefined;
  }
  const { projectRoot, worktreeId, terminalId } = worktree as {
    projectRoot?: unknown;
    worktreeId?: unknown;
    terminalId?: unknown;
  };
  if (typeof projectRoot !== "string" || projectRoot.trim().length === 0) {
    errors.push(
      `worktree.projectRoot must be a non-empty path string (got ${JSON.stringify(projectRoot)}). Scope project-profile mutations to the current/explicit worktree/project root.`,
    );
    return undefined;
  }
  if (projectRoot.length > MAX_PROJECT_ROOT_LENGTH) {
    errors.push(`worktree.projectRoot must be at most ${MAX_PROJECT_ROOT_LENGTH} chars.`);
    return undefined;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(projectRoot)) {
    errors.push("worktree.projectRoot must not contain control characters.");
    return undefined;
  }
  if (requiresScope && !isAbsoluteProjectRoot(projectRoot)) {
    errors.push(
      `worktree.projectRoot must be an absolute path for "${operation}" (got ${JSON.stringify(projectRoot)}). ` +
        `Project-scoped writes resolve against this root — a relative root would resolve against the worker's cwd instead of a verified worktree. ` +
        `Capture the explicit worktree root at submission (POSIX, drive-letter, or UNC/WSL).`,
    );
    return undefined;
  }
  if (worktreeId !== undefined) {
    if (typeof worktreeId !== "string" || worktreeId.length === 0 || worktreeId.length > MAX_WORKTREE_ID_LENGTH) {
      errors.push(`worktree.worktreeId must be a 1-${MAX_WORKTREE_ID_LENGTH} char string when present.`);
      return undefined;
    }
  }
  if (terminalId !== undefined) {
    if (typeof terminalId !== "string" || terminalId.length === 0 || terminalId.length > MAX_TERMINAL_ID_LENGTH) {
      errors.push(`worktree.terminalId must be a 1-${MAX_TERMINAL_ID_LENGTH} char string when present (explicit target — never "the active terminal").`);
      return undefined;
    }
  }
  const out: BridgeWorktreeScope = { projectRoot: normalizeProjectRoot(projectRoot) };
  if (typeof worktreeId === "string") out.worktreeId = worktreeId;
  if (typeof terminalId === "string") out.terminalId = terminalId;
  return out;
}

/**
 * Validate an unknown value as a `BridgeRequest`. Pure — never throws,
 * returns structured errors with stable requestId echo (`"unknown"` when
 * the caller supplied no usable id). Rejects arbitrary operations
 * (`exec`, `shell`, `command`, ...) with `validation`, never executes.
 */
export function parseBridgeRequest(data: unknown):
  | { ok: true; request: BridgeRequest }
  | { ok: false; requestId: string; error: BridgeError } {
  const fallbackId = "unknown";
  if (!isRecord(data)) {
    return {
      ok: false,
      requestId: fallbackId,
      error: {
        code: "validation",
        message: "Bridge request must be an object with protocolVersion, requestId, and operation.",
      },
    };
  }
  const rawId = (data as { requestId?: unknown }).requestId;
  const requestId =
    typeof rawId === "string" && REQUEST_ID_PATTERN.test(rawId) ? rawId : fallbackId;
  const fail = (message: string, field?: string): { ok: false; requestId: string; error: BridgeError } => ({
    ok: false,
    requestId,
    error: { code: "validation", message, ...(field !== undefined ? { field } : {}) },
  });

  if ((data as { protocolVersion?: unknown }).protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
    return {
      ok: false,
      requestId,
      error: {
        code: "unsupported",
        message: `Unsupported bridge protocolVersion ${JSON.stringify((data as { protocolVersion?: unknown }).protocolVersion)} (supported: ${BRIDGE_PROTOCOL_VERSION}). Upgrade orca-pi or use the degraded CLI fallback.`,
      },
    };
  }
  if (typeof rawId !== "string" || !REQUEST_ID_PATTERN.test(rawId)) {
    return fail(
      `requestId must match ${REQUEST_ID_PATTERN} (1-128 chars, stable per request, echoed on the response).`,
      "requestId",
    );
  }
  const operation = (data as { operation?: unknown }).operation;
  if (typeof operation !== "string" || !(BRIDGE_OPERATIONS as readonly string[]).includes(operation)) {
    return {
      ok: false,
      requestId,
      error: {
        code: "validation",
        message: `Unknown or disallowed bridge operation ${JSON.stringify(operation)}: expected one of ${BRIDGE_OPERATIONS.join(", ")}. The panel cannot request arbitrary command execution.`,
        detail: "allowlisted-operations-only",
      },
    };
  }
  const op = operation as BridgeOperation;
  const errors: string[] = [];
  const worktree = validateWorktreeScope((data as { worktree?: unknown }).worktree, op, errors);
  if (errors.length > 0) {
    return {
      ok: false,
      requestId,
      error: { code: "validation", message: errors.join(" ") },
    };
  }
  const request: BridgeRequest = {
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    requestId,
    operation: op,
    ...(worktree !== undefined ? { worktree } : {}),
    ...("params" in data && (data as { params?: unknown }).params !== undefined
      ? { params: (data as { params?: unknown }).params }
      : {}),
  };
  return { ok: true, request };
}

/** Build a success response (always echoes protocolVersion + requestId). */
export function bridgeOk(requestId: string, result: unknown): BridgeResponse {
  return { protocolVersion: BRIDGE_PROTOCOL_VERSION, requestId, ok: true, result };
}

/** Build an error response (always echoes protocolVersion + requestId). */
export function bridgeFail(
  requestId: string,
  code: BridgeErrorCode,
  message: string,
  extra?: { field?: string; retryable?: boolean; detail?: string },
): BridgeResponse {
  return {
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    requestId,
    ok: false,
    error: {
      code,
      message,
      ...(extra?.field !== undefined ? { field: extra.field } : {}),
      ...(extra?.retryable !== undefined ? { retryable: extra.retryable } : {}),
      ...(extra?.detail !== undefined ? { detail: extra.detail } : {}),
    },
  };
}

export type BridgeResponseValidation =
  | { ok: true; response: BridgeResponse }
  | { ok: false; code: "unsupported" | "internal"; message: string };

/**
 * Validate an unknown value as the `BridgeResponse` for one request.
 * Checks the versioned envelope end to end: object shape,
 * `protocolVersion`, `requestId` echo, the `ok` discriminant, and the
 * success (`result`) vs error (`error: {code, message}` against the
 * closed code set) fields. Version skew maps to `unsupported` (clean
 * degradation); every other malformation maps to `internal`. Pure — the
 * seam adapter uses this instead of trusting a sidecar cast, so a
 * compromised or skewed sidecar cannot smuggle unshaped data to the panel.
 */
export function validateBridgeResponse(data: unknown, expectedRequestId: string): BridgeResponseValidation {
  if (!isRecord(data)) {
    return { ok: false, code: "internal", message: "Bridge response must be an object. No data was trusted." };
  }
  if (data["protocolVersion"] !== BRIDGE_PROTOCOL_VERSION) {
    return {
      ok: false,
      code: "unsupported",
      message: `Unsupported bridge protocolVersion ${JSON.stringify(data["protocolVersion"])} (supported: ${BRIDGE_PROTOCOL_VERSION}). No data was trusted.`,
    };
  }
  if (data["requestId"] !== expectedRequestId) {
    return { ok: false, code: "internal", message: "Bridge response requestId mismatch. No data was trusted." };
  }
  if (data["ok"] === true) {
    if (!("result" in data)) {
      return { ok: false, code: "internal", message: "Bridge success response is missing `result`. No data was trusted." };
    }
    return { ok: true, response: data as unknown as BridgeResponse };
  }
  if (data["ok"] === false) {
    const error = (data as { error?: unknown }).error;
    if (!isRecord(error) || typeof error["message"] !== "string" || error["message"].length === 0) {
      return { ok: false, code: "internal", message: "Bridge error response has no usable `error.message`. No data was trusted." };
    }
    if (typeof error["code"] !== "string" || !(BRIDGE_ERROR_CODES as readonly string[]).includes(error["code"])) {
      return { ok: false, code: "internal", message: `Bridge error response carries an unknown code ${JSON.stringify(error["code"])}. No data was trusted.` };
    }
    return { ok: true, response: data as unknown as BridgeResponse };
  }
  return { ok: false, code: "internal", message: "Bridge response has a non-boolean `ok` discriminant. No data was trusted." };
}

/** Create a new request with a caller-supplied stable id (panels generate these per action). */
export function makeBridgeRequest(
  requestId: string,
  operation: BridgeOperation,
  options?: { worktree?: BridgeWorktreeScope; params?: unknown },
): BridgeRequest {
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error(`Invalid bridge requestId ${JSON.stringify(requestId)}: must match ${REQUEST_ID_PATTERN}.`);
  }
  if (!(BRIDGE_OPERATIONS as readonly string[]).includes(operation)) {
    throw new Error(`Disallowed bridge operation ${JSON.stringify(operation)}. The panel cannot request arbitrary command execution.`);
  }
  return {
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    requestId,
    operation,
    ...(options?.worktree !== undefined ? { worktree: options.worktree } : {}),
    ...(options?.params !== undefined ? { params: options.params } : {}),
  };
}

// ---------------------------------------------------------------------------
// Capability negotiation + degraded fallback
// ---------------------------------------------------------------------------

export type BridgeHostCapabilityKind =
  | "workspace:read"
  | "terminal:send"
  | "notifications:show"
  | "storage"
  | "secrets"
  | "events:subscribe"
  | "settings:own";

export interface BridgeNegotiationInput {
  appVersion?: string;
  pluginApi?: number;
  grantedCapabilities?: readonly string[];
  /**
   * Explicit transport/seam handshake. True only when the panel↔bridge
   * transport is present: the sidecar/seam injection
   * (`window.__ORCA_PI_BRIDGE__.request` in panels, `ORCA_PI_BRIDGE_SEAM=1`
   * or `seamAvailable` in the worker). Defaults to false (fail-closed):
   * without a proven transport the bridge reports degraded even when
   * versions and capabilities look right, because the audited Host API v0
   * has no panel↔bridge seam of its own.
   */
  seamAvailable?: boolean;
}

export interface BridgeNegotiation {
  bridgeVersion: string;
  protocolVersion: number;
  /**
   * True when the host can render declarative sandboxed panels
   * (pluginApi v1 + engines.orca >=1.4.0, both explicitly provided).
   */
  supported: boolean;
  /**
   * True when versioned bridge operations are actually reachable
   * (render support + `workspace:read` consent + seam handshake).
   * Stock Orca without the seam reports `structured: false`.
   */
  structured: boolean;
  /** True when the panel must use the read-only/degraded path. */
  degraded: boolean;
  /** Version/consent/handshake sub-signals (for host-side enforcement). */
  versionsOk: boolean;
  consentOk: boolean;
  seamHandshake: boolean;
  supportedOperations: readonly BridgeOperation[];
  fallback: "structured" | "cli-only";
  reasons: string[];
}

/**
 * Operations served without structured support (bootstrap/diagnostic only).
 * Everything else — including all reads of config data and all mutations —
 * requires negotiated `structured` support at the host boundary.
 */
export const DEGRADED_SAFE_OPERATIONS: readonly BridgeOperation[] = [
  "bridge.capabilities",
  "worktree.context",
  "diagnostics.doctor",
] as const;

function parseMajorMinorPatch(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function gte(a: string, b: string): boolean {
  const pa = parseMajorMinorPatch(a);
  const pb = parseMajorMinorPatch(b);
  if (!pa || !pb) return false;
  for (let index = 0; index < 3; index += 1) {
    if (pa[index]! > pb[index]!) return true;
    if (pa[index]! < pb[index]!) return false;
  }
  return true;
}

/**
 * Negotiate bridge support for the installed host. Pure — no I/O.
 * Fail-closed: unknown versions, missing consent, or a missing seam
 * handshake all degrade to read-only CLI fallback. In particular the
 * worker `orca` API exposes no `appVersion`/`pluginApi`, so callers must
 * not default them to the targeted versions — an absent version is
 * "unknown", never "current". Later Host API additions are additive:
 * unknown future capabilities are ignored (never required), and unknown
 * future operations degrade to `unsupported` with an actionable message
 * instead of requiring a panel rewrite.
 */
export function negotiateBridgeCapabilities(input?: BridgeNegotiationInput): BridgeNegotiation {
  const reasons: string[] = [];
  const pluginApi = input?.pluginApi;
  const appVersion = input?.appVersion;
  const granted = input?.grantedCapabilities !== undefined ? new Set(input.grantedCapabilities) : undefined;
  const seamAvailable = input?.seamAvailable === true;

  let renderSupported = true;
  if (pluginApi === undefined) {
    renderSupported = false;
    reasons.push(
      `Host pluginApi is unknown (the worker orca API does not expose it) — refusing to assume v${BRIDGE_TARGET_PLUGIN_API}; structured bridge degrades to read-only CLI fallback.`,
    );
  } else if (pluginApi !== BRIDGE_TARGET_PLUGIN_API) {
    renderSupported = false;
    reasons.push(
      `pluginApi ${pluginApi} is not the targeted v1 (${BRIDGE_TARGET_PLUGIN_API}); structured bridge degrades to read-only CLI fallback.`,
    );
  } else {
    reasons.push("pluginApi 1 supports declarative sandboxed panels.");
  }

  if (appVersion === undefined) {
    renderSupported = false;
    reasons.push(
      `Host app version is unknown (the worker orca API does not expose it) — refusing to assume ${BRIDGE_TARGET_ORCA_APP_VERSION}; structured bridge degrades to read-only CLI fallback.`,
    );
  } else if (!gte(appVersion, "1.4.0")) {
    renderSupported = false;
    reasons.push(
      `Orca app ${appVersion} is older than engines.orca >=1.4.0; structured bridge degrades to read-only CLI fallback.`,
    );
  } else {
    reasons.push(`Orca app ${appVersion} meets engines.orca >=1.4.0.`);
  }

  // Consent is only meaningful when the host actually reports grants: an
  // absent grant list is "unknown", never "granted".
  const hasWorkspaceRead = granted?.has("workspace:read") ?? false;
  if (granted === undefined) {
    reasons.push("Granted capabilities are unknown — consent cannot be verified; mutations stay disabled.");
  } else if (!hasWorkspaceRead) {
    reasons.push("Missing workspace:read consent — worktree context is unavailable; mutations stay disabled (explicit scope cannot be verified).");
  } else {
    reasons.push("workspace:read granted — worktree context available for explicit scoping.");
  }

  if (granted !== undefined) {
    if (!granted.has("terminal:send")) {
      reasons.push("terminal:send not granted — degraded CLI fallback stays text-only (no explicit terminal.sendText action offered).");
    } else {
      reasons.push("terminal:send granted — degraded fallback may offer an explicit user-triggered terminal.sendText action (never auto-executed, never parsed).");
    }
  }

  // The bridge never stores profiles in settings/storage: those
  // capabilities are intentionally unused so no second store can diverge.
  if (granted?.has("storage") || granted?.has("settings:own")) {
    reasons.push("Note: storage/settings capabilities are unused by the Orca-Pi bridge (no second profile store — authoritative YAML only).");
  }
  if (granted?.has("secrets")) {
    reasons.push("Note: secrets capability is unused by the Orca-Pi bridge (GitHub tokens never enter the panel; redacted status only).");
  }

  // Transport gate: the audited Host API v0 has no panel↔bridge seam
  // (no scoped process:exec/filesystem API, no plugin-service.invoke).
  // Versions + consent alone cannot prove reachability, so structured
  // operations require the explicit seam handshake. Reachable today via
  // the `orca-pi bridge` CLI sidecar; the generic scoped-exec seam is the
  // upstreamable future. `workspace.readContext` supplies branch, display
  // name, and terminal identity only — never filesystem paths, so the
  // absolute projectRoot for writes must arrive via the seam/sidecar
  // injection, never via readContext.
  const isStructured = renderSupported && hasWorkspaceRead && seamAvailable;
  if (!seamAvailable) {
    reasons.push(
      "No panel↔bridge seam handshake (no `window.__ORCA_PI_BRIDGE__.request` / `ORCA_PI_BRIDGE_SEAM=1` / `seamAvailable` signal): structured operations are unreachable on stock Orca — explicit read-only CLI fallback. Live data flows through the `orca-pi bridge` CLI sidecar where the seam harness provides it.",
    );
  } else if (isStructured) {
    reasons.push("Seam handshake present: versioned bridge operations are reachable (request IDs + validation/conflict/unsupported/auth-setup/internal errors). Panel never scrapes terminal output or YAML and never stores a second copy of profiles.");
  }

  const supportedOperations: readonly BridgeOperation[] = isStructured
    ? BRIDGE_OPERATIONS
    : DEGRADED_SAFE_OPERATIONS;
  return {
    bridgeVersion: BRIDGE_VERSION,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    supported: renderSupported,
    structured: isStructured,
    degraded: !isStructured,
    versionsOk: renderSupported,
    consentOk: hasWorkspaceRead,
    seamHandshake: seamAvailable,
    supportedOperations,
    fallback: isStructured ? "structured" : "cli-only",
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Degraded terminal.sendText fallback descriptors
// ---------------------------------------------------------------------------

export interface TerminalFallbackAction {
  /** Always the literal host action — clearly labeled, never a shell string. */
  hostAction: "terminal.sendText";
  /** Explicit target terminal (never "active" — callers must supply it from workspace.readContext). */
  terminalId: string;
  /** Exact CLI text the user explicitly triggers (e.g. `orca-pi profile validate`). */
  text: string;
  enter: false;
  degraded: true;
  note: string;
}

/**
 * Describe (never execute) an explicit degraded `terminal.sendText` action.
 * Requires an explicit `terminalId` from `workspace.readContext` so a focus
 * change can never redirect a delayed request into another pane. The panel
 * must only send this after an explicit user gesture, and must never parse
 * terminal output back into the UI.
 */
export function describeTerminalFallback(
  terminalId: string,
  text: string,
): TerminalFallbackAction | { ok: false; error: BridgeError } {
  if (typeof terminalId !== "string" || terminalId.length === 0 || terminalId.length > MAX_TERMINAL_ID_LENGTH) {
    return {
      ok: false,
      error: {
        code: "validation",
        message: "Degraded terminal.sendText requires an explicit terminalId from workspace.readContext (never the active terminal).",
      },
    };
  }
  if (typeof text !== "string" || text.trim().length === 0 || text.length > 4096) {
    return {
      ok: false,
      error: { code: "validation", message: "Degraded terminal.sendText requires non-empty CLI text (1-4096 chars)." },
    };
  }
  // Allowlist: degraded fallback may only run read-only / explicitly-scoped
  // orca-pi CLI commands — never arbitrary shell.
  const trimmed = text.trim();
  if (!/^orca-pi\s+(doctor|profiles\s+list|profile\s+(show|inspect|validate|path|read)\b)/.test(trimmed)) {
    return {
      ok: false,
      error: {
        code: "validation",
        message: `Degraded terminal.sendText refuses non-allowlisted text ${JSON.stringify(trimmed.slice(0, 80))}: only read-only orca-pi CLI commands (doctor, profiles list, profile show/inspect/validate/path/read) may be offered as explicit fallback. Mutations require the structured bridge.`,
        detail: "degraded-allowlist-only",
      },
    };
  }
  return {
    hostAction: "terminal.sendText",
    terminalId,
    text: trimmed,
    enter: false,
    degraded: true,
    note: "Degraded fallback: explicit user action only. The panel must not auto-send and must not parse terminal output back into the UI.",
  };
}

/**
 * Map a core `ProfileMutationError` code onto a bridge error code so the UI
 * can branch without parsing messages (`conflict` → reload+retry, ...).
 */
export function mapMutationCodeToBridge(code: string): BridgeErrorCode {
  switch (code) {
    case "conflict":
      return "conflict";
    case "already-exists":
      return "already-exists";
    case "not-found":
      return "not-found";
    case "missing-scope":
    case "invalid-name":
    case "invalid-field":
    case "invalid-value":
    case "validation-failed":
    case "resolve-failed":
    case "builtin-immutable":
      return "validation";
    case "atomic-write-failed":
    case "load-failed":
      return "internal";
    default:
      return "internal";
  }
}

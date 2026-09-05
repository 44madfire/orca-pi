/**
 * Secret-safe Pi RPC errors (SNC1.2).
 *
 * Diagnostics must never leak credentials or prompt contents. Every error
 * carries only:
 * - a stable machine-readable `code`,
 * - the command *name* + request *id* (never the full payload),
 * - a bounded, redacted `stderrTail` (never prompt text / image bytes),
 * - transport facts (timeout, exit code/signal, `ambiguous`).
 *
 * `ambiguous` implements the accepted/rejected/ambiguous contract:
 * - accepted: the request resolved (`success: true`). For `prompt` this
 *   means queued/handled, not completed — completion is `agent_settled`.
 * - rejected (`ambiguous: false`, `code: "rejected"`): Pi definitively
 *   refused (`success: false`); no partial state change per contract.
 * - ambiguous (`ambiguous: true`): the transport failed (timeout, exit,
 *   close) after the write succeeded, so the caller cannot know whether Pi
 *   processed the command. Callers must re-read state (`get_state`,
 *   `get_entries since`) rather than retry blindly.
 */

export type PiRpcErrorCode =
  | "not-started"
  | "already-started"
  | "already-closed"
  | "spawn-failed"
  | "startup-failed"
  | "startup-timeout"
  | "write-failed"
  | "request-timeout"
  | "rejected"
  | "process-exited"
  | "transport-closed"
  | "malformed-line";

export interface PiRpcErrorDetails {
  /** Stable code for programmatic handling. */
  readonly code: PiRpcErrorCode;
  /** Command name (e.g. `"prompt"`), never the full payload. */
  readonly command?: string;
  /** Correlated request id, when known. */
  readonly requestId?: string;
  /** True when Pi may or may not have processed the command. */
  readonly ambiguous: boolean;
  /** Bounded, redacted stderr tail (no secrets / prompt contents). */
  readonly stderrTail?: string;
  /** Process exit facts, when the transport died. */
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  /** Pi-supplied `error` string for `rejected` (itself secret-free). */
  readonly piError?: string;
  /** Deadline that fired, for timeout errors. */
  readonly timeoutMs?: number;
}

const SECRET_RES: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "bearer", re: /bearer\s+[A-Za-z0-9\-._~+/=]{8,}/gi },
  { name: "api-key", re: /sk-(?:proj-)?[A-Za-z0-9\-_]{8,}/g },
  { name: "pi-access", re: /"access"\s*:\s*"eyJ[A-Za-z0-9\-_]+[^"]*"/g },
  { name: "pi-refresh", re: /"refresh"\s*:\s*"rt\.[^"]*"/g },
  { name: "oauth", re: /ya29\.[A-Za-z0-9\-_]{8,}|xox[bpas]-[A-Za-z0-9\-_]{4,}/g },
  // Absolute user paths are identifying; collapse them in diagnostics.
  { name: "win-path", re: /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+(?:\\[^"\s]*)?/g },
  { name: "unix-home", re: /\/(?:home|Users)\/[A-Za-z0-9._-]+(?:\/[^"\s]*)?/g },
];

/** Redact token-like secrets + user paths from a diagnostic string. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const { re } of SECRET_RES) {
    out = out.replace(re, "[REDACTED]");
  }
  return out;
}

/** Bound a diagnostic string to `maxChars` code units, keeping the tail. */
export function boundTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `…[truncated ${text.length - maxChars} chars]…${text.slice(text.length - maxChars)}`;
}

export const STDERR_TAIL_MAX_CHARS = 4_000;

/** Redact + bound a raw stderr capture for inclusion in errors. */
export function redactStderrTail(raw: string, maxChars = STDERR_TAIL_MAX_CHARS): string {
  return boundTail(redactSecrets(raw), maxChars);
}

/** Preview a malformed stdout line without leaking unbounded bytes. */
export function redactLinePreview(line: string, maxChars = 500): string {
  return boundTail(redactSecrets(line), maxChars);
}

export class PiRpcError extends Error {
  readonly code: PiRpcErrorCode;
  readonly command?: string;
  readonly requestId?: string;
  readonly ambiguous: boolean;
  readonly stderrTail?: string;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly piError?: string;
  readonly timeoutMs?: number;

  constructor(details: PiRpcErrorDetails, message: string) {
    super(message);
    this.name = "PiRpcError";
    this.code = details.code;
    this.ambiguous = details.ambiguous;
    if (details.command !== undefined) this.command = details.command;
    if (details.requestId !== undefined) this.requestId = details.requestId;
    if (details.stderrTail !== undefined) this.stderrTail = details.stderrTail;
    if (details.exitCode !== undefined) this.exitCode = details.exitCode;
    if (details.signal !== undefined) this.signal = details.signal;
    if (details.piError !== undefined) this.piError = details.piError;
    if (details.timeoutMs !== undefined) this.timeoutMs = details.timeoutMs;
  }

  /** One-line secret-safe summary (safe for logs / toasts). */
  toSecretSafeString(): string {
    const parts = [`PiRpcError(${this.code})`];
    if (this.command) parts.push(`command=${this.command}`);
    if (this.requestId) parts.push(`id=${this.requestId}`);
    if (this.timeoutMs !== undefined) parts.push(`timeoutMs=${this.timeoutMs}`);
    if (this.exitCode !== undefined || this.signal !== undefined) {
      parts.push(`exit=${String(this.exitCode)}/${String(this.signal)}`);
    }
    if (this.ambiguous) parts.push("ambiguous");
    if (this.piError) parts.push(`pi=${boundTail(this.piError, 300)}`);
    return parts.join(" ");
  }
}

/** Build a `rejected` error from a Pi `success: false` response. */
export function rejectedError(
  command: string,
  requestId: string | undefined,
  piError: string,
  stderrTail?: string,
): PiRpcError {
  return new PiRpcError(
    {
      code: "rejected",
      command,
      ...(requestId !== undefined ? { requestId } : {}),
      ambiguous: false,
      piError: boundTail(piError, 1_000),
      ...(stderrTail !== undefined ? { stderrTail } : {}),
    },
    `Pi rejected ${command}${requestId ? ` (id=${requestId})` : ""}: ${boundTail(piError, 300)}`,
  );
}

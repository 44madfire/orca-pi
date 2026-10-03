/**
 * debug.ts — Debug logging for failures and decisions the package keeps silent.
 *
 * Set PI_SUBAGENTS_DEBUG=1 to reveal silenced catch blocks and outcomes that
 * leave no trace in a session, throughout the package. Production behavior is
 * unchanged when unset.
 */

export function isDebug(): boolean {
  return process.env.PI_SUBAGENTS_DEBUG === "1";
}

export function debugLog(context: string, err: unknown): void {
  if (isDebug()) console.warn(`[pi-subagents:debug] ${context}:`, err);
}

/** Report an outcome that is silent by design and has no error to attach. */
export function debugNote(message: string): void {
  if (isDebug()) console.warn(`[pi-subagents:debug] ${message}`);
}

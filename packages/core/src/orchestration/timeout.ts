/**
 * Human duration parsing for compact orchestration commands (OP1.5 / JEF-9).
 *
 * `orca-pi wait --timeout <duration>` accepts concise human durations and
 * converts them to the milliseconds Orca `--timeout-ms` expects. Plain
 * numbers mean seconds (the common coordinator shorthand); explicit suffixes
 * select units. Never returns NaN — invalid input throws a concise,
 * actionable error before any Orca effects.
 *
 * Supported (case-insensitive, optional whitespace):
 *   `500ms`, `30s`, `5m`, `1h`, `90` (= 90s), `1.5h`, `2m30s`? (no — single
 *   unit only in v1; combine by using the smallest unit).
 *
 * Bounds: must be > 0 and <= 24h (86_400_000ms). Zero/negative/unparseable
 * values are pre-launch errors (exit 2 at the CLI).
 */

/** Max compact wait timeout (24h). Longer waits should be split into rolling windows. */
export const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/** Default `wait` timeout when `--timeout` is omitted (15m, matches the orchestration guide). */
export const DEFAULT_WAIT_TIMEOUT_MS = 15 * 60 * 1000;

/** Default polling interval for `wait` (2s, with backoff up to 10s in operations). */
export const DEFAULT_POLL_INTERVAL_MS = 2_000;

/** Max polling interval for `wait` backoff. */
export const MAX_POLL_INTERVAL_MS = 10_000;

export class TimeoutParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutParseError";
  }
}

/**
 * Parse a human `--timeout` value into milliseconds.
 *
 * @param raw Raw CLI value (e.g. `"30s"`, `"5m"`, `"90"`, `"500ms"`).
 * @returns Timeout in milliseconds.
 * @throws {@link TimeoutParseError} on empty/unknown/zero/over-limit input.
 */
export function parseTimeoutToMs(raw: string): number {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) {
    throw new TimeoutParseError(
      `Invalid --timeout "": expected a duration like 30s, 5m, 1h, or 500ms (plain numbers mean seconds).`,
    );
  }
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(trimmed);
  if (!match) {
    throw new TimeoutParseError(
      `Invalid --timeout "${raw}": expected a duration like 30s, 5m, 1h, or 500ms (plain numbers mean seconds).`,
    );
  }
  const amount = Number(match[1]);
  const unit = match[2] ?? "s";
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new TimeoutParseError(
      `Invalid --timeout "${raw}": duration must be greater than zero (e.g. 30s, 5m, 1h).`,
    );
  }
  const factor =
    unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000;
  const ms = Math.round(amount * factor);
  if (ms <= 0) {
    throw new TimeoutParseError(
      `Invalid --timeout "${raw}": duration must be greater than zero (e.g. 30s, 5m, 1h).`,
    );
  }
  if (ms > MAX_TIMEOUT_MS) {
    throw new TimeoutParseError(
      `Invalid --timeout "${raw}": exceeds the 24h maximum; split long supervisions into rolling wait windows.`,
    );
  }
  return ms;
}

/** Format milliseconds back into a concise human duration (for human output). */
export function formatTimeoutMs(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) {
    const s = ms / 1_000;
    return `${Number.isInteger(s) ? s : s.toFixed(1)}s`;
  }
  if (ms < 3_600_000) {
    const m = ms / 60_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}m`;
  }
  const h = ms / 3_600_000;
  return `${Number.isInteger(h) ? h : h.toFixed(1)}h`;
}

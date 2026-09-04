/**
 * Structured Pi process invocation (OP1.3 / JEF-7).
 *
 * The launcher produces this shape — never a shell-concatenated string —
 * so correctness never depends on shell quoting. Callers spawn with
 * `spawn(spec.command, [...spec.args], { cwd: spec.cwd })` (POSIX) or the
 * equivalent `ProcessRunner`; the human-readable formatter in
 * `format-inspect.ts` is display-only and must never be used to execute.
 */

/** Deterministic Pi invocation: `{ command, args, cwd, env }`. */
export interface PiProcessSpec {
  /** Executable name (`"pi"`, resolved via PATH). */
  readonly command: string;
  /** Deterministic argv (no shell). Each flag value is one element. */
  readonly args: readonly string[];
  /** Preserved Orca worktree cwd. Never derived from process-global cwd. */
  readonly cwd: string;
  /**
   * Extra env overlay (v1: always empty — no hidden ambient config).
   * Callers must not merge `process.env` here; the spec carries only
   * explicit additions (currently none).
   */
  readonly env: Readonly<Record<string, string>>;
}

/** Executable used for every launched Pi process. */
export const PI_COMMAND = "pi" as const;

/**
 * Freeze a spec (and its `args`/`env`) for determinism guarantees.
 * Returns the same reference for chaining.
 */
export function freezePiProcessSpec(spec: PiProcessSpec): PiProcessSpec {
  if (!Object.isFrozen(spec.args)) Object.freeze(spec.args);
  if (!Object.isFrozen(spec.env)) Object.freeze(spec.env);
  return Object.freeze(spec);
}

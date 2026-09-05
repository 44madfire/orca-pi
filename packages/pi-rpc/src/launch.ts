/**
 * Pi RPC process-spec adapter (SNC1.2).
 *
 * Single-compiler rule: Orca-Pi profiles are compiled **only** by core's
 * `buildPiLaunch()` (`packages/core/src/pi/build-pi-launch.ts`, OP1.3/JEF-7).
 * That compiler owns the transport-neutral behavior issue #12 asks to reuse:
 * relative skill/extension/prompt paths resolved against `projectRoot`
 * (never the process cwd), and Pi's file-vs-literal `--system-prompt`
 * collision fallback (intended literal text that equals an existing file in
 * the launch cwd is materialized to a deterministic content-addressed temp
 * file so Pi's file branch reads the exact text).
 *
 * This module never compiles profiles and never reads prompt files. It adapts
 * an already-resolved spec to RPC transport: validate TUI-only exclusion,
 * append `--mode rpc` idempotently, and freeze. Pass core's output through:
 *
 * ```ts
 * import { buildPiLaunch } from "@orca-pi/core/dist/pi/index.js";
 * import { toPiRpcProcessSpec } from "@orca-pi/pi-rpc";
 *
 * const { spec } = await buildPiLaunch(profile, { projectRoot, cwd, env });
 * const rpc = toPiRpcProcessSpec(spec);
 * const conn = new PiRpcConnection({
 *   piCommand: rpc.command, piArgs: [...rpc.args], cwd: rpc.cwd, env: ...,
 * });
 * ```
 *
 * TUI-only behavior is explicitly excluded and never enters the transport:
 * `--theme`, `--use-theme`, `--no-themes`, `--tui-mode`, `--verbose`,
 * `--print`, `--export`, positional messages, `--models` cycling,
 * `--approve/--no-approve` trust prompts, and interactive `--continue` /
 * `--resume` pickers. Session resume over RPC uses the typed
 * `switch_session` command (see `connection.ts`), not CLI picker flags.
 */

/** Minimal shape of a resolved Pi invocation (e.g. core's `PiProcessSpec`). */
export interface ResolvedPiSpecLike {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

/** RPC-ready process invocation (structured, never a shell string). */
export interface PiRpcProcessSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

/** Flags that are TUI-only and must never enter the RPC transport. */
export const TUI_ONLY_FLAGS: ReadonlySet<string> = new Set([
  "--theme",
  "--use-theme",
  "--no-themes",
  "--tui-mode",
  "--verbose",
  "--print",
  "-p",
  "--export",
  "--models",
  "--approve",
  "--no-approve",
  "-a",
  "--continue",
  "-c",
  "--resume",
  "-r",
]);

function assertNoTuiFlags(args: readonly string[]): void {
  for (const arg of args) {
    const flag = arg.split("=")[0] as string;
    if (TUI_ONLY_FLAGS.has(flag) || TUI_ONLY_FLAGS.has(arg)) {
      throw new Error(
        `Pi RPC launch rejects TUI-only flag "${arg}". ` +
          `Use the typed RPC commands (e.g. switch_session) instead of CLI pickers/themes.`,
      );
    }
  }
}

/**
 * Adapt an already-resolved Pi spec (e.g. from core's `buildPiLaunch()`) to
 * RPC transport. Validates TUI exclusion, appends `--mode rpc` idempotently
 * (never twice), and freezes the result. Already-resolved values — absolute
 * `--skill`/`--extension` paths, collision-safe `--system-prompt` values
 * (literal or content-addressed temp path) — pass through untouched.
 */
export function toPiRpcProcessSpec(resolved: ResolvedPiSpecLike): PiRpcProcessSpec {
  if (!resolved || typeof resolved.command !== "string" || resolved.command === "") {
    throw new Error("toPiRpcProcessSpec requires a resolved spec with a non-empty command");
  }
  const args = [...(resolved.args ?? [])];
  assertNoTuiFlags(args);
  const hasMode = args.some((a, i) => a === "--mode" && args[i + 1] === "rpc");
  if (!hasMode) args.push("--mode", "rpc");

  return Object.freeze({
    command: resolved.command,
    args: Object.freeze([...args]) as readonly string[],
    ...(resolved.cwd !== undefined ? { cwd: resolved.cwd } : {}),
    ...(resolved.env !== undefined ? { env: Object.freeze({ ...resolved.env }) } : {}),
  });
}

/**
 * Resolve the environment base for spawning Pi.
 *
 * Transport-neutral overlay behavior (mirrors JEF-7: no hidden ambient
 * config): `overlay` entries override `base` (default `process.env`);
 * `undefined` values delete the key. Returns a fresh mutable record for
 * `spawn`. Callers should set an isolated `PI_CODING_AGENT_DIR` in tests so
 * global settings are never mutated.
 */
export function resolvePiRpcEnv(
  overlay: Readonly<Record<string, string | undefined>> = {},
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) delete out[key];
    else out[key] = value;
  }
  return out;
}

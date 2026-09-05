/**
 * Transport-neutral Pi RPC launch (SNC1.2).
 *
 * Mirrors the transport-neutral subset of the Orca-Pi launcher
 * (`packages/core/src/pi/build-pi-launch.ts`, OP1.3/JEF-7) without importing
 * Orca profile/journal types, so `@orca-pi/pi-rpc` stays usable by both the
 * external bridge and the future native adapter.
 *
 * Field → Pi flag mapping (long forms, fixed order — same as JEF-7):
 * - `provider` → `--provider <name>`
 * - `model` → `--model <id>`
 * - `thinking` → `--thinking <level>`
 * - `systemPrompt` → `--system-prompt <text>` (single argv element, never a
 *   shell string)
 * - `tools` → `--tools a,b,c`; explicit `[]` → `--no-tools`
 * - `excludeTools` → `--exclude-tools a,b,c` (when non-empty)
 * - `discoverSkills: false` → `--no-skills`, then `--skill <path>` per entry
 * - `discoverExtensions: false` → `--no-extensions`, then `--extension <p>`
 * - `promptTemplates: false` → `--no-prompt-templates`
 * - `contextFiles: false` → `--no-context-files`
 * - Session: `"ephemeral"` → `--no-session`; explicit `sessionDir` →
 *   `--session-dir <dir>`; explicit `sessionFile` → `--session <path>`;
 *   explicit `sessionName` → `--name <name>`
 * - Always appended: `--mode rpc` (last, so callers can see the transport).
 *
 * TUI-only behavior is explicitly excluded and never emitted here:
 * `--theme`, `--use-theme`, `--no-themes`, `--tui-mode`, `--verbose`,
 * `--print`, `--export`, positional messages, `--models` cycling,
 * `--approve/--no-approve` trust prompts, and interactive `--continue` /
 * `--resume` pickers. Session resume over RPC uses the typed
 * `switch_session` command (see `connection.ts`), not CLI picker flags.
 * Pass-through `extraArgs` is rejected when it contains any excluded flag
 * so TUI semantics cannot leak into the RPC transport silently.
 */

export interface PiRpcLaunchProfile {
  readonly provider?: string;
  readonly model?: string;
  readonly thinking?: string;
  /** Literal system prompt text (single argv element; no shell quoting). */
  readonly systemPrompt?: string;
  readonly tools?: readonly string[];
  readonly excludeTools?: readonly string[];
  readonly discoverSkills?: boolean;
  readonly skills?: readonly string[];
  readonly discoverExtensions?: boolean;
  readonly extensions?: readonly string[];
  /** Prompt-template discovery (default true; false → `--no-prompt-templates`). */
  readonly discoverPromptTemplates?: boolean;
  readonly contextFiles?: boolean;
  /** `"ephemeral"` → `--no-session`; otherwise sessions persist. */
  readonly session?: "ephemeral" | "persistent";
  readonly sessionDir?: string;
  readonly sessionFile?: string;
  readonly sessionName?: string;
}

export interface PiRpcLaunchOptions {
  /** Transport-neutral profile fields (see above). */
  readonly profile?: PiRpcLaunchProfile;
  /**
   * Working directory for the Pi process (preserved Orca worktree cwd).
   * Never derived from `process.cwd()` implicitly.
   */
  readonly cwd?: string;
  /**
   * Explicit environment overlay (e.g. `{ PI_CODING_AGENT_DIR: dir }`).
   * Never merged with `process.env` here — the spawner decides the base.
   */
  readonly env?: Readonly<Record<string, string>>;
  /** Pi executable (default `"pi"`, resolved via PATH at spawn). */
  readonly piCommand?: string;
  /**
   * Additional Pi argv *before* `--mode rpc`. Rejected when it contains
   * TUI-only flags (see `TUI_ONLY_FLAGS`).
   */
  readonly extraArgs?: readonly string[];
}

/** Resolved process invocation (structured, never a shell string). */
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
 * Build the deterministic `pi --mode rpc` argv for a transport-neutral
 * profile. Same input always yields the same structured output (frozen).
 */
export function buildPiRpcLaunch(options: PiRpcLaunchOptions = {}): PiRpcProcessSpec {
  const profile = options.profile ?? {};
  const args: string[] = [];

  if (profile.provider !== undefined && profile.provider !== "") {
    args.push("--provider", profile.provider);
  }
  if (profile.model !== undefined && profile.model !== "") {
    args.push("--model", profile.model);
  }
  if (profile.thinking !== undefined && profile.thinking !== "") {
    args.push("--thinking", profile.thinking);
  }
  if (profile.systemPrompt !== undefined && profile.systemPrompt !== "") {
    args.push("--system-prompt", profile.systemPrompt);
  }

  if (profile.tools !== undefined) {
    if (profile.tools.length === 0) {
      args.push("--no-tools");
    } else {
      args.push("--tools", [...profile.tools].join(","));
    }
  }
  if (profile.excludeTools !== undefined && profile.excludeTools.length > 0) {
    args.push("--exclude-tools", [...profile.excludeTools].join(","));
  }

  if (profile.discoverSkills === false) {
    args.push("--no-skills");
  }
  if (profile.skills !== undefined) {
    for (const skill of profile.skills) args.push("--skill", skill);
  }
  if (profile.discoverExtensions === false) {
    args.push("--no-extensions");
  }
  if (profile.extensions !== undefined) {
    for (const ext of profile.extensions) args.push("--extension", ext);
  }
  if (profile.discoverPromptTemplates === false) {
    args.push("--no-prompt-templates");
  }
  if (profile.contextFiles === false) {
    args.push("--no-context-files");
  }

  if (profile.session === "ephemeral") {
    args.push("--no-session");
  } else {
    if (profile.sessionDir !== undefined && profile.sessionDir !== "") {
      args.push("--session-dir", profile.sessionDir);
    }
    if (profile.sessionFile !== undefined && profile.sessionFile !== "") {
      args.push("--session", profile.sessionFile);
    }
  }
  if (profile.sessionName !== undefined && profile.sessionName !== "") {
    args.push("--name", profile.sessionName);
  }

  if (options.extraArgs !== undefined && options.extraArgs.length > 0) {
    assertNoTuiFlags(options.extraArgs);
    args.push(...options.extraArgs);
  }

  args.push("--mode", "rpc");

  return Object.freeze({
    command: options.piCommand ?? "pi",
    args: Object.freeze([...args]) as readonly string[],
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.env !== undefined ? { env: Object.freeze({ ...options.env }) } : {}),
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

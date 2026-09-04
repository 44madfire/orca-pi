/**
 * Deterministic Pi argv launcher (OP1.3 / JEF-7).
 *
 * Pure translation from a validated {@link ResolvedPiProfile} into a safe
 * Pi process invocation. Deterministic and unit-testable without starting
 * Pi: the only filesystem access is reading `systemPromptFile` (via an
 * injectable reader) relative to the documented `projectRoot`.
 *
 * Field → Pi flag mapping (long forms, fixed order):
 * - `provider` → `--provider <name>`
 * - `model` → `--model <id>`
 * - `thinking` → `--thinking <level>` (always; resolved fills the default)
 * - prompt text (inline or file-read) → `--system-prompt <text>`
 * - `tools` → `--tools a,b,c`; explicit `[]` → `--no-tools`
 * - `excludeTools` → `--exclude-tools a,b,c` (when non-empty)
 * - `discoverSkills: false` → `--no-skills`, then `--skill <abs>` per entry
 * - `discoverExtensions: false` → `--no-extensions`, then `--extension <abs>`
 * - `contextFiles: false` → `--no-context-files`
 * - `session: "ephemeral"` → `--no-session`; `"fresh"` emits no session
 *   flags and never emits resume flags
 *   (`--continue`/`--resume`/`--session`/`--fork`/…).
 *
 * Guarantees:
 * - Input is only a normalized `ResolvedPiProfile` — no YAML parsing here.
 * - Output is structured `{ command, args, cwd, env }` — never a shell
 *   string. Prompt text with quotes/newlines/metachars stays one argv
 *   element, so correctness never depends on shell quoting.
 * - Relative skill/extension/prompt paths resolve against `projectRoot`,
 *   never `process.cwd()`. `cwd` is the preserved Orca worktree cwd.
 * - Task text is never embedded — Orca `dispatch --inject` owns supervised
 *   task injection (JEF-8). No positional messages are emitted.
 * - Fresh sessions never auto-resume coordinator context.
 * - Display metadata (`displayName`, `description`, `name`, `extendsChain`)
 *   never affects argv.
 */

import type { ResolvedPiProfile } from "../profile/types.js";
import {
  PI_COMMAND,
  type PiProcessSpec,
} from "./process-spec.js";
import {
  joinProjectPath,
  resolvePromptText,
  type PromptFileReader,
} from "./resolve-prompt.js";

/** Options for {@link buildPiLaunch}. */
export interface BuildPiLaunchOptions {
  /**
   * Documented project/config root used to resolve relative paths
   * (`systemPromptFile`, `skills`, `extensions`) and to default `cwd`.
   * Should be the absolute worktree root selected by Orca.
   */
  readonly projectRoot: string;
  /**
   * Preserved Orca worktree cwd. Defaults to `projectRoot` when omitted.
   * Passed through untouched — never re-resolved against process cwd.
   */
  readonly cwd?: string;
  /**
   * Extra env overlay (v1: none). Defaults to `{}`. Never merged with
   * `process.env` implicitly — no hidden ambient configuration.
   */
  readonly env?: Readonly<Record<string, string>>;
  /** Injectable prompt-file reader (tests supply an in-memory map). */
  readonly readFile?: PromptFileReader;
}

/** Result of {@link buildPiLaunch}: structured spec plus prompt provenance. */
export interface PiLaunchResult {
  readonly spec: PiProcessSpec;
  readonly promptSource: "inline" | "file" | "none";
  readonly promptFileRelativePath?: string;
  readonly promptFileAbsolutePath?: string;
}

/**
 * Build the deterministic Pi invocation for a resolved profile.
 * Same input always yields the same structured output (frozen).
 * Throws {@link PiLaunchError} when `systemPromptFile` cannot be read.
 */
export async function buildPiLaunch(
  profile: ResolvedPiProfile,
  options: BuildPiLaunchOptions,
): Promise<PiLaunchResult> {
  const projectRoot = options.projectRoot;
  if (typeof projectRoot !== "string" || projectRoot.trim().length === 0) {
    throw new Error(
      `buildPiLaunch requires a non-empty projectRoot to resolve relative paths (got ${JSON.stringify(projectRoot)}). ` +
        `Pass the documented project/config root (usually the Orca worktree root).`,
    );
  }
  const cwd = options.cwd ?? projectRoot;
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new Error(
      `buildPiLaunch requires a non-empty cwd (got ${JSON.stringify(cwd)}). ` +
        `Pass the Orca worktree-selected cwd explicitly or omit it to default to projectRoot.`,
    );
  }

  const args: string[] = [];

  // 1-2. Provider / model (optional).
  if (profile.provider !== undefined) {
    args.push("--provider", profile.provider);
  }
  if (profile.model !== undefined) {
    args.push("--model", profile.model);
  }

  // 3. Thinking (always — resolved fills BUILTIN_PROFILE_DEFAULTS.thinking).
  args.push("--thinking", profile.thinking);

  // 4. Prompt (inline or file-read; absent when neither is set).
  const prompt = await resolvePromptText(profile, {
    projectRoot,
    readFile: options.readFile,
  });
  if (prompt.text !== undefined) {
    args.push("--system-prompt", prompt.text);
  }

  // 5. Tools: explicit [] disables all; undefined leaves Pi defaults alone.
  if (profile.tools !== undefined) {
    if (profile.tools.length === 0) {
      args.push("--no-tools");
    } else {
      args.push("--tools", profile.tools.join(","));
    }
  }

  // 6. Exclude-tools denylist (independent of the allowlist).
  if (profile.excludeTools !== undefined && profile.excludeTools.length > 0) {
    args.push("--exclude-tools", profile.excludeTools.join(","));
  }

  // 7. Skills: lean profiles visibly disable discovery first, then add
  // explicit resources. Paths resolve against projectRoot (absolute).
  if (!profile.discoverSkills) {
    args.push("--no-skills");
  }
  if (profile.skills !== undefined) {
    for (const skill of profile.skills) {
      args.push("--skill", joinProjectPath(projectRoot, skill));
    }
  }

  // 8. Extensions: same disable-then-add order as skills.
  if (!profile.discoverExtensions) {
    args.push("--no-extensions");
  }
  if (profile.extensions !== undefined) {
    for (const extension of profile.extensions) {
      args.push("--extension", joinProjectPath(projectRoot, extension));
    }
  }

  // 9. Context files (AGENTS.md / CLAUDE.md discovery).
  if (!profile.contextFiles) {
    args.push("--no-context-files");
  }

  // 10. Session policy. Ephemeral writes no session file; fresh starts a
  // new saved session by emitting *no* session flags at all — and never
  // resume flags (--continue/--resume/--session/--fork/--session-id/...),
  // so coordinator context can never leak in silently.
  if (profile.session === "ephemeral") {
    args.push("--no-session");
  }

  const env: Record<string, string> = { ...(options.env ?? {}) };

  const spec: PiProcessSpec = Object.freeze({
    command: PI_COMMAND,
    args: Object.freeze([...args]) as readonly string[],
    cwd,
    env: Object.freeze(env) as Readonly<Record<string, string>>,
  });

  return Object.freeze({
    spec,
    promptSource: prompt.source,
    ...(prompt.fileRelativePath !== undefined
      ? { promptFileRelativePath: prompt.fileRelativePath }
      : {}),
    ...(prompt.fileAbsolutePath !== undefined
      ? { promptFileAbsolutePath: prompt.fileAbsolutePath }
      : {}),
  });
}

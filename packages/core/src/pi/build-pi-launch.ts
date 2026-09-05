/**
 * Deterministic Pi argv launcher (OP1.3 / JEF-7).
 *
 * Pure translation from a validated {@link ResolvedPiProfile} into a safe
 * Pi process invocation. Deterministic and unit-testable without starting
 * Pi: the only filesystem access is reading `systemPromptFile` (via an
 * injectable reader) relative to the documented `projectRoot`, plus a
 * Pi-contract compatibility check against the launch `cwd` (see
 * `prompt-transport.ts`).
 *
 * Field → Pi flag mapping (long forms, fixed order):
 * - `provider` → `--provider <name>`
 * - `model` → `--model <id>`
 * - `thinking` → `--thinking <level>` (always; resolved fills the default)
 * - prompt text (inline or file-read) → `--system-prompt <text>` for the
 *   common non-colliding case; on Pi file-or-text collision (intended text
 *   equals an existing file in `cwd`) the text is materialized to a
 *   deterministic content-addressed temp file and the temp path is passed
 *   instead, so Pi's file branch reads the exact intended text.
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
 * - Task text is never embedded — Orca supervised attachment
 *   (`worker-start --terminal`) owns task injection (JEF-8). No positional
 *   messages are emitted.
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
  PiLaunchError,
  resolvePromptText,
  type PromptFileReader,
} from "./resolve-prompt.js";
import {
  resolvePromptArgValue,
  type PiPromptTransport,
  type PiPromptTransportFs,
} from "./prompt-transport.js";

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
   * Also used for Pi file-or-text collision detection (see
   * `prompt-transport.ts`): Pi resolves relative `--system-prompt` values
   * against its process cwd, which will be this `cwd` at spawn time.
   */
  readonly cwd?: string;
  /**
   * Extra env overlay (v1: none). Defaults to `{}`. Never merged with
   * `process.env` implicitly — no hidden ambient configuration.
   */
  readonly env?: Readonly<Record<string, string>>;
  /** Injectable prompt-file reader (tests supply an in-memory map). */
  readonly readFile?: PromptFileReader;
  /**
   * Injectable Pi file-or-text collision probe (tests supply in-memory fs).
   * Defaults to real `fs.stat` (regular-file check). Rarely needs override
   * except in contract tests where `cwd` is virtual.
   */
  readonly existsAsFile?: PiPromptTransportFs["existsAsFile"];
  /** Injectable temp-file writer for collision fallback (tests stub). */
  readonly writeFile?: PiPromptTransportFs["writeFile"];
  /** Injectable mkdir -p for temp dir (tests stub). */
  readonly mkdirp?: PiPromptTransportFs["mkdirp"];
  /**
   * Override temp dir for collision fallback (tests use an isolated dir).
   * Defaults to `os.tmpdir()`.
   */
  readonly tmpdir?: string;
}

/** Result of {@link buildPiLaunch}: structured spec plus prompt provenance. */
export interface PiLaunchResult {
  readonly spec: PiProcessSpec;
  readonly promptSource: "inline" | "file" | "none";
  readonly promptFileRelativePath?: string;
  readonly promptFileAbsolutePath?: string;
  /**
   * How the prompt travels to Pi: `"literal"` (common — argv carries the
   * exact text), `"temp-file"` (collision fallback — argv carries a
   * deterministic temp path whose file contains the exact text), or
   * `"none"` (no prompt).
   */
  readonly promptTransport: PiPromptTransport;
  /** Temp file path when `promptTransport === "temp-file"`. */
  readonly promptTempPath?: string;
  /**
   * Original intended prompt text (for redacted inspect display). Present
   * whenever a prompt exists, even when `promptTransport === "temp-file"`
   * (where `spec.args` carries the temp path, not the text).
   */
  readonly promptText?: string;
}

/**
 * Build the deterministic Pi invocation for a resolved profile.
 * Same input always yields the same structured output (frozen) for the
 * common non-colliding case; colliding prompts reuse a deterministic
 * content-addressed temp path for identical `(profile, text, tmpdir)`.
 * Throws {@link PiLaunchError} when `systemPromptFile` cannot be read or
 * when temp materialization fails.
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

  // Defense-in-depth (OP1.9 / JEF-15): reviewer identities never launch
  // with source-write tools, even if a caller bypasses resolveProfile.
  // The authoritative guard lives in resolveProfile; this mirrors it so
  // direct PiProcessSpec construction cannot smuggle edit/write in.
  if (profile.githubIdentity === "reviewer" && profile.tools !== undefined) {
    const offending = profile.tools.filter((tool) => tool === "edit" || tool === "write");
    if (offending.length > 0) {
      throw new Error(
        `Pi profile "${profile.name}" uses reviewer githubIdentity but resolves with source-write tools (${offending.map((tool) => `"${tool}"`).join(", ")}). ` +
          `The reviewer GitHub App holds Contents: read only — remove "edit"/"write" from this profile.`,
      );
    }
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
  // Pi file-or-text contract: pass literal unless the text equals an
  // existing file in `cwd`, in which case materialize to temp so Pi's file
  // branch reads the exact intended text (see prompt-transport.ts).
  const prompt = await resolvePromptText(profile, {
    projectRoot,
    readFile: options.readFile,
  });
  let promptTransport: PiPromptTransport = "none";
  let promptTempPath: string | undefined;
  let promptArgValue: string | undefined;
  if (prompt.text !== undefined) {
    const transportFs: PiPromptTransportFs = {
      ...(options.existsAsFile !== undefined ? { existsAsFile: options.existsAsFile } : {}),
      ...(options.writeFile !== undefined ? { writeFile: options.writeFile } : {}),
      ...(options.mkdirp !== undefined ? { mkdirp: options.mkdirp } : {}),
    };
    let resolved: Awaited<ReturnType<typeof resolvePromptArgValue>>;
    try {
      resolved = await resolvePromptArgValue(prompt.text, {
        profileName: profile.name,
        cwd,
        fs: transportFs,
        ...(options.tmpdir !== undefined ? { tmpdir: options.tmpdir } : {}),
      });
    } catch (error) {
      throw new PiLaunchError({
        code: "prompt-materialization-failed",
        profileName: profile.name,
        promptFile: profile.systemPromptFile ?? "(inline prompt)",
        resolvedPath: options.tmpdir ?? "(tmpdir)",
        message:
          `Pi profile "${profile.name}" could not materialize an ambiguous prompt ` +
          `(intended text equals an existing file in cwd "${cwd}"): ` +
          `${error instanceof Error ? error.message : String(error)}. ` +
          `Check temp-dir permissions or rephrase the prompt to avoid the collision.`,
      });
    }
    promptTransport = resolved.transport;
    promptTempPath = resolved.tempPath;
    promptArgValue = resolved.argvValue;
    if (promptArgValue !== undefined) {
      args.push("--system-prompt", promptArgValue);
    }
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
    promptTransport,
    ...(promptTempPath !== undefined ? { promptTempPath } : {}),
    ...(prompt.text !== undefined ? { promptText: prompt.text } : {}),
  });
}

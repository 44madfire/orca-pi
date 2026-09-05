/**
 * Pi agent profile types (OP1.2 / JEF-6).
 *
 * Declarative, role-specialized Pi worker descriptions. The runtime schema
 * lives in `schema.ts`; these are the static shapes derived from it.
 *
 * Precedence (low → high, later wins; arrays replace in v1):
 *   1. built-in defaults (`BUILTIN_PROFILE_DEFAULTS`)
 *   2. user/global config (`$PI_CODING_AGENT_DIR/profiles.yaml`)
 *   3. project config (`<projectRoot>/.pi/profiles.yaml`)
 *   4. inherited profile (`extends` chain, root first)
 *   5. selected profile
 *   6. explicit CLI overrides
 *
 * Display metadata (`displayName`, `description`) never affects execution
 * semantics — the deterministic launcher (JEF-7) must ignore it.
 */

/** Pi `--thinking` levels. (Pi CLI also accepts a `:<level>` suffix in `--model`; profiles reject the suffix so `thinking` stays canonical.) */
export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/**
 * Session policy for a profiled run.
 *
 * - `"ephemeral"` maps to Pi `--no-session` (no session file is written).
 * - `"fresh"` starts a new saved session without passing any resume flags
 *   (`--continue`, `--resume`, `--session`, `--fork`).
 *
 * v1 profiles can never silently resume coordinator/parent context: resume
 * requires an explicit CLI override (precedence level 6), never profile
 * config alone.
 */
export type SessionMode = "ephemeral" | "fresh";

/** Raw (unvalidated) profile fields as they appear in YAML/JSON config. */
export interface PiProfileInput {
  /** Single-parent inheritance (v1). Must name another profile. */
  extends?: string;
  /** Pi `--provider` value (e.g. `"anthropic"`, `"openai-codex"`). */
  provider?: string;
  /**
   * Pi single `--model` ID (supports `provider/id` and Pi exact/fuzzy
   * matching; variant colons such as `openrouter/foo:exacto` are allowed).
   * Glob characters (`*`, `?`) belong to Pi's separate `--models` scope and
   * are rejected, as is a terminal recognized thinking suffix (`:high`,
   * `:low`, ...); use the separate `thinking` field so JEF-7 never emits a
   * contradictory `--model X:high --thinking Y`.
   */
  model?: string;
  /** Pi `--thinking` level. */
  thinking?: ThinkingLevel;
  /** Inline system prompt (maps to Pi `--system-prompt`). */
  systemPrompt?: string;
  /**
   * Project-relative prompt file (e.g. `.pi/agents/scout.md`).
   * Mutually exclusive with `systemPrompt`. The launcher reads the file at
   * launch time; listing/resolving profiles never reads file contents.
   */
  systemPromptFile?: string;
  /** Pi `--tools` allowlist (built-in, extension, and custom tool names). */
  tools?: string[];
  /** Pi `--exclude-tools` denylist (same name rules as `tools`). */
  excludeTools?: string[];
  /** Explicit skill sources (repeatable Pi `--skill`); project-relative paths. */
  skills?: string[];
  /** Explicit extension sources (repeatable Pi `-e`); project-relative paths. */
  extensions?: string[];
  /** When false (default), the launcher passes Pi `--no-context-files`. */
  contextFiles?: boolean;
  /** When false (default), the launcher passes Pi `--no-skills`. */
  discoverSkills?: boolean;
  /** When false (default), the launcher passes Pi `--no-extensions`. */
  discoverExtensions?: boolean;
  /** Session policy. Defaults to `"ephemeral"` (never resumes). */
  session?: SessionMode;
  /**
   * Logical GitHub automation identity (OP1.9 / JEF-15).
   *
   * Names a credential slot (`"worker"`, `"reviewer"`, or a custom
   * identity) resolved at launch/runtime through a secret provider or
   * helper process — never a secret itself. Keeps GitHub actor selection
   * orthogonal to Pi model/tools/skills. The deterministic Pi launcher
   * (JEF-7) ignores it; GitHub helpers use it to select tokens.
   */
  githubIdentity?: string;
  /** Display-only label. Never affects execution semantics. */
  displayName?: string;
  /** Display-only description. Never affects execution semantics. */
  description?: string;
}

/** Raw top-level document shape: `{ profiles: { <name>: <profile> } }`. */
export interface PiProfilesDocumentInput {
  profiles?: Record<string, PiProfileInput>;
}

/**
 * Validated single profile. Paths are normalized project-relative POSIX
 * paths (no leading `./`, no absolute paths, no `..` escapes). All strings
 * are literal — parsing never executes shell or interpolates commands.
 */
export interface ValidatedPiProfile {
  extends?: string;
  provider?: string;
  model?: string;
  thinking?: ThinkingLevel;
  systemPrompt?: string;
  systemPromptFile?: string;
  tools?: string[];
  excludeTools?: string[];
  skills?: string[];
  extensions?: string[];
  contextFiles?: boolean;
  discoverSkills?: boolean;
  discoverExtensions?: boolean;
  session?: SessionMode;
  githubIdentity?: string;
  displayName?: string;
  description?: string;
  /** Which config source last defined this profile (for diagnostics). */
  sourceLabel?: string;
}

/** Validated document: profile map plus the source it was read from. */
export interface ValidatedProfilesDocument {
  profiles: Record<string, ValidatedPiProfile>;
  sourceLabel: string;
}

/**
 * Explicit CLI overrides (precedence level 6). Same fields as a profile
 * except `extends` (overrides apply after inheritance, so re-parenting via
 * CLI is rejected) — display metadata is accepted but ignored by execution.
 */
export type ProfileOverrides = Omit<PiProfileInput, "extends">;

/**
 * Normalized, immutable resolved profile — the single input JEF-7's
 * deterministic launcher uses to build Pi argv. All defaults are filled,
 * inheritance is flattened, and paths are normalized project-relative.
 * The object and its arrays are `Object.freeze`d.
 */
export interface ResolvedPiProfile {
  readonly name: string;
  /** Inheritance chain, root parent first, ending with `name`. */
  readonly extendsChain: readonly string[];
  readonly provider?: string;
  readonly model?: string;
  readonly thinking: ThinkingLevel;
  readonly systemPrompt?: string;
  readonly systemPromptFile?: string;
  readonly tools?: readonly string[];
  readonly excludeTools?: readonly string[];
  readonly skills?: readonly string[];
  readonly extensions?: readonly string[];
  readonly contextFiles: boolean;
  readonly discoverSkills: boolean;
  readonly discoverExtensions: boolean;
  readonly session: SessionMode;
  readonly githubIdentity?: string;
  readonly displayName?: string;
  readonly description?: string;
}

/** Built-in defaults (precedence level 1) applied to every resolved profile. */
export interface BuiltinProfileDefaults {
  readonly thinking: ThinkingLevel;
  readonly contextFiles: boolean;
  readonly discoverSkills: boolean;
  readonly discoverExtensions: boolean;
  readonly session: SessionMode;
}

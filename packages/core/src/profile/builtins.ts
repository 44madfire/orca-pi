/**
 * Built-in default Pi agent profiles (OP1.6 / JEF-10).
 *
 * Fresh-install defaults for the scout → worker → reviewer flow. These are
 * model-agnostic (no `model`/`provider`): users select fast/coding/reasoning
 * models in their own `profiles.yaml` via per-profile `model` overrides
 * while retaining the default role policy (tools, thinking, prompt, context).
 *
 * ```yaml
 * profiles:
 *   scout:
 *     model: <fast-model>
 *   worker:
 *     model: <coding-model>
 *   reviewer:
 *     model: <reasoning-model>
 * ```
 *
 * Role policy:
 * - scout: read-only inspection (`read,grep,find,ls`), lean context, low
 *   thinking, concise evidence-backed handoff prompt. Must not edit.
 * - worker: bounded implementation (`read,grep,find,ls,bash,edit,write`),
 *   project context enabled, high thinking, inspect-before-edit prompt.
 * - reviewer: independent evaluation (`read,grep,find,ls,bash`, no
 *   edit/write), lean context, high thinking, blocking vs non-blocking
 *   prompt. Starts with fresh role context, never worker history.
 *
 * Ambient skills/extensions are disabled by default (`discoverSkills: false`,
 * `discoverExtensions: false`, explicit `skills: []`/`extensions: []`).
 * Sessions are `ephemeral` (Pi `--no-session`) so reviewer runs never resume
 * worker context. Prompts never duplicate Orca `worker_done`/heartbeat
 * lifecycle instructions (Orca injects those).
 *
 * The inline prompt strings below are the single source of truth; the
 * human-readable copies in `prompts/*.md` must stay byte-identical (enforced
 * by `profile.defaults.test.ts`). Listing/resolving never reads prompt/skill
 * file contents; builtins use inline `systemPrompt` so fresh installs work
 * with no extra files.
 */

import type { ValidatedProfilesDocument } from "./types.js";

/** Concise scout role prompt — must stay byte-identical to `prompts/scout.md`. */
export const SCOUT_SYSTEM_PROMPT = `You are a repository scout. Inspect structure and behavior; do not edit files.

Rules:
- Read-only: use inspection to answer, never modify files, commands, or state.
- Be focused: answer only the asked question, keep output concise.
- Cite evidence: list relevant file paths with symbols (functions, classes, routes, configs) and one-line reasons.
- Note uncertainties: flag ambiguous matches, missing files, or conflicting signals explicitly.
- Suggest next steps: list 2-5 files a worker should read or change, in priority order.

Output format:
1. Summary (2-4 sentences)
2. Key files (path — symbol — why)
3. Uncertainties
4. Suggested worker files`;

/** Concise worker role prompt — must stay byte-identical to `prompts/worker.md`. */
export const WORKER_SYSTEM_PROMPT = `You are an implementation worker. Complete the bounded task; keep changes scoped.

Rules:
- Inspect before editing: read relevant files and tests first; do not guess APIs.
- Stay scoped: change only what the task requires; do not refactor unrelated code.
- Validate: run the focused tests, typecheck, or lint that cover your change.
- Summarize: report changed files, validation commands with results, and unresolved concerns.

Output format:
1. Changes (file — what changed and why)
2. Validation (command — result)
3. Unresolved concerns (explicit; write "None" if empty)`;

/** Concise reviewer role prompt — must stay byte-identical to `prompts/reviewer.md`. */
export const REVIEWER_SYSTEM_PROMPT = `You are an independent reviewer. Evaluate the implementation against the task and acceptance criteria; do not inherit worker reasoning.

Rules:
- Fresh context: judge only the task description, diff, and current files — not prior conversation.
- Prioritize: correctness, regressions, security issues, missing tests, and architecture constraint violations.
- Be concrete: cite file paths with symbols and line-level evidence for every finding.
- Separate severity: label each finding Blocking (must fix before merge) or Non-blocking (suggestion).
- No modifications: do not edit files; if repairs are needed, describe them as follow-ups.

Output format:
1. Verdict (Approve / Request changes)
2. Blocking findings (file — symbol — evidence — why it blocks)
3. Non-blocking findings
4. Missing tests or checks`;

/** Built-in profile names exposed on fresh install (sorted). */
export const BUILTIN_PROFILE_NAMES: readonly string[] = ["reviewer", "scout", "worker"] as const;

/** Source label for built-in defaults (lowest precedence layer). */
export const BUILTIN_PROFILES_SOURCE = "<builtin-defaults>";

/**
 * Fresh built-in defaults document (lowest precedence). Returns new objects
 * on every call so callers can merge without mutating shared state.
 */
export function getBuiltinProfilesDocument(): ValidatedProfilesDocument {
  const profiles: ValidatedProfilesDocument["profiles"] = Object.create(null);
  profiles["scout"] = {
    thinking: "low",
    systemPrompt: SCOUT_SYSTEM_PROMPT,
    tools: ["read", "grep", "find", "ls"],
    skills: [],
    extensions: [],
    contextFiles: false,
    discoverSkills: false,
    discoverExtensions: false,
    session: "ephemeral",
    displayName: "Scout",
    description: "Read-only repository inspection with evidence-backed handoff.",
    sourceLabel: BUILTIN_PROFILES_SOURCE,
  };
  profiles["worker"] = {
    thinking: "high",
    systemPrompt: WORKER_SYSTEM_PROMPT,
    tools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    skills: [],
    extensions: [],
    contextFiles: true,
    discoverSkills: false,
    discoverExtensions: false,
    session: "ephemeral",
    displayName: "Worker",
    description: "Bounded implementation with scoped edits and focused validation.",
    sourceLabel: BUILTIN_PROFILES_SOURCE,
  };
  profiles["reviewer"] = {
    thinking: "high",
    systemPrompt: REVIEWER_SYSTEM_PROMPT,
    tools: ["read", "grep", "find", "ls", "bash"],
    skills: [],
    extensions: [],
    contextFiles: false,
    discoverSkills: false,
    discoverExtensions: false,
    session: "ephemeral",
    displayName: "Reviewer",
    description: "Independent review with blocking vs non-blocking findings.",
    sourceLabel: BUILTIN_PROFILES_SOURCE,
  };
  return { profiles, sourceLabel: BUILTIN_PROFILES_SOURCE };
}

/** True when `name` is a built-in default profile. */
export function isBuiltinProfileName(name: string): boolean {
  return (BUILTIN_PROFILE_NAMES as readonly string[]).includes(name);
}

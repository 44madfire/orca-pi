/**
 * Runtime validator for Pi agent profiles (OP1.2 / JEF-6).
 *
 * Dependency-free (no Zod — `@orca-pi/core` ships zero runtime deps besides
 * the YAML parser in `load.ts`) so the thin Orca plugin and companion CLI
 * share one validator without Electron/Orca Desktop coupling.
 *
 * Design notes:
 * - Strict objects: unknown fields are rejected with an actionable message
 *   that also reminds authors profiles must never contain secrets/API keys.
 * - Strings are literal: no shell execution, no `$VAR`/backtick
 *   interpolation, no `~` expansion. Project-relative path fields reject
 *   absolute paths, URLs, and `..` escapes.
 * - `tools` validates Pi built-ins where practical while allowing
 *   custom/extension tools that match the same safe name grammar.
 * - `systemPrompt` and `systemPromptFile` are mutually exclusive within a
 *   single document entry (inheritance clearing is handled in `resolve.ts`).
 */

import type {
  BuiltinProfileDefaults,
  PiProfileInput,
  SessionMode,
  ThinkingLevel,
  ValidatedPiProfile,
  ValidatedProfilesDocument,
} from "./types.js";

/** Pi `--thinking` levels in increasing reasoning order. */
export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** Pi built-in tool names (`pi --help` → "Built-in Tool Names"). */
export const BUILTIN_TOOLS: readonly string[] = [
  "read",
  "bash",
  "powershell",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;

/** Session modes (v1): never resume via profile config alone. */
export const SESSION_MODES: readonly SessionMode[] = [
  "ephemeral",
  "fresh",
] as const;

/** Built-in defaults (precedence level 1): lean, non-resuming, explicit opt-in. */
export const BUILTIN_PROFILE_DEFAULTS: BuiltinProfileDefaults = {
  thinking: "medium",
  contextFiles: false,
  discoverSkills: false,
  discoverExtensions: false,
  session: "ephemeral",
} as const;

/** Profile names: portable, filesystem/CLI-safe identifiers. */
export const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
export const MAX_PROFILE_NAME_LENGTH = 64;

/** Pi provider names (e.g. `anthropic`, `openai-codex`, `opencode-go`). */
export const PROVIDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
export const MAX_PROVIDER_LENGTH = 64;

/**
 * Pi `--model` patterns/IDs. Supports `provider/id`, `:<thinking>` suffixes,
 * and glob/fuzzy patterns (`anthropic/*`, `*sonnet*`). Allows alphanumerics
 * plus `/ - _ . * : + @ ? ~` in any position — everything else (whitespace,
 * shell metacharacters such as `; | & $ ` ' " \\ ! ( ) < >`) is rejected
 * so a model string can never inject shell.
 */
export const MODEL_PATTERN: RegExp = new RegExp("^[A-Za-z0-9._/*:@?+~-]+$");
export const MAX_MODEL_LENGTH = 256;

/** Tool names: built-ins plus custom/extension tools share one safe grammar. */
export const TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
export const MAX_TOOL_NAME_LENGTH = 64;

export const MAX_SYSTEM_PROMPT_LENGTH = 50_000;
export const MAX_PATH_LENGTH = 512;
export const MAX_DISPLAY_NAME_LENGTH = 100;
export const MAX_DESCRIPTION_LENGTH = 1000;

const PROFILE_FIELDS: readonly (keyof PiProfileInput)[] = [
  "extends",
  "provider",
  "model",
  "thinking",
  "systemPrompt",
  "systemPromptFile",
  "tools",
  "excludeTools",
  "skills",
  "extensions",
  "contextFiles",
  "discoverSkills",
  "discoverExtensions",
  "session",
  "displayName",
  "description",
] as const;

const PROFILE_FIELD_SET = new Set<string>(PROFILE_FIELDS);

export interface ProfileIssue {
  /** Dotted path within the document (e.g. `profiles.scout.tools[2]`). */
  path: string;
  message: string;
}

/**
 * Actionable pre-launch error: every issue carries a dotted `path` and a
 * message that states the expected shape plus the offending value/source.
 */
export class ProfileValidationError extends Error {
  readonly issues: ProfileIssue[];
  readonly sourceLabel: string;

  constructor(sourceLabel: string, issues: ProfileIssue[]) {
    const lines = issues.map((issue) => `  - ${issue.path}: ${issue.message}`);
    super(
      `Invalid Pi profile config in ${sourceLabel} (${issues.length} issue${issues.length === 1 ? "" : "s"}):\n${lines.join("\n")}`,
    );
    this.name = "ProfileValidationError";
    this.issues = issues;
    this.sourceLabel = sourceLabel;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function preview(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    if (typeof text === "string" && text.length > 120) {
      return `${text.slice(0, 117)}...`;
    }
    return String(text);
  } catch {
    return String(value);
  }
}

/**
 * Normalize a project-relative path without touching the filesystem.
 * Returns the normalized POSIX path, or appends an issue and returns
 * `undefined` when the value is not a safe project-relative path.
 *
 * Rejects: non-strings, empty/blank, over-long, NUL/control chars,
 * backslashes (use `/`), absolute paths (POSIX + Windows `C:/` + `\\`),
 * `~` prefixes (no shell expansion), URL schemes (`npm://`, `git://`),
 * and any `..` segment that escapes the project root. Normalizes away
 * redundant `./`, `//`, and interior `.` segments.
 */
export function normalizeProjectRelativePath(
  value: unknown,
  fieldPath: string,
  issues: ProfileIssue[],
): string | undefined {
  if (typeof value !== "string") {
    issues.push({
      path: fieldPath,
      message: `expected a project-relative path string (e.g. ".pi/skills/repo-search"), got ${preview(value)}.`,
    });
    return undefined;
  }
  if (value.length === 0 || value.trim().length === 0) {
    issues.push({
      path: fieldPath,
      message: "expected a non-empty project-relative path (e.g. \".pi/skills/repo-search\").",
    });
    return undefined;
  }
  if (value.length > MAX_PATH_LENGTH) {
    issues.push({
      path: fieldPath,
      message: `path exceeds ${MAX_PATH_LENGTH} characters; keep profile paths short and project-relative.`,
    });
    return undefined;
  }
  // eslint-disable-next-line no-control-regex -- intentional NUL/control rejection for paths
  if (/[\0-\x1f\x7f]/.test(value)) {
    issues.push({
      path: fieldPath,
      message: "path contains control characters; use a plain project-relative path.",
    });
    return undefined;
  }
  if (value.includes("\\")) {
    issues.push({
      path: fieldPath,
      message: `use forward slashes for project-relative paths (got ${preview(value)}).`,
    });
    return undefined;
  }
  const trimmed = value.trim();
  if (
    trimmed.startsWith("/") ||
    /^[A-Za-z]:\//.test(trimmed) ||
    /^[A-Za-z]:$/.test(trimmed) ||
    trimmed.startsWith("\\\\") ||
    trimmed === "~" ||
    trimmed.startsWith("~/")
  ) {
    issues.push({
      path: fieldPath,
      message: `expected a project-relative path (e.g. ".pi/skills/repo-search"), got absolute or home-relative ${preview(value)}. Profiles must not reference absolute paths so configs stay portable.`,
    });
    return undefined;
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed)) {
    issues.push({
      path: fieldPath,
      message: `expected a project-relative path, got URL-like ${preview(value)}. Use a project-relative path (e.g. ".pi/skills/repo-search").`,
    });
    return undefined;
  }
  const normalized = posixNormalize(trimmed);
  if (normalized === "" || normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../") || normalized.endsWith("/..")) {
    issues.push({
      path: fieldPath,
      message: `path escapes the project root (got ${preview(value)}). Keep paths inside the project (e.g. ".pi/skills/repo-search").`,
    });
    return undefined;
  }
  // Split-and-check each segment for `..` leftovers and empties.
  const segments = normalized.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      issues.push({
        path: fieldPath,
        message: `path escapes the project root (got ${preview(value)}). Keep paths inside the project.`,
      });
      return undefined;
    }
  }
  return normalized;
}

/** Minimal POSIX normalization (no filesystem access, no `node:path`). */
function posixNormalize(input: string): string {
  const isAbsolute = input.startsWith("/");
  const parts = input.split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (stack.length > 0 && stack[stack.length - 1] !== "..") {
        stack.pop();
      } else {
        stack.push("..");
      }
      continue;
    }
    stack.push(part);
  }
  const result = stack.join("/");
  if (isAbsolute) return `/${result}`;
  return result;
}

function validateNameList(
  value: unknown,
  fieldPath: string,
  kind: "tools" | "excludeTools",
  issues: ProfileIssue[],
): string[] | undefined {
  if (!Array.isArray(value)) {
    issues.push({
      path: fieldPath,
      message: `expected an array of tool names (e.g. ["read", "grep"]), got ${preview(value)}.`,
    });
    return undefined;
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  value.forEach((entry, index) => {
    const entryPath = `${fieldPath}[${index}]`;
    if (typeof entry !== "string" || entry.length === 0) {
      issues.push({
        path: entryPath,
        message: `expected a tool name (built-ins: ${BUILTIN_TOOLS.join(", ")}; custom/extension tools must match ${TOOL_NAME_PATTERN}), got ${preview(entry)}.`,
      });
      return;
    }
    if (entry.length > MAX_TOOL_NAME_LENGTH || !TOOL_NAME_PATTERN.test(entry)) {
      issues.push({
        path: entryPath,
        message: `invalid tool name ${preview(entry)}: use letters, digits, "-" or "_" (built-ins: ${BUILTIN_TOOLS.join(", ")}). Custom/extension tools are allowed when they match the same pattern.`,
      });
      return;
    }
    if (seen.has(entry)) {
      duplicates.add(entry);
    }
    seen.add(entry);
    out.push(entry);
  });
  for (const duplicate of duplicates) {
    issues.push({
      path: fieldPath,
      message: `duplicate tool name ${preview(duplicate)}; list each tool once (arrays replace parents in v1, they never merge).`,
    });
  }
  return duplicates.size > 0 ? undefined : out;
}

function validatePathList(
  value: unknown,
  fieldPath: string,
  example: string,
  issues: ProfileIssue[],
): string[] | undefined {
  if (!Array.isArray(value)) {
    issues.push({
      path: fieldPath,
      message: `expected an array of project-relative paths (e.g. ["${example}"]), got ${preview(value)}.`,
    });
    return undefined;
  }
  const out: string[] = [];
  let failed = false;
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  value.forEach((entry, index) => {
    const entryPath = `${fieldPath}[${index}]`;
    const normalized = normalizeProjectRelativePath(entry, entryPath, issues);
    if (normalized === undefined) {
      failed = true;
      return;
    }
    if (seen.has(normalized)) {
      duplicates.add(normalized);
    }
    seen.add(normalized);
    out.push(normalized);
  });
  for (const duplicate of duplicates) {
    issues.push({
      path: fieldPath,
      message: `duplicate path ${preview(duplicate)}; list each path once (arrays replace parents in v1, they never merge).`,
    });
    failed = true;
  }
  return failed ? undefined : out;
}

function validateBoolean(
  value: unknown,
  fieldPath: string,
  issues: ProfileIssue[],
): boolean | undefined {
  if (typeof value !== "boolean") {
    issues.push({
      path: fieldPath,
      message: `expected a boolean true/false (unquoted in YAML), got ${preview(value)}.`,
    });
    return undefined;
  }
  return value;
}

interface SingleProfileResult {
  profile?: ValidatedPiProfile;
  failed: boolean;
}

function validateSingleProfile(
  name: string,
  raw: unknown,
  basePath: string,
  issues: ProfileIssue[],
  options: { allowExtends: boolean },
): SingleProfileResult {
  if (!isRecord(raw)) {
    issues.push({
      path: basePath,
      message: `expected an object with profile fields (${PROFILE_FIELDS.join(", ")}), got ${preview(raw)}.`,
    });
    return { failed: true };
  }
  let failed = false;
  const profile: ValidatedPiProfile = {};

  for (const key of Object.keys(raw)) {
    if (!PROFILE_FIELD_SET.has(key)) {
      issues.push({
        path: `${basePath}.${key}`,
        message: `unknown field ${preview(key)}: expected one of ${PROFILE_FIELDS.join(", ")}. Profiles must never contain secrets/API keys — remove this field (typo?) and keep credentials in env vars or Pi auth storage.`,
      });
      failed = true;
    }
  }
  if (failed) {
    // Continue collecting field-level issues for actionable output.
  }

  const get = (field: keyof PiProfileInput): unknown => raw[field];

  // extends
  const extendsRaw = get("extends");
  if (extendsRaw !== undefined) {
    if (!options.allowExtends) {
      issues.push({
        path: `${basePath}.extends`,
        message: `"extends" is not allowed here: CLI overrides apply after inheritance, so re-parenting via overrides is rejected. Edit the profile's "extends" in config instead.`,
      });
      failed = true;
    } else if (typeof extendsRaw !== "string" || !PROFILE_NAME_PATTERN.test(extendsRaw) || extendsRaw.length > MAX_PROFILE_NAME_LENGTH) {
      issues.push({
        path: `${basePath}.extends`,
        message: `expected a parent profile name matching ${PROFILE_NAME_PATTERN} (1-${MAX_PROFILE_NAME_LENGTH} chars), got ${preview(extendsRaw)}. v1 supports a single parent; unknown parents and cycles are rejected at resolve time.`,
      });
      failed = true;
    } else if (extendsRaw === name) {
      issues.push({
        path: `${basePath}.extends`,
        message: `profile ${preview(name)} cannot extend itself; pick a different parent or remove "extends".`,
      });
      failed = true;
    } else {
      profile.extends = extendsRaw;
    }
  }

  // provider
  const providerRaw = get("provider");
  if (providerRaw !== undefined) {
    if (typeof providerRaw !== "string" || providerRaw.length === 0 || providerRaw.length > MAX_PROVIDER_LENGTH || !PROVIDER_PATTERN.test(providerRaw)) {
      issues.push({
        path: `${basePath}.provider`,
        message: `expected a Pi provider name matching ${PROVIDER_PATTERN} (e.g. "anthropic", "openai-codex"), got ${preview(providerRaw)}.`,
      });
      failed = true;
    } else {
      profile.provider = providerRaw;
    }
  }

  // model
  const modelRaw = get("model");
  if (modelRaw !== undefined) {
    if (typeof modelRaw !== "string" || modelRaw.length === 0 || modelRaw.length > MAX_MODEL_LENGTH || !MODEL_PATTERN.test(modelRaw)) {
      issues.push({
        path: `${basePath}.model`,
        message: `expected a Pi model ID/pattern (e.g. "anthropic/claude-sonnet", "openai/gpt-4o", "sonnet:high"), got ${preview(modelRaw)}. Model strings are passed literally to Pi --model and must not contain whitespace or shell metacharacters.`,
      });
      failed = true;
    } else {
      profile.model = modelRaw;
    }
  }

  // thinking
  const thinkingRaw = get("thinking");
  if (thinkingRaw !== undefined) {
    if (typeof thinkingRaw !== "string" || !(THINKING_LEVELS as readonly string[]).includes(thinkingRaw)) {
      issues.push({
        path: `${basePath}.thinking`,
        message: `expected one of ${THINKING_LEVELS.map((level) => preview(level)).join(", ")} (Pi --thinking), got ${preview(thinkingRaw)}.`,
      });
      failed = true;
    } else {
      profile.thinking = thinkingRaw as ThinkingLevel;
    }
  }

  // systemPrompt / systemPromptFile (mutually exclusive)
  const systemPromptRaw = get("systemPrompt");
  const systemPromptFileRaw = get("systemPromptFile");
  if (systemPromptRaw !== undefined) {
    if (typeof systemPromptRaw !== "string" || systemPromptRaw.length === 0) {
      issues.push({
        path: `${basePath}.systemPrompt`,
        message: `expected a non-empty inline system prompt string (Pi --system-prompt), got ${preview(systemPromptRaw)}.`,
      });
      failed = true;
    } else if (systemPromptRaw.length > MAX_SYSTEM_PROMPT_LENGTH) {
      issues.push({
        path: `${basePath}.systemPrompt`,
        message: `systemPrompt exceeds ${MAX_SYSTEM_PROMPT_LENGTH} characters; prefer systemPromptFile for long prompts.`,
      });
      failed = true;
    } else {
      profile.systemPrompt = systemPromptRaw;
    }
  }
  if (systemPromptFileRaw !== undefined) {
    const normalized = normalizeProjectRelativePath(systemPromptFileRaw, `${basePath}.systemPromptFile`, issues);
    if (normalized === undefined) {
      failed = true;
    } else {
      profile.systemPromptFile = normalized;
    }
  }
  if (systemPromptRaw !== undefined && systemPromptFileRaw !== undefined) {
    issues.push({
      path: basePath,
      message: `"systemPrompt" and "systemPromptFile" are mutually exclusive: set exactly one. Use "systemPrompt" for short inline prompts or "systemPromptFile" (e.g. ".pi/agents/scout.md") for files.`,
    });
    failed = true;
  }

  // tools / excludeTools
  const toolsRaw = get("tools");
  if (toolsRaw !== undefined) {
    const validated = validateNameList(toolsRaw, `${basePath}.tools`, "tools", issues);
    if (validated === undefined) failed = true;
    else profile.tools = validated;
  }
  const excludeToolsRaw = get("excludeTools");
  if (excludeToolsRaw !== undefined) {
    const validated = validateNameList(excludeToolsRaw, `${basePath}.excludeTools`, "excludeTools", issues);
    if (validated === undefined) failed = true;
    else profile.excludeTools = validated;
  }

  // skills / extensions
  const skillsRaw = get("skills");
  if (skillsRaw !== undefined) {
    const validated = validatePathList(skillsRaw, `${basePath}.skills`, ".pi/skills/repo-search", issues);
    if (validated === undefined) failed = true;
    else profile.skills = validated;
  }
  const extensionsRaw = get("extensions");
  if (extensionsRaw !== undefined) {
    const validated = validatePathList(extensionsRaw, `${basePath}.extensions`, ".pi/extensions/example.ts", issues);
    if (validated === undefined) failed = true;
    else profile.extensions = validated;
  }

  // booleans
  const contextFilesRaw = get("contextFiles");
  if (contextFilesRaw !== undefined) {
    const validated = validateBoolean(contextFilesRaw, `${basePath}.contextFiles`, issues);
    if (validated === undefined) failed = true;
    else profile.contextFiles = validated;
  }
  const discoverSkillsRaw = get("discoverSkills");
  if (discoverSkillsRaw !== undefined) {
    const validated = validateBoolean(discoverSkillsRaw, `${basePath}.discoverSkills`, issues);
    if (validated === undefined) failed = true;
    else profile.discoverSkills = validated;
  }
  const discoverExtensionsRaw = get("discoverExtensions");
  if (discoverExtensionsRaw !== undefined) {
    const validated = validateBoolean(discoverExtensionsRaw, `${basePath}.discoverExtensions`, issues);
    if (validated === undefined) failed = true;
    else profile.discoverExtensions = validated;
  }

  // session
  const sessionRaw = get("session");
  if (sessionRaw !== undefined) {
    if (typeof sessionRaw !== "string" || !(SESSION_MODES as readonly string[]).includes(sessionRaw)) {
      issues.push({
        path: `${basePath}.session`,
        message: `expected one of ${SESSION_MODES.map((mode) => preview(mode)).join(", ")}, got ${preview(sessionRaw)}. Profiles default to "ephemeral" (Pi --no-session) and can never resume coordinator/parent context; resuming requires an explicit CLI override.`,
      });
      failed = true;
    } else {
      profile.session = sessionRaw as SessionMode;
    }
  }

  // display metadata (never affects execution)
  const displayNameRaw = get("displayName");
  if (displayNameRaw !== undefined) {
    if (typeof displayNameRaw !== "string" || displayNameRaw.length === 0 || displayNameRaw.length > MAX_DISPLAY_NAME_LENGTH) {
      issues.push({
        path: `${basePath}.displayName`,
        message: `expected a short display string (1-${MAX_DISPLAY_NAME_LENGTH} chars), got ${preview(displayNameRaw)}. Display metadata never affects execution semantics.`,
      });
      failed = true;
    } else {
      profile.displayName = displayNameRaw;
    }
  }
  const descriptionRaw = get("description");
  if (descriptionRaw !== undefined) {
    if (typeof descriptionRaw !== "string" || descriptionRaw.length === 0 || descriptionRaw.length > MAX_DESCRIPTION_LENGTH) {
      issues.push({
        path: `${basePath}.description`,
        message: `expected a display string (1-${MAX_DESCRIPTION_LENGTH} chars), got ${preview(descriptionRaw)}. Display metadata never affects execution semantics.`,
      });
      failed = true;
    } else {
      profile.description = descriptionRaw;
    }
  }

  return failed ? { failed: true } : { failed: false, profile };
}

/**
 * Validate a full `{ profiles: { <name>: <profile> } }` document.
 * Never mutates `raw`; never reads prompt/skill files; never executes shell.
 * Throws {@link ProfileValidationError} with actionable issues on failure.
 */
export function validateProfilesDocument(
  raw: unknown,
  sourceLabel = "<config>",
): ValidatedProfilesDocument {
  const issues: ProfileIssue[] = [];
  if (!isRecord(raw)) {
    throw new ProfileValidationError(sourceLabel, [
      {
        path: "(root)",
        message: `expected an object shaped like { profiles: { <name>: { ... } } }, got ${preview(raw)}. See profiles/README.md for the schema and merge order.`,
      },
    ]);
  }
  for (const key of Object.keys(raw)) {
    if (key !== "profiles") {
      issues.push({
        path: `(root).${key}`,
        message: `unknown top-level field ${preview(key)}: expected exactly { profiles: { ... } }. Profiles must never contain secrets/API keys — remove this field and keep credentials in env vars or Pi auth storage.`,
      });
    }
  }
  const profilesRaw = (raw as { profiles?: unknown }).profiles;
  if (profilesRaw === undefined) {
    issues.push({
      path: "profiles",
      message: `missing required "profiles" object (e.g. { profiles: { scout: { model: "anthropic/claude-haiku" } } }).`,
    });
    throw new ProfileValidationError(sourceLabel, issues);
  }
  if (!isRecord(profilesRaw)) {
    issues.push({
      path: "profiles",
      message: `expected an object mapping profile names to definitions, got ${preview(profilesRaw)}. Profile names must match ${PROFILE_NAME_PATTERN}.`,
    });
    throw new ProfileValidationError(sourceLabel, issues);
  }
  const entries = Object.entries(profilesRaw);
  if (entries.length === 0) {
    issues.push({
      path: "profiles",
      message: `expected at least one profile (e.g. { profiles: { scout: { model: "anthropic/claude-haiku" } } }), got an empty object.`,
    });
    throw new ProfileValidationError(sourceLabel, issues);
  }

  const profiles: Record<string, ValidatedPiProfile> = {};
  for (const [name, value] of entries) {
    const basePath = `profiles.${name}`;
    if (!PROFILE_NAME_PATTERN.test(name) || name.length > MAX_PROFILE_NAME_LENGTH) {
      issues.push({
        path: basePath,
        message: `invalid profile name ${preview(name)}: use 1-${MAX_PROFILE_NAME_LENGTH} chars matching ${PROFILE_NAME_PATTERN} (e.g. "scout", "worker", "reviewer").`,
      });
      continue;
    }
    const result = validateSingleProfile(name, value, basePath, issues, { allowExtends: true });
    if (!result.failed && result.profile) {
      profiles[name] = { ...result.profile, sourceLabel };
    }
  }

  if (issues.length > 0) {
    throw new ProfileValidationError(sourceLabel, issues);
  }
  return { profiles, sourceLabel };
}

/**
 * Validate explicit CLI overrides (precedence level 6). Rejects `extends`
 * (inheritance is fixed before overrides apply). Throws
 * {@link ProfileValidationError} on failure. Never mutates `raw`.
 */
export function validateProfileOverrides(
  raw: unknown,
  sourceLabel = "<cli-overrides>",
): ValidatedPiProfile {
  const issues: ProfileIssue[] = [];
  if (!isRecord(raw)) {
    throw new ProfileValidationError(sourceLabel, [
      {
        path: "(overrides)",
        message: `expected an object with profile fields (minus "extends"), got ${preview(raw)}.`,
      },
    ]);
  }
  const result = validateSingleProfile("<overrides>", raw, "(overrides)", issues, { allowExtends: false });
  if (issues.length > 0 || result.failed || !result.profile) {
    throw new ProfileValidationError(sourceLabel, issues);
  }
  return result.profile;
}

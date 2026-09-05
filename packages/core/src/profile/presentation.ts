/**
 * Provenance/display presentation for Pi agent profiles (OP1.7 / JEF-11).
 *
 * JEF-11 owns CLI commands, provenance/display presentation, validation UX,
 * and the Orca sidebar. JEF-7 owns `ResolvedPiProfile` → `ProcessSpec` and
 * the redacted launch-spec formatter — this module never builds Pi argv
 * itself. When JEF-7's formatter is available, callers inject it via
 * {@link LaunchPreviewProvider}; otherwise `inspect` omits the launch
 * preview with an explicit note instead of implementing a second formatter.
 *
 * Design rules (from JEF-11):
 * - Reuse OP1.2 schema/resolver for all display data.
 * - Show effective values plus provenance (`built-in`, user config, project
 *   config, inherited profile).
 * - Never load full skill/prompt file contents merely to render metadata.
 * - Validation errors identify file/source/field where possible.
 * - `show`/`inspect` redact secrets and avoid dumping large prompt/skill
 *   bodies unless explicitly requested (`--show-prompt`).
 * - Avoid exposing sensitive absolute paths unnecessarily: human output
 *   shortens the home directory to `~` except in the explicit `profile path`
 *   command, whose purpose is to locate configuration.
 */

import { BUILTIN_PROFILES_SOURCE } from "./builtins.js";
import { BUILTIN_PROFILE_DEFAULTS } from "./schema.js";
import { resolveProfile } from "./resolve.js";
import type {
  ResolvedPiProfile,
  SessionMode,
  ThinkingLevel,
  ValidatedProfilesDocument,
} from "./types.js";

/**
 * Context for a JEF-7 launch preview. Mirrors the inputs JEF-7's async
 * launch build requires: `buildPiLaunch(resolved, { projectRoot, cwd })`
 * may read `systemPromptFile` before `formatPiInspect(resolved, launch)`
 * can render file-backed prompts. JEF-11 never builds the launch itself —
 * it only supplies this context and awaits the injected provider.
 */
export interface LaunchPreviewContext {
  /** Documented project/config root used to resolve relative prompt paths. */
  projectRoot: string;
  /** Preserved worktree cwd for the launch spec. */
  cwd: string;
  /** True when the user passed `--show-prompt` (full prompt, else redacted). */
  showFullPrompt: boolean;
}

/**
 * JEF-7-owned redacted launch-spec formatter contract.
 *
 * JEF-11 consumes this via injection — it never builds Pi argv itself.
 * Async by design: JEF-7's `buildPiLaunch` may perform `systemPromptFile`
 * I/O before formatting, so the provider may return a promise. JEF-7
 * integrates as:
 *
 * ```ts
 * getLaunchPreview: async (resolved, ctx) => {
 *   const launch = await buildPiLaunch(resolved, { projectRoot: ctx.projectRoot, cwd: ctx.cwd });
 *   return {
 *     preview: formatPiInspect(resolved, launch, { showFullPrompt: ctx.showFullPrompt }),
 *     spec: launch.spec,
 *     promptSource: launch.promptSource,
 *     ...
 *   };
 * }
 * ```
 * (see `productionGetLaunchPreview` in `packages/cli/src/main.ts`).
 *
 * Providers may return a bare string (preview only); structured results
 * additionally populate `profile inspect --json` fields (`spec`,
 * `promptSource`, …) so the JSON contract keeps JEF-7's
 * `{ profile, spec, promptSource, … }` shape alongside JEF-11 presentation
 * fields. Implementations must be redacted, human-readable, display-only,
 * and must never be used to execute the command (see JEF-7 `process-spec.ts`).
 */
export type LaunchPreviewProvider = (
  resolved: ResolvedPiProfile,
  context: LaunchPreviewContext,
) => Promise<LaunchPreviewResult | string> | LaunchPreviewResult | string;

/**
 * Structured launch-preview result (JEF-7 owns the fields; JEF-11 renders them).
 *
 * `preview` is the redacted display-only string (human output + JSON
 * `launchPreview`). The remaining fields are JEF-7's structured launch data,
 * merged top-level into `profile inspect --json` so the JSON contract keeps
 * `{ profile, spec, promptSource, … }`. Display output must never be executed
 * — launchers use `spec.args` structurally.
 */
export interface LaunchPreviewResult {
  preview: string;
  spec?: unknown;
  promptSource?: string;
  promptFileRelativePath?: string;
  promptFileAbsolutePath?: string;
  promptTransport?: unknown;
  promptTempPath?: string;
  promptText?: string;
  /** Set by {@link sanitizeLaunchPreviewForDisplay} when truncation applied. */
  promptTruncated?: boolean;
}

/** Normalize a provider return into its structured form. */
export function normalizeLaunchPreview(
  value: LaunchPreviewResult | string,
): LaunchPreviewResult {
  return typeof value === "string" ? { preview: value } : value;
}

/**
 * Display-only JSON sanitizer for structured launch previews (JEF-11).
 *
 * The human `preview` string is already redacted by JEF-7's formatter, but
 * the structured fields (`promptText`, `spec.args` after `--system-prompt`)
 * carry the full prompt. When `showFullPrompt` is false, this returns a copy
 * with long prompt bodies truncated (same 240-char preview policy as
 * {@link formatPromptForDisplay}) so default `inspect --json` honors the
 * `redacted: true` contract. Never mutates its input or the executable
 * `PiProcessSpec` — `spec.args` is copied before redaction. Pass
 * `showFullPrompt: true` (`--show-prompt`) to expose full values.
 */
export function sanitizeLaunchPreviewForDisplay(
  preview: LaunchPreviewResult,
  options?: { showFullPrompt?: boolean; limit?: number },
): LaunchPreviewResult {
  if (options?.showFullPrompt) return preview;
  const limit = options?.limit ?? PROMPT_PREVIEW_LIMIT;
  let truncated = false;
  const redactText = (text: string): string => {
    if (text.length <= limit) return text;
    truncated = true;
    return `${text.slice(0, limit)}…`;
  };
  const out: LaunchPreviewResult = { ...preview };
  if (typeof out.promptText === "string") {
    const redacted = redactText(out.promptText);
    if (redacted !== out.promptText) out.promptText = redacted;
  }
  const spec = out.spec as { args?: unknown } | undefined;
  if (spec && typeof spec === "object" && Array.isArray(spec.args)) {
    const args = spec.args as unknown[];
    const index = args.indexOf("--system-prompt");
    if (index !== -1 && index + 1 < args.length && typeof args[index + 1] === "string") {
      const full = args[index + 1] as string;
      const redacted = redactText(full);
      if (redacted !== full) {
        const nextArgs = [...args];
        nextArgs[index + 1] = redacted;
        out.spec = { ...spec, args: nextArgs };
      }
    }
  }
  if (truncated) out.promptTruncated = true;
  return out;
}

/** Where an effective field value came from. */
export type ProvenanceKind = "built-in" | "user" | "project";

export interface FieldProvenance {
  kind: ProvenanceKind;
  /** Profile in the `extends` chain that last defined the field (when not built-in). */
  definedIn?: string;
  /** Config file that supplied the field (user/project path when known). */
  configPath?: string;
  /** True when the value was inherited from an ancestor profile. */
  inherited: boolean;
  /** Human display, e.g. `built-in`, `user config`, `project config`, `inherited profile "base" (project config)`. */
  display: string;
}

export interface ProfileLayerContext {
  mergedDoc: ValidatedProfilesDocument;
  /** JEF-10 built-in defaults (lowest layer; always present in CLI use). */
  builtinDoc: ValidatedProfilesDocument;
  userDoc?: ValidatedProfilesDocument;
  projectDoc?: ValidatedProfilesDocument;
  userPath: string;
  projectPath: string;
  userExists: boolean;
  projectExists: boolean;
}

/** Minimal per-profile summary for lists and the Orca sidebar. */
export interface ProfileSummary {
  name: string;
  displayName?: string;
  model?: string;
  thinking: ThinkingLevel;
  /** Undefined when the profile leaves tools to Pi defaults. */
  toolCount?: number;
  tools?: readonly string[];
  skillNames: readonly string[];
  skillCount: number;
  extensionCount: number;
  contextFiles: boolean;
  discoverSkills: boolean;
  discoverExtensions: boolean;
  session: SessionMode;
  extendsChain: readonly string[];
  sourceLabel?: string;
  valid: boolean;
  validationError?: string;
}

export interface ProfileDetailField<T> {
  value: T;
  provenance: FieldProvenance;
}

export interface ProfileDetail {
  name: string;
  resolved: ResolvedPiProfile;
  provider: ProfileDetailField<string | undefined>;
  model: ProfileDetailField<string | undefined>;
  thinking: ProfileDetailField<ThinkingLevel>;
  systemPrompt: ProfileDetailField<string | undefined>;
  systemPromptFile: ProfileDetailField<string | undefined>;
  tools: ProfileDetailField<readonly string[] | undefined>;
  excludeTools: ProfileDetailField<readonly string[] | undefined>;
  skills: ProfileDetailField<readonly string[] | undefined>;
  extensions: ProfileDetailField<readonly string[] | undefined>;
  contextFiles: ProfileDetailField<boolean>;
  discoverSkills: ProfileDetailField<boolean>;
  discoverExtensions: ProfileDetailField<boolean>;
  session: ProfileDetailField<SessionMode>;
  githubIdentity: ProfileDetailField<string | undefined>;
  displayName: ProfileDetailField<string | undefined>;
  description: ProfileDetailField<string | undefined>;
  extendsChain: readonly string[];
  sourceLabel?: string;
}

export interface ProfileValidationEntry {
  name: string;
  valid: boolean;
  error?: string;
  /** Resolve error code when available (`unknown-parent`, `extends-cycle`, ...). */
  code?: string;
  sourceLabel?: string;
}

/** Sidebar-friendly model (JSON-serializable, metadata-only, no prompt bodies). */
export interface ProfilesPanelModel {
  profiles: Array<{
    name: string;
    displayName?: string;
    model?: string;
    thinking: ThinkingLevel;
    toolCount?: number;
    skillNames: readonly string[];
    skillCount: number;
    extensionCount: number;
    contextFiles: boolean;
    valid: boolean;
  }>;
  validation: {
    ok: boolean;
    invalidCount: number;
  };
  config: {
    userPath: string;
    projectPath: string;
    userExists: boolean;
    projectExists: boolean;
  };
}

const PROMPT_PREVIEW_LIMIT = 240;

type ExecutionFieldName =
  | "provider"
  | "model"
  | "thinking"
  | "systemPrompt"
  | "systemPromptFile"
  | "tools"
  | "excludeTools"
  | "skills"
  | "extensions"
  | "contextFiles"
  | "discoverSkills"
  | "discoverExtensions"
  | "session"
  | "githubIdentity"
  | "displayName"
  | "description";

/**
 * Shorten a filesystem path for human display by collapsing the home
 * directory to `~`. Used everywhere except the explicit `profile path`
 * command (whose purpose is to locate configuration). Never mutates the
 * underlying path — display only.
 */
export function shortenHomeForDisplay(
  filePath: string,
  home?: string,
): string {
  if (!filePath) return filePath;
  const resolvedHome =
    home ?? process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (!resolvedHome) return filePath;
  const normalizedPath = filePath.replace(/\\/g, "/");
  const normalizedHome = resolvedHome.replace(/\\/g, "/").replace(/\/+$/, "");
  if (
    normalizedPath === normalizedHome ||
    normalizedPath.startsWith(`${normalizedHome}/`)
  ) {
    return `~${normalizedPath.slice(normalizedHome.length)}`;
  }
  return filePath;
}

/** Truncate a potentially large inline prompt for redacted display. */
export function truncatePromptPreview(
  text: string,
  limit: number = PROMPT_PREVIEW_LIMIT,
): { preview: string; truncated: boolean; fullLength: number } {
  if (text.length <= limit) {
    return { preview: text, truncated: false, fullLength: text.length };
  }
  return {
    preview: `${text.slice(0, limit)}…`,
    truncated: true,
    fullLength: text.length,
  };
}

/**
 * Render one prompt value for display. Never dumps the full body unless
 * `showFull` is true (`--show-prompt`). Returns a single-line-safe string
 * with an explicit truncation note so validation output stays greppable.
 */
export function formatPromptForDisplay(
  text: string | undefined,
  options?: { showFull?: boolean; limit?: number },
): string {
  if (text === undefined) return "(none)";
  if (options?.showFull) return text;
  const { preview, truncated, fullLength } = truncatePromptPreview(
    text,
    options?.limit ?? PROMPT_PREVIEW_LIMIT,
  );
  if (!truncated) return preview.length === 0 ? "(empty)" : preview;
  return `${preview} [truncated ${fullLength} chars — use --show-prompt to display full]`;
}

function layerDisplay(kind: ProvenanceKind): string {
  if (kind === "user") return "user config";
  if (kind === "project") return "project config";
  return "built-in";
}

function fieldDefinedIn(
  doc: ValidatedProfilesDocument | undefined,
  profileName: string,
  field: ExecutionFieldName,
): boolean {
  if (!doc) return false;
  const entry = Object.hasOwn(doc.profiles, profileName)
    ? doc.profiles[profileName]
    : undefined;
  if (!entry) return false;
  return (entry as Record<string, unknown>)[field] !== undefined;
}

/**
 * Determine per-field provenance for one resolved profile.
 *
 * Walks the `extends` chain root-first (last definition wins), then attributes
 * the winning definition to the project, user, or built-in layer (project wins
 * over user wins over JEF-10 builtins, mirroring `mergeValidatedDocuments`).
 * Fields from JEF-10's built-in document (`BUILTIN_PROFILES_SOURCE`) report
 * `built-in`, as do fields no profile defines (compiled `BUILTIN_DEFAULTS`).
 */
export function getFieldProvenance(
  profileName: string,
  field: ExecutionFieldName,
  chain: readonly string[],
  layers: Pick<
    ProfileLayerContext,
    "mergedDoc" | "builtinDoc" | "userDoc" | "projectDoc" | "userPath" | "projectPath"
  >,
): FieldProvenance {
  let definer: string | undefined;
  for (const entry of chain) {
    const mergedEntry = Object.hasOwn(layers.mergedDoc.profiles, entry)
      ? layers.mergedDoc.profiles[entry]
      : undefined;
    if (
      mergedEntry &&
      (mergedEntry as Record<string, unknown>)[field] !== undefined
    ) {
      definer = entry;
    }
  }
  if (!definer) {
    return { kind: "built-in", inherited: false, display: "built-in" };
  }
  let kind: ProvenanceKind = "user";
  let configPath: string | undefined;
  if (fieldDefinedIn(layers.projectDoc, definer, field)) {
    kind = "project";
    configPath = layers.projectPath;
  } else if (fieldDefinedIn(layers.userDoc, definer, field)) {
    kind = "user";
    configPath = layers.userPath;
  } else if (fieldDefinedIn(layers.builtinDoc, definer, field)) {
    kind = "built-in";
    configPath = undefined;
  } else {
    // Layer docs unavailable (e.g. single-file callers): fall back to the
    // merged entry's source label without inventing a layer.
    const mergedEntry = layers.mergedDoc.profiles[definer];
    const label = mergedEntry?.sourceLabel ?? layers.mergedDoc.sourceLabel;
    if (label === BUILTIN_PROFILES_SOURCE) {
      kind = "built-in";
      configPath = undefined;
    } else {
      const looksProject =
        label === layers.projectPath || label.includes(layers.projectPath);
      kind = looksProject ? "project" : "user";
      configPath = looksProject ? layers.projectPath : layers.userPath;
    }
  }
  const inherited = definer !== profileName;
  if (inherited) {
    return {
      kind,
      definedIn: definer,
      ...(configPath !== undefined ? { configPath } : {}),
      inherited: true,
      display: `inherited profile "${definer}" (${layerDisplay(kind)})`,
    };
  }
  return {
    kind,
    definedIn: definer,
    ...(configPath !== undefined ? { configPath } : {}),
    inherited: false,
    display: layerDisplay(kind),
  };
}

/** Build a metadata-only summary from an already-resolved profile. */
export function summarizeResolvedProfile(
  resolved: ResolvedPiProfile,
  options?: { sourceLabel?: string; valid?: boolean; validationError?: string },
): ProfileSummary {
  return {
    name: resolved.name,
    ...(resolved.displayName !== undefined
      ? { displayName: resolved.displayName }
      : {}),
    ...(resolved.model !== undefined ? { model: resolved.model } : {}),
    thinking: resolved.thinking,
    ...(resolved.tools !== undefined
      ? { toolCount: resolved.tools.length, tools: resolved.tools }
      : {}),
    skillNames: resolved.skills ?? [],
    skillCount: resolved.skills?.length ?? 0,
    extensionCount: resolved.extensions?.length ?? 0,
    contextFiles: resolved.contextFiles,
    discoverSkills: resolved.discoverSkills,
    discoverExtensions: resolved.discoverExtensions,
    session: resolved.session,
    extendsChain: resolved.extendsChain,
    ...(options?.sourceLabel !== undefined
      ? { sourceLabel: options.sourceLabel }
      : {}),
    valid: options?.valid ?? true,
    ...(options?.validationError !== undefined
      ? { validationError: options.validationError }
      : {}),
  };
}

/**
 * Resolve one profile and attach per-field provenance. Throws
 * `ProfileResolveError` for unknown profiles/parents/cycles (callers format
 * the message with file/source/field context).
 */
export function describeProfile(
  name: string,
  layers: ProfileLayerContext,
): ProfileDetail {
  const resolved = resolveProfile(name, layers.mergedDoc);
  const chain = resolved.extendsChain;
  const at = (field: ExecutionFieldName): FieldProvenance =>
    getFieldProvenance(name, field, chain, layers);
  const mergedEntry = Object.hasOwn(layers.mergedDoc.profiles, name)
    ? layers.mergedDoc.profiles[name]
    : undefined;
  const field = <T>(value: T, provenanceField: ExecutionFieldName): ProfileDetailField<T> => ({
    value,
    provenance: at(provenanceField),
  });
  return {
    name,
    resolved,
    provider: field(resolved.provider, "provider"),
    model: field(resolved.model, "model"),
    thinking: field(resolved.thinking, "thinking"),
    systemPrompt: field(resolved.systemPrompt, "systemPrompt"),
    systemPromptFile: field(resolved.systemPromptFile, "systemPromptFile"),
    tools: field(resolved.tools, "tools"),
    excludeTools: field(resolved.excludeTools, "excludeTools"),
    skills: field(resolved.skills, "skills"),
    extensions: field(resolved.extensions, "extensions"),
    contextFiles: field(resolved.contextFiles, "contextFiles"),
    discoverSkills: field(resolved.discoverSkills, "discoverSkills"),
    discoverExtensions: field(resolved.discoverExtensions, "discoverExtensions"),
    session: field(resolved.session, "session"),
    githubIdentity: field(resolved.githubIdentity, "githubIdentity"),
    displayName: field(resolved.displayName, "displayName"),
    description: field(resolved.description, "description"),
    extendsChain: chain,
    ...(mergedEntry?.sourceLabel !== undefined
      ? { sourceLabel: mergedEntry.sourceLabel }
      : {}),
  };
}

/** Validate every profile in the merged document (resolve attempt per name). */
export function validateAllProfiles(
  layers: Pick<ProfileLayerContext, "mergedDoc">,
): ProfileValidationEntry[] {
  const names = Object.keys(layers.mergedDoc.profiles).sort();
  return names.map((name) => {
    try {
      resolveProfile(name, layers.mergedDoc);
      const entry = Object.hasOwn(layers.mergedDoc.profiles, name)
        ? layers.mergedDoc.profiles[name]
        : undefined;
      return {
        name,
        valid: true,
        ...(entry?.sourceLabel !== undefined
          ? { sourceLabel: entry.sourceLabel }
          : {}),
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as { code: unknown }).code)
          : undefined;
      const entry = Object.hasOwn(layers.mergedDoc.profiles, name)
        ? layers.mergedDoc.profiles[name]
        : undefined;
      return {
        name,
        valid: false,
        error: message,
        ...(code !== undefined ? { code } : {}),
        ...(entry?.sourceLabel !== undefined
          ? { sourceLabel: entry.sourceLabel }
          : {}),
      };
    }
  });
}

/** Summarize every profile, marking unresolvable ones invalid (no throw). */
export function summarizeAllProfiles(layers: ProfileLayerContext): ProfileSummary[] {
  const names = Object.keys(layers.mergedDoc.profiles).sort();
  return names.map((name) => {
    try {
      const resolved = resolveProfile(name, layers.mergedDoc);
      const entry = Object.hasOwn(layers.mergedDoc.profiles, name)
        ? layers.mergedDoc.profiles[name]
        : undefined;
      return summarizeResolvedProfile(resolved, {
        ...(entry?.sourceLabel !== undefined
          ? { sourceLabel: entry.sourceLabel }
          : {}),
        valid: true,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      // Unresolvable profiles still appear in lists so `validate` can point
      // at the exact bad field/source; execution defaults fill the rest.
      return {
        name,
        thinking: BUILTIN_PROFILE_DEFAULTS.thinking,
        skillNames: [],
        skillCount: 0,
        extensionCount: 0,
        contextFiles: BUILTIN_PROFILE_DEFAULTS.contextFiles,
        discoverSkills: BUILTIN_PROFILE_DEFAULTS.discoverSkills,
        discoverExtensions: BUILTIN_PROFILE_DEFAULTS.discoverExtensions,
        session: BUILTIN_PROFILE_DEFAULTS.session,
        extendsChain: [],
        valid: false,
        validationError: message,
      };
    }
  });
}

/** Build the sidebar/panel model (metadata only — never prompt bodies). */
export function toPanelModel(layers: ProfileLayerContext): ProfilesPanelModel {
  const summaries = summarizeAllProfiles(layers);
  const invalidCount = summaries.filter((entry) => !entry.valid).length;
  return {
    profiles: summaries.map((entry) => ({
      name: entry.name,
      ...(entry.displayName !== undefined
        ? { displayName: entry.displayName }
        : {}),
      ...(entry.model !== undefined ? { model: entry.model } : {}),
      thinking: entry.thinking,
      ...(entry.toolCount !== undefined ? { toolCount: entry.toolCount } : {}),
      skillNames: entry.skillNames,
      skillCount: entry.skillCount,
      extensionCount: entry.extensionCount,
      contextFiles: entry.contextFiles,
      valid: entry.valid,
    })),
    validation: {
      ok: invalidCount === 0,
      invalidCount,
    },
    config: {
      userPath: layers.userPath,
      projectPath: layers.projectPath,
      userExists: layers.userExists,
      projectExists: layers.projectExists,
    },
  };
}

function formatProvenanceSuffix(provenance: FieldProvenance): string {
  return `[${provenance.display}]`;
}

function formatListValue(value: unknown): string {
  if (value === undefined) return "(none)";
  if (Array.isArray(value)) {
    if (value.length === 0) return "(none)";
    return value.join(", ");
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

/** Human-readable `profiles list` table (one line per profile + precedence footer). */
export function formatProfilesList(
  summaries: readonly ProfileSummary[],
  layers: Pick<ProfileLayerContext, "userPath" | "projectPath" | "userExists" | "projectExists">,
  options?: { home?: string },
): string {
  if (summaries.length === 0) {
    return [
      "No Pi profiles found.",
      "",
      "Configuration precedence (low → high):",
      `  user/global: ${shortenHomeForDisplay(layers.userPath, options?.home)}${layers.userExists ? "" : " (missing — optional)"}`,
      `  project:     ${shortenHomeForDisplay(layers.projectPath, options?.home)}${layers.projectExists ? "" : " (missing — optional)"}`,
      "",
      "Create one to get started — see profiles/examples.yaml:",
      `  user/global: ${shortenHomeForDisplay(layers.userPath, options?.home)}`,
      `  project:     ${shortenHomeForDisplay(layers.projectPath, options?.home)}`,
    ].join("\n");
  }
  const lines: string[] = [];
  lines.push(`Pi profiles (${summaries.length}):`);
  lines.push("");
  for (const entry of summaries) {
    const status = entry.valid ? "" : " [INVALID]";
    const model = entry.model ?? "(no model)";
    const tools =
      entry.toolCount !== undefined ? `${entry.toolCount} tools` : "default tools";
    const skills =
      entry.skillCount > 0
        ? `${entry.skillCount} skill${entry.skillCount === 1 ? "" : "s"}`
        : "no skills";
    const head = `  ${entry.name}${status} — ${model} / ${entry.thinking} — ${tools}, ${skills}, ${entry.extensionCount} extension${entry.extensionCount === 1 ? "" : "s"}`;
    lines.push(head);
    if (entry.validationError) {
      lines.push(`    invalid: ${entry.validationError.split("\n")[0]}`);
    } else if (entry.sourceLabel) {
      lines.push(
        `    source: ${shortenHomeForDisplay(entry.sourceLabel, options?.home)}`,
      );
    }
  }
  lines.push("");
  lines.push("Configuration precedence (low → high): built-in < user/global < project < inherited < selected.");
  lines.push(
    `  user/global: ${shortenHomeForDisplay(layers.userPath, options?.home)}${layers.userExists ? "" : " (missing — optional)"}`,
  );
  lines.push(
    `  project:     ${shortenHomeForDisplay(layers.projectPath, options?.home)}${layers.projectExists ? "" : " (missing — optional)"}`,
  );
  return lines.join("\n");
}

/** Human-readable `profile show` — effective values + provenance, redacted by default. */
export function formatProfileShow(
  detail: ProfileDetail,
  layers: Pick<ProfileLayerContext, "userPath" | "projectPath">,
  options?: { showPrompt?: boolean; home?: string },
): string {
  const showPrompt = options?.showPrompt ?? false;
  const lines: string[] = [];
  const title = detail.resolved.displayName
    ? `${detail.name} — ${detail.resolved.displayName}`
    : detail.name;
  lines.push(`Profile: ${title}`);
  if (detail.resolved.description) {
    lines.push(`Description: ${detail.resolved.description}`);
  }
  lines.push(`Extends chain: ${detail.extendsChain.join(" → ") || "(none)"}`);
  if (detail.sourceLabel) {
    lines.push(
      `Defined in: ${shortenHomeForDisplay(detail.sourceLabel, options?.home)}`,
    );
  }
  lines.push(
    `Config: user ${shortenHomeForDisplay(layers.userPath, options?.home)} < project ${shortenHomeForDisplay(layers.projectPath, options?.home)}`,
  );
  lines.push("");
  const row = (label: string, value: unknown, provenance: FieldProvenance): void => {
    lines.push(`  ${label}: ${formatListValue(value)} ${formatProvenanceSuffix(provenance)}`);
  };
  row("provider", detail.resolved.provider, detail.provider.provenance);
  row("model", detail.resolved.model, detail.model.provenance);
  row("thinking", detail.resolved.thinking, detail.thinking.provenance);
  if (detail.resolved.systemPrompt !== undefined) {
    const preview = formatPromptForDisplay(detail.resolved.systemPrompt, { showFull: showPrompt });
    // Multi-line prompts stay greppable: first line inline, rest indented.
    const [first, ...rest] = preview.split("\n");
    lines.push(`  systemPrompt: ${first} ${formatProvenanceSuffix(detail.systemPrompt.provenance)}`);
    for (const extra of rest) lines.push(`    ${extra}`);
  } else {
    row("systemPrompt", undefined, detail.systemPrompt.provenance);
  }
  row("systemPromptFile", detail.resolved.systemPromptFile, detail.systemPromptFile.provenance);
  row("tools", detail.resolved.tools, detail.tools.provenance);
  row("excludeTools", detail.resolved.excludeTools, detail.excludeTools.provenance);
  row("skills", detail.resolved.skills, detail.skills.provenance);
  row("extensions", detail.resolved.extensions, detail.extensions.provenance);
  row("contextFiles", detail.resolved.contextFiles, detail.contextFiles.provenance);
  row("discoverSkills", detail.resolved.discoverSkills, detail.discoverSkills.provenance);
  row("discoverExtensions", detail.resolved.discoverExtensions, detail.discoverExtensions.provenance);
  row("session", detail.resolved.session, detail.session.provenance);
  row("githubIdentity", detail.resolved.githubIdentity, detail.githubIdentity.provenance);
  if (!showPrompt && detail.resolved.systemPrompt !== undefined && detail.resolved.systemPrompt.length > PROMPT_PREVIEW_LIMIT) {
    lines.push("");
    lines.push("Note: inline prompt truncated (redacted display). Re-run with --show-prompt for the full text.");
  }
  lines.push("");
  lines.push("Provenance: built-in = compiled defaults or JEF-10 role defaults; user/project config = file layer; inherited profile = ancestor in extends chain.");
  return lines.join("\n");
}

/**
 * Human-readable `profile inspect` — `show` plus context policy, optional
 * JEF-10 context summary, and optional JEF-7 launch preview.
 *
 * The context summary text comes from JEF-10's `formatContextSummary()`
 * (one contract, one test set); callers compute it via
 * `summarizeProfileContext()` and pass the rendered block here.
 */
export function formatProfileInspect(
  detail: ProfileDetail,
  layers: Pick<ProfileLayerContext, "userPath" | "projectPath">,
  options?: {
    showPrompt?: boolean;
    /** Rendered `formatContextSummary()` block (JEF-10 contract). */
    contextSummaryText?: string;
    launchPreview?: string;
    home?: string;
  },
): string {
  const base = formatProfileShow(detail, layers, {
    showPrompt: options?.showPrompt,
    home: options?.home,
  });
  const lines = [base];
  lines.push("");
  lines.push("Context policy:");
  const skills = detail.resolved.skills ?? [];
  const extensions = detail.resolved.extensions ?? [];
  lines.push(
    `  contextFiles: ${detail.resolved.contextFiles ? "enabled (AGENTS.md/CLAUDE.md discovery on)" : "disabled (--no-context-files)"} ${formatProvenanceSuffix(detail.contextFiles.provenance)}`,
  );
  lines.push(
    `  skills: ${detail.resolved.discoverSkills ? "ambient discovery on" : "ambient discovery off (--no-skills)"} + ${skills.length} explicit ${formatProvenanceSuffix(detail.skills.provenance)}`,
  );
  for (const skill of skills.slice(0, 20)) lines.push(`    - ${skill}`);
  if (skills.length > 20) lines.push(`    … and ${skills.length - 20} more (metadata only — file contents never loaded)`);
  lines.push(
    `  extensions: ${detail.resolved.discoverExtensions ? "ambient discovery on" : "ambient discovery off (--no-extensions)"} + ${extensions.length} explicit ${formatProvenanceSuffix(detail.extensions.provenance)}`,
  );
  for (const extension of extensions.slice(0, 20)) lines.push(`    - ${extension}`);
  if (extensions.length > 20) lines.push(`    … and ${extensions.length - 20} more`);
  if (options?.contextSummaryText !== undefined) {
    lines.push("");
    lines.push(options.contextSummaryText);
  }
  lines.push("");
  if (options?.launchPreview !== undefined) {
    lines.push("Launch preview (redacted, display-only — never executed; JEF-7 formatter):");
    lines.push(options.launchPreview);
  } else {
    lines.push("Launch preview: unavailable — deterministic Pi argv is owned by JEF-7 (ResolvedPiProfile → ProcessSpec + redacted formatter).");
    lines.push("This command shows resolved configuration only and never builds argv itself.");
  }
  return lines.join("\n");
}

/** Human-readable `profile validate` report (file/source/field diagnostics). */
export function formatValidationReport(
  entries: readonly ProfileValidationEntry[],
  layers: Pick<ProfileLayerContext, "userPath" | "projectPath" | "userExists" | "projectExists">,
  options?: { home?: string },
): string {
  if (entries.length === 0) {
    return [
      "No profiles to validate (no profiles found).",
      `  user/global: ${shortenHomeForDisplay(layers.userPath, options?.home)}${layers.userExists ? "" : " (missing — optional)"}`,
      `  project:     ${shortenHomeForDisplay(layers.projectPath, options?.home)}${layers.projectExists ? "" : " (missing — optional)"}`,
    ].join("\n");
  }
  const invalid = entries.filter((entry) => !entry.valid);
  const lines: string[] = [];
  if (invalid.length === 0) {
    lines.push(`All ${entries.length} profile${entries.length === 1 ? "" : "s"} valid.`);
    for (const entry of entries) {
      const where = entry.sourceLabel
        ? ` (${shortenHomeForDisplay(entry.sourceLabel, options?.home)})`
        : "";
      lines.push(`  ok ${entry.name}${where}`);
    }
    return lines.join("\n");
  }
  lines.push(
    `${invalid.length} of ${entries.length} profile${entries.length === 1 ? "" : "s"} invalid:`,
  );
  for (const entry of entries) {
    if (entry.valid) {
      const where = entry.sourceLabel
        ? ` (${shortenHomeForDisplay(entry.sourceLabel, options?.home)})`
        : "";
      lines.push(`  ok ${entry.name}${where}`);
      continue;
    }
    const where = entry.sourceLabel
      ? ` [${shortenHomeForDisplay(entry.sourceLabel, options?.home)}]`
      : "";
    const code = entry.code ? ` (${entry.code})` : "";
    lines.push(`  invalid ${entry.name}${code}${where}`);
    if (entry.error) {
      for (const errorLine of entry.error.split("\n").slice(0, 12)) {
        lines.push(`    ${errorLine}`);
      }
    }
  }
  lines.push("");
  lines.push("Fix the dotted-path field(s) above in the indicated file, then re-run `orca-pi profile validate`.");
  return lines.join("\n");
}

/** Human-readable `profile path` output (authoritative locations + precedence). */
export function formatConfigPaths(
  layers: Pick<ProfileLayerContext, "userPath" | "projectPath" | "userExists" | "projectExists">,
  options?: { only?: "user" | "project"; home?: string },
): string {
  if (options?.only === "user") return layers.userPath;
  if (options?.only === "project") return layers.projectPath;
  return [
    "Pi profile configuration (authoritative; the CLI/profile file is the single store):",
    `  user/global: ${layers.userPath}${layers.userExists ? "" : " (missing — optional)"}`,
    `  project:     ${layers.projectPath}${layers.projectExists ? "" : " (missing — optional)"}`,
    "Precedence (low → high): built-in < user/global < project < inherited < selected < CLI overrides.",
    "The UI never creates a second store — edit these files, then re-run `orca-pi profile validate`.",
  ].join("\n");
}

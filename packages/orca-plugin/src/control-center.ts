/**
 * Orca-Pi Control Center helpers (UI1.3 shell + Profiles, UI1.4 Orchestration).
 *
 * Pure, dependency-light helpers for the single Control Center shell and the
 * structured Profiles editor. No I/O, no `node:` imports, no DOM — panels,
 * workers, and tests share this module. Live data always flows through the
 * versioned bridge (`bridge.ts` / `bridge-host.ts`); this module only shapes
 * drafts, validates them client-side, maps bridge errors back to fields, and
 * formats provenance/launch summaries for display.
 *
 * Schema notes (v1, from `@orca-pi/core`):
 * - All 17 `MUTABLE_PROFILE_FIELDS` are representable in the editor.
 * - `systemPrompt` and `systemPromptFile` are mutually exclusive.
 * - Arrays replace parents (never merge); inherited values are shown via the
 *   `extends` chain + per-field provenance, not additive diffs.
 * - v1 has no dedicated `mcp` field: MCP in the UI maps to the
 *   `extensions` surface (`extensions` + `discoverExtensions`) plus skills.
 *   The editor labels this explicitly and never renders secret values
 *   (bridge returns redacted status only; MCP config values stay out of the
 *   panel unless the backend adds a redacted shape).
 * - Thinking levels and tool names are closed sets owned by the backend
 *   schema; the editor offers them as selects/checkboxes but always lets the
 *   server validate (no hard-coded model list — models are free text with
 *   examples, validated server-side so Pi provider drift never breaks the UI).
 */

export const CONTROL_CENTER_PANEL_ID = "orca-pi-control-center";
/** Compatibility aliases retained after UI1.3 (same entry, one UI). */
export const CONTROL_CENTER_COMPAT_PANEL_IDS = [
  "orca-pi-status",
  "orca-pi-profiles",
] as const;

export type ControlCenterSectionId =
  | "profiles"
  | "orchestration"
  | "github"
  | "diagnostics";

export interface ControlCenterSection {
  id: ControlCenterSectionId;
  title: string;
  /** True when the section is implemented (Profiles UI1.3, Orchestration UI1.4, Diagnostics UI1.3); others are placeholders. */
  implemented: boolean;
  blurb: string;
}

export function controlCenterSections(): readonly ControlCenterSection[] {
  return [
    {
      id: "profiles",
      title: "Profiles",
      implemented: true,
      blurb:
        "Create, clone, edit, delete, and reset Pi role profiles with structured controls and provenance. Saves through the authoritative mutation service.",
    },
    {
      id: "orchestration",
      title: "Orchestration",
      implemented: true,
      blurb:
        "Map Orca roles/task types to Pi profiles (worker/scout/reviewer defaults plus custom roles) with provenance, validation, and launch preview. Saves through the authoritative orchestration service; Orca owns task/DAG/worktree/run lifecycle.",
    },
    {
      id: "github",
      title: "GitHub",
      implemented: true,
      blurb:
        "Worker/reviewer identity health via github.status + github.doctor (redacted status only, never secrets). Human/ChatGPT review actor 44madfire is a review actor, never a credential slot.",
    },
    {
      id: "diagnostics",
      title: "Diagnostics",
      implemented: true,
      blurb:
        "Bridge, capability, CLI, config, and worktree health via diagnostics.doctor plus profile validation and worktree context. UI1.5 hardens the display; CLI remains authoritative.",
    },
  ] as const;
}

/** Thinking levels owned by the backend schema (select options). */
export const CONTROL_CENTER_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** Pi built-in tool names (checkbox options; custom tools allowed as text). */
export const CONTROL_CENTER_BUILTIN_TOOLS = [
  "read",
  "bash",
  "powershell",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;

export const CONTROL_CENTER_SESSION_MODES = ["ephemeral", "fresh"] as const;

/** All structured profile fields the editor covers (v1 schema). */
export const CONTROL_CENTER_EDITABLE_FIELDS = [
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
  "githubIdentity",
  "displayName",
  "description",
] as const;

export type ControlCenterField = (typeof CONTROL_CENTER_EDITABLE_FIELDS)[number];

/** Scopes the mutation service accepts. Never inferred — always explicit. */
export type ControlCenterScope = "user" | "project";

/** Minimal list item the Control Center renders (mirrors ProfileSummary). */
export interface ControlCenterListItem {
  name: string;
  displayName?: string;
  provider?: string;
  model?: string;
  thinking: string;
  toolCount?: number;
  tools?: readonly string[];
  skillNames: readonly string[];
  skillCount: number;
  extensionCount: number;
  contextFiles: boolean;
  extendsChain: readonly string[];
  extends?: string;
  githubIdentity?: string;
  layer?: "builtin" | "user" | "project";
  valid: boolean;
  validationError?: string;
}

/** Human layer label for the list. */
export function describeLayer(layer: ControlCenterListItem["layer"]): string {
  if (layer === "project") return "project";
  if (layer === "user") return "user";
  return "builtin";
}

/**
 * One-line MCP summary for the list (v1 mapping).
 * v1 has no dedicated `mcp` field, so MCP surfaces as extensions:
 * explicit count + ambient-discovery state. Never includes secret values.
 */
export function describeMcpSummary(item: Pick<ControlCenterListItem, "extensionCount"> & { discoverExtensions?: boolean }): string {
  const count = item.extensionCount;
  const ambient = item.discoverExtensions === true ? "ambient on" : "ambient off";
  if (count === 0) return `MCP via extensions: none (${ambient})`;
  return `MCP via extensions: ${count} (${ambient})`;
}

/** Compact inherited-vs-explicit hint for array fields (arrays replace). */
export function describeArrayInheritanceNote(): string {
  return "Arrays replace parents in v1 (never merge): the winning layer's list is effective; ancestors are shown via the extends chain and per-field provenance.";
}

/** True for shipped defaults that must never be destructively edited. */
export function isBuiltinProfileName(name: string): boolean {
  return name === "scout" || name === "worker" || name === "reviewer";
}

/** Editor draft: layer-targeted patch values (undefined = untouched). */
export type ControlCenterDraft = Partial<
  Record<ControlCenterField, unknown>
> & { name?: string };

export interface DraftIssue {
  field: string;
  message: string;
}

const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const PROVIDER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const MODEL_RE = /^[A-Za-z0-9._/:@+~-]+$/;
const TOOL_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const GITHUB_IDENTITY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const THINKING_SUFFIX_RE = /:(off|minimal|low|medium|high|xhigh|max)$/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkProjectRelativePath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "expected a non-empty project-relative path (e.g. \".pi/skills/repo-search\").";
  }
  if (value.length > 512) return "path exceeds 512 characters; keep profile paths short.";
  // eslint-disable-next-line no-control-regex
  if (/[\0-\x1f\x7f]/.test(value)) return "path contains control characters.";
  if (value.includes("\\")) return "use forward slashes for project-relative paths.";
  const trimmed = value.trim();
  if (
    trimmed.startsWith("/") ||
    /^[A-Za-z]:\//.test(trimmed) ||
    trimmed.startsWith("\\\\") ||
    trimmed === "~" ||
    trimmed.startsWith("~/")
  ) {
    return "expected a project-relative path, got an absolute or home-relative path.";
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed)) {
    return "expected a project-relative path, got a URL.";
  }
  const segs = trimmed.split("/");
  for (const seg of segs) {
    if (seg === "..") return "path must stay inside the project (no \"..\").";
  }
  return undefined;
}

function checkStringList(
  value: unknown,
  kind: "tool" | "path",
  example: string,
): string | undefined {
  if (!Array.isArray(value)) return `expected an array (e.g. ["${example}"]).`;
  const seen = new Set<string>();
  for (let i = 0; i < value.length; i += 1) {
    const entry = (value as unknown[])[i];
    if (kind === "tool") {
      if (typeof entry !== "string" || entry.length === 0 || entry.length > 64 || !TOOL_RE.test(entry)) {
        return `[${i}]: invalid tool name ${JSON.stringify(entry)}: use letters, digits, "-" or "_" (built-ins: read, bash, edit, write, grep, find, ls).`;
      }
    } else {
      const err = checkProjectRelativePath(entry);
      if (err) return `[${i}]: ${err}`;
    }
    const key = String(entry);
    if (seen.has(key)) return `duplicate entry ${JSON.stringify(key)}; list each once.`;
    seen.add(key);
  }
  return undefined;
}

/**
 * Client-side shape checks for the editor draft (fast feedback before the
 * bridge). Mirrors the backend schema grammar without duplicating server
 * policy: the server remains authoritative and may reject what this passes.
 * Returns dotted field issues; empty means shape-ok (server still validates).
 */
export function validateDraftShape(draft: ControlCenterDraft): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const get = (field: ControlCenterField): unknown =>
    (draft as Record<string, unknown>)[field];

  const extendsRaw = get("extends");
  if (extendsRaw !== undefined && extendsRaw !== null && extendsRaw !== "") {
    if (typeof extendsRaw !== "string" || !PROFILE_NAME_RE.test(extendsRaw) || extendsRaw.length > 64) {
      issues.push({ field: "extends", message: "expected a parent profile name (1-64 chars, letters/digits/_/-)." });
    } else if (typeof draft.name === "string" && extendsRaw === draft.name) {
      issues.push({ field: "extends", message: "a profile cannot extend itself." });
    }
  }

  const providerRaw = get("provider");
  if (providerRaw !== undefined && providerRaw !== null && providerRaw !== "") {
    if (typeof providerRaw !== "string" || providerRaw.length > 64 || !PROVIDER_RE.test(providerRaw)) {
      issues.push({ field: "provider", message: "expected a Pi provider name (e.g. \"anthropic\", \"openai-codex\")." });
    }
  }

  const modelRaw = get("model");
  if (modelRaw !== undefined && modelRaw !== null && modelRaw !== "") {
    if (typeof modelRaw !== "string" || modelRaw.length > 256 || !MODEL_RE.test(modelRaw)) {
      issues.push({ field: "model", message: "expected a Pi --model ID without whitespace or shell characters (custom IDs allowed; validated server-side)." });
    } else if (THINKING_SUFFIX_RE.test(modelRaw)) {
      issues.push({ field: "model", message: "ambiguous terminal \":<thinking>\" suffix would be overridden by --thinking; use the thinking field instead." });
    }
  }

  const thinkingRaw = get("thinking");
  if (thinkingRaw !== undefined && thinkingRaw !== null && thinkingRaw !== "") {
    if (typeof thinkingRaw !== "string" || !(CONTROL_CENTER_THINKING_LEVELS as readonly string[]).includes(thinkingRaw)) {
      issues.push({ field: "thinking", message: `expected one of ${(CONTROL_CENTER_THINKING_LEVELS as readonly string[]).join(", ")}.` });
    }
  }

  const promptRaw = get("systemPrompt");
  const promptFileRaw = get("systemPromptFile");
  const hasPrompt = promptRaw !== undefined && promptRaw !== null && promptRaw !== "";
  const hasPromptFile = promptFileRaw !== undefined && promptFileRaw !== null && promptFileRaw !== "";
  if (hasPrompt && hasPromptFile) {
    issues.push({ field: "systemPrompt", message: "\"systemPrompt\" and \"systemPromptFile\" are mutually exclusive: set exactly one." });
  }
  if (hasPrompt) {
    if (typeof promptRaw !== "string" || promptRaw.length === 0) {
      issues.push({ field: "systemPrompt", message: "expected a non-empty inline prompt string." });
    } else if (promptRaw.length > 50000) {
      issues.push({ field: "systemPrompt", message: "inline prompt exceeds 50000 chars; prefer systemPromptFile." });
    }
  }
  if (hasPromptFile) {
    const err = checkProjectRelativePath(promptFileRaw);
    if (err) issues.push({ field: "systemPromptFile", message: err });
  }

  const toolsRaw = get("tools");
  if (toolsRaw !== undefined && toolsRaw !== null) {
    const err = checkStringList(toolsRaw, "tool", "read");
    if (err) issues.push({ field: "tools", message: err });
  }
  const excludeRaw = get("excludeTools");
  if (excludeRaw !== undefined && excludeRaw !== null) {
    const err = checkStringList(excludeRaw, "tool", "edit");
    if (err) issues.push({ field: "excludeTools", message: err });
  }
  const skillsRaw = get("skills");
  if (skillsRaw !== undefined && skillsRaw !== null) {
    const err = checkStringList(skillsRaw, "path", ".pi/skills/repo-search");
    if (err) issues.push({ field: "skills", message: err });
  }
  const extRaw = get("extensions");
  if (extRaw !== undefined && extRaw !== null) {
    const err = checkStringList(extRaw, "path", ".pi/extensions/example.ts");
    if (err) issues.push({ field: "extensions", message: err });
  }

  for (const flag of ["contextFiles", "discoverSkills", "discoverExtensions"] as const) {
    const raw = get(flag);
    if (raw !== undefined && raw !== null && typeof raw !== "boolean") {
      issues.push({ field: flag, message: "expected a boolean true/false." });
    }
  }

  const sessionRaw = get("session");
  if (sessionRaw !== undefined && sessionRaw !== null && sessionRaw !== "") {
    if (sessionRaw !== "ephemeral" && sessionRaw !== "fresh") {
      issues.push({ field: "session", message: "expected \"ephemeral\" or \"fresh\"." });
    }
  }

  const ghRaw = get("githubIdentity");
  if (ghRaw !== undefined && ghRaw !== null && ghRaw !== "") {
    if (typeof ghRaw !== "string" || ghRaw.length > 64 || !GITHUB_IDENTITY_RE.test(ghRaw)) {
      issues.push({ field: "githubIdentity", message: "expected a logical identity (e.g. \"worker\", \"reviewer\"); never a secret." });
    } else if (
      ghRaw === "reviewer" &&
      Array.isArray(toolsRaw) &&
      (toolsRaw as unknown[]).some((t) => t === "edit" || t === "write")
    ) {
      issues.push({ field: "tools", message: "reviewer identity must not request edit/write tools." });
    }
  }

  const displayRaw = get("displayName");
  if (displayRaw !== undefined && displayRaw !== null && displayRaw !== "") {
    if (typeof displayRaw !== "string" || displayRaw.length > 100) {
      issues.push({ field: "displayName", message: "expected a short display string (1-100 chars)." });
    }
  }
  const descRaw = get("description");
  if (descRaw !== undefined && descRaw !== null && descRaw !== "") {
    if (typeof descRaw !== "string" || descRaw.length > 1000) {
      issues.push({ field: "description", message: "expected a display string (1-1000 chars)." });
    }
  }

  for (const key of Object.keys(draft)) {
    if (key === "name") continue;
    if (!(CONTROL_CENTER_EDITABLE_FIELDS as readonly string[]).includes(key)) {
      issues.push({ field: key, message: `unknown field: expected one of ${CONTROL_CENTER_EDITABLE_FIELDS.join(", ")}. Profiles must never contain secrets.` });
    }
  }
  return issues;
}

/**
 * Build `profile.mutate` params from an editor draft.
 * - `mode: "create"` → `{action:"create", name, scope, initial, ...hash}`
 * - `mode: "patch"` → `{action:"patch", name, scope, patch, ...hash}`
 * - `mode: "clone"` → `{action:"clone", source, dest, scope, ...hash}`
 * - `mode: "delete"` → `{action:"delete", name, scope, ...hash}`
 * Empty-string values are normalized to `null` in patches (field deletion);
 * untouched (undefined) fields are omitted. Never includes secrets.
 */
export function buildMutateParams(options: {
  mode: "create" | "patch" | "clone" | "delete";
  name: string;
  scope: ControlCenterScope;
  draft?: ControlCenterDraft;
  source?: string;
  expectedSourceHash?: string | null;
  expectedAbsent?: boolean;
}): Record<string, unknown> {
  const { mode, name, scope } = options;
  const hash =
    options.expectedSourceHash !== undefined
      ? { expectedSourceHash: options.expectedSourceHash }
      : options.expectedAbsent === true
        ? { expectedAbsent: true }
        : {};
  if (mode === "delete") {
    return { action: "delete", name, scope, ...hash };
  }
  if (mode === "clone") {
    if (!options.source) throw new Error("clone requires options.source.");
    return { action: "clone", source: options.source, dest: name, scope, ...hash };
  }
  const draft = options.draft ?? {};
  const patch: Record<string, unknown> = {};
  for (const field of CONTROL_CENTER_EDITABLE_FIELDS) {
    const value = (draft as Record<string, unknown>)[field];
    if (value === undefined) continue;
    if (value === "") {
      patch[field] = null;
      continue;
    }
    patch[field] = value;
  }
  if (mode === "create") {
    return { action: "create", name, scope, initial: patch, ...hash };
  }
  return { action: "patch", name, scope, patch, ...hash };
}

/** Validate a profile name for create/clone (mirrors backend grammar). */
export function validateProfileName(name: unknown): string | undefined {
  if (typeof name !== "string" || name.length === 0) return "expected a profile name (e.g. \"worker-fast\").";
  if (name === "__proto__" || name === "constructor" || name === "prototype") {
    return "reserved name: never use \"__proto__\", \"constructor\", or \"prototype\".";
  }
  if (!PROFILE_NAME_RE.test(name) || name.length > 64) {
    return "use 1-64 chars matching [A-Za-z0-9][A-Za-z0-9_-]* (e.g. \"worker-fast\").";
  }
  return undefined;
}

export type BridgeErrorKind =
  | "validation"
  | "conflict"
  | "unsupported"
  | "auth/setup"
  | "internal"
  | "not-found"
  | "already-exists";

export interface MappedBridgeError {
  kind: BridgeErrorKind;
  message: string;
  /** Field the error maps to (`_global` when it is not field-specific). */
  field: string;
  /** True when the user can retry after reload (stale-write conflict). */
  retryable: boolean;
  /** True when the editor should offer reload/compare (never overwrite). */
  isConflict: boolean;
}

/**
 * Map a bridge error response onto editor UX.
 * `conflict` → reload/compare prompt (never silent overwrite).
 * `validation` with a dotted `field` (e.g. `profiles.x.model`) → short field.
 * Everything else → `_global` with the server message intact.
 */
export function mapBridgeErrorToField(error: {
  code?: unknown;
  message?: unknown;
  field?: unknown;
  retryable?: unknown;
}): MappedBridgeError {
  const code = typeof error.code === "string" ? error.code : "internal";
  const message = typeof error.message === "string" && error.message.length > 0 ? error.message : "Request failed.";
  const kind = (
    ["validation", "conflict", "unsupported", "auth/setup", "internal", "not-found", "already-exists"] as const
  ).includes(code as BridgeErrorKind)
    ? (code as BridgeErrorKind)
    : "internal";
  const retryable = error.retryable === true || kind === "conflict";
  const isConflict = kind === "conflict";
  let field = "_global";
  const rawField = typeof error.field === "string" ? error.field : undefined;
  if (rawField) {
    const short = rawField.split(".").pop() ?? rawField;
    if ((CONTROL_CENTER_EDITABLE_FIELDS as readonly string[]).includes(short)) {
      field = short;
    } else {
      field = rawField;
    }
  } else {
    // Heuristic: server messages often name the field (`profiles.x.model:`).
    const match = /profiles\.[^.]+\.([A-Za-z]+)/.exec(message);
    if (match && (CONTROL_CENTER_EDITABLE_FIELDS as readonly string[]).includes(match[1]!)) {
      field = match[1]!;
    }
  }
  return { kind, message, field, retryable, isConflict };
}

/** Human provenance display for a field (mirrors backend `display`). */
export function describeProvenance(input: {
  kind?: string;
  display?: string;
  definedIn?: string;
  inherited?: boolean;
}): string {
  if (typeof input.display === "string" && input.display.length > 0) return input.display;
  if (input.kind === "project") return input.inherited ? `inherited profile "${input.definedIn ?? "?"}" (project config)` : "project config";
  if (input.kind === "user") return input.inherited ? `inherited profile "${input.definedIn ?? "?"}" (user config)` : "user config";
  return "built-in";
}

/**
 * Degraded-mode explainer for unsupported hosts.
 * Never claims structured support; points at the explicit CLI fallback.
 */
export function describeDegradedMode(input: {
  structured?: boolean;
  bridgeVersion?: string;
  reasons?: readonly string[];
}): { title: string; body: string } {
  if (input.structured === true) {
    return { title: "Bridge ready", body: "Structured editing is available." };
  }
  const reasons = (input.reasons ?? []).join(" ");
  return {
    title: "Degraded (read-only CLI fallback)",
    body: `Structured bridge unreachable (bridge ${input.bridgeVersion ?? "1.0.0"}). ${reasons} Live editing stays disabled; use the explicit terminal action for read-only CLI commands. Mutations require the structured bridge — never a hidden store.`.trim(),
  };
}

/**
 * Whether the editor must block saves for a builtin-named profile.
 *
 * Never blocks: the core mutation contract supports `patch`/`set --scope
 * <user|project>` on an effective builtin to create/update that layer's
 * override — only the compiled builtin source itself is immutable (and the
 * server enforces `builtin-immutable` for deletes with no override plus
 * `already-exists` for creates that shadow). The UI therefore always
 * allows saving builtin-named profiles into the selected user/project
 * layer; destructive base deletes stay server-gated. Kept as a predicate
 * (always false) so callers cannot reintroduce name-based blocking.
 */
export function isBuiltinSaveBlocked(_profileName: string, _mode: "edit" | "create" | "clone"): boolean {
  void _profileName;
  void _mode;
  return false;
}

/** Guard text for builtins (override semantics, never a Save block). */
export function builtinGuardText(name: string): string {
  return `Built-in base "${name}" is immutable, but you can customize it here: saving creates/updates only the selected user/project layer override (builtins < user < project). Clone only when you need a new profile name; the server still rejects deleting the builtin base with no override.`;
}

/** Validate unknown bridge list payloads into list items (never throws). */
export function toListItems(payload: unknown): ControlCenterListItem[] {
  if (!isPlainRecord(payload)) return [];
  const raw =
    (payload as { summaries?: unknown; panel?: unknown }).summaries ??
    (payload as { profiles?: unknown }).profiles ??
    (payload as { panel?: { profiles?: unknown } }).panel;
  const list: unknown =
    Array.isArray(raw) ? raw : isPlainRecord(raw) && Array.isArray((raw as { profiles?: unknown }).profiles)
      ? (raw as { profiles: unknown[] }).profiles
      : [];
  if (!Array.isArray(list)) return [];
  const out: ControlCenterListItem[] = [];
  for (const entry of list) {
    if (!isPlainRecord(entry) || typeof entry["name"] !== "string") continue;
    const rec = entry as Record<string, unknown>;
    out.push({
      name: rec["name"] as string,
      ...(typeof rec["displayName"] === "string" ? { displayName: rec["displayName"] } : {}),
      ...(typeof rec["provider"] === "string" ? { provider: rec["provider"] } : {}),
      ...(typeof rec["model"] === "string" ? { model: rec["model"] } : {}),
      thinking: typeof rec["thinking"] === "string" ? (rec["thinking"] as string) : "medium",
      ...(typeof rec["toolCount"] === "number" ? { toolCount: rec["toolCount"] } : {}),
      ...(Array.isArray(rec["tools"]) ? { tools: rec["tools"] as readonly string[] } : {}),
      skillNames: Array.isArray(rec["skillNames"]) ? (rec["skillNames"] as readonly string[]) : [],
      skillCount: typeof rec["skillCount"] === "number" ? (rec["skillCount"] as number) : 0,
      extensionCount: typeof rec["extensionCount"] === "number" ? (rec["extensionCount"] as number) : 0,
      contextFiles: rec["contextFiles"] === true,
      extendsChain: Array.isArray(rec["extendsChain"]) ? (rec["extendsChain"] as readonly string[]) : [],
      ...(typeof rec["extends"] === "string" ? { extends: rec["extends"] } : {}),
      ...(typeof rec["githubIdentity"] === "string" ? { githubIdentity: rec["githubIdentity"] } : {}),
      ...(rec["layer"] === "builtin" || rec["layer"] === "user" || rec["layer"] === "project"
        ? { layer: rec["layer"] }
        : {}),
      valid: rec["valid"] !== false,
      ...(typeof rec["validationError"] === "string" ? { validationError: rec["validationError"] } : {}),
    });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Orchestration role→profile mapping (UI1.4)
//
// Pure helpers for the Orca-native orchestration configuration UI. Orca owns
// task/DAG/worktree/run lifecycle; Orca-Pi owns only Pi-specific execution
// policy (which Pi profile backs each logical role). All mutations route
// through the authoritative orchestration service via `orchestration.set`
// with explicit user/project scope + source hash; the panel never writes
// files directly and never stores a second copy of the mapping.
//
// Backend model (v1, from `@orca-pi/core` orchestration/config.ts):
// - Builtins (lowest layer): worker→worker, scout→scout, reviewer→reviewer.
// - user/global (`orchestration.json` alongside profiles) < project
//   (`<projectRoot>/.pi/orchestration.json`); project wins.
// - Custom named roles are supported (same `[a-z0-9-]+` grammar); they act
//   as extensible preset slots. There is no separate team-preset store in
//   v1 — team presets/DAG remain Orca-native and are never duplicated here.
// - Dangling refs never throw at read time so the UI can surface them
//   before launch via `invalidRefs` / known-profile comparison.
// ---------------------------------------------------------------------------

/** Built-in orchestration roles (lowest layer, always present). */
export const ORCHESTRATION_BUILTIN_ROLES = ["worker", "scout", "reviewer"] as const;

/** Ownership boundary shown in the UI (never duplicate Orca surfaces). */
export const ORCHESTRATION_OWNERSHIP_NOTE =
  "Orca owns task/DAG/worktree/run lifecycle; Orca-Pi owns only role→profile policy.";

/** Resolution chain shown alongside every launch preview. */
export const ORCHESTRATION_CHAIN_LABEL =
  "Orchestration role mapping → profile → user/project profile layers → effective launch";

/** Scope for orchestration writes. Never inferred — always explicit. */
export type OrchestrationScope = "user" | "project";

/** One normalized role→profile row for the mapping table. */
export interface OrchestrationItem {
  role: string;
  profile: string;
  provenance: "builtin" | "user" | "project";
  /** True when the referenced profile has no matching Pi profile. */
  invalid: boolean;
}

/** True for shipped role defaults (worker/scout/reviewer). */
export function isBuiltinOrchestrationRole(role: string): boolean {
  return (ORCHESTRATION_BUILTIN_ROLES as readonly string[]).includes(role);
}

const ORCH_ROLE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Canonical Pi profile-name grammar (mirrors core profile/schema.ts); role names stay narrow. */
const ORCH_PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const ORCH_MAX_NAME = 64;
const ORCH_RESERVED = new Set(["__proto__", "prototype", "constructor"]);

/** Validate one role name against the backend grammar (mirrors core). */
export function validateOrchestrationRole(role: unknown): string | undefined {
  if (typeof role !== "string" || role.length === 0) return "expected a role name (e.g. \"worker\", \"scout\", \"reviewer\").";
  if (ORCH_RESERVED.has(role)) return "reserved name: never use \"__proto__\", \"constructor\", or \"prototype\".";
  if (role.length > ORCH_MAX_NAME || !ORCH_ROLE_PATTERN.test(role)) {
    return `use 1-${ORCH_MAX_NAME} chars matching [a-z0-9]+(-[a-z0-9]+)* (e.g. "worker-fast").`;
  }
  return undefined;
}

/** Validate one profile reference against the canonical Pi profile grammar (letters/digits/_/-). */
export function validateOrchestrationProfileRef(ref: unknown): string | undefined {
  if (typeof ref !== "string" || ref.length === 0) return "expected a Pi profile name (e.g. \"worker-fast\").";
  if (ORCH_RESERVED.has(ref)) return "reserved name: never use \"__proto__\", \"constructor\", or \"prototype\".";
  if (ref.length > ORCH_MAX_NAME || !ORCH_PROFILE_PATTERN.test(ref)) {
    return `use 1-${ORCH_MAX_NAME} chars matching [A-Za-z0-9][A-Za-z0-9_-]* (e.g. "worker-fast", "Worker_Fast"). Roles stay narrow; profile refs accept the full Pi grammar.`;
  }
  return undefined;
}

/** Client-side shape checks for the orchestration draft (server remains authoritative). */
export function validateOrchestrationDraft(draft: { role?: unknown; profile?: unknown }): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const roleErr = draft.role !== undefined ? validateOrchestrationRole(draft.role) : "expected a role name.";
  if (roleErr) issues.push({ field: "role", message: roleErr });
  const profileErr = draft.profile !== undefined ? validateOrchestrationProfileRef(draft.profile) : "expected a Pi profile name.";
  if (profileErr) issues.push({ field: "profile", message: profileErr });
  return issues;
}

/**
 * Build `orchestration.set` params for one role→profile mapping.
 * - `expectedSourceHash`: SHA-256 of the scope file as last seen (optimistic concurrency).
 * - `expectedAbsent: true` asserts the scope file is still absent (fresh installs).
 * Never includes shell strings; scope is always explicit.
 */
export function buildOrchestrationSetParams(options: {
  role: string;
  profile: string;
  scope: OrchestrationScope;
  expectedSourceHash?: string | null;
  expectedAbsent?: boolean;
}): Record<string, unknown> {
  const { role, profile, scope } = options;
  const hash =
    options.expectedSourceHash !== undefined
      ? { expectedSourceHash: options.expectedSourceHash }
      : options.expectedAbsent === true
        ? { expectedAbsent: true }
        : {};
  return { role, profile, scope, ...hash };
}

/**
 * Build `orchestration.set` params that clear one role override
 * (`clear: true` falls back to the lower layer; builtins can never be
 * deleted, only overridden). Same versioning contract as set.
 */
export function buildOrchestrationClearParams(options: {
  role: string;
  scope: OrchestrationScope;
  expectedSourceHash?: string | null;
  expectedAbsent?: boolean;
}): Record<string, unknown> {
  const { role, scope } = options;
  const hash =
    options.expectedSourceHash !== undefined
      ? { expectedSourceHash: options.expectedSourceHash }
      : options.expectedAbsent === true
        ? { expectedAbsent: true }
        : {};
  return { role, scope, clear: true, ...hash };
}

function asProvenance(value: unknown): "builtin" | "user" | "project" {
  if (value === "user" || value === "project") return value;
  return "builtin";
}

/**
 * Normalize an unknown `orchestration.get` payload into table rows (never throws).
 * Accepts the bridge shape `{effective|roles, provenance, invalidRefs?}` plus
 * the raw `{roles}` file shape. `knownProfiles` (from `profiles.list`) marks
 * `invalid` when the payload carries no `invalidRefs` of its own, so deleted
 * profiles surface before launch instead of hiding the config.
 * Sort: worker/scout/reviewer first (builtin order), then custom roles alpha.
 */
export function toOrchestrationItems(payload: unknown, knownProfiles?: readonly string[]): OrchestrationItem[] {
  if (!isPlainRecord(payload)) return [];
  const rec = payload as Record<string, unknown>;
  const mappingRaw =
    (isPlainRecord(rec["effective"]) ? rec["effective"] : undefined) ??
    (isPlainRecord(rec["roles"]) ? rec["roles"] : undefined) ??
    (isPlainRecord(rec["mapping"]) ? rec["mapping"] : undefined);
  if (!isPlainRecord(mappingRaw)) return [];
  const provenanceRaw = isPlainRecord(rec["provenance"]) ? (rec["provenance"] as Record<string, unknown>) : {};
  const hasInvalidRefs = Array.isArray(rec["invalidRefs"]);
  const invalidSet = new Set<string>(
    hasInvalidRefs ? (rec["invalidRefs"] as unknown[]).filter((r): r is string => typeof r === "string") : [],
  );
  const known = knownProfiles !== undefined ? new Set(knownProfiles) : undefined;
  const out: OrchestrationItem[] = [];
  for (const [role, profile] of Object.entries(mappingRaw)) {
    if (typeof profile !== "string") continue;
    if (validateOrchestrationRole(role) !== undefined) continue;
    const provenance = asProvenance(provenanceRaw[role]);
    // Trust the bridge's invalidRefs when provided (even when empty = all
    // valid). Fall back to known-profile comparison only when the payload
    // carries no invalidRefs of its own and the known list is non-empty —
    // an empty known list means profiles haven't loaded yet, never "all invalid".
    const invalid =
      invalidSet.has(role) || (!hasInvalidRefs && known !== undefined && known.size > 0 && !known.has(profile));
    out.push({ role, profile, provenance, invalid });
  }
  const builtinOrder = new Map<string, number>(
    (ORCHESTRATION_BUILTIN_ROLES as readonly string[]).map((r, i) => [r, i]),
  );
  out.sort((a, b) => {
    const ao = builtinOrder.has(a.role) ? (builtinOrder.get(a.role) as number) : 1000;
    const bo = builtinOrder.has(b.role) ? (builtinOrder.get(b.role) as number) : 1000;
    if (ao !== bo) return ao - bo;
    return a.role < b.role ? -1 : a.role > b.role ? 1 : 0;
  });
  return out;
}

/**
 * Read one layer's authoritative role value from an `orchestration.get`
 * payload (never throws). Returns the layer's own entry when present,
 * otherwise undefined (no override in that layer — the effective winner
 * comes from a lower layer). Editors must initialize from this, never
 * from the merged effective value, so saving the user layer cannot copy
 * the project winner into it.
 */
export function orchestrationLayerValue(
  payload: unknown,
  role: string,
  scope: OrchestrationScope,
): string | undefined {
  if (!isPlainRecord(payload) || typeof role !== "string") return undefined;
  if (scope !== "user" && scope !== "project") return undefined;
  const layers = (payload as Record<string, unknown>)["layers"];
  if (!isPlainRecord(layers)) return undefined;
  const layer = layers[scope];
  if (!isPlainRecord(layer)) return undefined;
  const value = (layer as Record<string, unknown>)[role];
  return typeof value === "string" ? value : undefined;
}

/** Human layer label for the mapping table. */
export function describeOrchestrationProvenance(prov: OrchestrationItem["provenance"] | undefined): string {
  if (prov === "project") return "project (.pi/orchestration.json)";
  if (prov === "user") return "user/global (orchestration.json)";
  return "built-in defaults";
}

/** One-line resolution chain for a role (shown beside every launch preview). */
export function describeOrchestrationChain(role: string, profile: string): string {
  return `Role "${role}" → profile "${profile}" → user/project profile layers → effective launch (${ORCHESTRATION_CHAIN_LABEL}).`;
}

/** Summary line for the mapping table (valid vs invalid before launch). */
export function orchestrationInvalidSummary(items: readonly OrchestrationItem[]): string {
  const invalid = items.filter((i) => i.invalid);
  if (invalid.length === 0) return `all ${items.length} mapping(s) valid (every referenced profile exists).`;
  return `${invalid.length} invalid reference(s): ${invalid.map((i) => `${i.role}→${i.profile}`).join(", ")} — fix before launch.`;
}

/**
 * Map a bridge error for `orchestration.set` onto editor UX.
 * `conflict` → reload/compare (never silent overwrite). `validation` with a
 * dotted field → short field (`role`/`profile`/`scope`); everything else →
 * `_global` with the server message intact.
 */
export function mapOrchestrationErrorToField(error: {
  code?: unknown;
  message?: unknown;
  field?: unknown;
  retryable?: unknown;
}): MappedBridgeError {
  const code = typeof error.code === "string" ? error.code : "internal";
  const message = typeof error.message === "string" && error.message.length > 0 ? error.message : "Request failed.";
  const kind = (
    ["validation", "conflict", "unsupported", "auth/setup", "internal", "not-found", "already-exists"] as const
  ).includes(code as BridgeErrorKind)
    ? (code as BridgeErrorKind)
    : "internal";
  const retryable = error.retryable === true || kind === "conflict";
  const isConflict = kind === "conflict";
  let field = "_global";
  const rawField = typeof error.field === "string" ? error.field : undefined;
  if (rawField) {
    const short = rawField.split(".").pop() ?? rawField;
    if (short === "role" || short === "profile" || short === "scope") field = short;
    else field = rawField;
  } else {
    const match = /role\s+"([^"]+)"|profile\s+"([^"]+)"/i.exec(message);
    if (match) field = match[1] !== undefined ? "role" : "profile";
  }
  return { kind, message, field, retryable, isConflict };
}

// ---------------------------------------------------------------------------
// GitHub identities + Diagnostics (UI1.5)
//
// Pure helpers for the Control Center GitHub and Diagnostics sections.
// All live data flows through the versioned bridge (`github.status`,
// `github.doctor`, `diagnostics.doctor` plus `profiles.list` /
// `orchestration.get` / `profile.validate` / `worktree.context` for
// mapped profiles and config/worktree context). The panel never mints
// tokens, never handles private keys, and never displays secret values:
// every helper below shapes redacted status only (identity names, source
// labels, expiry timestamps, permission names, setup var names — never
// token/key/secret values). Mint/refresh stays outside the panel via
// `orca-pi github mint` (operator, outside LLM context).
//
// Actor model (from docs/GITHUB_IDENTITIES.md):
//   worker bot != reviewer bot != 44madfire (human/ChatGPT review actor).
// 44madfire is a review actor with final merge authority — never a
// credential slot. The UI renders it as such and never offers a token
// status row for it.
// ---------------------------------------------------------------------------

/** Logical credential slots the GitHub section tracks (never secrets). */
export const GITHUB_IDENTITIES = ["worker", "reviewer"] as const;

/** Human/ChatGPT review actor (review actor, never a credential slot). */
export const HUMAN_REVIEW_ACTOR = "44madfire";

/** Ownership note for the human review actor (never a token row). */
export const REVIEW_ACTOR_NOTE =
  "Human/ChatGPT review actor 44madfire holds final merge authority — a review actor, never a credential slot (worker bot != reviewer bot != 44madfire).";

/** Default repository + ambient actor for doctor/access-test workflows. */
export const GITHUB_DEFAULT_REPO = "44madfire/orca-pi";
export const GITHUB_DEFAULT_AMBIENT = HUMAN_REVIEW_ACTOR;

/** Redacted per-identity credential health (from `github.status`). */
export interface GithubStatusItem {
  identity: string;
  configured: boolean;
  sourceLabel: string;
  expiresAt?: string;
  expired?: boolean;
}

/** Redacted per-identity doctor entry (from `github.doctor`). */
export interface GithubDoctorItem {
  identity: string;
  configured: boolean;
  sourceLabel: string;
  expiresAt?: string;
  expired?: boolean;
  expectedPermissions: { contents: string; pullRequests: string; checks: string; metadata: string };
  appLogin?: string;
  appLoginConfigured: boolean;
  installationId?: string;
  installationIdConfigured: boolean;
  tokenRefreshable: boolean;
  refreshVars: { appIdVar: string; keyVar: string; installationVar: string };
  iatProved?: boolean;
  iatError?: string;
  repoAccess?: boolean;
  repoError?: string;
  permissionsValid?: boolean;
  permissionDetail?: string;
}

/** Distinct-actor summary (worker bot != reviewer bot != human). */
export interface GithubActorSummary {
  workerLogin?: string;
  reviewerLogin?: string;
  ambientLogin: string;
  distinctWorkerReviewer?: boolean;
  distinctFromAmbient?: boolean;
  distinctDetail: string;
  ok: boolean;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Normalize an unknown `github.status` payload into per-identity rows
 * (never throws). Accepts the bridge shape `{identities: {...}}`.
 * Sort: worker/reviewer first (canonical order), then custom alpha.
 * Only allowlisted redacted fields survive — token/key values never pass
 * through (the bridge is already redacted; this shapes display rows).
 */
export function toGithubStatusItems(payload: unknown): GithubStatusItem[] {
  if (!isPlainRecord(payload)) return [];
  const raw = (payload as Record<string, unknown>)["identities"];
  if (!isPlainRecord(raw)) return [];
  const out: GithubStatusItem[] = [];
  for (const [identity, entry] of Object.entries(raw)) {
    if (!isPlainRecord(entry)) continue;
    if (typeof identity !== "string" || identity.length === 0 || identity.length > 64) continue;
    const rec = entry as Record<string, unknown>;
    const configured = rec["configured"] === true;
    const sourceLabel = asNonEmptyString(rec["sourceLabel"]) ?? "(unknown source)";
    out.push({
      identity,
      configured,
      sourceLabel,
      ...(asNonEmptyString(rec["expiresAt"]) !== undefined ? { expiresAt: rec["expiresAt"] as string } : {}),
      ...(asBoolean(rec["expired"]) !== undefined ? { expired: rec["expired"] as boolean } : {}),
    });
  }
  const order = new Map<string, number>(GITHUB_IDENTITIES.map((id, i) => [id, i]));
  out.sort((a, b) => {
    const ao = order.has(a.identity) ? (order.get(a.identity) as number) : 1000;
    const bo = order.has(b.identity) ? (order.get(b.identity) as number) : 1000;
    if (ao !== bo) return ao - bo;
    return a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0;
  });
  return out;
}

/**
 * Merge a (possibly role-scoped/partial) `github.status` payload into the
 * existing panel snapshot (never throws). `github.status({identity})`
 * intentionally returns only that identity; the panel must fold the
 * partial map into the previous snapshot so a scoped refresh never hides
 * the sibling identity. `next` wins per identity; other identities,
 * `redacted`, and `note` carry over when `next` omits them. Only
 * allowlisted redacted entry shapes survive (identity-keyed records) —
 * anything else is dropped, never rendered.
 */
export function mergeGithubStatusSnapshots(prev: unknown, next: unknown): Record<string, unknown> {
  const prevRec = isPlainRecord(prev) ? (prev as Record<string, unknown>) : {};
  const nextRec = isPlainRecord(next) ? (next as Record<string, unknown>) : {};
  const prevIdentities = isPlainRecord(prevRec["identities"]) ? (prevRec["identities"] as Record<string, unknown>) : {};
  const nextIdentities = isPlainRecord(nextRec["identities"]) ? (nextRec["identities"] as Record<string, unknown>) : {};
  const merged: Record<string, unknown> = {};
  const put = (identity: string, entry: unknown): void => {
    if (typeof identity !== "string" || identity.length === 0 || identity.length > 64) return;
    if (!isPlainRecord(entry)) return;
    merged[identity] = entry;
  };
  for (const [identity, entry] of Object.entries(prevIdentities)) put(identity, entry);
  for (const [identity, entry] of Object.entries(nextIdentities)) put(identity, entry);
  const out: Record<string, unknown> = { identities: merged };
  const redacted = nextRec["redacted"] !== undefined ? nextRec["redacted"] : prevRec["redacted"];
  if (typeof redacted === "boolean") out["redacted"] = redacted;
  const note = typeof nextRec["note"] === "string" ? nextRec["note"] : prevRec["note"];
  if (typeof note === "string" && note.length > 0) out["note"] = note;
  const profile = typeof nextRec["profile"] === "string" ? nextRec["profile"] : undefined;
  if (profile !== undefined) out["profile"] = profile;
  return out;
}

function toExpectedPermissions(value: unknown): GithubDoctorItem["expectedPermissions"] {
  const fallback = { contents: "?", pullRequests: "?", checks: "?", metadata: "read" };
  if (!isPlainRecord(value)) return fallback;
  const rec = value as Record<string, unknown>;
  const pick = (key: string): string => (typeof rec[key] === "string" && (rec[key] as string).length > 0 ? (rec[key] as string) : "?");
  return { contents: pick("contents"), pullRequests: pick("pullRequests"), checks: pick("checks"), metadata: pick("metadata") };
}

/**
 * Normalize an unknown `github.doctor` report into per-identity rows
 * (never throws). Accepts the core `GithubDoctorReport` shape
 * (`{worker, reviewer, ...}`). Missing halves are omitted (never
 * synthesized) so partial reports render honestly.
 */
export function toGithubDoctorItems(report: unknown): GithubDoctorItem[] {
  if (!isPlainRecord(report)) return [];
  const out: GithubDoctorItem[] = [];
  for (const key of GITHUB_IDENTITIES) {
    const entry = (report as Record<string, unknown>)[key];
    if (!isPlainRecord(entry)) continue;
    const rec = entry as Record<string, unknown>;
    const refreshRaw = isPlainRecord(rec["refreshVars"]) ? (rec["refreshVars"] as Record<string, unknown>) : {};
    out.push({
      identity: typeof rec["identity"] === "string" && (rec["identity"] as string).length > 0 ? (rec["identity"] as string) : key,
      configured: rec["configured"] === true,
      sourceLabel: asNonEmptyString(rec["sourceLabel"]) ?? "(unknown source)",
      ...(asNonEmptyString(rec["expiresAt"]) !== undefined ? { expiresAt: rec["expiresAt"] as string } : {}),
      ...(asBoolean(rec["expired"]) !== undefined ? { expired: rec["expired"] as boolean } : {}),
      expectedPermissions: toExpectedPermissions(rec["expectedPermissions"]),
      ...(asNonEmptyString(rec["appLogin"]) !== undefined ? { appLogin: rec["appLogin"] as string } : {}),
      appLoginConfigured: rec["appLoginConfigured"] === true,
      ...(asNonEmptyString(rec["installationId"]) !== undefined ? { installationId: rec["installationId"] as string } : {}),
      installationIdConfigured: rec["installationIdConfigured"] === true,
      tokenRefreshable: rec["tokenRefreshable"] === true,
      refreshVars: {
        appIdVar: asNonEmptyString(refreshRaw["appIdVar"]) ?? `ORCA_PI_GITHUB_${key.toUpperCase()}_APP_ID`,
        keyVar: asNonEmptyString(refreshRaw["keyVar"]) ?? `ORCA_PI_GITHUB_${key.toUpperCase()}_PRIVATE_KEY_PATH`,
        installationVar: asNonEmptyString(refreshRaw["installationVar"]) ?? `ORCA_PI_GITHUB_${key.toUpperCase()}_INSTALLATION_ID`,
      },
      ...(asBoolean(rec["iatProved"]) !== undefined ? { iatProved: rec["iatProved"] as boolean } : {}),
      ...(asNonEmptyString(rec["iatError"]) !== undefined ? { iatError: rec["iatError"] as string } : {}),
      ...(asBoolean(rec["repoAccess"]) !== undefined ? { repoAccess: rec["repoAccess"] as boolean } : {}),
      ...(asNonEmptyString(rec["repoError"]) !== undefined ? { repoError: rec["repoError"] as string } : {}),
      ...(asBoolean(rec["permissionsValid"]) !== undefined ? { permissionsValid: rec["permissionsValid"] as boolean } : {}),
      ...(asNonEmptyString(rec["permissionDetail"]) !== undefined ? { permissionDetail: rec["permissionDetail"] as string } : {}),
    });
  }
  return out;
}

/**
 * Extract the distinct-actor summary from a `github.doctor` report
 * (never throws). The ambient login defaults to 44madfire (human/ChatGPT
 * review actor) when the report carries none, so the UI always shows the
 * three-actor invariant even before a doctor run with `--ambient`.
 */
export function toGithubActorSummary(report: unknown, fallbackAmbient?: string): GithubActorSummary | undefined {
  if (!isPlainRecord(report)) return undefined;
  const rec = report as Record<string, unknown>;
  const workerLogin = asNonEmptyString(rec["workerLogin"]);
  const reviewerLogin = asNonEmptyString(rec["reviewerLogin"]);
  const ambientLogin = asNonEmptyString(rec["ambientLogin"]) ?? asNonEmptyString(fallbackAmbient) ?? HUMAN_REVIEW_ACTOR;
  const distinctDetail =
    asNonEmptyString(rec["distinctDetail"]) ??
    (workerLogin && reviewerLogin
      ? `${workerLogin} != ${reviewerLogin} != ${ambientLogin}`
      : `actor distinctness unknown (configure worker/reviewer App logins outside LLM context; human review actor ${ambientLogin} holds final merge authority)`);
  const dwr = asBoolean(rec["distinctWorkerReviewer"]);
  const dfa = asBoolean(rec["distinctFromAmbient"]);
  const ok = rec["ok"] === true;
  return {
    ...(workerLogin !== undefined ? { workerLogin } : {}),
    ...(reviewerLogin !== undefined ? { reviewerLogin } : {}),
    ambientLogin,
    ...(dwr !== undefined ? { distinctWorkerReviewer: dwr } : {}),
    ...(dfa !== undefined ? { distinctFromAmbient: dfa } : {}),
    distinctDetail,
    ok,
  };
}

/** One-line redacted health for a status row (never includes secrets). */
export function describeGithubStatusItem(item: GithubStatusItem): string {
  if (item.expired === true) return `${item.identity}: expired (see ${item.sourceLabel}) — mint a fresh installation token outside LLM context.`;
  if (!item.configured) return `${item.identity}: missing (see ${item.sourceLabel}) — run \`orca-pi github setup --identity ${item.identity}\` for operator steps.`;
  const expiry = item.expiresAt ? ` (expires ${item.expiresAt})` : "";
  return `${item.identity}: configured via ${item.sourceLabel}${expiry}.`;
}

/** Token freshness without secrets (source class + expiry only). */
export function describeTokenFreshness(item: Pick<GithubStatusItem, "sourceLabel" | "expiresAt" | "expired" | "configured">): string {
  if (item.expired === true) return `expired (see ${item.sourceLabel})`;
  if (!item.configured) return `missing (see ${item.sourceLabel})`;
  if (item.expiresAt) return `fresh via ${item.sourceLabel} (expires ${item.expiresAt})`;
  return `configured via ${item.sourceLabel}`;
}

/** One-line doctor summary for an identity (permissions + repo + proof). */
export function describeGithubDoctorItem(item: GithubDoctorItem): string {
  const parts: string[] = [];
  parts.push(item.configured ? `configured via ${item.sourceLabel}` : `missing (see ${item.sourceLabel})`);
  if (item.expired === true) parts.push("token expired");
  else if (item.expiresAt) parts.push(`expires ${item.expiresAt}`);
  parts.push(`expected contents=${item.expectedPermissions.contents} pull_requests=${item.expectedPermissions.pullRequests} checks=${item.expectedPermissions.checks}`);
  parts.push(`app ${item.appLogin ?? "(missing login)"} / installation ${item.installationId ?? "(missing id)"}`);
  parts.push(item.tokenRefreshable ? "refreshable via App config" : `not refreshable (missing ${item.refreshVars.appIdVar} / ${item.refreshVars.keyVar})`);
  if (item.iatProved !== undefined) parts.push(item.iatProved ? "installation-token proof ok" : `proof FAILED — ${item.iatError ?? "see iatError"}`);
  if (item.repoAccess !== undefined) {
    if (item.repoAccess && item.permissionsValid !== false) parts.push("repo access ok");
    else if (item.repoAccess && item.permissionsValid === false) parts.push(`repo access ok but ${item.permissionDetail ?? "permission mismatch"}`);
    else parts.push(`repo access FAILED — ${item.repoError ?? item.permissionDetail ?? "see detail"}`);
  }
  return parts.join("; ");
}

/** Human review-actor line (44madfire is an actor, never a slot). */
export function describeReviewActor(summary: GithubActorSummary): string {
  const base =
    summary.workerLogin && summary.reviewerLogin
      ? `${summary.workerLogin} != ${summary.reviewerLogin} != ${summary.ambientLogin} : ${summary.distinctWorkerReviewer && summary.distinctFromAmbient ? "distinct (ok)" : "NOT distinct (fix App installs)"}`
      : `worker/reviewer logins unconfigured; human review actor ${summary.ambientLogin} holds final merge authority (distinctness unknown until App logins are set outside LLM context)`;
  return `${base} — ${REVIEW_ACTOR_NOTE}`;
}

/** Actionable setup errors from a doctor report (never throws). */
export function githubSetupActions(report: unknown): string[] {
  if (!isPlainRecord(report)) return [];
  const raw = (report as Record<string, unknown>)["setupNeeded"];
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[]).filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

const GITHUB_STATUS_IDENTITY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const GITHUB_STATUS_PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const GITHUB_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?(?:\[bot\])?$/;

/**
 * Client-side shape checks for `github.doctor` inputs (server authoritative).
 * `repo` must be `owner/repo`; `ambient` must be a GitHub login (human
 * review actor, e.g. 44madfire). Empty means shape-ok.
 */
export function validateGithubDoctorParams(input: { repo?: unknown; ambient?: unknown }): DraftIssue[] {
  const issues: DraftIssue[] = [];
  if (input.repo !== undefined && input.repo !== null && input.repo !== "") {
    if (typeof input.repo !== "string" || !GITHUB_REPO_RE.test(input.repo.trim())) {
      issues.push({ field: "repo", message: 'expected "owner/repo" (e.g. "44madfire/orca-pi").' });
    }
  }
  if (input.ambient !== undefined && input.ambient !== null && input.ambient !== "") {
    if (typeof input.ambient !== "string" || !GITHUB_LOGIN_RE.test(input.ambient.trim())) {
      issues.push({ field: "ambient", message: 'expected a GitHub login (e.g. "44madfire"); human review actor, never a secret.' });
    }
  }
  return issues;
}

/**
 * Build `github.status` params with explicit role scope.
 * - `{identity}` refreshes one slot (worker/reviewer/custom).
 * - `{profile}` inherits the profile's `githubIdentity` server-side.
 * - `{}` refreshes worker+reviewer (server default).
 * Never includes secrets; identity/profile grammars mirror the backend.
 */
export function buildGithubStatusParams(options?: { identity?: string; profile?: string }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (options?.identity !== undefined && options.identity !== "") {
    if (!GITHUB_STATUS_IDENTITY_RE.test(options.identity)) {
      throw new Error(`Invalid github identity ${JSON.stringify(options.identity)}: expected 1-64 chars matching [A-Za-z0-9_-] (e.g. "worker", "reviewer").`);
    }
    out["identity"] = options.identity;
  }
  if (options?.profile !== undefined && options.profile !== "") {
    if (options.profile.length > 64 || !GITHUB_STATUS_PROFILE_RE.test(options.profile)) {
      throw new Error(`Invalid profile name ${JSON.stringify(options.profile)}: expected 1-64 chars matching [A-Za-z0-9][A-Za-z0-9_-]*.`);
    }
    out["profile"] = options.profile;
  }
  return out;
}

/**
 * Build `github.doctor` params (repo access-test + ambient actor).
 * Omits empty fields so `{}` runs the offline doctor (no repo proof).
 * `repo` is the repository access-test target; `ambient` is the human
 * review actor login (default 44madfire shown in the UI, sent only when
 * explicitly set — the server falls back to GITHUB_ACTOR).
 */
export function buildGithubDoctorParams(options?: { repo?: string; ambient?: string }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const repo = options?.repo?.trim() ?? "";
  if (repo.length > 0) {
    if (!GITHUB_REPO_RE.test(repo)) {
      throw new Error(`Invalid repo ${JSON.stringify(options?.repo)}: expected "owner/repo" (e.g. "44madfire/orca-pi").`);
    }
    out["repo"] = repo;
  }
  const ambient = options?.ambient?.trim() ?? "";
  if (ambient.length > 0) {
    if (!GITHUB_LOGIN_RE.test(ambient)) {
      throw new Error(`Invalid ambient login ${JSON.stringify(options?.ambient)}: expected a GitHub login (e.g. "44madfire").`);
    }
    out["ambient"] = ambient;
  }
  return out;
}

/**
 * Map a bridge error for `github.status` / `github.doctor` onto UI.
 * `repo`/`ambient`/`identity`/`profile` dotted fields map to short
 * fields; everything else → `_global` with the server message intact.
 */
export function mapGithubErrorToField(error: {
  code?: unknown;
  message?: unknown;
  field?: unknown;
  retryable?: unknown;
}): MappedBridgeError {
  const code = typeof error.code === "string" ? error.code : "internal";
  const message = typeof error.message === "string" && error.message.length > 0 ? error.message : "Request failed.";
  const kind = (
    ["validation", "conflict", "unsupported", "auth/setup", "internal", "not-found", "already-exists"] as const
  ).includes(code as BridgeErrorKind)
    ? (code as BridgeErrorKind)
    : "internal";
  const retryable = error.retryable === true || kind === "conflict";
  const isConflict = kind === "conflict";
  let field = "_global";
  const rawField = typeof error.field === "string" ? error.field : undefined;
  if (rawField) {
    const short = rawField.split(".").pop() ?? rawField;
    if (short === "repo" || short === "ambient" || short === "identity" || short === "profile") field = short;
    else field = rawField;
  }
  return { kind, message, field, retryable, isConflict };
}

/** One mapped profile row (role → profile → githubIdentity). */
export interface GithubMappedProfile {
  role: string;
  profile: string;
  githubIdentity?: string;
  invalid: boolean;
}

/**
 * Join orchestration roles with profile githubIdentity for the GitHub
 * section (never throws). `profiles` are `profiles.list` summaries (or
 * names); `orchItems` are `toOrchestrationItems` rows. Rows sort
 * worker/scout/reviewer first, then custom alpha — matching the
 * orchestration table. Unknown profiles surface as `invalid` instead of
 * hiding the mapping.
 */
export function toGithubMappedProfiles(
  profiles: readonly unknown[] | unknown,
  orchItems: readonly OrchestrationItem[],
): GithubMappedProfile[] {
  const identityByProfile = new Map<string, string>();
  const collect = (entry: unknown): void => {
    if (typeof entry === "string") return;
    if (!isPlainRecord(entry)) return;
    const rec = entry as Record<string, unknown>;
    const name = rec["name"];
    const identity = rec["githubIdentity"];
    if (typeof name === "string" && typeof identity === "string" && identity.length > 0) {
      identityByProfile.set(name, identity);
    }
  };
  if (Array.isArray(profiles)) {
    for (const entry of profiles) collect(entry);
  } else if (isPlainRecord(profiles)) {
    const rec = profiles as Record<string, unknown>;
    const list = Array.isArray(rec["summaries"]) ? rec["summaries"] : Array.isArray(rec["profiles"]) ? rec["profiles"] : undefined;
    if (Array.isArray(list)) for (const entry of list as unknown[]) collect(entry);
  }
  const out: GithubMappedProfile[] = [];
  for (const item of orchItems) {
    if (!item || typeof item.role !== "string" || typeof item.profile !== "string") continue;
    const identity = identityByProfile.get(item.profile);
    out.push({
      role: item.role,
      profile: item.profile,
      ...(identity !== undefined ? { githubIdentity: identity } : {}),
      invalid: item.invalid,
    });
  }
  return out;
}

/** Summary line for mapped profiles (valid vs invalid before launch). */
export function githubMappedSummary(rows: readonly GithubMappedProfile[]): string {
  if (rows.length === 0) return "no role→profile mappings loaded (refresh orchestration to see mapped Pi profiles).";
  const invalid = rows.filter((r) => r.invalid);
  const worker = rows.find((r) => r.role === "worker");
  const reviewer = rows.find((r) => r.role === "reviewer");
  const bits: string[] = [];
  bits.push(worker ? `worker→${worker.profile}${worker.githubIdentity ? ` (identity ${worker.githubIdentity})` : ""}` : "worker→(unmapped)");
  bits.push(reviewer ? `reviewer→${reviewer.profile}${reviewer.githubIdentity ? ` (identity ${reviewer.githubIdentity})` : ""}` : "reviewer→(unmapped)");
  if (invalid.length > 0) return `${invalid.length} invalid mapping(s): ${invalid.map((r) => `${r.role}→${r.profile}`).join(", ")} — fix before launch. (${bits.join("; ")})`;
  return `mapped profiles ok: ${bits.join("; ")}.`;
}

// ---------------------------------------------------------------------------
// Diagnostics display (UI1.5)
//
// The Diagnostics section aggregates redacted health the bridge already
// serves: `diagnostics.doctor` (orca/pi CLIs + bridge negotiation +
// versions), `profile.validate` (config), `worktree.context` (explicit
// scope), and `orchestration.get` (mapping validity). The panel combines
// them client-side; the bridge never shells out from panel code and the
// panel never scrapes CLI output.
// ---------------------------------------------------------------------------

/** Redacted CLI health for one executable (from `diagnostics.doctor.cli`). */
export interface DiagnosticsCliEntry {
  executable: string;
  found: boolean;
  version?: string;
  detail: string;
}

/**
 * Normalize `diagnostics.doctor` CLI health (never throws). Returns
 * undefined when the payload carries no CLI block (e.g. no runner
 * injected — the UI then points at `orca-pi doctor`).
 *
 * Details are sanitized via {@link sanitizeDiagnosticsDetail} (redact +
 * bound) so even a compromised bridge payload cannot smuggle runner
 * stdout/stderr secrets into the DOM — defense in depth behind the
 * bridge-host sanitize-before-return.
 */
export function toDiagnosticsCliHealth(payload: unknown): { orca: DiagnosticsCliEntry; pi: DiagnosticsCliEntry; ok: boolean } | undefined {
  if (!isPlainRecord(payload)) return undefined;
  const cli = (payload as Record<string, unknown>)["cli"];
  if (typeof cli === "string") return undefined;
  if (!isPlainRecord(cli)) return undefined;
  const rec = cli as Record<string, unknown>;
  const orcaRaw = rec["orca"];
  const piRaw = rec["pi"];
  if (!isPlainRecord(orcaRaw) || !isPlainRecord(piRaw)) return undefined;
  const entry = (raw: Record<string, unknown>, name: string): DiagnosticsCliEntry => ({
    executable: name,
    found: raw["found"] === true,
    ...(typeof raw["version"] === "string" && (raw["version"] as string).length > 0 ? { version: (raw["version"] as string).slice(0, 64) } : {}),
    detail: sanitizeDiagnosticsDetail(raw["detail"]),
  });
  const orca = entry(orcaRaw as Record<string, unknown>, "orca");
  const pi = entry(piRaw as Record<string, unknown>, "pi");
  return { orca, pi, ok: rec["ok"] === true };
}

/** One-line CLI health (agrees with `orca-pi doctor` output). */
export function describeDiagnosticsCli(health: { orca: DiagnosticsCliEntry; pi: DiagnosticsCliEntry; ok: boolean } | undefined): string {
  if (!health) return "CLI health unavailable in this response (no runner injected) — run `orca-pi doctor` for live orca/pi versions.";
  const orca = health.orca.version ? `orca ${health.orca.version}` : health.orca.found ? "orca (version unknown)" : "orca missing";
  const pi = health.pi.version ? `pi ${health.pi.version}` : health.pi.found ? "pi (version unknown)" : "pi missing";
  return health.ok ? `${orca}, ${pi} — ready (both CLIs available).` : `${orca}, ${pi} — action needed (run \`orca-pi doctor\` for details).`;
}

/**
 * Normalize `diagnostics.doctor` bridge negotiation (never throws).
 * Returns undefined when the payload carries no bridge block.
 */
export function toDiagnosticsBridgeHealth(payload: unknown):
  | { structured: boolean; degraded: boolean; versionsOk: boolean; consentOk: boolean; seamHandshake: boolean; supportedOperations: readonly string[]; reasons: string[] }
  | undefined {
  if (!isPlainRecord(payload)) return undefined;
  const bridge = (payload as Record<string, unknown>)["bridge"];
  if (!isPlainRecord(bridge)) return undefined;
  const rec = bridge as Record<string, unknown>;
  const supportedOperations = Array.isArray(rec["supportedOperations"])
    ? (rec["supportedOperations"] as unknown[]).filter((op): op is string => typeof op === "string")
    : [];
  const reasons = Array.isArray(rec["reasons"]) ? (rec["reasons"] as unknown[]).filter((r): r is string => typeof r === "string") : [];
  return {
    structured: rec["structured"] === true,
    degraded: rec["degraded"] !== false,
    versionsOk: rec["versionsOk"] === true,
    consentOk: rec["consentOk"] === true,
    seamHandshake: rec["seamHandshake"] === true,
    supportedOperations,
    reasons,
  };
}

/** Explicit worktree scope health (from `worktree.context`). */
export interface DiagnosticsWorktreeHealth {
  projectRoot: string;
  explicit: boolean;
  worktreeId?: string;
  terminalId?: string;
}

/**
 * Normalize `worktree.context` health (never throws). Returns undefined
 * when the payload is not a worktree context shape.
 */
export function toDiagnosticsWorktreeHealth(payload: unknown): DiagnosticsWorktreeHealth | undefined {
  if (!isPlainRecord(payload)) return undefined;
  const rec = payload as Record<string, unknown>;
  const projectRoot = rec["projectRoot"];
  if (typeof projectRoot !== "string" || projectRoot.length === 0) return undefined;
  return {
    projectRoot,
    explicit: rec["explicit"] === true,
    ...(typeof rec["worktreeId"] === "string" && (rec["worktreeId"] as string).length > 0
      ? { worktreeId: rec["worktreeId"] as string }
      : {}),
    ...(typeof rec["terminalId"] === "string" && (rec["terminalId"] as string).length > 0
      ? { terminalId: rec["terminalId"] as string }
      : {}),
  };
}

/** One-line worktree scope (explicit vs inferred). */
export function describeWorktreeHealth(health: DiagnosticsWorktreeHealth | undefined): string {
  if (!health) return "worktree scope unavailable (structured bridge unreachable or context not loaded).";
  const scope = health.explicit
    ? `explicit scope ${health.projectRoot} (captured at submission — delayed requests cannot be redirected)`
    : `implicit scope ${health.projectRoot} (reads only; mutations require explicit worktree.projectRoot)`;
  const extra =
    (health.worktreeId ? ` worktree ${health.worktreeId}` : "") + (health.terminalId ? ` terminal ${health.terminalId}` : "");
  return `${scope}.${extra}`;
}

/**
 * Normalize `profile.validate` health (never throws). Returns undefined
 * when the payload is not a validation shape — including when the
 * entries block is present but the explicit `ok` flag is missing
 * (malformed): callers treat unknown as pending/unavailable, never as
 * valid, so a malformed validate response can never yield a "ready"
 * headline (fail closed).
 */
export function toDiagnosticsConfigHealth(
  payload: unknown,
): { ok: boolean; invalidCount: number; total: number } | undefined {
  if (!isPlainRecord(payload)) return undefined;
  const rec = payload as Record<string, unknown>;
  const entries = rec["entries"];
  if (!Array.isArray(entries)) {
    if (typeof rec["ok"] === "boolean") return { ok: rec["ok"] === true, invalidCount: 0, total: 0 };
    return undefined;
  }
  if (typeof rec["ok"] !== "boolean") return undefined;
  const total = entries.length;
  let invalidCount = 0;
  for (const entry of entries as unknown[]) {
    if (isPlainRecord(entry) && entry["valid"] === false) invalidCount += 1;
  }
  // Trust the explicit server flag, but fail closed when it disagrees
  // with the entries (ok:true with invalid entries is still not-ready).
  const ok = (rec["ok"] as boolean) === true && invalidCount === 0;
  return { ok, invalidCount, total };
}

/** One-line config health (agrees with `orca-pi profile validate`). */
export function describeConfigHealth(health: { ok: boolean; invalidCount: number; total: number } | undefined): string {
  if (!health) return "profile config health unavailable (run `orca-pi profile validate` for file/source/field diagnostics).";
  if (health.total === 0) return health.ok ? "profiles: no entries reported (ok)." : "profiles: validation failed with no entries.";
  return health.ok
    ? `profiles: all ${health.total} valid (authoritative YAML; no second store).`
    : `profiles: ${health.invalidCount} invalid of ${health.total} — run \`orca-pi profile validate\` for file/source/field diagnostics.`;
}

/** Max chars of runner-derived diagnostics detail that may cross the bridge/DOM. */
export const DIAGNOSTICS_DETAIL_LIMIT = 500;

/**
 * Redact token/private-key material from free-form diagnostics text
 * (pure, never throws). Mirrors {@link containsSecretMaterial} patterns:
 * full PEM blocks collapse to `[redacted-private-key]`, token-like
 * shapes to `<redacted-token>`. Var-name labels (`*_TOKEN`) are left
 * intact — only values are redacted.
 */
export function redactDiagnosticsText(text: string): string {
  if (!text) return text;
  let out = text;
  out = out.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted-private-key]");
  out = out.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, "[redacted-private-key]");
  out = out.replace(/-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted-private-key]");
  out = out.replace(/\bghp_[A-Za-z0-9]{8,}/g, "<redacted-token>");
  out = out.replace(/\bgho_[A-Za-z0-9]{8,}/g, "<redacted-token>");
  out = out.replace(/\bghu_[A-Za-z0-9]{8,}/g, "<redacted-token>");
  out = out.replace(/\bghs_[A-Za-z0-9]{8,}/g, "<redacted-token>");
  out = out.replace(/\bghr_[A-Za-z0-9]{8,}/g, "<redacted-token>");
  out = out.replace(/\bgithub_pat_[A-Za-z0-9_]{8,}/g, "<redacted-token>");
  out = out.replace(/x-access-token:[^\s"']+/g, "<redacted-token>");
  return out;
}

/**
 * Sanitize runner-derived detail for bridge/DOM display (pure, never
 * throws): redacts explicit `secrets` values plus token/key patterns,
 * then bounds to `limit` chars. Non-string input yields `"(no detail)"`.
 * The bridge passes env-collected secrets; the panel passes none
 * (pattern redaction + bound only) as defense in depth.
 */
export function sanitizeDiagnosticsDetail(detail: unknown, limit: number = DIAGNOSTICS_DETAIL_LIMIT, secrets: readonly string[] = []): string {
  if (typeof detail !== "string" || detail.length === 0) return "(no detail)";
  let out = detail;
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue;
    out = out.split(secret).join("<redacted>");
  }
  out = redactDiagnosticsText(out);
  if (out.length <= limit) return out;
  return `${out.slice(0, limit)}… [truncated]`;
}

/**
 * Defensive secret scan for display text (pure). True when `text` carries
 * private-key material or token-like values that must never appear in
 * DOM/logs/errors. The panel renders only allowlisted redacted fields,
 * and tests assert this over every GitHub/diagnostics rendering.
 */
export function containsSecretMaterial(text: string): boolean {
  if (!text) return false;
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) return true;
  if (/\bghp_[A-Za-z0-9]{8,}/.test(text)) return true;
  if (/\bgho_[A-Za-z0-9]{8,}/.test(text)) return true;
  if (/\bghu_[A-Za-z0-9]{8,}/.test(text)) return true;
  if (/\bghs_[A-Za-z0-9]{8,}/.test(text)) return true;
  if (/\bghr_[A-Za-z0-9]{8,}/.test(text)) return true;
  if (/\bgithub_pat_[A-Za-z0-9_]{8,}/.test(text)) return true;
  if (/x-access-token:[^\s"']+/.test(text)) return true;
  return false;
}

/**
 * True when a bridge payload is secret-free for panel display (pure).
 * Stringifies the payload and runs {@link containsSecretMaterial} plus
 * token/private-key value shapes (`"*token*": "<non-empty>"` and
 * `"*private*key*": "<non-empty>"` with a secret-looking value).
 * Var-name labels (`*_TOKEN`, `sourceLabel`) never trigger — only values
 * do (mirrors the bridge-host defensive scan). Redacted reports use
 * `configured`/`sourceLabel`/`tokenRefreshable` booleans, never raw
 * `token`/key values, so any such key with a non-trivial string value
 * means a secret crossed the bridge.
 */
export function isSecretFreePayload(payload: unknown): boolean {
  let text: string;
  try {
    text = JSON.stringify(payload) ?? "";
  } catch {
    return false;
  }
  if (containsSecretMaterial(text)) return false;
  // Any `*token*` key with a non-trivial string value is a leak
  // (`token`, `ORCA_PI_GITHUB_WORKER_TOKEN`, ...). `sourceLabel` values
  // like `"sourceLabel": "ORCA_PI_GITHUB_WORKER_TOKEN"` never match
  // (key has no `token`), and `tokenRefreshable` booleans never match
  // (value is not a string) — so this stays precise while closing the
  // `*TOKEN*`-key hole the exact-`"token"` check missed.
  if (/"[^"]*token[^"]*"\s*:\s*"[^"]{8,}"/i.test(text)) return false;
  if (/"[^"]*private[_-]?key[^"]*"\s*:\s*"[^"]{8,}"/i.test(text)) return false;
  return true;
}

/** Overall diagnostics headline (CLI + bridge + config + worktree + GitHub). Unknown legs
 * (unavailable/pending/malformed/failed → undefined) are never ready:
 * they render as pending/unavailable, fail-closed like an explicit invalid.
 * The worktree leg must be an explicit healthy `worktree.context` result —
 * the headline never claims ready without a confirmed project/worktree scope.
 * The GitHub leg is required: missing/expired/attention-needed GitHub status
 * or github.doctor keeps the headline at action-needed, so the top-level
 * banner can never claim overall ready while GitHub needs attention. */
export function diagnosticsHeadline(input: {
  cli?: { ok: boolean } | undefined;
  bridge?: { structured: boolean } | undefined;
  config?: { ok: boolean } | undefined;
  worktree?: { ok: boolean } | undefined;
  github?: { ok: boolean } | undefined;
}): string {
  const cliOk = input.cli?.ok === true;
  const bridgeOk = input.bridge?.structured === true;
  const configOk = input.config?.ok === true;
  const configUnknown = input.config === undefined;
  const worktreeOk = input.worktree?.ok === true;
  const worktreeUnknown = input.worktree === undefined;
  const githubOk = input.github?.ok === true;
  const githubUnknown = input.github === undefined;
  if (cliOk && bridgeOk && configOk && worktreeOk && githubOk) return "diagnostics: ready — CLIs available, structured bridge reachable, config valid, worktree scope confirmed, GitHub identities healthy.";
  const parts: string[] = [];
  if (!cliOk) parts.push("CLIs need attention (run `orca-pi doctor`)");
  if (!bridgeOk) parts.push("bridge degraded (explicit CLI fallback)");
  if (configUnknown) parts.push("profiles validation pending/unavailable (run `orca-pi profile validate`)");
  else if (!configOk) parts.push("profiles need attention (run `orca-pi profile validate`)");
  if (worktreeUnknown) parts.push("worktree scope pending/unavailable (requires `worktree.context` over the structured bridge)");
  else if (!worktreeOk) parts.push("worktree scope unavailable (requires `worktree.context` over the structured bridge)");
  if (githubUnknown) parts.push("GitHub health pending/unavailable (refresh `github.status` + `github.doctor`; redacted, no mint in panel)");
  else if (!githubOk) parts.push("GitHub needs attention (refresh `github.status` + `github.doctor`; redacted, no mint in panel)");
  return `diagnostics: action needed — ${parts.join("; ")}.`;
}

/**
 * Required GitHub health for the top-level Diagnostics readiness (pure,
 * never throws). Returns `{ok:true}` only when explicit healthy status
 * rows for BOTH canonical credential identities (`worker` and `reviewer`)
 * are observed (each configured and unexpired) AND the doctor report is
 * `ok:true` (distinct actors, proofs, repo access). Missing status or
 * doctor → `undefined` (pending/unavailable, never ready); any observed
 * missing/expired row → `{ok:false}`; a healthy-but-partial snapshot
 * (e.g. a scoped worker-only response merged into an empty snapshot)
 * stays `undefined` until both canonical rows are observed and healthy.
 * The headline takes this value as its `github` leg so overall ready can
 * never coincide with broken or half-observed GitHub.
 */
export function toDiagnosticsGithubHealth(statusPayload: unknown, doctorPayload: unknown): { ok: boolean } | undefined {
  if (statusPayload === undefined || statusPayload === null) return undefined;
  const items = toGithubStatusItems(statusPayload);
  if (items.length === 0) return undefined;
  for (const item of items) {
    if (item.expired === true) return { ok: false };
    if (!item.configured) return { ok: false };
  }
  // Both canonical slots must be explicitly observed healthy. A scoped
  // worker-only (or reviewer-only) payload that is healthy on its own
  // row is still pending until the sibling row is observed healthy —
  // otherwise a partial merge could headline as ready with half the
  // credentials unverified.
  const byIdentity = new Map(items.map((entry) => [entry.identity, entry] as const));
  const worker = byIdentity.get("worker");
  const reviewer = byIdentity.get("reviewer");
  if (!worker || !reviewer) return undefined;
  if (worker.expired === true || !worker.configured) return { ok: false };
  if (reviewer.expired === true || !reviewer.configured) return { ok: false };
  if (doctorPayload === undefined || doctorPayload === null) return undefined;
  if (!isPlainRecord(doctorPayload)) return { ok: false };
  const rec = doctorPayload as Record<string, unknown>;
  // Doctor `ok:true` is the authoritative attention signal (distinct
  // actors + proofs + repo access). Anything else — `ok:false`,
  // missing flag, malformed — is attention-needed, never ready.
  if (rec["ok"] !== true) return { ok: false };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Diagnostics one-place overview (UI1.5)
//
// The Diagnostics section reports the required health in one redacted
// place by composing already-typed bridge results and panel state — never
// CLI text scraping, never shell, never secrets. Each row reuses the
// normalizers above, so the overview agrees with the drill-down boxes.
// ---------------------------------------------------------------------------

/** One consolidated Diagnostics overview row (label + redacted detail). */
export interface DiagnosticsOverviewRow {
  label: string;
  detail: string;
}

/** Typed inputs for the overview (raw bridge payloads + panel state). */
export interface DiagnosticsOverviewInput {
  diagnostics?: unknown;
  validate?: unknown;
  profilesList?: unknown;
  orchestration?: unknown;
  knownProfiles?: readonly string[];
  githubStatus?: unknown;
  githubDoctor?: unknown;
  launchPreviewSupported?: boolean;
  worktree?: unknown;
}

/** Per-row detail bound (redacted text, never raw runner output). */
export const DIAGNOSTICS_OVERVIEW_LIMIT = 400;

function overviewDetail(text: string): string {
  const redacted = redactDiagnosticsText(text);
  return redacted.length <= DIAGNOSTICS_OVERVIEW_LIMIT ? redacted : `${redacted.slice(0, DIAGNOSTICS_OVERVIEW_LIMIT)}…`;
}

/** Allowlisted `orca-pi` / bridge / protocol versions from `diagnostics.doctor` (never throws). */
function diagnosticsVersionsText(payload: unknown): string {
  if (!isPlainRecord(payload)) return "";
  const rec = payload as Record<string, unknown>;
  const pick = (key: string): string | undefined =>
    typeof rec[key] === "string" && (rec[key] as string).length > 0 ? (rec[key] as string).slice(0, 64) : undefined;
  const proto = rec["protocolVersion"];
  const protoText = typeof proto === "number" ? String(proto) : typeof proto === "string" ? proto.slice(0, 16) : "(unknown)";
  return ` Versions: orca-pi ${pick("orcaPiVersion") ?? "(unknown)"} / bridge ${pick("bridgeVersion") ?? "(unknown)"} / protocol ${protoText}.`;
}

// ---------------------------------------------------------------------------
// Diagnostics typed host/runtime context (UI1.5 gap fix)
//
// #32 Runtime requires Orca app version, plugin API / Host capability
// support, orca-pi/Pi versions, OS/runtime context (Windows/WSL), focused
// project/worktree, and bridge transport mode — with truthful
// unknown/degraded states. CLI versions alone are not enough: the panel
// must surface the host-reported app/plugin context plus Node/OS/WSL
// context where available, never synthesizing healthy values for missing
// legs. All fields below are allowlisted, bounded, escaped at render
// time, and secret-free (versions/names only, never tokens/keys/values).
// ---------------------------------------------------------------------------

/** Typed host context from `diagnostics.doctor.host` + `bridge` + `transport` (never secrets). */
export interface DiagnosticsHostHealth {
  appVersion?: string;
  pluginApi?: number;
  versionsOk?: boolean;
  consentOk?: boolean;
  seamHandshake?: boolean;
  structured?: boolean;
  grantedCapabilities?: readonly string[];
  transportMode?: string;
}

/** Typed OS/runtime context from `diagnostics.doctor.runtime` (never secrets). */
export interface DiagnosticsRuntimeHealth {
  node?: string;
  platform?: string;
  arch?: string;
  wsl?: string;
}

/** Allowlisted Host capability names (mirrors bridge.ts `BridgeHostCapabilityKind`). */
export const DIAGNOSTICS_HOST_CAPABILITIES = [
  "workspace:read",
  "terminal:send",
  "notifications:show",
  "storage",
  "secrets",
  "events:subscribe",
  "settings:own",
] as const;

const DIAGNOSTICS_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const DIAGNOSTICS_RUNTIME_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/;
const DIAGNOSTICS_WSL_RE = /^(native|unknown|wsl-unknown-distro|wsl:[A-Za-z0-9._-]+)$/;
const DIAGNOSTICS_TRANSPORT_RE = /^(seam|operator)$/;

function asBoundedVersion(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().slice(0, 64);
  if (trimmed.length === 0 || trimmed.length > 64) return undefined;
  // Strip control characters; reject empty/suspicious leftovers.
  // eslint-disable-next-line no-control-regex
  const clean = trimmed.replace(/[\0-\x1f\x7f]/g, "");
  if (clean.length === 0) return undefined;
  if (!DIAGNOSTICS_VERSION_RE.test(clean)) return undefined;
  return clean;
}

function asBoundedRuntimeToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().slice(0, 32);
  if (trimmed.length === 0) return undefined;
  // eslint-disable-next-line no-control-regex
  const clean = trimmed.replace(/[\0-\x1f\x7f]/g, "");
  if (clean.length === 0 || clean.length > 32) return undefined;
  if (!DIAGNOSTICS_RUNTIME_TOKEN_RE.test(clean)) return undefined;
  return clean;
}

/**
 * Normalize `diagnostics.doctor` host context (never throws). Reads only
 * allowlisted fields: `host.{appVersion,pluginApi,grantedCapabilities}`
 * plus `bridge.{versionsOk,consentOk,seamHandshake,structured}` signals
 * and `transport.mode`. Missing legs stay `undefined` (unknown) — never
 * synthesized from `target` desired versions, so the UI renders
 * truthful unknown/degraded states.
 */
export function toDiagnosticsHostHealth(payload: unknown): DiagnosticsHostHealth | undefined {
  if (!isPlainRecord(payload)) return undefined;
  const rec = payload as Record<string, unknown>;
  const host = isPlainRecord(rec["host"]) ? (rec["host"] as Record<string, unknown>) : {};
  const bridge = isPlainRecord(rec["bridge"]) ? (rec["bridge"] as Record<string, unknown>) : undefined;
  const transport = isPlainRecord(rec["transport"]) ? (rec["transport"] as Record<string, unknown>) : undefined;
  const hasHostBlock = isPlainRecord(rec["host"]);
  if (!hasHostBlock && !bridge && !transport) return undefined;
  const appVersion = asBoundedVersion(host["appVersion"]);
  const pluginApi = typeof host["pluginApi"] === "number" && Number.isInteger(host["pluginApi"]) && (host["pluginApi"] as number) >= 0 && (host["pluginApi"] as number) <= 999 ? (host["pluginApi"] as number) : undefined;
  const rawCaps = host["grantedCapabilities"];
  const grantedCapabilities = Array.isArray(rawCaps)
    ? (rawCaps as unknown[]).filter((c): c is string => typeof c === "string" && (DIAGNOSTICS_HOST_CAPABILITIES as readonly string[]).includes(c)).slice(0, 16)
    : undefined;
  const pickBool = (scope: Record<string, unknown> | undefined, key: string): boolean | undefined => {
    if (!scope) return undefined;
    const v = scope[key];
    return typeof v === "boolean" ? v : undefined;
  };
  const versionsOk = pickBool(host["versionsOk"] !== undefined ? host : bridge, "versionsOk");
  const consentOk = pickBool(host["consentOk"] !== undefined ? host : bridge, "consentOk");
  const seamHandshake = pickBool(host["seamHandshake"] !== undefined ? host : bridge, "seamHandshake");
  const structured = pickBool(host["structured"] !== undefined ? host : bridge, "structured");
  const rawMode = typeof host["transportMode"] === "string" ? host["transportMode"] : transport?.["mode"];
  const transportMode = typeof rawMode === "string" && DIAGNOSTICS_TRANSPORT_RE.test(rawMode.trim()) ? rawMode.trim() : undefined;
  return {
    ...(appVersion !== undefined ? { appVersion } : {}),
    ...(pluginApi !== undefined ? { pluginApi } : {}),
    ...(versionsOk !== undefined ? { versionsOk } : {}),
    ...(consentOk !== undefined ? { consentOk } : {}),
    ...(seamHandshake !== undefined ? { seamHandshake } : {}),
    ...(structured !== undefined ? { structured } : {}),
    ...(grantedCapabilities !== undefined ? { grantedCapabilities } : {}),
    ...(transportMode !== undefined ? { transportMode } : {}),
  };
}

/** One-line host context (Orca app version + plugin API + capability status). Unknown legs render as unknown, never healthy. */
export function describeDiagnosticsHost(host: DiagnosticsHostHealth | undefined): string {
  if (!host) return "Orca app (unknown version) (pluginApi unknown; capabilities unknown — degraded/unknown).";
  const app = host.appVersion ?? "(unknown version)";
  const api = host.pluginApi !== undefined ? `pluginApi ${host.pluginApi}` : "pluginApi unknown";
  const caps = host.grantedCapabilities !== undefined
    ? (host.grantedCapabilities.length > 0 ? `capabilities ${host.grantedCapabilities.join(", ")}` : "capabilities (none granted)")
    : "capabilities unknown";
  const signals: string[] = [];
  if (host.structured !== undefined) signals.push(host.structured ? "structured" : "degraded");
  else signals.push("reachability unknown");
  if (host.consentOk !== undefined) signals.push(host.consentOk ? "consent ok" : "consent missing");
  if (host.seamHandshake !== undefined) signals.push(host.seamHandshake ? "seam ok" : "no seam");
  if (host.versionsOk !== undefined) signals.push(host.versionsOk ? "versions ok" : "versions mismatch");
  const transport = host.transportMode ? `transport ${host.transportMode}` : "transport unknown";
  return `Orca app ${app} (${api}; ${caps}; ${signals.join(", ")}; ${transport}).`;
}

/**
 * Normalize `diagnostics.doctor` runtime context (never throws). Reads
 * only allowlisted `runtime.{node,platform,arch,wsl}` fields (bounded
 * tokens); anything else is dropped. Returns undefined when the payload
 * carries no runtime block so callers render truthful unknown states.
 */
export function toDiagnosticsRuntimeHealth(payload: unknown): DiagnosticsRuntimeHealth | undefined {
  if (!isPlainRecord(payload)) return undefined;
  const rec = payload as Record<string, unknown>;
  const runtime = rec["runtime"];
  if (!isPlainRecord(runtime)) return undefined;
  const r = runtime as Record<string, unknown>;
  const node = asBoundedRuntimeToken(r["node"]);
  const platform = asBoundedRuntimeToken(r["platform"]);
  const arch = asBoundedRuntimeToken(r["arch"]);
  const rawWsl = typeof r["wsl"] === "string" ? r["wsl"].trim().slice(0, 64) : undefined;
  // eslint-disable-next-line no-control-regex
  const cleanWsl = rawWsl?.replace(/[\0-\x1f\x7f]/g, "");
  const wsl = cleanWsl !== undefined && DIAGNOSTICS_WSL_RE.test(cleanWsl) ? cleanWsl : undefined;
  if (node === undefined && platform === undefined && arch === undefined && wsl === undefined) return {};
  return {
    ...(node !== undefined ? { node } : {}),
    ...(platform !== undefined ? { platform } : {}),
    ...(arch !== undefined ? { arch } : {}),
    ...(wsl !== undefined ? { wsl } : {}),
  };
}

/** One-line OS/runtime context (Node + OS/arch + Windows/WSL). Unknown legs render as unknown, never healthy. */
export function describeDiagnosticsRuntime(runtime: DiagnosticsRuntimeHealth | undefined): string {
  if (!runtime) return "Node (unknown) on (unknown) (OS context unknown).";
  const node = runtime.node ?? "(unknown)";
  const os = runtime.platform && runtime.arch ? `${runtime.platform}/${runtime.arch}` : (runtime.platform ?? runtime.arch ?? "(unknown)");
  const wsl = runtime.wsl;
  let ctx: string;
  if (wsl === undefined) ctx = "OS context unknown";
  else if (wsl === "native") ctx = runtime.platform === "win32" ? "native Windows" : runtime.platform === "darwin" ? "native macOS" : runtime.platform === "linux" ? "native Linux" : "native OS";
  else if (wsl === "unknown") ctx = "OS context unknown";
  else if (wsl === "wsl-unknown-distro") ctx = "WSL (distro unknown)";
  else if (wsl.startsWith("wsl:")) ctx = `WSL distro ${wsl.slice(4)}`;
  else ctx = wsl;
  return `Node ${node} on ${os} (${ctx}).`;
}

/**
 * User/project config paths + existence from a `profiles.list` payload
 * (never throws). Reads only `panel.config` path names (actionable,
 * non-secret); returns undefined when the payload carries no config block.
 */
export function toDiagnosticsConfigPaths(
  payload: unknown,
): { userPath: string; projectPath: string; userExists: boolean; projectExists: boolean } | undefined {
  if (!isPlainRecord(payload)) return undefined;
  const panel = (payload as Record<string, unknown>)["panel"];
  if (!isPlainRecord(panel)) return undefined;
  const config = (panel as Record<string, unknown>)["config"];
  if (!isPlainRecord(config)) return undefined;
  const rec = config as Record<string, unknown>;
  if (typeof rec["userPath"] !== "string" || typeof rec["projectPath"] !== "string") return undefined;
  return {
    userPath: (rec["userPath"] as string).slice(0, 256),
    projectPath: (rec["projectPath"] as string).slice(0, 256),
    userExists: rec["userExists"] === true,
    projectExists: rec["projectExists"] === true,
  };
}

/** One-line config-paths summary (path names + existence only, never values). */
export function describeConfigPaths(
  paths: { userPath: string; projectPath: string; userExists: boolean; projectExists: boolean } | undefined,
): string {
  if (!paths) return "config paths unavailable (refresh profiles via `profiles.list`).";
  return (
    `user ${paths.userPath} (${paths.userExists ? "present" : "absent"}); ` +
    `project ${paths.projectPath} (${paths.projectExists ? "present" : "absent"}).`
  );
}

/**
 * Consolidated one-place Diagnostics overview rows (never throws).
 * Every row composes allowlisted typed data via the redacted describers
 * above — no secret values can reach the details (bounded + pattern
 * redacted), and missing legs render as pending/unavailable, never as
 * healthy. Row order: runtime, bridge, worktree, profiles, roles,
 * launch, GitHub status, GitHub doctor.
 */
export function diagnosticsOverviewRows(input: DiagnosticsOverviewInput): DiagnosticsOverviewRow[] {
  const cliHealth = toDiagnosticsCliHealth(input.diagnostics);
  const bridge = toDiagnosticsBridgeHealth(input.diagnostics);
  const host = toDiagnosticsHostHealth(input.diagnostics);
  const runtime = toDiagnosticsRuntimeHealth(input.diagnostics);
  const config = toDiagnosticsConfigHealth(input.validate);
  const orchItems = toOrchestrationItems(input.orchestration, input.knownProfiles);
  const statusItems = toGithubStatusItems(input.githubStatus);
  const actor = toGithubActorSummary(input.githubDoctor);
  const setup = githubSetupActions(input.githubDoctor);

  const mapping =
    orchItems.length > 0 ? orchItems.map((item) => `${item.role}→${item.profile}`).join(", ") : "(no mappings loaded)";
  const rows: DiagnosticsOverviewRow[] = [
    {
      label: "Runtime",
      detail: `${describeDiagnosticsCli(cliHealth)}${diagnosticsVersionsText(input.diagnostics)} Host: ${describeDiagnosticsHost(host)} Runtime: ${describeDiagnosticsRuntime(runtime)}`,
    },
    {
      label: "Bridge",
      detail: bridge
        ? `${bridge.structured ? "structured" : "degraded (read-only CLI fallback)"}; ` +
          `${bridge.supportedOperations.length} supported operation(s)` +
          `${host?.transportMode ? `; transport ${host.transportMode}` : "; transport unknown"}` +
          `${bridge.reasons.length > 0 ? `; notes: ${bridge.reasons.slice(0, 2).join(" ")}` : ""}.`
        : host?.transportMode
          ? `bridge negotiation unavailable in this response (transport ${host.transportMode}).`
          : "bridge negotiation unavailable in this response.",
    },
    {
      label: "Worktree",
      detail: describeWorktreeHealth(toDiagnosticsWorktreeHealth(input.worktree)),
    },
    {
      label: "Profiles",
      detail: `${describeConfigHealth(config)} ${describeConfigPaths(toDiagnosticsConfigPaths(input.profilesList))}`,
    },
    {
      label: "Roles",
      detail: `${orchestrationInvalidSummary(orchItems)} Mappings: ${mapping}.`,
    },
    {
      label: "Launch",
      detail:
        input.launchPreviewSupported === true
          ? "compiler available: sanitized display-only previews via `launch.preview` (never executed)."
          : "compiler unavailable on this host (needs `launch.preview` over the structured bridge).",
    },
    {
      label: "GitHub status",
      detail:
        statusItems.length > 0
          ? statusItems.map(describeGithubStatusItem).join(" ")
          : "GitHub status not loaded (refresh via `github.status`; redacted status only, no mint in the panel).",
    },
    {
      label: "GitHub doctor",
      detail: actor
        ? `${actor.ok ? "actors distinct (ok)" : "actor attention needed"} — ${actor.distinctDetail}` +
          `${setup.length > 0 ? ` Next: ${setup.slice(0, 3).join(" ")}` : ""}`
        : "doctor not run yet (run `github.doctor` with a repo access-test; redacted, no mint in the panel).",
    },
  ];
  return rows.map((row) => ({ label: row.label, detail: overviewDetail(row.detail) }));
}

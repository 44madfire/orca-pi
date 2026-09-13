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
      implemented: false,
      blurb:
        "Worker/reviewer identity health lives here in UI1.5 (redacted status only, never secrets).",
    },
    {
      id: "diagnostics",
      title: "Diagnostics",
      implemented: true,
      blurb:
        "Bridge, capability, and CLI health via diagnostics.doctor plus profile validation. Full hardening lands with UI1.5/UI1.6.",
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

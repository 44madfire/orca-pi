/**
 * Orca plugin manifest model + validator (OP1.1 scaffold).
 *
 * Mirrors the upstream manifest v1 schema (`orca-plugin.json` at the plugin
 * root, `manifestVersion: 1`, `pluginApi: 1`) as implemented in
 * `src/shared/plugins/plugin-manifest*.ts` and
 * `plugin-content-pack-contributions.ts`. The host (desktop app, headless
 * `orca serve`, relay, CLI) is the final authority — this validator exists so
 * `npm test` proves the shipped artifact is well-formed without requiring
 * Electron or Orca Desktop.
 *
 * Deliberate simplifications vs. the host: `contributes.commands[].action`
 * is shape-checked only (the host rejects unknown built-in action aliases
 * against a closed list), and keybinding `key` conflict detection is an
 * exact-match approximation (the host normalizes key names per platform).
 * Everything else — including capability kinds, contribution limits, and
 * the `events:subscribe` gate — is enforced so `ok: true` means the
 * manifest is expected to pass Orca validation.
 */

export type PluginCommandContext = "global" | "worktree";

export interface OrcaPluginPanelContribution {
  id: string;
  title: string;
  icon?: string;
  /** HTML entry rendered inside a sandboxed panel frame, e.g. "panel.html". */
  entry: string;
}

export interface OrcaPluginCommandContribution {
  id: string;
  title: string;
  context?: PluginCommandContext;
  /** Built-in action alias. Omit for inert placeholder commands. */
  action?: string;
}

export type PluginEventName =
  | "worktree.created"
  | "worktree.removed"
  | "agent.status.changed";

export interface OrcaPluginEventContribution {
  on: PluginEventName;
}

/**
 * Closed v0 capability set (strict `{ kind }` objects — a typo fails
 * validation instead of silently granting nothing). Mirrors
 * `PLUGIN_CAPABILITY_KINDS` upstream.
 */
export type PluginCapabilityKind =
  | "workspace:read"
  | "terminal:send"
  | "notifications:show"
  | "storage"
  | "secrets"
  | "events:subscribe"
  | "settings:own";

export interface OrcaPluginCapability {
  kind: PluginCapabilityKind;
}

export interface OrcaPluginLanguagePackContribution {
  locale: string;
  path: string;
}

export interface OrcaPluginKeybindingContribution {
  command: string;
  key: string;
  when?: PluginCommandContext;
}

export interface OrcaPluginPathContribution {
  path: string;
}

export interface OrcaPluginManifest {
  manifestVersion: 1;
  /** Kebab-case plugin id; canonical identity is `<publisher>.<id>`. */
  id: string;
  /** Kebab-case publisher slug. */
  publisher: string;
  name: string;
  /** Semver plugin version — must track the orca-pi release line. */
  version: string;
  description?: string;
  repository?: string;
  /** Minimum host version gate; only the `>=x.y.z` form is supported. */
  engines: { orca: string };
  /** Host-API major version this plugin targets. */
  pluginApi: 1;
  main?: string;
  contributes?: {
    panels?: OrcaPluginPanelContribution[];
    commands?: OrcaPluginCommandContribution[];
    events?: OrcaPluginEventContribution[];
    languagePacks?: OrcaPluginLanguagePackContribution[];
    keybindings?: OrcaPluginKeybindingContribution[];
    vmRecipes?: OrcaPluginPathContribution[];
    agents?: OrcaPluginPathContribution[];
  };
  capabilities?: OrcaPluginCapability[];
}

export interface ManifestValidation {
  ok: boolean;
  errors: string[];
}

/**
 * Design contract: `ok: true` means the manifest is expected to pass Orca's
 * own validation. Every contribution family the validator recognizes is
 * therefore checked against the host schema and limits — not just
 * shape-checked. Anything the host normalizes itself (keybinding `key`
 * strings) is length-checked here and flagged as host-authoritative.
 */

/** Canonical install identity: `<publisher>.<id>`. */
export function qualifiedPluginKey(manifest: Pick<OrcaPluginManifest, "publisher" | "id">): string {
  return `${manifest.publisher}.${manifest.id}`;
}

const SEMVER_RE =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PLUGIN_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED_IDS = new Set(["__proto__", "prototype", "constructor"]);
const COMMAND_ID_RE = /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/;
const ENGINE_RANGE_RE = /^>=\d+\.\d+\.\d+$/;
const EVENT_NAMES: readonly PluginEventName[] = [
  "worktree.created",
  "worktree.removed",
  "agent.status.changed",
];
const KNOWN_CONTRIBUTION_KEYS = new Set([
  "panels",
  "commands",
  "events",
  "languagePacks",
  "keybindings",
  "vmRecipes",
  "agents",
]);

// Host contribution limits mirrored from plugin-manifest.ts /
// plugin-content-pack-contributions.ts upstream.
const LIMITS = {
  panels: 64,
  commands: 256,
  events: 3,
  languagePacks: 16,
  keybindings: 256,
  vmRecipes: 64,
  agents: 64,
  capabilities: 32,
} as const;

const CAPABILITY_KINDS: readonly string[] = [
  "workspace:read",
  "terminal:send",
  "notifications:show",
  "storage",
  "secrets",
  "events:subscribe",
  "settings:own",
];

const LOCALE_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

const WINDOWS_DEVICE_NAME_RE =
  /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i;
const WINDOWS_FORBIDDEN_CHAR_RE = /[<>:"|?*]/;

function isPluginId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 64 &&
    PLUGIN_ID_RE.test(value) &&
    !RESERVED_IDS.has(value)
  );
}

function isCommandId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    COMMAND_ID_RE.test(value)
  );
}

/** Mirror of the host's safe-relative-path rule: no dot segments, no absolute. */
function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) {
    return false;
  }
  if (value.startsWith("/") || value.startsWith("\\")) return false;
  const segments = value.split(/[\\/]/);
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") return false;
    if (segment.endsWith(".") || segment.endsWith(" ")) return false;
    if (WINDOWS_FORBIDDEN_CHAR_RE.test(segment)) return false;
    if ([...segment].some((ch) => (ch.codePointAt(0) ?? 0) <= 31)) return false;
    if (WINDOWS_DEVICE_NAME_RE.test(segment)) return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate an unknown value as an `OrcaPluginManifest`. Pure function. */
export function validatePluginManifest(manifest: unknown): ManifestValidation {
  const errors: string[] = [];
  if (!isRecord(manifest)) {
    return { ok: false, errors: ["manifest must be a JSON object"] };
  }

  if (manifest["manifestVersion"] !== 1) {
    errors.push('manifest.manifestVersion must be the literal 1 (manifest v1, file "orca-plugin.json")');
  }
  if (!isPluginId(manifest["id"])) {
    errors.push("manifest.id must be kebab-case (a-z, 0-9, dashes; max 64 chars)");
  }
  if (!isPluginId(manifest["publisher"])) {
    errors.push("manifest.publisher must be a kebab-case slug (a-z, 0-9, dashes; max 64 chars)");
  }
  if (typeof manifest["name"] !== "string" || manifest["name"].length === 0 || manifest["name"].length > 256) {
    errors.push("manifest.name must be a non-empty string (max 256 chars)");
  }
  if (typeof manifest["version"] !== "string" || !SEMVER_RE.test(manifest["version"])) {
    errors.push('manifest.version must be a semver string (e.g. "0.1.0")');
  }
  if (manifest["description"] !== undefined) {
    if (typeof manifest["description"] !== "string" || manifest["description"].length > 4096) {
      errors.push("manifest.description must be a string of at most 4096 chars when present");
    }
  }
  if (manifest["engines"] === undefined || !isRecord(manifest["engines"])) {
    errors.push('manifest.engines must be an object like { "orca": ">=1.4.0" }');
  } else if (
    typeof manifest["engines"]["orca"] !== "string" ||
    !ENGINE_RANGE_RE.test(manifest["engines"]["orca"])
  ) {
    errors.push('manifest.engines.orca must use the ">=x.y.z" form (e.g. ">=1.4.0")');
  }
  if (manifest["pluginApi"] !== 1) {
    errors.push("manifest.pluginApi must be the literal 1");
  }
  if (manifest["main"] !== undefined && !isSafeRelativePath(manifest["main"])) {
    errors.push("manifest.main must be a safe plugin-relative path when present");
  }

  const contributes = manifest["contributes"];
  if (contributes !== undefined) {
    if (!isRecord(contributes)) {
      errors.push("manifest.contributes must be an object when present");
    } else {
      for (const key of Object.keys(contributes)) {
        if (!KNOWN_CONTRIBUTION_KEYS.has(key)) {
          errors.push(`manifest.contributes.${key} is not a known v1 contribution point`);
        }
      }
      validatePanels(contributes["panels"], errors);
      validateCommands(contributes["commands"], errors);
      validateEvents(contributes["events"], errors);
      validateLanguagePacks(contributes["languagePacks"], errors);
      validateKeybindings(
        contributes["keybindings"],
        declaredCommandContexts(contributes["commands"]),
        errors,
      );
      validatePathList(contributes["vmRecipes"], "vmRecipes", LIMITS.vmRecipes, errors);
      validatePathList(contributes["agents"], "agents", LIMITS.agents, errors);
    }
  }

  const capabilityKinds = validateCapabilities(manifest["capabilities"], errors);

  // Cross-field rules mirrored from the host's contribution validation:
  // action-less commands are worker commands and need a `main` entry, as do
  // event subscriptions (which additionally need an events:subscribe
  // capability object).
  const hasMain =
    typeof manifest["main"] === "string" && manifest["main"].length > 0;
  const contributesRecord = isRecord(contributes) ? contributes : undefined;
  const commandList =
    contributesRecord && Array.isArray(contributesRecord["commands"])
      ? (contributesRecord["commands"] as unknown[])
      : [];
  if (
    !hasMain &&
    commandList.some(
      (command) => isRecord(command) && command["action"] === undefined,
    )
  ) {
    errors.push(
      'manifest.main is required when contributes.commands contains a worker command (a command without a built-in "action" alias)',
    );
  }
  const eventList =
    contributesRecord && Array.isArray(contributesRecord["events"])
      ? (contributesRecord["events"] as unknown[])
      : [];
  if (!hasMain && eventList.length > 0) {
    errors.push(
      "manifest.main is required when contributes.events is non-empty",
    );
  }
  if (eventList.length > 0 && !capabilityKinds.has("events:subscribe")) {
    errors.push(
      'manifest.capabilities must include { "kind": "events:subscribe" } when contributes.events is non-empty',
    );
  }

  return { ok: errors.length === 0, errors };
}

/** Strict `{ kind }` capability entries against the closed v0 kind set. */
function validateCapabilities(value: unknown, errors: string[]): Set<string> {
  const kinds = new Set<string>();
  if (value === undefined) return kinds;
  if (!Array.isArray(value)) {
    errors.push("manifest.capabilities must be an array when present");
    return kinds;
  }
  if (value.length > LIMITS.capabilities) {
    errors.push(
      `manifest.capabilities must contain at most ${LIMITS.capabilities} entries`,
    );
  }
  for (const [index, capability] of value.entries()) {
    const at = `manifest.capabilities[${index}]`;
    if (!isRecord(capability)) {
      errors.push(`${at} must be an object`);
      continue;
    }
    const keys = Object.keys(capability);
    if (keys.length !== 1 || keys[0] !== "kind") {
      errors.push(`${at} must be a strict { "kind": ... } object`);
      continue;
    }
    if (typeof capability["kind"] !== "string" || !CAPABILITY_KINDS.includes(capability["kind"])) {
      errors.push(`${at}.kind must be one of: ${CAPABILITY_KINDS.join(", ")}`);
      continue;
    }
    kinds.add(capability["kind"] as string);
  }
  return kinds;
}

/** Declared command ids mapped to their effective context (default global). */
function declaredCommandContexts(value: unknown): Map<string, string> {
  const contexts = new Map<string, string>();
  if (!Array.isArray(value)) return contexts;
  for (const command of value) {
    if (!isRecord(command) || !isCommandId(command["id"])) continue;
    const context = command["context"];
    contexts.set(
      command["id"] as string,
      context === "worktree" ? "worktree" : "global",
    );
  }
  return contexts;
}

function validatePanels(value: unknown, errors: string[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push("contributes.panels must be an array when present");
    return;
  }
  if (value.length > LIMITS.panels) {
    errors.push(`contributes.panels must contain at most ${LIMITS.panels} entries`);
  }
  const seen = new Set<string>();
  for (const [index, panel] of value.entries()) {
    const at = `contributes.panels[${index}]`;
    if (!isRecord(panel)) {
      errors.push(`${at} must be an object`);
      continue;
    }
    if (!isPluginId(panel["id"])) {
      errors.push(`${at}.id must be kebab-case (a-z, 0-9, dashes)`);
    } else if (seen.has(panel["id"] as string)) {
      errors.push(`${at}.id is a duplicate panel id`);
    } else {
      seen.add(panel["id"] as string);
    }
    if (typeof panel["title"] !== "string" || panel["title"].length === 0 || panel["title"].length > 256) {
      errors.push(`${at}.title must be a non-empty string (max 256 chars)`);
    }
    if (!isSafeRelativePath(panel["entry"])) {
      errors.push(`${at}.entry must be a safe plugin-relative HTML path (e.g. "panel.html", no "./" prefix)`);
    }
  }
}

function validateCommands(value: unknown, errors: string[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push("contributes.commands must be an array when present");
    return;
  }
  if (value.length > LIMITS.commands) {
    errors.push(`contributes.commands must contain at most ${LIMITS.commands} entries`);
  }
  const seen = new Set<string>();
  for (const [index, command] of value.entries()) {
    const at = `contributes.commands[${index}]`;
    if (!isRecord(command)) {
      errors.push(`${at} must be an object`);
      continue;
    }
    if (!isCommandId(command["id"])) {
      errors.push(`${at}.id must be a portable command id (letters, digits, ".", "_", "-")`);
    } else if (seen.has(command["id"] as string)) {
      errors.push(`${at}.id is a duplicate command id`);
    } else {
      seen.add(command["id"] as string);
    }
    if (typeof command["title"] !== "string" || command["title"].length === 0 || command["title"].length > 256) {
      errors.push(`${at}.title must be a non-empty string (max 256 chars)`);
    }
    if (
      command["context"] !== undefined &&
      command["context"] !== "global" &&
      command["context"] !== "worktree"
    ) {
      errors.push(`${at}.context must be "global" or "worktree" when present`);
    }
    // Shape-check only: the host rejects unknown built-in action aliases
    // against its closed list (see plugin-command-actions.ts upstream).
    if (command["action"] !== undefined && !isCommandId(command["action"])) {
      errors.push(`${at}.action must be a portable command id when present`);
    }
  }
}

function validateEvents(value: unknown, errors: string[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push("contributes.events must be an array when present");
    return;
  }
  if (value.length > LIMITS.events) {
    errors.push(`contributes.events must contain at most ${LIMITS.events} entries`);
  }
  for (const [index, event] of value.entries()) {
    const at = `contributes.events[${index}]`;
    if (!isRecord(event)) {
      errors.push(`${at} must be an object`);
      continue;
    }
    if (
      typeof event["on"] !== "string" ||
      !(EVENT_NAMES as readonly string[]).includes(event["on"])
    ) {
      errors.push(`${at}.on must be one of: ${EVENT_NAMES.join(", ")}`);
    }
  }
}

function validatePathList(value: unknown, key: string, limit: number, errors: string[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push(`contributes.${key} must be an array when present`);
    return;
  }
  if (value.length > limit) {
    errors.push(`contributes.${key} must contain at most ${limit} entries`);
  }
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const at = `contributes.${key}[${index}]`;
    if (!isRecord(entry) || !isSafeRelativePath(entry["path"])) {
      errors.push(`${at}.path must be a safe plugin-relative path`);
      continue;
    }
    const path = entry["path"] as string;
    if (seen.has(path)) {
      errors.push(`${at}.path is a duplicate ${key} path`);
    } else {
      seen.add(path);
    }
  }
}

function validateLanguagePacks(value: unknown, errors: string[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push("contributes.languagePacks must be an array when present");
    return;
  }
  if (value.length > LIMITS.languagePacks) {
    errors.push(`contributes.languagePacks must contain at most ${LIMITS.languagePacks} entries`);
  }
  const seen = new Set<string>();
  for (const [index, pack] of value.entries()) {
    const at = `contributes.languagePacks[${index}]`;
    if (!isRecord(pack)) {
      errors.push(`${at} must be an object`);
      continue;
    }
    const locale = pack["locale"];
    if (
      typeof locale !== "string" ||
      locale.length < 2 ||
      locale.length > 35 ||
      !LOCALE_RE.test(locale)
    ) {
      errors.push(`${at}.locale must be a portable locale identifier (e.g. "en", "pt-BR")`);
    } else if (seen.has(locale.toLowerCase())) {
      errors.push(`${at}.locale is a duplicate language pack locale`);
    } else {
      seen.add(locale.toLowerCase());
    }
    if (!isSafeRelativePath(pack["path"])) {
      errors.push(`${at}.path must be a safe plugin-relative path`);
    }
  }
}

function validateKeybindings(
  value: unknown,
  commandContexts: Map<string, string>,
  errors: string[],
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push("contributes.keybindings must be an array when present");
    return;
  }
  if (value.length > LIMITS.keybindings) {
    errors.push(`contributes.keybindings must contain at most ${LIMITS.keybindings} entries`);
  }
  // Approximation of the host's per-platform conflict detection: exact key
  // strings compared case-insensitively. The host normalizes key names
  // itself and remains authoritative for near-misses.
  const seenKeys = new Set<string>();
  for (const [index, keybinding] of value.entries()) {
    const at = `contributes.keybindings[${index}]`;
    if (!isRecord(keybinding)) {
      errors.push(`${at} must be an object`);
      continue;
    }
    const target = keybinding["command"];
    if (!isCommandId(target)) {
      errors.push(`${at}.command must be a portable command id`);
    } else if (!commandContexts.has(target as string)) {
      errors.push(`${at}.command references an unknown contributed command`);
    } else if (
      keybinding["when"] !== undefined &&
      keybinding["when"] !== commandContexts.get(target as string)
    ) {
      errors.push(`${at}.when must match its command context`);
    }
    if (
      keybinding["when"] !== undefined &&
      keybinding["when"] !== "global" &&
      keybinding["when"] !== "worktree"
    ) {
      errors.push(`${at}.when must be "global" or "worktree" when present`);
    }
    const key = keybinding["key"];
    if (typeof key !== "string" || key.length === 0 || key.length > 128) {
      errors.push(
        `${at}.key must be a non-empty keybinding string (max 128 chars; host normalization is authoritative)`,
      );
    } else if (seenKeys.has(key.toLowerCase())) {
      errors.push(`${at}.key is a duplicate keybinding`);
    } else {
      seenKeys.add(key.toLowerCase());
    }
  }
}

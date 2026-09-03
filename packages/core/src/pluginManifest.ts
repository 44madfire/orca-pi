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
 * against a closed list); `capabilities[]` entries are shape-checked only.
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
    languagePacks?: { locale: string; path: string }[];
    keybindings?: { command: string; key: string; when?: PluginCommandContext }[];
    vmRecipes?: { path: string }[];
    agents?: { path: string }[];
  };
  capabilities?: unknown[];
}

export interface ManifestValidation {
  ok: boolean;
  errors: string[];
}

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
      validatePathList(contributes["vmRecipes"], "vmRecipes", errors);
      validatePathList(contributes["agents"], "agents", errors);
    }
  }

  if (manifest["capabilities"] !== undefined && !Array.isArray(manifest["capabilities"])) {
    errors.push("manifest.capabilities must be an array when present");
  }

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

  return { ok: errors.length === 0, errors };
}

function validatePanels(value: unknown, errors: string[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push("contributes.panels must be an array when present");
    return;
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

function validatePathList(value: unknown, key: string, errors: string[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push(`contributes.${key} must be an array when present`);
    return;
  }
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry) || !isSafeRelativePath(entry["path"])) {
      errors.push(`contributes.${key}[${index}].path must be a safe plugin-relative path`);
    }
  }
}

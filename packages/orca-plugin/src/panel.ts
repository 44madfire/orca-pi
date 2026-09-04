/**
 * Read-only profiles sidebar helpers (OP1.7 / JEF-11).
 *
 * The thin Orca plugin must not depend on unrestricted `child_process`,
 * filesystem, or network access in the panel/worker (see
 * `docs/ORCA_PLUGIN_API.md` and stablyai/orca#15637). All live data comes
 * from the companion `orca-pi` CLI (`orca-pi profiles list --json`); this
 * module only formats injected data into HTML/text and detects what the
 * installed host supports. When the host lacks a panel↔worker bridge or a
 * supported persistence path, callers fall back to CLI + informational
 * panel content instead of undocumented access — never a hidden
 * panel-local store.
 */

import type { ProfilesPanelModel } from "@orca-pi/core";
import { TARGET_ORCA_APP_VERSION, TARGET_ORCA_PLUGIN_API } from "@orca-pi/core";

export const PROFILES_PANEL_ID = "orca-pi-profiles";

export interface PanelSupportInput {
  appVersion?: string;
  pluginApi?: number;
}

export interface PanelSupport {
  /** True when the host can render the declarative read-only summary. */
  supported: boolean;
  /** Declarative sandboxed HTML summary (always true on pluginApi 1). */
  readOnlySummary: boolean;
  /** Live reload without manual refresh (false in v1 — explicit reload). */
  liveReload: boolean;
  /** Supported persistence/host path for edits (false in v1 — CLI owns files). */
  persistence: boolean;
  /** In-panel editing (false in v1 — no hidden panel-local store). */
  editing: boolean;
  /** Fallback strategy when capabilities are missing. */
  fallback: "cli-only";
  reasons: string[];
}

function parseMajorMinorPatch(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function gte(a: string, b: string): boolean {
  const pa = parseMajorMinorPatch(a);
  const pb = parseMajorMinorPatch(b);
  if (!pa || !pb) return false;
  for (let index = 0; index < 3; index += 1) {
    if (pa[index]! > pb[index]!) return true;
    if (pa[index]! < pb[index]!) return false;
  }
  return true;
}

/**
 * Detect what the installed Orca host supports for the profiles sidebar.
 * Pure function — no I/O, no version sniffing beyond injected values.
 */
export function detectPanelSupport(input?: PanelSupportInput): PanelSupport {
  const reasons: string[] = [];
  const pluginApi = input?.pluginApi ?? TARGET_ORCA_PLUGIN_API;
  const appVersion = input?.appVersion ?? TARGET_ORCA_APP_VERSION;

  let supported = true;
  if (pluginApi !== 1) {
    supported = false;
    reasons.push(
      `pluginApi ${pluginApi} is not the targeted v1 (${TARGET_ORCA_PLUGIN_API}); falling back to CLI-only display.`,
    );
  } else {
    reasons.push("pluginApi 1 supports declarative sandboxed panels (read-only summary).");
  }

  if (!gte(appVersion, "1.4.0")) {
    supported = false;
    reasons.push(
      `Orca app ${appVersion} is older than the minimum engines.orca >=1.4.0; falling back to CLI-only display.`,
    );
  } else {
    reasons.push(`Orca app ${appVersion} meets engines.orca >=1.4.0.`);
  }

  // v1 has no supported worker bridge, persistence, or editing path for
  // profiles — the CLI/profile file stays authoritative.
  reasons.push("No supported panel↔worker persistence/host bridge in v1 — edits happen in config files via the CLI, not in the panel.");
  reasons.push("Panel degrades gracefully: live data comes from `orca-pi profiles list --json`; missing bridge never blocks orchestration.");

  return {
    supported,
    readOnlySummary: pluginApi === 1 && gte(appVersion, "1.4.0"),
    liveReload: false,
    persistence: false,
    editing: false,
    fallback: "cli-only",
    reasons,
  };
}

/** HTML-escape one string for panel rendering. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Render the read-only profiles summary as an HTML fragment (pure, escaped).
 * Handles: no profiles, valid profiles, invalid profiles, missing config.
 */
export function renderProfilesPanelHtml(model: ProfilesPanelModel): string {
  const parts: string[] = [];
  if (model.profiles.length === 0) {
    parts.push("<p><strong>No Pi profiles found.</strong></p>");
    parts.push("<p>The CLI/profile file is authoritative; the panel never creates a second store.</p>");
    parts.push("<ul>");
    parts.push(
      `<li>User/global: <code>${escapeHtml(model.config.userPath)}</code>${model.config.userExists ? "" : " (missing — optional)"}</li>`,
    );
    parts.push(
      `<li>Project: <code>${escapeHtml(model.config.projectPath)}</code>${model.config.projectExists ? "" : " (missing — optional)"}</li>`,
    );
    parts.push("</ul>");
    parts.push("<p>Copy <code>profiles/examples.yaml</code> to one of the paths above, then choose Refresh (re-run <code>orca-pi profile validate</code>).</p>");
    return parts.join("\n");
  }

  if (!model.validation.ok) {
    parts.push(
      `<p><strong>Validation: ${model.validation.invalidCount} invalid profile${model.validation.invalidCount === 1 ? "" : "s"}.</strong> Run <code>orca-pi profile validate</code> for file/source/field diagnostics.</p>`,
    );
  } else {
    parts.push(
      `<p>Validation: all ${model.profiles.length} profile${model.profiles.length === 1 ? "" : "s"} valid. Refresh runs <code>orca-pi profile validate</code>.</p>`,
    );
  }

  parts.push("<ul>");
  for (const profile of model.profiles) {
    const status = profile.valid ? "" : " — <strong>INVALID</strong>";
    const modelText = profile.model ? escapeHtml(profile.model) : "(no model)";
    const tools =
      profile.toolCount !== undefined ? `${profile.toolCount} tools` : "default tools";
    const context = profile.contextFiles ? "context on" : "context off";
    const display = profile.displayName
      ? ` — ${escapeHtml(profile.displayName)}`
      : "";
    parts.push(
      `<li><code>${escapeHtml(profile.name)}</code>${display}: ${modelText} / ${escapeHtml(profile.thinking)} — ${escapeHtml(tools)}, ${profile.skillCount} skill${profile.skillCount === 1 ? "" : "s"}, ${profile.extensionCount} extension${profile.extensionCount === 1 ? "" : "s"}, ${escapeHtml(context)}${status}</li>`,
    );
    if (profile.skillNames.length > 0) {
      const names = profile.skillNames.slice(0, 8).map(escapeHtml).join(", ");
      const more =
        profile.skillNames.length > 8
          ? ` (and ${profile.skillNames.length - 8} more)`
          : "";
      parts.push(`<li style="list-style:none;margin-left:1em;">skills: ${names}${more}</li>`);
    }
  }
  parts.push("</ul>");

  parts.push("<p>Conservative actions (no hidden store):</p>");
  parts.push("<ul>");
  parts.push("<li><code>orca-pi profile validate</code> — validate profiles</li>");
  parts.push("<li><code>orca-pi profile path</code> — show/open/copy config location</li>");
  parts.push("<li><code>orca-pi profiles list</code> — refresh/reload configuration</li>");
  parts.push("</ul>");
  parts.push(
    `<p>User/global: <code>${escapeHtml(model.config.userPath)}</code>${model.config.userExists ? "" : " (missing)"} · Project: <code>${escapeHtml(model.config.projectPath)}</code>${model.config.projectExists ? "" : " (missing)"}</p>`,
  );
  return parts.join("\n");
}

/** Plain-text profiles summary (for commands/status, same data as the panel). */
export function renderProfilesStatusText(model: ProfilesPanelModel): string {
  if (model.profiles.length === 0) {
    return [
      "No Pi profiles found.",
      `user/global: ${model.config.userPath}${model.config.userExists ? "" : " (missing — optional)"}`,
      `project: ${model.config.projectPath}${model.config.projectExists ? "" : " (missing — optional)"}`,
    ].join("\n");
  }
  const lines = [
    `Pi profiles (${model.profiles.length}, ${model.validation.ok ? "all valid" : `${model.validation.invalidCount} invalid`}):`,
  ];
  for (const profile of model.profiles) {
    const status = profile.valid ? "" : " [INVALID]";
    lines.push(
      `  ${profile.name}${status} — ${profile.model ?? "(no model)"} / ${profile.thinking} — ${profile.toolCount !== undefined ? `${profile.toolCount} tools` : "default tools"}, ${profile.skillCount} skills, ${profile.extensionCount} extensions`,
    );
  }
  return lines.join("\n");
}

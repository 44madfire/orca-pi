/**
 * Profiles sidebar + Control Center helpers (OP1.7 / JEF-11 + UI1.2 bridge).
 *
 * The thin Orca plugin must not depend on unrestricted `child_process`,
 * filesystem, or network access in the panel (see `docs/ORCA_PLUGIN_API.md`).
 * Live data flows through the versioned Orca↔Orca-Pi bridge
 * (`bridge.ts` / `bridge-host.ts` / `worker.ts`) with stable request IDs and
 * machine-readable errors; the companion `orca-pi` CLI remains the
 * degraded fallback. This module only formats injected data into HTML/text
 * and detects what the installed host supports. When the host lacks the
 * structured bridge or a required capability, callers fall back to CLI +
 * informational panel content instead of undocumented access — never a
 * hidden panel-local store.
 */

import type { ProfilesPanelModel } from "@orca-pi/core";
import {
  BRIDGE_VERSION,
  negotiateBridgeCapabilities,
  type BridgeOperation,
} from "./bridge.js";

export const PROFILES_PANEL_ID = "orca-pi-profiles";

export interface PanelSupportInput {
  appVersion?: string;
  pluginApi?: number;
  grantedCapabilities?: readonly string[];
  /**
   * Seam handshake: true only when the panel↔bridge transport is present
   * (`window.__ORCA_PI_BRIDGE__.request`). Panels detect this at runtime;
   * absent (default) means structured editing stays disabled.
   */
  seamAvailable?: boolean;
}

export interface PanelSupport {
  /** True when the host can render the declarative read-only summary. */
  supported: boolean;
  /** Declarative sandboxed HTML summary (always true on pluginApi 1). */
  readOnlySummary: boolean;
  /** Live reload without manual refresh (true when the structured bridge is negotiated). */
  liveReload: boolean;
  /** Supported persistence/host path for edits (true only behind the structured bridge). */
  persistence: boolean;
  /** In-panel editing (true only behind the structured bridge; never a hidden store). */
  editing: boolean;
  /** Fallback strategy when capabilities are missing. */
  fallback: "structured" | "cli-only";
  /** True when the panel must use the read-only/degraded path. */
  degraded: boolean;
  /** Versioned bridge contract in use. */
  bridgeVersion: string;
  /** Structured operations available on this host (degraded hosts expose read-only subset). */
  supportedOperations: readonly BridgeOperation[];
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
 *
 * UI1.2 negotiates the versioned bridge (`bridge.ts`): structured requests
 * (live reload + persistence + editing behind the bridge host) require the
 * explicit seam handshake (`seamAvailable`, detected at runtime from
 * `window.__ORCA_PI_BRIDGE__.request`) plus versions and `workspace:read`
 * consent. Stock Orca without the seam degrades explicitly to read-only
 * CLI fallback — liveReload/persistence/editing stay false and no
 * "structured available" claim is made. Unknown versions or grants
 * degrade the same way (fail-closed).
 */
export function detectPanelSupport(input?: PanelSupportInput): PanelSupport {
  const reasons: string[] = [];
  const pluginApi = input?.pluginApi;
  const appVersion = input?.appVersion;
  const negotiation = negotiateBridgeCapabilities({
    ...(appVersion !== undefined ? { appVersion } : {}),
    ...(pluginApi !== undefined ? { pluginApi } : {}),
    ...(input?.grantedCapabilities !== undefined
      ? { grantedCapabilities: input.grantedCapabilities }
      : {}),
    ...(input?.seamAvailable !== undefined ? { seamAvailable: input.seamAvailable } : {}),
  });

  const readOnlySummary =
    pluginApi === 1 && appVersion !== undefined && gte(appVersion, "1.4.0");
  const structured = negotiation.structured;
  reasons.push(...negotiation.reasons);
  if (structured) {
    reasons.push(
      `Structured bridge ${BRIDGE_VERSION} reachable via the seam handshake: live data via typed requests (request IDs + validation/conflict/unsupported/auth-setup/internal errors); mutations route through the authoritative core service.`,
    );
    reasons.push(
      "Panel never scrapes terminal output or YAML and never stores a second copy of profiles in settings/storage.",
    );
  } else {
    reasons.push(
      "Structured bridge unreachable (no seam handshake, unknown host version, or missing consent) — panel degrades explicitly to read-only CLI fallback with actionable terminal.sendText descriptors (explicit user gesture only, never parsed).",
    );
  }

  return {
    supported: readOnlySummary,
    readOnlySummary,
    liveReload: structured,
    persistence: structured,
    editing: structured,
    fallback: structured ? "structured" : "cli-only",
    degraded: !structured,
    bridgeVersion: BRIDGE_VERSION,
    supportedOperations: negotiation.supportedOperations,
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

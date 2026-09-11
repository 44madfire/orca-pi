/**
 * Thin Orca plugin entry (OP1.1 scaffold + UI1.2 bridge).
 *
 * Deliberately free of `node:child_process`, Electron, and Orca Desktop
 * imports. The versioned Orca↔Orca-Pi bridge (bridge.ts / bridge-host.ts /
 * worker.ts) owns structured configuration/status transport; this module
 * only describes contributions and formats status strings from injected
 * data — fully testable in Node.
 */
import type { DoctorReport } from "@orca-pi/core";

export {
  BRIDGE_OPERATIONS,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_READ_OPERATIONS,
  BRIDGE_VERSION,
  BRIDGE_WRITE_OPERATIONS,
  bridgeFail,
  bridgeOk,
  DEGRADED_SAFE_OPERATIONS,
  describeTerminalFallback,
  isAbsoluteProjectRoot,
  makeBridgeRequest,
  mapMutationCodeToBridge,
  negotiateBridgeCapabilities,
  normalizeProjectRoot,
  parseBridgeRequest,
  type BridgeError,
  type BridgeErrorCode,
  type BridgeNegotiation,
  type BridgeNegotiationInput,
  type BridgeOperation,
  type BridgeRequest,
  type BridgeResponse,
  type BridgeWorktreeScope,
  type TerminalFallbackAction,
} from "./bridge.js";
export { handleBridgeRequest, type BridgeHostDeps } from "./bridge-host.js";
export {
  createBridgeWorker,
  type BridgeWorker,
  type BridgeWorkerInit,
} from "./worker.js";

export {
  detectPanelSupport,
  escapeHtml,
  PROFILES_PANEL_ID,
  renderProfilesPanelHtml,
  renderProfilesStatusText,
  type PanelSupport,
  type PanelSupportInput,
} from "./panel.js";

/** Canonical install identity: `<publisher>.<id>` (also the install dir name). */
export const PLUGIN_KEY = "44madfire.orca-pi";
export const PANEL_ID = "orca-pi-status";

/**
 * Reserved for a later ticket: manifest v1 treats action-less commands as
 * worker commands requiring a `main` entry, and `action` aliases must come
 * from the host's closed built-in list — so OP1.1 ships no commands.
 */
export const PLUGIN_COMMAND_ID = "orca-pi.showStatus";

export interface PluginStatusInput {
  pluginVersion: string;
  pluginApi: number;
  doctor: DoctorReport;
}

/** Render the placeholder panel/command status text. Pure function. */
export function renderPluginStatus(input: PluginStatusInput): string {
  const orca = input.doctor.orca.version
    ? `orca ${input.doctor.orca.version}`
    : `orca (${input.doctor.orca.found ? "version unknown" : "missing"})`;
  const pi = input.doctor.pi.version
    ? `pi ${input.doctor.pi.version}`
    : `pi (${input.doctor.pi.found ? "version unknown" : "missing"})`;
  const health = input.doctor.ok
    ? "ready — both CLIs available"
    : "action needed — run `orca-pi doctor` for details";
  return [
    `Orca–Pi ${input.pluginVersion} (pluginApi ${input.pluginApi})`,
    `Companion CLIs: ${orca}, ${pi}`,
    `Status: ${health}`,
  ].join("\n");
}

/**
 * Activation record. The worker entry (`dist/worker.js`, manifest `main`)
 * serves the versioned bridge; panels stay declarative sandboxed HTML.
 *
 * UI1.2 adds the bridge worker alongside the status + profiles panels.
 * Live data flows through the typed panel↔bridge protocol (request IDs +
 * structured errors), never through `window.__ORCA_PI_PROFILES__` injection
 * (deprecated legacy path, read-only fallback only).
 */
export function activate(): { plugin: string; commands: string[]; panels: string[] } {
  return {
    plugin: PLUGIN_KEY,
    // No commands in OP1.1 (see PLUGIN_COMMAND_ID note above).
    commands: [],
    panels: [PANEL_ID, "orca-pi-profiles"],
  };
}

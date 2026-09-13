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
  BRIDGE_ERROR_CODES,
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
  isAllowlistedFallbackArgv,
  makeBridgeRequest,
  mapMutationCodeToBridge,
  negotiateBridgeCapabilities,
  normalizeProjectRoot,
  parseBridgeRequest,
  validateBridgeResponse,
  type BridgeError,
  type BridgeErrorCode,
  type BridgeNegotiation,
  type BridgeNegotiationInput,
  type BridgeOperation,
  type BridgeRequest,
  type BridgeResponse,
  type BridgeResponseValidation,
  type BridgeWorktreeScope,
  type TerminalFallbackAction,
} from "./bridge.js";
export { handleBridgeRequest, type BridgeHostDeps } from "./bridge-host.js";
export {
  createSeamAdapter,
  type SeamAdapter,
  type SeamAdapterOptions,
  type SeamHostFacts,
  type SeamHostVersions,
} from "./seam-adapter.js";
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
export {
  CONTROL_CENTER_BUILTIN_TOOLS,
  CONTROL_CENTER_COMPAT_PANEL_IDS,
  CONTROL_CENTER_EDITABLE_FIELDS,
  CONTROL_CENTER_PANEL_ID,
  CONTROL_CENTER_SESSION_MODES,
  CONTROL_CENTER_THINKING_LEVELS,
  buildMutateParams,
  builtinGuardText,
  controlCenterSections,
  describeArrayInheritanceNote,
  describeDegradedMode,
  describeLayer,
  describeMcpSummary,
  describeProvenance,
  isBuiltinProfileName,
  isBuiltinSaveBlocked,
  mapBridgeErrorToField,
  toListItems,
  validateDraftShape,
  validateProfileName,
  type BridgeErrorKind,
  type ControlCenterDraft,
  type ControlCenterField,
  type ControlCenterListItem,
  type ControlCenterScope,
  type ControlCenterSection,
  type ControlCenterSectionId,
  type DraftIssue,
  type MappedBridgeError,
} from "./control-center.js";

/** Canonical install identity: `<publisher>.<id>` (also the install dir name). */
export const PLUGIN_KEY = "44madfire.orca-pi";
export const PANEL_ID = "orca-pi-control-center";
/** Compatibility aliases (same Control Center entry, one UI). */
export const PANEL_COMPAT_IDS = ["orca-pi-status", "orca-pi-profiles"] as const;

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
 * UI1.3 owns the single Control Center shell plus compat aliases (one UI).
 * Live data flows through the typed panel↔bridge protocol (request IDs +
 * structured errors), never through `window.__ORCA_PI_PROFILES__` injection
 * (removed from the Control Center production path).
 */
export function activate(): { plugin: string; commands: string[]; panels: string[] } {
  return {
    plugin: PLUGIN_KEY,
    // No commands in OP1.1 (see PLUGIN_COMMAND_ID note above).
    commands: [],
    panels: [PANEL_ID, ...PANEL_COMPAT_IDS],
  };
}

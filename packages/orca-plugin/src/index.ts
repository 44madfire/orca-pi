/**
 * Thin Orca plugin entry (OP1.1 scaffold).
 *
 * Deliberately free of `node:child_process`, Electron, and Orca Desktop
 * imports: the plugin worker's capability model is still evolving
 * (stablyai/orca#15637), so all process spawning lives in the companion
 * `orca-pi` CLI. This module only describes contributions and formats a
 * status string from injected version/doctor data — fully testable in Node.
 */
import type { DoctorReport } from "@orca-pi/core";

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
 * Placeholder activation record. A future Orca plugin host can call this to
 * prove the artifact loads; it performs no I/O and requests no capabilities.
 */
export function activate(): { plugin: string; commands: string[]; panels: string[] } {
  return {
    plugin: PLUGIN_KEY,
    // No commands in OP1.1 (see PLUGIN_COMMAND_ID note above).
    commands: [],
    panels: [PANEL_ID],
  };
}

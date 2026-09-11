/**
 * Orca plugin worker entry (UI1.2).
 *
 * Manifest `main` for `44madfire.orca-pi`. Runs out-of-process via
 * `child_process.fork` channel in Orca main (see upstream
 * `plugin-host-protocol.ts`); the host re-gates every host call
 * regardless of what this worker believes is granted.
 *
 * Responsibilities:
 * - Track consented capabilities from `init` (`grantedCapabilities`) and
 *   fail fast client-side when a required capability is missing (honest
 *   consent — the host remains authoritative).
 * - Serve the versioned Orca-Pi bridge (`bridge-host.ts`) behind the
 *   future generic scoped-exec/plugin-service seam. Today the worker
 *   proves it loads, negotiates capabilities, and degrades explicitly;
 *   live data flows through the Node sidecar path until the seam lands.
 * - Handle worker commands/events minimally: UI1.2 ships no worker
 *   commands and no event subscriptions (panels are declarative), so
 *   invocations return `unsupported` instead of executing anything.
 *
 * Deliberately free of `node:child_process`, Electron, and unrestricted
 * network/filesystem access. Filesystem access happens only inside
 * `bridge-host.ts` via `@orca-pi/core` scoped to the explicit
 * `worktree.projectRoot` (never arbitrary host paths, never shell).
 */

import { handleBridgeRequest, type BridgeHostDeps } from "./bridge-host.js";
import {
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_VERSION,
  negotiateBridgeCapabilities,
} from "./bridge.js";

export interface BridgeWorkerInit {
  pluginId?: string;
  pluginRoot?: string;
  mainEntry?: string;
  grantedCapabilities?: readonly string[];
  appVersion?: string;
  pluginApi?: number;
}

export interface BridgeWorker {
  readonly pluginKey: string;
  onInit(init: BridgeWorkerInit): { ok: true; bridgeVersion: string; protocolVersion: number };
  getGrantedCapabilities(): readonly string[];
  isBridgeSupported(): boolean;
  degradationReasons(): string[];
  handleRequest(data: unknown): Promise<import("./bridge.js").BridgeResponse>;
  handleInvokeCommand(commandId: string): { ok: false; code: "unsupported"; error: string };
  handleDeliverEvent(event: string): { ok: true; ack: true };
}

export const PLUGIN_KEY = "44madfire.orca-pi";

/**
 * Create an isolated bridge worker (one per test; production creates one).
 * `deps` wires the bridge host (fs/env/runner/fetch) — panels never supply
 * these; they are host-side configuration, never panel input.
 */
export function createBridgeWorker(deps: BridgeHostDeps = {}): BridgeWorker {
  let granted: readonly string[] = [];
  let appVersion: string | undefined;
  let pluginApi: number | undefined;

  return {
    pluginKey: PLUGIN_KEY,
    onInit(init: BridgeWorkerInit) {
      granted = [...(init.grantedCapabilities ?? [])];
      if (init.appVersion !== undefined) appVersion = init.appVersion;
      if (init.pluginApi !== undefined) pluginApi = init.pluginApi;
      return { ok: true, bridgeVersion: BRIDGE_VERSION, protocolVersion: BRIDGE_PROTOCOL_VERSION };
    },
    getGrantedCapabilities() {
      return [...granted];
    },
    isBridgeSupported() {
      return negotiateBridgeCapabilities({ appVersion, pluginApi, grantedCapabilities: granted }).supported;
    },
    degradationReasons() {
      return negotiateBridgeCapabilities({ appVersion, pluginApi, grantedCapabilities: granted }).reasons;
    },
    async handleRequest(data: unknown) {
      const hostDeps: BridgeHostDeps = {
        ...deps,
        hostInfo: {
          ...(appVersion !== undefined ? { appVersion } : {}),
          ...(pluginApi !== undefined ? { pluginApi } : {}),
          grantedCapabilities: granted,
        },
      };
      return await handleBridgeRequest(data, hostDeps);
    },
    handleInvokeCommand(commandId: string) {
      // UI1.2 ships no worker commands (manifest contributes.commands is
      // empty): every invocation degrades explicitly instead of executing.
      return {
        ok: false,
        code: "unsupported" as const,
        error: `Unknown worker command ${JSON.stringify(commandId)} (orca-pi ships no worker commands; use the versioned bridge or the companion CLI).`,
      };
    },
    handleDeliverEvent() {
      // No event subscriptions in UI1.2 — acknowledge without side effects.
      return { ok: true, ack: true as const };
    },
  };
}

/**
 * Default singleton for the forked worker host. The Orca fork harness
 * calls `onInit` once with the consented capabilities, then routes
 * `invokeCommand` / `deliverEvent` / bridge calls here. Pure delegation —
 * no I/O at import time, safe to import in tests.
 */
const defaultWorker = createBridgeWorker({
  ...(process.env.ORCA_PI_PROJECT_ROOT ? { projectRoot: process.env.ORCA_PI_PROJECT_ROOT } : {}),
});

export function onInit(init: BridgeWorkerInit): { ok: true; bridgeVersion: string; protocolVersion: number } {
  return defaultWorker.onInit(init);
}

export function getGrantedCapabilities(): readonly string[] {
  return defaultWorker.getGrantedCapabilities();
}

export function isBridgeSupported(): boolean {
  return defaultWorker.isBridgeSupported();
}

export function handleRequest(data: unknown): Promise<import("./bridge.js").BridgeResponse> {
  return defaultWorker.handleRequest(data);
}

export function handleInvokeCommand(commandId: string): { ok: false; code: "unsupported"; error: string } {
  return defaultWorker.handleInvokeCommand(commandId);
}

export function handleDeliverEvent(event: string): { ok: true; ack: true } {
  return defaultWorker.handleDeliverEvent(event);
}

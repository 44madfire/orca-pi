/* global process */
/**
 * Orca plugin entry (UI1.2).
 *
 * Manifest `main` for `44madfire.orca-pi`. Orca's worker runtime
 * (`plugin-host-runtime.ts` upstream) imports this file via file URL and
 * requires a **default-exported `activate(orca)` function**; it is called
 * with the worker `orca` API (`commands.register`, `events.on`,
 * `host.call`, `grantedCapabilities`, `log`).
 *
 * This module is ESM (`.mjs`) so `import()` yields a real default export.
 * It uses only the `orca` API handed to `activate` — it never reimplements
 * the parent↔child fork/IPC channel (owned by Orca's own
 * `plugin-host-entry`, which validates every message with Zod on both
 * sides). Bridge logic lives in `dist/worker.js` / `dist/bridge-host.js`
 * (required here via `createRequire`); this file is only the activation
 * seam. No `child_process`, no shell, no network.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createBridgeWorker } = require("./dist/worker.js");
const { BRIDGE_VERSION, BRIDGE_PROTOCOL_VERSION } = require("./dist/bridge.js");

/**
 * Activate the Orca-Pi bridge worker.
 *
 * UI1.2 ships no worker commands and no event subscriptions (panels are
 * declarative), so `activate` registers nothing and `ready.commands` is
 * `[]`. It records the consented capabilities, logs the bridge version for
 * operator diagnostics, and degrades explicitly (via `log`, never by
 * throwing) when the host cannot support structured operations. Live data
 * flows through the Node sidecar path today and binds behind the future
 * generic scoped-exec/plugin-service seam tomorrow; `terminal.sendText`
 * stays an explicit panel-side degraded fallback only.
 *
 * @param {object} orca Worker API handed by the Orca runtime.
 */
export default async function activate(orca) {
  const grantedCapabilities = Array.isArray(orca?.grantedCapabilities)
    ? [...orca.grantedCapabilities]
    : undefined;
  // Seam handshake: the stock worker `orca` API exposes no transport of
  // its own, so structured operations stay disabled unless the seam
  // harness signals it. Either signal suffices; absent means degraded.
  const seamAvailable =
    orca?.seamAvailable === true || process.env.ORCA_PI_BRIDGE_SEAM === "1";
  const worker = createBridgeWorker({
    ...(process.env.ORCA_PI_PROJECT_ROOT ? { projectRoot: process.env.ORCA_PI_PROJECT_ROOT } : {}),
  });
  worker.onInit({
    pluginId: "44madfire.orca-pi",
    ...(grantedCapabilities !== undefined ? { grantedCapabilities } : {}),
    ...(typeof orca?.appVersion === "string" ? { appVersion: orca.appVersion } : {}),
    ...(typeof orca?.pluginApi === "number" ? { pluginApi: orca.pluginApi } : {}),
    ...(seamAvailable ? { seamAvailable: true } : {}),
  });
  const log = typeof orca?.log === "function" ? orca.log.bind(orca) : () => {};
  if (worker.isBridgeSupported()) {
    log(`orca-pi bridge ${BRIDGE_VERSION} (protocol ${BRIDGE_PROTOCOL_VERSION}) ready — structured requests available.`);
  } else {
    log(
      `orca-pi bridge ${BRIDGE_VERSION} degraded to read-only CLI fallback: ${worker.degradationReasons().join(" ")}`,
    );
  }
  // No commands.register / events.on in UI1.2 — declarative panels only.
}

/**
 * Opt-in real-Pi compatibility smoke (SNC1.10).
 *
 * Gated by `ORCA_PI_LIVE_SMOKE=1` so deterministic CI stays offline and
 * credential-free. When enabled, probes the real `pi` binary on the local
 * host ONLY (no remote/SSH/mobile/paired locations are ever attempted):
 *
 * 1. `pi --version` with a bounded timeout → `checkPiVersionSupport()`;
 *    unsupported versions fail closed with the Pi TUI fallback reason.
 * 2. Idle reads over the production `PiRpcConnection`
 *    (`get_state` / `get_entries`+`leafId` / `get_available_thinking_levels`)
 *    with an isolated `PI_CODING_AGENT_DIR` — no LLM calls, no network,
 *    no secrets.
 *
 * Native environment failures (missing binary, spawn errors, timeouts)
 * are reported SEPARATELY from code failures: they log a one-line
 * `LIVE-SMOKE-ENV` diagnostic and skip, never failing the suite. Only a
 * real protocol/contract violation fails.
 *
 * Platform boundary: this smoke is proven on win32 local hosts (where
 * fixtures were captured). darwin/linux local runs are welcome evidence —
 * report the `platform` + `piVersion` line from the output when filing
 * results. WSL/remote/SSH/mobile/paired locations are out of scope:
 * do not run this smoke there and do not claim support from it.
 *
 *   ORCA_PI_LIVE_SMOKE=1 npm test -- pi-live-smoke
 */

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPiVersionSupport, gatePiStructuredSession } from "../src/pi-compat.js";

const enabled = process.env["ORCA_PI_LIVE_SMOKE"] === "1";

function probePiVersion(): { raw: string } | { envFailure: string } {
  try {
    const raw = execFileSync("pi", ["--version"], { timeout: 15_000, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trim();
    return { raw };
  } catch (error) {
    return { envFailure: `pi binary unavailable on this host (${error instanceof Error ? error.message.split("\n")[0] : String(error)})` };
  }
}

describe.skipIf(!enabled)("real-Pi compatibility smoke (ORCA_PI_LIVE_SMOKE=1)", () => {
  it("probes version support and runs idle reads without credentials", async () => {
    const probe = probePiVersion();
    if ("envFailure" in probe) {
      console.warn(`LIVE-SMOKE-ENV: ${probe.envFailure} — skipping (environment, not a code failure)`);
      return;
    }
    console.warn(`LIVE-SMOKE: platform=${process.platform} piVersion=${probe.raw}`);
    const versionGate = checkPiVersionSupport(probe.raw);
    const gate = gatePiStructuredSession({
      location: { executionHostId: "local", wslDistro: null },
      agent: "pi",
      piVersion: probe.raw,
    });
    if (!versionGate.supported || !gate.structured) {
      console.warn(`LIVE-SMOKE-ENV: ${versionGate.reason} — skipping idle reads (fail-closed to Pi TUI as designed)`);
      expect(versionGate.fallback).toBe("pi-tui");
      return;
    }
    const { PiRpcConnection } = await import("@orca-pi/pi-rpc");
    const agentDir = mkdtempSync(join(tmpdir(), "snc110-live-"));
    const conn = new PiRpcConnection({
      piCommand: "pi",
      piArgs: ["--no-session", "--offline", "--no-skills", "--no-prompt-templates", "--no-extensions", "--no-context-files"],
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
      defaultTimeoutMs: 20_000,
      startupTimeoutMs: 20_000,
    });
    try {
      await conn.start();
    } catch (error) {
      console.warn(`LIVE-SMOKE-ENV: Pi startup failed (${error instanceof Error ? error.message.split("\n")[0] : String(error)}) — skipping (environment, not a code failure)`);
      return;
    }
    try {
      const state = await conn.getState();
      expect(state).toHaveProperty("isStreaming");
      const entries = await conn.getEntries();
      expect(Array.isArray(entries.entries)).toBe(true);
      expect(typeof entries.leafId).toBe("string");
      const levels = await conn.getAvailableThinkingLevels();
      expect(Array.isArray(levels.levels)).toBe(true);
    } finally {
      const result = await conn.close(3000);
      expect(result.forced).toBe(false);
    }
  }, 90_000);
});

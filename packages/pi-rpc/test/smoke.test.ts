/**
 * Optional real-Pi smoke test (SNC1.2).
 *
 * Gated by `PI_RPC_SMOKE=1` so CI stays offline. When enabled, spawns the
 * real `pi --mode rpc` binary offline (`--no-session --offline`), runs idle
 * `get_state` / `get_entries` / `get_available_thinking_levels` through the
 * production `PiRpcConnection`, and closes gracefully. No LLM calls, no
 * network, no secrets.
 *
 *   PI_RPC_SMOKE=1 npm test -- smoke
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { PiRpcConnection } from "../src/connection.js";

const enabled = process.env["PI_RPC_SMOKE"] === "1";

/**
 * Resolve a spawnable Pi invocation. On Windows git-bash boxes the `pi`
 * shim is a shell script (not directly spawnable), so honor
 * `PI_RPC_PI_CLI` (binary or `dist/bundle/cli.js`) then fall back to the
 * global npm bundle, mirroring `spike/capture.mjs`. Returns
 * `{ piCommand, piArgsPrefix }` where `piArgsPrefix` goes before the
 * caller's args.
 */
function resolvePiSpawn(): { piCommand: string; piArgsPrefix: string[] } {
  const override = process.env["PI_RPC_PI_CLI"];
  if (override) {
    if (override.endsWith(".js")) return { piCommand: process.execPath, piArgsPrefix: [override] };
    return { piCommand: override, piArgsPrefix: [] };
  }
  // Direct `pi` first (POSIX + Windows .cmd resolution via Node).
  for (const candidate of ["pi", "pi.cmd"]) {
    try {
      execFileSync(candidate, ["--version"], { timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
      return { piCommand: candidate, piArgsPrefix: [] };
    } catch {
      // Try the next candidate / bundle fallback.
    }
  }
  // Global npm bundle without invoking `npm` (Windows `npm.cmd` is not
  // directly spawnable without a shell). Check the standard locations.
  const candidates: string[] = [];
  try {
    const root = execFileSync("npm.cmd", ["root", "-g"], { timeout: 15_000, encoding: "utf8" }).trim();
    candidates.push(path.join(root, "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"));
  } catch {
    // Ignore; fall through to well-known paths.
  }
  for (const home of [process.env["APPDATA"], process.env["npm_config_prefix"]]) {
    if (home) {
      candidates.push(
        path.join(home, "npm", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"),
      );
    }
  }
  // Volta / per-user global installs.
  if (process.env["USERPROFILE"]) {
    candidates.push(
      path.join(
        process.env["USERPROFILE"],
        "AppData", "Roaming", "npm", "node_modules",
        "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js",
      ),
    );
  }
  for (const bundle of candidates) {
    try {
      if (bundle && fs.existsSync(bundle)) return { piCommand: process.execPath, piArgsPrefix: [bundle] };
    } catch {
      // Ignore.
    }
  }
  return { piCommand: "pi", piArgsPrefix: [] };
}

describe.skipIf(!enabled)("real-Pi smoke (PI_RPC_SMOKE=1)", () => {
  it("runs idle reads over the production transport", async () => {
    const { piCommand, piArgsPrefix } = resolvePiSpawn();
    const conn = new PiRpcConnection({
      piCommand,
      piArgs: [...piArgsPrefix, "--no-session", "--offline", "--no-skills", "--no-prompt-templates", "--no-extensions", "--no-context-files"],
      defaultTimeoutMs: 20_000,
      startupTimeoutMs: 20_000,
    });
    await conn.start();
    try {
      const state = await conn.getState();
      expect(state).toHaveProperty("isStreaming");
      const entries = await conn.getEntries();
      expect(Array.isArray(entries.entries)).toBe(true);
      expect(typeof entries.leafId).toBe("string");
      const levels = await conn.getAvailableThinkingLevels();
      expect(Array.isArray(levels.levels)).toBe(true);
      const stats = await conn.getSessionStats();
      expect(stats).toBeTypeOf("object");
    } finally {
      const result = await conn.close(3000);
      expect(result.forced).toBe(false);
    }
  }, 60_000);
});

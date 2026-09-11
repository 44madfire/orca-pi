/**
 * Orca plugin entry contract tests (UI1.2 review findings).
 *
 * Upstream `plugin-host-runtime.ts` imports the manifest `main` via file
 * URL and requires a default-exported `activate(orca)` function — a worker
 * entry with only named exports fails activation before the bridge can run.
 * These tests pin the contract: the entry default-exports an `activate`
 * that uses only the handed `orca` API (no fork/IPC reimplementation, no
 * child_process) and degrades explicitly via `log` instead of throwing.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

function loadManifest(): { main?: string } {
  return JSON.parse(readFileSync(join(here, "..", "orca-plugin.json"), "utf8")) as { main?: string };
}

describe("plugin entry contract", () => {
  it("manifest main points at the ESM entry that exists in the artifact", () => {
    const manifest = loadManifest();
    expect(manifest.main).toBe("worker-entry.mjs");
    expect(join(here, "..", manifest.main!)).toSatisfy((p) => {
      try {
        readFileSync(p as string, "utf8");
        return true;
      } catch {
        return false;
      }
    });
  });

  it("entry source default-exports activate(orca) with no IPC/child_process", () => {
    const manifest = loadManifest();
    const source = readFileSync(join(here, "..", manifest.main!), "utf8");
    expect(source).toMatch(/export default async function activate/);
    expect(source).toContain("grantedCapabilities");
    // Uses only the handed orca API — never the fork channel or processes.
    expect(source).not.toContain("node:child_process");
    expect(source).not.toContain('require("child_process")');
    expect(source).not.toContain("hostCall");
    expect(source).not.toContain("callId");
    expect(source).not.toContain("fork(");
  });

  it("entry activate initializes the bridge and logs (never throws)", async () => {
    const entry = (await import("../worker-entry.mjs")) as {
      default: (orca: unknown) => Promise<unknown>;
    };
    expect(typeof entry.default).toBe("function");

    const previousSeam = process.env.ORCA_PI_BRIDGE_SEAM;
    process.env.ORCA_PI_BRIDGE_SEAM = "1";
    try {
      const logs: string[] = [];
      await entry.default({
        grantedCapabilities: ["workspace:read", "terminal:send"],
        appVersion: "1.4.199",
        pluginApi: 1,
        log: (message: string) => {
          logs.push(message);
        },
      });
      expect(logs.join("\n")).toMatch(/orca-pi bridge .* ready/);
    } finally {
      if (previousSeam === undefined) delete process.env.ORCA_PI_BRIDGE_SEAM;
      else process.env.ORCA_PI_BRIDGE_SEAM = previousSeam;
    }

    // Stock worker API (no versions, no grants, no seam signal) degrades
    // explicitly instead of claiming structured support.
    const degradedLogs: string[] = [];
    await entry.default({
      grantedCapabilities: [],
      log: (message: string) => {
        degradedLogs.push(message);
      },
    });
    expect(degradedLogs.join("\n")).toMatch(/degraded/);

    // Minimal orca (no log, no capabilities) still resolves — explicit
    // degradation, never a thrown activation failure.
    await expect(entry.default({})).resolves.toBeUndefined();
  });
});

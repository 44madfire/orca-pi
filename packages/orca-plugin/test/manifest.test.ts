import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { qualifiedPluginKey, validatePluginManifest } from "@orca-pi/core";
import { activate, renderPluginStatus } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));

function loadArtifact(): { manifest: unknown; panelHtml: string } {
  const root = join(here, "..");
  const manifest = JSON.parse(readFileSync(join(root, "orca-plugin.json"), "utf8")) as unknown;
  const panelHtml = readFileSync(join(root, "panel.html"), "utf8");
  return { manifest, panelHtml };
}

describe("orca-plugin artifact", () => {
  it("ships a valid v1 manifest named orca-plugin.json", () => {
    const { manifest } = loadArtifact();
    const result = validatePluginManifest(manifest);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(
      qualifiedPluginKey(manifest as { publisher: string; id: string }),
    ).toBe("44madfire.orca-pi");
  });

  it("manifest version tracks the plugin package version", () => {
    const { manifest } = loadArtifact();
    const pkg = JSON.parse(
      readFileSync(join(here, "..", "package.json"), "utf8"),
    ) as { version: string };
    expect((manifest as { version: string }).version).toBe(pkg.version);
  });

  it("every panel entry points at a file that exists in the artifact", () => {
    const { manifest } = loadArtifact();
    const panels = (manifest as { contributes: { panels: { entry: string }[] } })
      .contributes.panels;
    expect(panels.length).toBeGreaterThan(0);
    for (const panel of panels) {
      expect(existsSync(join(here, "..", panel.entry))).toBe(true);
    }
  });

  it("ships the Control Center as the primary panel referencing the companion CLI", () => {
    const root = join(here, "..");
    const center = readFileSync(join(root, "panel", "control-center.html"), "utf8");
    expect(center).toContain("Orca-Pi Control Center");
    expect(center).toContain("orca-pi doctor");
    // Legacy standalone entries stay on disk as deprecated fallbacks only;
    // the manifest primary + compat aliases all share the Control Center.
    for (const legacy of ["panel.html", join("panel", "profiles.html")]) {
      expect(existsSync(join(root, legacy))).toBe(true);
    }
  });

  it("declares the bridge worker main and only the capabilities actually used", () => {
    const { manifest } = loadArtifact();
    const typed = manifest as {
      main?: string;
      capabilities: { kind: string }[];
      contributes: { commands: { action?: string }[] };
    };
    // UI1.2: worker entry serves the versioned bridge; panels genuinely
    // call workspace:read (fallback terminal target) + terminal:send
    // (explicit user-triggered fallback only) — verified by
    // panel-actions.test.ts against the shipped scripts. No
    // storage/secrets/settings/notifications — nothing unused is declared.
    expect(typed.main).toBe("worker-entry.mjs");
    const kinds = typed.capabilities.map((cap) => cap.kind).sort();
    expect(kinds).toEqual(["terminal:send", "workspace:read"]);
    // Every declared command must carry a built-in action alias: action-less
    // commands are worker commands and would require a `main` entry (we have
    // one, but UI1.2 still ships no worker commands — invocations degrade).
    for (const command of typed.contributes.commands) {
      expect(typeof command.action).toBe("string");
    }
  });

  it("ships the Control Center as primary with compat aliases (one UI)", () => {
    const { manifest } = loadArtifact();
    const panels = (manifest as { contributes: { panels: { id: string; entry: string }[] } }).contributes.panels;
    const byId = new Map(panels.map((p) => [p.id, p.entry]));
    expect(byId.get("orca-pi-control-center")).toBe("panel/control-center.html");
    // Compat aliases point at the same entry — one UI, never two independent UIs.
    expect(byId.get("orca-pi-status")).toBe("panel/control-center.html");
    expect(byId.get("orca-pi-profiles")).toBe("panel/control-center.html");
    const center = readFileSync(join(here, "..", "panel", "control-center.html"), "utf8");
    expect(center).toContain("Orca-Pi Control Center");
    expect(center).toContain("Profiles");
    expect(center).toContain("Orchestration");
    expect(center).toContain("GitHub");
    expect(center).toContain("Diagnostics");
  });

  it("activates without I/O and renders status from injected doctor data", () => {
    expect(activate()).toEqual({
      plugin: "44madfire.orca-pi",
      commands: [],
      panels: ["orca-pi-control-center", "orca-pi-status", "orca-pi-profiles"],
    });
    const text = renderPluginStatus({
      pluginVersion: "0.1.0",
      pluginApi: 1,
      doctor: {
        ok: true,
        orca: { executable: "orca", found: true, version: "1.4.196", detail: "orca 1.4.196" },
        pi: { executable: "pi", found: true, version: "0.84.4", detail: "pi 0.84.4" },
      },
    });
    expect(text).toContain("0.1.0");
    expect(text).toContain("orca 1.4.196");
    expect(text).toContain("pi 0.84.4");
  });
});

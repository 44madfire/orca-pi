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

  it("ships a placeholder panel referencing the companion CLI", () => {
    const { panelHtml } = loadArtifact();
    expect(panelHtml).toContain("Orca–Pi Status");
    expect(panelHtml).toContain("orca-pi doctor");
  });

  it("declares no worker main and no capabilities (declarative-only scaffold)", () => {
    const { manifest } = loadArtifact();
    const typed = manifest as { main?: string; capabilities: unknown[] };
    expect(typed.main).toBeUndefined();
    expect(typed.capabilities).toEqual([]);
  });

  it("activates without I/O and renders status from injected doctor data", () => {
    expect(activate()).toEqual({
      plugin: "44madfire.orca-pi",
      commands: ["orca-pi.showStatus"],
      panels: ["orca-pi-status"],
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

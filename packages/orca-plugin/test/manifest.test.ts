import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validatePluginManifest } from "@orca-pi/core";
import { activate, renderPluginStatus } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));

function loadArtifact(): { manifest: unknown; panelHtml: string; commands: unknown } {
  const root = join(here, "..");
  const manifest = JSON.parse(readFileSync(join(root, "orca.plugin.json"), "utf8")) as unknown;
  const panelHtml = readFileSync(join(root, "panel.html"), "utf8");
  const commands = JSON.parse(readFileSync(join(root, "commands.json"), "utf8")) as unknown;
  return { manifest, panelHtml, commands };
}

describe("orca-plugin artifact", () => {
  it("ships a valid manifest", () => {
    const { manifest } = loadArtifact();
    const result = validatePluginManifest(manifest);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("manifest version tracks the plugin package version", () => {
    const { manifest } = loadArtifact();
    const pkg = JSON.parse(
      readFileSync(join(here, "..", "package.json"), "utf8"),
    ) as { version: string };
    expect((manifest as { version: string }).version).toBe(pkg.version);
  });

  it("ships a placeholder panel referencing the companion CLI", () => {
    const { panelHtml } = loadArtifact();
    expect(panelHtml).toContain("Orca–Pi Status");
    expect(panelHtml).toContain("orca-pi doctor");
  });

  it("ships a placeholder command matching the manifest", () => {
    const { manifest, commands } = loadArtifact();
    const manifestCommands = (manifest as { contributions: { commands: { id: string }[] } })
      .contributions.commands;
    expect(manifestCommands.map((c) => c.id)).toContain("orca-pi.showStatus");
    expect(JSON.stringify(commands)).toContain("orca-pi.showStatus");
  });

  it("activates without I/O and renders status from injected doctor data", () => {
    expect(activate()).toEqual({
      plugin: "orca-pi",
      commands: ["orca-pi.showStatus"],
      panels: ["orca-pi.status"],
    });
    const text = renderPluginStatus({
      pluginVersion: "0.1.0",
      orcaApiVersion: "1.4.x",
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

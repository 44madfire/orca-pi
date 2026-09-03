import { describe, expect, it } from "vitest";
import { qualifiedPluginKey, validatePluginManifest } from "../src/index.js";

const VALID = {
  manifestVersion: 1,
  id: "orca-pi",
  publisher: "44madfire",
  name: "Orca–Pi Orchestration",
  version: "0.1.0",
  description: "Thin Orca shell over the companion orca-pi CLI.",
  repository: "https://github.com/44madfire/orca-pi",
  engines: { orca: ">=1.4.0" },
  pluginApi: 1,
  contributes: {
    panels: [{ id: "orca-pi-status", title: "Orca-Pi Status", entry: "panel.html" }],
    commands: [{ id: "orca-pi.showStatus", title: "Orca-Pi: Show Status", context: "global" }],
  },
  capabilities: [],
};

describe("validatePluginManifest", () => {
  it("accepts a well-formed v1 manifest", () => {
    expect(validatePluginManifest(VALID)).toEqual({ ok: true, errors: [] });
  });

  it("accepts a minimal manifest (optional keys omitted)", () => {
    expect(
      validatePluginManifest({
        manifestVersion: 1,
        id: "example",
        publisher: "example",
        name: "Example",
        version: "1.0.0",
        engines: { orca: ">=1.4.0" },
        pluginApi: 1,
      }),
    ).toEqual({ ok: true, errors: [] });
  });

  it("derives the qualified <publisher>.<id> key", () => {
    expect(qualifiedPluginKey(VALID)).toBe("44madfire.orca-pi");
  });

  it("rejects non-objects", () => {
    expect(validatePluginManifest(null).ok).toBe(false);
    expect(validatePluginManifest("orca-pi").ok).toBe(false);
  });

  it("requires manifestVersion 1, kebab-case id/publisher, semver, engines range, pluginApi 1", () => {
    const result = validatePluginManifest({
      ...VALID,
      manifestVersion: 2,
      id: "Orca_Pi",
      publisher: "",
      version: "not-semver",
      engines: { orca: "^1.4.0" },
      pluginApi: "1.x",
    });
    expect(result.ok).toBe(false);
    const joined = result.errors.join("\n");
    expect(joined).toContain("manifestVersion");
    expect(joined).toContain("manifest.id");
    expect(joined).toContain("manifest.publisher");
    expect(joined).toContain("manifest.version");
    expect(joined).toContain("manifest.engines.orca");
    expect(joined).toContain("manifest.pluginApi");
  });

  it("rejects dot-prefixed panel entries and unknown contribution points", () => {
    const result = validatePluginManifest({
      ...VALID,
      contributes: {
        panels: [{ id: "p", title: "P", entry: "./panel.html" }],
        skills: [{ id: "s", path: "./skills/s" }],
      },
    });
    expect(result.ok).toBe(false);
    const joined = result.errors.join("\n");
    expect(joined).toContain("panels[0].entry");
    expect(joined).toContain("contributes.skills");
  });

  it("rejects duplicate command ids and bad event names", () => {
    const result = validatePluginManifest({
      ...VALID,
      contributes: {
        commands: [
          { id: "a.b", title: "A" },
          { id: "a.b", title: "A again" },
        ],
        events: [{ on: "plugin.clicked" }],
      },
    });
    expect(result.ok).toBe(false);
    const joined = result.errors.join("\n");
    expect(joined).toContain("duplicate command id");
    expect(joined).toContain("contributes.events[0].on");
  });
});

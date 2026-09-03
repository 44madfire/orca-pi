import { describe, expect, it } from "vitest";
import { validatePluginManifest } from "../src/index.js";

const VALID = {
  name: "orca-pi",
  displayName: "Orca–Pi Orchestration",
  version: "0.1.0",
  description: "Thin Orca shell over the companion orca-pi CLI.",
  orcaApiVersion: "1.4.x",
  contributions: {
    commands: [{ id: "orca-pi.showStatus", title: "Orca-Pi: Show Status" }],
    panels: [{ id: "orca-pi.status", title: "Orca-Pi Status", entry: "./panel.html" }],
    skills: [{ id: "orca-pi-doctor", path: "./skills/orca-pi-doctor" }],
  },
};

describe("validatePluginManifest", () => {
  it("accepts a well-formed manifest", () => {
    expect(validatePluginManifest(VALID)).toEqual({ ok: true, errors: [] });
  });

  it("rejects non-objects", () => {
    expect(validatePluginManifest(null).ok).toBe(false);
    expect(validatePluginManifest("orca-pi").ok).toBe(false);
  });

  it("requires name, version, and orcaApiVersion", () => {
    const result = validatePluginManifest({
      ...VALID,
      name: "",
      version: "not-semver",
      orcaApiVersion: "",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("manifest.name");
    expect(result.errors.join("\n")).toContain("manifest.version");
    expect(result.errors.join("\n")).toContain("manifest.orcaApiVersion");
  });

  it("validates command and panel entries", () => {
    const result = validatePluginManifest({
      ...VALID,
      contributions: {
        commands: [{ id: "", title: "" }],
        panels: [{ id: "x", title: "X", entry: "/absolute/panel.html" }],
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("commands[0].id");
    expect(result.errors.join("\n")).toContain("panels[0].entry");
  });
});

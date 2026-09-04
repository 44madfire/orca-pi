import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validatePluginManifest } from "@orca-pi/core";
import {
  activate,
  detectPanelSupport,
  escapeHtml,
  renderProfilesPanelHtml,
  renderProfilesStatusText,
} from "../src/index.js";
import type { ProfilesPanelModel } from "@orca-pi/core";

const here = dirname(fileURLToPath(import.meta.url));

function model(overrides?: Partial<ProfilesPanelModel>): ProfilesPanelModel {
  return {
    profiles: [
      {
        name: "scout",
        displayName: "Scout",
        model: "anthropic/claude-haiku",
        thinking: "low",
        toolCount: 4,
        skillNames: [".pi/skills/repo-search"],
        skillCount: 1,
        extensionCount: 0,
        contextFiles: false,
        valid: true,
      },
    ],
    validation: { ok: true, invalidCount: 0 },
    config: {
      userPath: "/home/u/.pi/agent/profiles.yaml",
      projectPath: "/repo/p/.pi/profiles.yaml",
      userExists: true,
      projectExists: true,
    },
    ...overrides,
  };
}

describe("profiles panel: rendering states", () => {
  it("renders valid profiles with model/thinking/counts/policy", () => {
    const html = renderProfilesPanelHtml(model());
    expect(html).toContain("scout");
    expect(html).toContain("anthropic/claude-haiku");
    expect(html).toContain("low");
    expect(html).toContain("4 tools");
    expect(html).toContain(".pi/skills/repo-search");
    expect(html).toContain("orca-pi profile validate");
    expect(html).toContain("orca-pi profile path");
  });

  it("renders no profiles with config locations and CLI guidance", () => {
    const html = renderProfilesPanelHtml(
      model({ profiles: [], validation: { ok: true, invalidCount: 0 } }),
    );
    expect(html).toContain("No Pi profiles found");
    expect(html).toContain("/home/u/.pi/agent/profiles.yaml");
    expect(html).toContain("examples.yaml");
    expect(html).not.toContain("<script");
  });

  it("renders invalid profiles with validation state", () => {
    const html = renderProfilesPanelHtml(
      model({
        profiles: [
          {
            name: "bad",
            thinking: "medium",
            skillNames: [],
            skillCount: 0,
            extensionCount: 0,
            contextFiles: false,
            valid: false,
          },
        ],
        validation: { ok: false, invalidCount: 1 },
      }),
    );
    expect(html).toContain("INVALID");
    expect(html).toContain("1 invalid");
    expect(html).toContain("orca-pi profile validate");
  });

  it("renders missing config with (missing) markers", () => {
    const html = renderProfilesPanelHtml(
      model({
        config: {
          userPath: "/home/u/.pi/agent/profiles.yaml",
          projectPath: "/repo/p/.pi/profiles.yaml",
          userExists: false,
          projectExists: false,
        },
      }),
    );
    expect(html).toContain("(missing)");
  });

  it("escapes hostile profile names/models/paths", () => {
    const html = renderProfilesPanelHtml(
      model({
        profiles: [
          {
            name: "<img src=x>",
            model: 'a"b<c>',
            thinking: "low",
            skillNames: ["<evil>"],
            skillCount: 1,
            extensionCount: 0,
            contextFiles: false,
            valid: true,
          },
        ],
      }),
    );
    expect(html).not.toContain("<img src=x>");
    expect(html).toContain("&lt;img");
    expect(escapeHtml(`<a href="x">'`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;");
  });

  it("renders a plain-text status variant with the same data", () => {
    expect(renderProfilesStatusText(model())).toContain("scout");
    expect(
      renderProfilesStatusText(
        model({ profiles: [], validation: { ok: true, invalidCount: 0 } }),
      ),
    ).toContain("No Pi profiles found");
  });
});

describe("profiles panel: feature detection and fallback", () => {
  it("supports read-only summary on the targeted host, without persistence/editing", () => {
    const support = detectPanelSupport({ appVersion: "1.4.196", pluginApi: 1 });
    expect(support.supported).toBe(true);
    expect(support.readOnlySummary).toBe(true);
    expect(support.liveReload).toBe(false);
    expect(support.persistence).toBe(false);
    expect(support.editing).toBe(false);
    expect(support.fallback).toBe("cli-only");
  });

  it("degrades gracefully on unsupported hosts without a hidden store", () => {
    const old = detectPanelSupport({ appVersion: "1.3.0", pluginApi: 1 });
    expect(old.supported).toBe(false);
    expect(old.fallback).toBe("cli-only");
    expect(old.editing).toBe(false);
    const future = detectPanelSupport({ appVersion: "1.4.196", pluginApi: 99 });
    expect(future.supported).toBe(false);
    expect(future.readOnlySummary).toBe(false);
  });

  it("activates both declarative panels with no worker or capabilities", () => {
    expect(activate()).toEqual({
      plugin: "44madfire.orca-pi",
      commands: [],
      panels: ["orca-pi-status", "orca-pi-profiles"],
    });
    const manifest = JSON.parse(
      readFileSync(join(here, "..", "orca-plugin.json"), "utf8"),
    ) as unknown;
    const result = validatePluginManifest(manifest);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("ships both panel entries with CLI fallback content and no escape hatch", () => {
    const status = readFileSync(join(here, "..", "panel.html"), "utf8");
    const profiles = readFileSync(join(here, "..", "panel", "profiles.html"), "utf8");
    expect(status).toContain("Orca–Pi Profiles");
    expect(profiles).toContain("Orca–Pi Profiles");
    expect(profiles).toContain("orca-pi profiles list");
    expect(profiles).toContain("orca-pi profile validate");
    // No undocumented bridge: no worker imports, filesystem requires, or fetch.
    expect(profiles).not.toContain("node:child_process");
    expect(profiles).not.toContain("node:fs");
    expect(profiles).not.toContain('require("fs")');
    expect(profiles).not.toContain("fetch(");
  });
});

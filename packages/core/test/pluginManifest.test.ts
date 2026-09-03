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
    commands: [
      { id: "orca-pi.showStatus", title: "Orca-Pi: Show Status", context: "global", action: "view.tasks" },
    ],
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

  it("requires main for worker commands (action-less) and event subscriptions", () => {
    const workerCommand = {
      ...VALID,
      contributes: {
        commands: [{ id: "orca-pi.showStatus", title: "Orca-Pi: Show Status" }],
      },
    };
    expect(validatePluginManifest(workerCommand).ok).toBe(false);
    expect(
      validatePluginManifest(workerCommand).errors.join("\n"),
    ).toContain("manifest.main is required");
    expect(
      validatePluginManifest({ ...workerCommand, main: "dist/index.js" }).ok,
    ).toBe(true);

    const withEvents = {
      ...VALID,
      main: "dist/index.js",
      contributes: { events: [{ on: "worktree.created" }] },
      capabilities: [{ kind: "events:subscribe" }],
    };
    expect(validatePluginManifest(withEvents)).toEqual({ ok: true, errors: [] });
    // Missing main fails…
    expect(
      validatePluginManifest({ ...withEvents, main: undefined }).ok,
    ).toBe(false);
    // …and so does a missing events:subscribe capability.
    const withoutCapability = validatePluginManifest({ ...withEvents, capabilities: [] });
    expect(withoutCapability.ok).toBe(false);
    expect(withoutCapability.errors.join("\n")).toContain("events:subscribe");
  });

  it("validates capability entries against the closed v0 kind set", () => {
    const base = { ...VALID, main: "dist/index.js" };
    expect(
      validatePluginManifest({ ...base, capabilities: [{ kind: "storage" }] }),
    ).toEqual({ ok: true, errors: [] });

    const unknownKind = validatePluginManifest({
      ...base,
      capabilities: [{ kind: "network:admin" }],
    });
    expect(unknownKind.ok).toBe(false);
    expect(unknownKind.errors.join("\n")).toContain("capabilities[0].kind");

    const nonStrict = validatePluginManifest({
      ...base,
      capabilities: [{ kind: "storage", scope: "global" }],
    });
    expect(nonStrict.ok).toBe(false);
    expect(nonStrict.errors.join("\n")).toContain("strict");

    const tooMany = validatePluginManifest({
      ...base,
      capabilities: Array.from({ length: 33 }, () => ({ kind: "storage" })),
    });
    expect(tooMany.ok).toBe(false);
    expect(tooMany.errors.join("\n")).toContain("at most 32");
  });

  it("validates language packs and keybindings against host schemas", () => {
    const base = {
      ...VALID,
      contributes: {
        commands: [{ id: "open-tasks", title: "Open Tasks", context: "global", action: "view.tasks" }],
        languagePacks: [{ locale: "pt-BR", path: "locales/pt-BR.json" }],
        keybindings: [{ command: "open-tasks", key: "Mod+Alt+T", when: "global" }],
      },
    };
    expect(validatePluginManifest(base)).toEqual({ ok: true, errors: [] });

    const badLocale = validatePluginManifest({
      ...base,
      contributes: { languagePacks: [{ locale: "not a locale!", path: "x.json" }] },
    });
    expect(badLocale.ok).toBe(false);
    expect(badLocale.errors.join("\n")).toContain("languagePacks[0].locale");

    const danglingKeybinding = validatePluginManifest({
      ...base,
      contributes: { keybindings: [{ command: "missing.command", key: "Mod+Alt+T" }] },
    });
    expect(danglingKeybinding.ok).toBe(false);
    expect(danglingKeybinding.errors.join("\n")).toContain("unknown contributed command");

    const contextMismatch = validatePluginManifest({
      ...base,
      contributes: {
        commands: [{ id: "open-tasks", title: "Open Tasks", context: "worktree", action: "view.tasks" }],
        keybindings: [{ command: "open-tasks", key: "Mod+Alt+T", when: "global" }],
      },
    });
    expect(contextMismatch.ok).toBe(false);
    expect(contextMismatch.errors.join("\n")).toContain("must match its command context");
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

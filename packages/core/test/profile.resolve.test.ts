import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAndValidateProfilesText } from "../src/profile/load.js";
import {
  ProfileResolveError,
  resolveAllProfiles,
  resolveProfile,
} from "../src/profile/resolve.js";
import { ProfileValidationError } from "../src/profile/schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string =>
  readFileSync(join(here, "fixtures/profiles", name), "utf8");

describe("profile resolve: defaults and full profiles", () => {
  it("fills lean built-in defaults and freezes the result", () => {
    const doc = parseAndValidateProfilesText(fixture("minimal.yaml"), "minimal.yaml");
    const resolved = resolveProfile("scout", doc);
    expect(resolved.name).toBe("scout");
    expect(resolved.extendsChain).toEqual(["scout"]);
    expect(resolved.model).toBe("anthropic/claude-haiku");
    // Lean defaults: explicit opt-in for ambient discovery, never resume.
    expect(resolved.thinking).toBe("medium");
    expect(resolved.contextFiles).toBe(false);
    expect(resolved.discoverSkills).toBe(false);
    expect(resolved.discoverExtensions).toBe(false);
    expect(resolved.session).toBe("ephemeral");
    // Immutable: profile and arrays are frozen.
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.extendsChain)).toBe(true);
  });

  it("resolves a full profile preserving every execution field", () => {
    const doc = parseAndValidateProfilesText(fixture("full.yaml"), "full.yaml");
    const resolved = resolveProfile("worker", doc);
    expect(resolved.provider).toBe("anthropic");
    expect(resolved.model).toBe("anthropic/claude-sonnet");
    expect(resolved.thinking).toBe("high");
    expect(resolved.systemPromptFile).toBe(".pi/agents/worker.md");
    expect(resolved.tools).toEqual(["read", "grep", "find", "ls", "bash", "edit", "write"]);
    expect(resolved.excludeTools).toEqual(["powershell"]);
    expect(resolved.skills).toEqual([".pi/skills/project", ".pi/skills/testing"]);
    expect(resolved.contextFiles).toBe(true);
    expect(resolved.session).toBe("fresh");
    expect(resolved.displayName).toBe("Worker");
  });

  it("never reads prompt/skill file contents to resolve", () => {
    const doc = parseAndValidateProfilesText(
      `profiles:
  ghost:
    model: anthropic/claude-haiku
    systemPromptFile: .pi/agents/does-not-exist.md
    skills: [.pi/skills/also-missing]
`,
      "ghost.yaml",
    );
    const resolved = resolveProfile("ghost", doc);
    // Resolution succeeds and keeps the normalized relative paths as-is.
    expect(resolved.systemPromptFile).toBe(".pi/agents/does-not-exist.md");
    expect(resolved.skills).toEqual([".pi/skills/also-missing"]);
  });

  it("never mutates the input document", () => {
    const doc = parseAndValidateProfilesText(fixture("inheritance.yaml"), "inheritance.yaml");
    const snapshot = JSON.parse(JSON.stringify(doc)) as unknown;
    resolveProfile("scout", doc);
    resolveAllProfiles(doc);
    expect(doc).toEqual(snapshot);
  });
});

describe("profile resolve: inheritance", () => {
  it("inherits missing fields and lets the child win", () => {
    const doc = parseAndValidateProfilesText(fixture("inheritance.yaml"), "inheritance.yaml");
    const scout = resolveProfile("scout", doc);
    expect(scout.extendsChain).toEqual(["readonly", "scout"]);
    // Inherited tools from readonly (scout defines no tools)...
    expect(scout.tools).toEqual(["read", "grep", "find", "ls"]);
    // ...but scout's own skills/thinking/model/prompt win.
    expect(scout.model).toBe("anthropic/claude-haiku");
    expect(scout.thinking).toBe("low");
    expect(scout.systemPromptFile).toBe(".pi/agents/scout.md");
    expect(scout.skills).toEqual([".pi/skills/repo-search"]);
    // Worker overrides tools wholesale.
    const worker = resolveProfile("worker", doc);
    expect(worker.extendsChain).toEqual(["worker"]);
    expect(worker.tools).toEqual(["read", "grep", "find", "ls", "bash", "edit", "write"]);
  });

  it("replaces arrays wholesale — no concat/append in v1", () => {
    const doc = parseAndValidateProfilesText(
      `profiles:
  base:
    tools: [read, grep]
    skills: [.pi/skills/a, .pi/skills/b]
  child:
    extends: base
    tools: [bash]
`,
      "arrays.yaml",
    );
    const child = resolveProfile("child", doc);
    expect(child.tools).toEqual(["bash"]);
    // Skills fall through untouched when the child omits them.
    expect(child.skills).toEqual([".pi/skills/a", ".pi/skills/b"]);
  });

  it("child prompt fields clear the parent's opposite prompt field", () => {
    const doc = parseAndValidateProfilesText(
      `profiles:
  base:
    systemPromptFile: .pi/agents/base.md
  child:
    extends: base
    systemPrompt: inline child prompt
  other:
    extends: base
`,
      "prompt-inherit.yaml",
    );
    const child = resolveProfile("child", doc);
    expect(child.systemPrompt).toBe("inline child prompt");
    expect(child.systemPromptFile).toBeUndefined();
    const other = resolveProfile("other", doc);
    expect(other.systemPromptFile).toBe(".pi/agents/base.md");
    expect(other.systemPrompt).toBeUndefined();
  });

  it("supports multi-level chains root-first", () => {
    const doc = parseAndValidateProfilesText(
      `profiles:
  a:
    thinking: low
    tools: [read]
  b:
    extends: a
    thinking: high
  c:
    extends: b
    model: anthropic/claude-sonnet
`,
      "chain.yaml",
    );
    const resolved = resolveProfile("c", doc);
    expect(resolved.extendsChain).toEqual(["a", "b", "c"]);
    expect(resolved.thinking).toBe("high");
    expect(resolved.tools).toEqual(["read"]);
    expect(resolved.model).toBe("anthropic/claude-sonnet");
  });
});

describe("profile resolve: errors", () => {
  it("rejects unknown profile names with available-name hints", () => {
    const doc = parseAndValidateProfilesText(fixture("inheritance.yaml"), "inheritance.yaml");
    try {
      resolveProfile("scouts", doc);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProfileResolveError);
      const resolveError = error as ProfileResolveError;
      expect(resolveError.code).toBe("unknown-profile");
      expect(resolveError.profileName).toBe("scouts");
      expect(resolveError.message).toContain('"scout"');
    }
  });

  it("rejects unknown parents with the child's name in context", () => {
    const doc = parseAndValidateProfilesText(
      fixture("invalid-unknown-parent.yaml"),
      "unknown-parent.yaml",
    );
    try {
      resolveProfile("scout", doc);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProfileResolveError);
      expect((error as ProfileResolveError).code).toBe("unknown-parent");
      expect((error as Error).message).toContain("does-not-exist");
    }
  });

  it("rejects extends cycles with the full chain", () => {
    const doc = parseAndValidateProfilesText(fixture("invalid-cycle.yaml"), "cycle.yaml");
    try {
      resolveProfile("a", doc);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProfileResolveError);
      const resolveError = error as ProfileResolveError;
      expect(resolveError.code).toBe("extends-cycle");
      expect(resolveError.message).toContain('"a"');
      expect(resolveError.message).toContain('"b"');
    }
  });

  it("rejects self-extends at validation time", () => {
    expect(() =>
      parseAndValidateProfilesText("profiles:\n  a:\n    extends: a\n", "self.yaml"),
    ).toThrow(ProfileValidationError);
  });
});

describe("profile resolve: CLI overrides (precedence level 6)", () => {
  it("applies overrides last with array replacement", () => {
    const doc = parseAndValidateProfilesText(fixture("inheritance.yaml"), "inheritance.yaml");
    const resolved = resolveProfile("scout", doc, {
      overrides: { model: "openai/gpt-4o", thinking: "high", tools: ["read"] },
      overridesLabel: "--model/--thinking/--tools",
    });
    expect(resolved.model).toBe("openai/gpt-4o");
    expect(resolved.thinking).toBe("high");
    expect(resolved.tools).toEqual(["read"]);
    // Untouched fields still come from the profile chain.
    expect(resolved.skills).toEqual([".pi/skills/repo-search"]);
  });

  it("override prompt fields clear the profile's opposite prompt field", () => {
    const doc = parseAndValidateProfilesText(fixture("full.yaml"), "full.yaml");
    const resolved = resolveProfile("worker", doc, {
      overrides: { systemPrompt: "override inline" },
    });
    expect(resolved.systemPrompt).toBe("override inline");
    expect(resolved.systemPromptFile).toBeUndefined();
  });

  it("rejects extends in overrides and invalid override values", () => {
    const doc = parseAndValidateProfilesText(fixture("minimal.yaml"), "minimal.yaml");
    expect(() =>
      resolveProfile("scout", doc, { overrides: { extends: "other" } }),
    ).toThrow(ProfileResolveError);
    try {
      resolveProfile("scout", doc, { overrides: { thinking: "ultra" } });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProfileResolveError);
      expect((error as ProfileResolveError).code).toBe("invalid-override");
    }
  });
});

describe("profile resolve: display metadata and sessions", () => {
  it("display metadata never affects execution fields", () => {
    const doc = parseAndValidateProfilesText(
      `profiles:
  a:
    model: anthropic/claude-haiku
    displayName: A
    description: First label.
  b:
    model: anthropic/claude-haiku
    displayName: B
    description: Second label.
`,
      "display.yaml",
    );
    const a = resolveProfile("a", doc);
    const b = resolveProfile("b", doc);
    const { displayName: _da, description: _dea, ...execA } = a;
    const { displayName: _db, description: _deb, ...execB } = b;
    void _da;
    void _dea;
    void _db;
    void _deb;
    // Execution-relevant fields are identical; only display differs.
    expect({ ...execA, name: "x", extendsChain: [] }).toEqual({
      ...execB,
      name: "x",
      extendsChain: [],
    });
    expect(a.displayName).toBe("A");
    expect(b.displayName).toBe("B");
  });

  it("resolves all profiles into a frozen map", () => {
    const doc = parseAndValidateProfilesText(fixture("inheritance.yaml"), "inheritance.yaml");
    const all = resolveAllProfiles(doc);
    expect(Object.keys(all).sort()).toEqual(["readonly", "scout", "worker"]);
    expect(Object.isFrozen(all)).toBe(true);
    expect(all.scout?.model).toBe("anthropic/claude-haiku");
  });
});

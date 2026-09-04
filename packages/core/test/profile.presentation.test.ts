import { describe, expect, it } from "vitest";
import {
  describeProfile,
  formatConfigPaths,
  formatProfileInspect,
  formatProfileShow,
  formatProfilesList,
  formatPromptForDisplay,
  formatValidationReport,
  shortenHomeForDisplay,
  summarizeAllProfiles,
  toPanelModel,
  truncatePromptPreview,
  validateAllProfiles,
  type ProfileLayerContext,
} from "../src/profile/presentation.js";
import {
  getBuiltinProfilesDocument,
} from "../src/profile/builtins.js";
import {
  mergeValidatedDocuments,
  parseAndValidateProfilesText,
} from "../src/profile/load.js";

function layersFor(userText?: string, projectText?: string): ProfileLayerContext {
  const builtinDoc = getBuiltinProfilesDocument();
  const userDoc = userText
    ? parseAndValidateProfilesText(userText, "/home/u/.pi/agent/profiles.yaml")
    : undefined;
  const projectDoc = projectText
    ? parseAndValidateProfilesText(projectText, "/repo/p/.pi/profiles.yaml")
    : undefined;
  const docs = [builtinDoc, userDoc, projectDoc].filter((doc) => doc !== undefined);
  const mergedDoc = mergeValidatedDocuments(docs);
  return {
    mergedDoc,
    builtinDoc,
    ...(userDoc ? { userDoc } : {}),
    ...(projectDoc ? { projectDoc } : {}),
    userPath: "/home/u/.pi/agent/profiles.yaml",
    projectPath: "/repo/p/.pi/profiles.yaml",
    userExists: userDoc !== undefined,
    projectExists: projectDoc !== undefined,
  };
}

describe("presentation: provenance", () => {
  it("attributes compiled defaults when no layer defines the field", () => {
    const layers = layersFor(
      "profiles:\n  custom:\n    model: anthropic/claude-haiku\n",
      undefined,
    );
    const detail = describeProfile("custom", layers);
    expect(detail.thinking.value).toBe("medium");
    expect(detail.thinking.provenance.kind).toBe("built-in");
    expect(detail.thinking.provenance.display).toBe("built-in");
    expect(detail.model.value).toBe("anthropic/claude-haiku");
    expect(detail.model.provenance.kind).toBe("user");
  });

  it("attributes JEF-10 built-in role fields as built-in on fresh installs", () => {
    const layers = layersFor(undefined, undefined);
    const detail = describeProfile("scout", layers);
    expect(detail.resolved.thinking).toBe("low");
    expect(detail.thinking.provenance.kind).toBe("built-in");
    expect(detail.thinking.provenance.display).toBe("built-in");
    expect(detail.tools.value).toEqual(["read", "grep", "find", "ls"]);
    expect(detail.tools.provenance.kind).toBe("built-in");
    expect(detail.systemPrompt.value).toContain("repository scout");
    expect(detail.systemPrompt.provenance.kind).toBe("built-in");
    // No model in the model-agnostic built-ins.
    expect(detail.model.value).toBeUndefined();
  });

  it("keeps role policy built-in under a sparse user model override", () => {
    const layers = layersFor(
      "profiles:\n  scout:\n    model: anthropic/claude-haiku\n",
      undefined,
    );
    const detail = describeProfile("scout", layers);
    expect(detail.model.value).toBe("anthropic/claude-haiku");
    expect(detail.model.provenance.display).toBe("user config");
    expect(detail.thinking.value).toBe("low");
    expect(detail.thinking.provenance.kind).toBe("built-in");
    expect(detail.tools.provenance.kind).toBe("built-in");
    expect(detail.systemPrompt.provenance.kind).toBe("built-in");
  });

  it("prefers project config over user config for the same profile field", () => {
    const layers = layersFor(
      "profiles:\n  shared:\n    model: user-model\n    thinking: low\n",
      "profiles:\n  shared:\n    thinking: high\n",
    );
    const detail = describeProfile("shared", layers);
    expect(detail.resolved.model).toBe("user-model");
    expect(detail.model.provenance.display).toBe("user config");
    expect(detail.resolved.thinking).toBe("high");
    expect(detail.thinking.provenance.display).toBe("project config");
  });

  it("marks ancestor definitions as inherited profiles", () => {
    const layers = layersFor(
      undefined,
      "profiles:\n  base:\n    tools: [read, grep]\n  child:\n    extends: base\n    model: anthropic/claude-haiku\n",
    );
    const detail = describeProfile("child", layers);
    expect(detail.resolved.tools).toEqual(["read", "grep"]);
    expect(detail.tools.provenance.inherited).toBe(true);
    expect(detail.tools.provenance.display).toContain('inherited profile "base"');
    expect(detail.tools.provenance.display).toContain("project config");
    expect(detail.model.provenance.inherited).toBe(false);
  });

  it("getFieldProvenance handles multi-level chains root-first", () => {
    const layers = layersFor(
      undefined,
      "profiles:\n  a:\n    thinking: low\n  b:\n    extends: a\n    thinking: high\n  c:\n    extends: b\n    model: anthropic/claude-haiku\n",
    );
    const detail = describeProfile("c", layers);
    expect(detail.thinking.value).toBe("high");
    expect(detail.thinking.provenance.definedIn).toBe("b");
    expect(detail.thinking.provenance.inherited).toBe(true);
  });
});

describe("presentation: redaction", () => {
  it("truncates long prompts with an explicit --show-prompt hint", () => {
    const long = "x".repeat(500);
    const without = formatPromptForDisplay(long);
    expect(without).toContain("truncated 500 chars");
    expect(without).toContain("--show-prompt");
    expect(without.length).toBeLessThan(long.length);
    expect(formatPromptForDisplay(long, { showFull: true })).toBe(long);
    expect(formatPromptForDisplay("short")).toBe("short");
    expect(formatPromptForDisplay(undefined)).toBe("(none)");
  });

  it("truncatePromptPreview reports lengths", () => {
    expect(truncatePromptPreview("abc", 10).truncated).toBe(false);
    const out = truncatePromptPreview("x".repeat(300), 240);
    expect(out.truncated).toBe(true);
    expect(out.fullLength).toBe(300);
  });

  it("show redacts by default and reveals with showPrompt", () => {
    const long = "secret-prompt ".repeat(30);
    const layers = layersFor(
      `profiles:\n  s:\n    model: anthropic/claude-haiku\n    systemPrompt: "${long}"\n`,
      undefined,
    );
    const detail = describeProfile("s", layers);
    const redacted = formatProfileShow(detail, layers, {});
    expect(redacted).toContain("truncated");
    expect(redacted).not.toContain(long);
    const full = formatProfileShow(detail, layers, { showPrompt: true });
    expect(full).toContain(long);
  });

  it("never loads skill/prompt file contents to render metadata", () => {
    const layers = layersFor(
      "profiles:\n  ghost:\n    model: anthropic/claude-haiku\n    systemPromptFile: .pi/agents/does-not-exist.md\n    skills: [.pi/skills/also-missing]\n",
      undefined,
    );
    const detail = describeProfile("ghost", layers);
    expect(detail.resolved.systemPromptFile).toBe(".pi/agents/does-not-exist.md");
    const text = formatProfileShow(detail, layers, {});
    expect(text).toContain(".pi/agents/does-not-exist.md");
    expect(text).toContain(".pi/skills/also-missing");
  });
});

describe("presentation: source-precedence display", () => {
  it("list shows counts plus precedence footer", () => {
    const layers = layersFor(
      "profiles:\n  scout:\n    model: anthropic/claude-haiku\n",
      "profiles:\n  worker:\n    model: anthropic/claude-sonnet\n    thinking: high\n",
    );
    const summaries = summarizeAllProfiles(layers);
    // Fresh-install builtins (reviewer/scout/worker) merge with file layers.
    expect(summaries.map((entry) => entry.name)).toEqual(["reviewer", "scout", "worker"]);
    const text = formatProfilesList(summaries, layers, {});
    expect(text).toContain("Pi profiles (3)");
    expect(text).toContain("scout");
    expect(text).toContain("worker");
    expect(text).toContain("precedence");
    expect(text).toContain("user/global");
    expect(text).toContain("project:");
  });

  it("list handles no profiles with config locations", () => {
    const layers = layersFor(undefined, undefined);
    const text = formatProfilesList([], layers, {});
    expect(text).toContain("No Pi profiles found");
    expect(text).toContain(layers.userPath);
    expect(text).toContain(layers.projectPath);
  });

  it("shortens home directories except in explicit path output", () => {
    expect(shortenHomeForDisplay("/home/u/.pi/agent/profiles.yaml", "/home/u")).toBe(
      "~/.pi/agent/profiles.yaml",
    );
    expect(shortenHomeForDisplay("/repo/p/.pi/profiles.yaml", "/home/u")).toBe(
      "/repo/p/.pi/profiles.yaml",
    );
    const layers = layersFor(undefined, undefined);
    expect(formatConfigPaths(layers)).toContain("authoritative");
    expect(formatConfigPaths({ ...layers }, { only: "user" })).toBe(layers.userPath);
    expect(formatConfigPaths({ ...layers }, { only: "project" })).toBe(layers.projectPath);
  });
});

describe("presentation: validation UX", () => {
  it("validates all profiles and reports file/source/field", () => {
    const layers = layersFor(
      "profiles:\n  good:\n    model: anthropic/claude-haiku\n",
      "profiles:\n  child:\n    extends: does-not-exist\n    model: anthropic/claude-haiku\n",
    );
    const entries = validateAllProfiles(layers);
    expect(entries.find((entry) => entry.name === "good")?.valid).toBe(true);
    const bad = entries.find((entry) => entry.name === "child");
    expect(bad?.valid).toBe(false);
    expect(bad?.code).toBe("unknown-parent");
    const report = formatValidationReport(entries, layers, {});
    expect(report).toContain("invalid child");
    expect(report).toContain("does-not-exist");
    expect(report).toContain("ok good");
  });

  it("reports all-valid with per-profile sources", () => {
    const layers = layersFor("profiles:\n  s:\n    model: x\n", undefined);
    const report = formatValidationReport(validateAllProfiles(layers), layers, {});
    // Custom profile plus the three fresh-install built-ins.
    expect(report).toContain("All 4 profiles valid");
  });

  it("inspect includes context policy and JEF-7 launch note when no provider", () => {
    const layers = layersFor(
      "profiles:\n  s:\n    model: anthropic/claude-haiku\n    skills: [.pi/skills/a]\n",
      undefined,
    );
    const detail = describeProfile("s", layers);
    const text = formatProfileInspect(detail, layers, {});
    expect(text).toContain("Context policy");
    expect(text).toContain("JEF-7");
    expect(text).toContain("never builds argv itself");
    const withPreview = formatProfileInspect(detail, layers, {
      launchPreview: "pi --model x --thinking medium (redacted)",
      contextSummaryText: "context summary for profile \"s\" (estimates, not provider billing):\n  prompt: 0 chars",
    });
    expect(withPreview).toContain("Launch preview");
    expect(withPreview).toContain("pi --model");
    expect(withPreview).toContain("estimates, not provider billing");
  });

  it("toPanelModel is metadata-only (no prompt bodies)", () => {
    const layers = layersFor(
      'profiles:\n  s:\n    model: anthropic/claude-haiku\n    systemPrompt: "inline secret body"\n    skills: [.pi/skills/a, .pi/skills/b]\n',
      undefined,
    );
    const model = toPanelModel(layers);
    const entry = model.profiles.find((profile) => profile.name === "s");
    expect(entry?.skillCount).toBe(2);
    expect(JSON.stringify(model)).not.toContain("inline secret body");
    expect(model.validation.ok).toBe(true);
  });
});

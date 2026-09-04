import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  getCandidateConfigPaths,
  getProjectProfilesPath,
  getUserProfilesPath,
  listProfileNames,
  loadMergedProfiles,
  loadProfilesFile,
  mergeValidatedDocuments,
  parseAndValidateProfilesText,
  parseProfilesText,
  ProfileLoadError,
} from "../src/profile/load.js";
import { ProfileValidationError } from "../src/profile/schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string =>
  readFileSync(join(here, "fixtures/profiles", name), "utf8");

describe("profile load: parsing", () => {
  it("parses YAML and JSON by content sniffing", () => {
    const fromYaml = parseProfilesText("profiles:\n  scout:\n    model: x\n", "a.yaml");
    expect(fromYaml).toEqual({ profiles: { scout: { model: "x" } } });
    const fromJson = parseProfilesText('{"profiles": {"scout": {"model": "x"}}}', "a.json");
    expect(fromJson).toEqual({ profiles: { scout: { model: "x" } } });
  });

  it("throws actionable diagnostics for malformed YAML with location", () => {
    let error: unknown;
    try {
      parseProfilesText(fixture("malformed.yaml"), "malformed.yaml");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ProfileLoadError);
    const loadError = error as ProfileLoadError;
    expect(loadError.sourceLabel).toBe("malformed.yaml");
    expect(loadError.message).toContain("malformed YAML");
    expect(loadError.message).toContain("Hint:");
  });

  it("throws actionable diagnostics for malformed JSON", () => {
    let error: unknown;
    try {
      parseProfilesText(fixture("malformed.json"), "malformed.json");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ProfileLoadError);
    expect((error as Error).message).toContain("malformed JSON");
  });

  it("rejects empty configs before validation", () => {
    expect(() => parseProfilesText("  \n", "empty.yaml")).toThrow(ProfileLoadError);
    expect(() => parseProfilesText("", "empty.yaml")).toThrow(/empty/);
  });

  it("parseAndValidate combines parsing and schema errors distinctly", () => {
    // Syntax failure → ProfileLoadError.
    expect(() => parseAndValidateProfilesText(fixture("malformed.yaml"), "bad.yaml")).toThrow(
      ProfileLoadError,
    );
    // Schema failure → ProfileValidationError (with source label).
    try {
      parseAndValidateProfilesText(fixture("invalid-thinking.yaml"), "thinking.yaml");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProfileValidationError);
      expect((error as ProfileValidationError).sourceLabel).toBe("thinking.yaml");
    }
  });

  it("never interpolates env vars or executes shell", () => {
    const raw = parseProfilesText(
      "profiles:\n  s:\n    model: $HOME\n    systemPrompt: \"$(whoami) `id`\"\n",
      "literal.yaml",
    ) as { profiles: { s: { model: string; systemPrompt: string } } };
    expect(raw.profiles.s.model).toBe("$HOME");
    expect(raw.profiles.s.systemPrompt).toBe("$(whoami) `id`");
  });
});

describe("profile load: merging and listing", () => {
  it("merges user < project with per-field override and array replacement", () => {
    const user = parseAndValidateProfilesText(
      `profiles:
  shared:
    model: user-model
    thinking: low
    tools: [read]
    skills: [.pi/skills/old]
`,
      "user.yaml",
    );
    const project = parseAndValidateProfilesText(
      `profiles:
  shared:
    thinking: high
    tools: [bash, edit]
  only-project:
    model: anthropic/claude-haiku
`,
      "project.yaml",
    );
    const merged = mergeValidatedDocuments([user, project]);
    expect(merged.sourceLabel).toContain("user.yaml");
    expect(merged.sourceLabel).toContain("project.yaml");
    // Project wins per-field; model falls through from user; tools replace.
    expect(merged.profiles.shared?.model).toBe("user-model");
    expect(merged.profiles.shared?.thinking).toBe("high");
    expect(merged.profiles.shared?.tools).toEqual(["bash", "edit"]);
    // Skills fall through from user when the project layer omits them.
    expect(merged.profiles.shared?.skills).toEqual([".pi/skills/old"]);
    expect(merged.profiles["only-project"]?.model).toBe("anthropic/claude-haiku");
  });

  it("prompt fields clear each other across layers (mutual exclusivity)", () => {
    const user = parseAndValidateProfilesText(
      "profiles:\n  s:\n    systemPromptFile: .pi/agents/old.md\n",
      "user.yaml",
    );
    const project = parseAndValidateProfilesText(
      "profiles:\n  s:\n    systemPrompt: inline override\n",
      "project.yaml",
    );
    const merged = mergeValidatedDocuments([user, project]);
    expect(merged.profiles.s?.systemPrompt).toBe("inline override");
    expect(merged.profiles.s?.systemPromptFile).toBeUndefined();
  });

  it("never mutates its inputs when merging", () => {
    const user = parseAndValidateProfilesText(
      "profiles:\n  s:\n    model: m\n    tools: [read]\n",
      "user.yaml",
    );
    const snapshot = JSON.parse(JSON.stringify(user)) as unknown;
    mergeValidatedDocuments([user]);
    expect(user).toEqual(snapshot);
  });

  it("lists profile names sorted without reading prompt/skill files", () => {
    const doc = parseAndValidateProfilesText(fixture("inheritance.yaml"), "inheritance.yaml");
    // The fixture references .pi/agents/*.md files that do not exist on
    // disk — listing must succeed without reading them.
    expect(listProfileNames(doc)).toEqual(["readonly", "scout", "worker"]);
  });

  it("documents one deterministic merge order via candidate paths", () => {
    const paths = getCandidateConfigPaths({
      projectRoot: "/repo/my-project",
      env: { PI_CODING_AGENT_DIR: "/home/u/.pi/agent" } as NodeJS.ProcessEnv,
    });
    expect(paths).toEqual([
      "/home/u/.pi/agent/profiles.yaml",
      "/repo/my-project/.pi/profiles.yaml",
    ]);
    // User/global falls back to ~/.pi/agent when the env var is unset.
    expect(
      getUserProfilesPath({ env: {} as NodeJS.ProcessEnv, homedir: "/home/u" }),
    ).toBe("/home/u/.pi/agent/profiles.yaml");
    expect(getProjectProfilesPath("/repo/my-project")).toBe(
      "/repo/my-project/.pi/profiles.yaml",
    );
  });

  it("resolves the OS home directory when HOME is unset (Windows-safe)", () => {
    // Native Windows rarely sets HOME; the loader must not return a literal
    // `~` path that loadProfilesFile cannot expand (PR2 non-blocking).
    expect(
      getUserProfilesPath({
        env: {} as NodeJS.ProcessEnv,
        osHomedir: () => "C:/Users/test",
      }),
    ).toBe("C:/Users/test/.pi/agent/profiles.yaml");
    // Explicit homedir still wins (tests), then HOME, then os.homedir().
    expect(
      getUserProfilesPath({
        env: { HOME: "/home/env" } as NodeJS.ProcessEnv,
        osHomedir: () => "C:/Users/os",
      }),
    ).toBe("/home/env/.pi/agent/profiles.yaml");
    expect(
      getCandidateConfigPaths({
        projectRoot: "/repo/p",
        env: {} as NodeJS.ProcessEnv,
        osHomedir: () => "/home/os",
      }),
    ).toEqual(["/home/os/.pi/agent/profiles.yaml", "/repo/p/.pi/profiles.yaml"]);
  });
});

describe("profile load: filesystem helpers", () => {
  it("loadProfilesFile returns undefined for missing files (optional layers)", async () => {
    const missing = await loadProfilesFile("/definitely/not/here/profiles.yaml");
    expect(missing).toBeUndefined();
  });

  it("loadProfilesFile reads, parses, and validates real files", async () => {
    const path = join(here, "fixtures/profiles/minimal.yaml");
    const doc = await loadProfilesFile(path);
    expect(doc?.profiles.scout?.model).toBe("anthropic/claude-haiku");
  });

  it("loadMergedProfiles merges user < project and skips missing files", async () => {
    const merged = await loadMergedProfiles({
      projectRoot: "/repo/my-project",
      userConfigPath: join(here, "fixtures/profiles/minimal.yaml"),
      projectConfigPath: "/definitely/not/here/profiles.yaml",
    });
    expect(listProfileNames(merged)).toEqual(["scout"]);
  });

  it("loadMergedProfiles surfaces schema errors with file context", async () => {
    await expect(
      loadMergedProfiles({
        projectRoot: "/repo",
        userConfigPath: join(here, "fixtures/profiles/invalid-thinking.yaml"),
        projectConfigPath: "/definitely/not/here/profiles.yaml",
      }),
    ).rejects.toThrow(ProfileValidationError);
  });
});

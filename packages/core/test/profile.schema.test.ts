import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_PROFILE_DEFAULTS,
  BUILTIN_TOOLS,
  ProfileValidationError,
  THINKING_LEVELS,
  validateProfileOverrides,
  validateProfilesDocument,
} from "../src/profile/schema.js";
import { parseAndValidateProfilesText } from "../src/profile/load.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string =>
  readFileSync(join(here, "fixtures/profiles", name), "utf8");

function expectInvalid(raw: unknown, sourceLabel: string, pathFragment: string): ProfileValidationError {
  let error: unknown;
  try {
    validateProfilesDocument(raw, sourceLabel);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(ProfileValidationError);
  const validationError = error as ProfileValidationError;
  expect(validationError.sourceLabel).toBe(sourceLabel);
  expect(validationError.issues.length).toBeGreaterThan(0);
  expect(validationError.message).toContain(sourceLabel);
  expect(validationError.issues.some((issue) => issue.path.includes(pathFragment))).toBe(true);
  return validationError;
}

describe("profile schema: minimal/full", () => {
  it("accepts a minimal profile and leaves optionals undefined", () => {
    const doc = validateProfilesDocument(
      { profiles: { scout: { model: "anthropic/claude-haiku" } } },
      "minimal.yaml",
    );
    expect(doc.sourceLabel).toBe("minimal.yaml");
    expect(doc.profiles.scout?.model).toBe("anthropic/claude-haiku");
    expect(doc.profiles.scout?.thinking).toBeUndefined();
    expect(doc.profiles.scout?.tools).toBeUndefined();
    expect(doc.profiles.scout?.sourceLabel).toBe("minimal.yaml");
  });

  it("accepts a full profile exercising every v1 field", () => {
    const doc = validateProfilesDocument(
      {
        profiles: {
          worker: {
            provider: "anthropic",
            model: "anthropic/claude-sonnet",
            thinking: "high",
            systemPromptFile: ".pi/agents/worker.md",
            tools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
            excludeTools: ["powershell"],
            skills: [".pi/skills/project", ".pi/skills/testing"],
            extensions: [".pi/extensions/example.ts"],
            contextFiles: true,
            discoverSkills: false,
            discoverExtensions: false,
            session: "fresh",
            displayName: "Worker",
            description: "Coding worker.",
          },
        },
      },
      "full.yaml",
    );
    const worker = doc.profiles.worker!;
    expect(worker.provider).toBe("anthropic");
    expect(worker.thinking).toBe("high");
    expect(worker.systemPromptFile).toBe(".pi/agents/worker.md");
    expect(worker.tools).toEqual(["read", "grep", "find", "ls", "bash", "edit", "write"]);
    expect(worker.session).toBe("fresh");
    expect(worker.displayName).toBe("Worker");
  });

  it("exposes the documented thinking levels and built-in tools", () => {
    expect([...THINKING_LEVELS]).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    for (const tool of ["read", "bash", "edit", "write", "grep", "find", "ls"]) {
      expect(BUILTIN_TOOLS).toContain(tool);
    }
    expect(BUILTIN_PROFILE_DEFAULTS).toEqual({
      thinking: "medium",
      contextFiles: false,
      discoverSkills: false,
      discoverExtensions: false,
      session: "ephemeral",
    });
  });

  it("allows custom/extension tools that match the safe name grammar", () => {
    const doc = validateProfilesDocument(
      { profiles: { worker: { tools: ["read", "my_custom-tool1"] } } },
      "custom-tools.yaml",
    );
    expect(doc.profiles.worker?.tools).toEqual(["read", "my_custom-tool1"]);
  });
});

describe("profile schema: rejection cases", () => {
  it("rejects an invalid thinking enum with the allowed list", () => {
    const error = expectInvalid(
      { profiles: { scout: { thinking: "ultra" } } },
      "thinking.yaml",
      "thinking",
    );
    expect(error.message).toContain("off");
    expect(error.message).toContain("xhigh");
  });

  it("rejects mutually exclusive prompt fields", () => {
    const error = expectInvalid(
      {
        profiles: {
          scout: { systemPrompt: "inline", systemPromptFile: ".pi/agents/scout.md" },
        },
      },
      "prompt.yaml",
      "profiles.scout",
    );
    expect(error.message).toContain("mutually exclusive");
  });

  it("rejects unknown fields and reminds authors about secrets", () => {
    const error = expectInvalid(
      { profiles: { scout: { model: "x", apiKey: "sk-secret" } } },
      "secrets.yaml",
      "apiKey",
    );
    expect(error.message).toMatch(/secret/i);
    expect(error.issues[0]?.message).toMatch(/secret/i);
  });

  it("rejects unknown top-level fields", () => {
    expectInvalid({ profiles: {}, extra: 1 }, "top.yaml", "(root)");
  });

  it("rejects missing/empty/non-object profiles", () => {
    expectInvalid({}, "missing.yaml", "profiles");
    expectInvalid({ profiles: {} }, "empty.yaml", "profiles");
    expectInvalid({ profiles: [] }, "array.yaml", "profiles");
    expectInvalid("nope", "string.yaml", "(root)");
  });

  it("rejects invalid profile names", () => {
    expectInvalid({ profiles: { "Bad Name!": {} } }, "name.yaml", "Bad Name!");
    expectInvalid({ profiles: { "": {} } }, "name.yaml", "profiles.");
  });

  it("rejects self-extends", () => {
    expectInvalid(
      { profiles: { a: { extends: "a" } } },
      "self.yaml",
      "extends",
    );
  });

  it("rejects shell metacharacters in model strings", () => {
    for (const bad of ["model; rm -rf", "model|cat", "model$(whoami)", "has space", "quote\"x"]) {
      expectInvalid({ profiles: { s: { model: bad } } }, "model.yaml", "model");
    }
  });

  it("accepts model globs and provider/id:thinking patterns", () => {
    const doc = validateProfilesDocument(
      {
        profiles: {
          a: { model: "anthropic/*" },
          b: { model: "*sonnet*" },
          c: { model: "openai/gpt-4o" },
          d: { model: "sonnet:high" },
        },
      },
      "models.yaml",
    );
    expect(Object.keys(doc.profiles).sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("rejects invalid tool names and duplicates", () => {
    expectInvalid({ profiles: { s: { tools: ["read;rm"] } } }, "t.yaml", "tools");
    expectInvalid({ profiles: { s: { tools: ["read read"] } } }, "t.yaml", "tools");
    expectInvalid({ profiles: { s: { tools: "read" } } }, "t.yaml", "tools");
    const dup = expectInvalid(
      { profiles: { s: { tools: ["read", "read"] } } },
      "t.yaml",
      "tools",
    );
    expect(dup.message).toContain("duplicate");
  });

  it("rejects non-boolean discovery flags (quoted YAML booleans)", () => {
    expectInvalid(
      { profiles: { s: { contextFiles: "false" } } },
      "bool.yaml",
      "contextFiles",
    );
    expectInvalid(
      { profiles: { s: { discoverSkills: 1 } } },
      "bool.yaml",
      "discoverSkills",
    );
  });

  it("rejects resumable session modes — default must not resume", () => {
    expectInvalid({ profiles: { s: { session: "continue" } } }, "s.yaml", "session");
    expectInvalid({ profiles: { s: { session: "resume" } } }, "s.yaml", "session");
  });
});

describe("profile schema: project-relative paths", () => {
  it("normalizes redundant segments without touching the filesystem", () => {
    const doc = validateProfilesDocument(
      {
        profiles: {
          s: {
            systemPromptFile: "./.pi//agents/./scout.md",
            skills: ["./.pi/skills//repo-search"],
          },
        },
      },
      "norm.yaml",
    );
    expect(doc.profiles.s?.systemPromptFile).toBe(".pi/agents/scout.md");
    expect(doc.profiles.s?.skills).toEqual([".pi/skills/repo-search"]);
  });

  it("rejects absolute, home-relative, URL, and escaping paths", () => {
    expectInvalid(
      { profiles: { s: { systemPromptFile: "/abs/path.md" } } },
      "p.yaml",
      "systemPromptFile",
    );
    expectInvalid(
      { profiles: { s: { systemPromptFile: "C:/win/path.md" } } },
      "p.yaml",
      "systemPromptFile",
    );
    expectInvalid(
      { profiles: { s: { skills: ["~/skills/x"] } } },
      "p.yaml",
      "skills",
    );
    expectInvalid(
      { profiles: { s: { skills: ["https://example.com/skill"] } } },
      "p.yaml",
      "skills",
    );
    expectInvalid(
      { profiles: { s: { systemPromptFile: "../../etc/passwd" } } },
      "p.yaml",
      "systemPromptFile",
    );
    expectInvalid(
      { profiles: { s: { skills: ["a/../../escape"] } } },
      "p.yaml",
      "skills",
    );
    expectInvalid(
      { profiles: { s: { extensions: ["a\\b"] } } },
      "p.yaml",
      "extensions",
    );
  });

  it("rejects duplicate normalized paths", () => {
    const error = expectInvalid(
      { profiles: { s: { skills: [".pi/skills/x", "./.pi/skills/x"] } } },
      "dup.yaml",
      "skills",
    );
    expect(error.message).toContain("duplicate");
  });
});

describe("profile schema: overrides", () => {
  it("accepts execution overrides but forbids extends", () => {
    const overrides = validateProfileOverrides(
      { model: "openai/gpt-4o", thinking: "low" },
      "--model",
    );
    expect(overrides.model).toBe("openai/gpt-4o");
    expect(overrides.thinking).toBe("low");
    expect(() =>
      validateProfileOverrides({ extends: "other" }, "--extends"),
    ).toThrow(ProfileValidationError);
  });

  it("still enforces prompt mutual exclusivity in overrides", () => {
    expect(() =>
      validateProfileOverrides(
        { systemPrompt: "a", systemPromptFile: ".pi/agents/x.md" },
        "--prompt",
      ),
    ).toThrow(/mutually exclusive/);
  });
});

describe("profile schema: fixtures", () => {
  it("validates the shipped full fixture without errors", () => {
    const doc = parseAndValidateProfilesText(fixture("full.yaml"), "full.yaml");
    expect(Object.keys(doc.profiles)).toEqual(["worker"]);
  });
});

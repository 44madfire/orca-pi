import { describe, expect, it } from "vitest";
import { run } from "../src/main.js";
import type { CliDeps } from "../src/main.js";
import type { CommandResult } from "@orca-pi/core";

function memFs(
  files: Record<string, string>,
): Pick<typeof import("node:fs/promises"), "readFile" | "stat"> {
  return {
    async readFile(path: unknown) {
      const key = String(path);
      if (Object.hasOwn(files, key)) return files[key]!;
      const error = new Error(`ENOENT: no such file ${key}`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    },
    async stat(path: unknown) {
      const key = String(path);
      if (Object.hasOwn(files, key)) return { isFile: () => true } as unknown as import("node:fs").Stats;
      const error = new Error(`ENOENT: no such file ${key}`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    },
  };
}

function makeDeps(files: Record<string, string>, extra?: Partial<CliDeps>): {
  deps: CliDeps;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  const runner = {
    async run(): Promise<CommandResult> {
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };
  const deps: CliDeps = {
    runner,
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => err.push(text),
    version: "0.1.0-test",
    projectRoot: "/repo/p",
    env: {},
    homedir: "/home/u",
    fs: memFs(files),
    userConfigPathOverride: "/home/u/.pi/agent/profiles.yaml",
    projectConfigPathOverride: "/repo/p/.pi/profiles.yaml",
    ...extra,
  };
  return { deps, out, err };
}

const USER_YAML = `profiles:
  scout:
    model: anthropic/claude-haiku
    thinking: low
    displayName: Scout
`;
const PROJECT_YAML = `profiles:
  worker:
    model: anthropic/claude-sonnet
    thinking: high
    tools: [read, bash]
    skills: [.pi/skills/project]
`;

describe("orca-pi profiles list", () => {
  it("lists merged profiles with precedence footer", async () => {
    const { deps, out } = makeDeps({
      "/home/u/.pi/agent/profiles.yaml": USER_YAML,
      "/repo/p/.pi/profiles.yaml": PROJECT_YAML,
    });
    const result = await run(["profiles", "list"], deps);
    expect(result.exitCode).toBe(0);
    const text = out.join("");
    expect(text).toContain("scout");
    expect(text).toContain("worker");
    expect(text).toContain("precedence");
  });

  it("supports the singular alias and --json", async () => {
    const { deps, out } = makeDeps({
      "/home/u/.pi/agent/profiles.yaml": USER_YAML,
    });
    const result = await run(["profile", "list", "--json"], deps);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(out.join("")) as {
      profiles: { name: string }[];
      config: { userExists: boolean; projectExists: boolean };
    };
    // Fresh-install built-ins merge with the user file layer.
    expect(parsed.profiles.map((entry) => entry.name)).toEqual([
      "reviewer",
      "scout",
      "worker",
    ]);
    expect(parsed.config.userExists).toBe(true);
    expect(parsed.config.projectExists).toBe(false);
  });

  it("exposes fresh-install built-ins when both files are missing", async () => {
    const { deps, out } = makeDeps({});
    const result = await run(["profiles", "list"], deps);
    expect(result.exitCode).toBe(0);
    const text = out.join("");
    expect(text).toContain("scout");
    expect(text).toContain("worker");
    expect(text).toContain("reviewer");
  });

  it("rejects unknown list flags with exit 2", async () => {
    const { deps, err } = makeDeps({});
    const result = await run(["profiles", "list", "--mutate"], deps);
    expect(result.exitCode).toBe(2);
    expect(err.join("")).toContain("unknown profiles list option");
  });
});

describe("orca-pi profile show", () => {
  it("shows effective values plus provenance, redacted by default", async () => {
    const long = "p ".repeat(200);
    const { deps, out } = makeDeps({
      "/home/u/.pi/agent/profiles.yaml": `profiles:\n  s:\n    model: anthropic/claude-haiku\n    systemPrompt: "${long}"\n`,
    });
    const result = await run(["profile", "show", "s"], deps);
    expect(result.exitCode).toBe(0);
    const text = out.join("");
    expect(text).toContain("anthropic/claude-haiku");
    expect(text).toContain("user config");
    expect(text).toContain("truncated");
    expect(text).not.toContain(long);
  });

  it("reveals the full prompt with --show-prompt", async () => {
    const long = "p ".repeat(200);
    const { deps, out } = makeDeps({
      "/home/u/.pi/agent/profiles.yaml": `profiles:\n  s:\n    model: anthropic/claude-haiku\n    systemPrompt: "${long}"\n`,
    });
    const result = await run(["profile", "show", "s", "--show-prompt"], deps);
    expect(result.exitCode).toBe(0);
    expect(out.join("")).toContain(long);
  });

  it("exits 1 with available-name hints for unknown profiles", async () => {
    const { deps, err } = makeDeps({
      "/home/u/.pi/agent/profiles.yaml": USER_YAML,
    });
    const result = await run(["profile", "show", "scouts"], deps);
    expect(result.exitCode).toBe(1);
    expect(err.join("")).toContain("Unknown Pi profile");
    expect(err.join("")).toContain("scout");
  });

  it("supports --json with redaction metadata", async () => {
    const { deps, out } = makeDeps({
      "/home/u/.pi/agent/profiles.yaml": USER_YAML,
    });
    const result = await run(["profile", "show", "scout", "--json"], deps);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(out.join("")) as {
      profile: { name: string };
      provenance: Record<string, string>;
      redacted: boolean;
    };
    expect(parsed.profile.name).toBe("scout");
    expect(parsed.provenance.model).toContain("user config");
    expect(parsed.redacted).toBe(true);
  });
});

describe("orca-pi profile inspect", () => {
  it("includes context policy and consumes the JEF-7 launch formatter when injected", async () => {
    const { deps, out } = makeDeps(
      { "/home/u/.pi/agent/profiles.yaml": USER_YAML },
      {
        getLaunchPreview: async (resolved, ctx) =>
          `pi --model ${resolved.model} --thinking ${resolved.thinking} (redacted, root=${ctx.projectRoot} cwd=${ctx.cwd})`,
      },
    );
    const result = await run(["profile", "inspect", "scout", "--context-summary"], deps);
    expect(result.exitCode).toBe(0);
    const text = out.join("");
    expect(text).toContain("Context policy");
    expect(text).toContain("pi --model anthropic/claude-haiku");
    // Single JEF-10 context-summary contract.
    expect(text).toContain("estimates, not provider billing");
  });

  it("awaits an async JEF-7-style provider for file-backed prompts (systemPromptFile)", async () => {
    const seen: { projectRoot: string; cwd: string; showFullPrompt: boolean }[] = [];
    const { deps, out } = makeDeps(
      {
        "/home/u/.pi/agent/profiles.yaml":
          "profiles:\n  filescout:\n    model: anthropic/claude-haiku\n    systemPromptFile: .pi/agents/scout.md\n",
      },
      {
        getLaunchPreview: async (resolved, ctx) => {
          seen.push({
            projectRoot: ctx.projectRoot,
            cwd: ctx.cwd,
            showFullPrompt: ctx.showFullPrompt,
          });
          // Simulate JEF-7's async build (prompt-file I/O) + format without
          // duplicating launch construction: echo the declared file path.
          await new Promise((resolve) => setTimeout(resolve, 1));
          return `launch preview for ${resolved.name} prompt=${resolved.systemPromptFile ?? "(none)"} root=${ctx.projectRoot}`;
        },
      },
    );
    const result = await run(["profile", "inspect", "filescout", "--context-summary"], deps);
    expect(result.exitCode).toBe(0);
    expect(out.join("")).toContain(".pi/agents/scout.md");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.projectRoot).toBe("/repo/p");
    expect(seen[0]?.cwd).toBe("/repo/p");
  });

  it("supports JEF-7-aligned --project-root/--cwd/--config overrides in context", async () => {
    const seen: { projectRoot: string; cwd: string }[] = [];
    const { deps, out } = makeDeps(
      {
        "/custom/user.yaml": USER_YAML,
        "/custom/project.yaml": USER_YAML,
      },
      {
        projectRoot: "/ignored",
        userConfigPathOverride: undefined,
        projectConfigPathOverride: undefined,
        getLaunchPreview: async (_resolved, ctx) => {
          seen.push({ projectRoot: ctx.projectRoot, cwd: ctx.cwd });
          return "preview";
        },
      },
    );
    const result = await run(
      [
        "profile",
        "inspect",
        "scout",
        "--project-root",
        "/repo/override",
        "--cwd",
        "/repo/override/cwd",
        "--user-config",
        "/custom/user.yaml",
        "--project-config",
        "/custom/project.yaml",
      ],
      deps,
    );
    expect(result.exitCode).toBe(0);
    expect(seen[0]).toEqual({
      projectRoot: "/repo/override",
      cwd: "/repo/override/cwd",
    });
    expect(out.join("")).toContain("preview");
  });

  it("states JEF-7 ownership instead of building argv when no formatter is injected", async () => {
    // Production `run()` always wires JEF-7's provider; the no-provider
    // fallback lives in `runProfilesCommand` directly (no hidden store).
    const { runProfilesCommand } = await import("../src/commands/profiles.js");
    const out: string[] = [];
    const err: string[] = [];
    const { fs, projectRoot } = makeDeps({
      "/home/u/.pi/agent/profiles.yaml": USER_YAML,
    }).deps;
    const result = await runProfilesCommand(["inspect", "scout"], {
      stdout: (text: string) => out.push(text),
      stderr: (text: string) => err.push(text),
      projectRoot: projectRoot ?? "/repo/p",
      ...(fs !== undefined ? { fs } : {}),
      userConfigPathOverride: "/home/u/.pi/agent/profiles.yaml",
      projectConfigPathOverride: "/repo/p/.pi/profiles.yaml",
    });
    expect(result.exitCode).toBe(0);
    expect(out.join("")).toContain("JEF-7");
    expect(out.join("")).toContain("never builds argv");
  });

  it("wires JEF-7 production preview by default (no stub needed)", async () => {
    const { deps, out, err } = makeDeps({
      "/home/u/.pi/agent/profiles.yaml": USER_YAML,
    });
    const result = await run(["profile", "inspect", "scout"], deps);
    expect(result.exitCode).toBe(0);
    expect(err.join("")).toBe("");
    // Real JEF-7 formatter output: deterministic argv + DO NOT EXECUTE.
    expect(out.join("")).toContain("--model");
    expect(out.join("")).toContain("DO NOT EXECUTE");
  });

  it("supports --json with contextSummary and launchPreview", async () => {
    const { deps, out } = makeDeps(
      { "/home/u/.pi/agent/profiles.yaml": USER_YAML },
      { getLaunchPreview: async () => "preview" },
    );
    const result = await run(["profile", "inspect", "scout", "--json", "--context-summary"], deps);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(out.join("")) as {
      contextSummary: { profileName: string; promptChars: number };
      launchPreview: string;
    };
    // Single JEF-10 context-summary contract (prompt chars/words/lines).
    expect(parsed.contextSummary.profileName).toBe("scout");
    expect(parsed.contextSummary.promptChars).toBeGreaterThan(0);
    expect(parsed.launchPreview).toBe("preview");
  });
});

describe("orca-pi profile validate", () => {
  it("exits 0 when all profiles are valid", async () => {
    const { deps, out } = makeDeps({
      "/home/u/.pi/agent/profiles.yaml": USER_YAML,
    });
    const result = await run(["profile", "validate"], deps);
    expect(result.exitCode).toBe(0);
    // User scout merges with built-in scout: reviewer + scout + worker.
    expect(out.join("")).toContain("All 3 profiles valid");
  });

  it("validates fresh-install built-ins with no config files", async () => {
    const { deps, out } = makeDeps({});
    const result = await run(["profile", "validate"], deps);
    expect(result.exitCode).toBe(0);
    expect(out.join("")).toContain("All 3 profiles valid");
  });

  it("exits 1 with file/source/field diagnostics for invalid profiles", async () => {
    const { deps, out } = makeDeps({
      "/home/u/.pi/agent/profiles.yaml": USER_YAML,
      "/repo/p/.pi/profiles.yaml": "profiles:\n  bad:\n    extends: does-not-exist\n",
    });
    const result = await run(["profile", "validate"], deps);
    expect(result.exitCode).toBe(1);
    expect(out.join("")).toContain("invalid bad");
    expect(out.join("")).toContain("does-not-exist");
  });

  it("validates a single profile and supports --json", async () => {
    const { deps, out } = makeDeps({
      "/home/u/.pi/agent/profiles.yaml": USER_YAML,
    });
    const result = await run(["profile", "validate", "scout", "--json"], deps);
    expect(result.exitCode).toBe(0);
    expect((JSON.parse(out.join("")) as { ok: boolean }).ok).toBe(true);
  });

  it("surfaces malformed config with source context", async () => {
    const { deps, err } = makeDeps({
      "/home/u/.pi/agent/profiles.yaml": "profiles:\n  bad: [unclosed\n",
    });
    const result = await run(["profile", "validate"], deps);
    expect(result.exitCode).toBe(1);
    expect(err.join("")).toContain("/home/u/.pi/agent/profiles.yaml");
  });
});

describe("orca-pi profile path", () => {
  it("prints both authoritative paths with precedence", async () => {
    const { deps, out } = makeDeps({});
    const result = await run(["profile", "path"], deps);
    expect(result.exitCode).toBe(0);
    expect(out.join("")).toContain("/home/u/.pi/agent/profiles.yaml");
    expect(out.join("")).toContain("/repo/p/.pi/profiles.yaml");
    expect(out.join("")).toContain("authoritative");
  });

  it("supports --project/--user for scripting and --json", async () => {
    const { deps, out } = makeDeps({});
    expect((await run(["profile", "path", "--project"], deps)).exitCode).toBe(0);
    expect(out.join("").trim()).toBe("/repo/p/.pi/profiles.yaml");
    const second = makeDeps({});
    const result = await run(["profile", "path", "--json"], second.deps);
    expect(result.exitCode).toBe(0);
    expect((JSON.parse(second.out.join("")) as { userPath: string }).userPath).toContain(
      ".pi/agent/profiles.yaml",
    );
  });

  it("remains usable when config is malformed (recovery UX)", async () => {
    const { deps, out } = makeDeps({
      "/home/u/.pi/agent/profiles.yaml": "profiles:\n  bad: [unclosed\n",
    });
    const result = await run(["profile", "path"], deps);
    expect(result.exitCode).toBe(0);
    expect(out.join("")).toContain("/home/u/.pi/agent/profiles.yaml");
    const jsonDeps = makeDeps({
      "/home/u/.pi/agent/profiles.yaml": "profiles:\n  bad: [unclosed\n",
    });
    const jsonResult = await run(["profile", "path", "--json"], jsonDeps.deps);
    expect(jsonResult.exitCode).toBe(0);
    const parsed = JSON.parse(jsonDeps.out.join("")) as {
      userExists: boolean;
      projectExists: boolean;
    };
    // Malformed-but-present files count as existing so users can find them.
    expect(parsed.userExists).toBe(true);
    expect(parsed.projectExists).toBe(false);
  });
});

describe("fresh-install defaults through JEF-11 commands (JEF-10 built-ins)", () => {
  it("profile show reports built-in provenance with no config files", async () => {
    const { deps, out } = makeDeps({});
    const result = await run(["profile", "show", "scout"], deps);
    expect(result.exitCode).toBe(0);
    const text = out.join("");
    expect(text).toContain("scout");
    expect(text).toContain("[built-in]");
  });

  it("profile show --json marks role fields built-in on fresh installs", async () => {
    const { deps, out } = makeDeps({});
    const result = await run(["profile", "show", "reviewer", "--json"], deps);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(out.join("")) as {
      profile: { name: string; thinking: string };
      provenance: Record<string, string>;
    };
    expect(parsed.profile.name).toBe("reviewer");
    expect(parsed.profile.thinking).toBe("high");
    expect(parsed.provenance.thinking).toBe("built-in");
    expect(parsed.provenance.tools).toBe("built-in");
  });

  it("profile inspect --context-summary uses the JEF-10 contract on fresh installs", async () => {
    const { deps, out, err } = makeDeps({});
    const result = await run(
      ["profile", "inspect", "scout", "--context-summary"],
      deps,
    );
    expect(result.exitCode).toBe(0);
    expect(err.join("")).toBe("");
    const text = out.join("");
    expect(text).toContain("estimates, not provider billing");
    expect(text).toContain("profile: scout");
  });
});

describe("profiles help and routing", () => {
  it("prints usage for bare profile(s) and rejects unknown subcommands", async () => {
    const { deps, out, err } = makeDeps({});
    expect((await run(["profiles"], deps)).exitCode).toBe(0);
    expect(out.join("")).toContain("orca-pi profiles list");
    const bad = await run(["profile", "frobnicate"], deps);
    expect(bad.exitCode).toBe(2);
    expect(err.join("")).toContain("unknown profiles subcommand");
  });

  it("appears in top-level --help", async () => {
    const { deps, out } = makeDeps({});
    await run(["--help"], deps);
    expect(out.join("")).toContain("profile show");
    expect(out.join("")).toContain("profile validate");
  });
});

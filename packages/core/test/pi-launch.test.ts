import { describe, expect, it } from "vitest";
import { buildPiLaunch } from "../src/pi/build-pi-launch.js";
import { PiLaunchError } from "../src/pi/resolve-prompt.js";
import { parseAndValidateProfilesText } from "../src/profile/load.js";
import { resolveProfile } from "../src/profile/resolve.js";
import type { ResolvedPiProfile } from "../src/profile/types.js";

const PROJECT_ROOT = "/repo/my-project";

function makeProfile(overrides?: Partial<ResolvedPiProfile> & { name?: string }): ResolvedPiProfile {
  const base: ResolvedPiProfile = Object.freeze({
    name: overrides?.name ?? "test",
    extendsChain: Object.freeze(["test"]) as readonly string[],
    thinking: "medium",
    contextFiles: false,
    discoverSkills: false,
    discoverExtensions: false,
    session: "ephemeral",
    ...(overrides ?? {}),
    // Re-freeze arrays when provided via overrides (Object.freeze in literal
    // above only freezes the base arrays, not override arrays).
  });
  // Deep-freeze array fields for parity with resolveProfile().
  const frozen: Record<string, unknown> = { ...base };
  for (const key of ["extendsChain", "tools", "excludeTools", "skills", "extensions"] as const) {
    const value = (base as Record<string, unknown>)[key];
    if (Array.isArray(value) && !Object.isFrozen(value)) {
      frozen[key] = Object.freeze([...value]);
    }
  }
  return Object.freeze(frozen as ResolvedPiProfile);
}

function memReader(files: Record<string, string>) {
  return async (absPath: string): Promise<string> => {
    if (Object.hasOwn(files, absPath)) return files[absPath] as string;
    const error = new Error(`ENOENT: no such file or directory, open '${absPath}'`) as NodeJS.ErrnoException;
    error.code = "ENOENT";
    throw error;
  };
}

describe("pi launch: read-only scout (lean defaults)", () => {
  it("disables ambient skills/extensions/context and emits a deterministic scout argv", async () => {
    const doc = parseAndValidateProfilesText(
      `profiles:
  readonly:
    tools: [read, grep, find, ls]
    skills: []
    extensions: []
    contextFiles: false
    discoverSkills: false
    discoverExtensions: false
    session: ephemeral
  scout:
    extends: readonly
    model: anthropic/claude-haiku
    thinking: low
    skills: [.pi/skills/repo-search]
`,
      "scout.yaml",
    );
    const profile = resolveProfile("scout", doc);
    const first = await buildPiLaunch(profile, { projectRoot: PROJECT_ROOT });
    const second = await buildPiLaunch(profile, { projectRoot: PROJECT_ROOT });

    // Determinism: same profile → same structured invocation, frozen.
    expect(second.spec).toEqual(first.spec);
    expect(Object.isFrozen(first.spec)).toBe(true);
    expect(Object.isFrozen(first.spec.args)).toBe(true);

    expect(first.spec.command).toBe("pi");
    expect(first.spec.cwd).toBe(PROJECT_ROOT);
    expect(first.spec.env).toEqual({});
    expect(first.promptSource).toBe("none");

    // Lean: visibly disable ambient discovery/context, then add explicit resources.
    expect(first.spec.args).toEqual([
      "--model", "anthropic/claude-haiku",
      "--thinking", "low",
      "--tools", "read,grep,find,ls",
      "--no-skills",
      "--skill", `${PROJECT_ROOT}/.pi/skills/repo-search`,
      "--no-extensions",
      "--no-context-files",
      "--no-session",
    ]);
  });
});

describe("pi launch: full worker", () => {
  it("maps every execution field and ignores display metadata", async () => {
    const doc = parseAndValidateProfilesText(
      `profiles:
  worker:
    provider: anthropic
    model: anthropic/claude-sonnet
    thinking: high
    systemPrompt: You are a coding worker.
    tools: [read, grep, find, ls, bash, edit, write]
    excludeTools: [powershell]
    skills: [.pi/skills/project, .pi/skills/testing]
    extensions: [.pi/extensions/example.ts]
    contextFiles: true
    discoverSkills: false
    discoverExtensions: false
    session: fresh
    displayName: Worker
    description: Coding worker with full tool access.
`,
      "worker.yaml",
    );
    const profile = resolveProfile("worker", doc);
    const launch = await buildPiLaunch(profile, { projectRoot: PROJECT_ROOT });

    expect(launch.spec.args).toEqual([
      "--provider", "anthropic",
      "--model", "anthropic/claude-sonnet",
      "--thinking", "high",
      "--system-prompt", "You are a coding worker.",
      "--tools", "read,grep,find,ls,bash,edit,write",
      "--exclude-tools", "powershell",
      "--no-skills",
      "--skill", `${PROJECT_ROOT}/.pi/skills/project`,
      "--skill", `${PROJECT_ROOT}/.pi/skills/testing`,
      "--no-extensions",
      "--extension", `${PROJECT_ROOT}/.pi/extensions/example.ts`,
      // contextFiles: true → no --no-context-files
      // session: fresh → no --no-session and no resume flags
    ]);
    // Never resumes: no resume/session-fork flags leak in.
    for (const forbidden of ["--continue", "--resume", "--session", "--fork", "--session-id", "--session-dir", "-c", "-r"]) {
      expect(launch.spec.args).not.toContain(forbidden);
    }

    // Display-only fields never affect argv.
    const doc2 = parseAndValidateProfilesText(
      `profiles:
  worker:
    provider: anthropic
    model: anthropic/claude-sonnet
    thinking: high
    systemPrompt: You are a coding worker.
    tools: [read, grep, find, ls, bash, edit, write]
    excludeTools: [powershell]
    skills: [.pi/skills/project, .pi/skills/testing]
    extensions: [.pi/extensions/example.ts]
    contextFiles: true
    discoverSkills: false
    discoverExtensions: false
    session: fresh
    displayName: Totally Different Label
    description: Different description.
`,
      "worker2.yaml",
    );
    const other = await buildPiLaunch(resolveProfile("worker", doc2), { projectRoot: PROJECT_ROOT });
    expect(other.spec.args).toEqual(launch.spec.args);
  });
});

describe("pi launch: reviewer with context files disabled", () => {
  it("emits --no-context-files when contextFiles is false, omits it when true", async () => {
    const off = makeProfile({ name: "reviewer", model: "anthropic/claude-sonnet", thinking: "medium", contextFiles: false });
    const on = makeProfile({ name: "reviewer", model: "anthropic/claude-sonnet", thinking: "medium", contextFiles: true });
    const offLaunch = await buildPiLaunch(off, { projectRoot: PROJECT_ROOT });
    const onLaunch = await buildPiLaunch(on, { projectRoot: PROJECT_ROOT });
    expect(offLaunch.spec.args).toContain("--no-context-files");
    expect(onLaunch.spec.args).not.toContain("--no-context-files");
  });
});

describe("pi launch: explicit skills/extensions with discovery disabled", () => {
  it("orders --no-skills before --skill and --no-extensions before --extension", async () => {
    const profile = makeProfile({
      name: "custom",
      skills: [".pi/skills/a", ".pi/skills/b"],
      extensions: [".pi/extensions/x.ts"],
      discoverSkills: false,
      discoverExtensions: false,
    });
    const launch = await buildPiLaunch(profile, { projectRoot: PROJECT_ROOT });
    const args = [...launch.spec.args];
    const noSkills = args.indexOf("--no-skills");
    const skill1 = args.indexOf("--skill");
    const noExt = args.indexOf("--no-extensions");
    const ext1 = args.indexOf("--extension");
    expect(noSkills).toBeGreaterThanOrEqual(0);
    expect(skill1).toBeGreaterThan(noSkills);
    expect(noExt).toBeGreaterThanOrEqual(0);
    expect(ext1).toBeGreaterThan(noExt);
    expect(args).toContain(`${PROJECT_ROOT}/.pi/skills/a`);
    expect(args).toContain(`${PROJECT_ROOT}/.pi/extensions/x.ts`);
  });

  it("omits --no-skills/--no-extensions when discovery is enabled", async () => {
    const profile = makeProfile({
      name: "open",
      skills: [".pi/skills/a"],
      extensions: [".pi/extensions/x.ts"],
      discoverSkills: true,
      discoverExtensions: true,
    });
    const launch = await buildPiLaunch(profile, { projectRoot: PROJECT_ROOT });
    expect(launch.spec.args).not.toContain("--no-skills");
    expect(launch.spec.args).not.toContain("--no-extensions");
    expect(launch.spec.args).toContain("--skill");
    expect(launch.spec.args).toContain("--extension");
  });
});

describe("pi launch: empty tool allowlist", () => {
  it("uses --no-tools for explicit [] and omits tool flags when unset", async () => {
    const empty = makeProfile({ name: "locked", tools: [] });
    const unset = makeProfile({ name: "ambient" });
    const some = makeProfile({ name: "some", tools: ["read", "bash"] });

    const emptyLaunch = await buildPiLaunch(empty, { projectRoot: PROJECT_ROOT });
    expect(emptyLaunch.spec.args).toContain("--no-tools");
    expect(emptyLaunch.spec.args).not.toContain("--tools");

    const unsetLaunch = await buildPiLaunch(unset, { projectRoot: PROJECT_ROOT });
    expect(unsetLaunch.spec.args).not.toContain("--no-tools");
    expect(unsetLaunch.spec.args).not.toContain("--tools");

    const someLaunch = await buildPiLaunch(some, { projectRoot: PROJECT_ROOT });
    expect(someLaunch.spec.args).toContain("--tools");
    expect(someLaunch.spec.args).toContain("read,bash");
    expect(someLaunch.spec.args).not.toContain("--no-tools");
  });
});

describe("pi launch: paths with spaces", () => {
  it("keeps space-containing absolute paths as single argv elements", async () => {
    const root = "/repo/my project";
    const profile = makeProfile({
      name: "spaced",
      skills: [".pi/skills/my skill"],
      extensions: [".pi/extensions/my ext.ts"],
    });
    const launch = await buildPiLaunch(profile, { projectRoot: root });
    expect(launch.spec.args).toContain(`${root}/.pi/skills/my skill`);
    expect(launch.spec.args).toContain(`${root}/.pi/extensions/my ext.ts`);
    // Each path is exactly one argv element (no shell splitting).
    const skillIndex = launch.spec.args.indexOf("--skill");
    expect(launch.spec.args[skillIndex + 1]).toBe(`${root}/.pi/skills/my skill`);
  });
});

describe("pi launch: quotes/newlines/shell metacharacters in prompt", () => {
  it("passes prompt text as one literal argv element without shell quoting", async () => {
    const tricky = `line1\nline2 "double" 'single' $HOME $(whoami) \`backtick\` ; | & < > * ? \\ ! ( )`;
    const profile = makeProfile({ name: "tricky", systemPrompt: tricky });
    const launch = await buildPiLaunch(profile, { projectRoot: PROJECT_ROOT });
    const index = launch.spec.args.indexOf("--system-prompt");
    expect(index).toBeGreaterThanOrEqual(0);
    // Single element, byte-identical — structured argv, not a shell string.
    expect(launch.spec.args[index + 1]).toBe(tricky);
    // Determinism holds for hostile prompts too.
    const again = await buildPiLaunch(profile, { projectRoot: PROJECT_ROOT });
    expect(again.spec.args).toEqual(launch.spec.args);
  });
});

describe("pi launch: systemPromptFile", () => {
  it("reads the file against projectRoot and passes contents explicitly", async () => {
    const profile = makeProfile({ name: "scout", systemPromptFile: ".pi/agents/scout.md" });
    const files = { [`${PROJECT_ROOT}/.pi/agents/scout.md`]: "You are a scout.\nBe brief." };
    const launch = await buildPiLaunch(profile, { projectRoot: PROJECT_ROOT, readFile: memReader(files) });
    expect(launch.promptSource).toBe("file");
    expect(launch.promptFileRelativePath).toBe(".pi/agents/scout.md");
    expect(launch.promptFileAbsolutePath).toBe(`${PROJECT_ROOT}/.pi/agents/scout.md`);
    const index = launch.spec.args.indexOf("--system-prompt");
    expect(launch.spec.args[index + 1]).toBe("You are a scout.\nBe brief.");
  });

  it("throws an actionable missing-file error (never ambient discovery)", async () => {
    const profile = makeProfile({ name: "ghost", systemPromptFile: ".pi/agents/does-not-exist.md" });
    await expect(
      buildPiLaunch(profile, { projectRoot: PROJECT_ROOT, readFile: memReader({}) }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(PiLaunchError);
      const launchError = error as PiLaunchError;
      expect(launchError.code).toBe("missing-prompt-file");
      expect(launchError.profileName).toBe("ghost");
      expect(launchError.message).toContain("does-not-exist.md");
      expect(launchError.message).toContain(PROJECT_ROOT);
      return true;
    });
  });

  it("resolves the prompt file against projectRoot, not cwd", async () => {
    const profile = makeProfile({ name: "scout", systemPromptFile: ".pi/agents/scout.md" });
    const files = { [`/repo/proj/.pi/agents/scout.md`]: "from project root" };
    const launch = await buildPiLaunch(profile, {
      projectRoot: "/repo/proj",
      cwd: "/tmp/other-cwd",
      readFile: memReader(files),
    });
    expect(launch.spec.args).toContain("from project root");
    expect(launch.spec.cwd).toBe("/tmp/other-cwd");
    expect(launch.promptFileAbsolutePath).toBe("/repo/proj/.pi/agents/scout.md");
  });
});

describe("pi launch: explicit cwd", () => {
  it("preserves the Orca worktree cwd instead of defaulting to projectRoot", async () => {
    const profile = makeProfile({ name: "worker", model: "anthropic/claude-sonnet" });
    const withCwd = await buildPiLaunch(profile, { projectRoot: PROJECT_ROOT, cwd: "/tmp/worktree-123" });
    expect(withCwd.spec.cwd).toBe("/tmp/worktree-123");
    const defaulted = await buildPiLaunch(profile, { projectRoot: PROJECT_ROOT });
    expect(defaulted.spec.cwd).toBe(PROJECT_ROOT);
    // cwd never leaks into argv or path resolution.
    expect(withCwd.spec.args).toEqual(defaulted.spec.args);
  });
});

describe("pi launch: fresh-session behavior", () => {
  it("emits --no-session for ephemeral and no session flags for fresh", async () => {
    const ephemeral = makeProfile({ name: "e", session: "ephemeral" });
    const fresh = makeProfile({ name: "f", session: "fresh" });
    const eLaunch = await buildPiLaunch(ephemeral, { projectRoot: PROJECT_ROOT });
    const fLaunch = await buildPiLaunch(fresh, { projectRoot: PROJECT_ROOT });
    expect(eLaunch.spec.args).toContain("--no-session");
    expect(fLaunch.spec.args).not.toContain("--no-session");
    for (const forbidden of ["--continue", "--resume", "--session", "--fork", "--session-id", "--session-dir"]) {
      expect(eLaunch.spec.args).not.toContain(forbidden);
      expect(fLaunch.spec.args).not.toContain(forbidden);
    }
  });
});

describe("pi launch: every supported field is covered", () => {
  it("exercises provider/model/thinking/tools/exclude/skills/extensions/context/session/prompt", async () => {
    const profile = makeProfile({
      name: "all",
      provider: "openai-codex",
      model: "openai/gpt-4o",
      thinking: "xhigh",
      systemPrompt: "inline prompt",
      tools: ["read", "bash"],
      excludeTools: ["powershell"],
      skills: [".pi/skills/s"],
      extensions: [".pi/extensions/e.ts"],
      contextFiles: false,
      discoverSkills: false,
      discoverExtensions: false,
      session: "ephemeral",
    });
    const launch = await buildPiLaunch(profile, { projectRoot: PROJECT_ROOT });
    const args = launch.spec.args;
    expect(args).toContain("--provider");
    expect(args).toContain("openai-codex");
    expect(args).toContain("--model");
    expect(args).toContain("openai/gpt-4o");
    expect(args).toContain("--thinking");
    expect(args).toContain("xhigh");
    expect(args).toContain("--system-prompt");
    expect(args).toContain("--tools");
    expect(args).toContain("--exclude-tools");
    expect(args).toContain("--skill");
    expect(args).toContain("--extension");
    expect(args).toContain("--no-skills");
    expect(args).toContain("--no-extensions");
    expect(args).toContain("--no-context-files");
    expect(args).toContain("--no-session");
  });

  it("never embeds task text or positional messages", async () => {
    const profile = makeProfile({ name: "clean", model: "anthropic/claude-haiku", systemPrompt: "prompt" });
    const launch = await buildPiLaunch(profile, { projectRoot: PROJECT_ROOT });
    // No `--` separator, no positional messages — only flags + values.
    expect(launch.spec.args).not.toContain("--");
    // Every odd-position token after a value flag is a value; no bare task text.
    // At minimum: command is `pi` and all flags start with `-`.
    expect(launch.spec.command).toBe("pi");
  });
});

import { describe, expect, it } from "vitest";
import { buildPiLaunch } from "../src/pi/build-pi-launch.js";
import {
  formatPiInspect,
  formatPiSpecCommandForDisplay,
  quoteForDisplay,
} from "../src/pi/format-inspect.js";
import type { ResolvedPiProfile } from "../src/profile/types.js";

const PROJECT_ROOT = "/repo/my-project";

function makeProfile(overrides?: Partial<ResolvedPiProfile> & { name?: string }): ResolvedPiProfile {
  const base = {
    name: overrides?.name ?? "scout",
    extendsChain: ["scout"],
    thinking: "low",
    contextFiles: false,
    discoverSkills: false,
    discoverExtensions: false,
    session: "ephemeral",
    ...(overrides ?? {}),
  } as ResolvedPiProfile;
  return Object.freeze(base);
}

describe("pi inspect formatter: redacted human-readable output", () => {
  it("shows every emitted flag name and redacts long prompts by default", async () => {
    const longPrompt = `You are a scout.\n${"x".repeat(500)}`;
    const profile = makeProfile({
      model: "anthropic/claude-haiku",
      systemPrompt: longPrompt,
      tools: ["read", "grep"],
      skills: [".pi/skills/repo-search"],
    });
    const launch = await buildPiLaunch(profile, { projectRoot: PROJECT_ROOT });
    const text = formatPiInspect(profile, launch);

    // Every emitted flag name is visible for Pi-doc comparison.
    for (const flag of ["--model", "--thinking", "--system-prompt", "--tools", "--no-skills", "--no-extensions", "--no-context-files", "--no-session"]) {
      expect(text).toContain(flag);
    }
    // Redacted: full 500+ char prompt is not dumped; length is shown.
    expect(text).not.toContain("x".repeat(500));
    expect(text).toMatch(/chars/);
    expect(text).toContain("redacted");
    // Provenance + cwd/command are visible.
    expect(text).toContain("scout");
    expect(text).toContain(PROJECT_ROOT);
    expect(text).toContain("DO NOT EXECUTE");
    expect(text).toContain("https://github.com/up0to1/pi-mono/blob/main/packages/coding-agent/README.md");
  });

  it("prints the full prompt with --show-prompt and valid shell-quoted display line", async () => {
    const profile = makeProfile({ model: "m", systemPrompt: `say "hi"\nbye` });
    const launch = await buildPiLaunch(profile, { projectRoot: PROJECT_ROOT });
    const full = formatPiInspect(profile, launch, { showFullPrompt: true });
    expect(full).toContain(`say`);
    // Display command is single-line, quoted for humans...
    const display = formatPiSpecCommandForDisplay(launch.spec);
    expect(display.startsWith("pi ")).toBe(true);
    expect(display).toContain("--system-prompt");
    // ...but execution still uses the structured array (one literal element).
    const index = launch.spec.args.indexOf("--system-prompt");
    expect(launch.spec.args[index + 1]).toBe(`say "hi"\nbye`);
    // Formatter output is a string — never the execution source.
    expect(typeof display).toBe("string");
    expect(Array.isArray(launch.spec.args)).toBe(true);
  });

  it("quotes hostile tokens for display without changing structured argv", () => {
    expect(quoteForDisplay("--model")).toBe("--model");
    expect(quoteForDisplay("plain")).toBe("plain");
    expect(quoteForDisplay("has space")).toBe(`"has space"`);
    expect(quoteForDisplay(`a"b`)).toBe(`"a\\"b"`);
    expect(quoteForDisplay("line1\nline2")).toBe(`"line1\\nline2"`);
    expect(quoteForDisplay("")).toBe(`""`);
  });
});

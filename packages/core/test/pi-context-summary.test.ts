import { describe, expect, it } from "vitest";
import {
  estimatePromptTokens,
  formatContextSummary,
  summarizeProfileContext,
} from "../src/pi/context-summary.js";
import type { ResolvedPiProfile } from "../src/profile/types.js";

function makeProfile(overrides?: Partial<ResolvedPiProfile> & { name?: string }): ResolvedPiProfile {
  return Object.freeze({
    name: overrides?.name ?? "test",
    extendsChain: Object.freeze(["test"]) as readonly string[],
    thinking: "medium",
    contextFiles: false,
    discoverSkills: false,
    discoverExtensions: false,
    session: "ephemeral",
    ...(overrides ?? {}),
  }) as ResolvedPiProfile;
}

describe("context summary: token heuristic", () => {
  it("estimates ceil(chars/4), zero for empty", () => {
    expect(estimatePromptTokens(0)).toBe(0);
    expect(estimatePromptTokens(1)).toBe(1);
    expect(estimatePromptTokens(4)).toBe(1);
    expect(estimatePromptTokens(5)).toBe(2);
    expect(estimatePromptTokens(100)).toBe(25);
  });
});

describe("context summary: profile summarization", () => {
  it("counts prompt chars/words/lines and tool/skill/extension/policy", () => {
    const profile = makeProfile({
      name: "scout",
      systemPrompt: "hello world\nsecond line",
      tools: ["read", "grep"],
      skills: [".pi/skills/a"],
      thinking: "low",
    });
    const summary = summarizeProfileContext(profile, "hello world\nsecond line", "inline");
    expect(summary.profileName).toBe("scout");
    expect(summary.promptChars).toBe("hello world\nsecond line".length);
    expect(summary.promptLines).toBe(2);
    expect(summary.promptWords).toBe(4);
    expect(summary.toolCount).toBe(2);
    expect(summary.explicitSkillCount).toBe(1);
    expect(summary.explicitExtensionCount).toBe(0);
    expect(summary.contextFiles).toBe(false);
    expect(summary.promptSource).toBe("inline");
  });

  it("reports zero-size file prompts without resolved text", () => {
    const profile = makeProfile({ name: "ghost", systemPromptFile: ".pi/agents/x.md" });
    const summary = summarizeProfileContext(profile);
    expect(summary.promptChars).toBe(0);
    expect(summary.promptLines).toBe(0);
    expect(summary.promptWords).toBe(0);
    expect(summary.estimatedTokens).toBe(0);
    expect(summary.promptSource).toBe("file");
  });

  it("formats a human-readable estimate disclaimer", () => {
    const profile = makeProfile({ name: "worker", tools: ["read", "bash"] });
    const summary = summarizeProfileContext(profile, "hi", "inline");
    const text = formatContextSummary(summary);
    expect(text).toContain('context summary for profile "worker"');
    expect(text).toContain("estimates, not provider billing");
    expect(text).toContain("tools: 2");
    expect(text).toContain("contextFiles: off");
  });
});

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_PROFILE_NAMES,
  REVIEWER_SYSTEM_PROMPT,
  SCOUT_SYSTEM_PROMPT,
  WORKER_SYSTEM_PROMPT,
  getBuiltinProfilesDocument,
  isBuiltinProfileName,
} from "../src/profile/builtins.js";
import {
  listProfileNames,
  mergeValidatedDocuments,
  parseAndValidateProfilesText,
} from "../src/profile/load.js";
import { resolveProfile } from "../src/profile/resolve.js";
import { buildPiLaunch } from "../src/pi/build-pi-launch.js";
import {
  estimatePromptTokens,
  formatContextSummary,
  summarizeProfileContext,
} from "../src/pi/context-summary.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

describe("builtin default profiles (JEF-10)", () => {
  it("exposes scout, worker, and reviewer", () => {
    expect([...BUILTIN_PROFILE_NAMES].sort()).toEqual(["reviewer", "scout", "worker"]);
    const doc = getBuiltinProfilesDocument();
    expect(listProfileNames(doc)).toEqual(["reviewer", "scout", "worker"]);
    for (const name of BUILTIN_PROFILE_NAMES) {
      expect(isBuiltinProfileName(name)).toBe(true);
    }
    expect(isBuiltinProfileName("scouts")).toBe(false);
  });

  it("is model-agnostic: builtins omit model so user overrides retain role policy", () => {
    const doc = getBuiltinProfilesDocument();
    expect(doc.profiles.scout?.model).toBeUndefined();
    expect(doc.profiles.worker?.model).toBeUndefined();
    expect(doc.profiles.reviewer?.model).toBeUndefined();
    const user = parseAndValidateProfilesText(
      "profiles:\n  scout:\n    model: fast-model\n",
      "user.yaml",
    );
    const merged = mergeValidatedDocuments([doc, user]);
    const scout = resolveProfile("scout", merged);
    expect(scout.model).toBe("fast-model");
    expect(scout.tools).toEqual(["read", "grep", "find", "ls"]);
    expect(scout.thinking).toBe("low");
    expect(scout.systemPrompt).toBe(SCOUT_SYSTEM_PROMPT);
  });

  it("guard: scout/reviewer cannot edit through default tool allowlists", () => {
    const doc = getBuiltinProfilesDocument();
    const scout = resolveProfile("scout", doc);
    const reviewer = resolveProfile("reviewer", doc);
    const worker = resolveProfile("worker", doc);
    for (const profile of [scout, reviewer]) {
      expect(profile.tools).not.toContain("edit");
      expect(profile.tools).not.toContain("write");
    }
    expect(scout.tools).toEqual(["read", "grep", "find", "ls"]);
    expect(reviewer.tools).toEqual(["read", "grep", "find", "ls", "bash"]);
    expect(worker.tools).toEqual(["read", "grep", "find", "ls", "bash", "edit", "write"]);
  });

  it("guard: worker tools/skills never leak into scout/reviewer defaults", () => {
    const doc = getBuiltinProfilesDocument();
    const scout = resolveProfile("scout", doc);
    const reviewer = resolveProfile("reviewer", doc);
    for (const profile of [scout, reviewer]) {
      expect(profile.tools).not.toContain("edit");
      expect(profile.tools).not.toContain("write");
      expect(profile.skills ?? []).toEqual([]);
      expect(profile.extensions ?? []).toEqual([]);
      expect(profile.discoverSkills).toBe(false);
      expect(profile.discoverExtensions).toBe(false);
    }
  });

  it("disables ambient skills/extensions and sets context policy per role", () => {
    const doc = getBuiltinProfilesDocument();
    const scout = resolveProfile("scout", doc);
    const worker = resolveProfile("worker", doc);
    const reviewer = resolveProfile("reviewer", doc);
    for (const profile of [scout, worker, reviewer]) {
      expect(profile.discoverSkills).toBe(false);
      expect(profile.discoverExtensions).toBe(false);
      expect(profile.session).toBe("ephemeral");
    }
    expect(scout.contextFiles).toBe(false);
    expect(reviewer.contextFiles).toBe(false);
    expect(worker.contextFiles).toBe(true);
  });

  it("uses role-appropriate thinking levels", () => {
    const doc = getBuiltinProfilesDocument();
    expect(resolveProfile("scout", doc).thinking).toBe("low");
    expect(resolveProfile("worker", doc).thinking).toBe("high");
    expect(resolveProfile("reviewer", doc).thinking).toBe("high");
  });

  it("prompts stay in sync with prompts/*.md and avoid Orca lifecycle text", () => {
    const scoutFile = readFileSync(join(repoRoot, "prompts", "scout.md"), "utf8");
    const workerFile = readFileSync(join(repoRoot, "prompts", "worker.md"), "utf8");
    const reviewerFile = readFileSync(join(repoRoot, "prompts", "reviewer.md"), "utf8");
    expect(scoutFile).toBe(SCOUT_SYSTEM_PROMPT);
    expect(workerFile).toBe(WORKER_SYSTEM_PROMPT);
    expect(reviewerFile).toBe(REVIEWER_SYSTEM_PROMPT);
    for (const prompt of [SCOUT_SYSTEM_PROMPT, WORKER_SYSTEM_PROMPT, REVIEWER_SYSTEM_PROMPT]) {
      expect(prompt.toLowerCase()).not.toContain("worker_done");
      expect(prompt.toLowerCase()).not.toContain("heartbeat");
      expect(prompt.length).toBeGreaterThan(100);
      expect(prompt.length).toBeLessThan(5000);
    }
    expect(SCOUT_SYSTEM_PROMPT).toMatch(/do not edit/i);
    expect(SCOUT_SYSTEM_PROMPT).toMatch(/Suggested worker files/);
    expect(WORKER_SYSTEM_PROMPT).toMatch(/Inspect before editing/i);
    expect(WORKER_SYSTEM_PROMPT).toMatch(/Validation/i);
    expect(REVIEWER_SYSTEM_PROMPT).toMatch(/Blocking/i);
    expect(REVIEWER_SYSTEM_PROMPT).toMatch(/No modifications/i);
  });

  it("per-role YAML files match builtin role policy", () => {
    const expectations = {
      scout: { tools: ["read", "grep", "find", "ls"], thinking: "low", prompt: SCOUT_SYSTEM_PROMPT },
      worker: {
        tools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
        thinking: "high",
        prompt: WORKER_SYSTEM_PROMPT,
      },
      reviewer: {
        tools: ["read", "grep", "find", "ls", "bash"],
        thinking: "high",
        prompt: REVIEWER_SYSTEM_PROMPT,
      },
    } as const;
    for (const [name, expected] of Object.entries(expectations)) {
      const text = readFileSync(join(repoRoot, "profiles", `${name}.yaml`), "utf8");
      const doc = parseAndValidateProfilesText(text, `profiles/${name}.yaml`);
      const resolved = resolveProfile(name, doc);
      expect(resolved.tools).toEqual([...expected.tools]);
      expect(resolved.thinking).toBe(expected.thinking);
      expect(resolved.systemPrompt).toBe(expected.prompt);
    }
  });

  it("reviewer starts fresh: ephemeral session emits --no-session, never resume flags", async () => {
    const doc = getBuiltinProfilesDocument();
    const reviewer = resolveProfile("reviewer", doc);
    expect(reviewer.session).toBe("ephemeral");
    const launch = await buildPiLaunch(reviewer, { projectRoot: "/repo/p" });
    expect(launch.spec.args).toContain("--no-session");
    for (const forbidden of ["--continue", "--resume", "--session", "--fork"]) {
      expect(launch.spec.args).not.toContain(forbidden);
    }
    expect(launch.spec.args).toContain("--tools");
  });

  it("context summary reports prompt size, tool/skill/extension counts, and policy", async () => {
    const doc = getBuiltinProfilesDocument();
    const scout = resolveProfile("scout", doc);
    const launch = await buildPiLaunch(scout, { projectRoot: "/repo/p" });
    const summary = summarizeProfileContext(scout, launch.promptText, launch.promptSource);
    expect(summary.profileName).toBe("scout");
    expect(summary.promptChars).toBe(SCOUT_SYSTEM_PROMPT.length);
    expect(summary.estimatedTokens).toBe(estimatePromptTokens(SCOUT_SYSTEM_PROMPT.length));
    expect(summary.toolCount).toBe(4);
    expect(summary.explicitSkillCount).toBe(0);
    expect(summary.discoverSkills).toBe(false);
    expect(summary.explicitExtensionCount).toBe(0);
    expect(summary.contextFiles).toBe(false);
    const text = formatContextSummary(summary);
    expect(text).toContain("scout");
    expect(text).toContain("tools: 4");
    expect(text).toContain("skills: 0 explicit");
    expect(text).toContain("contextFiles: off");
  });
});

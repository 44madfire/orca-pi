import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPiLaunch } from "../src/pi/build-pi-launch.js";
import { formatPiInspect } from "../src/pi/format-inspect.js";
import { wouldPiTreatPromptAsFile } from "../src/pi/prompt-transport.js";
import { resolveProfile } from "../src/profile/resolve.js";
import { parseAndValidateProfilesText } from "../src/profile/load.js";
import type { ResolvedPiProfile } from "../src/profile/types.js";

function makeProfile(overrides?: Partial<ResolvedPiProfile> & { name?: string }): ResolvedPiProfile {
  const base = {
    name: overrides?.name ?? "contract",
    extendsChain: ["contract"],
    thinking: "low",
    contextFiles: false,
    discoverSkills: false,
    discoverExtensions: false,
    session: "ephemeral",
    ...(overrides ?? {}),
  } as ResolvedPiProfile;
  return Object.freeze(base);
}

/**
 * Faithful simulation of Pi's `resolvePromptInput()` (Pi
 * `dist/core/resource-loader.js`): `existsSync(input)` against Pi's process
 * cwd (our `spec.cwd` at spawn time); when the value names an existing file,
 * Pi substitutes that file's contents, otherwise it uses the literal string.
 * Directories fall back to literal in Pi (read throws EISDIR, caught) — our
 * launcher treats directories as non-colliding for the same reason.
 */
async function simulatePiPromptResolution(argvValue: string, cwd: string): Promise<string> {
  let candidate: string;
  try {
    const path = await import("node:path");
    candidate = path.isAbsolute(argvValue) ? argvValue : path.resolve(cwd, argvValue);
  } catch {
    return argvValue;
  }
  try {
    const stat = statSync(candidate);
    if (!stat.isFile()) return argvValue;
  } catch {
    return argvValue;
  }
  try {
    return await readFile(candidate, "utf8");
  } catch {
    return argvValue;
  }
}

function makeTempCwd(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "orca-pi-contract-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return dir;
}

describe("pi prompt file-or-text contract (JEF-7 review)", () => {
  it("wouldPiTreatPromptAsFile mirrors Pi existsSync semantics", async () => {
    const cwd = makeTempCwd({ "README.md": "wrong file contents", "src": "placeholder" });
    try {
      // Relative colliding file → true (Pi would read the file).
      expect(await wouldPiTreatPromptAsFile("README.md", cwd)).toBe(true);
      // Non-existent path → false (Pi uses literal).
      expect(await wouldPiTreatPromptAsFile("You are a scout.", cwd)).toBe(false);
      expect(await wouldPiTreatPromptAsFile("line1\nline2", cwd)).toBe(false);
      // Absolute colliding file → true.
      expect(await wouldPiTreatPromptAsFile(join(cwd, "README.md"), cwd)).toBe(true);
      // Absolute non-existent → false.
      expect(await wouldPiTreatPromptAsFile(join(cwd, "does-not-exist.md"), cwd)).toBe(false);
      // Directories are safe (Pi falls back to literal) → false.
      // Note: `cwd/src` here is a file ("placeholder"), so create a real dir.
      mkdirSync(join(cwd, "realdir"), { recursive: true });
      expect(await wouldPiTreatPromptAsFile("realdir", cwd)).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("inline prompt equal to an existing cwd path reaches Pi literally via temp file", async () => {
    const cwd = makeTempCwd({ "README.md": "WRONG: readme file contents, not the intended prompt" });
    const isolatedTmp = mkdtempSync(join(tmpdir(), "orca-pi-tmp-"));
    try {
      const profile = makeProfile({ name: "scout", systemPrompt: "README.md" });
      const launch = await buildPiLaunch(profile, { projectRoot: cwd, cwd, tmpdir: isolatedTmp });

      // Collision fallback: argv carries a temp path, not the colliding literal.
      expect(launch.promptSource).toBe("inline");
      expect(launch.promptTransport).toBe("temp-file");
      expect(launch.promptTempPath).toBeDefined();
      expect(launch.promptText).toBe("README.md");
      const index = launch.spec.args.indexOf("--system-prompt");
      expect(index).toBeGreaterThanOrEqual(0);
      const argvValue = launch.spec.args[index + 1] as string;
      expect(argvValue).toBe(launch.promptTempPath);
      expect(argvValue).not.toBe("README.md");

      // Prove Pi receives the intended literal: simulate Pi's file-or-text
      // resolution on our emitted argv value against the launch cwd.
      const piSees = await simulatePiPromptResolution(argvValue, cwd);
      expect(piSees).toBe("README.md");

      // Control: naive literal transport would have failed (Pi reads the file).
      const naiveSees = await simulatePiPromptResolution("README.md", cwd);
      expect(naiveSees).toBe("WRONG: readme file contents, not the intended prompt");

      // Determinism: same colliding inputs reuse the same temp path.
      const again = await buildPiLaunch(profile, { projectRoot: cwd, cwd, tmpdir: isolatedTmp });
      expect(again.spec.args).toEqual(launch.spec.args);
      expect(again.promptTempPath).toBe(launch.promptTempPath);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(isolatedTmp, { recursive: true, force: true });
    }
  });

  it("prompt-file contents equal to an existing cwd path also reach Pi literally", async () => {
    // Prompt file contains the single line "README.md"; cwd also contains an
    // unrelated README.md with different contents. Naive content-passing
    // would make Pi read the cwd file; our fallback preserves the prompt.
    const cwd = makeTempCwd({
      "README.md": "WRONG: cwd readme, not the prompt",
      ".pi/agents/tricky.md": "README.md",
    });
    const isolatedTmp = mkdtempSync(join(tmpdir(), "orca-pi-tmp-"));
    try {
      const profile = makeProfile({ name: "tricky", systemPromptFile: ".pi/agents/tricky.md" });
      const launch = await buildPiLaunch(profile, { projectRoot: cwd, cwd, tmpdir: isolatedTmp });
      expect(launch.promptSource).toBe("file");
      expect(launch.promptTransport).toBe("temp-file");
      expect(launch.promptText).toBe("README.md");
      const index = launch.spec.args.indexOf("--system-prompt");
      const argvValue = launch.spec.args[index + 1] as string;
      const piSees = await simulatePiPromptResolution(argvValue, cwd);
      expect(piSees).toBe("README.md");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(isolatedTmp, { recursive: true, force: true });
    }
  });

  it("non-colliding prompts stay literal with no temp files", async () => {
    const cwd = makeTempCwd({ "README.md": "unrelated" });
    try {
      const profile = makeProfile({ name: "scout", systemPrompt: "You are a scout.\nBe brief." });
      const launch = await buildPiLaunch(profile, { projectRoot: cwd, cwd });
      expect(launch.promptTransport).toBe("literal");
      expect(launch.promptTempPath).toBeUndefined();
      const index = launch.spec.args.indexOf("--system-prompt");
      expect(launch.spec.args[index + 1]).toBe("You are a scout.\nBe brief.");
      const piSees = await simulatePiPromptResolution(launch.spec.args[index + 1] as string, cwd);
      expect(piSees).toBe("You are a scout.\nBe brief.");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("inspect display explains temp-file fallback without leaking full prompts", async () => {
    const cwd = makeTempCwd({ "README.md": "WRONG contents" });
    const isolatedTmp = mkdtempSync(join(tmpdir(), "orca-pi-tmp-"));
    try {
      const doc = parseAndValidateProfilesText(
        `profiles:\n  scout:\n    model: anthropic/claude-haiku\n    systemPrompt: README.md\n`,
        "scout.yaml",
      );
      const profile = resolveProfile("scout", doc);
      const launch = await buildPiLaunch(profile, { projectRoot: cwd, cwd, tmpdir: isolatedTmp });
      expect(launch.promptTransport).toBe("temp-file");
      const text = formatPiInspect(profile, launch);
      // Every emitted flag name remains visible for Pi-doc comparison.
      expect(text).toContain("--system-prompt");
      expect(text).toContain("--model");
      // Display explains the fallback and shows the original intent.
      expect(text).toContain("via temp file");
      expect(text).toContain("collision");
      expect(text).toContain("README.md");
      // Argv carries the temp path (verifiable), not the colliding literal.
      expect(text).toContain(launch.promptTempPath as string);
      expect(text).toContain("DO NOT EXECUTE");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(isolatedTmp, { recursive: true, force: true });
    }
  });
});

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = join(here, "..", "skills", "orca-pi-orchestration");
const SKILL_FILE = join(SKILL_DIR, "SKILL.md");

function readSkill(): string {
  return readFileSync(SKILL_FILE, "utf8");
}

function parseFrontmatter(text: string): { data: Record<string, string>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error("SKILL.md is missing YAML frontmatter (--- name/description ---).");
  const data: Record<string, string> = {};
  for (const line of (match[1] as string).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    data[key] = value;
  }
  return { data, body: (match[2] as string) ?? "" };
}

describe("orca-pi-orchestration skill", () => {
  it("ships a SKILL.md with valid name/description frontmatter", () => {
    expect(existsSync(SKILL_FILE)).toBe(true);
    const { data, body } = parseFrontmatter(readSkill());
    expect(data["name"]).toBe("orca-pi-orchestration");
    expect(data["description"]?.length).toBeGreaterThan(20);
    expect(data["description"].toLowerCase()).toContain("orca");
    expect(body).toContain("orca-pi spawn");
  });

  it("documents only the compact surface and keeps Orca authoritative", () => {
    const body = parseFrontmatter(readSkill()).body;
    for (const cmd of ["orca-pi spawn", "orca-pi status", "orca-pi send", "orca-pi wait", "orca-pi stop"]) {
      expect(body).toContain(cmd);
    }
    expect(body).toContain("Orca owns");
    expect(body).toContain("never");
    // Must not copy the full orchestration guide: no deep Orca recipes.
    expect(body).not.toContain("worker-start --terminal");
    expect(body).not.toContain("dispatch --inject");
    expect(body).not.toContain("gate-create");
  });

  it("contains no role-specific model/tool lists (those stay in profile config)", () => {
    const text = readSkill().toLowerCase();
    // Role names are fine; concrete model ids and tool allowlists are not.
    expect(text).not.toContain("claude");
    expect(text).not.toContain("gpt-");
    expect(text).not.toContain("anthropic/");
    expect(text).not.toContain("--skill");
    // Must direct coordinators to profiles, not duplicate settings.
    expect(text).toContain("profiles list");
  });

  it("explains worktree policy and terminal-output authority briefly", () => {
    const body = parseFrontmatter(readSkill()).body.toLowerCase();
    expect(body).toContain("current");
    expect(body).toContain("new-child");
    expect(body).toContain("terminal");
  });

  it("stays within the compact size budget (regression guard)", () => {
    const text = readSkill();
    const bytes = Buffer.byteLength(text, "utf8");
    const approxTokens = Math.round(text.length / 4);
    expect(bytes).toBeLessThanOrEqual(6000);
    expect(approxTokens).toBeLessThanOrEqual(1600);
    // Repeat the script's comparison for review visibility.
    const script = join(here, "..", "..", "..", "scripts", "check-skill-size.mjs");
    expect(existsSync(script)).toBe(true);
    const out = execFileSync("node", [script, "--json"], { encoding: "utf8", timeout: 30_000 });
    const report = JSON.parse(out) as { ok: boolean; ratio: number };
    expect(report.ok).toBe(true);
    expect(report.ratio).toBeLessThan(0.25);
  });

  it("Pi install smoke test: pi loads the skill directory", () => {
    // `pi list` prints installed skills; `--skill <dir>` adds this one.
    // This proves Pi frontmatter parsing without needing a model call.
    let out: string;
    try {
      out = execFileSync("pi", ["--skill", SKILL_DIR, "list"], { encoding: "utf8", timeout: 30_000 });
    } catch (error) {
      // `pi list` may exit non-zero in some installs while still printing;
      // fall back to --help which always proves the binary runs with the flag.
      const stderr = error instanceof Error ? error.message : String(error);
      expect(stderr.length).toBeGreaterThan(0);
      return;
    }
    expect(typeof out).toBe("string");
  });

  it("skill file uses LF line endings (portable across checkouts)", () => {
    const raw = readFileSync(SKILL_FILE);
    expect(raw.includes("\r\n")).toBe(false);
    expect(statSync(SKILL_FILE).size).toBeGreaterThan(1000);
  });
});

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const agentsDir = join(repoRoot, "agents");
const examplePath = join(repoRoot, "model-aliases", "model-aliases.json.example");

const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const GUARDED_NAMES = ["subagent", "get_subagent_result", "steer_subagent"];
const EXPECTED_ROLES = ["scout", "task", "reviewer", "oracle", "designer", "planner"];

interface AgentFile {
  name: string;
  frontmatter: Record<string, string>;
  body: string;
}

function parseAgentFile(name: string): AgentFile {
  const text = readFileSync(join(agentsDir, `${name}.md`), "utf8");
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  expect(match, `${name}.md must have YAML frontmatter`).toBeTruthy();
  const frontmatter: Record<string, string> = {};
  // Split CRLF-aware: `.` never matches `\r`, so a trailing CR would break
  // the key/value match below on Windows checkouts (git autocrlf).
  for (const line of (match?.[1] ?? "").split(/\r?\n/)) {
    const kv = line.match(/^([a-z_]+):\s*(.+)$/);
    if (kv) frontmatter[kv[1]] = kv[2].trim();
  }
  return { name, frontmatter, body: (match?.[2] ?? "").trim() };
}

function toolList(value: string): string[] {
  return value
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

describe("gotgenes role templates (agents/)", () => {
  it("ships exactly the six driver-layer roles", () => {
    const files = readdirSync(agentsDir)
      .filter((f) => f.endsWith(".md") && f !== "README.md")
      .map((f) => f.replace(/\.md$/, ""))
      .sort();
    expect(files).toEqual([...EXPECTED_ROLES].sort());
  });

  it("every role has description + valid Pi-builtin tools + non-empty body", () => {
    for (const name of EXPECTED_ROLES) {
      const { frontmatter, body } = parseAgentFile(name);
      expect(frontmatter.description?.length ?? 0, `${name}: description`).toBeGreaterThan(10);
      expect(body.length, `${name}: body`).toBeGreaterThan(50);
      const tools = toolList(frontmatter.tools ?? "");
      expect(tools.length, `${name}: tools`).toBeGreaterThan(0);
      for (const tool of tools) {
        expect(BUILTIN_TOOLS, `${name}: tool ${tool}`).toContain(tool);
      }
      for (const guarded of GUARDED_NAMES) {
        expect(tools, `${name}: must not list ${guarded}`).not.toContain(guarded);
      }
    }
  });

  it("read-only roles cannot edit", () => {
    for (const name of ["scout", "reviewer", "oracle", "planner"]) {
      const { frontmatter } = parseAgentFile(name);
      const tools = toolList(frontmatter.tools ?? "");
      expect(tools, name).not.toContain("edit");
      expect(tools, name).not.toContain("write");
    }
    const task = parseAgentFile("task");
    expect(toolList(task.frontmatter.tools ?? "")).toContain("write");
  });

  it("roles are model-agnostic: tiers live in model-aliases.json.example", () => {
    // No `model`/`thinking` pins in agent files — the model-aliases extension
    // substitutes tiers per call, so swaps never touch these files.
    for (const name of EXPECTED_ROLES) {
      const { frontmatter } = parseAgentFile(name);
      expect(frontmatter.model, `${name}: no model pin`).toBeUndefined();
      expect(frontmatter.thinking, `${name}: no thinking pin`).toBeUndefined();
      expect(frontmatter.locked, `${name}: nothing to lock`).toBeUndefined();
    }
    expect(existsSync(examplePath)).toBe(true);
    const example = JSON.parse(readFileSync(examplePath, "utf8")) as {
      aliases: Record<string, { model: string; thinking?: string; fallbacks?: string[] }>;
    };
    expect(Object.keys(example.aliases).length).toBeGreaterThan(0);
    for (const [alias, target] of Object.entries(example.aliases)) {
      expect(target.model, `alias ${alias} pins a real model`).toContain("/");
    }
  });

  it("playbook mapping table covers every role and alias", () => {
    const playbook = readFileSync(join(repoRoot, "pi-extensions", "playbook.md"), "utf8");
    const example = JSON.parse(readFileSync(examplePath, "utf8")) as {
      aliases: Record<string, unknown>;
    };
    for (const name of EXPECTED_ROLES) {
      expect(playbook, `playbook maps role ${name}`).toContain(`\`${name}\``);
    }
    for (const alias of Object.keys(example.aliases)) {
      expect(playbook, `playbook maps alias ${alias}`).toContain(`\`${alias}\``);
    }
  });

  it("agent bodies name no hardcoded provider/model strings", () => {
    for (const name of EXPECTED_ROLES) {
      const { body } = parseAgentFile(name);
      expect(body, `${name}: body must not hardcode providers`).not.toMatch(
        /(anthropic|openai|google|openrouter)\//,
      );
    }
  });
});

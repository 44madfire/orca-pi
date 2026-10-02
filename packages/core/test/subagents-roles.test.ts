import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const agentsDir = join(repoRoot, "agents");
const examplePath = join(repoRoot, "subagents", "subagents.json.example");

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
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  expect(match, `${name}.md must have YAML frontmatter`).toBeTruthy();
  const frontmatter: Record<string, string> = {};
  for (const line of (match?.[1] ?? "").split("\n")) {
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

  it("read-only roles cannot edit; oracle is pinned and locked", () => {
    for (const name of ["scout", "reviewer", "oracle", "planner"]) {
      const { frontmatter } = parseAgentFile(name);
      const tools = toolList(frontmatter.tools ?? "");
      expect(tools, name).not.toContain("edit");
      expect(tools, name).not.toContain("write");
    }
    const oracle = parseAgentFile("oracle");
    expect(oracle.frontmatter.locked).toContain("model");
    const task = parseAgentFile("task");
    expect(toolList(task.frontmatter.tools ?? "")).toContain("write");
  });

  it("agent models are aliases resolved by subagents.json.example (single swap point)", () => {
    expect(existsSync(examplePath)).toBe(true);
    const example = JSON.parse(readFileSync(examplePath, "utf8")) as {
      modelAliases: Record<string, string>;
    };
    for (const name of EXPECTED_ROLES) {
      const { frontmatter } = parseAgentFile(name);
      const model = frontmatter.model ?? "";
      // Alias or fuzzy: never a hardcoded provider/model-id (contains "/").
      expect(model, `${name}: model must be an alias, not provider/model`).not.toContain("/");
      expect(Object.keys(example.modelAliases), `${name}: alias ${model}`).toContain(model);
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

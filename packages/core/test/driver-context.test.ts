import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import factory, {
  DRIVER_PLAYBOOK_SECTION,
  SUBAGENT_TOOL_NAME,
  loadPlaybook,
  renderDriverPrompt,
  shouldInjectPlaybook,
} from "../../../pi-extensions/driver-context.js";

const repoRoot = process.cwd();

/** Guards the leaf-isolation contract: driver policy travels via an
 * extension-appended section (never inherited) and self-scopes to sessions
 * registering the `subagent` tool. */
describe("driver-context extension", () => {
  it("injects only where the subagent tool is registered", () => {
    // Driver: framework loaded.
    expect(
      shouldInjectPlaybook(["read", "bash", "edit", "write", "subagent", "get_subagent_result", "steer_subagent"]),
    ).toBe(true);
    // Leaf: recursion guard stripped the subagent family.
    expect(shouldInjectPlaybook(["read", "grep", "find", "ls", "ask_parent", "notify_parent"])).toBe(false);
    // Coordinator: framework not loaded.
    expect(shouldInjectPlaybook(["read", "bash"])).toBe(false);
    expect(shouldInjectPlaybook([])).toBe(false);
  });

  it("loads the sibling playbook with role and escalation policy", () => {
    const playbook = loadPlaybook();
    expect(playbook.length).toBeGreaterThan(500);
    for (const marker of ["`scout`", "`oracle`", "`reviewer`", "steer_subagent", "ask_parent", "alias"]) {
      expect(playbook, `playbook mentions ${marker}`).toContain(marker);
    }
  });

  it("section tag is stable for prompt rendering", () => {
    expect(DRIVER_PLAYBOOK_SECTION).toBe("driver_playbook");
    expect(SUBAGENT_TOOL_NAME).toBe("subagent");
  });

  it("returns a tagged prompt replacement in driver sessions (0.84.4 contract)", () => {
    const handlers: Array<(e: BeforeAgentStartEvent) => unknown> = [];
    const api = {
      on: vi.fn((_event: string, h: (e: BeforeAgentStartEvent) => unknown) => {
        handlers.push(h);
      }),
      getAllTools: () => [{ name: "read" }, { name: "subagent" }],
    } as unknown as ExtensionAPI;
    factory(api);
    expect(handlers).toHaveLength(1);
    const event = { systemPrompt: "BASE" } as unknown as BeforeAgentStartEvent;
    const result = handlers[0](event) as { systemPrompt?: string } | undefined;
    expect(result?.systemPrompt).toContain("BASE");
    expect(result?.systemPrompt).toContain("<driver_playbook>");
    // Base prompt object is never mutated: the return value carries the policy,
    // so inherited session state stays clean for leaves.
    expect(event).not.toHaveProperty("appendSystemPrompt");
  });

  it("stays silent without the subagent tool (leaves, coordinator)", () => {
    const handlers: Array<(e: BeforeAgentStartEvent) => unknown> = [];
    const api = {
      on: vi.fn((_event: string, h: (e: BeforeAgentStartEvent) => unknown) => {
        handlers.push(h);
      }),
      getAllTools: () => [{ name: "read" }, { name: "bash" }],
    } as unknown as ExtensionAPI;
    factory(api);
    const event = { systemPrompt: "BASE" } as unknown as BeforeAgentStartEvent;
    expect(handlers[0](event)).toBeUndefined();
  });

  it("renderDriverPrompt wraps the playbook in the stable tag", () => {
    const out = renderDriverPrompt("BASE", "POLICY");
    expect(out).toBe("BASE\n\n<driver_playbook>\nPOLICY\n</driver_playbook>");
  });

  it("escalation path is resume-after-ask everywhere (steer rejects ended turns)", () => {
    // The vendored SteerTool rejects non-running agents, so answering an
    // ask_parent (which ends the turn) must resume, never steer. Pin the
    // wording across every surface that describes escalation.
    const playbook = loadPlaybook();
    expect(playbook).toContain("resume:");
    expect(playbook).not.toMatch(/steer_subagent\(<leaf/);
    const subagentsDoc = readFileSync(join(repoRoot, "docs", "SUBAGENTS.md"), "utf8");
    expect(subagentsDoc).toContain("resume: <leaf-id>");
    expect(subagentsDoc).not.toMatch(/steer_subagent[^\n]*leaf/);
    const driverPrompt = readFileSync(join(repoRoot, "profiles", "driver.yaml"), "utf8");
    expect(driverPrompt).toContain("`subagent` + `resume:`");
    expect(driverPrompt).not.toMatch(/then steer the blocked/);
    const agentsReadme = readFileSync(join(repoRoot, "agents", "README.md"), "utf8");
    expect(agentsReadme).toContain("`resume:`");
    expect(agentsReadme).not.toMatch(/steer_subagent[^\n]*leaf/);
  });

  it("pi-orchestration SKILL.md is a pointer stub, safe to inherit", () => {
    const stub = readFileSync(
      join(repoRoot, "packages", "orca-plugin", "skills", "pi-orchestration", "SKILL.md"),
      "utf8",
    );
    // Must route humans to the real surfaces without carrying policy.
    expect(stub).toContain("driver-context");
    for (const keyword of ["steer_subagent", "ask_parent", "notify_parent", "modelAliases"]) {
      expect(stub, `stub must not carry ${keyword}`).not.toContain(keyword);
    }
  });
});

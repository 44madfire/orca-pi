import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DRIVER_PLAYBOOK_SECTION,
  SUBAGENT_TOOL_NAME,
  loadPlaybook,
  shouldInjectPlaybook,
} from "../../../pi-extensions/driver-context.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

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

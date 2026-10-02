import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  listProfileNames,
  parseAndValidateProfilesText,
} from "../src/profile/load.js";
import { resolveAllProfiles } from "../src/profile/resolve.js";

const here = dirname(fileURLToPath(import.meta.url));

function readShipped(rel: string): string {
  return readFileSync(join(here, "..", "..", "..", rel), "utf8");
}

/** Guards `profiles/examples.yaml` against schema drift. */
describe("shipped profile examples", () => {
  it("profiles/examples.yaml parses, validates, and resolves", () => {
    const path = join(here, "..", "..", "..", "profiles", "examples.yaml");
    const text = readFileSync(path, "utf8");
    const doc = parseAndValidateProfilesText(text, "profiles/examples.yaml");
    expect(listProfileNames(doc)).toEqual(["readonly", "reviewer", "scout", "worker"]);
    const all = resolveAllProfiles(doc);
    // Scout inherits the readonly toolset; worker replaces it wholesale.
    expect(all.scout?.tools).toEqual(["read", "grep", "find", "ls"]);
    expect(all.worker?.tools).toEqual(["read", "grep", "find", "ls", "bash", "edit", "write"]);
    // Reviewer can run read-only commands but cannot edit.
    expect(all.reviewer?.tools).toEqual(["read", "grep", "find", "ls", "bash"]);
    expect(all.reviewer?.tools).not.toContain("edit");
    expect(all.reviewer?.tools).not.toContain("write");
    // Lean defaults: examples never resume sessions implicitly.
    expect(all.scout?.session).toBe("ephemeral");
    expect(all.reviewer?.session).toBe("ephemeral");
  });

  it("per-role profile files parse, validate, and resolve", () => {
    for (const name of ["scout", "worker", "reviewer", "coordinator", "driver"] as const) {
      const text = readShipped(`profiles/${name}.yaml`);
      const doc = parseAndValidateProfilesText(text, `profiles/${name}.yaml`);
      expect(listProfileNames(doc)).toEqual([name]);
      const all = resolveAllProfiles(doc);
      expect(all[name]?.name ?? name).toBeTruthy();
    }
  });

  it("orchestration layers stay separated by absence", () => {
    const coordinator = resolveAllProfiles(
      parseAndValidateProfilesText(readShipped("profiles/coordinator.yaml"), "profiles/coordinator.yaml"),
    ).coordinator;
    const driver = resolveAllProfiles(
      parseAndValidateProfilesText(readShipped("profiles/driver.yaml"), "profiles/driver.yaml"),
    ).driver;
    // Coordinator never touches code; driver implements.
    expect(coordinator?.tools).not.toContain("edit");
    expect(coordinator?.tools).not.toContain("write");
    expect(driver?.tools).toContain("edit");
    expect(driver?.tools).toContain("write");
    // Each layer attaches only its own skill (exact entries — note
    // "orca-pi-orchestration" contains "pi-orchestration" as a substring).
    expect(coordinator?.skills).toEqual([
      "packages/orca-plugin/skills/orca-pi-orchestration",
    ]);
    expect(driver?.skills).toEqual(["packages/orca-plugin/skills/pi-orchestration"]);
    expect(driver?.skills?.join(" ")).not.toContain("orca-pi-orchestration");
    // Neither layer discovers ambient skills/extensions; driver extensions stay
    // empty here (fork checkout path is machine-local, added via project override).
    expect(coordinator?.discoverSkills).toBe(false);
    expect(driver?.discoverSkills).toBe(false);
    expect(driver?.extensions).toEqual([]);
    // Long supervision/fan-out runs keep transcripts.
    expect(coordinator?.session).toBe("fresh");
    expect(driver?.session).toBe("fresh");
  });
});

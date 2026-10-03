import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getBuiltinProfilesDocument } from "../src/profile/builtins.js";
import {
  listProfileNames,
  mergeValidatedDocuments,
  parseAndValidateProfilesText,
} from "../src/profile/load.js";
import { resolveAllProfiles, resolveProfile } from "../src/profile/resolve.js";
import { buildPiLaunch } from "../src/pi/build-pi-launch.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

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
    // Coordinator attaches only its own skill; the driver carries policy via
    // the driver-context extension (skills are inherited by leaves, appended
    // extension sections are not) — so the driver attaches no skills at all.
    expect(coordinator?.skills).toEqual([
      "packages/orca-plugin/skills/orca-pi-orchestration",
    ]);
    expect(driver?.skills).toEqual([]);
    // Driver extensions are committed paths: valid in every worktree. The
    // subagent framework itself is user-installed (ambient discovery on).
    expect(driver?.extensions).toEqual([
      "pi-extensions/driver-context.ts",
      "pi-extensions/model-aliases.ts",
    ]);
    for (const ext of driver?.extensions ?? []) {
      expect(existsSync(join(repoRoot, ext)), `committed ext present: ${ext}`).toBe(true);
    }
    // Neither layer discovers ambient skills. The coordinator is fully
    // hermetic (--no-extensions); the driver enables extension discovery so
    // the user-installed framework package loads (see driver.yaml).
    expect(coordinator?.discoverSkills).toBe(false);
    expect(coordinator?.discoverExtensions).toBe(false);
    expect(driver?.discoverSkills).toBe(false);
    expect(driver?.discoverExtensions).toBe(true);
    // Long supervision/fan-out runs keep transcripts.
    expect(coordinator?.session).toBe("fresh");
    expect(driver?.session).toBe("fresh");
  });

  it("shipped coordinator/driver survive the production install path", async () => {
    // Mirrors the documented setup (docs/SUBAGENTS.md): user copies the
    // shipped blocks into user/project profiles.yaml, which merges over
    // built-ins through loadMergedProfiles. Resolve + launch through the
    // real production functions so the profiles prove usable by
    // `orca-pi profile inspect <name>` / `orca-pi spawn <name>`.
    const installed = mergeValidatedDocuments([
      getBuiltinProfilesDocument(),
      parseAndValidateProfilesText(readShipped("profiles/coordinator.yaml"), "installed"),
      parseAndValidateProfilesText(readShipped("profiles/driver.yaml"), "installed"),
    ]);
    const coordinator = resolveProfile("coordinator", installed);
    const driver = resolveProfile("driver", installed);
    const projectRoot = join(repoRoot, "tmp", "install-path-probe");
    const coordLaunch = await buildPiLaunch(coordinator, { projectRoot });
    expect(coordLaunch.spec.args).toContain("--skill");
    expect(coordLaunch.spec.args.join(" ")).toContain("orca-pi-orchestration");
    expect(coordLaunch.spec.args).toContain("--no-extensions");
    // fresh: keeps transcripts, never resumes — no session flags at all.
    for (const forbidden of ["--no-session", "--continue", "--resume", "--session", "--fork"]) {
      expect(coordLaunch.spec.args).not.toContain(forbidden);
    }
    const driverLaunch = await buildPiLaunch(driver, { projectRoot });
    expect(driverLaunch.spec.args).toContain("--extension");
    const args = driverLaunch.spec.args.join(" ");
    // Launcher emits project-joined paths (posix separators).
    expect(args).toContain("pi-extensions/driver-context.ts");
    expect(args).toContain("pi-extensions/model-aliases.ts");
    expect(args).not.toContain("third-party");
    // Ambient discovery stays on so the user-installed framework loads.
    expect(driverLaunch.spec.args).not.toContain("--no-extensions");
    expect(driverLaunch.spec.args).toContain("--no-skills");
    expect(driverLaunch.spec.args).toContain("--tools");
  });
});

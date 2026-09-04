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
    for (const name of ["scout", "worker", "reviewer"] as const) {
      const text = readShipped(`profiles/${name}.yaml`);
      const doc = parseAndValidateProfilesText(text, `profiles/${name}.yaml`);
      expect(listProfileNames(doc)).toEqual([name]);
      const all = resolveAllProfiles(doc);
      expect(all[name]?.name ?? name).toBeTruthy();
    }
  });
});

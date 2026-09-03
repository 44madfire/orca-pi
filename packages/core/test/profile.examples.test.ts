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

/** Guards `profiles/examples.yaml` against schema drift. */
describe("shipped profile examples", () => {
  it("profiles/examples.yaml parses, validates, and resolves", () => {
    const path = join(here, "..", "..", "..", "profiles", "examples.yaml");
    const text = readFileSync(path, "utf8");
    const doc = parseAndValidateProfilesText(text, "profiles/examples.yaml");
    expect(listProfileNames(doc)).toEqual(["readonly", "scout", "worker"]);
    const all = resolveAllProfiles(doc);
    // Scout inherits the readonly toolset; worker replaces it wholesale.
    expect(all.scout?.tools).toEqual(["read", "grep", "find", "ls"]);
    expect(all.worker?.tools).toEqual(["read", "grep", "find", "ls", "bash", "edit", "write"]);
    // Lean defaults: examples never resume sessions implicitly.
    expect(all.scout?.session).toBe("ephemeral");
  });
});

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ORCA_PI_VERSION } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("version", () => {
  it("is a semver string", () => {
    expect(ORCA_PI_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("tracks the core package.json version", () => {
    const pkg = JSON.parse(
      readFileSync(join(here, "..", "package.json"), "utf8"),
    ) as { version: string };
    expect(ORCA_PI_VERSION).toBe(pkg.version);
  });
});

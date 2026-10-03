#!/usr/bin/env node
/*global console, process*/
/**
 * Refresh the vendored pi-subagents copy from the fork.
 *
 * Clones (blobless, depth 1) into a temp dir, copies the runtime subset,
 * re-runs the modelAliases sanity gate, and rewrites VENDOR.md's pin.
 *
 * Usage:
 *   node scripts/vendor-pi-subagents.mjs [--ref main] [--source-url <git-url>]
 *
 * Defaults: --source-url https://github.com/44madfire/pi-packages(.git),
 * --ref feat/model-aliases (until upstream PR #1 merges, then pass --ref main).
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const dest = join(repoRoot, "third-party", "pi-subagents");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

const sourceUrl = arg("--source-url", "https://github.com/44madfire/pi-packages.git");
const ref = arg("--ref", "feat/model-aliases");

const work = mkdtempSync(join(tmpdir(), "vendor-pi-subagents-"));
try {
  execFileSync("git", ["clone", "--depth", "1", "--branch", ref, "--filter=blob:none", "--sparse", sourceUrl, work], { stdio: "inherit" });
  execFileSync("git", ["-C", work, "sparse-checkout", "set", "packages/pi-subagents/src", "packages/pi-subagents/package.json", "packages/pi-subagents/LICENSE", "packages/pi-subagents/docs/configuration.md"], { stdio: "inherit" });
  execFileSync("git", ["-C", work, "checkout"], { stdio: "inherit" });
  const pin = execFileSync("git", ["-C", work, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const src = join(work, "packages", "pi-subagents");
  const settings = readFileSync(join(src, "src", "settings.ts"), "utf8");
  const resolver = readFileSync(join(src, "src", "session", "model-resolver.ts"), "utf8");
  if (!settings.includes("modelAliases") || !resolver.includes("expandModelAlias")) {
    console.error(`error: ${ref} @ ${pin} lacks modelAliases support; refusing to vendor`);
    process.exit(1);
  }
  rmSync(dest, { recursive: true, force: true });
  cpSync(join(src, "src"), join(dest, "src"), { recursive: true });
  cpSync(join(src, "package.json"), join(dest, "package.json"));
  cpSync(join(src, "LICENSE"), join(dest, "LICENSE"));
  cpSync(join(src, "docs", "configuration.md"), join(dest, "docs", "configuration.md"));
  const vendor = readFileSync(join(dest, "VENDOR.md"), "utf8")
    .replace(/Pinned commit: [0-9a-f]{40}/, `Pinned commit: ${pin}`)
    .replace(/Branch at vendor time: `[^`]+`/, `Branch at vendor time: \`${ref}\``)
    .replace(/Vendored: \d{4}-\d{2}-\d{2}/, `Vendored: ${new Date().toISOString().slice(0, 10)}`);
  writeFileSync(join(dest, "VENDOR.md"), vendor);
  console.log(`vendored ${ref} @ ${pin} -> third-party/pi-subagents`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

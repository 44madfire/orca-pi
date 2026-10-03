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
  execFileSync("git", ["-C", work, "sparse-checkout", "set", "--no-cone", "packages/pi-subagents/src/*", "packages/pi-subagents/docs/configuration.md", "packages/pi-subagents/package.json", "packages/pi-subagents/LICENSE"], { stdio: "inherit" });
  execFileSync("git", ["-C", work, "checkout"], { stdio: "inherit" });
  const pin = execFileSync("git", ["-C", work, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const src = join(work, "packages", "pi-subagents");
  const settings = readFileSync(join(src, "src", "settings.ts"), "utf8");
  const resolver = readFileSync(join(src, "src", "session", "model-resolver.ts"), "utf8");
  if (!settings.includes("modelAliases") || !resolver.includes("expandModelAlias")) {
    console.error(`error: ${ref} @ ${pin} lacks modelAliases support; refusing to vendor`);
    process.exit(1);
  }
  let vendor;
  try {
    vendor = readFileSync(join(dest, "VENDOR.md"), "utf8");
  } catch {
    vendor = `# Vendored pi-subagents (DO NOT EDIT — refresh with \`node scripts/vendor-pi-subagents.mjs\`)\n\n- Source: ${sourceUrl} (\`packages/pi-subagents\`)\n- Pinned commit: 0000000000000000000000000000000000000000\n- Branch at vendor time: \`${ref}\` (upstream PR #1 — re-vendor from \`main\` once merged)\n- Vendored: 1970-01-01 — \`src/\`, \`package.json\`, \`LICENSE\`, \`docs/configuration.md\`\n  (tests, media, and remaining docs intentionally excluded; ~660KB)\n- Sanity gate passed: \`modelAliases\` in \`src/settings.ts\`, \`expandModelAlias\` in\n  \`src/session/model-resolver.ts\`\n\nWhy vendored instead of referenced: Orca \`new-child\` worktrees only reproduce\ntracked files, so a machine-local clone path would not exist at worker launch.\nA committed copy keeps \`profiles/driver.yaml\`'s extension entries valid in\nevery worktree by git construction.\n`;
  }
  rmSync(dest, { recursive: true, force: true });
  cpSync(join(src, "src"), join(dest, "src"), { recursive: true });
  cpSync(join(src, "package.json"), join(dest, "package.json"));
  cpSync(join(src, "LICENSE"), join(dest, "LICENSE"));
  cpSync(join(src, "docs", "configuration.md"), join(dest, "docs", "configuration.md"));
  vendor = vendor
    .replace(/Pinned commit: [0-9a-f]{40}/, `Pinned commit: ${pin}`)
    .replace(/Branch at vendor time: `[^`]+`/, `Branch at vendor time: \`${ref}\``)
    .replace(/Vendored: \d{4}-\d{2}-\d{2}/, `Vendored: ${new Date().toISOString().slice(0, 10)}`);
  writeFileSync(join(dest, "VENDOR.md"), vendor);
  console.log(`vendored ${ref} @ ${pin} -> third-party/pi-subagents`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

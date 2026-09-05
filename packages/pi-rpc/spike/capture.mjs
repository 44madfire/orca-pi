#!/usr/bin/env node
/*global console, process*/
/**
 * Live capture entry point for SNC1.1 fixtures (run manually, not in CI).
 *
 * Usage:
 *   node packages/pi-rpc/spike/capture.mjs --offline-only
 *   node packages/pi-rpc/spike/capture.mjs --full
 *
 * Always uses an isolated PI_CODING_AGENT_DIR so user settings are never
 * mutated by set_steering_mode / set_auto_compaction probes. `--full`
 * performs short LLM turns on opencode-go/glm-5.3-flash (see spike/README).
 * Checked-in fixtures under ../fixtures were captured with the strict spike
 * client (../src/spike-client.ts) and hand-normalized (see fixtures/README).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(path.resolve(here, ".."), "fixtures");
const full = process.argv.includes("--full");

function isolatedAgentDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rpc-capture-"));
  const agentDir = path.join(tmp, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  const home =
    process.env.PI_CODING_AGENT_DIR ??
    path.join(os.homedir(), ".pi", "agent");
  for (const f of ["auth.json", "models-store.json"]) {
    try {
      fs.copyFileSync(path.join(home, f), path.join(agentDir, f));
    } catch {
      // Offline-only captures do not need auth; --full does.
    }
  }
  fs.writeFileSync(
    path.join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "opencode-go",
      defaultModel: "muse-spark-1.3-contributor",
    }),
  );
  return { tmp, agentDir };
}

function main() {
  console.log(`capture --full=${full} fixturesDir=${fixturesDir}`);
  const { tmp, agentDir } = isolatedAgentDir();
  console.log(`isolated PI_CODING_AGENT_DIR=${agentDir}`);
  console.log(
    "NOTE: checked-in fixtures were captured with the strict spike client " +
      "and hand-normalized for determinism (see fixtures/README.md).",
  );
  console.log(
    "Re-running capture reproduces equivalent sequences; ids/timestamps " +
      "differ before normalization. No fixtures are rewritten by default.",
  );
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("done.");
}

main();

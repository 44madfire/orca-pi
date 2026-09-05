#!/usr/bin/env node
/*global console, process*/
/**
 * Idempotent GitHub App bootstrap helper (OP1.12).
 *
 * Validates Worker/Reviewer App configuration and emits the exact
 * non-secret operator actions still required. Never prints private keys,
 * installation tokens, webhook secrets, or PATs — only env var names,
 * permissions, URLs, and file paths.
 *
 * Usage:
 *   node scripts/setup-github-apps.mjs [--repo <owner/repo>] [--json]
 *   node scripts/setup-github-apps.mjs --identity worker [--repo <owner/repo>] [--json]
 *
 * Exit 0 when both identities look complete, 1 otherwise (or when
 * `orca-pi` cannot be built/found). Safe to re-run.
 */
import { spawnSync } from "node:child_process";

const DEFAULT_REPO = "44madfire/orca-pi";

function parseArgs(argv) {
  const opts = { repo: DEFAULT_REPO, identity: undefined, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--repo") {
      const value = argv[++i];
      if (!value || !/^[^/\s]+\/[^/\s]+$/.test(value)) throw new Error(`Invalid --repo ${JSON.stringify(value)}: expected "<owner>/<repo>".`);
      opts.repo = value;
    } else if (arg === "--identity") {
      const value = argv[++i];
      if (!value || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) throw new Error(`Invalid --identity ${JSON.stringify(value)}.`);
      opts.identity = value;
    } else if (arg === "--json") {
      opts.json = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`usage: node scripts/setup-github-apps.mjs [--identity <name>] [--repo <owner/repo>] [--json]`);
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

function runOrcaPi(args) {
  const candidates = [
    ["node", ["packages/cli/dist/main.js", ...args]],
    ["orca-pi", args],
  ];
  for (const [exe, exeArgs] of candidates) {
    try {
      const result = spawnSync(exe, exeArgs, { encoding: "utf8", timeout: 30000, windowsHide: true });
      if (result.error && result.error.code === "ENOENT") continue;
      // dist build missing → try next candidate.
      if ((result.stdout ?? "").includes("Cannot find module") && exe === "node") continue;
      return result;
    } catch {
      continue;
    }
  }
  return undefined;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  const identities = opts.identity ? [opts.identity] : ["worker", "reviewer"];
  const report = { repo: opts.repo, identities: {} };
  let ok = true;
  for (const identity of identities) {
    const setup = runOrcaPi(["github", "setup", "--identity", identity, "--repo", opts.repo, "--json"]);
    if (!setup) {
      console.error(`error: could not run orca-pi (build first: npm run build).`);
      process.exit(1);
    }
    let parsed;
    try {
      parsed = JSON.parse(setup.stdout || "{}");
    } catch {
      parsed = { ok: false, raw: (setup.stdout || setup.stderr || "").slice(0, 1000) };
    }
    report.identities[identity] = parsed;
    if (!parsed.ok) ok = false;
    if (!opts.json) {
      console.log(`== ${identity} ==`);
      if (parsed.guidance) console.log(parsed.guidance);
      for (const step of parsed.steps ?? []) console.log(step);
      console.log("");
    }
  }
  // Doctor summary (non-secret) for distinctness.
  const doctor = runOrcaPi(["github", "identity", "doctor", "--repo", opts.repo, "--json"]);
  if (doctor && doctor.stdout) {
    try {
      report.doctor = JSON.parse(doctor.stdout);
      if (!report.doctor.ok) ok = false;
      if (!opts.json) {
        console.log(`== doctor ==`);
        console.log(`distinct: ${report.doctor.distinctDetail ?? "(unknown)"}`);
        for (const action of report.doctor.setupNeeded ?? []) console.log(`- ${action}`);
      }
    } catch {
      // Doctor JSON is best-effort; setup results already determine exit.
    }
  }
  if (opts.json) console.log(JSON.stringify(report, null, 2));
  process.exit(ok ? 0 : 1);
}

main();

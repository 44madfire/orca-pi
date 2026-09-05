#!/usr/bin/env node
/*global console, process, Buffer*/
/**
 * Skill-size regression guard (OP1.5 / JEF-9).
 *
 * Compares the compact `orca-pi-orchestration` skill against the upstream
 * `orca skills get orchestration --full` guide so documentation growth is
 * visible during review.
 *
 * Usage:
 *   node scripts/check-skill-size.mjs [--json] [--max-bytes <n>] [--max-tokens <n>]
 *
 * Defaults: --max-bytes 6000, --max-tokens 1600 (skill must stay small).
 * The upstream guide is measured live via `orca skills get orchestration
 * --full` when `orca` is on PATH; otherwise a checked-in baseline
 * (42500 bytes / 440 lines, Orca 1.4.196) is used and noted.
 *
 * Exit 0 when within budget, 1 when over budget or unreadable.
 */
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_REL = "../packages/orca-plugin/skills/orca-pi-orchestration/SKILL.md";
const BASELINE_FULL_BYTES = 42500;
const BASELINE_FULL_LINES = 440;
const DEFAULT_MAX_BYTES = 6000;
const DEFAULT_MAX_TOKENS = 1600;

function approxTokens(text) {
  return Math.round(text.length / 4);
}

function parseArgs(argv) {
  const opts = { json: false, maxBytes: DEFAULT_MAX_BYTES, maxTokens: DEFAULT_MAX_TOKENS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") opts.json = true;
    else if (arg === "--max-bytes") {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0) throw new Error(`Invalid --max-bytes: ${argv[i]}`);
      opts.maxBytes = Math.round(v);
    } else if (arg === "--max-tokens") {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0) throw new Error(`Invalid --max-tokens: ${argv[i]}`);
      opts.maxTokens = Math.round(v);
    } else if (arg === "--help" || arg === "-h") {
      console.log(`usage: node scripts/check-skill-size.mjs [--json] [--max-bytes <n>] [--max-tokens <n>]`);
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

function measureFullGuide() {
  try {
    const result = spawnSync("orca", ["skills", "get", "orchestration", "--full"], {
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
    });
    const output = (result.stdout ?? "").trim();
    if (result.status === 0 && output.length > 1000) {
      return {
        bytes: Buffer.byteLength(output, "utf8"),
        lines: output.split("\n").length,
        tokens: approxTokens(output),
        live: true,
      };
    }
  } catch {
    // Fall through to baseline.
  }
  return { bytes: BASELINE_FULL_BYTES, lines: BASELINE_FULL_LINES, tokens: approxTokens("x".repeat(BASELINE_FULL_BYTES)), live: false };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const skillPath = join(here, SKILL_REL);
  let skillText;
  try {
    skillText = await readFile(skillPath, "utf8");
  } catch (error) {
    console.error(`error: could not read skill at ${skillPath}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  const skill = {
    bytes: Buffer.byteLength(skillText, "utf8"),
    lines: skillText.split("\n").length,
    words: skillText.trim().split(/\s+/).length,
    tokens: approxTokens(skillText),
  };
  const full = measureFullGuide();
  const ratio = full.bytes > 0 ? skill.bytes / full.bytes : 0;
  const ok = skill.bytes <= opts.maxBytes && skill.tokens <= opts.maxTokens;
  const report = {
    ok,
    skill: { path: SKILL_REL, ...skill, maxBytes: opts.maxBytes, maxTokens: opts.maxTokens },
    fullGuide: { bytes: full.bytes, lines: full.lines, tokens: full.tokens, live: full.live, baselineBytes: BASELINE_FULL_BYTES },
    ratio: Number(ratio.toFixed(3)),
    summary: `skill ${skill.bytes} bytes (~${skill.tokens} tokens, ${skill.lines} lines) vs full guide ${full.bytes} bytes (~${full.tokens} tokens) — ${(ratio * 100).toFixed(1)}%${full.live ? "" : " (baseline; orca unavailable)"}`,
  };
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(report.summary);
    console.log(`budget: <= ${opts.maxBytes} bytes, <= ${opts.maxTokens} tokens — ${ok ? "PASS" : "FAIL"}`);
    if (!ok) {
      if (skill.bytes > opts.maxBytes) console.log(`  over bytes budget by ${skill.bytes - opts.maxBytes}`);
      if (skill.tokens > opts.maxTokens) console.log(`  over tokens budget by ${skill.tokens - opts.maxTokens}`);
    }
  }
  process.exit(ok ? 0 : 1);
}

await main();

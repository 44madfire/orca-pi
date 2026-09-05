#!/usr/bin/env node
/*global console, process, setTimeout*/
/**
 * Live capture for SNC1.1 fixtures (run manually, not in CI).
 *
 *   node packages/pi-rpc/spike/capture.mjs --offline-only
 *   node packages/pi-rpc/spike/capture.mjs --full
 *
 * Drives a real `pi --mode rpc` binary through the strict spike client
 * (`../dist/spike-client.js`), normalizes each scenario with a fresh
 * `createRecordNormalizer()` (identity-preserving aliases), and rewrites
 * `../fixtures/*.jsonl` + `../fixtures/baseline.json` LF-only.
 *
 * - `--offline-only`: no LLM calls. Captures startup-idle, bash-rpc,
 *   models-thinking, malformed-exit, plus baseline skeleton. Safe anywhere.
 * - `--full`: also captures LLM turns (text, thinking, tools, abort/queue,
 *   state-tree text turn, images, extension UI incl. input/editor, resume).
 *   Needs provider auth + network; uses opencode-go/glm-5.3-flash, low
 *   thinking (high for the thinking probe), short constrained prompts.
 *
 * Always uses an isolated PI_CODING_AGENT_DIR (auth copied, settings
 * minimal) so global user settings are never mutated.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SpikeClient, createRecordNormalizer } from "../dist/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const fixturesDir = path.join(pkgRoot, "fixtures");
const full = process.argv.includes("--full");
const onlyIdx = process.argv.indexOf("--only");
const only = onlyIdx !== -1 ? process.argv[onlyIdx + 1] : null;
function enabled(name) {
  return only === null || only === name;
}
// Prefer `pi` on PATH; fall back to the local npm bundle path (Windows dev box).
const PI_BUNDLE = "C:/Users/jeffr/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";
const USE_BUNDLE = fs.existsSync(PI_BUNDLE);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isolatedEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rpc-capture-"));
  const agentDir = path.join(tmp, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  const home = path.join(os.homedir(), ".pi", "agent");
  for (const f of ["auth.json", "models-store.json"]) {
    try {
      fs.copyFileSync(path.join(home, f), path.join(agentDir, f));
    } catch {
      // Offline-only captures do not need auth.
    }
  }
  fs.writeFileSync(
    path.join(agentDir, "settings.json"),
    JSON.stringify({ defaultProvider: "opencode-go", defaultModel: "muse-spark-1.3-contributor" }),
  );
  return { tmp, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } };
}

function writeFixture(name, records, normalizer) {
  const lines = records.map((r) => JSON.stringify({ v: 1, dir: r.dir, payload: normalizer.normalize(r.payload) }));
  fs.writeFileSync(path.join(fixturesDir, name), lines.join("\n") + "\n", { encoding: "utf8", flag: "w" });
  const s2c = records.filter((r) => r.dir === "s2c").length;
  console.log(`wrote ${name}: ${records.length} records (${s2c} s2c)`);
}

async function runSession(piArgs, env, script) {
  const client = USE_BUNDLE
    ? new SpikeClient({ piCommand: process.execPath, piArgs: [PI_BUNDLE, ...piArgs], env })
    : new SpikeClient({ piCommand: "pi", piArgs, env });
  await client.start();
  await sleep(2500);
  try {
    await script(client);
  } finally {
    await client.close(2000);
  }
  return client.records;
}

async function autoRespondDialogs(client, seen, respond) {
  for (const r of client.records) {
    if (r.dir !== "s2c" || seen.has(r.seq)) continue;
    seen.add(r.seq);
    const p = r.payload;
    if (p && p.type === "extension_ui_request" && typeof p.id === "string" && typeof p.method === "string") {
      const reply = respond(p);
      if (reply) client.send(reply);
    }
  }
}

async function waitSettledWithDialogs(client, respond, timeoutMs = 90000) {
  const seen = new Set();
  const t0 = Date.now();
  const startSettled = client.countByType("agent_settled");
  while (Date.now() - t0 < timeoutMs) {
    await autoRespondDialogs(client, seen, respond);
    if (client.countByType("agent_settled") > startSettled) return;
    await sleep(400);
  }
  throw new Error("timed out waiting for agent_settled");
}

function dialogResponder(p) {
  if (p.method === "select") {
    if (p.title === "Pick one") return { type: "extension_ui_response", id: p.id, cancelled: true };
    return { type: "extension_ui_response", id: p.id, value: p.options?.[0] ?? "Apple" };
  }
  if (p.method === "confirm") return { type: "extension_ui_response", id: p.id, confirmed: true };
  if (p.method === "input") return { type: "extension_ui_response", id: p.id, value: "orca-nick" };
  if (p.method === "editor") return { type: "extension_ui_response", id: p.id, value: "edited-a\nedited-b\nedited-c" };
  return null;
}

function piVersion() {
  return new Promise((resolve) => {
    const cmd = USE_BUNDLE ? process.execPath : "pi";
    const args = USE_BUNDLE ? [PI_BUNDLE, "--version"] : ["--version"];
    execFile(cmd, args, { timeout: 15000 }, (_e, stdout, stderr) => {
      const out = `${stdout}\n${stderr}`;
      resolve(/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(out)?.[1] ?? out.trim());
    });
  });
}

async function main() {
  console.log(`capture --full=${full}`);
  const { tmp, env } = isolatedEnv();
  console.log(`isolated agent dir under ${tmp}`);
  try {
    // ---- startup-idle (no LLM) ----
    if (enabled("startup-idle")) {
      const records = await runSession(["--no-session", "--offline"], env, async (c) => {
        for (const cmd of [
          { id: "s1", type: "get_state" },
          { id: "s2", type: "get_entries" },
          { id: "s3", type: "get_tree" },
          { id: "s4", type: "get_session_stats" },
          { id: "s5", type: "get_messages" },
          { id: "s6", type: "get_available_thinking_levels" },
          { id: "s7", type: "get_last_assistant_text" },
          { id: "s8", type: "get_fork_messages" },
        ]) {
          await c.waitResponse(cmd, { timeoutMs: 15000 });
          await sleep(250);
        }
      });
      writeFixture("startup-idle.jsonl", records, createRecordNormalizer());
    }

    // ---- bash-rpc incl. U+2028/U+2029 (no LLM) ----
    if (enabled("bash-rpc")) {
      const records = await runSession(["--no-session", "--offline"], env, async (c) => {
        await c.waitResponse({ id: "u1", type: "bash", command: "echo hello-pi-rpc" }, { timeoutMs: 15000 });
        await sleep(300);
        await c.waitResponse(
          { id: "u2", type: "bash", command: "node -p \"'A' + String.fromCharCode(8232) + 'B' + String.fromCharCode(8233) + 'C'\"" },
          { timeoutMs: 15000 },
        );
        await sleep(300);
        await c.waitResponse({ id: "u3", type: "get_messages" }, { timeoutMs: 15000 });
      });
      writeFixture("bash-rpc.jsonl", records, createRecordNormalizer());
    }

    // ---- models-thinking + queue modes (no LLM) ----
    if (enabled("models-thinking")) {
      const records = await runSession(["--no-session", "--provider", "opencode-go", "--model", "glm-5.3-flash"], env, async (c) => {
        await c.waitResponse({ id: "m1", type: "get_available_models" }, { timeoutMs: 20000 });
        await c.waitResponse({ id: "m2", type: "set_model", provider: "opencode-go", modelId: "glm-5.3-flash" }, { timeoutMs: 20000 });
        await c.waitResponse({ id: "m3", type: "set_model", provider: "nope", modelId: "nope" }, { timeoutMs: 20000 });
        await c.waitResponse({ id: "m4", type: "get_available_thinking_levels" }, { timeoutMs: 15000 });
        await c.waitResponse({ id: "m5", type: "set_thinking_level", level: "low" }, { timeoutMs: 15000 });
        await sleep(300);
        await c.waitResponse({ id: "m6", type: "cycle_thinking_level" }, { timeoutMs: 15000 });
        await sleep(300);
        await c.waitResponse({ id: "m7", type: "set_steering_mode", mode: "all" }, { timeoutMs: 15000 });
        await c.waitResponse({ id: "m8", type: "set_follow_up_mode", mode: "all" }, { timeoutMs: 15000 });
        await c.waitResponse({ id: "m9", type: "set_auto_compaction", enabled: false }, { timeoutMs: 15000 });
        await c.waitResponse({ id: "m10", type: "set_auto_retry", enabled: false }, { timeoutMs: 15000 });
        await c.waitResponse({ id: "m11", type: "abort" }, { timeoutMs: 15000 });
        await c.waitResponse({ id: "m12", type: "abort_bash" }, { timeoutMs: 15000 });
        await c.waitResponse({ id: "m13", type: "abort_retry" }, { timeoutMs: 15000 });
        await c.waitResponse({ id: "m14", type: "set_thinking_level", level: "bogus-level" }, { timeoutMs: 15000 });
      });
      writeFixture("models-thinking.jsonl", records, createRecordNormalizer());
    }

    // ---- malformed + exit notes (no LLM) ----
    if (enabled("malformed-exit")) {
      const records = await runSession(["--no-session", "--offline"], env, async (c) => {
        c.sendRaw("not-json\n");
        await sleep(600);
        await c.waitResponse({ id: "x1", type: "unknown_cmd_xyz" }, { timeoutMs: 15000 });
        await c.waitResponse({ id: "x2", type: "set_model", provider: "nope", modelId: "nope" }, { timeoutMs: 15000 });
        await c.waitResponse({ id: "x3", type: "fork", entryId: "does-not-exist" }, { timeoutMs: 15000 });
        await c.waitResponse({ id: "x4", type: "get_entries", since: "missing" }, { timeoutMs: 15000 });
        await c.waitResponse({ id: "x6", type: "switch_session", sessionPath: "/nonexistent/path.jsonl" }, { timeoutMs: 15000 });
        await c.waitResponse({ id: "x7", type: "compact" }, { timeoutMs: 30000 });
        await sleep(500);
        await c.waitResponse({ id: "x8", type: "export_html", outputPath: `${tmp}/probe.html` }, { timeoutMs: 15000 });
        await c.waitResponse({ id: "x9", type: "get_state" }, { timeoutMs: 15000 });
      });
      // Append prompt-while-streaming rejection + exit notes (streaming case
      // needs an LLM turn; rejection text verified live — see contract doc).
      records.push({ seq: records.length, dir: "sys", payload: { event: "stdin-eof", result: "process exits 0" } });
      records.push({ seq: records.length, dir: "sys", payload: { event: "process-exit", code: 0, signal: null, note: "Closing stdin (EOF) exits cleanly 0; SIGTERM fallback kills when EOF is ignored." } });
      writeFixture("malformed-exit.jsonl", records, createRecordNormalizer());
    }

    // ---- baseline.json ----
    if (enabled("baseline")) {
      const version = await piVersion();
      let models = [];
      let thinkingLevels = [];
      try {
        const recs = await runSession(["--no-session", "--provider", "opencode-go", "--model", "glm-5.3-flash"], env, async (c) => {
          const m = await c.waitResponse({ id: "b1", type: "get_available_models" }, { timeoutMs: 20000 });
          models = m.data?.models ?? [];
          const t = await c.waitResponse({ id: "b2", type: "get_available_thinking_levels" }, { timeoutMs: 15000 });
          thinkingLevels = t.data?.levels ?? [];
        });
        void recs;
      } catch (e) {
        console.log(`baseline catalog unavailable: ${e.message}`);
      }
      const baseline = {
        piVersion: version,
        platform: process.platform,
        nodeVersion: process.version,
        capturedAt: new Date().toISOString(),
        modelCount: models.length,
        models: models.slice(0, 8).map((m) => ({
          provider: m.provider,
          id: m.id,
          reasoning: Boolean(m.reasoning),
          supportsImages: Array.isArray(m.input) && m.input.includes("image"),
        })),
        thinkingLevels,
        framing: "LF-only",
        commandsCovered: ["prompt", "steer", "follow_up", "abort", "clear_queue", "new_session", "get_state", "set_model", "cycle_model", "get_available_models", "set_thinking_level", "cycle_thinking_level", "get_available_thinking_levels", "set_steering_mode", "set_follow_up_mode", "compact", "set_auto_compaction", "set_auto_retry", "abort_retry", "bash", "abort_bash", "get_session_stats", "export_html", "switch_session", "fork", "clone", "get_fork_messages", "get_entries", "get_tree", "get_last_assistant_text", "set_session_name", "get_messages", "get_commands"],
        eventsObserved: ["agent_start", "agent_end", "agent_settled", "turn_start", "turn_end", "message_start", "message_update", "message_end", "bash_execution_update", "tool_execution_start", "tool_execution_update", "tool_execution_end", "queue_update", "compaction_start", "compaction_end", "thinking_level_changed", "session_info_changed", "extension_ui_request"],
        notes: "No secrets: model costs/urls/tokens omitted. Full command/event semantics in docs/pi-rpc-contract.md.",
      };
      fs.writeFileSync(path.join(fixturesDir, "baseline.json"), JSON.stringify(baseline, null, 2) + "\n");
      console.log(`wrote baseline.json: pi ${version}, ${models.length} models`);
    }

    if (!full) {
      console.log("offline-only done. LLM fixtures (text/thinking/tools/abort/state/images/extension-ui/resume) need --full.");
      return;
    }

    const MODEL_ARGS = ["--provider", "opencode-go", "--model", "glm-5.3-flash", "--thinking", "low"];

    // ---- text-streaming ----
    if (enabled("text-streaming")) {
      const records = await runSession(["--no-session", ...MODEL_ARGS], env, async (c) => {
        await c.waitResponse({ id: "p1", type: "prompt", message: "Reply with exactly the 3 words: alpha beta gamma. No tools." }, { timeoutMs: 20000 });
        await waitSettledWithDialogs(c, dialogResponder);
        await c.waitResponse({ id: "p2", type: "get_last_assistant_text" }, { timeoutMs: 15000 });
      });
      writeFixture("text-streaming.jsonl", records, createRecordNormalizer());
    }

    // ---- thinking (high) ----
    if (enabled("thinking")) {
      const records = await runSession(["--no-session", "--provider", "opencode-go", "--model", "glm-5.3-flash", "--thinking", "high"], env, async (c) => {
        await c.waitResponse({ id: "h1", type: "prompt", message: "Think step by step then reply with exactly: done. Keep reasoning brief." }, { timeoutMs: 20000 });
        await waitSettledWithDialogs(c, dialogResponder);
      });
      writeFixture("thinking.jsonl", records, createRecordNormalizer());
    }

    // ---- tool-execution (read + streaming bash) ----
    if (enabled("tool-execution")) {
      const records = await runSession(["--no-session", ...MODEL_ARGS], env, async (c) => {
        await c.waitResponse({ id: "q1", type: "prompt", message: "Use the read tool to read package.json in the current directory and reply with just its name field value. No other tools." }, { timeoutMs: 20000 });
        await waitSettledWithDialogs(c, dialogResponder);
        await c.waitResponse({ id: "q2", type: "prompt", message: "Use the bash tool to run this exact command: echo tick-1; echo tick-2; echo tick-3 and then reply DONE. Only that tool." }, { timeoutMs: 20000 });
        await waitSettledWithDialogs(c, dialogResponder);
      });
      writeFixture("tool-execution.jsonl", records, createRecordNormalizer());
    }

    // ---- abort-queue ----
    if (enabled("abort-queue")) {
      const records = await runSession(["--no-session", ...MODEL_ARGS], env, async (c) => {
        await c.waitResponse({ id: "ab1", type: "prompt", message: "Write a 100-word essay about the history of JSON Lines. Do not use tools." }, { timeoutMs: 20000 });
        // Abort as soon as the first streamed delta arrives: deterministic
        // mid-stream abort with a small fixture regardless of model speed.
        const t0 = Date.now();
        for (;;) {
          const streaming = c.records.some((r) => r.dir === "s2c" && r.payload?.type === "message_update");
          if (streaming || Date.now() - t0 > 25000) break;
          await sleep(150);
        }
        await c.waitResponse({ id: "ab2", type: "abort" }, { timeoutMs: 30000 });
        await sleep(1500);
        await c.waitResponse({ id: "ab3", type: "steer", message: "idle steer" }, { timeoutMs: 15000 });
        await c.waitResponse({ id: "ab4", type: "follow_up", message: "idle followup" }, { timeoutMs: 15000 });
        await c.waitResponse({ id: "ab5", type: "clear_queue" }, { timeoutMs: 15000 });
        await c.waitResponse({ id: "ab6", type: "prompt", message: "Queued via steer behavior", streamingBehavior: "steer" }, { timeoutMs: 20000 });
        await waitSettledWithDialogs(c, dialogResponder);
      });
      writeFixture("abort-queue.jsonl", records, createRecordNormalizer());
    }

    // ---- state-tree (one text turn, then state reads — one coherent session) ----
    if (enabled("state-tree")) {
      const records = await runSession(["--no-session", ...MODEL_ARGS], env, async (c) => {
        await c.waitResponse({ id: "st0", type: "prompt", message: "Say IDLE-OK" }, { timeoutMs: 20000 });
        await waitSettledWithDialogs(c, dialogResponder);
        await c.waitResponse({ id: "st1", type: "set_session_name", name: "snc1-probe" }, { timeoutMs: 15000 });
        await sleep(300);
        await c.waitResponse({ id: "st2", type: "get_state" }, { timeoutMs: 15000 });
        const entriesRes = await c.waitResponse({ id: "st3", type: "get_entries" }, { timeoutMs: 15000 });
        const entries = entriesRes.data?.entries ?? [];
        const userEntry = entries.find((e) => e.message?.role === "user");
        if (userEntry) await c.waitResponse({ id: "st4", type: "get_entries", since: userEntry.id }, { timeoutMs: 15000 });
        await c.waitResponse({ id: "st5", type: "get_tree" }, { timeoutMs: 15000 });
        await c.waitResponse({ id: "st6", type: "get_fork_messages" }, { timeoutMs: 15000 });
        await c.waitResponse({ id: "st7", type: "get_last_assistant_text" }, { timeoutMs: 15000 });
        await c.waitResponse({ id: "st8", type: "get_session_stats" }, { timeoutMs: 15000 });
        await c.waitResponse({ id: "st9", type: "get_messages" }, { timeoutMs: 15000 });
      });
      writeFixture("state-tree.jsonl", records, createRecordNormalizer());
    }

    // ---- images ----
    if (enabled("images")) {
      const png1px = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
      const records = await runSession(["--no-session", ...MODEL_ARGS], env, async (c) => {
        await c.waitResponse({ id: "i1", type: "prompt", message: "What is in this image? Reply with exactly: ONE-PIXEL.", images: [{ type: "image", data: png1px, mimeType: "image/png" }] }, { timeoutMs: 20000 });
        await waitSettledWithDialogs(c, dialogResponder);
        await c.waitResponse({ id: "i2", type: "get_entries" }, { timeoutMs: 15000 });
      });
      writeFixture("images.jsonl", records, createRecordNormalizer());
    }

    // ---- extension-ui (select/confirm/input/editor/cancel + fire-and-forget) ----
    if (enabled("extension-ui")) {
      const extCode = [
        "export default function(pi) {",
        "  pi.registerCommand(\"rpc-ask\", { description: \"Trigger select dialog\", handler: async (_a, ctx) => { const v = await ctx.ui.select(\"Pick a fruit\", [\"Apple\", \"Banana\"]); ctx.ui.notify(\"Chose: \" + v, \"info\"); } });",
        "  pi.registerCommand(\"rpc-confirm\", { description: \"Trigger confirm\", handler: async (_a, ctx) => { const v = await ctx.ui.confirm(\"Proceed?\", \"Are you sure?\"); ctx.ui.notify(\"Confirmed: \" + v, \"info\"); } });",
        "  pi.registerCommand(\"rpc-input\", { description: \"Trigger input dialog\", handler: async (_a, ctx) => { const v = await ctx.ui.input(\"Enter a nickname\", \"e.g. orca\"); ctx.ui.notify(\"Input got: \" + v, \"info\"); } });",
        "  pi.registerCommand(\"rpc-editor\", { description: \"Trigger editor dialog\", handler: async (_a, ctx) => { const v = await ctx.ui.editor(\"Edit notes\", \"line one\\nline two\"); ctx.ui.notify(\"Editor lines: \" + (v ? v.split(\"\\n\").length : 0), \"info\"); } });",
        "  pi.registerCommand(\"rpc-cancel\", { description: \"Trigger cancelled select\", handler: async (_a, ctx) => { const v = await ctx.ui.select(\"Pick one\", [\"A\", \"B\"]); ctx.ui.notify(\"Select got: \" + v, \"info\"); } });",
        "}",
        "",
      ].join("\n");
      const extPath = path.join(tmp, "rpc-dialog-ext.mjs");
      fs.writeFileSync(extPath, extCode);
      const records = await runSession(["--no-session", ...MODEL_ARGS, "--extension", extPath], env, async (c) => {
        await c.waitResponse({ id: "e1", type: "get_commands" }, { timeoutMs: 15000 });
        const seenExt = new Set();
        for (const [id, msg] of [["e2", "/rpc-ask"], ["e3", "/rpc-confirm"], ["e4", "/rpc-input"], ["e5", "/rpc-editor"], ["e6", "/rpc-cancel"]]) {
          c.send({ id, type: "prompt", message: msg });
          const t0 = Date.now();
          for (;;) {
            await autoRespondDialogs(c, seenExt, dialogResponder);
            const done = [...c.records].reverse().find((r) => r.dir === "s2c" && r.payload?.type === "response" && r.payload?.id === id);
            if (done || Date.now() - t0 > 25000) break;
            await sleep(300);
          }
          await sleep(400);
        }
        await c.waitResponse({ id: "e7", type: "get_entries" }, { timeoutMs: 15000 });
      });
      writeFixture("extension-ui.jsonl", records, createRecordNormalizer());
    }

    // ---- resume-branch (session dir, switch resume, fork, clone, new_session) ----
    if (enabled("resume-branch")) {
      const sessionDir = path.join(tmp, "sessions");
      fs.mkdirSync(sessionDir, { recursive: true });
      let sessionFile = null;
      const records = await runSession([...MODEL_ARGS, "--session-dir", sessionDir], env, async (c) => {
        await c.waitResponse({ id: "r0", type: "prompt", message: "Say FIRST." }, { timeoutMs: 20000 });
        await waitSettledWithDialogs(c, dialogResponder);
        const st = await c.waitResponse({ id: "r1", type: "get_state" }, { timeoutMs: 15000 });
        sessionFile = st.data?.sessionFile ?? null;
        await c.waitResponse({ id: "r2", type: "get_entries" }, { timeoutMs: 15000 });
      });
      if (sessionFile) {
        const records2 = await runSession(["--no-session", "--offline"], env, async (c) => {
          await c.waitResponse({ id: "r3", type: "switch_session", sessionPath: sessionFile }, { timeoutMs: 15000 });
          await c.waitResponse({ id: "r4", type: "get_entries" }, { timeoutMs: 15000 });
          await c.waitResponse({ id: "r5", type: "get_last_assistant_text" }, { timeoutMs: 15000 });
          const fm = await c.waitResponse({ id: "r6", type: "get_fork_messages" }, { timeoutMs: 15000 });
          const first = fm.data?.messages?.[0];
          if (first) await c.waitResponse({ id: "r7", type: "fork", entryId: first.entryId }, { timeoutMs: 20000 });
          await c.waitResponse({ id: "r8", type: "get_entries" }, { timeoutMs: 15000 });
          await c.waitResponse({ id: "r9", type: "get_tree" }, { timeoutMs: 15000 });
          await c.waitResponse({ id: "r10", type: "get_state" }, { timeoutMs: 15000 });
          await c.waitResponse({ id: "r11", type: "clone" }, { timeoutMs: 15000 });
          await c.waitResponse({ id: "r12", type: "new_session" }, { timeoutMs: 15000 });
          await c.waitResponse({ id: "r13", type: "get_state" }, { timeoutMs: 15000 });
        });
        records.push({ seq: records.length, dir: "sys", payload: { event: "restart-process-for-resume" } });
        for (const r of records2) records.push({ seq: records.length, dir: r.dir, payload: r.payload });
      }
      writeFixture("resume-branch.jsonl", records, createRecordNormalizer());
    }

    console.log("full capture done.");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

await main();

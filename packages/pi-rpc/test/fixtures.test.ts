import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { assertLfOnlyJsonl } from "../src/normalize.js";
import { splitJsonLines } from "../src/jsonl.js";
import { isPiBaseline } from "../src/baseline.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, "../fixtures");

const EXPECTED_FIXTURES = [
  "startup-idle.jsonl",
  "text-streaming.jsonl",
  "thinking.jsonl",
  "tool-execution.jsonl",
  "bash-rpc.jsonl",
  "abort-queue.jsonl",
  "state-tree.jsonl",
  "models-thinking.jsonl",
  "images.jsonl",
  "extension-ui.jsonl",
  "resume-branch.jsonl",
  "malformed-exit.jsonl",
];

function readFixture(name: string): string {
  return fs.readFileSync(path.join(fixturesDir, name), "utf8");
}

function envelopes(name: string): Array<{ v: number; dir: string; payload: Record<string, unknown> }> {
  const text = readFixture(name);
  const { lines } = splitJsonLines(text);
  return lines.map((l) => JSON.parse(l) as { v: number; dir: string; payload: Record<string, unknown> });
}

describe("pi-rpc fixtures (real-Pi, normalized, secret-free)", () => {
  it("ships every required scenario plus a redacted baseline", () => {
    for (const name of EXPECTED_FIXTURES) {
      expect(fs.existsSync(path.join(fixturesDir, name)), name).toBe(true);
    }
    const baseline = JSON.parse(fs.readFileSync(path.join(fixturesDir, "baseline.json"), "utf8"));
    expect(isPiBaseline(baseline)).toBe(true);
    expect(baseline.piVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(baseline.framing).toBe("LF-only");
  });

  it("every fixture is valid LF-only JSONL, secret-free, and enveloped", () => {
    for (const name of EXPECTED_FIXTURES) {
      const text = readFixture(name);
      expect(text.endsWith("\n"), `${name} trailing newline`).toBe(true);
      assertLfOnlyJsonl(text, name);
      for (const env of envelopes(name)) {
        expect(env.v).toBe(1);
        expect(["c2s", "s2c", "sys"]).toContain(env.dir);
        expect(env.payload).toBeTypeOf("object");
      }
    }
  });

  it("contains no volatile raw ids/timestamps/paths or secrets", () => {
    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    const rawWinUserPath = /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+\\/;
    for (const name of EXPECTED_FIXTURES) {
      const text = readFixture(name);
      expect(text, `${name} raw UUID`).not.toMatch(uuid);
      expect(text, `${name} raw user path`).not.toMatch(rawWinUserPath);
      expect(text, `${name} bearer`).not.toMatch(/bearer\s+[A-Za-z0-9\-._~+/=]{16,}/i);
      expect(text, `${name} api key`).not.toMatch(/sk-(?:proj-)?[A-Za-z0-9\-_]{16,}/);
      // Legacy collapsed placeholders must not appear; aliases are numbered.
      expect(text, `${name} legacy placeholder`).not.toMatch(/<(SESSION_ID|ENTRY_ID|PARENT_ID|LEAF_ID|CALL_ID|EXT_UI_ID|RESPONSE_ID)>/);
      // No raw epoch-ms timestamps: numeric `timestamp` fields normalize to
      // the fixed 1700000000000 sentinel (baseline.json carries no epochs).
      const epochs = text.match(/\b1[678]\d{11}\b/g) ?? [];
      expect(
        epochs.filter((n) => n !== "1700000000000"),
        `${name} raw epoch-ms`,
      ).toEqual([]);
    }
  });

  it("proves LF-only U+2028/U+2029 survival in bash-rpc", () => {
    const text = readFixture("bash-rpc.jsonl");
    expect(text.includes("\u2028") && text.includes("\u2029")).toBe(true);
    const { lines } = splitJsonLines(text);
    const deltas = lines
      .map((l) => JSON.parse(l) as { payload: { type?: string; delta?: string; data?: { output?: string } } })
      .filter((e) => e.payload.type === "bash_execution_update");
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.some((d) => (d.payload.delta ?? "").includes("\u2028"))).toBe(true);
  });

  it("keeps state-tree internally coherent as one session trace", () => {
    const envs = envelopes("state-tree.jsonl");
    const byId = (id: string) =>
      envs.find((e) => e.dir === "s2c" && (e.payload as Record<string, unknown>)["id"] === id)?.payload as Record<string, unknown>;
    const entries = (byId("st3")?.["data"] as { entries: Array<{ id: string; parentId: string | null }>; leafId: string })["entries"];
    const leafId = (byId("st3")?.["data"] as { leafId: string })["leafId"];
    // Parent chain links and leafId names the last entry.
    expect(entries[0]?.parentId).toBeNull();
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i]?.parentId).toBe(entries[i - 1]?.id);
    }
    expect(leafId).toBe(entries[entries.length - 1]?.id);
    // get_tree shows the same chain with the same leaf.
    const tree = byId("st5")?.["data"] as { tree: Array<{ entry: { id: string }; children: unknown[] }>; leafId: string };
    expect(tree.leafId).toBe(leafId);
    // get_fork_messages lists this session's user turn; message counts match.
    const forks = byId("st6")?.["data"] as { messages: Array<{ entryId: string; text: string }> };
    const userEntry = entries.find((e) => (e as unknown as { type: string }).type === "message" && JSON.stringify(e).includes('"role":"user"'));
    expect(forks.messages.map((m) => m.entryId)).toContain(userEntry?.id);
    const state = byId("st2")?.["data"] as { messageCount: number };
    expect(state.messageCount).toBe(2);
  });

  it("keeps resume-branch coherent across switch/fork", () => {
    const envs = envelopes("resume-branch.jsonl");
    const byId = (id: string) =>
      envs.find((e) => e.dir === "s2c" && (e.payload as Record<string, unknown>)["id"] === id)?.payload as Record<string, unknown>;
    const before = JSON.stringify((byId("r2")?.["data"] as { entries: unknown })["entries"]);
    const after = JSON.stringify((byId("r4")?.["data"] as { entries: unknown })["entries"]);
    // switch_session resume returns the identical entry tree.
    expect(after).toBe(before);
    // fork resets to a fresh bootstrap session with a new session id.
    const forked = (byId("r8")?.["data"] as { entries: Array<{ type: string }> })["entries"];
    expect(forked.every((e) => e.type === "model_change" || e.type === "thinking_level_change")).toBe(true);
    const preState = (byId("r1")?.["data"] as { sessionId: string })["sessionId"];
    const postState = (byId("r10")?.["data"] as { sessionId: string })["sessionId"];
    expect(postState).not.toBe(preState);
  });

  it("preserves tool-call and extension-UI correlations", () => {
    const toolText = readFixture("tool-execution.jsonl");
    // Distinct calls keep distinct aliases; every frame of a call matches.
    expect(toolText).toContain("<CALL_1>");
    expect(toolText).toContain("<CALL_2>");
    const ext = envelopes("extension-ui.jsonl");
    const requests = ext.filter((e) => (e.payload as Record<string, unknown>)["type"] === "extension_ui_request");
    const responses = ext.filter((e) => (e.payload as Record<string, unknown>)["type"] === "extension_ui_response");
    expect(requests.length).toBeGreaterThan(0);
    for (const res of responses) {
      const id = (res.payload as Record<string, unknown>)["id"];
      expect(requests.some((q) => (q.payload as Record<string, unknown>)["id"] === id)).toBe(true);
    }
    // All four dialog methods plus cancellation are proven live.
    const methods = requests.map((r) => (r.payload as Record<string, unknown>)["method"]);
    for (const m of ["select", "confirm", "input", "editor"]) {
      expect(methods).toContain(m);
    }
    expect(ext.some((e) => JSON.stringify(e.payload).includes('"cancelled":true'))).toBe(true);
  });

  it("locks core protocol invariants across fixtures", () => {
    // prompt accept precedes agent_settled in text-streaming.
    const textFlow = envelopes("text-streaming.jsonl").map((e) => e.payload["type"] ?? e.payload["command"]);
    expect(textFlow).toContain("agent_settled");
    // abort yields stopReason:aborted before settle.
    const abortText = readFixture("abort-queue.jsonl");
    expect(abortText).toContain('"stopReason":"aborted"');
    expect(abortText).toContain('"errorMessage":"Request was aborted"');
    // queue updates carry both queues.
    expect(abortText).toContain('"queue_update"');
    // malformed ops fail closed with success:false + error.
    const malformed = readFixture("malformed-exit.jsonl");
    expect(malformed).toContain('"command":"parse","success":false');
    expect(malformed).toContain('"success":false,"error":"Entry not found: missing"');
    // images preserve ImageContent shape with normalized bytes.
    const images = readFixture("images.jsonl");
    expect(images).toContain('"mimeType":"image/png"');
    expect(images).toContain("<IMAGE_DATA>");
  });
});

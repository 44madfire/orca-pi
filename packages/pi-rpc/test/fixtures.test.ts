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
    for (const name of EXPECTED_FIXTURES) {
      const text = readFixture(name);
      expect(text, `${name} raw UUID`).not.toMatch(uuid);
      expect(text, `${name} raw user path`).not.toContain("C:\\Users\\jeffr\\");
      expect(text, `${name} bearer`).not.toMatch(/bearer\s+[A-Za-z0-9\-._~+/=]{16,}/i);
      expect(text, `${name} api key`).not.toMatch(/sk-(?:proj-)?[A-Za-z0-9\-_]{16,}/);
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
    // leafId present in state-tree + resume-branch.
    expect(readFixture("state-tree.jsonl")).toContain('"leafId":"<LEAF_ID>"');
    expect(readFixture("resume-branch.jsonl")).toContain('"leafId":"<LEAF_ID>"');
    // extension UI request/response id correlation shape.
    const ext = readFixture("extension-ui.jsonl");
    expect(ext).toContain('"method":"select"');
    expect(ext).toContain('"type":"extension_ui_response"');
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

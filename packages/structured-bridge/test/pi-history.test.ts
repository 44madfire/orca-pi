/**
 * Pi history reconstruction tests (SNC1.7, #17).
 *
 * Pins the pure, fixture-testable `pi-history.ts` contract without Orca or Pi:
 * - active-branch extraction (root → leaf, abandoned siblings excluded);
 * - `get_tree` fallback converges on the same branch;
 * - historical translation converges with live SNC1.5 semantics (user/text →
 *   user/assistant, thinking never prose, tool results → tool, image bytes
 *   never journaled, tool-only assistants journal no assistant);
 * - bounded policy for compaction/summary/custom/unknown (skipped, never
 *   terminating);
 * - partial/aborted recovery (trailing user stays lone user; aborted text kept);
 * - fail-closed diagnostics (empty, leaf-missing, broken chain, cycle).
 */

import { describe, expect, it } from "vitest";
import {
  extractActiveBranch,
  extractActiveBranchFromTree,
  extractPiTextContent,
  translatePiBranchToBridgeHistory,
  translatePiEntryToBridgeEntries,
} from "../src/pi-history.js";

function msgEntry(id: string, parentId: string | null, role: string, content: unknown, extra: Record<string, unknown> = {}) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role, content, timestamp: 1700000000000 },
    ...extra,
  };
}

describe("extractActiveBranch (get_entries + leafId)", () => {
  it("walks root → leaf, excluding abandoned siblings", () => {
    // Linear chain with a fork sibling (abandoned): e3 branches to e4a
    // (abandoned) and e4b (active leaf). Only e4b's chain survives.
    const entries = [
      { type: "model_change", id: "e1", parentId: null },
      { type: "thinking_level_change", id: "e2", parentId: "e1" },
      msgEntry("e3", "e2", "user", [{ type: "text", text: "first" }]),
      msgEntry("e4a", "e3", "assistant", [{ type: "text", text: "abandoned" }]),
      msgEntry("e4b", "e3", "assistant", [{ type: "text", text: "active" }]),
    ];
    const res = extractActiveBranch(entries, "e4b");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.branch.map((e) => e.id)).toEqual(["e1", "e2", "e3", "e4b"]);
    // Abandoned sibling excluded.
    expect(res.branch.some((e) => e.id === "e4a")).toBe(false);
  });

  it("fails closed on empty, leaf-missing, broken chain, and cycle", () => {
    expect(extractActiveBranch([], "e1").ok).toBe(false);
    expect(extractActiveBranch([{ type: "model_change", id: "e1", parentId: null }], "").ok).toBe(false);
    expect(
      extractActiveBranch([{ type: "model_change", id: "e1", parentId: null }], "missing").ok,
    ).toBe(false);
    // Broken parent link.
    expect(
      extractActiveBranch(
        [
          { type: "model_change", id: "e1", parentId: null },
          msgEntry("e2", "nope", "user", [{ type: "text", text: "x" }]),
        ],
        "e2",
      ).ok,
    ).toBe(false);
    // Cycle.
    expect(
      extractActiveBranch(
        [
          { type: "model_change", id: "e1", parentId: "e2" },
          msgEntry("e2", "e1", "user", [{ type: "text", text: "x" }]),
        ],
        "e2",
      ).ok,
    ).toBe(false);
  });
});

describe("extractActiveBranchFromTree converges with flat entries", () => {
  it("flattens nested tree to the same leaf chain", () => {
    const tree = [
      {
        entry: { type: "model_change", id: "e1", parentId: null },
        children: [
          {
            entry: { type: "thinking_level_change", id: "e2", parentId: "e1" },
            children: [
              {
                entry: msgEntry("e3", "e2", "user", [{ type: "text", text: "hi" }]),
                children: [
                  {
                    entry: msgEntry("e4", "e3", "assistant", [{ type: "text", text: "hello" }]),
                    children: [],
                  },
                ],
              },
            ],
          },
        ],
      },
    ];
    const res = extractActiveBranchFromTree(tree, "e4");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.branch.map((e) => e.id)).toEqual(["e1", "e2", "e3", "e4"]);
  });
});

describe("translatePiEntryToBridgeEntries converges with live SNC1.5", () => {
  it("maps user text (images dropped, bytes never journaled)", () => {
    const rows = translatePiEntryToBridgeEntries(
      msgEntry("u1", "e2", "user", [
        { type: "text", text: "look " },
        { type: "image", data: "AAA", mimeType: "image/png" },
        { type: "text", text: "here" },
      ]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "u1", parentId: "e2", role: "user", text: "look here" });
    expect(JSON.stringify(rows)).not.toContain("AAA");
  });

  it("maps assistant text, drops thinking, skips tool-only assistants", () => {
    const withThinking = translatePiEntryToBridgeEntries(
      msgEntry("a1", "u1", "assistant", [
        { type: "thinking", thinking: "secret reasoning" },
        { type: "text", text: "done." },
      ]),
    );
    expect(withThinking).toHaveLength(1);
    expect(withThinking[0]).toMatchObject({ role: "assistant", text: "done." });
    expect(JSON.stringify(withThinking)).not.toContain("secret reasoning");

    const toolOnly = translatePiEntryToBridgeEntries(
      msgEntry("a2", "u1", "assistant", [{ type: "toolCall", id: "c1", name: "read", arguments: {} }]),
    );
    expect(toolOnly).toHaveLength(0);
  });

  it("maps toolResult and bashExecution to tool (never assistant prose)", () => {
    const tool = translatePiEntryToBridgeEntries({
      type: "message",
      id: "t1",
      parentId: "a1",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "read",
        content: [{ type: "text", text: "file-bytes" }],
        isError: false,
        timestamp: 1700000000000,
      },
    });
    expect(tool).toHaveLength(1);
    expect(tool[0]).toMatchObject({ role: "tool", text: "file-bytes" });

    const bash = translatePiEntryToBridgeEntries({
      type: "message",
      id: "b1",
      parentId: "t1",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "bashExecution",
        command: "echo hi",
        output: "hi\n",
        exitCode: 0,
        timestamp: 1700000000000,
      },
    });
    expect(bash).toHaveLength(1);
    expect(bash[0]).toMatchObject({ role: "tool", text: "hi\n" });
  });

  it("bounded-skips non-message and unknown roles (never terminates)", () => {
    expect(translatePiEntryToBridgeEntries({ type: "model_change", id: "e1", parentId: null })).toEqual([]);
    expect(translatePiEntryToBridgeEntries({ type: "thinking_level_change", id: "e2", parentId: "e1" })).toEqual([]);
    expect(translatePiEntryToBridgeEntries({ type: "session_info", id: "e5", parentId: "e4" })).toEqual([]);
    expect(translatePiEntryToBridgeEntries({ type: "compaction_summary", id: "c9", parentId: "e4" })).toEqual([]);
    expect(translatePiEntryToBridgeEntries({ type: "custom_future", id: "x1", parentId: "e1" })).toEqual([]);
    expect(translatePiEntryToBridgeEntries(msgEntry("u9", "e1", "future_role_xyz", "hi"))).toEqual([]);
  });
});

describe("translatePiBranchToBridgeHistory recovers partials honestly", () => {
  it("keeps a trailing user without a fabricated assistant", () => {
    const branch = [
      { type: "model_change", id: "e1", parentId: null },
      msgEntry("u1", "e1", "user", [{ type: "text", text: "started then died" }]),
    ];
    const history = translatePiBranchToBridgeHistory(branch);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ role: "user", text: "started then died" });
  });

  it("preserves Pi ids/parents verbatim for handoff metadata", () => {
    const branch = [
      { type: "model_change", id: "e1", parentId: null },
      msgEntry("u1", "e1", "user", [{ type: "text", text: "hi" }]),
      msgEntry("a1", "u1", "assistant", [{ type: "text", text: "hello" }]),
    ];
    const history = translatePiBranchToBridgeHistory(branch);
    expect(history.map((e) => e.id)).toEqual(["u1", "a1"]);
    expect(history[1]?.parentId).toBe("u1");
  });

  it("extractPiTextContent concatenates text blocks only", () => {
    expect(extractPiTextContent([{ type: "text", text: "a" }, { type: "thinking", thinking: "x" }])).toBe("a");
    expect(extractPiTextContent("raw")).toBe("raw");
    expect(extractPiTextContent(undefined)).toBe("");
  });
});

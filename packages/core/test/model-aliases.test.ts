import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import factory, {
  agentDirFromEnv,
  loadModelAliases,
  normalizeAliases,
  resolveAliasTarget,
} from "../../../pi-extensions/model-aliases.js";

/** Minimal model-registry stub shaped like Pi's (provider/id pairs). */
function registry(available: Array<{ provider: string; id: string }>) {
  return {
    getAvailable: () => available.map((m) => ({ ...m })),
  };
}

/** Run `fn` with a temp agent dir holding the given alias map. */
function withAliasMap(map: unknown, fn: () => void): void {
  const dir = mkdtempSync(join(tmpdir(), "ma-factory-"));
  try {
    writeFileSync(join(dir, "model-aliases.json"), JSON.stringify(map));
    const prev = process.env["PI_CODING_AGENT_DIR"];
    process.env["PI_CODING_AGENT_DIR"] = dir;
    try {
      fn();
    } finally {
      if (prev === undefined) delete process.env["PI_CODING_AGENT_DIR"];
      else process.env["PI_CODING_AGENT_DIR"] = prev;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Drive the factory's tool_call handler once; returns the mutated input. */
function fire(
  input: Record<string, unknown>,
  toolName: string,
  ctx: Pick<ExtensionContext, "modelRegistry" | "cwd">,
): Record<string, unknown> {
  const handlers: Array<(e: unknown, c: unknown) => unknown> = [];
  const api = {
    on: vi.fn((_event: string, h: (e: unknown, c: unknown) => unknown) => {
      handlers.push(h);
    }),
  };
  factory(api as never);
  expect(handlers).toHaveLength(1);
  for (const h of handlers) {
    h({ toolName, input }, ctx as unknown as ExtensionContext);
  }
  return input;
}

function ctxFor(available: Array<{ provider: string; id: string }>) {
  return {
    modelRegistry: registry(available),
    cwd: process.cwd(),
  } as unknown as Pick<ExtensionContext, "modelRegistry" | "cwd">;
}

/** Guards the alias wrapper: JSON mapping → subagent param substitution with
 * availability-selected fallbacks. Pure resolution is unit-tested; the
 * factory tests drive the tool_call rewrite end to end. */
describe("model-aliases normalize", () => {
  it("lowercases keys and keeps valid entries", () => {
    expect(normalizeAliases({ aliases: { Fast: { model: "a/b", thinking: "low" } } })).toEqual({
      fast: { model: "a/b", thinking: "low" },
    });
  });

  it("accepts a bare map without the aliases envelope", () => {
    expect(normalizeAliases({ fast: { model: "a/b" } })).toEqual({ fast: { model: "a/b" } });
  });

  it("drops entries without a usable model, keeps entry on bad thinking", () => {
    expect(
      normalizeAliases({ aliases: { ok: { model: "a/b", thinking: "nonsense" }, bad: { thinking: "low" }, bad2: 42 } }),
    ).toEqual({ ok: { model: "a/b" } });
  });

  it("filters fallbacks to non-empty strings, capped at 8", () => {
    const out = normalizeAliases({ aliases: { m: { model: "a/b", fallbacks: ["c/d", "", 42, "e/f"] } } });
    expect(out["m"]?.fallbacks).toEqual(["c/d", "e/f"]);
  });

  it("returns {} for missing/malformed input", () => {
    for (const raw of [undefined, null, 42, "x", [], { aliases: 42 }]) {
      expect(normalizeAliases(raw)).toEqual({});
    }
  });
});

describe("model-aliases layered load", () => {
  function dirs() {
    const globalDir = mkdtempSync(join(tmpdir(), "ma-global-"));
    const projectDir = mkdtempSync(join(tmpdir(), "ma-project-"));
    return {
      globalDir,
      projectDir,
      dispose() {
        rmSync(globalDir, { recursive: true, force: true });
        rmSync(projectDir, { recursive: true, force: true });
      },
    };
  }

  it("project map replaces the whole global map (even when empty)", () => {
    const d = dirs();
    try {
      writeFileSync(join(d.globalDir, "model-aliases.json"), JSON.stringify({ aliases: { fast: { model: "a/b" } } }));
      expect(loadModelAliases(d.globalDir, d.projectDir)).toEqual({ fast: { model: "a/b" } });
      mkdirSync(join(d.projectDir, ".pi"), { recursive: true });
      writeFileSync(join(d.projectDir, ".pi", "model-aliases.json"), JSON.stringify({ aliases: {} }));
      expect(loadModelAliases(d.globalDir, d.projectDir)).toEqual({});
    } finally {
      d.dispose();
    }
  });

  it("missing files yield {}", () => {
    const d = dirs();
    try {
      expect(loadModelAliases(d.globalDir, d.projectDir)).toEqual({});
    } finally {
      d.dispose();
    }
  });

  it("agentDirFromEnv honors PI_CODING_AGENT_DIR", () => {
    expect(agentDirFromEnv({ PI_CODING_AGENT_DIR: "/custom/dir" })).toBe("/custom/dir");
    expect(agentDirFromEnv({})).toContain(".pi");
  });
});

describe("model-aliases resolve", () => {
  const alias = { model: "anthropic/opus", thinking: "max" as const, fallbacks: ["anthropic/sonnet"] };

  it("picks the primary when available", () => {
    expect(
      resolveAliasTarget(alias, registry([{ provider: "anthropic", id: "opus" }, { provider: "anthropic", id: "sonnet" }])),
    ).toEqual({ model: "anthropic/opus", thinking: "max", via: "anthropic/opus" });
  });

  it("falls back to the first available fallback", () => {
    const out = resolveAliasTarget(alias, registry([{ provider: "anthropic", id: "sonnet" }]));
    expect(out?.model).toBe("anthropic/sonnet");
    expect(out?.thinking).toBe("max");
  });

  it("returns undefined when nothing has auth (fail closed downstream)", () => {
    expect(resolveAliasTarget(alias, registry([]))).toBeUndefined();
  });

  it("uses the primary when the registry is unreadable", () => {
    const broken = { getAvailable: () => { throw new Error("nope"); } };
    expect(resolveAliasTarget(alias, broken)).toEqual({
      model: "anthropic/opus",
      thinking: "max",
      via: "anthropic/opus",
    });
  });
});

describe("model-aliases factory rewrite", () => {
  const MAP = { aliases: { max: { model: "anthropic/opus", thinking: "max" } } };
  const HAVE_OPUS = [{ provider: "anthropic", id: "opus" }];

  it("ignores non-subagent tools", () => {
    withAliasMap(MAP, () => {
      expect(fire({ model: "max" }, "read", ctxFor(HAVE_OPUS))).toEqual({ model: "max" });
    });
  });

  it("leaves absent/non-alias models untouched", () => {
    withAliasMap(MAP, () => {
      expect(fire({ prompt: "x" }, "subagent", ctxFor(HAVE_OPUS))).toEqual({ prompt: "x" });
      expect(fire({ model: "anthropic/claude-sonnet-4-6" }, "subagent", ctxFor(HAVE_OPUS))).toEqual({
        model: "anthropic/claude-sonnet-4-6",
      });
    });
  });

  it("substitutes alias model + tier thinking", () => {
    withAliasMap(MAP, () => {
      expect(fire({ model: "max" }, "subagent", ctxFor(HAVE_OPUS))).toEqual({
        model: "anthropic/opus",
        thinking: "max",
      });
    });
  });

  it("matches aliases case-insensitively", () => {
    withAliasMap(MAP, () => {
      expect(fire({ model: "MAX" }, "subagent", ctxFor(HAVE_OPUS))["model"]).toBe("anthropic/opus");
    });
  });

  it("caller-explicit thinking wins over the alias tier", () => {
    withAliasMap(MAP, () => {
      expect(fire({ model: "max", thinking: "low" }, "subagent", ctxFor(HAVE_OPUS))).toEqual({
        model: "anthropic/opus",
        thinking: "low",
      });
    });
  });

  it("leaves the alias for stock resolution when nothing is available", () => {
    withAliasMap(MAP, () => {
      expect(fire({ model: "max" }, "subagent", ctxFor([]))).toEqual({ model: "max" });
    });
  });
});

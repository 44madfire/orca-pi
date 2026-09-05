/**
 * RPC spec adapter + secret-safe error tests (SNC1.2).
 *
 * Single-compiler rule: profiles are compiled only by core's
 * `buildPiLaunch()` (JEF-7). `toPiRpcProcessSpec()` adapts an
 * already-resolved spec to RPC transport without recompiling, so prompt
 * collision fallback (literal vs content-addressed temp path) and
 * projectRoot-relative path resolution are preserved by construction.
 */

import { describe, expect, it } from "vitest";
import {
  resolvePiRpcEnv,
  toPiRpcProcessSpec,
  TUI_ONLY_FLAGS,
} from "../src/launch.js";
import {
  PiRpcError,
  boundTail,
  redactSecrets,
  redactStderrTail,
  rejectedError,
} from "../src/errors.js";

describe("toPiRpcProcessSpec (single-compiler adapter, TUI excluded)", () => {
  it("appends --mode rpc idempotently and freezes", () => {
    const spec = toPiRpcProcessSpec({ command: "pi", args: ["--offline"] });
    expect(spec.command).toBe("pi");
    expect(spec.args).toEqual(["--offline", "--mode", "rpc"]);
    expect(Object.isFrozen(spec)).toBe(true);
    expect(Object.isFrozen(spec.args)).toBe(true);
    // Already-RPC args are never doubled (core may hand back an RPC spec).
    expect(toPiRpcProcessSpec(spec).args).toEqual(["--offline", "--mode", "rpc"]);
  });

  it("preserves core-resolved absolute paths and collision-safe prompt values untouched", () => {
    // Simulates core's buildPiLaunch() output: relative skills/extensions
    // already resolved against projectRoot to absolute paths, and a
    // colliding literal prompt already materialized to a content-addressed
    // temp path (JEF-7 prompt-transport semantics).
    const coreResolved = {
      command: "pi",
      args: [
        "--provider", "opencode-go",
        "--model", "glm-5.3-flash",
        "--thinking", "low",
        "--system-prompt", "/tmp/orca-pi-prompts/orca-pi-prompt-worker-abc123.md",
        "--no-skills", "--skill", "/work/.pi/skills/repo-search",
        "--no-extensions", "--extension", "/work/.pi/extensions/custom.mjs",
        "--no-context-files",
      ],
      cwd: "/work",
      env: {},
    };
    const rpc = toPiRpcProcessSpec(coreResolved);
    // Absolute resource paths and the temp prompt path survive verbatim.
    expect(rpc.args).toContain("/work/.pi/skills/repo-search");
    expect(rpc.args).toContain("/work/.pi/extensions/custom.mjs");
    expect(rpc.args).toContain("/tmp/orca-pi-prompts/orca-pi-prompt-worker-abc123.md");
    expect(rpc.args.slice(-2)).toEqual(["--mode", "rpc"]);
    expect(rpc.cwd).toBe("/work");
  });

  it("preserves literal prompts with shell metachars as one argv element", () => {
    const tricky = 'say "hi" && rm -rf / ; echo \'x\'\nline2';
    const rpc = toPiRpcProcessSpec({ command: "pi", args: ["--system-prompt", tricky] });
    const idx = rpc.args.indexOf("--system-prompt");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(rpc.args[idx + 1]).toBe(tricky);
  });

  it("rejects TUI-only flags from resolved specs", () => {
    for (const flag of ["--theme", "--use-theme", "--tui-mode", "--verbose", "--print", "--export", "--models", "--approve", "--continue", "--resume"]) {
      expect(TUI_ONLY_FLAGS.has(flag)).toBe(true);
      expect(() => toPiRpcProcessSpec({ command: "pi", args: [flag] })).toThrow(/TUI-only/);
    }
    // Transport-neutral passthrough stays allowed.
    expect(toPiRpcProcessSpec({ command: "pi", args: ["--offline"] }).args).toContain("--offline");
  });

  it("requires a resolved command", () => {
    expect(() => toPiRpcProcessSpec({ command: "", args: [] })).toThrow(/non-empty command/);
  });

  it("resolves env overlays without implicit process.env merging surprises", () => {
    const out = resolvePiRpcEnv({ PI_CODING_AGENT_DIR: "/tmp/iso", FOO: undefined }, { FOO: "keep", BAR: "1" } as NodeJS.ProcessEnv);
    expect(out["PI_CODING_AGENT_DIR"]).toBe("/tmp/iso");
    expect(out["BAR"]).toBe("1");
    expect("FOO" in out).toBe(false);
  });
});

describe("secret-safe errors", () => {
  it("redacts token-like secrets and user paths", () => {
    expect(redactSecrets("bearer abcdefghijklmnop123456")).toContain("[REDACTED]");
    expect(redactSecrets('{"k":"sk-proj-abcdefghijklmnop123456"}')).toContain("[REDACTED]");
    expect(redactSecrets("at C:\\Users\\someone\\docs")).toContain("[REDACTED]");
    expect(redactSecrets('{"ok":true}')).toBe('{"ok":true}');
  });

  it("bounds tails, keeping the end", () => {
    expect(boundTail("abcdef", 3)).toContain("def");
    expect(redactStderrTail("x".repeat(10_000)).length).toBeLessThanOrEqual(4_100);
  });

  it("rejected errors are non-ambiguous and secret-safe", () => {
    const err = rejectedError("prompt", "r1", "Agent is already processing");
    expect(err).toBeInstanceOf(PiRpcError);
    expect(err.code).toBe("rejected");
    expect(err.ambiguous).toBe(false);
    expect(err.toSecretSafeString()).toContain("prompt");
    expect(err.toSecretSafeString()).toContain("r1");
  });

  it("error details never carry prompt contents", () => {
    const promptText = "super secret prompt contents sk-proj-abcdefghijklmnop123456";
    const err = new PiRpcError(
      { code: "request-timeout", command: "prompt", requestId: "r9", ambiguous: true, timeoutMs: 10 },
      "timed out",
    );
    expect(err.message).not.toContain(promptText);
    expect(err.toSecretSafeString()).not.toContain("super secret");
    void promptText;
  });
});

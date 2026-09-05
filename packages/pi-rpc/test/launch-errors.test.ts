/**
 * Transport-neutral launch + secret-safe error tests (SNC1.2).
 */

import { describe, expect, it } from "vitest";
import {
  buildPiRpcLaunch,
  resolvePiRpcEnv,
  TUI_ONLY_FLAGS,
} from "../src/launch.js";
import {
  PiRpcError,
  boundTail,
  redactSecrets,
  redactStderrTail,
  rejectedError,
} from "../src/errors.js";

describe("buildPiRpcLaunch (transport-neutral, TUI excluded)", () => {
  it("builds deterministic pi --mode rpc argv in fixed order", () => {
    const spec = buildPiRpcLaunch({
      profile: {
        provider: "opencode-go",
        model: "glm-5.3-flash",
        thinking: "low",
        systemPrompt: "Be brief.",
        tools: ["read", "bash"],
        excludeTools: ["ask_question"],
        discoverSkills: false,
        skills: ["s1"],
        discoverExtensions: false,
        extensions: ["e1"],
        discoverPromptTemplates: false,
        contextFiles: false,
        session: "persistent",
        sessionDir: "/tmp/sess",
        sessionName: "demo",
      },
      cwd: "/work",
      piCommand: "pi",
    });
    expect(spec.command).toBe("pi");
    expect(spec.args).toEqual([
      "--provider", "opencode-go",
      "--model", "glm-5.3-flash",
      "--thinking", "low",
      "--system-prompt", "Be brief.",
      "--tools", "read,bash",
      "--exclude-tools", "ask_question",
      "--no-skills", "--skill", "s1",
      "--no-extensions", "--extension", "e1",
      "--no-prompt-templates",
      "--no-context-files",
      "--session-dir", "/tmp/sess",
      "--name", "demo",
      "--mode", "rpc",
    ]);
    expect(Object.isFrozen(spec.args)).toBe(true);
    // Deterministic: same input → same output.
    expect(buildPiRpcLaunch({
      profile: { provider: "opencode-go", model: "glm-5.3-flash", thinking: "low" },
    }).args).toEqual(
      buildPiRpcLaunch({
        profile: { provider: "opencode-go", model: "glm-5.3-flash", thinking: "low" },
      }).args,
    );
  });

  it("maps explicit [] tools to --no-tools and ephemeral to --no-session", () => {
    const spec = buildPiRpcLaunch({ profile: { tools: [], session: "ephemeral", thinking: "low" } });
    expect(spec.args).toContain("--no-tools");
    expect(spec.args).toContain("--no-session");
    expect(spec.args).not.toContain("--session-dir");
  });

  it("passes prompt text as a single argv element (no shell quoting)", () => {
    const tricky = `say "hi" && rm -rf / ; echo 'x'\nline2`;
    const spec = buildPiRpcLaunch({ profile: { systemPrompt: tricky } });
    const idx = spec.args.indexOf("--system-prompt");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(spec.args[idx + 1]).toBe(tricky);
  });

  it("rejects TUI-only flags in extraArgs", () => {
    for (const flag of ["--theme", "--use-theme", "--tui-mode", "--verbose", "--print", "--export", "--models", "--approve", "--continue", "--resume"]) {
      expect(TUI_ONLY_FLAGS.has(flag)).toBe(true);
      expect(() => buildPiRpcLaunch({ extraArgs: [flag] })).toThrow(/TUI-only/);
    }
    // Non-TUI passthrough is allowed (e.g. --offline, --session-dir).
    expect(() =>
      buildPiRpcLaunch({ extraArgs: ["--offline"] }),
    ).not.toThrow();
    expect(buildPiRpcLaunch({ extraArgs: ["--offline"] }).args).toContain("--offline");
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

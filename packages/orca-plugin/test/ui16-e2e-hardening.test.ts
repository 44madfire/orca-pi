/**
 * UI1.6 E2E hardening — deterministic integration + regression coverage.
 *
 * Bounded first-PR slice of issue #33 that can be validated headlessly:
 * authoritative CLI/typed-bridge consistency, layering/stale-edit/
 * orchestration behavior, unsupported-host degraded safety, WSL scope
 * handling, migration invariants, and security regressions. Every case
 * uses in-memory filesystems and never touches host config, network, or
 * real credentials (synthetic `ghp_`/`gho_` fixtures only).
 *
 * What this file proves (automated here):
 * - Fresh install: built-ins load, are immutable at the base, and accept
 *   layer overrides through the typed bridge.
 * - Profile edit → launch: a bridge `profile.mutate` is observable through
 *   the same core loader/resolver the CLI uses, and `launch.preview`
 *   matches the JEF-7 compiler output (no panel-local truth).
 * - Layering: built-in < user < project precedence, extends inheritance,
 *   project-shadows-user, reset-reveals-user, and cycle rejection.
 * - Stale edits: `expectedSourceHash` conflicts for profiles and
 *   orchestration instead of silent overwrites; clear falls back.
 * - Orchestration mapping: typed set/get observes the mapping; invalid
 *   refs surface before launch; Orca owns lifecycle (ownership note).
 * - Degraded safety: negotiation is fail-closed; the seam host gate
 *   rejects config reads/mutations while unstructured; degraded fallback
 *   requires explicit terminal targets and allowlisted read-only text.
 * - WSL scopes: drive-letter, UNC/WSL, and POSIX roots normalize and stay
 *   absolute; relative roots are rejected for writes.
 * - Security: no arbitrary exec, no path-override escape, no secrets in
 *   bridge results/errors, reviewer cannot gain write tools via UI edits,
 *   actor binding stays distinct.
 * - Migration: compat aliases share the Control Center entry; the Control
 *   Center production path never uses legacy static injection.
 *
 * Explicitly NOT proven here (manual Windows 11 + WSL/Orca Desktop):
 * real Orca Desktop rendering, path translation against a live WSL
 * project, live `orca`/`pi` CLI probes, real App token mint/refresh, and
 * visual UX (skeletons, focus, themes, narrow panels, long strings).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  describeTerminalFallback,
  isAbsoluteProjectRoot,
  isAllowlistedFallbackArgv,
  negotiateBridgeCapabilities,
  normalizeProjectRoot,
  parseBridgeRequest,
} from "../src/bridge.js";
import { handleBridgeRequest, type BridgeHostDeps } from "../src/bridge-host.js";
import {
  buildGithubStatusParams,
  buildMutateParams,
  buildOrchestrationClearParams,
  buildOrchestrationSetParams,
  CONTROL_CENTER_COMPAT_PANEL_IDS,
  containsSecretMaterial,
  describeDegradedMode,
  HUMAN_REVIEW_ACTOR,
  isSecretFreePayload,
  mapBridgeErrorToField,
  mapOrchestrationErrorToField,
  ORCHESTRATION_OWNERSHIP_NOTE,
  toGithubActorSummary,
  toGithubStatusItems,
  toListItems,
  toOrchestrationItems,
  validateDraftShape,
} from "../src/control-center.js";

const here = dirname(fileURLToPath(import.meta.url));
const controlCenterHtml = readFileSync(join(here, "..", "panel", "control-center.html"), "utf8");

function memFs() {
  const files = new Map<string, string>();
  return {
    files,
    async readFile(path: string) {
      const key = String(path);
      if (!files.has(key)) {
        const error = new Error(`ENOENT: ${key}`) as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return files.get(key)!;
    },
    async writeFile(path: string, content: string) {
      files.set(String(path), content);
    },
    async rename(oldPath: string, newPath: string) {
      const from = String(oldPath);
      const to = String(newPath);
      if (!files.has(from)) {
        const error = new Error(`ENOENT: ${from}`) as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      files.set(to, files.get(from)!);
      files.delete(from);
    },
    async mkdir() {
      return undefined;
    },
    async stat(path: string) {
      if (files.has(String(path))) return {};
      const error = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    },
    async unlink(path: string) {
      files.delete(String(path));
    },
    async readdir() {
      return [];
    },
  };
}

function deps(overrides?: Partial<BridgeHostDeps>): BridgeHostDeps {
  const fs = memFs();
  return {
    projectRoot: "/repo/p",
    transport: "operator",
    env: { HOME: "/home/u" } as NodeJS.ProcessEnv,
    homedir: "/home/u",
    fs,
    orchestrationFs: fs,
    fetchFn: async () => {
      throw new Error("no network in tests");
    },
    runner: {
      async run(exe: string) {
        if (exe === "orca") return { exitCode: 0, stdout: "orca 1.4.196", stderr: "" };
        return { exitCode: 0, stdout: "pi 0.84.4", stderr: "" };
      },
    } as unknown as import("@orca-pi/core").ProcessRunner,
    providerFs: {
      async readFile() {
        const error = new Error("ENOENT") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      },
      async writeFile() {},
      async mkdir() {},
    },
    ...overrides,
  };
}

async function bridge(operation: string, extra: Record<string, unknown>, hostDeps: BridgeHostDeps) {
  return handleBridgeRequest(
    { protocolVersion: 1, requestId: `ui16-${operation}-${Math.random().toString(36).slice(2, 8)}`, operation, ...extra },
    hostDeps,
  );
}

describe("UI1.6: fresh install + built-in immutability (issue #33 §1)", () => {
  it("lists built-in scout/worker/reviewer with no user/project files", async () => {
    const d = deps();
    const res = await bridge("profiles.list", {}, d);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const items = toListItems(res.result);
    expect(items.map((i) => i.name).sort()).toEqual(["reviewer", "scout", "worker"]);
    for (const item of items) expect(item.layer ?? "builtin").toBe("builtin");
  });

  it("refuses to create over a built-in name but allows a project override patch", async () => {
    const d = deps();
    const scope = { projectRoot: "/repo/p" };
    const over = await bridge(
      "profile.mutate",
      { worktree: scope, params: { action: "create", name: "worker", scope: "project" } },
      d,
    );
    expect(over.ok).toBe(false);
    if (!over.ok) expect(["already-exists", "validation"]).toContain(over.error.code);
    const override = await bridge(
      "profile.mutate",
      { worktree: scope, params: { action: "patch", name: "worker", scope: "project", patch: { model: "openai/gpt-5.6" } } },
      d,
    );
    expect(override.ok).toBe(true);
    const read = await bridge("profile.read", { params: { name: "worker" } }, d);
    expect(read.ok).toBe(true);
    if (read.ok) {
      const view = read.result as { effective?: { model?: string }; source?: { project?: unknown } };
      expect(view.effective?.model).toBe("openai/gpt-5.6");
      expect(view.source?.project).toBeDefined();
    }
  });
});

describe("UI1.6: profile edit → launch consistency (issue #33 §2)", () => {
  it("bridge mutations are observable through the authoritative core loader + compiler", async () => {
    const d = deps();
    const scope = { projectRoot: "/repo/p" };
    const created = await bridge(
      "profile.mutate",
      { worktree: scope, params: buildMutateParams({ mode: "create", name: "worker-e2e", scope: "project", source: undefined, draft: { extends: "worker", model: "openai/gpt-5.6", thinking: "high" } }) },
      d,
    );
    expect(created.ok).toBe(true);

    // Same authoritative YAML through the core loader the CLI uses (not a
    // second store): identical effective values.
    const core = await import("@orca-pi/core");
    const readFs = { readFile: (d.fs as { readFile: (p: string) => Promise<string> }).readFile.bind(d.fs) };
    const merged = await core.loadMergedProfiles({
      projectRoot: "/repo/p",
      env: d.env,
      homedir: "/home/u",
      fs: readFs,
    });
    const resolved = core.resolveProfile("worker-e2e", merged);
    expect(resolved.model).toBe("openai/gpt-5.6");
    expect(resolved.thinking).toBe("high");

    const read = await bridge("profile.read", { params: { name: "worker-e2e" } }, d);
    expect(read.ok).toBe(true);
    if (read.ok) {
      const view = read.result as { effective?: { model?: string; thinking?: string } };
      expect(view.effective?.model).toBe(resolved.model);
      expect(view.effective?.thinking).toBe(resolved.thinking);
    }

    // Launch preview reuses the JEF-7 compiler: edited profile is actually
    // used (argv carries the edited model), display-only, no secrets.
    const preview = await bridge("launch.preview", { params: { name: "worker-e2e" } }, d);
    expect(preview.ok).toBe(true);
    if (preview.ok) {
      const result = preview.result as { displayOnly?: boolean; launch?: { spec?: { args?: unknown[] } } };
      expect(result.displayOnly).toBe(true);
      const args = (result.launch?.spec?.args ?? []) as unknown[];
      expect(args).toContain("--model");
      expect(args).toContain("openai/gpt-5.6");
      expect(isSecretFreePayload(result)).toBe(true);
    }

    // Independent compiler output agrees with the bridge preview shape.
    const launch = await core.buildPiLaunch(resolved, { projectRoot: "/repo/p", cwd: "/repo/p" });
    expect(launch.spec.args).toContain("openai/gpt-5.6");
  });
});

describe("UI1.6: layering / inheritance (issue #33 §3)", () => {
  it("applies built-in < user < project precedence with reset revealing the lower layer", async () => {
    const d = deps();
    const scope = { projectRoot: "/repo/p" };
    for (const [layerScope, model] of [["user", "user-model-a"], ["project", "project-model-b"]] as const) {
      const patched = await bridge(
        "profile.mutate",
        { worktree: scope, params: { action: "patch", name: "scout", scope: layerScope, patch: { model } } },
        d,
      );
      expect(patched.ok).toBe(true);
    }
    const readProject = await bridge("profile.read", { params: { name: "scout" } }, d);
    expect(readProject.ok).toBe(true);
    if (readProject.ok) {
      expect((readProject.result as { effective?: { model?: string } }).effective?.model).toBe("project-model-b");
    }
    // Reset the project override (unset model → layer entry removed or
    // whole-layer delete) reveals the user value instead of flattening.
    const unset = await bridge(
      "profile.mutate",
      { worktree: scope, params: { action: "unset", name: "scout", scope: "project", field: "model" } },
      d,
    );
    expect(unset.ok).toBe(true);
    const afterReset = await bridge("profile.read", { params: { name: "scout" } }, d);
    expect(afterReset.ok).toBe(true);
    if (afterReset.ok) {
      const view = afterReset.result as { effective?: { model?: string } };
      expect(view.effective?.model).toBe("user-model-a");
    }
  });

  it("inherits through extends and rejects cycles before write", async () => {
    const d = deps();
    const scope = { projectRoot: "/repo/p" };
    expect(
      await bridge("profile.mutate", { worktree: scope, params: { action: "create", name: "base-a", scope: "project", extends: "worker" } }, d),
    ).toMatchObject({ ok: true });
    expect(
      await bridge("profile.mutate", { worktree: scope, params: { action: "create", name: "base-b", scope: "project", extends: "base-a" } }, d),
    ).toMatchObject({ ok: true });
    const read = await bridge("profile.read", { params: { name: "base-b" } }, d);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect((read.result as { extendsChain?: string[] }).extendsChain).toContain("worker");
    }
    // Closing the loop must fail before any write (never a partial file).
    const cycle = await bridge(
      "profile.mutate",
      { worktree: scope, params: { action: "patch", name: "base-a", scope: "project", patch: { extends: "base-b" } } },
      d,
    );
    expect(cycle.ok).toBe(false);
    if (!cycle.ok) {
      expect(["validation", "internal"]).toContain(cycle.error.code);
      const mapped = mapBridgeErrorToField(cycle.error);
      expect(mapped.isConflict).toBe(false);
    }
    // Self-extends is caught client-side before the bridge.
    expect(validateDraftShape({ name: "x", extends: "x" }).some((i) => i.field === "extends")).toBe(true);
  });
});

describe("UI1.6: concurrent / stale editing (issue #33 §4)", () => {
  it("conflicts on stale profile hashes instead of overwriting", async () => {
    const d = deps();
    const scope = { projectRoot: "/repo/p" };
    expect(
      await bridge("profile.mutate", { worktree: scope, params: { action: "create", name: "stale-e2e", scope: "project" } }, d),
    ).toMatchObject({ ok: true });
    const stale = await bridge(
      "profile.mutate",
      {
        worktree: scope,
        params: { action: "set", name: "stale-e2e", scope: "project", field: "model", value: "m", expectedSourceHash: "0".repeat(64) },
      },
      d,
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error.code).toBe("conflict");
      const mapped = mapBridgeErrorToField(stale.error);
      expect(mapped.isConflict).toBe(true);
      expect(mapped.retryable).toBe(true);
    }
  });

  it("conflicts on stale orchestration hashes and clear falls back to the lower layer", async () => {
    const d = deps();
    const scope = { projectRoot: "/repo/p" };
    const set = await bridge(
      "orchestration.set",
      { worktree: scope, params: buildOrchestrationSetParams({ role: "worker", profile: "worker", scope: "project" }) },
      d,
    );
    expect(set.ok).toBe(true);
    const stale = await bridge(
      "orchestration.set",
      {
        worktree: scope,
        params: { ...buildOrchestrationSetParams({ role: "worker", profile: "scout", scope: "project" }), expectedSourceHash: "0".repeat(64) },
      },
      d,
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error.code).toBe("conflict");
      expect(mapOrchestrationErrorToField(stale.error).isConflict).toBe(true);
    }
    const cleared = await bridge(
      "orchestration.set",
      { worktree: scope, params: buildOrchestrationClearParams({ role: "worker", scope: "project" }) },
      d,
    );
    expect(cleared.ok).toBe(true);
    const got = await bridge("orchestration.get", {}, d);
    expect(got.ok).toBe(true);
    if (got.ok) {
      const items = toOrchestrationItems(got.result, ["worker", "scout", "reviewer"]);
      expect(items.find((i) => i.role === "worker")?.provenance).toBe("builtin");
    }
  });
});

describe("UI1.6: orchestration mapping (issue #33 §5)", () => {
  it("observes role mapping changes and surfaces invalid refs before launch", async () => {
    const d = deps();
    const scope = { projectRoot: "/repo/p" };
    const before = await bridge("orchestration.get", {}, d);
    expect(before.ok).toBe(true);
    const set = await bridge(
      "orchestration.set",
      { worktree: scope, params: buildOrchestrationSetParams({ role: "scout", profile: "scout", scope: "project" }) },
      d,
    );
    expect(set.ok).toBe(true);
    const after = await bridge("orchestration.get", {}, d);
    expect(after.ok).toBe(true);
    if (after.ok) {
      const items = toOrchestrationItems(after.result, ["worker", "scout", "reviewer"]);
      expect(items.find((i) => i.role === "scout")?.profile).toBe("scout");
      expect(items.find((i) => i.role === "scout")?.invalid).toBe(false);
      // Dangling refs never throw at read time; they surface as invalid.
      const dangling = await bridge(
        "orchestration.set",
        { worktree: scope, params: buildOrchestrationSetParams({ role: "scout", profile: "gone-profile", scope: "project" }) },
        d,
      );
      expect(dangling.ok).toBe(true);
      const reget = await bridge("orchestration.get", {}, d);
      expect(reget.ok).toBe(true);
      if (reget.ok) {
        const reitems = toOrchestrationItems(reget.result, ["worker", "scout", "reviewer"]);
        expect(reitems.find((i) => i.role === "scout")?.invalid).toBe(true);
      }
    }
    // Mapping owns only role→profile policy; lifecycle stays Orca-native.
    expect(ORCHESTRATION_OWNERSHIP_NOTE).toMatch(/Orca owns/);
  });

  it("initializes editors from the selected layer, never the merged winner", async () => {
    const { orchestrationLayerValue } = await import("../src/control-center.js");
    const payload = {
      effective: { worker: "project-winner" },
      layers: { user: { worker: "user-value" }, project: { worker: "project-winner" } },
    };
    expect(orchestrationLayerValue(payload, "worker", "user")).toBe("user-value");
    expect(orchestrationLayerValue(payload, "worker", "project")).toBe("project-winner");
  });
});

describe("UI1.6: unsupported / degraded host safety (issue #33 §8)", () => {
  it("negotiates degraded fail-closed without the seam handshake", () => {
    const degraded = negotiateBridgeCapabilities({
      appVersion: "1.4.196",
      pluginApi: 1,
      grantedCapabilities: ["workspace:read", "terminal:send"],
    });
    expect(degraded.structured).toBe(false);
    expect(degraded.degraded).toBe(true);
    expect(degraded.fallback).toBe("cli-only");
    const explainer = describeDegradedMode({ structured: degraded.structured, bridgeVersion: degraded.bridgeVersion, reasons: degraded.reasons });
    expect(explainer.title).toMatch(/Degraded/);
    expect(explainer.body).toMatch(/CLI/);
  });

  it("enforces degraded mode at the host boundary (no hidden persistence fallback)", async () => {
    const d = deps({
      transport: "seam",
      hostInfo: { appVersion: "1.4.196", pluginApi: 1, grantedCapabilities: ["terminal:send"] },
    });
    // Missing workspace:read consent blocks config reads with auth/setup.
    const blocked = await bridge("profiles.list", {}, d);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.code).toBe("auth/setup");
    // Bootstrap/diagnostic ops stay available while unstructured.
    for (const op of ["bridge.capabilities", "worktree.context", "diagnostics.doctor"] as const) {
      const res = await bridge(op, {}, d);
      expect(res.ok).toBe(true);
    }
    // Consent alone without the seam handshake is still unsupported.
    const noSeam = deps({
      transport: "seam",
      hostInfo: { appVersion: "1.4.196", pluginApi: 1, grantedCapabilities: ["workspace:read"] },
    });
    const rejected = await bridge("profiles.list", {}, noSeam);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe("unsupported");
  });

  it("degraded terminal fallback needs an explicit target and allowlisted read-only text", () => {
    const missing = describeTerminalFallback("", "orca-pi doctor");
    expect("ok" in missing && missing.ok === false).toBe(true);
    const refused = describeTerminalFallback("term-1", "orca-pi profile set worker model x");
    expect("ok" in refused && refused.ok === false).toBe(true);
    for (const text of ["orca-pi doctor", "orca-pi profiles list", "orca-pi profile validate", "orca-pi profile show worker"]) {
      expect(isAllowlistedFallbackArgv(text)).toBe(true);
      const described = describeTerminalFallback("term-9", text);
      expect("hostAction" in described).toBe(true);
    }
    expect(isAllowlistedFallbackArgv("orca-pi doctor; touch /tmp/pwn")).toBe(false);
    expect(isAllowlistedFallbackArgv("orca-pi spawn worker --task hi")).toBe(false);
  });
});

describe("UI1.6: Windows + WSL scope handling (issue #33 §7, headless slice)", () => {
  it("normalizes drive-letter, UNC/WSL, and POSIX roots while staying absolute", () => {
    expect(normalizeProjectRoot("C:\\repo\\p\\")).toBe("C:/repo/p");
    expect(normalizeProjectRoot("\\\\wsl.localhost\\Ubuntu\\repo")).toBe("//wsl.localhost/Ubuntu/repo");
    expect(normalizeProjectRoot("/repo/p/")).toBe("/repo/p");
    expect(isAbsoluteProjectRoot("C:/repo/p")).toBe(true);
    expect(isAbsoluteProjectRoot("\\\\wsl.localhost\\Ubuntu\\repo")).toBe(true);
    expect(isAbsoluteProjectRoot("/repo/p")).toBe(true);
    expect(isAbsoluteProjectRoot("../../somewhere")).toBe(false);
  });

  it("rejects relative mutation scopes (never worker-cwd-relative)", () => {
    const parsed = parseBridgeRequest({
      protocolVersion: 1,
      requestId: "wsl-1",
      operation: "profile.mutate",
      worktree: { projectRoot: "../../somewhere" },
      params: { action: "create", name: "x", scope: "project" },
    });
    expect(parsed.ok).toBe(false);
  });

  it("pins request roots to the transport-authorized root", async () => {
    const d = deps({ trustedProjectRoot: "C:/repo/p", projectRoot: "C:/repo/p" });
    const mismatch = await bridge(
      "profile.mutate",
      { worktree: { projectRoot: "C:/other/q" }, params: { action: "create", name: "x", scope: "project" } },
      d,
    );
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.error.code).toBe("validation");
  });
});

describe("UI1.6: security regression suite (issue #33, headless slice)", () => {
  it("rejects arbitrary operations (no shell/command exec)", async () => {
    const d = deps();
    for (const operation of ["exec", "shell", "command", "process:exec"]) {
      const res = await bridge(operation, {}, d);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("validation");
    }
    expect(() => buildMutateParams({ mode: "create", name: "x", scope: "project", draft: { token: "ghp_fixture" } as never })).not.toThrow();
    // Unknown draft fields are flagged client-side before the bridge.
    expect(validateDraftShape({ token: "x" } as never).length).toBeGreaterThan(0);
  });

  it("ignores arbitrary userPath/projectPath overrides from the panel", async () => {
    const d = deps();
    const res = await bridge(
      "profile.mutate",
      {
        worktree: { projectRoot: "/repo/p" },
        params: { action: "create", name: "scoped-e2e", scope: "project", userPath: "/evil/u.yaml", projectPath: "/evil/p.yaml" },
      },
      d,
    );
    expect(res.ok).toBe(true);
    const files = (d.fs as { files: Map<string, string> }).files;
    expect([...files.keys()].some((k) => k.startsWith("/evil"))).toBe(false);
  });

  it("keeps GitHub bridge results redacted (never tokens/keys)", async () => {
    const d = deps();
    const status = await bridge("github.status", { params: buildGithubStatusParams({}) }, d);
    expect(status.ok).toBe(true);
    if (status.ok) {
      expect(isSecretFreePayload(status.result)).toBe(true);
      expect(containsSecretMaterial(JSON.stringify(status.result))).toBe(false);
      const items = toGithubStatusItems(status.result);
      expect(items.map((i) => i.identity).sort()).toEqual(["reviewer", "worker"]);
    }
    const doctor = await bridge("github.doctor", { params: {} }, d);
    expect(doctor.ok).toBe(true);
    if (doctor.ok) expect(isSecretFreePayload(doctor.result)).toBe(true);
  });

  it("redacts secret-bearing failures before they reach the DOM", async () => {
    const fixtureSecret = "bridge-arbitrary-secret-9917";
    const fixtureToken = "gho_bridgeoauthcheck9988776655";
    const d = deps({ env: { HOME: "/home/u", ORCA_PI_GITHUB_WORKER_TOKEN: fixtureSecret } as NodeJS.ProcessEnv });
    const res = await bridge("github.status", { params: { identity: `bad ${fixtureSecret} ${fixtureToken} name!` } }, d);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(JSON.stringify(res.error)).not.toContain(fixtureSecret);
      expect(JSON.stringify(res.error)).not.toContain(fixtureToken);
    }
  });

  it("refuses reviewer write-tool escalation through UI edits (resolve + schema)", async () => {
    const d = deps();
    const scope = { projectRoot: "/repo/p" };
    // Same-entry violation fails before write.
    const bad = await bridge(
      "profile.mutate",
      { worktree: scope, params: { action: "create", name: "reviewer-e2e", scope: "project", initial: { githubIdentity: "reviewer", tools: ["read", "edit"] } } },
      d,
    );
    expect(bad.ok).toBe(false);
    // Client-side draft check flags it before the bridge.
    expect(validateDraftShape({ githubIdentity: "reviewer", tools: ["read", "edit"] }).some((i) => i.field === "tools")).toBe(true);
  });

  it("preserves worker != reviewer != human actor binding", async () => {
    const d = deps();
    const doctor = await bridge("github.doctor", { params: {} }, d);
    expect(doctor.ok).toBe(true);
    if (doctor.ok) {
      const summary = toGithubActorSummary(doctor.result, HUMAN_REVIEW_ACTOR);
      expect(summary?.ambientLogin).toBe(HUMAN_REVIEW_ACTOR);
    }
  });
});

describe("UI1.6: migration invariants (issue #33 cleanup)", () => {
  it("keeps one Control Center entry with compat aliases (no divergent panels)", async () => {
    expect([...CONTROL_CENTER_COMPAT_PANEL_IDS]).toEqual(["orca-pi-status", "orca-pi-profiles"]);
    const manifest = JSON.parse(readFileSync(join(here, "..", "orca-plugin.json"), "utf8")) as {
      contributes: { panels: { id: string; entry: string }[] };
    };
    const byId = new Map(manifest.contributes.panels.map((p) => [p.id, p.entry]));
    expect(byId.get("orca-pi-control-center")).toBe("panel/control-center.html");
    expect(byId.get("orca-pi-status")).toBe("panel/control-center.html");
    expect(byId.get("orca-pi-profiles")).toBe("panel/control-center.html");
  });

  it("Control Center production path never uses legacy static injection", () => {
    expect(controlCenterHtml).toContain("Orca-Pi Control Center");
    expect(controlCenterHtml).toContain("__ORCA_PI_BRIDGE__");
    expect(controlCenterHtml).not.toContain("__ORCA_PI_PROFILES__");
  });
});

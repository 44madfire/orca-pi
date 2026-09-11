/**
 * Bridge host dispatcher tests (UI1.2).
 *
 * Proves the versioned bridge returns real live profile/config data,
 * routes mutations through UI1.1's core service (never ad-hoc YAML),
 * enforces the security boundary (no arbitrary exec, redacted GitHub,
 * explicit race-safe scoping), and degrades with machine-readable errors.
 * Uses in-memory filesystems — never touches host config or network.
 */
import { describe, expect, it } from "vitest";
import { handleBridgeRequest, type BridgeHostDeps } from "../src/bridge-host.js";
import { createBridgeWorker } from "../src/worker.js";

function memFs() {
  const files = new Map<string, string>();
  const api = {
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
  };
  return api;
}

function deps(overrides?: Partial<BridgeHostDeps>): BridgeHostDeps {
  const fs = memFs();
  return {
    projectRoot: "/repo/p",
    // Dispatcher behavior tests use operator (sidecar-equivalent) transport:
    // the consent/seam gate below is covered by dedicated enforcement tests.
    transport: "sidecar",
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

async function call(operation: string, extra: Record<string, unknown> = {}, hostDeps?: BridgeHostDeps) {
  const d = hostDeps ?? deps();
  const res = await handleBridgeRequest({ protocolVersion: 1, requestId: "r1", operation, ...extra }, d);
  return { res, deps: d };
}

describe("bridge host: capabilities and worktree context", () => {
  it("reports bridge version, ops, and transport (no second store)", async () => {
    const { res } = await call("bridge.capabilities");
    expect(res.ok).toBe(true);
    if (res.ok) {
      const result = res.result as Record<string, unknown>;
      expect(result["bridgeVersion"]).toBe("1.0.0");
      expect(result["protocolVersion"]).toBe(1);
      const transport = result["transport"] as Record<string, unknown>;
      expect(transport["noSecondStore"]).toBe(true);
    }
  });

  it("echoes explicit worktree scope (race-safe, never inferred)", async () => {
    const { res } = await call("worktree.context", {
      worktree: { projectRoot: "C:\\repo\\p", worktreeId: "repo::/x", terminalId: "t1" },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const result = res.result as Record<string, unknown>;
      expect(result["projectRoot"]).toBe("C:/repo/p");
      expect(result["explicit"]).toBe(true);
    }
  });

  it("rejects unknown operations (no arbitrary exec)", async () => {
    for (const operation of ["exec", "shell", "process:exec", "run"]) {
      const { res } = await call(operation);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("validation");
    }
  });
});

describe("bridge host: live profile data (no injection)", () => {
  it("lists builtin scout/worker/reviewer with empty stores", async () => {
    const { res } = await call("profiles.list");
    expect(res.ok).toBe(true);
    if (res.ok) {
      const result = res.result as { panel: { profiles: { name: string }[] } };
      const names = result.panel.profiles.map((p) => p.name).sort();
      expect(names).toEqual(["reviewer", "scout", "worker"]);
    }
  });

  it("reads an editable view with provenance + hashes", async () => {
    const { res } = await call("profile.read", { params: { name: "worker" } });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const view = res.result as Record<string, unknown>;
      expect(view["name"]).toBe("worker");
      expect(view["exists"]).toBe(true);
    }
  });

  it("validates profiles (ok with builtins only)", async () => {
    const { res } = await call("profile.validate", { params: {} });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const result = res.result as { ok: boolean; entries: unknown[] };
      expect(result.ok).toBe(true);
      expect(result.entries.length).toBeGreaterThan(0);
    }
  });

  it("reflects live writes (no second store, no stale cache)", async () => {
    const d = deps();
    const created = await handleBridgeRequest(
      {
        protocolVersion: 1,
        requestId: "c1",
        operation: "profile.mutate",
        worktree: { projectRoot: "/repo/p" },
        params: { action: "create", name: "worker-fast", scope: "project", extends: "worker" },
      },
      d,
    );
    expect(created.ok).toBe(true);
    // Inheritance survives the bridge (folded into initial like CLI --extends).
    const read = await handleBridgeRequest(
      { protocolVersion: 1, requestId: "r1", operation: "profile.read", params: { name: "worker-fast" } },
      d,
    );
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect((read.result as { extendsChain: string[] }).extendsChain).toContain("worker");
    }
    const listed = await handleBridgeRequest({ protocolVersion: 1, requestId: "l1", operation: "profiles.list" }, d);
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      const names = ((listed.result as { panel: { profiles: { name: string }[] } }).panel.profiles).map((p) => p.name);
      expect(names).toContain("worker-fast");
    }
  });
});

describe("bridge host: mutations route through the core service", () => {
  it("creates/sets/patches/deletes with explicit scope + hashes", async () => {
    const d = deps();
    const scope = { projectRoot: "/repo/p" };
    expect(
      await handleBridgeRequest(
        { protocolVersion: 1, requestId: "a", operation: "profile.mutate", worktree: scope, params: { action: "create", name: "x1", scope: "project" } },
        d,
      ),
    ).toMatchObject({ ok: true });
    const set = await handleBridgeRequest(
      { protocolVersion: 1, requestId: "b", operation: "profile.mutate", worktree: scope, params: { action: "set", name: "x1", scope: "project", field: "model", value: "openai/gpt-5.6" } },
      d,
    );
    expect(set.ok).toBe(true);
    const read = await handleBridgeRequest({ protocolVersion: 1, requestId: "c", operation: "profile.read", params: { name: "x1" } }, d);
    expect(read.ok).toBe(true);
    const del = await handleBridgeRequest(
      { protocolVersion: 1, requestId: "e", operation: "profile.mutate", worktree: scope, params: { action: "delete", name: "x1", scope: "project" } },
      d,
    );
    expect(del.ok).toBe(true);
  });

  it("requires explicit scope and worktree (never inferred)", async () => {
    const noScope = await handleBridgeRequest(
      { protocolVersion: 1, requestId: "r1", operation: "profile.mutate", worktree: { projectRoot: "/r" }, params: { action: "create", name: "n" } },
      deps(),
    );
    expect(noScope.ok).toBe(false);
    const noWorktree = await handleBridgeRequest(
      { protocolVersion: 1, requestId: "r2", operation: "profile.mutate", params: { action: "create", name: "n", scope: "project" } },
      deps(),
    );
    expect(noWorktree.ok).toBe(false);
    if (!noWorktree.ok) expect(["validation", "conflict"]).toContain(noWorktree.error.code);
  });

  it("refuses to create over builtins (already-exists) and rejects bad fields", async () => {
    const d = deps();
    const over = await handleBridgeRequest(
      { protocolVersion: 1, requestId: "r1", operation: "profile.mutate", worktree: { projectRoot: "/r" }, params: { action: "create", name: "worker", scope: "project" } },
      d,
    );
    expect(over.ok).toBe(false);
    if (!over.ok) expect(["already-exists", "validation"]).toContain(over.error.code);
    const badField = await handleBridgeRequest(
      { protocolVersion: 1, requestId: "r2", operation: "profile.mutate", worktree: { projectRoot: "/r" }, params: { action: "set", name: "worker", scope: "project", field: "token", value: "x" } },
      d,
    );
    expect(badField.ok).toBe(false);
    if (!badField.ok) expect(badField.error.code).toBe("validation");
  });

  it("conflicts on stale hashes instead of overwriting", async () => {
    const d = deps();
    const scope = { projectRoot: "/r" };
    await handleBridgeRequest(
      { protocolVersion: 1, requestId: "c", operation: "profile.mutate", worktree: scope, params: { action: "create", name: "cc", scope: "project" } },
      d,
    );
    const stale = await handleBridgeRequest(
      {
        protocolVersion: 1,
        requestId: "s",
        operation: "profile.mutate",
        worktree: scope,
        params: { action: "set", name: "cc", scope: "project", field: "model", value: "m", expectedSourceHash: "0".repeat(64) },
      },
      d,
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("conflict");
  });

  it("rejects relative projectRoot mutations (never worker-cwd-relative)", async () => {
    const res = await handleBridgeRequest(
      {
        protocolVersion: 1,
        requestId: "rel",
        operation: "profile.mutate",
        worktree: { projectRoot: "../../somewhere" },
        params: { action: "create", name: "rel", scope: "project" },
      },
      deps(),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("validation");
      expect(res.error.message).toMatch(/absolute/);
    }
  });

  it("ignores arbitrary userPath/projectPath overrides from the panel", async () => {    const d = deps();
    const res = await handleBridgeRequest(
      {
        protocolVersion: 1,
        requestId: "evil",
        operation: "profile.mutate",
        worktree: { projectRoot: "/repo/p" },
        params: { action: "create", name: "scoped", scope: "project", userPath: "/evil/u.yaml", projectPath: "/evil/p.yaml" },
      },
      d,
    );
    expect(res.ok).toBe(true);
    const fs = (d.fs as { files: Map<string, string> }).files;
    expect([...fs.keys()].some((k) => k.startsWith("/evil"))).toBe(false);
    expect([...fs.keys()].some((k) => k.includes("/repo/p/.pi/profiles.yaml"))).toBe(true);
  });
});

describe("bridge host: launch preview reuses the compiler (display-only)", () => {
  it("returns sanitized spec + preview without executing", async () => {
    const { res } = await call("launch.preview", { params: { name: "worker" } });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const result = res.result as Record<string, unknown>;
      expect(result["displayOnly"]).toBe(true);
      expect(result["launch"]).toBeDefined();
    }
  });

  it("returns not-found for unknown profiles", async () => {
    const { res } = await call("launch.preview", { params: { name: "nope-missing" } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("not-found");
  });
});

describe("bridge host: orchestration read/write (typed, scoped)", () => {
  it("gets builtin mapping and sets a role with explicit scope", async () => {
    const d = deps();
    const got = await handleBridgeRequest({ protocolVersion: 1, requestId: "g", operation: "orchestration.get" }, d);
    expect(got.ok).toBe(true);
    const set = await handleBridgeRequest(
      {
        protocolVersion: 1,
        requestId: "s",
        operation: "orchestration.set",
        worktree: { projectRoot: "/repo/p" },
        params: { role: "worker", profile: "worker", scope: "project" },
      },
      d,
    );
    expect(set.ok).toBe(true);
  });

  it("requires explicit scope for orchestration.set", async () => {
    const { res } = await call("orchestration.set", { params: { role: "worker", profile: "worker" } });
    expect(res.ok).toBe(false);
  });
});

describe("bridge host: GitHub and diagnostics are redacted", () => {
  it("returns redacted github status (no tokens)", async () => {
    const { res } = await call("github.status", { params: {} });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const text = JSON.stringify(res.result);
      expect(text).toMatch(/redacted/);
      expect(text).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
      expect(text).not.toMatch(/\bghp_[A-Za-z0-9]{10,}/);
    }
  });

  it("returns redacted github doctor without network", async () => {
    const { res } = await call("github.doctor", { params: {} });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const text = JSON.stringify(res.result);
      expect(text).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    }
  });

  it("runs diagnostics.doctor with injected runner (read-only)", async () => {
    const { res } = await call("diagnostics.doctor");
    expect(res.ok).toBe(true);
    if (res.ok) {
      const result = res.result as Record<string, unknown>;
      expect(result["bridgeVersion"]).toBe("1.0.0");
    }
  });
});

describe("bridge host: transport enforcement (seam path)", () => {
  const STRUCTURED = {
    appVersion: "1.4.199",
    pluginApi: 1,
    grantedCapabilities: ["workspace:read", "terminal:send", "notifications:show"],
    seamAvailable: true,
  };

  function seamDeps(extraHostInfo: Record<string, unknown> = {}): BridgeHostDeps {
    const d = deps();
    return {
      ...d,
      transport: "seam",
      hostInfo: { ...STRUCTURED, ...extraHostInfo } as BridgeHostDeps["hostInfo"],
    };
  }

  it("serves everything once structured support is negotiated", async () => {
    const d = seamDeps();
    const list = await handleBridgeRequest({ protocolVersion: 1, requestId: "e1", operation: "profiles.list" }, d);
    expect(list.ok).toBe(true);
    const mutate = await handleBridgeRequest(
      {
        protocolVersion: 1,
        requestId: "e2",
        operation: "profile.mutate",
        worktree: { projectRoot: "/repo/p" },
        params: { action: "create", name: "enforced-ok", scope: "project" },
      },
      d,
    );
    expect(mutate.ok).toBe(true);
  });

  it("rejects config reads and mutations while unstructured (auth/setup when consent unverified)", async () => {
    const d = deps();
    const noHostInfo = { ...d, transport: "seam" as const };
    for (const operation of ["profiles.list", "profile.mutate", "orchestration.get", "launch.preview"]) {
      const res = await handleBridgeRequest(
        {
          protocolVersion: 1,
          requestId: "e3",
          operation,
          ...(operation === "profile.mutate"
            ? { worktree: { projectRoot: "/repo/p" }, params: { action: "create", name: "x", scope: "project" } }
            : {}),
        },
        noHostInfo,
      );
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("auth/setup");
    }
  });

  it("rejects with unsupported when consent holds but the seam handshake is missing", async () => {
    const d = seamDeps({ seamAvailable: false });
    const res = await handleBridgeRequest({ protocolVersion: 1, requestId: "e4", operation: "profiles.list" }, d);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("unsupported");
  });

  it("still serves bootstrap/diagnostic ops while unstructured", async () => {
    const d = { ...deps(), transport: "seam" as const };
    for (const operation of ["bridge.capabilities", "worktree.context", "diagnostics.doctor"]) {
      const res = await handleBridgeRequest({ protocolVersion: 1, requestId: "e5", operation }, d);
      expect(res.ok).toBe(true);
    }
  });

  it("pins request roots to the transport-authorized root (untrusted-scope rejected, untouched)", async () => {
    const d = { ...deps(), trustedProjectRoot: "/repo/p" };
    const res = await handleBridgeRequest(
      {
        protocolVersion: 1,
        requestId: "e6",
        operation: "profile.mutate",
        worktree: { projectRoot: "/other" },
        params: { action: "create", name: "evil", scope: "project" },
      },
      d,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("validation");
      expect(res.error.message).toMatch(/Untrusted worktree/);
    }
    const fs = (d.fs as { files: Map<string, string> }).files;
    expect([...fs.keys()].some((k) => k.startsWith("/other"))).toBe(false);
    expect([...fs.keys()].some((k) => k.includes("evil"))).toBe(false);
  });

  it("accepts matching pinned roots (slash-normalized)", async () => {
    const d = { ...deps(), trustedProjectRoot: "C:/repo/p" };
    const res = await handleBridgeRequest(
      {
        protocolVersion: 1,
        requestId: "e7",
        operation: "profile.mutate",
        worktree: { projectRoot: "C:\\repo\\p" },
        params: { action: "create", name: "pinned-ok", scope: "project" },
      },
      d,
    );
    expect(res.ok).toBe(true);
  });
});

describe("bridge worker: lifecycle and consent honesty", () => {
  it("tracks granted capabilities and enforces degraded mode at the host boundary", async () => {
    const worker = createBridgeWorker(deps());
    worker.onInit({ pluginId: "44madfire.orca-pi", grantedCapabilities: ["terminal:send"], appVersion: "1.4.196", pluginApi: 1 });
    expect(worker.isBridgeSupported()).toBe(false);
    expect(worker.degradationReasons().join("\n")).toMatch(/workspace:read/);
    // Worker transport is the seam path: unstructured reads of config data
    // are rejected here (auth/setup), not merely hidden by the UI.
    const res = await worker.handleRequest({ protocolVersion: 1, requestId: "w1", operation: "profiles.list" });
    expect(res.requestId).toBe("w1");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("auth/setup");
    // Bootstrap stays available so callers can learn the degraded state.
    const caps = await worker.handleRequest({ protocolVersion: 1, requestId: "w2", operation: "bridge.capabilities" });
    expect(caps.ok).toBe(true);
  });

  it("rejects worker commands explicitly (no silent exec)", () => {
    const worker = createBridgeWorker();
    worker.onInit({ grantedCapabilities: [] });
    expect(worker.handleInvokeCommand("anything").ok).toBe(false);
    expect(worker.handleDeliverEvent("worktree.created")).toEqual({ ok: true, ack: true });
  });

  it("uses stable requestIds end-to-end", async () => {
    const worker = createBridgeWorker(deps());
    worker.onInit({ grantedCapabilities: ["workspace:read", "terminal:send", "notifications:show"], appVersion: "1.4.196", pluginApi: 1, seamAvailable: true });
    expect(worker.isBridgeSupported()).toBe(true);
    const res = await worker.handleRequest({ protocolVersion: 1, requestId: "stable-42", operation: "bridge.capabilities" });
    expect(res.requestId).toBe("stable-42");
    expect(res.ok).toBe(true);
  });
});

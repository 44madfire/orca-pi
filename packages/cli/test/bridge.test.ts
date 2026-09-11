/**
 * `orca-pi bridge` sidecar tests (UI1.2 review findings).
 *
 * Proves the versioned bridge is reachable through an actual current
 * transport (one request per CLI call, JSON response) instead of dead code
 * behind a future seam: capabilities, live profile data, scoped mutations,
 * and machine-readable errors — all over isolated in-memory filesystems.
 */
import { describe, expect, it } from "vitest";
import { run, type CliDeps } from "../src/main.js";

function memFs() {
  const files = new Map<string, string>();
  return {
    files,
    async readFile(path: unknown) {
      const key = String(path);
      if (!files.has(key)) {
        const error = new Error(`ENOENT: ${key}`) as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return files.get(key)!;
    },
    async stat(path: unknown) {
      if (files.has(String(path))) return { isFile: () => true } as unknown as import("node:fs").Stats;
      const error = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    },
    async writeFile(path: unknown, content: unknown) {
      files.set(String(path), String(content));
    },
    async rename(oldPath: unknown, newPath: unknown) {
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
    async unlink(path: unknown) {
      files.delete(String(path));
    },
  };
}

function deps(overrides?: Partial<CliDeps>): CliDeps & { fs: ReturnType<typeof memFs> } {
  const fs = memFs();
  const out: string[] = [];
  const err: string[] = [];
  return {
    runner: {
      async run() {
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    } as unknown as CliDeps["runner"],
    stdout: (text: string) => {
      out.push(text);
    },
    stderr: (text: string) => {
      err.push(text);
    },
    projectRoot: "/repo/p",
    env: { HOME: "/home/u" } as NodeJS.ProcessEnv,
    homedir: "/home/u",
    fs: fs as unknown as CliDeps["fs"],
    ...(overrides ?? {}),
    __out: out,
    __err: err,
  } as unknown as CliDeps & { fs: ReturnType<typeof memFs>; __out: string[]; __err: string[] };
}

function parseOut(d: { __out: string[] }): unknown {
  return JSON.parse(d.__out.join(""));
}

describe("orca-pi bridge sidecar", () => {
  it("serves bridge.capabilities with the seam handshake proven by invocation", async () => {
    const d = deps();
    const result = await run(
      ["bridge", "--request", JSON.stringify({ protocolVersion: 1, requestId: "s1", operation: "bridge.capabilities" }), "--json"],
      d,
    );
    expect(result.exitCode).toBe(0);
    const response = parseOut(d) as { ok: boolean; requestId: string; result: { structured: boolean; fallback: string } };
    expect(response.ok).toBe(true);
    expect(response.requestId).toBe("s1");
    // Sidecar invocation proves the transport; host facts stay unknown
    // unless passed, so render support gates fail-closed while the
    // transport block records the sidecar path.
    expect(response.result.structured).toBe(false);
    expect(JSON.stringify(response.result)).toMatch(/sidecar/);
  });

  it("reports structured when the harness declares host facts (sidecar transport proven)", async () => {
    const d = deps();
    const result = await run(
      [
        "bridge",
        "--request",
        JSON.stringify({ protocolVersion: 1, requestId: "s2", operation: "bridge.capabilities" }),
        "--host-app-version",
        "1.4.199",
        "--host-plugin-api",
        "1",
        "--granted-capability",
        "workspace:read,terminal:send",
        "--json",
      ],
      d,
    );
    expect(result.exitCode).toBe(0);
    const response = parseOut(d) as { ok: boolean; result: { structured: boolean; fallback: string; supportedOperations: string[] } };
    expect(response.ok).toBe(true);
    expect(response.result.structured).toBe(true);
    expect(response.result.fallback).toBe("structured");
    expect(response.result.supportedOperations).toContain("profile.mutate");
  });

  it("returns live profile data (builtins with empty stores)", async () => {
    const d = deps();
    const result = await run(
      ["bridge", "--request", JSON.stringify({ protocolVersion: 1, requestId: "l1", operation: "profiles.list" }), "--json"],
      d,
    );
    expect(result.exitCode).toBe(0);
    const response = parseOut(d) as { ok: boolean; result: { panel: { profiles: { name: string }[] } } };
    expect(response.ok).toBe(true);
    expect(response.result.panel.profiles.map((p) => p.name).sort()).toEqual(["reviewer", "scout", "worker"]);
  });

  it("round-trips a scoped mutation through the sidecar", async () => {
    const d = deps();
    const created = await run(
      [
        "bridge",
        "--request",
        JSON.stringify({
          protocolVersion: 1,
          requestId: "c1",
          operation: "profile.mutate",
          worktree: { projectRoot: "/repo/p" },
          params: { action: "create", name: "sidecar-fast", scope: "project", extends: "worker" },
        }),
        "--json",
      ],
      d,
    );
    expect(created.exitCode).toBe(0);
    const listed = await run(
      ["bridge", "--request", JSON.stringify({ protocolVersion: 1, requestId: "l2", operation: "profiles.list" }), "--json"],
      d,
    );
    expect(listed.exitCode).toBe(0);
    const before = d.__out.join("");
    expect(before).toContain("sidecar-fast");
  });

  it("rejects absolute-but-untrusted roots without touching them", async () => {
    const d = deps();
    const result = await run(
      [
        "bridge",
        "--request",
        JSON.stringify({
          protocolVersion: 1,
          requestId: "u1",
          operation: "profile.mutate",
          worktree: { projectRoot: "/other" },
          params: { action: "create", name: "evil", scope: "project" },
        }),
        "--project-root",
        "/repo/p",
        "--json",
      ],
      d,
    );
    expect(result.exitCode).toBe(1);
    const response = parseOut(d) as { ok: boolean; error: { code: string; message: string } };
    expect(response.ok).toBe(false);
    expect(response.error.code).toBe("validation");
    expect(response.error.message).toMatch(/Untrusted worktree/);
    expect([...d.fs.files.keys()].some((k) => k.startsWith("/other"))).toBe(false);
  });

  it("rejects relative-root mutations with a validation error (exit 1)", async () => {
    const d = deps();
    const result = await run(
      [
        "bridge",
        "--request",
        JSON.stringify({
          protocolVersion: 1,
          requestId: "r1",
          operation: "profile.mutate",
          worktree: { projectRoot: "../../somewhere" },
          params: { action: "create", name: "x", scope: "project" },
        }),
        "--json",
      ],
      d,
    );
    expect(result.exitCode).toBe(1);
    const response = parseOut(d) as { ok: boolean; error: { code: string; message: string } };
    expect(response.ok).toBe(false);
    expect(response.error.code).toBe("validation");
    expect(response.error.message).toMatch(/absolute/);
  });

  it("returns validation errors for disallowed operations (exit 1, no exec)", async () => {
    const d = deps();
    const result = await run(
      ["bridge", "--request", JSON.stringify({ protocolVersion: 1, requestId: "e1", operation: "exec" }), "--json"],
      d,
    );
    expect(result.exitCode).toBe(1);
    const response = parseOut(d) as { ok: boolean; error: { code: string } };
    expect(response.ok).toBe(false);
    expect(response.error.code).toBe("validation");
  });

  it("fails usage (exit 2) without --request or with malformed JSON", async () => {
    expect((await run(["bridge", "--json"], deps())).exitCode).toBe(2);
    expect((await run(["bridge", "--request", "{nope", "--json"], deps())).exitCode).toBe(2);
    expect((await run(["bridge", "--bogus", "--json"], deps())).exitCode).toBe(2);
  });

  // Round-3 regression: two concurrent sidecar PROCESSES racing one
  // orchestration write with the same stale hash must not both succeed —
  // the cross-process lock serializes them and the loser conflicts.
  it("serializes concurrent sidecar processes (one wins, one conflicts)", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const runFile = promisify(execFile);
    const cliEntry = new URL("../dist/main.js", import.meta.url);
    const { fileURLToPath } = await import("node:url");
    const cliPath = fileURLToPath(cliEntry);
    const sandbox = mkdtempSync(join(tmpdir(), "orca-pi-bridge-race-"));
    try {
      const projectRoot = join(sandbox, "proj");
      const home = join(sandbox, "home");
      const env = { ...process.env, HOME: home };
      const bridge = async (requestId: string, params: unknown): Promise<{ stdout: string; stderr: string; code: number }> => {
        const argv = [cliPath, "bridge", "--request", JSON.stringify({ protocolVersion: 1, requestId, operation: "orchestration.set", worktree: { projectRoot }, params }), "--project-root", projectRoot, "--json"];
        try {
          const out = await runFile(process.execPath, argv, { env });
          return { stdout: out.stdout as string, stderr: out.stderr as string, code: 0 };
        } catch (error) {
          // Non-zero exit (e.g. the conflict loser) still carries the JSON
          // BridgeResponse on stdout — surface it instead of throwing.
          const execError = error as { stdout?: unknown; stderr?: unknown; code?: unknown };
          return {
            stdout: typeof execError.stdout === "string" ? execError.stdout : "",
            stderr: typeof execError.stderr === "string" ? execError.stderr : String(error),
            code: typeof execError.code === "number" ? execError.code : 1,
          };
        }
      };
      const seed = await bridge("seed", { role: "worker", profile: "alpha", scope: "project" });
      expect(seed.stderr).toBe("");
      expect(seed.code).toBe(0);
      const seeded = JSON.parse(seed.stdout) as { ok: boolean };
      expect(seeded.ok).toBe(true);
      const got = await runFile(
        process.execPath,
        [cliPath, "bridge", "--request", JSON.stringify({ protocolVersion: 1, requestId: "get", operation: "orchestration.get" }), "--project-root", projectRoot, "--json"],
        { env },
      );
      const mapping = JSON.parse(got.stdout) as { ok: boolean; result: { sourceHash: { project: string } } };
      expect(mapping.ok).toBe(true);
      const hash = mapping.result.sourceHash.project;
      const [first, second] = await Promise.all([
        bridge("race-a", { role: "worker", profile: "beta", scope: "project", expectedSourceHash: hash }),
        bridge("race-b", { role: "worker", profile: "gamma", scope: "project", expectedSourceHash: hash }),
      ]);
      const outcomes = [first, second].map((r) => JSON.parse(r.stdout) as { ok: boolean; error?: { code?: string } });
      expect(outcomes.map((o) => o.ok).sort()).toEqual([false, true]);
      const loser = outcomes.find((o) => !o.ok)!;
      expect(loser.error?.code).toBe("conflict");
      const winner = outcomes.find((o) => o.ok)!;
      void winner;
      const final = await runFile(
        process.execPath,
        [cliPath, "bridge", "--request", JSON.stringify({ protocolVersion: 1, requestId: "final", operation: "orchestration.get" }), "--project-root", projectRoot, "--json"],
        { env },
      );
      const finalMapping = JSON.parse(final.stdout) as { ok: boolean; result: { effective: { worker: string } } };
      expect(["beta", "gamma"]).toContain(finalMapping.result.effective.worker);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 60000);
});

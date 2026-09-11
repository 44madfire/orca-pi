/**
 * Orchestration role→profile mapping service tests (UI1.2).
 *
 * Covers builtins, user/project precedence, explicit scope, validation,
 * atomicity/conflict, and Windows/WSL path handling. Uses an in-memory fs
 * so no host files are touched.
 */
import { describe, expect, it } from "vitest";
import {
  BUILTIN_ROLE_MAPPING,
  deleteRoleOverride,
  getProjectOrchestrationPath,
  getRoleMapping,
  getUserOrchestrationPath,
  hashOrchestrationText,
  OrchestrationConfigError,
  setRoleMapping,
} from "../src/orchestration/config.js";

function memFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  const dirs = new Set<string>();
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
    async mkdir(path: string) {
      dirs.add(String(path));
      return undefined;
    },
    async stat(path: string) {
      if (files.has(String(path)) || dirs.has(String(path))) return {};
      const error = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    },
    async unlink(path: string) {
      files.delete(String(path));
    },
  };
}

describe("orchestration role mapping: builtins and precedence", () => {
  it("exposes builtin worker/scout/reviewer with no files", async () => {
    const fs = memFs();
    const mapping = await getRoleMapping({
      projectRoot: "/repo/p",
      userPath: "/home/u/.pi/agent/orchestration.json",
      projectPath: "/repo/p/.pi/orchestration.json",
      fs,
    });
    expect(mapping.effective).toMatchObject(BUILTIN_ROLE_MAPPING);
    expect(mapping.provenance["worker"]).toBe("builtin");
    expect(mapping.config.userExists).toBe(false);
    expect(mapping.config.projectExists).toBe(false);
  });

  it("merges user < project (project wins)", async () => {
    const userPath = "/home/u/.pi/agent/orchestration.json";
    const projectPath = "/repo/p/.pi/orchestration.json";
    const fs = memFs({
      [userPath]: JSON.stringify({ version: 1, roles: { worker: "worker-fast" } }),
      [projectPath]: JSON.stringify({ version: 1, roles: { worker: "worker-project" } }),
    });
    const mapping = await getRoleMapping({ projectRoot: "/repo/p", userPath, projectPath, fs });
    expect(mapping.effective["worker"]).toBe("worker-project");
    expect(mapping.provenance["worker"]).toBe("project");
    expect(mapping.effective["scout"]).toBe("scout");
  });

  it("reports dangling refs via knownProfiles without throwing", async () => {
    const fs = memFs();
    await setRoleMapping(
      { role: "worker", profile: "ghost-profile", scope: "project" },
      { projectRoot: "/repo/p", userPath: "/u.json", projectPath: "/repo/p/.pi/orchestration.json", fs },
    );
    const mapping = await getRoleMapping({
      projectRoot: "/repo/p",
      userPath: "/u.json",
      projectPath: "/repo/p/.pi/orchestration.json",
      fs,
      knownProfiles: ["worker", "scout", "reviewer"],
    });
    expect(mapping.invalidRefs).toContain("worker");
  });
});

describe("orchestration role mapping: writes are explicit, validated, atomic", () => {
  it("requires explicit scope (never inferred)", async () => {
    const fs = memFs();
    await expect(
      setRoleMapping(
        { role: "worker", profile: "x", scope: "bogus" as never },
        { projectRoot: "/r", fs },
      ),
    ).rejects.toMatchObject({ code: "missing-scope" });
  });

  it("rejects invalid roles and profile refs", async () => {
    const fs = memFs();
    await expect(
      setRoleMapping({ role: "__proto__", profile: "worker", scope: "user" }, { projectRoot: "/r", fs }),
    ).rejects.toMatchObject({ code: "invalid-role" });
    await expect(
      setRoleMapping({ role: "worker", profile: "has space!", scope: "user" }, { projectRoot: "/r", fs }),
    ).rejects.toMatchObject({ code: "invalid-profile" });
  });

  it("round-trips set → get and supports delete (fallback to lower layer)", async () => {
    const userPath = "/u.json";
    const projectPath = "/r/.pi/orchestration.json";
    const fs = memFs();
    await setRoleMapping({ role: "scout", profile: "scout-fast", scope: "user" }, { projectRoot: "/r", userPath, projectPath, fs });
    let mapping = await getRoleMapping({ projectRoot: "/r", userPath, projectPath, fs });
    expect(mapping.effective["scout"]).toBe("scout-fast");
    expect(mapping.provenance["scout"]).toBe("user");
    const deleted = await deleteRoleOverride({ role: "scout", scope: "user" }, { projectRoot: "/r", userPath, projectPath, fs });
    expect(deleted.removed).toBe(true);
    mapping = await getRoleMapping({ projectRoot: "/r", userPath, projectPath, fs });
    expect(mapping.effective["scout"]).toBe("scout");
  });

  it("conflicts on stale hashes instead of overwriting", async () => {
    const userPath = "/u.json";
    const projectPath = "/r/.pi/orchestration.json";
    const fs = memFs();
    const first = await setRoleMapping({ role: "worker", profile: "a", scope: "project" }, { projectRoot: "/r", userPath, projectPath, fs });
    const stale = "0".repeat(64);
    await expect(
      setRoleMapping({ role: "worker", profile: "b", scope: "project" }, { projectRoot: "/r", userPath, projectPath, fs, expectedSourceHash: stale }),
    ).rejects.toMatchObject({ code: "conflict" });
    // Fresh hash wins.
    await setRoleMapping(
      { role: "worker", profile: "b", scope: "project" },
      { projectRoot: "/r", userPath, projectPath, fs, expectedSourceHash: first.sourceHashAfter },
    );
    const mapping = await getRoleMapping({ projectRoot: "/r", userPath, projectPath, fs });
    expect(mapping.effective["worker"]).toBe("b");
  });

  it("rejects malformed JSON with load-failed (never a partial merge)", async () => {
    const projectPath = "/r/.pi/orchestration.json";
    const fs = memFs({ [projectPath]: "{ not json" });
    await expect(getRoleMapping({ projectRoot: "/r", projectPath, fs })).rejects.toMatchObject({
      code: "load-failed",
    });
  });
});

describe("orchestration paths: Windows + WSL", () => {
  it("derives project paths with slash normalization", () => {
    expect(getProjectOrchestrationPath("C:\\repo\\p")).toBe("C:/repo/p/.pi/orchestration.json");
    expect(getProjectOrchestrationPath("\\\\wsl.localhost\\Ubuntu\\repo")).toBe(
      "//wsl.localhost/Ubuntu/repo/.pi/orchestration.json",
    );
  });

  it("derives user paths from PI_CODING_AGENT_DIR or HOME", () => {
    expect(getUserOrchestrationPath({ env: { PI_CODING_AGENT_DIR: "C:\\pi" } as NodeJS.ProcessEnv })).toBe(
      "C:/pi/orchestration.json",
    );
    expect(getUserOrchestrationPath({ env: { HOME: "/home/u" } as NodeJS.ProcessEnv })).toBe(
      "/home/u/.pi/agent/orchestration.json",
    );
  });

  it("hashes are stable hex (conflict protocol)", () => {
    expect(hashOrchestrationText("{}")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("surfaces a typed error with scope on failure", () => {
    const err = new OrchestrationConfigError({ code: "conflict", scope: "project", role: "worker", message: "stale" });
    expect(err.code).toBe("conflict");
    expect(err.scope).toBe("project");
  });
});

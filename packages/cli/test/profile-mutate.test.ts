import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/main.js";
import type { CliDeps } from "../src/main.js";
import type { CommandResult } from "@orca-pi/core";

type FullFs = Pick<typeof import("node:fs/promises"), "readFile" | "stat" | "writeFile" | "rename" | "mkdir" | "unlink">;

function memFs(initial: Record<string, string> = {}): FullFs & {
  files: Map<string, string>;
} {
  const files = new Map<string, string>(Object.entries(initial));
  const fs = {
    files,
    async readFile(path: unknown, encoding?: unknown) {
      void encoding;
      const key = String(path);
      if (files.has(key)) return files.get(key)!;
      const error = new Error(`ENOENT: no such file ${key}`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    },
    async stat(path: unknown) {
      const key = String(path);
      if (files.has(key)) return { isFile: () => true } as unknown as import("node:fs").Stats;
      const error = new Error(`ENOENT: no such file ${key}`) as NodeJS.ErrnoException;
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
        const error = new Error(`ENOENT: no such file ${from}`) as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      files.set(to, files.get(from)!);
      files.delete(from);
    },
    async mkdir() {
      return undefined as unknown as string;
    },
    async unlink(path: unknown) {
      const key = String(path);
      if (!files.has(key)) {
        const error = new Error(`ENOENT: no such file ${key}`) as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      files.delete(key);
    },
  };
  return fs as unknown as FullFs & { files: Map<string, string> };
}

function makeDeps(files: Record<string, string>): {
  deps: CliDeps;
  out: string[];
  err: string[];
  fs: FullFs & { files: Map<string, string> };
} {
  const out: string[] = [];
  const err: string[] = [];
  const full = memFs(files);
  const runner = {
    async run(): Promise<CommandResult> {
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };
  const deps: CliDeps = {
    runner,
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => err.push(text),
    version: "0.1.0-test",
    projectRoot: "/repo/p",
    env: {},
    homedir: "/home/u",
    fs: full,
    userConfigPathOverride: "/home/u/.pi/agent/profiles.yaml",
    projectConfigPathOverride: "/repo/p/.pi/profiles.yaml",
  };
  return { deps, out, err, fs: full };
}

describe("orca-pi profile create/clone", () => {
  it("creates a profile in project scope with JSON receipt", async () => {
    const { deps, out, err, fs } = makeDeps({});
    const result = await run(
      ["profile", "create", "worker-fast", "--extends", "worker", "--scope", "project", "--json"],
      deps,
    );
    expect(err.join("")).toBe("");
    expect(result.exitCode).toBe(0);
    const receipt = JSON.parse(out.join("")) as { ok: boolean; action: string; profileName: string; scope: string };
    expect(receipt.ok).toBe(true);
    expect(receipt.action).toBe("create");
    expect(receipt.profileName).toBe("worker-fast");
    expect(receipt.scope).toBe("project");
    expect(fs.files.get("/repo/p/.pi/profiles.yaml")).toContain("worker-fast");
  });

  it("requires explicit --scope (exit 2, never infers)", async () => {
    const { deps, err } = makeDeps({});
    const result = await run(["profile", "create", "x"], deps);
    expect(result.exitCode).toBe(2);
    expect(err.join("")).toContain("--scope");
  });

  it("rejects duplicate create with exit 1", async () => {
    const { deps, out } = makeDeps({});
    expect(
      (await run(["profile", "create", "n1", "--scope", "project", "--json"], deps)).exitCode,
    ).toBe(0);
    out.length = 0;
    const second = makeDeps({});
    // Reuse the same fs files by copying.
    void second;
    const result = await run(["profile", "create", "scout", "--scope", "project", "--json"], deps);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(out.join("")) as { ok: boolean }).toEqual(expect.objectContaining({ ok: false }));
  });

  it("clones worker to worker-fast", async () => {
    const { deps, out, fs } = makeDeps({});
    const result = await run(["profile", "clone", "worker", "worker-fast", "--scope", "project", "--json"], deps);
    expect(result.exitCode).toBe(0);
    expect((JSON.parse(out.join("")) as { resolved: { model?: string } }).resolved).toBeDefined();
    expect(fs.files.get("/repo/p/.pi/profiles.yaml")).toContain("worker-fast");
  });
});

describe("orca-pi profile set/unset/delete", () => {
  it("sets a field with JSON value parsing (arrays/booleans/strings)", async () => {
    const { deps, out, fs } = makeDeps({});
    expect((await run(["profile", "create", "a", "--scope", "project", "--json"], deps)).exitCode).toBe(0);
    out.length = 0;
    expect(
      (await run(["profile", "set", "a", "model", "openai/gpt-5.6", "--scope", "project", "--json"], deps)).exitCode,
    ).toBe(0);
    expect((JSON.parse(out.join("")) as { resolved: { model: string } }).resolved.model).toBe("openai/gpt-5.6");
    out.length = 0;
    expect(
      (await run(["profile", "set", "a", "tools", '["read","bash"]', "--scope", "project", "--json"], deps)).exitCode,
    ).toBe(0);
    expect((JSON.parse(out.join("")) as { resolved: { tools: string[] } }).resolved.tools).toEqual(["read", "bash"]);
    expect(fs.files.get("/repo/p/.pi/profiles.yaml")).toContain("openai/gpt-5.6");
  });

  it("unsets a field and deletes the override file when emptied", async () => {
    const { deps, fs } = makeDeps({
      "/repo/p/.pi/profiles.yaml": "profiles:\n  solo:\n    model: x\n",
    });
    const result = await run(["profile", "unset", "solo", "model", "--scope", "project", "--json"], deps);
    expect(result.exitCode).toBe(0);
    expect(fs.files.has("/repo/p/.pi/profiles.yaml")).toBe(false);
  });

  it("deletes only the targeted scope", async () => {
    const { deps, fs } = makeDeps({
      "/home/u/.pi/agent/profiles.yaml": "profiles:\n  shared:\n    model: user-m\n",
      "/repo/p/.pi/profiles.yaml": "profiles:\n  shared:\n    model: project-m\n",
    });
    const result = await run(["profile", "delete", "shared", "--scope", "project", "--json"], deps);
    expect(result.exitCode).toBe(0);
    expect(fs.files.has("/repo/p/.pi/profiles.yaml")).toBe(false);
    expect(fs.files.get("/home/u/.pi/agent/profiles.yaml")).toContain("shared");
  });

  it("refuses builtin delete with exit 1", async () => {
    const { deps, err } = makeDeps({});
    const result = await run(["profile", "delete", "scout", "--scope", "project"], deps);
    expect(result.exitCode).toBe(1);
    expect(err.join("")).toContain("Built-in");
  });
});

describe("orca-pi profile patch (machine transaction)", () => {
  it("patches via --patch JSON and via --json @file shape", async () => {
    const { deps, out } = makeDeps({});
    expect((await run(["profile", "create", "p", "--scope", "project", "--json"], deps)).exitCode).toBe(0);
    out.length = 0;
    const patched = await run(
      ["profile", "patch", "p", "--scope", "project", "--patch", '{"model":"openai/gpt-5.6","thinking":"high"}'],
      deps,
    );
    expect(patched.exitCode).toBe(0);
    // Bare patch uses the human one-line summary (no --json flag).
    expect(out.join("")).toContain('Updated profile "p"');

    // Issue's suggested `--json @patch.json` shape: payload via @file.
    const { deps: deps2, out: out2, fs: fs2 } = makeDeps({
      "/tmp/patch.json": '{"model":"from-file"}',
      "/repo/p/.pi/profiles.yaml": "profiles:\n  q:\n    model: old\n",
    });
    // Inject the patch file into the same fs the CLI reads.
    fs2.files.set("/tmp/patch.json", '{"model":"from-file"}');
    const viaJsonAt = await run(
      ["profile", "patch", "q", "--scope", "project", "--json", "@/tmp/patch.json"],
      deps2,
    );
    expect(viaJsonAt.exitCode).toBe(0);
    expect(out2.join("")).toContain("from-file");
  });

  it("fails patch with invalid values and leaves the original unchanged", async () => {
    const { deps, out, fs } = makeDeps({
      "/repo/p/.pi/profiles.yaml": "profiles:\n  a:\n    model: good\n",
    });
    const before = fs.files.get("/repo/p/.pi/profiles.yaml")!;
    const result = await run(
      ["profile", "patch", "a", "--scope", "project", "--patch", '{"thinking":"ultra"}', "--json"],
      deps,
    );
    expect(result.exitCode).toBe(1);
    expect(fs.files.get("/repo/p/.pi/profiles.yaml")).toBe(before);
    expect(out.join("")).toContain("ok");
  });

  it("supports stale-hash conflict via --expected-hash", async () => {
    const { deps, out } = makeDeps({});
    expect((await run(["profile", "create", "c", "--scope", "project", "--json"], deps)).exitCode).toBe(0);
    const first = JSON.parse(out.join("")) as { sourceHashAfter: string };
    out.length = 0;
    // External edit advances the hash.
    expect(
      (await run(["profile", "set", "c", "model", "two", "--scope", "project", "--json"], deps)).exitCode,
    ).toBe(0);
    out.length = 0;
    const stale = await run(
      ["profile", "set", "c", "model", "stale", "--scope", "project", "--expected-hash", first.sourceHashAfter, "--json"],
      deps,
    );
    expect(stale.exitCode).toBe(1);
    expect(out.join("")).toContain("conflict");
  });
});

describe("orca-pi profile read (editable view)", () => {
  it("returns per-layer source + effective + provenance as JSON", async () => {
    const { deps, out } = makeDeps({
      "/home/u/.pi/agent/profiles.yaml": "profiles:\n  scout:\n    model: user-m\n",
    });
    const result = await run(["profile", "read", "scout", "--json"], deps);
    expect(result.exitCode).toBe(0);
    const view = JSON.parse(out.join("")) as {
      name: string;
      exists: boolean;
      source: { user?: { model: string } };
      effective: { model: string };
      fields: Record<string, { provenance: { display: string } }>;
    };
    expect(view.name).toBe("scout");
    expect(view.exists).toBe(true);
    expect(view.source.user?.model).toBe("user-m");
    expect(view.effective.model).toBe("user-m");
    expect(view.fields.model?.provenance.display).toContain("user config");
  });

  it("human read shows layers without building argv", async () => {
    const { deps, out } = makeDeps({});
    const result = await run(["profile", "read", "scout"], deps);
    expect(result.exitCode).toBe(0);
    expect(out.join("")).toContain("scout");
    expect(out.join("")).not.toContain("--model");
  });
});

describe("existing inspection stays compatible after mutations", () => {
  it("list/show/validate/path still work after a mutation", async () => {
    const { deps, out } = makeDeps({});
    expect((await run(["profile", "create", "extra", "--scope", "project"], deps)).exitCode).toBe(0);
    out.length = 0;
    expect((await run(["profiles", "list"], deps)).exitCode).toBe(0);
    expect(out.join("")).toContain("extra");
    out.length = 0;
    expect((await run(["profile", "show", "extra", "--json"], deps)).exitCode).toBe(0);
    expect((JSON.parse(out.join("")) as { profile: { name: string } }).profile.name).toBe("extra");
    out.length = 0;
    expect((await run(["profile", "validate"], deps)).exitCode).toBe(0);
    out.length = 0;
    expect((await run(["profile", "path", "--json"], deps)).exitCode).toBe(0);
  });
});

describe("orca-pi profile mutations and descendant safety (P1 review)", () => {
  it("refuses to delete a referenced parent (exit 1, file unchanged)", async () => {
    const { deps, out, fs } = makeDeps({
      "/repo/p/.pi/profiles.yaml": "profiles:\n  base:\n    model: m\n  child:\n    extends: base\n    thinking: low\n",
    });
    const before = fs.files.get("/repo/p/.pi/profiles.yaml")!;
    const result = await run(["profile", "delete", "base", "--scope", "project", "--json"], deps);
    expect(result.exitCode).toBe(1);
    expect(out.join("")).toContain("child");
    expect(fs.files.get("/repo/p/.pi/profiles.yaml")).toBe(before);
  });
});

describe("orca-pi profile absent-layer versioning (P1 review)", () => {
  it("two clients reading a missing layer: first --expected-absent wins, second conflicts", async () => {
    const { deps, out } = makeDeps({});
    // Both clients read while the project file is absent (no hash to send).
    const first = await run(
      ["profile", "create", "first", "--scope", "project", "--expected-absent", "--json"],
      deps,
    );
    expect(first.exitCode).toBe(0);
    out.length = 0;
    // Stale second creator still asserts absence: must conflict, never
    // silently replace the first value.
    const second = await run(
      ["profile", "create", "second", "--scope", "project", "--expected-absent", "--json"],
      deps,
    );
    expect(second.exitCode).toBe(1);
    expect(out.join("")).toMatch(/conflict|absent|stale/i);
  });

  it("rejects combining --expected-hash with --expected-absent (exit 2)", async () => {
    const { deps } = makeDeps({});
    const result = await run(
      ["profile", "create", "x", "--scope", "project", "--expected-hash", "abc", "--expected-absent"],
      deps,
    );
    expect(result.exitCode).toBe(2);
  });

  it("a read-only injected fs fails closed without touching the host FS", async () => {
    // Real host sentinel: if the mutation fell back to the real filesystem
    // it would create/modify this file. It must stay exactly as written.
    const dir = mkdtempSync(join(tmpdir(), "orca-pi-fs-boundary-"));
    const sentinel = join(dir, "profiles.yaml");
    writeFileSync(sentinel, "profiles:\n  keep:\n    model: host\n");
    try {
      const out: string[] = [];
      const err: string[] = [];
      const readOnlyFs = {
        async readFile(path: unknown) {
          void path;
          const error = new Error("ENOENT: no such file") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        },
        async stat(path: unknown) {
          void path;
          const error = new Error("ENOENT: no such file") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        },
      };
      const runner = {
        async run(): Promise<CommandResult> {
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      };
      const deps: CliDeps = {
        runner,
        stdout: (text: string) => out.push(text),
        stderr: (text: string) => err.push(text),
        version: "0.1.0-test",
        projectRoot: "/repo/p",
        env: {},
        homedir: "/home/u",
        fs: readOnlyFs as unknown as CliDeps["fs"],
        userConfigPathOverride: "/home/u/.pi/agent/profiles.yaml",
        projectConfigPathOverride: sentinel,
      };
      const result = await run(
        ["profile", "create", "evil", "--scope", "project", "--json"],
        deps,
      );
      expect(result.exitCode).toBe(1);
      expect(out.join("") + err.join("")).toMatch(/does not support mutations|refusing/i);
      expect(readFileSync(sentinel, "utf8")).toBe("profiles:\n  keep:\n    model: host\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("orca-pi profile patch output mode (P2 review)", () => {
  it("bare patch uses the human one-line summary; failures go to stderr", async () => {
    const { deps, out, err } = makeDeps({
      "/repo/p/.pi/profiles.yaml": "profiles:\n  a:\n    model: good\n",
    });
    const ok = await run(
      ["profile", "patch", "a", "--scope", "project", "--patch", '{"model":"m2"}'],
      deps,
    );
    expect(ok.exitCode).toBe(0);
    expect(out.join("")).toContain('Updated profile "a"');
    expect(out.join("")).not.toContain('"ok"');
    out.length = 0;
    err.length = 0;
    const bad = await run(
      ["profile", "patch", "nope", "--scope", "project", "--patch", '{"model":"m"}'],
      deps,
    );
    expect(bad.exitCode).toBe(1);
    expect(err.join("")).toContain("Unknown Pi profile");
  });

  it("patch --json keeps machine output on success and failure", async () => {
    const { deps, out } = makeDeps({
      "/repo/p/.pi/profiles.yaml": "profiles:\n  a:\n    model: good\n",
    });
    const ok = await run(
      ["profile", "patch", "a", "--scope", "project", "--patch", '{"model":"m2"}', "--json"],
      deps,
    );
    expect(ok.exitCode).toBe(0);
    expect((JSON.parse(out.join("")) as { ok: boolean }).ok).toBe(true);
  });
});

describe("orca-pi profile read invalid config (P1 review)", () => {
  it("read --json returns the structured invalid view with issues, not bare {ok:false}", async () => {
    const { deps, out } = makeDeps({
      "/repo/p/.pi/profiles.yaml":
        "profiles:\n  scout:\n    model: anthropic/claude-haiku\n    thinking: ultra\n",
    });
    const result = await run(["profile", "read", "scout", "--json"], deps);
    expect(result.exitCode).toBe(1);
    const view = JSON.parse(out.join("")) as {
      validation: { ok: boolean; code?: string; issues?: Array<{ path: string }> };
      sourceHash: { project?: string };
    };
    expect(view.validation.ok).toBe(false);
    expect(view.validation.code).toBe("load-failed");
    expect(view.validation.issues?.length).toBeGreaterThan(0);
    expect(view.validation.issues?.some((issue) => issue.path.includes("thinking"))).toBe(true);
    expect(view.sourceHash.project).toBeDefined();
  });

  it("an invalid custom profile reads as existing and repairs through set", async () => {
    const broken = "profiles:\n  custom:\n    model: openai/gpt-5.6\n    thinking: ultra\n";
    const { deps, out, err, fs } = makeDeps({ "/repo/p/.pi/profiles.yaml": broken });
    const read = await run(["profile", "read", "custom", "--json"], deps);
    expect(read.exitCode).toBe(1);
    const view = JSON.parse(out.join("")) as {
      exists: boolean;
      validation: { ok: boolean; issues?: Array<{ path: string }> };
      sourceHash: { project?: string };
    };
    expect(view.exists).toBe(true);
    expect(view.validation.ok).toBe(false);
    expect(view.validation.issues?.some((issue) => issue.path.includes("thinking"))).toBe(true);
    out.length = 0;
    const repaired = await run(
      ["profile", "set", "custom", "thinking", "high", "--scope", "project", "--expected-hash", view.sourceHash.project as string, "--json"],
      deps,
    );
    expect(repaired.exitCode).toBe(0);
    expect(fs.files.get("/repo/p/.pi/profiles.yaml")).not.toContain("ultra");
    out.length = 0;
    err.length = 0;
    // Human read reports the validation error, not "Unknown Pi profile".
    const human = await run(["profile", "read", "custom"], deps);
    expect(human.exitCode).toBe(0);
    expect(err.join("")).toBe("");
  });

  it("human read of a broken custom profile shows invalid, not unknown", async () => {
    const { deps, err } = makeDeps({
      "/repo/p/.pi/profiles.yaml": "profiles:\n  custom:\n    model: m\n    thinking: ultra\n",
    });
    const result = await run(["profile", "read", "custom"], deps);
    expect(result.exitCode).toBe(1);
    expect(err.join("")).toContain("invalid");
    expect(err.join("")).not.toContain("Unknown Pi profile");
  });
});

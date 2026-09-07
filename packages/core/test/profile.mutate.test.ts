import { describe, expect, it } from "vitest";
import { hostname } from "node:os";
import {
  buildEditableView,
  cloneProfile,
  createProfile,
  deleteProfile,
  hashSourceText,
  lockOrigin,
  patchProfile,
  readEditableProfile,
  serializeProfilesDocument,
  setProfileField,
  unsetProfileField,
  withMutationLock,
  ProfileMutationError,
  type MutationFs,
} from "../src/profile/mutate.js";
import {
  getBuiltinProfilesDocument,
  mergeValidatedDocuments,
  parseAndValidateProfilesText,
  resolveProfile,
} from "../src/profile/index.js";
import { getCandidateConfigPaths, getUserProfilesPath } from "../src/profile/load.js";
import type { ValidatedProfilesDocument } from "../src/profile/types.js";

function parentDir(path: string): string {
  const normalized = String(path).replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return index === 0 ? "/" : ".";
  // Return the normalized parent so strict dir modeling compares one
  // canonical form regardless of separator style (Windows vs WSL paths).
  const parent = normalized.slice(0, index);
  return parent.length === 0 ? "/" : parent;
}

function memFs(
  initial: Record<string, string> = {},
  opts: {
    modelDirs?: boolean;
    denied?: string[];
    shared?: { files?: Map<string, string>; mtimes?: Map<string, number>; dirs?: Set<string> };
  } = {},
): MutationFs & {
  files: Map<string, string>;
  mtimes: Map<string, number>;
  dirs: Set<string>;
  failNextWrite?: boolean;
  writes: string[];
} {
  const files = opts.shared?.files ?? new Map<string, string>(Object.entries(initial));
  const mtimes = opts.shared?.mtimes ?? new Map<string, number>();
  if (opts.shared === undefined) {
    for (const key of files.keys()) mtimes.set(key, Date.now());
  } else if (Object.keys(initial).length > 0) {
    for (const [key, value] of Object.entries(initial)) {
      if (!files.has(key)) {
        files.set(key, value);
        mtimes.set(key, Date.now());
      }
    }
  }
  // Optional strict directory modeling (P1-A): writes fail ENOENT when the
  // parent was never created via recursive mkdir, like a real filesystem.
  const dirs = opts.shared?.dirs ?? new Set<string>();
  const modelDirs = opts.modelDirs === true;
  // Paths (or subtrees) that deny writes with EACCES, simulating read-only
  // stores/checkouts. Reads still succeed; only mkdir/writeExclusive fail.
  const denied = (opts.denied ?? []).map((d) => String(d).replace(/\\/g, "/").replace(/\/+$/, ""));
  const isDenied = (path: string): boolean => {
    const normalized = String(path).replace(/\\/g, "/").replace(/\/+$/, "");
    return denied.some((d) => normalized === d || normalized.startsWith(`${d}/`));
  };
  const denyEacces = (what: string): NodeJS.ErrnoException => {
    const error = new Error(`EACCES: permission denied ${what}`) as NodeJS.ErrnoException;
    error.code = "EACCES";
    return error;
  };
  const dirExists = (dir: string): boolean => {
    const normalized = String(dir).replace(/\\/g, "/").replace(/\/+$/, "");
    if (normalized === "" || normalized === "." || normalized === "/") return true;
    if (/^[A-Za-z]:$/.test(normalized)) return true;
    return dirs.has(normalized);
  };
  const requireParent = (path: string): void => {
    if (!modelDirs) return;
    if (!dirExists(parentDir(path))) {
      const error = new Error(`ENOENT: no such directory ${parentDir(path)}`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
  };
  const fs = {
    files,
    mtimes,
    dirs,
    writes: [] as string[],
    failNextWrite: false,
    async readFile(path: string): Promise<string> {
      const key = String(path);
      if (files.has(key)) return files.get(key)!;
      const error = new Error(`ENOENT: no such file ${key}`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    },
    async writeFile(path: string, content: string): Promise<void> {
      if ((fs as { failNextWrite?: boolean }).failNextWrite) {
        (fs as { failNextWrite?: boolean }).failNextWrite = false;
        throw new Error("injected write failure");
      }
      requireParent(String(path));
      if (isDenied(parentDir(String(path)))) throw denyEacces(`write ${String(path)}`);
      files.set(String(path), content);
      mtimes.set(String(path), Date.now());
      fs.writes.push(String(path));
    },
    async writeExclusive(path: string, content: string): Promise<void> {
      const key = String(path);
      if (isDenied(parentDir(key))) throw denyEacces(`write ${key}`);
      requireParent(key);
      if (files.has(key)) {
        const error = new Error(`EEXIST: ${key}`) as NodeJS.ErrnoException;
        error.code = "EEXIST";
        throw error;
      }
      files.set(key, content);
      mtimes.set(key, Date.now());
    },
    async rename(oldPath: string, newPath: string): Promise<void> {
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
    async mkdir(path: string, mkdirOpts?: { recursive: boolean }): Promise<string | undefined> {
      if (isDenied(String(path))) throw denyEacces(`mkdir ${String(path)}`);
      if (mkdirOpts?.recursive) {
        // Populate the full ancestor chain like a real recursive mkdir.
        let current = String(path).replace(/\\/g, "/").replace(/\/+$/, "");
        const chain: string[] = [];
        for (;;) {
          if (current === "" || current === "." || current === "/" || /^[A-Za-z]:$/.test(current)) break;
          chain.push(current);
          const slash = current.lastIndexOf("/");
          if (slash <= 0) break;
          current = current.slice(0, slash);
        }
        // Mimic Node: resolve the first directory actually created (topmost
        // newly added ancestor), or undefined when everything existed.
        let firstCreated: string | undefined;
        for (let i = chain.length - 1; i >= 0; i--) {
          if (!dirs.has(chain[i] as string)) {
            firstCreated = chain[i];
            break;
          }
        }
        for (const dir of chain) dirs.add(dir);
        return firstCreated;
      } else {
        requireParent(String(path));
        dirs.add(String(path).replace(/\\/g, "/").replace(/\/+$/, ""));
        return undefined;
      }
    },
    async stat(path: string): Promise<unknown> {
      const key = String(path);
      if (files.has(key)) return { isFile: () => true, mtimeMs: mtimes.get(key) ?? Date.now() };
      const normalized = key.replace(/\\/g, "/").replace(/\/+$/, "");
      if (dirs.has(normalized)) return { isFile: () => false, mtimeMs: Date.now() };
      const error = new Error(`ENOENT: no such file ${key}`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    },
    async rmdir(path: string): Promise<void> {
      const key = String(path);
      const normalized = key.replace(/\\/g, "/").replace(/\/+$/, "");
      for (const file of files.keys()) {
        const f = file.replace(/\\/g, "/");
        if (f === normalized || f.startsWith(`${normalized}/`)) {
          const error = new Error(`ENOTEMPTY: directory not empty ${key}`) as NodeJS.ErrnoException;
          error.code = "ENOTEMPTY";
          throw error;
        }
      }
      for (const dir of dirs) {
        if (dir !== normalized && dir.startsWith(`${normalized}/`)) {
          const error = new Error(`ENOTEMPTY: directory not empty ${key}`) as NodeJS.ErrnoException;
          error.code = "ENOTEMPTY";
          throw error;
        }
      }
      if (!dirs.has(normalized)) {
        const error = new Error(`ENOENT: no such directory ${key}`) as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      dirs.delete(normalized);
    },
    async unlink(path: string): Promise<void> {
      const key = String(path);
      if (!files.has(key)) {
        const error = new Error(`ENOENT: no such file ${key}`) as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      files.delete(key);
      mtimes.delete(key);
    },
    async readdir(path: string): Promise<string[]> {
      const prefix = `${String(path)}/`;
      const out: string[] = [];
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          if (rest.length > 0 && !rest.includes("/")) out.push(rest);
        }
      }
      return out;
    },
  };
  return fs as unknown as MutationFs & {
    files: Map<string, string>;
    mtimes: Map<string, number>;
    dirs: Set<string>;
    failNextWrite?: boolean;
    writes: string[];
  };
}

const USER = "/home/u/.pi/agent/profiles.yaml";
const PROJECT = "/repo/p/.pi/profiles.yaml";

function opts(fs: MutationFs, extra?: Record<string, unknown>): {
  userPath: string;
  projectPath: string;
  fs: MutationFs;
} {
  return {
    userPath: USER,
    projectPath: PROJECT,
    fs,
    ...(extra ?? {}),
  } as unknown as { userPath: string; projectPath: string; fs: MutationFs };
}

async function expectMutationError(
  promise: Promise<unknown>,
  code: string,
): Promise<ProfileMutationError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ProfileMutationError);
    expect((error as ProfileMutationError).code).toBe(code);
    return error as ProfileMutationError;
  }
  expect.unreachable(`expected ProfileMutationError(${code})`);
}

describe("profile mutate: create + layering", () => {
  it("creates a new profile in project scope with extends", async () => {
    const fs = memFs();
    const receipt = await createProfile(
      { name: "worker-fast", scope: "project", initial: { extends: "worker", model: "openai/gpt-5.6" } },
      opts(fs),
    );
    expect(receipt.action).toBe("create");
    expect(receipt.scope).toBe("project");
    expect(receipt.path).toBe(PROJECT);
    expect(receipt.resolved?.model).toBe("openai/gpt-5.6");
    expect(receipt.resolved?.extendsChain).toEqual(["worker", "worker-fast"]);
    expect(receipt.sourceHashAfter).toBeDefined();
    // File contains only the delta, YAML-serialized without sourceLabel.
    const text = fs.files.get(PROJECT)!;
    expect(text).toContain("worker-fast");
    expect(text).toContain("openai/gpt-5.6");
    expect(text).not.toContain("sourceLabel");
    // Provenance: model from project, thinking inherited from worker builtin.
    expect(receipt.provenance?.model.kind).toBe("project");
  });

  it("rejects create when the name already exists (builtin guard)", async () => {
    const fs = memFs();
    const error = await expectMutationError(
      createProfile({ name: "scout", scope: "project", initial: { model: "x" } }, opts(fs)),
      "already-exists",
    );
    expect(error.message).toContain("built-in");
    expect(fs.files.has(PROJECT)).toBe(false);
  });

  it("requires explicit scope and valid names", async () => {
    const fs = memFs();
    await expectMutationError(
      // @ts-expect-error intentional missing scope
      createProfile({ name: "x" }, opts(fs)),
      "missing-scope",
    );
    await expectMutationError(
      createProfile({ name: "__proto__", scope: "project" }, opts(fs)),
      "invalid-name",
    );
    await expectMutationError(
      createProfile({ name: "Bad Name!", scope: "project" }, opts(fs)),
      "invalid-name",
    );
  });

  it("serializes without metadata and hashes stably", async () => {
    const doc = parseAndValidateProfilesText("profiles:\n  a:\n    model: x\n", "a.yaml");
    const text = serializeProfilesDocument(doc);
    expect(text).toContain("profiles:");
    expect(text).not.toContain("sourceLabel");
    expect(hashSourceText(text)).toBe(hashSourceText(text));
  });
});

describe("profile mutate: clone/delete", () => {
  it("clones an effective profile into the target scope", async () => {
    const fs = memFs({
      [USER]: "profiles:\n  base:\n    model: anthropic/claude-haiku\n    thinking: low\n",
    });
    const receipt = await cloneProfile({ source: "base", dest: "base-copy", scope: "project" }, opts(fs));
    expect(receipt.sourceName).toBe("base");
    expect(receipt.resolved?.model).toBe("anthropic/claude-haiku");
    expect(fs.files.get(PROJECT)).toContain("base-copy");
    // Source layer untouched.
    expect(fs.files.get(USER)).toContain("base:");
    expect(fs.files.get(USER)).not.toContain("base-copy");
  });

  it("rejects clone of unknown source or existing dest", async () => {
    const fs = memFs();
    await expectMutationError(cloneProfile({ source: "nope", dest: "x", scope: "project" }, opts(fs)), "not-found");
    await expectMutationError(cloneProfile({ source: "scout", dest: "worker", scope: "project" }, opts(fs)), "already-exists");
  });

  it("deletes only the targeted scope (never infers destructive target)", async () => {
    const fs = memFs({
      [USER]: "profiles:\n  shared:\n    model: user-model\n",
      [PROJECT]: "profiles:\n  shared:\n    model: project-model\n",
    });
    const receipt = await deleteProfile({ name: "shared", scope: "project" }, opts(fs));
    expect(receipt.scope).toBe("project");
    expect(fs.files.has(PROJECT)).toBe(false);
    // User layer survives; effective falls back to user.
    const view = await readEditableProfile("shared", opts(fs));
    expect(view.exists).toBe(true);
    expect(view.effective?.model).toBe("user-model");
  });

  it("unlinks the file when the last entry is deleted", async () => {
    const fs = memFs({
      [PROJECT]: "profiles:\n  solo:\n    model: x\n",
    });
    const receipt = await deleteProfile({ name: "solo", scope: "project" }, opts(fs));
    expect(receipt.deleted).toBe(true);
    expect(fs.files.has(PROJECT)).toBe(false);
  });

  it("refuses to delete built-ins directly", async () => {
    const fs = memFs();
    const error = await expectMutationError(deleteProfile({ name: "scout", scope: "project" }, opts(fs)), "builtin-immutable");
    expect(error.message).toContain("Built-in");
  });

  it("refuses to delete from a scope with no entry even when the other scope has it", async () => {
    const fs = memFs({
      [USER]: "profiles:\n  only-user:\n    model: x\n",
    });
    await expectMutationError(deleteProfile({ name: "only-user", scope: "project" }, opts(fs)), "not-found");
  });
});

describe("profile mutate: set/unset/patch", () => {
  it("set creates a delta override for builtin profiles (layering preserved)", async () => {
    const fs = memFs();
    const receipt = await setProfileField(
      { name: "scout", scope: "project", field: "model", value: "openai/gpt-5.6" },
      opts(fs),
    );
    expect(receipt.resolved?.model).toBe("openai/gpt-5.6");
    const text = fs.files.get(PROJECT)!;
    // Delta: only the changed field lands in project scope, not a full copy.
    expect(text).toContain("model");
    expect(text).not.toContain("low");
    // Thinking still inherits builtin.
    expect(receipt.resolved?.thinking).toBe("low");
    expect(receipt.provenance?.model.kind).toBe("project");
    expect(receipt.provenance?.thinking.kind).toBe("built-in");
  });

  it("set replaces arrays wholesale and validates values", async () => {
    const fs = memFs();
    await createProfile({ name: "a", scope: "project", initial: { tools: ["read"] } }, opts(fs));
    const receipt = await setProfileField(
      { name: "a", scope: "project", field: "tools", value: ["bash", "edit"] },
      opts(fs),
    );
    expect(receipt.resolved?.tools).toEqual(["bash", "edit"]);
  });

  it("rejects invalid set values without touching the original", async () => {
    const fs = memFs({
      [PROJECT]: "profiles:\n  a:\n    model: good\n",
    });
    const before = fs.files.get(PROJECT)!;
    const beforeHash = hashSourceText(before);
    const error = await expectMutationError(
      setProfileField({ name: "a", scope: "project", field: "thinking", value: "ultra" }, opts(fs)),
      "validation-failed",
    );
    expect(error.issues?.some((issue) => issue.path.includes("thinking"))).toBe(true);
    expect(fs.files.get(PROJECT)).toBe(before);
    expect(hashSourceText(fs.files.get(PROJECT)!)).toBe(beforeHash);
  });

  it("rejects unknown fields and secret-like fields", async () => {
    const fs = memFs();
    await createProfile({ name: "a", scope: "project", initial: { model: "x" } }, opts(fs));
    await expectMutationError(
      setProfileField({ name: "a", scope: "project", field: "apiKey", value: "sk-secret" }, opts(fs)),
      "invalid-field",
    );
    const error = await expectMutationError(
      patchProfile({ name: "a", scope: "project", patch: { apiKey: "sk-secret" } }, opts(fs)),
      "invalid-field",
    );
    expect(error.message).toMatch(/secret/i);
  });

  it("unset removes only the targeted scope field", async () => {
    const fs = memFs({
      [USER]: "profiles:\n  s:\n    model: user-model\n    thinking: low\n",
      [PROJECT]: "profiles:\n  s:\n    model: project-model\n",
    });
    await unsetProfileField({ name: "s", scope: "project", field: "model" }, opts(fs));
    expect(fs.files.has(PROJECT)).toBe(false);
    const view = await readEditableProfile("s", opts(fs));
    expect(view.effective?.model).toBe("user-model");
  });

  it("patch applies a structured transaction with null deletes", async () => {
    const fs = memFs();
    await createProfile(
      { name: "p", scope: "project", initial: { model: "a", thinking: "low", displayName: "P" } },
      opts(fs),
    );
    const receipt = await patchProfile(
      { name: "p", scope: "project", patch: { model: "b", displayName: null } },
      opts(fs),
    );
    expect(receipt.resolved?.model).toBe("b");
    expect(receipt.resolved?.displayName).toBeUndefined();
  });

  it("patch keeps prompt mutual exclusivity in the same layer", async () => {
    const fs = memFs();
    await createProfile(
      { name: "p", scope: "project", initial: { systemPromptFile: ".pi/agents/x.md" } },
      opts(fs),
    );
    await patchProfile(
      { name: "p", scope: "project", patch: { systemPrompt: "inline" } },
      opts(fs),
    );
    const view = await readEditableProfile("p", opts(fs));
    expect(view.effective?.systemPrompt).toBe("inline");
    expect(view.effective?.systemPromptFile).toBeUndefined();
  });

  it("user-vs-project precedence: project wins with correct provenance", async () => {
    const fs = memFs();
    await createProfile({ name: "m", scope: "user", initial: { model: "user-model", thinking: "low" } }, opts(fs));
    await patchProfile({ name: "m", scope: "project", patch: { model: "project-model" } }, opts(fs));
    const view = await readEditableProfile("m", opts(fs));
    expect(view.effective?.model).toBe("project-model");
    expect(view.effective?.thinking).toBe("low");
    expect(view.fields.model?.provenance.kind).toBe("project");
    expect(view.fields.thinking?.provenance.kind).toBe("user");
    expect(view.fields.model?.user).toBe("user-model");
    expect(view.fields.model?.project).toBe("project-model");
  });
});

describe("profile mutate: inheritance + cycles", () => {
  it("resolves extends chains across layers", async () => {
    const fs = memFs();
    await createProfile({ name: "base", scope: "user", initial: { tools: ["read"], thinking: "low" } }, opts(fs));
    await createProfile({ name: "child", scope: "project", initial: { extends: "base", model: "x" } }, opts(fs));
    const view = await readEditableProfile("child", opts(fs));
    expect(view.extendsChain).toEqual(["base", "child"]);
    expect(view.effective?.tools).toEqual(["read"]);
    expect(view.effective?.model).toBe("x");
  });

  it("rejects cycles without writing", async () => {
    const fs = memFs();
    await createProfile({ name: "a", scope: "project", initial: { model: "x" } }, opts(fs));
    await createProfile({ name: "b", scope: "project", initial: { extends: "a", model: "y" } }, opts(fs));
    const before = fs.files.get(PROJECT)!;
    const error = await expectMutationError(
      patchProfile({ name: "a", scope: "project", patch: { extends: "b" } }, opts(fs)),
      "resolve-failed",
    );
    expect(error.message).toContain("cycle");
    expect(fs.files.get(PROJECT)).toBe(before);
  });

  it("rejects unknown parents", async () => {
    const fs = memFs();
    await createProfile({ name: "a", scope: "project", initial: { model: "x" } }, opts(fs));
    await expectMutationError(
      patchProfile({ name: "a", scope: "project", patch: { extends: "does-not-exist" } }, opts(fs)),
      "resolve-failed",
    );
  });

  it("enforces the reviewer no-write-tools guard on effective config", async () => {
    const fs = memFs();
    await createProfile(
      { name: "rev", scope: "project", initial: { githubIdentity: "reviewer", tools: ["read"] } },
      opts(fs),
    );
    await expectMutationError(
      setProfileField({ name: "rev", scope: "project", field: "tools", value: ["read", "edit"] }, opts(fs)),
      "validation-failed",
    );
  });
});

describe("profile mutate: atomicity + conflicts", () => {
  it("fails with conflict on stale expectedSourceHash", async () => {
    const fs = memFs();
    const first = await createProfile({ name: "a", scope: "project", initial: { model: "one" } }, opts(fs));
    const stale = first.sourceHashAfter!;
    // External edit advances the file.
    await setProfileField({ name: "a", scope: "project", field: "model", value: "two" }, opts(fs));
    const error = await expectMutationError(
      setProfileField(
        { name: "a", scope: "project", field: "model", value: "stale-write" },
        opts(fs, { expectedSourceHash: stale }),
      ),
      "conflict",
    );
    expect(error.message).toContain("Stale");
    // Loser's value never landed.
    const view = await readEditableProfile("a", opts(fs));
    expect(view.effective?.model).toBe("two");
  });

  it("succeeds with a fresh expectedSourceHash", async () => {
    const fs = memFs();
    const first = await createProfile({ name: "a", scope: "project", initial: { model: "one" } }, opts(fs));
    const receipt = await setProfileField(
      { name: "a", scope: "project", field: "model", value: "two" },
      opts(fs, { expectedSourceHash: first.sourceHashAfter }),
    );
    expect(receipt.resolved?.model).toBe("two");
  });

  it("leaves the original unchanged when the write fails", async () => {
    const fs = memFs({
      [PROJECT]: "profiles:\n  a:\n    model: good\n",
    });
    const before = fs.files.get(PROJECT)!;
    fs.failNextWrite = true;
    const error = await expectMutationError(
      setProfileField({ name: "a", scope: "project", field: "model", value: "new" }, opts(fs)),
      "atomic-write-failed",
    );
    expect(error.message).toContain("Original document left unchanged");
    expect(fs.files.get(PROJECT)).toBe(before);
  });

  it("returns the original document unchanged on validation failure", async () => {
    const fs = memFs({
      [PROJECT]: "profiles:\n  ok:\n    model: good\n",
    });
    const before = fs.files.get(PROJECT)!;
    await expectMutationError(
      createProfile({ name: "bad", scope: "project", initial: { thinking: "ultra" } }, opts(fs)),
      "validation-failed",
    );
    expect(fs.files.get(PROJECT)).toBe(before);
  });
});

describe("profile mutate: editable view", () => {
  it("exposes builtin/user/project/effective layers with provenance", async () => {
    const fs = memFs({
      [USER]: "profiles:\n  scout:\n    model: user-model\n",
      [PROJECT]: "profiles:\n  scout:\n    thinking: high\n",
    });
    const view = await readEditableProfile("scout", opts(fs));
    expect(view.exists).toBe(true);
    expect(view.source.user?.model).toBe("user-model");
    expect(view.source.project?.thinking).toBe("high");
    expect(view.source.builtin?.thinking).toBe("low");
    expect(view.effective?.model).toBe("user-model");
    expect(view.effective?.thinking).toBe("high");
    expect(view.sourceHash.user).toBeDefined();
    expect(view.sourceHash.project).toBeDefined();
    expect(view.config.userExists).toBe(true);
    expect(view.config.projectExists).toBe(true);
  });

  it("reports unknown profiles and invalid profiles with field paths", async () => {
    const fs = memFs();
    const missing = await readEditableProfile("nope", opts(fs));
    expect(missing.exists).toBe(false);
    expect(missing.validation.ok).toBe(false);
  });

  it("buildEditableView is pure and launch-agnostic (no argv built here)", async () => {
    const builtinDoc = getBuiltinProfilesDocument();
    const userDoc = parseAndValidateProfilesText("profiles:\n  scout:\n    model: m\n", "user.yaml");
    const { mergeValidatedDocuments: merge } = await import("../src/profile/load.js");
    const merged = merge([builtinDoc, userDoc]);
    const view = buildEditableView(
      "scout",
      {
        mergedDoc: merged,
        builtinDoc,
        userDoc,
        userPath: USER,
        projectPath: PROJECT,
        userExists: true,
        projectExists: false,
      },
      {},
    );
    expect(view.effective?.model).toBe("m");
    // View carries no argv/spec — launch preview reuses the existing
    // compiler with `view.effective` (JEF-7 boundary).
    expect((view as Record<string, unknown>).spec).toBeUndefined();
    expect((view as Record<string, unknown>).args).toBeUndefined();
  });
});

describe("profile mutate: windows + wsl paths", () => {
  it("resolves Windows home paths without literal ~", async () => {
    expect(
      getUserProfilesPath({ env: {} as NodeJS.ProcessEnv, osHomedir: () => "C:/Users/test" }),
    ).toBe("C:/Users/test/.pi/agent/profiles.yaml");
    const fs = memFs();
    const winUser = "C:/Users/test/.pi/agent/profiles.yaml";
    const winProject = "C:/repo/.pi/profiles.yaml";
    const receipt = await createProfile(
      { name: "win", scope: "user", initial: { model: "x" } },
      { userPath: winUser, projectPath: winProject, fs },
    );
    expect(receipt.path).toBe(winUser);
    expect(fs.files.get(winUser)).toContain("win:");
  });

  it("supports WSL mount paths and backslash parents", async () => {
    const fs = memFs();
    const wslProject = "/mnt/c/repo/.pi/profiles.yaml";
    await createProfile(
      { name: "wsl", scope: "project", initial: { model: "x" } },
      { userPath: USER, projectPath: wslProject, fs },
    );
    expect(fs.files.get(wslProject)).toContain("wsl:");
    // Backslash Windows path lands in the same logical file store.
    const backslashUser = "C:\\Users\\test\\.pi\\profiles.yaml";
    await createProfile(
      { name: "back", scope: "user", initial: { model: "y" } },
      { userPath: backslashUser, projectPath: PROJECT, fs },
    );
    expect(fs.files.get(backslashUser)).toContain("back:");
  });

  it("keeps candidate-path order user < project", async () => {
    expect(
      getCandidateConfigPaths({
        projectRoot: "/repo/p",
        env: { PI_CODING_AGENT_DIR: "/home/u/.pi/agent" } as NodeJS.ProcessEnv,
      }),
    ).toEqual(["/home/u/.pi/agent/profiles.yaml", "/repo/p/.pi/profiles.yaml"]);
  });
});

describe("profile mutate: merge + resolve reuse", () => {
  it("merges builtins < user < project for effective resolution", async () => {
    const builtinDoc = getBuiltinProfilesDocument();
    const userDoc = parseAndValidateProfilesText("profiles:\n  worker:\n    model: user-m\n", "user.yaml");
    const projectDoc = parseAndValidateProfilesText(
      "profiles:\n  worker:\n    thinking: low\n",
      "project.yaml",
    );
    const merged = mergeValidatedDocuments([builtinDoc, userDoc, projectDoc]);
    const resolved = resolveProfile("worker", merged as ValidatedProfilesDocument);
    expect(resolved.model).toBe("user-m");
    expect(resolved.thinking).toBe("low");
  });
});

describe("profile mutate: descendant invalidation (P1 review)", () => {
  it("rejects deleting a referenced parent without touching the file", async () => {
    const fs = memFs({
      [PROJECT]: "profiles:\n  base:\n    model: m\n  child:\n    extends: base\n    thinking: low\n",
    });
    const before = fs.files.get(PROJECT)!;
    const error = await expectMutationError(
      deleteProfile({ name: "base", scope: "project" }, opts(fs)),
      "resolve-failed",
    );
    expect(error.message).toContain("child");
    expect(fs.files.get(PROJECT)).toBe(before);
    // The graph is untouched: child still resolves.
    const view = await readEditableProfile("child", opts(fs));
    expect(view.validation.ok).toBe(true);
    expect(view.extendsChain).toEqual(["base", "child"]);
  });

  it("rejects a parent edit that invalidates an inheriting reviewer child", async () => {
    const fs = memFs({
      [PROJECT]:
        "profiles:\n  parent:\n    tools: [read]\n  child:\n    extends: parent\n    githubIdentity: reviewer\n",
    });
    const before = fs.files.get(PROJECT)!;
    // `child` inherits `tools` from `parent`; adding `edit` would resolve the
    // reviewer child with source-write tools via the chain.
    const error = await expectMutationError(
      setProfileField({ name: "parent", scope: "project", field: "tools", value: ["read", "edit"] }, opts(fs)),
      "resolve-failed",
    );
    expect(error.message).toMatch(/reviewer|edit/i);
    expect(fs.files.get(PROJECT)).toBe(before);
  });

  it("fails closed when the graph is already invalid elsewhere", async () => {
    const fs = memFs({
      [PROJECT]: "profiles:\n  broken:\n    extends: does-not-exist\n",
    });
    // Schema-valid file, unresolvable graph: even an unrelated create is
    // refused so no commit lands on a broken effective configuration.
    const error = await expectMutationError(
      createProfile({ name: "good", scope: "project", initial: { model: "x" } }, opts(fs)),
      "resolve-failed",
    );
    expect(error.message).toContain("broken");
    expect(fs.files.has(PROJECT)).toBe(true);
    // Repairing the invalid profile itself is the way out.
    await patchProfile({ name: "broken", scope: "project", patch: { extends: null, model: "x" } }, opts(fs));
    const view = await readEditableProfile("broken", opts(fs));
    expect(view.validation.ok).toBe(true);
  });
});

describe("profile mutate: concurrent writers (P1 TOCTOU review)", () => {
  const lockDir = `${PROJECT}.lock.d`;

  it("serializes two writers from the same hash: one commits, one conflicts", async () => {
    const fs = memFs();
    const first = await createProfile({ name: "a", scope: "project", initial: { model: "one" } }, opts(fs));
    const stale = first.sourceHashAfter!;
    // Both writers load hash H. The lock serializes them; the loser loads the
    // winner's commit inside the lock and its stale expected hash conflicts
    // instead of silently overwriting. Either writer may win.
    const results = await Promise.allSettled([
      setProfileField({ name: "a", scope: "project", field: "model", value: "two" }, opts(fs, { expectedSourceHash: stale })),
      setProfileField({ name: "a", scope: "project", field: "model", value: "three" }, opts(fs, { expectedSourceHash: stale })),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(ProfileMutationError);
    expect((reason as ProfileMutationError).code).toBe("conflict");
    const view = await readEditableProfile("a", opts(fs));
    expect(["two", "three"]).toContain(view.effective?.model);
    // No lock droppings remain.
    expect(await fs.readdir!(lockDir)).toHaveLength(0);
  });

  it("ignores a dead candidate instead of deadlocking", async () => {
    const fs = memFs();
    await createProfile({ name: "a", scope: "project", initial: { model: "one" } }, opts(fs));
    // Plant a dead contender file simulating a crashed writer. Dead pids are
    // ignored for election (never block), and the next holder GCs them.
    await fs.mkdir!(lockDir, { recursive: true });
    await (fs as unknown as MutationFs & { writeExclusive(p: string, c: string): Promise<void> }).writeExclusive(
      `${lockDir}/n-aaa-dead.json`,
      JSON.stringify({ pid: 2147483647, token: "aaa-dead", number: 1 }),
    );
    const receipt = await setProfileField(
      { name: "a", scope: "project", field: "model", value: "two" },
      opts(fs),
    );
    expect(receipt.resolved?.model).toBe("two");
    expect(await fs.readdir!(lockDir)).toHaveLength(0);
  });

  it("releases the lock after a validation failure so later writes proceed", async () => {
    const fs = memFs({
      [PROJECT]: "profiles:\n  a:\n    model: good\n",
    });
    await expectMutationError(
      setProfileField({ name: "a", scope: "project", field: "thinking", value: "ultra" }, opts(fs)),
      "validation-failed",
    );
    const receipt = await setProfileField(
      { name: "a", scope: "project", field: "model", value: "better" },
      opts(fs),
    );
    expect(receipt.resolved?.model).toBe("better");
    expect(await fs.readdir!(lockDir).catch(() => [] as string[])).toHaveLength(0);
  });
});

describe("profile mutate: fresh-store lock ordering (P1 review)", () => {
  it("creates the parent directory before acquiring the lock", async () => {
    // Strict directory modeling: nothing exists, not even `.pi/`. Before the
    // fix, lock acquisition threw ENOENT and the first mutation on a fresh
    // store never reached the write path.
    const fs = memFs({}, { modelDirs: true });
    const receipt = await createProfile(
      { name: "fresh", scope: "project", initial: { model: "x" } },
      opts(fs),
    );
    expect(receipt.resolved?.model).toBe("x");
    expect(fs.files.get(PROJECT)).toContain("fresh:");
    expect(await fs.readdir!(`${PROJECT}.lock.d`)).toHaveLength(0);
  });

  it("creates a fresh user store the same way", async () => {
    const fs = memFs({}, { modelDirs: true });
    await setProfileField({ name: "scout", scope: "user", field: "model", value: "m" }, opts(fs));
    expect(fs.files.get(USER)).toContain("model: m");
  });
});

describe("profile mutate: lock ownership (P1 review)", () => {
  const lockDir = `${PROJECT}.lock.d`;

  it("release deletes only its own file, never a successor's", async () => {
    const fs = memFs();
    await createProfile({ name: "a", scope: "project", initial: { model: "one" } }, opts(fs));
    // Holder A acquires the lock and pauses mid-transaction.
    let releaseA!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const holderA = withMutationLock(PROJECT, fs, () => gate);
    // Wait until A's number file exists (choosing is cleared on election).
    let aFile = "";
    for (let i = 0; i < 100; i++) {
      const names = await fs.readdir!(lockDir).catch(() => [] as string[]);
      const numbered = names.find((n) => n.startsWith("n-"));
      if (numbered) {
        aFile = numbered;
        break;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(aFile).not.toBe("");
    // A cross-process successor waiter B appears (newer, so A stays holder).
    // B must survive A's release untouched.
    const bFile = `n-zzz-b.json`;
    await (fs as unknown as MutationFs & { writeExclusive(p: string, c: string): Promise<void> }).writeExclusive(
      `${lockDir}/${bFile}`,
      JSON.stringify({ pid: process.pid, token: "zzz-b", number: 999 }),
    );
    const unlinked: string[] = [];
    const origUnlink = fs.unlink!.bind(fs);
    (fs as unknown as { unlink: NonNullable<MutationFs["unlink"]> }).unlink = (async (p: string) => {
      unlinked.push(String(p));
      return origUnlink(p);
    }) as NonNullable<MutationFs["unlink"]>;
    releaseA();
    await holderA;
    // A removed exactly its own number file; B's file was never touched.
    // (The already-cleared choosing path may record a best-effort ENOENT
    // attempt; only number-file removals matter for the invariant.)
    expect(unlinked.filter((p) => p.endsWith(".json"))).toEqual([`${lockDir}/${aFile}`]);
    expect(fs.files.has(`${lockDir}/${bFile}`)).toBe(true);
    expect(fs.files.has(`${lockDir}/${aFile}`)).toBe(false);
    (fs as unknown as { unlink: NonNullable<MutationFs["unlink"]> }).unlink =
      origUnlink as NonNullable<MutationFs["unlink"]>;
    await (fs as unknown as MutationFs).unlink!(`${lockDir}/${bFile}`);
  });

  it("a live holder blocks contenders even when stale-by-mtime (suspension-safe)", async () => {
    const fs = memFs();
    await createProfile({ name: "a", scope: "project", initial: { model: "one" } }, opts(fs));
    await fs.mkdir!(lockDir, { recursive: true });
    const liveContent = JSON.stringify({ pid: process.pid, token: "live-holder", number: 5 });
    await (fs as unknown as MutationFs & { writeExclusive(p: string, c: string): Promise<void> }).writeExclusive(
      `${lockDir}/n-live.json`,
      liveContent,
    );
    // Age the entry far past any lease to simulate suspension/sleep. There is
    // no mtime lease: a live pid is never ignored, so the contender must wait
    // then conflict, never acquire alongside the holder.
    fs.mtimes.set(`${lockDir}/n-live.json`, Date.now() - 60_000);
    const outcome = await withMutationLock(
      PROJECT,
      fs,
      () => Promise.resolve("should-not-run"),
      { timeoutMs: 60 },
    ).then(
      () => "ran",
      (error: unknown) => (error as { code?: string }).code ?? "threw",
    );
    expect(outcome).toBe("conflict");
    expect(fs.files.get(`${lockDir}/n-live.json`)).toBe(liveContent);
    await (fs as unknown as MutationFs).unlink!(`${lockDir}/n-live.json`);
  });

  it("dead candidates never block and are GC'd by the next holder", async () => {
    const fs = memFs();
    await createProfile({ name: "a", scope: "project", initial: { model: "one" } }, opts(fs));
    await fs.mkdir!(lockDir, { recursive: true });
    await (fs as unknown as MutationFs & { writeExclusive(p: string, c: string): Promise<void> }).writeExclusive(
      `${lockDir}/n-dead.json`,
      JSON.stringify({ pid: 2147483647, token: "dead", number: 1 }),
    );
    // A live contender must acquire immediately (dead is ignored), then GC
    // removes the dead file on the way in.
    const outcome = await withMutationLock(
      PROJECT,
      fs,
      () => Promise.resolve("ran"),
      { timeoutMs: 2_000 },
    );
    expect(outcome).toBe("ran");
    expect(await fs.readdir!(lockDir)).toHaveLength(0);
  });

  it("no background writes touch the lock while held", async () => {
    const fs = memFs();
    await createProfile({ name: "a", scope: "project", initial: { model: "one" } }, opts(fs));
    let releaseHold!: () => void;
    const holdGate = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    const holder = withMutationLock(PROJECT, fs, () => holdGate, { staleMs: 90 });
    let ownFile = "";
    for (let i = 0; i < 100; i++) {
      const names = await fs.readdir!(lockDir).catch(() => [] as string[]);
      const numbered = names.find((n) => n.startsWith("n-"));
      if (numbered) {
        ownFile = numbered;
        break;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(ownFile).not.toBe("");
    const before = (await fs.readdir!(lockDir)).slice().sort();
    const writesBefore = fs.writes.filter((w) => w.startsWith(lockDir)).length;
    // A successor waiter replaces nothing (unique files): it just adds its
    // own file. No heartbeat may rewrite or remove anything.
    await (fs as unknown as MutationFs & { writeExclusive(p: string, c: string): Promise<void> }).writeExclusive(
      `${lockDir}/n-waiter.json`,
      JSON.stringify({ pid: process.pid, token: "waiter", number: 999 }),
    );
    await new Promise((r) => setTimeout(r, 150));
    const during = (await fs.readdir!(lockDir)).slice().sort();
    expect(during).toContain(ownFile);
    expect(during).toContain("n-waiter.json");
    expect(fs.writes.filter((w) => w.startsWith(lockDir)).length).toBe(writesBefore);
    expect(before).toContain(ownFile);
    releaseHold();
    await holder;
    // Holder removed only its own file; the waiter remains.
    expect(fs.files.has(`${lockDir}/${ownFile}`)).toBe(false);
    expect(fs.files.has(`${lockDir}/n-waiter.json`)).toBe(true);
    await (fs as unknown as MutationFs).unlink!(`${lockDir}/n-waiter.json`);
  });

  it("never renames another participant's lock file", async () => {
    const fs = memFs();
    await createProfile({ name: "a", scope: "project", initial: { model: "one" } }, opts(fs));
    const renamed: Array<[string, string]> = [];
    const origRename = fs.rename.bind(fs);
    (fs as unknown as { rename: MutationFs["rename"] }).rename = (async (from: string, to: string) => {
      if (String(from).startsWith(lockDir) || String(to).startsWith(lockDir)) {
        renamed.push([String(from), String(to)]);
      }
      return origRename(from, to);
    }) as MutationFs["rename"];
    // Full election + release cycle with a dead file present: the protocol
    // must never rename any lock-dir entry (no claim/restore window).
    await fs.mkdir!(lockDir, { recursive: true });
    await (fs as unknown as MutationFs & { writeExclusive(p: string, c: string): Promise<void> }).writeExclusive(
      `${lockDir}/n-dead.json`,
      JSON.stringify({ pid: 2147483647, token: "dead", number: 1 }),
    );
    await withMutationLock(PROJECT, fs, () => Promise.resolve(undefined));
    expect(renamed).toHaveLength(0);
    expect(await fs.readdir!(lockDir)).toHaveLength(0);
  });
});

describe("profile mutate: absent-layer versioning (P1 review)", () => {
  it("two creators from absent: first wins, second conflicts", async () => {
    const fs = memFs();
    // Both clients read while the project file does not exist: no hash.
    const view = await readEditableProfile("scout", opts(fs));
    expect(view.sourceHash.project).toBeUndefined();
    // First creator asserts absence explicitly and wins.
    const first = await createProfile(
      { name: "first", scope: "project", initial: { model: "m1" } },
      opts(fs, { expectedSourceHash: null }),
    );
    expect(first.sourceHashAfter).toBeDefined();
    // Second stale creator still asserts absence: must conflict, never
    // silently replace the first value.
    const error = await expectMutationError(
      createProfile(
        { name: "second", scope: "project", initial: { model: "m2" } },
        opts(fs, { expectedSourceHash: null }),
      ),
      "conflict",
    );
    expect(error.message).toMatch(/absent|no file|stale/i);
    const after = await readEditableProfile("first", opts(fs));
    expect(after.effective?.model).toBe("m1");
    const missing = await readEditableProfile("second", opts(fs));
    expect(missing.exists).toBe(false);
  });

  it("explicit null succeeds when still absent", async () => {
    const fs = memFs();
    const receipt = await createProfile(
      { name: "solo", scope: "project", initial: { model: "m" } },
      opts(fs, { expectedSourceHash: null }),
    );
    expect(receipt.resolved?.model).toBe("m");
  });
});

describe("profile mutate: end-to-end no silent overwrite (P1 review)", () => {
  it("C cannot enter while B is active after its ownership check", async () => {
    const fs = memFs();
    const lockDir = `${PROJECT}.lock.d`;
    const first = await createProfile({ name: "a", scope: "project", initial: { model: "one" } }, opts(fs));
    const baseHash = first.sourceHashAfter!;
    // Pause B after it becomes holder and passes the pre-commit holder check
    // but before it commits: wrap the target re-read so B holds the lock
    // while paused. C must block until B commits, then fail on its stale
    // hash — never silently overwriting B.
    const origRead = fs.readFile.bind(fs);
    let bPaused = false;
    let releaseB!: () => void;
    const bGate = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    (fs as unknown as { readFile: MutationFs["readFile"] }).readFile = (async (p: string, enc: "utf8") => {
      const result = await origRead(p, enc);
      if (!bPaused && String(p) === PROJECT) {
        bPaused = true;
        setTimeout(releaseB, 80);
        await bGate;
      }
      return result;
    }) as MutationFs["readFile"];
    const bPromise = setProfileField(
      { name: "a", scope: "project", field: "model", value: "two" },
      opts(fs, { expectedSourceHash: baseHash }),
    );
    // Wait until B is paused holding the lock.
    for (let i = 0; i < 100 && !bPaused; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(bPaused).toBe(true);
    const holdersWhilePaused = await fs.readdir!(lockDir);
    expect(holdersWhilePaused).toHaveLength(1);
    const bFile = holdersWhilePaused[0];
    // C attempts while B holds: same-process contenders serialize on the
    // in-process mutex plus directory election, so C must wait and only enter
    // after B releases — never overlapping B, never seeing the path absent.
    let cEntered = false;
    const cAttempt = withMutationLock(
      PROJECT,
      fs,
      () => {
        cEntered = true;
        return Promise.resolve("c-entered");
      },
      { timeoutMs: 5_000 },
    ).then(
      () => "c-entered",
      (error: unknown) => (error as { code?: string }).code ?? "threw",
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(cEntered).toBe(false);
    expect(await fs.readdir!(lockDir)).toEqual([bFile]);
    const cOutcome = await cAttempt;
    expect(cOutcome).toBe("c-entered");
    expect(cEntered).toBe(true);
    const bReceipt = await bPromise;
    expect(bReceipt.resolved?.model).toBe("two");
    (fs as unknown as { readFile: MutationFs["readFile"] }).readFile =
      origRead as MutationFs["readFile"];
    // C retries the real write with the same stale base hash against B's
    // commit: must conflict, never silently overwrite "two" with "three".
    const cError = await expectMutationError(
      setProfileField({ name: "a", scope: "project", field: "model", value: "three" }, opts(fs, { expectedSourceHash: baseHash })),
      "conflict",
    );
    expect(cError.message).toMatch(/stale|changed|reload/i);
    const view = await readEditableProfile("a", opts(fs));
    expect(view.effective?.model).toBe("two");
    expect(await fs.readdir!(lockDir)).toHaveLength(0);
  });
});

describe("profile mutate: cross-scope serialization (P1 review)", () => {  it("concurrent user/project edits cannot commit a cycle neither validated", async () => {
    const fs = memFs({
      [USER]: "profiles:\n  a:\n    model: x\n",
      [PROJECT]: "profiles:\n  b:\n    model: y\n",
    });
    // Writer U makes user-scope `a` extend project-scope `b` while writer P
    // concurrently makes `b` extend `a`. Each half is valid alone; together
    // they form a cycle. Both locks are held per transaction, so the loser
    // revalidates against the winner's commit and fails instead of
    // committing an unvalidated graph.
    const results = await Promise.allSettled([
      patchProfile({ name: "a", scope: "user", patch: { extends: "b" } }, opts(fs)),
      patchProfile({ name: "b", scope: "project", patch: { extends: "a" } }, opts(fs)),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(ProfileMutationError);
    expect(["resolve-failed", "validation-failed"]).toContain((reason as ProfileMutationError).code);
    // The committed graph stays valid: exactly one extends edge landed.
    const viewA = await readEditableProfile("a", opts(fs));
    const viewB = await readEditableProfile("b", opts(fs));
    expect(viewA.validation.ok).toBe(true);
    expect(viewB.validation.ok).toBe(true);
    const userText = fs.files.get(USER) ?? "";
    const projectText = fs.files.get(PROJECT) ?? "";
    const edges = [
      userText.includes("extends: b"),
      projectText.includes("extends: a"),
    ].filter(Boolean);
    expect(edges).toHaveLength(1);
  });

  it("an out-of-band opposite-layer edit before commit rejects the write", async () => {
    const fs = memFs({
      [USER]: "profiles:\n  a:\n    model: x\n",
      [PROJECT]: "profiles:\n  b:\n    model: y\n",
    });
    // An external editor rewrites the project layer after merged-graph
    // validation but before commit: inject on the pre-commit revalidation
    // read of the project file (initial load + one pre-commit re-read
    // precede it), so the transaction must see the changed opposite layer
    // and conflict instead of committing an unvalidated a -> b -> a graph.
    const origRead = fs.readFile.bind(fs);
    let projectReads = 0;
    (fs as unknown as { readFile: MutationFs["readFile"] }).readFile = (async (p: string, enc: "utf8") => {
      if (String(p) === PROJECT) {
        projectReads += 1;
        if (projectReads === 2) {
          fs.files.set(PROJECT, "profiles:\n  b:\n    extends: a\n    model: y\n");
        }
      }
      return origRead(p, enc);
    }) as MutationFs["readFile"];
    const error = await expectMutationError(
      patchProfile({ name: "a", scope: "user", patch: { extends: "b" } }, opts(fs)),
      "conflict",
    );
    expect(error.message).toMatch(/stale|changed|reload/i);
    // Target layer untouched; the external opposite-layer edit stands alone
    // (no cycle was ever committed).
    expect(fs.files.get(USER)).toBe("profiles:\n  a:\n    model: x\n");
    const viewB = await readEditableProfile("b", opts(fs));
    expect(viewB.validation.ok).toBe(true);
  });

  it("complementary store permissions cannot commit a cycle neither validated", async () => {
    // P1 asymmetric permissions: process U writes the user store but gets
    // EACCES on the project lock; process P is mirrored. Both share one
    // in-memory filesystem (separate adapters, complementary denials) so
    // the shared pair lock — not silent skipping — must serialize them.
    const files = new Map<string, string>([
      [USER, "profiles:\n  a:\n    model: x\n"],
      [PROJECT, "profiles:\n  b:\n    model: y\n"],
    ]);
    const shared = { files, mtimes: new Map<string, number>(), dirs: new Set<string>() };
    const fsU = memFs({}, { denied: ["/repo/p/.pi"], shared });
    const fsP = memFs({}, { denied: ["/home/u/.pi/agent"], shared });
    // Spy: the shared pair lock (not silent skipping) must engage for both
    // participants despite their complementary denials.
    const pairMkdirs: string[] = [];
    for (const fs of [fsU, fsP]) {
      const origMkdir = fs.mkdir!.bind(fs);
      (fs as unknown as { mkdir: NonNullable<MutationFs["mkdir"]> }).mkdir = (async (
        p: string,
        o?: { recursive: boolean },
      ) => {
        if (String(p).includes("orca-pi-profiles-")) pairMkdirs.push(String(p));
        return origMkdir(p, o);
      }) as NonNullable<MutationFs["mkdir"]>;
    }
    const results = await Promise.allSettled([
      patchProfile({ name: "a", scope: "user", patch: { extends: "b" } }, opts(fsU)),
      patchProfile({ name: "b", scope: "project", patch: { extends: "a" } }, opts(fsP)),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(ProfileMutationError);
    expect(["resolve-failed", "validation-failed", "conflict"]).toContain(
      (reason as ProfileMutationError).code,
    );
    // Exactly one extends edge landed; the final graph stays valid.
    const probe = memFs({}, { shared });
    const viewA = await readEditableProfile("a", opts(probe));
    const viewB = await readEditableProfile("b", opts(probe));
    expect(viewA.validation.ok).toBe(true);
    expect(viewB.validation.ok).toBe(true);
    const edges = [
      (files.get(USER) ?? "").includes("extends: b"),
      (files.get(PROJECT) ?? "").includes("extends: a"),
    ].filter(Boolean);
    expect(edges).toHaveLength(1);
    expect(pairMkdirs.length).toBeGreaterThan(0);
  });

  it("a live foreign ticket in a denied opposite lock fails closed", async () => {
    // The opposite store denies writes AND its lock dir shows a live
    // foreign-namespace ticket: no shared pair lock could reach that
    // contender, so fail closed instead of committing uncoordinated.
    const fs = memFs(
      {
        [USER]: "profiles:\n  a:\n    model: x\n",
        [PROJECT]: "profiles:\n  b:\n    model: y\n",
      },
      { denied: ["/repo/p/.pi"] },
    );
    const foreignContent = JSON.stringify({
      pid: 2147483647,
      token: "foreign-holder",
      number: 1,
      origin: "other-host|linux|wsl",
    });
    fs.files.set(`${PROJECT}.lock.d/n-foreign.json`, foreignContent);
    const error = await expectMutationError(
      patchProfile({ name: "a", scope: "user", patch: { extends: "b" } }, opts(fs)),
      "conflict",
    );
    expect(error.message).toMatch(/single environment|coordinat/i);
    expect(fs.files.get(USER)).toBe("profiles:\n  a:\n    model: x\n");
    expect(fs.files.get(`${PROJECT}.lock.d/n-foreign.json`)).toBe(foreignContent);
  });
});

describe("profile mutate: unwritable opposite store (P1 review)", () => {
  it("user-scope write succeeds with an unwritable project store", async () => {
    const fs = memFs(
      {
        [USER]: "profiles:\n  a:\n    model: x\n",
        [PROJECT]: "profiles:\n  b:\n    model: y\n",
      },
      { denied: ["/repo/p/.pi"] },
    );
    // The opposite (project) layer stays readable; only its lock/store
    // writes are denied. The target mutation must still succeed without
    // creating anything next to the opposite config.
    const receipt = await setProfileField(
      { name: "a", scope: "user", field: "model", value: "z" },
      opts(fs),
    );
    expect(receipt.resolved?.model).toBe("z");
    expect(fs.files.get(USER)).toContain("model: z");
    expect(fs.files.get(PROJECT)).toBe("profiles:\n  b:\n    model: y\n");
    expect(await fs.readdir!(`${USER}.lock.d`)).toHaveLength(0);
    expect(fs.files.has(`${PROJECT}.lock.d/c-x`)).toBe(false);
  });

  it("project-scope write succeeds with an unwritable user store", async () => {
    const fs = memFs(
      {
        [USER]: "profiles:\n  a:\n    model: x\n",
        [PROJECT]: "profiles:\n  b:\n    model: y\n",
      },
      { denied: ["/home/u/.pi/agent"] },
    );
    const receipt = await setProfileField(
      { name: "b", scope: "project", field: "model", value: "w" },
      opts(fs),
    );
    expect(receipt.resolved?.model).toBe("w");
    expect(fs.files.get(PROJECT)).toContain("model: w");
    expect(fs.files.get(USER)).toBe("profiles:\n  a:\n    model: x\n");
    expect(await fs.readdir!(`${PROJECT}.lock.d`)).toHaveLength(0);
  });

  it("a denied target store still fails closed", async () => {
    const fs = memFs({}, { denied: ["/home/u/.pi/agent"] });
    const error = await expectMutationError(
      createProfile({ name: "x", scope: "user", initial: { model: "m" } }, opts(fs)),
      "atomic-write-failed",
    );
    expect(error.message).toMatch(/config directory|lock directory/i);
    expect(fs.files.has(USER)).toBe(false);
  });
});

describe("profile mutate: absent opposite store stays absent (P2 review)", () => {  it("user-scope write leaves an absent writable project dir absent", async () => {
    const fs = memFs(
      { [USER]: "profiles:\n  a:\n    model: x\n" },
      { modelDirs: true },
    );
    const receipt = await setProfileField(
      { name: "a", scope: "user", field: "model", value: "z" },
      opts(fs),
    );
    expect(receipt.resolved?.model).toBe("z");
    expect(fs.files.get(USER)).toContain("model: z");
    // Nothing was materialized next to the untargeted opposite config:
    // no project file, no lock dir, no `.pi` tree (files AND directories).
    expect(fs.files.has(PROJECT)).toBe(false);
    expect([...fs.files.keys()].some((k) => k.startsWith("/repo/p/.pi"))).toBe(false);
    expect([...fs.dirs].some((d) => d === "/repo/p/.pi" || d.startsWith("/repo/p/.pi/"))).toBe(false);
  });

  it("project-scope write leaves an absent writable user dir absent", async () => {
    const fs = memFs(
      { [PROJECT]: "profiles:\n  b:\n    model: y\n" },
      { modelDirs: true },
    );
    const receipt = await setProfileField(
      { name: "b", scope: "project", field: "model", value: "w" },
      opts(fs),
    );
    expect(receipt.resolved?.model).toBe("w");
    expect(fs.files.get(PROJECT)).toContain("model: w");
    expect(fs.files.has(USER)).toBe(false);
    expect([...fs.files.keys()].some((k) => k.startsWith("/home/u/.pi"))).toBe(false);
    // The full created ancestor chain is undone: neither `~/.pi/agent` nor
    // its parent `~/.pi` (both absent before use) may leak.
    expect([...fs.dirs].some((d) => d === "/home/u/.pi" || d.startsWith("/home/u/.pi/"))).toBe(false);
  });

  it("concurrent dual-absent creates serialize without losing either", async () => {
    const fs = memFs({}, { modelDirs: true });
    // Neither config file exists: each transaction coordinates through the
    // shared opposite file lock (transiently created, cleaned on release)
    // rather than an OS-local side channel, so both commits land.
    const results = await Promise.allSettled([
      createProfile({ name: "u1", scope: "user", initial: { model: "a" } }, opts(fs)),
      createProfile({ name: "p1", scope: "project", initial: { model: "b" } }, opts(fs)),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(fs.files.get(USER)).toContain("u1:");
    expect(fs.files.get(PROJECT)).toContain("p1:");
    const viewU = await readEditableProfile("u1", opts(fs));
    const viewP = await readEditableProfile("p1", opts(fs));
    expect(viewU.validation.ok).toBe(true);
    expect(viewP.validation.ok).toBe(true);
  });
});

describe("profile mutate: repair of an invalid target layer (P1 review)", () => {
  const BROKEN_PROJECT = "profiles:\n  custom:\n    model: openai/gpt-5.6\n    thinking: ultra\n";

  it("reads an invalid custom profile as existing with issues", async () => {
    const fs = memFs({ [PROJECT]: BROKEN_PROJECT });
    const view = await readEditableProfile("custom", opts(fs));
    expect(view.exists).toBe(true);
    expect(view.validation.ok).toBe(false);
    expect(view.validation.code).toBe("load-failed");
    expect(view.validation.issues?.some((issue) => issue.path.includes("thinking"))).toBe(true);
    expect(view.source.project).toMatchObject({ model: "openai/gpt-5.6", thinking: "ultra" });
    expect(view.sourceHash.project).toBe(hashSourceText(BROKEN_PROJECT));
  });

  it("repairs the invalid field with an expected hash and commits", async () => {
    const fs = memFs({ [PROJECT]: BROKEN_PROJECT });
    const before = await readEditableProfile("custom", opts(fs));
    const receipt = await setProfileField(
      { name: "custom", scope: "project", field: "thinking", value: "high" },
      opts(fs, { expectedSourceHash: before.sourceHash.project }),
    );
    expect(receipt.resolved?.thinking).toBe("high");
    const text = fs.files.get(PROJECT)!;
    expect(text).toContain("high");
    expect(text).not.toContain("ultra");
    const after = await readEditableProfile("custom", opts(fs));
    expect(after.validation.ok).toBe(true);
    expect(after.effective?.thinking).toBe("high");
  });

  it("an unrelated mutation that keeps the invalid value fails with bytes unchanged", async () => {
    const fs = memFs({ [PROJECT]: BROKEN_PROJECT });
    const error = await expectMutationError(
      setProfileField({ name: "custom", scope: "project", field: "model", value: "other" }, opts(fs)),
      "validation-failed",
    );
    expect(error.message).toMatch(/thinking|ultra|invalid/i);
    expect(fs.files.get(PROJECT)).toBe(BROKEN_PROJECT);
  });
});

describe("profile mutate: invalid on-disk read contract (P1 review)", () => {  const INVALID_PROJECT =
    "profiles:\n  scout:\n    model: anthropic/claude-haiku\n    thinking: ultra\n";

  it("returns a structured invalid view with issues + hashes for a schema-invalid file", async () => {
    const fs = memFs({
      [USER]: "profiles:\n  good:\n    model: m\n",
      [PROJECT]: INVALID_PROJECT,
    });
    const view = await readEditableProfile("scout", opts(fs));
    expect(view.validation.ok).toBe(false);
    expect(view.validation.code).toBe("load-failed");
    expect(view.validation.issues?.length).toBeGreaterThan(0);
    expect(view.validation.issues?.some((issue) => issue.path.includes("thinking"))).toBe(true);
    // Hashes + layer existence survive so the UI can show diagnostics and
    // the caller keeps a version token for the broken file.
    expect(view.sourceHash.project).toBe(hashSourceText(INVALID_PROJECT));
    expect(view.sourceHash.user).toBeDefined();
    expect(view.config.projectExists).toBe(true);
    expect(view.config.userExists).toBe(true);
    // P2: the hand-edited (invalid) source values stay visible next to the
    // errors — the UI renders what is broken, not just issue paths.
    expect(view.source.project).toMatchObject({ model: "anthropic/claude-haiku", thinking: "ultra" });
    expect(view.fields.thinking?.project).toBe("ultra");
    expect(view.fields.model?.project).toBe("anthropic/claude-haiku");
  });

  it("an unknown name with an invalid file still carries the load issues", async () => {
    const fs = memFs({ [PROJECT]: INVALID_PROJECT });
    const view = await readEditableProfile("nope", opts(fs));
    expect(view.exists).toBe(false);
    expect(view.validation.ok).toBe(false);
    expect(view.validation.issues?.length).toBeGreaterThan(0);
    expect(view.sourceHash.project).toBe(hashSourceText(INVALID_PROJECT));
  });
});

describe("profile mutate: bakery choosing gate (P1 review)", () => {
  const lockDir = `${PROJECT}.lock.d`;

  it("a contender published late cannot outrank: choosing blocks entry", async () => {
    const fs = memFs();
    await createProfile({ name: "a", scope: "project", initial: { model: "one" } }, opts(fs));
    await fs.mkdir!(lockDir, { recursive: true });
    // B announces (choosing) but pauses before publishing its number — the
    // exact late-publisher interleaving. A must wait on the live choosing
    // flag instead of entering and later being retroactively outranked.
    await (fs as unknown as MutationFs & { writeExclusive(p: string, c: string): Promise<void> }).writeExclusive(
      `${lockDir}/c-paused-b.choosing`,
      JSON.stringify({ pid: process.pid, token: "paused-B" }),
    );
    let entered = false;
    const contender = withMutationLock(
      PROJECT,
      fs,
      () => {
        entered = true;
        return Promise.resolve("entered");
      },
      { timeoutMs: 2_000 },
    );
    await new Promise((r) => setTimeout(r, 60));
    // Still waiting on B's choosing; B's flag untouched (nobody deletes
    // another participant's file).
    expect(entered).toBe(false);
    expect(fs.files.has(`${lockDir}/c-paused-b.choosing`)).toBe(true);
    // B resumes: publishes a larger number and clears choosing. A (number 1)
    // outranks B (999) and enters.
    await (fs as unknown as MutationFs & { writeExclusive(p: string, c: string): Promise<void> }).writeExclusive(
      `${lockDir}/n-paused-b.json`,
      JSON.stringify({ pid: process.pid, token: "paused-B", number: 999 }),
    );
    await (fs as unknown as MutationFs).unlink!(`${lockDir}/c-paused-b.choosing`);
    expect(await contender).toBe("entered");
    expect(entered).toBe(true);
    // A cleaned up exactly its own files; the simulated B number file (a
    // foreign live entry the test harness owns) is never touched by A.
    expect(await fs.readdir!(lockDir)).toEqual(["n-paused-b.json"]);
    await (fs as unknown as MutationFs).unlink!(`${lockDir}/n-paused-b.json`);
    expect(await fs.readdir!(lockDir)).toHaveLength(0);
  });

  it("a choosing-to-number transition mid-scan cannot hide a smaller ticket", async () => {
    const fs = memFs();
    await createProfile({ name: "a", scope: "project", initial: { model: "one" } }, opts(fs));
    await fs.mkdir!(lockDir, { recursive: true });
    // Contender B announces (choosing) with a smaller ticket (number 0 beats
    // any elected number >= 1) but pauses before publishing its number file.
    const bChoosing = `${lockDir}/c-small-b.choosing`;
    const bNumber = `${lockDir}/n-small-b.json`;
    const bNumberContent = JSON.stringify({ pid: process.pid, token: "small-B", number: 0 });
    await (fs as unknown as MutationFs & { writeExclusive(p: string, c: string): Promise<void> }).writeExclusive(
      bChoosing,
      JSON.stringify({ pid: process.pid, token: "small-B" }),
    );
    let entered = false;
    const contender = withMutationLock(
      PROJECT,
      fs,
      () => {
        entered = true;
        return Promise.resolve("entered");
      },
      { timeoutMs: 2_000 },
    );
    // Wait until the waiter is spinning on B's choosing flag (its own number
    // is published and visible).
    for (let i = 0; i < 100; i++) {
      const names = await fs.readdir!(lockDir).catch(() => [] as string[]);
      if (names.some((n) => n.startsWith("n-") && n !== "n-small-b.json")) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(entered).toBe(false);
    // Pause the waiter after its readdir snapshot returns B's choosing
    // filename: publish B's smaller number and remove choosing, then resume.
    // The waiter must follow the vanished choosing entry to B's number file
    // and keep waiting — never enter ahead of the smaller ticket.
    const origRead = fs.readFile.bind(fs);
    let paused = false;
    let releaseWaiter!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseWaiter = resolve;
    });
    (fs as unknown as { readFile: MutationFs["readFile"] }).readFile = (async (p: string, enc: "utf8") => {
      if (!paused && String(p) === bChoosing) {
        paused = true;
        await gate;
      }
      return origRead(p, enc);
    }) as MutationFs["readFile"];
    // Give the waiter a chance to reach the paused read, then transition B.
    for (let i = 0; i < 100 && !paused; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(paused).toBe(true);
    await (fs as unknown as MutationFs & { writeExclusive(p: string, c: string): Promise<void> }).writeExclusive(
      bNumber,
      bNumberContent,
    );
    await (fs as unknown as MutationFs).unlink!(bChoosing);
    releaseWaiter();
    // Let several election rounds run: the waiter must still not have
    // entered, and B's smaller ticket must be untouched.
    await new Promise((r) => setTimeout(r, 80));
    expect(entered).toBe(false);
    expect(fs.files.get(bNumber)).toBe(bNumberContent);
    // B releases: the waiter (larger number) then enters and cleans up only
    // its own files.
    await (fs as unknown as MutationFs).unlink!(bNumber);
    expect(await contender).toBe("entered");
    expect(await fs.readdir!(lockDir)).toHaveLength(0);
  });

  it("a contender paused before choosing publication survives a releaser's cleanup", async () => {
    // P1: A releases (deleting its ticket) and its empty-dir cleanup removes
    // lockDir while cross-process contender B has mkdir'd but not yet
    // published choosing. B's exclusive creation then fails ENOENT; B must
    // re-prepare and acquire instead of failing the mutation.
    const fs = memFs(
      { [PROJECT]: "profiles:\n  a:\n    model: m\n" },
      { modelDirs: true },
    );
    const dir = `${PROJECT}.lock.d`;
    // Cross-process holder A (live, smallest ticket), simulated with direct
    // file ops to bypass this process's mutex.
    await fs.mkdir!(dir, { recursive: true });
    await (fs as unknown as MutationFs & { writeExclusive(p: string, c: string): Promise<void> }).writeExclusive(
      `${dir}/n-a.json`,
      JSON.stringify({ pid: process.pid, token: "a-holder", number: 1 }),
    );
    // Pause B's acquisition after lock-dir preparation, before its choosing
    // file is created.
    const origExclusive = (
      fs as unknown as MutationFs & { writeExclusive(p: string, c: string): Promise<void> }
    ).writeExclusive.bind(fs);
    let paused = false;
    let releaseB!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    (
      fs as unknown as MutationFs & { writeExclusive(p: string, c: string): Promise<void> }
    ).writeExclusive = (async (p: string, c: string) => {
      if (!paused && String(p).endsWith(".choosing")) {
        paused = true;
        await gate;
      }
      return origExclusive(p, c);
    }) as MutationFs["writeExclusive"];
    let entered = false;
    const contender = withMutationLock(
      PROJECT,
      fs,
      () => {
        entered = true;
        return Promise.resolve("entered");
      },
      { timeoutMs: 5_000 },
    );
    for (let i = 0; i < 100 && !paused; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(paused).toBe(true);
    expect(entered).toBe(false);
    // A finishes: deletes its ticket; the empty lock dir is cleaned up.
    await (fs as unknown as MutationFs).unlink!(`${dir}/n-a.json`);
    expect(await fs.readdir!(dir)).toHaveLength(0);
    await fs.rmdir!(dir);
    // B resumes into a missing directory: it must re-prepare, acquire, and
    // complete — never fail with ENOENT.
    releaseB();
    expect(await contender).toBe("entered");
    expect(entered).toBe(true);
    expect(await fs.readdir!(dir)).toHaveLength(0);
  });

  it("a timed-out contender removes its own files and wedges nothing", async () => {
    const fs = memFs();
    await createProfile({ name: "a", scope: "project", initial: { model: "one" } }, opts(fs));
    await fs.mkdir!(lockDir, { recursive: true });
    // External live holder with the smallest number.
    await (fs as unknown as MutationFs & { writeExclusive(p: string, c: string): Promise<void> }).writeExclusive(
      `${lockDir}/n-holder.json`,
      JSON.stringify({ pid: process.pid, token: "holder", number: 1 }),
    );
    const outcome = await withMutationLock(
      PROJECT,
      fs,
      () => Promise.resolve("should-not-run"),
      { timeoutMs: 60 },
    ).then(
      () => "ran",
      (error: unknown) => (error as { code?: string }).code ?? "threw",
    );
    expect(outcome).toBe("conflict");
    // Only the external holder remains: the timed-out contender cleaned up
    // its own choosing + number files, leaving no orphaned live candidate.
    expect(await fs.readdir!(lockDir)).toEqual(["n-holder.json"]);
    // Release the external holder: a subsequent mutation in the same
    // long-lived process must succeed (no orphan wedge).
    await (fs as unknown as MutationFs).unlink!(`${lockDir}/n-holder.json`);
    const receipt = await setProfileField(
      { name: "a", scope: "project", field: "model", value: "two" },
      opts(fs),
    );
    expect(receipt.resolved?.model).toBe("two");
    expect(await fs.readdir!(lockDir)).toHaveLength(0);
  });

  it("a later contender paused in choosing does not displace the holder", async () => {
    const fs = memFs({
      [PROJECT]: "profiles:\n  a:\n    model: good\n",
    });
    // Inject a live cross-process contender paused between publishing its
    // choosing flag and its number file, once the holder has entered the
    // transaction body (first read of the TARGET file — election and the
    // opposite-presence probe use other paths, so this is strictly
    // post-election). The holder's final verification must ignore it — the
    // late contender necessarily picks a larger number — instead of
    // spuriously conflicting an ordinary contended write.
    const lockDirs = [`${USER}.lock.d`, `${PROJECT}.lock.d`];
    const laterChoosing = JSON.stringify({ pid: process.pid, token: "later" });
    const origRead = fs.readFile.bind(fs);
    let injected = false;
    (fs as unknown as { readFile: MutationFs["readFile"] }).readFile = (async (p: string, enc: "utf8") => {
      if (!injected && String(p) === PROJECT) {
        injected = true;
        for (const dir of lockDirs) {
          fs.files.set(`${dir}/c-later.choosing`, laterChoosing);
        }
      }
      return origRead(p, enc);
    }) as MutationFs["readFile"];
    const receipt = await setProfileField(
      { name: "a", scope: "project", field: "model", value: "better" },
      opts(fs),
    );
    expect(receipt.resolved?.model).toBe("better");
    expect(injected).toBe(true);
    // The late contender's choosing flags were never deleted (only their
    // owner removes them) and the holder committed normally.
    for (const dir of lockDirs) {
      expect(fs.files.get(`${dir}/c-later.choosing`)).toBe(laterChoosing);
      await (fs as unknown as MutationFs).unlink!(`${dir}/c-later.choosing`);
    }
  });

  it("a live foreign-namespace ticket is never treated as dead (Windows/WSL)", async () => {
    const fs = memFs();
    await createProfile({ name: "a", scope: "project", initial: { model: "one" } }, opts(fs));
    await fs.mkdir!(lockDir, { recursive: true });
    // A ticket from another OS/PID namespace (e.g. native Windows vs WSL):
    // its pid probe would report ESRCH/dead here, but cross-namespace death
    // can never be proven, so it must block contenders and survive GC.
    const foreignContent = JSON.stringify({
      pid: 2147483647,
      token: "foreign-holder",
      number: 1,
      origin: "other-host|win32|native",
    });
    await (fs as unknown as MutationFs & { writeExclusive(p: string, c: string): Promise<void> }).writeExclusive(
      `${lockDir}/n-foreign.json`,
      foreignContent,
    );
    const outcome = await withMutationLock(
      PROJECT,
      fs,
      () => Promise.resolve("should-not-run"),
      { timeoutMs: 60 },
    ).then(
      () => "ran",
      (error: unknown) => (error as { code?: string }).code ?? "threw",
    );
    expect(outcome).toBe("conflict");
    // Never ignored, never GC'd: still exactly the foreign file.
    expect(fs.files.get(`${lockDir}/n-foreign.json`)).toBe(foreignContent);
    expect(await fs.readdir!(lockDir)).toEqual(["n-foreign.json"]);
    await (fs as unknown as MutationFs).unlink!(`${lockDir}/n-foreign.json`);
  });
});

describe("profile mutate: single-filesystem boundary (P2 review)", () => {  it("emptied-layer removal without unlink fails closed, never touches the host FS", async () => {
    const full = memFs({
      [PROJECT]: "profiles:\n  solo:\n    model: m\n",
    });
    // Injected writable adapter that omits `unlink` (like some embedders).
    const { unlink: _dropped, ...rest } = full as unknown as Record<string, unknown>;
    void _dropped;
    const fs = rest as unknown as MutationFs;
    const error = await expectMutationError(
      deleteProfile({ name: "solo", scope: "project" }, opts(fs)),
      "atomic-write-failed",
    );
    expect(error.message).toMatch(/does not support deletion|left unchanged/i);
    // The injected file is untouched; nothing was deleted anywhere.
    expect(full.files.get(PROJECT)).toContain("solo:");
  });
});

describe("profile mutate: PID-namespace origin (P1 review)", () => {
  const lockDir = `${PROJECT}.lock.d`;

  function withDistro<T>(distro: string | undefined, fn: () => Promise<T>): Promise<T> {
    const key = "WSL_DISTRO_NAME";
    const had = Object.hasOwn(process.env, key);
    const prev = process.env[key];
    if (distro === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = distro;
    }
    return fn().finally(() => {
      if (had) process.env[key] = prev as string;
      else delete process.env[key];
    });
  }

  it("lockOrigin distinguishes WSL distributions sharing host and platform", async () => {
    const ubuntu = await withDistro("Ubuntu", () => Promise.resolve(lockOrigin()));
    const debian = await withDistro("Debian", () => Promise.resolve(lockOrigin()));
    expect(ubuntu).toContain("Ubuntu");
    expect(debian).toContain("Debian");
    expect(ubuntu).not.toBe(debian);
  });

  it("a bare-wsl ticket is foreign once the local distro is known", async () => {
    // Old origins collapsed every distro to a bare `wsl` literal, so Ubuntu
    // and Debian compared equal and a dead-pid probe decided liveness across
    // PID namespaces. With distro-qualified origins the same ticket is
    // foreign here: it must block and survive GC even though its pid probes
    // dead locally.
    await withDistro("Debian", async () => {
      const fs = memFs();
      await createProfile({ name: "a", scope: "project", initial: { model: "one" } }, opts(fs));
      await fs.mkdir!(lockDir, { recursive: true });
      const legacyWslOrigin = `${hostname()}|${process.platform}|wsl`;
      expect(lockOrigin()).not.toBe(legacyWslOrigin);
      const content = JSON.stringify({
        pid: 2147483647,
        token: "legacy-wsl-holder",
        number: 1,
        origin: legacyWslOrigin,
      });
      await (fs as unknown as MutationFs & { writeExclusive(p: string, c: string): Promise<void> }).writeExclusive(
        `${lockDir}/n-legacy.json`,
        content,
      );
      const outcome = await withMutationLock(
        PROJECT,
        fs,
        () => Promise.resolve("should-not-run"),
        { timeoutMs: 60 },
      ).then(
        () => "ran",
        (error: unknown) => (error as { code?: string }).code ?? "threw",
      );
      expect(outcome).toBe("conflict");
      expect(fs.files.get(`${lockDir}/n-legacy.json`)).toBe(content);
      await (fs as unknown as MutationFs).unlink!(`${lockDir}/n-legacy.json`);
    });
  });
});

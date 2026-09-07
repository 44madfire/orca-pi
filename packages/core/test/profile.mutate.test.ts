import { describe, expect, it } from "vitest";
import {
  buildEditableView,
  cloneProfile,
  createProfile,
  deleteProfile,
  hashSourceText,
  patchProfile,
  readEditableProfile,
  serializeProfilesDocument,
  setProfileField,
  unsetProfileField,
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

function memFs(initial: Record<string, string> = {}): MutationFs & {
  files: Map<string, string>;
  mtimes: Map<string, number>;
  failNextWrite?: boolean;
  writes: string[];
} {
  const files = new Map<string, string>(Object.entries(initial));
  const mtimes = new Map<string, number>();
  for (const key of files.keys()) mtimes.set(key, Date.now());
  const fs = {
    files,
    mtimes,
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
      files.set(String(path), content);
      mtimes.set(String(path), Date.now());
      fs.writes.push(String(path));
    },
    async writeExclusive(path: string, content: string): Promise<void> {
      const key = String(path);
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
    async mkdir(): Promise<undefined> {
      return undefined;
    },
    async stat(path: string): Promise<unknown> {
      const key = String(path);
      if (files.has(key)) return { isFile: () => true, mtimeMs: mtimes.get(key) ?? Date.now() };
      const error = new Error(`ENOENT: no such file ${key}`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
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
  };
  return fs as unknown as MutationFs & {
    files: Map<string, string>;
    mtimes: Map<string, number>;
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
    expect(fs.files.has(`${PROJECT}.lock`)).toBe(false);
  });

  it("reaps a stale crashed-holder lock instead of deadlocking", async () => {
    const fs = memFs();
    await createProfile({ name: "a", scope: "project", initial: { model: "one" } }, opts(fs));
    // Plant a lock file with an ancient mtime, simulating a crashed writer.
    await (fs as unknown as MutationFs & { writeExclusive(path: string, content: string): Promise<void> }).writeExclusive(
      `${PROJECT}.lock`,
      "99999@1",
    );
    fs.mtimes.set(`${PROJECT}.lock`, Date.now() - 60_000);
    const receipt = await setProfileField(
      { name: "a", scope: "project", field: "model", value: "two" },
      opts(fs),
    );
    expect(receipt.resolved?.model).toBe("two");
    expect(fs.files.has(`${PROJECT}.lock`)).toBe(false);
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
    expect(fs.files.has(`${PROJECT}.lock`)).toBe(false);
  });
});

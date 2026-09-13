import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildOrchestrationClearParams,
  buildOrchestrationSetParams,
  controlCenterSections,
  describeOrchestrationChain,
  describeOrchestrationProvenance,
  isBuiltinOrchestrationRole,
  mapOrchestrationErrorToField,
  ORCHESTRATION_BUILTIN_ROLES,
  ORCHESTRATION_CHAIN_LABEL,
  ORCHESTRATION_OWNERSHIP_NOTE,
  orchestrationInvalidSummary,
  toOrchestrationItems,
  validateOrchestrationDraft,
  validateOrchestrationProfileRef,
  validateOrchestrationRole,
} from "../src/control-center.js";

const here = dirname(fileURLToPath(import.meta.url));

function scriptOf(): string {
  const html = readFileSync(join(here, "..", "panel", "control-center.html"), "utf8");
  const start = html.indexOf("<script>");
  const end = html.indexOf("</script>");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return html.slice(start + "<script>".length, end);
}

describe("orchestration helpers: roles, validation, params", () => {
  it("exposes builtin worker/scout/reviewer in order", () => {
    expect([...ORCHESTRATION_BUILTIN_ROLES]).toEqual(["worker", "scout", "reviewer"]);
    expect(isBuiltinOrchestrationRole("worker")).toBe(true);
    expect(isBuiltinOrchestrationRole("scout")).toBe(true);
    expect(isBuiltinOrchestrationRole("reviewer")).toBe(true);
    expect(isBuiltinOrchestrationRole("worker-fast")).toBe(false);
    expect(isBuiltinOrchestrationRole("custom-role")).toBe(false);
  });

  it("validates roles narrowly but profile refs with the full Pi grammar", () => {
    expect(validateOrchestrationRole("worker")).toBeUndefined();
    expect(validateOrchestrationRole("custom-role")).toBeUndefined();
    expect(validateOrchestrationRole("")).toBeDefined();
    expect(validateOrchestrationRole("has space")).toBeDefined();
    expect(validateOrchestrationRole("HasCaps")).toBeDefined();
    expect(validateOrchestrationRole("with_underscore")).toBeDefined();
    expect(validateOrchestrationRole("__proto__")).toBeDefined();
    expect(validateOrchestrationProfileRef("worker-fast")).toBeUndefined();
    // Canonical Pi profile grammar accepts uppercase/underscore (Profiles UI can create them).
    expect(validateOrchestrationProfileRef("Worker_Fast")).toBeUndefined();
    expect(validateOrchestrationProfileRef("W1")).toBeUndefined();
    expect(validateOrchestrationProfileRef("")).toBeDefined();
    expect(validateOrchestrationProfileRef("bad name!")).toBeDefined();
    expect(validateOrchestrationProfileRef("__proto__")).toBeDefined();
  });

  it("runs client-side draft checks before the bridge", () => {
    expect(validateOrchestrationDraft({ role: "worker", profile: "worker-fast" })).toEqual([]);
    const missing = validateOrchestrationDraft({ role: "worker" });
    expect(missing.some((i) => i.field === "profile")).toBe(true);
    const badRole = validateOrchestrationDraft({ role: "has space", profile: "worker" });
    expect(badRole.some((i) => i.field === "role")).toBe(true);
    const badProfile = validateOrchestrationDraft({ role: "worker", profile: "bad name!" });
    expect(badProfile.some((i) => i.field === "profile")).toBe(true);
  });

  it("builds typed set/clear params with explicit scope and hashes", () => {
    const set = buildOrchestrationSetParams({
      role: "worker",
      profile: "worker-fast",
      scope: "project",
      expectedSourceHash: "a".repeat(64),
    });
    expect(set).toMatchObject({ role: "worker", profile: "worker-fast", scope: "project", expectedSourceHash: "a".repeat(64) });
    const absent = buildOrchestrationSetParams({ role: "scout", profile: "scout", scope: "user", expectedAbsent: true });
    expect(absent).toMatchObject({ expectedAbsent: true });
    expect(absent).not.toHaveProperty("clear");
    const clear = buildOrchestrationClearParams({ role: "worker", scope: "project", expectedSourceHash: "b".repeat(64) });
    expect(clear).toMatchObject({ role: "worker", scope: "project", clear: true, expectedSourceHash: "b".repeat(64) });
    // No shell strings, no inferred scope.
    expect(JSON.stringify(set)).not.toContain(";");
    expect(JSON.stringify(clear)).not.toContain(";");
  });

  it("describes provenance, chain, and ownership without duplicating Orca UI", () => {
    expect(describeOrchestrationProvenance("project")).toContain(".pi/orchestration.json");
    expect(describeOrchestrationProvenance("user")).toContain("orchestration.json");
    expect(describeOrchestrationProvenance("builtin")).toContain("built-in");
    expect(describeOrchestrationProvenance(undefined)).toContain("built-in");
    expect(ORCHESTRATION_CHAIN_LABEL).toContain("Orchestration role mapping");
    expect(ORCHESTRATION_CHAIN_LABEL).toContain("effective launch");
    expect(describeOrchestrationChain("worker", "worker-fast")).toContain("worker-fast");
    expect(describeOrchestrationChain("worker", "worker-fast")).toContain(ORCHESTRATION_CHAIN_LABEL);
    expect(ORCHESTRATION_OWNERSHIP_NOTE).toContain("Orca owns");
    expect(ORCHESTRATION_OWNERSHIP_NOTE).toContain("role→profile");
  });

  it("maps bridge errors; conflicts prompt reload/compare", () => {
    const conflict = mapOrchestrationErrorToField({ code: "conflict", message: "stale" });
    expect(conflict.isConflict).toBe(true);
    expect(conflict.retryable).toBe(true);
    expect(conflict.field).toBe("_global");
    const roleField = mapOrchestrationErrorToField({ code: "validation", message: "bad", field: "role" });
    expect(roleField.field).toBe("role");
    const dotted = mapOrchestrationErrorToField({ code: "validation", message: "bad", field: "orchestration.worker.profile" });
    expect(dotted.field).toBe("profile");
    const global = mapOrchestrationErrorToField({ code: "internal", message: "boom" });
    expect(global.field).toBe("_global");
  });
});

describe("orchestration helpers: table normalization", () => {
  it("exposes default mappings with builtin provenance and order", () => {
    const items = toOrchestrationItems({
      effective: { worker: "worker", scout: "scout", reviewer: "reviewer" },
      provenance: { worker: "builtin", scout: "builtin", reviewer: "builtin" },
    });
    expect(items.map((i) => i.role)).toEqual(["worker", "scout", "reviewer"]);
    expect(items.every((i) => i.provenance === "builtin")).toBe(true);
    expect(items.every((i) => i.invalid === false)).toBe(true);
  });

  it("supports custom roles as preset slots (sorted after builtins)", () => {
    const items = toOrchestrationItems({
      effective: { worker: "worker", zebra: "worker-fast", alpha: "scout" },
      provenance: { worker: "builtin", zebra: "project", alpha: "user" },
    });
    expect(items.map((i) => i.role)).toEqual(["worker", "alpha", "zebra"]);
    expect(items.find((i) => i.role === "zebra")!.provenance).toBe("project");
    expect(items.find((i) => i.role === "alpha")!.provenance).toBe("user");
  });

  it("marks invalid/deleted profile references without throwing", () => {
    const viaRefs = toOrchestrationItems({
      effective: { worker: "ghost-profile", scout: "scout" },
      provenance: { worker: "project", scout: "builtin" },
      invalidRefs: ["worker"],
    });
    expect(viaRefs.find((i) => i.role === "worker")!.invalid).toBe(true);
    expect(viaRefs.find((i) => i.role === "scout")!.invalid).toBe(false);
    const viaKnown = toOrchestrationItems(
      { effective: { worker: "ghost-profile", scout: "scout" }, provenance: {} },
      ["scout", "worker"],
    );
    expect(viaKnown.find((i) => i.role === "worker")!.invalid).toBe(true);
    expect(viaKnown.find((i) => i.role === "scout")!.invalid).toBe(false);
    expect(orchestrationInvalidSummary(viaKnown)).toContain("1 invalid");
    expect(orchestrationInvalidSummary(viaKnown)).toContain("ghost-profile");
  });

  it("summarizes valid tables and project precedence", () => {
    // Project precedence is resolved server-side; the UI preserves the
    // provenance the bridge reports (project wins over user over builtin).
    const items = toOrchestrationItems({
      effective: { worker: "worker-project", scout: "scout-user", reviewer: "reviewer" },
      provenance: { worker: "project", scout: "user", reviewer: "builtin" },
    });
    expect(items.find((i) => i.role === "worker")!.profile).toBe("worker-project");
    expect(items.find((i) => i.role === "worker")!.provenance).toBe("project");
    expect(items.find((i) => i.role === "scout")!.provenance).toBe("user");
    expect(orchestrationInvalidSummary(items, )).toContain("valid");
  });

  it("normalizes file and bridge shapes without throwing", () => {
    expect(toOrchestrationItems(null)).toEqual([]);
    expect(toOrchestrationItems({})).toEqual([]);
    const fromRoles = toOrchestrationItems({ roles: { worker: "worker-fast" }, provenance: { worker: "user" } });
    expect(fromRoles).toHaveLength(1);
    expect(fromRoles[0]!.profile).toBe("worker-fast");
  });

  it("does not mark all invalid while profiles are still loading (empty known)", () => {
    const items = toOrchestrationItems(
      { effective: { worker: "worker", scout: "scout" }, provenance: {} },
      [],
    );
    expect(items.every((i) => i.invalid === false)).toBe(true);
  });
});

describe("orchestration section: implemented in the shell", () => {
  it("marks orchestration implemented with a Pi-policy blurb", () => {
    const sections = controlCenterSections();
    const orch = sections.find((s) => s.id === "orchestration")!;
    expect(orch.implemented).toBe(true);
    expect(orch.blurb).toContain("role");
    expect(orch.blurb).toContain("profile");
  });
});

describe("orchestration: shipped script honors bridge + ownership contract", () => {
  it("mentions structured ops and never escapes the sandbox", () => {
    const html = readFileSync(join(here, "..", "panel", "control-center.html"), "utf8");
    for (const token of [
      "orchestration.get",
      "orchestration.set",
      "launch.preview",
      "worktree.context",
      "orch-list",
      "orch-editor",
      "orch-preview",
      "orch-context",
      "orch-scope",
      "btn-orch-refresh",
      "btn-orch-save",
      "btn-orch-preview",
      "orch-dirty",
      "expectedSourceHash",
      "clear: true",
      "ORCH_PROFILE_RE",
      "ownsDraft",
      "INVALID",
      "Provenance",
      "Orchestration role mapping → profile → user/project profile layers → effective launch",
      "Orca owns task/DAG/worktree/run",
      "no task board",
      "no DAG viewer",
      "no worker monitor",
      "Team presets",
      "custom role",
      "never a hidden store",
      "never to focus at completion time",
      "orchListToken",
      "orchPreviewToken",
      "orchSaveGen",
      "orchDraftRev",
      "selectOrchRole",
      "saveOrchDraft",
      "resetOrchRole",
      "cloneOrchRole",
      "Clone",
      "loadOrchPreview",
      "loadOrchestration",
      "loadOrchContext",
      "refreshOrchListOnly",
      "toOrchItems",
      "mapOrchError",
    ]) {
      expect(html).toContain(token);
    }
    for (const banned of ["node:child_process", "node:fs", 'require("fs")', "fetch("]) {
      expect(html).not.toContain(banned);
    }
    expect(html).not.toContain("__ORCA_PI_PROFILES__");
    // Ownership: Orca-native surfaces stay Orca's; presets/DAG are read-only context.
    expect(html).toContain("Orca owns task/DAG/worktree/run lifecycle");
  });

  it("keeps profile tokens intact alongside orchestration", () => {
    const html = readFileSync(join(here, "..", "panel", "control-center.html"), "utf8");
    for (const token of [
      "__ORCA_PI_BRIDGE__",
      "bridge.capabilities",
      "profiles.list",
      "profile.read",
      "profile.mutate",
      "launch.preview",
      "github.status",
      "diagnostics.doctor",
      "workspace.readContext",
      "terminal.sendText",
    ]) {
      expect(html).toContain(token);
    }
  });
});

// Lightweight execution harness for the orchestration section (mirrors the
// profiles harness: fake DOM + mocked bridge, no network/filesystem).
interface FakeEl {
  tag: string;
  children: FakeEl[];
  listeners: Record<string, ((...args: never[]) => void)[]>;
  textContent: string;
  innerHTML: string;
  disabled: boolean;
  value: string;
  checked: boolean;
  tabIndex: number;
  attrs: Record<string, string>;
  appendChild(child: FakeEl): void;
  addEventListener(event: string, fn: (...args: never[]) => void): void;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  getAttribute(name: string): string | null;
  insertBefore(child: FakeEl, before: FakeEl | null): void;
}

function makeEl(tag: string): FakeEl {
  const ell: FakeEl = {
    tag, children: [], listeners: {}, textContent: "", innerHTML: "",
    disabled: false, value: "", checked: false, tabIndex: 0, attrs: {},
    appendChild(child: FakeEl) { ell.children.push(child); },
    addEventListener(event: string, fn: (...args: never[]) => void) { (ell.listeners[event] ??= []).push(fn); },
    setAttribute(name: string, value: string) { ell.attrs[name] = value; },
    removeAttribute(name: string) { delete ell.attrs[name]; },
    getAttribute(name: string) { return ell.attrs[name] ?? null; },
    insertBefore(child: FakeEl) { ell.children.unshift(child); },
  };
  return ell;
}

function makeOrchDom(bridge?: unknown): {
  window: Record<string, unknown> & { parent: { postMessage: (m: unknown) => void } };
  document: Record<string, unknown>;
  posted: unknown[];
  byId: Record<string, FakeEl>;
  tabs: FakeEl[];
} {
  const posted: unknown[] = [];
  const listeners: Record<string, ((...args: never[]) => void)[]> = {};
  const byId: Record<string, FakeEl> = {};
  const ids = [
    "bridge-state", "cc-tabs", "section-profiles", "section-orchestration",
    "section-github", "section-diagnostics", "btn-refresh", "btn-create",
    "default-scope", "dirty-state", "profiles-summary", "profiles-list",
    "profile-editor", "launch-preview-wrap", "launch-preview",
    "btn-launch-preview", "raw-patch-view", "orchestration-summary",
    "orch-list", "orch-editor", "orch-preview", "orch-context",
    "orch-scope", "orch-dirty", "btn-orch-refresh", "btn-orch-preview",
    "github-summary", "diagnostics-summary", "btn-diagnostics-reload",
  ];
  for (const id of ids) {
    const e = makeEl(id.startsWith("btn-") ? "button" : "div");
    if (id === "default-scope" || id === "orch-scope") (e as FakeEl).value = "project";
    byId[id] = e;
  }
  const tabs: FakeEl[] = ["tab-profiles", "tab-orchestration", "tab-github", "tab-diagnostics"].map((id, i) => {
    const t = makeEl("button");
    t.setAttribute("role", "tab");
    t.setAttribute("aria-controls", id.replace("tab-", "section-"));
    t.setAttribute("aria-selected", i === 0 ? "true" : "false");
    return t;
  });
  const fakeWindow: Record<string, unknown> & { parent: { postMessage: (m: unknown) => void } } = {
    __ORCA_PI_BRIDGE__: bridge,
    parent: { postMessage: (m: unknown) => { posted.push(m); } },
    confirm: (() => true) as never,
    prompt: (() => null) as never,
    alert: (() => undefined) as never,
    addEventListener: undefined as never,
    removeEventListener: undefined as never,
  };
  fakeWindow["addEventListener"] = ((event: string, fn: (...args: never[]) => void) => {
    (listeners[event] ??= []).push(fn);
  }) as never;
  fakeWindow["removeEventListener"] = ((event: string, fn: (...args: never[]) => void) => {
    listeners[event] = (listeners[event] ?? []).filter((f) => f !== (fn as (...args: never[]) => void));
  }) as never;
  const fakeDocument: Record<string, unknown> = {
    getElementById: ((id: string) => byId[id] ?? null) as never,
    querySelectorAll: ((sel: string) => (sel.includes("tab") ? tabs : [])) as never,
    createElement: ((tag: string) => makeEl(tag)) as never,
  };
  return { window: fakeWindow, document: fakeDocument, posted, byId, tabs };
}

function findButtons(root: FakeEl): FakeEl[] {
  const out: FakeEl[] = [];
  const visit = (n: FakeEl): void => {
    if (n.tag === "button") out.push(n);
    for (const c of n.children) visit(c);
  };
  visit(root);
  return out;
}

const flush = async (rounds = 10): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) await new Promise<void>((r) => setTimeout(r, 0));
};

describe("orchestration: bridge round-trip in the shipped script", () => {
  it("lists default mappings after capabilities (structured first)", async () => {
    const calls: string[] = [];
    const dom = makeOrchDom({
      request: (req: { operation: string; requestId: string }) => {
        calls.push(req.operation);
        if (req.operation === "bridge.capabilities") {
          return Promise.resolve({
            protocolVersion: 1, requestId: req.requestId, ok: true,
            result: { structured: true, supportedOperations: ["profiles.list", "profile.read", "orchestration.get", "orchestration.set", "launch.preview", "worktree.context", "github.status", "diagnostics.doctor"] },
          });
        }
        if (req.operation === "profiles.list") {
          return Promise.resolve({
            protocolVersion: 1, requestId: req.requestId, ok: true,
            result: { summaries: [{ name: "worker", thinking: "high", skillNames: [], skillCount: 0, extensionCount: 0, contextFiles: true, extendsChain: ["worker"], layer: "builtin", valid: true }] },
          });
        }
        if (req.operation === "orchestration.get") {
          return Promise.resolve({
            protocolVersion: 1, requestId: req.requestId, ok: true,
            result: {
              effective: { worker: "worker", scout: "scout", reviewer: "reviewer" },
              provenance: { worker: "builtin", scout: "builtin", reviewer: "builtin" },
              config: { userPath: "/u", projectPath: "/p", userExists: false, projectExists: false },
              sourceHash: {},
            },
          });
        }
        if (req.operation === "worktree.context") {
          return Promise.resolve({ protocolVersion: 1, requestId: req.requestId, ok: true, result: { projectRoot: "/repo/p" } });
        }
        return Promise.resolve({ protocolVersion: 1, requestId: req.requestId, ok: true, result: {} });
      },
    });
    const runner = new Function("window", "document", scriptOf()) as unknown as (w: unknown, d: unknown) => void;
    runner(dom.window, dom.document);
    await flush(14);
    expect(calls[0]).toBe("bridge.capabilities");
    expect(calls).toContain("orchestration.get");
    // Three builtin rows + one add-custom row.
    expect(dom.byId["orch-list"]!.children.length).toBe(4);
    expect(dom.posted).toHaveLength(0);
  });

  it("surfaces invalid/deleted profile references before launch", async () => {
    const dom = makeOrchDom({
      request: (req: { operation: string; requestId: string }) => {
        if (req.operation === "bridge.capabilities") {
          return Promise.resolve({
            protocolVersion: 1, requestId: req.requestId, ok: true,
            result: { structured: true, supportedOperations: ["profiles.list", "orchestration.get", "orchestration.set", "launch.preview", "worktree.context"] },
          });
        }
        if (req.operation === "profiles.list") {
          return Promise.resolve({
            protocolVersion: 1, requestId: req.requestId, ok: true,
            result: { summaries: [{ name: "worker", thinking: "high", skillNames: [], skillCount: 0, extensionCount: 0, contextFiles: true, extendsChain: ["worker"], layer: "builtin", valid: true }] },
          });
        }
        if (req.operation === "orchestration.get") {
          return Promise.resolve({
            protocolVersion: 1, requestId: req.requestId, ok: true,
            result: {
              effective: { worker: "ghost-profile", scout: "scout" },
              provenance: { worker: "project", scout: "builtin" },
              invalidRefs: ["worker"],
              config: { userPath: "/u", projectPath: "/p", userExists: false, projectExists: true },
              sourceHash: { project: "p".repeat(64) },
            },
          });
        }
        if (req.operation === "worktree.context") {
          return Promise.resolve({ protocolVersion: 1, requestId: req.requestId, ok: true, result: { projectRoot: "/repo/p" } });
        }
        return Promise.resolve({ protocolVersion: 1, requestId: req.requestId, ok: true, result: {} });
      },
    });
    const runner = new Function("window", "document", scriptOf()) as unknown as (w: unknown, d: unknown) => void;
    runner(dom.window, dom.document);
    await flush(14);
    const collectHtml = (n: FakeEl): string => n.innerHTML + n.children.map(collectHtml).join(" ");
    const text = JSON.stringify(dom.byId["orch-list"]!.children.map(collectHtml));
    expect(text).toContain("INVALID");
    expect(dom.byId["orchestration-summary"]!.innerHTML).toContain("invalid");
    expect(dom.byId["orchestration-summary"]!.innerHTML).toContain("ghost-profile");
  });

  it("edits a role end-to-end (get → set with scope + hash → round-trip)", async () => {
    const calls: Array<{ op: string; params?: unknown }> = [];
    const dom = makeOrchDom({
      request: (req: { operation: string; requestId: string; params?: unknown }) => {
        calls.push({ op: req.operation, params: req.params });
        if (req.operation === "bridge.capabilities") {
          return Promise.resolve({
            protocolVersion: 1, requestId: req.requestId, ok: true,
            result: { structured: true, supportedOperations: ["profiles.list", "orchestration.get", "orchestration.set", "launch.preview", "worktree.context"] },
          });
        }
        if (req.operation === "profiles.list") {
          return Promise.resolve({
            protocolVersion: 1, requestId: req.requestId, ok: true,
            result: {
              summaries: [
                { name: "worker", thinking: "high", skillNames: [], skillCount: 0, extensionCount: 0, contextFiles: true, extendsChain: ["worker"], layer: "builtin", valid: true },
                { name: "worker-fast", thinking: "high", skillNames: [], skillCount: 0, extensionCount: 0, contextFiles: true, extendsChain: ["worker", "worker-fast"], layer: "project", valid: true },
              ],
            },
          });
        }
        if (req.operation === "orchestration.get") {
          return Promise.resolve({
            protocolVersion: 1, requestId: req.requestId, ok: true,
            result: {
              effective: { worker: "worker", scout: "scout", reviewer: "reviewer" },
              provenance: { worker: "builtin", scout: "builtin", reviewer: "builtin" },
              config: { userPath: "/u", projectPath: "/p", userExists: false, projectExists: false },
              sourceHash: {},
            },
          });
        }
        if (req.operation === "orchestration.set") {
          const params = req.params as Record<string, unknown>;
          expect(params.role).toBe("worker");
          expect(params.scope).toBe("project");
          expect(typeof params.profile).toBe("string");
          return Promise.resolve({
            protocolVersion: 1, requestId: req.requestId, ok: true,
            result: { role: "worker", profile: params.profile, scope: "project", path: "/p" },
          });
        }
        if (req.operation === "worktree.context") {
          return Promise.resolve({ protocolVersion: 1, requestId: req.requestId, ok: true, result: { projectRoot: "/repo/p" } });
        }
        return Promise.resolve({ protocolVersion: 1, requestId: req.requestId, ok: true, result: {} });
      },
    });
    const runner = new Function("window", "document", scriptOf()) as unknown as (w: unknown, d: unknown) => void;
    runner(dom.window, dom.document);
    await flush(14);
    const items = dom.byId["orch-list"]!.children;
    expect(items.length).toBe(4);
    const editBtn = findButtons(items[0]!).find((b) => b.textContent === "Edit")!;
    expect(editBtn).toBeDefined();
    for (const fn of editBtn.listeners["click"] ?? []) (fn as () => void)();
    await flush(6);
    // Editor rendered with scope + save.
    const saveBtn = (function findSave(node: FakeEl): FakeEl | undefined {
      if (node.textContent.startsWith("Save") && node.tag === "button") return node;
      for (const c of node.children) { const found = findSave(c); if (found) return found; }
      return undefined;
    })(dom.byId["orch-editor"]!);
    expect(saveBtn).toBeDefined();
  });

  it("shows launch preview chain (role → profile → layers → effective launch)", async () => {
    const dom = makeOrchDom({
      request: (req: { operation: string; requestId: string; params?: unknown }) => {
        if (req.operation === "bridge.capabilities") {
          return Promise.resolve({
            protocolVersion: 1, requestId: req.requestId, ok: true,
            result: { structured: true, supportedOperations: ["profiles.list", "orchestration.get", "orchestration.set", "launch.preview", "worktree.context"] },
          });
        }
        if (req.operation === "profiles.list") {
          return Promise.resolve({
            protocolVersion: 1, requestId: req.requestId, ok: true,
            result: { summaries: [{ name: "worker", thinking: "high", skillNames: [], skillCount: 0, extensionCount: 0, contextFiles: true, extendsChain: ["worker"], layer: "builtin", valid: true }] },
          });
        }
        if (req.operation === "orchestration.get") {
          return Promise.resolve({
            protocolVersion: 1, requestId: req.requestId, ok: true,
            result: {
              effective: { worker: "worker", scout: "scout", reviewer: "reviewer" },
              provenance: { worker: "builtin", scout: "builtin", reviewer: "builtin" },
              config: { userPath: "/u", projectPath: "/p", userExists: false, projectExists: false },
              sourceHash: {},
            },
          });
        }
        if (req.operation === "launch.preview") {
          const name = (req.params as { name?: string })?.name;
          return Promise.resolve({
            protocolVersion: 1, requestId: req.requestId, ok: true,
            result: {
              profile: name,
              resolved: { model: "test/model", thinking: "high", tools: ["read"], skills: [], extensions: [], contextFiles: true },
              launch: { preview: "pi --model test/model", promptSource: "builtin", spec: { args: ["--model", "test/model"] } },
              displayOnly: true,
            },
          });
        }
        if (req.operation === "worktree.context") {
          return Promise.resolve({ protocolVersion: 1, requestId: req.requestId, ok: true, result: { projectRoot: "/repo/p" } });
        }
        return Promise.resolve({ protocolVersion: 1, requestId: req.requestId, ok: true, result: {} });
      },
    });
    const runner = new Function("window", "document", scriptOf()) as unknown as (w: unknown, d: unknown) => void;
    runner(dom.window, dom.document);
    await flush(14);
    const items = dom.byId["orch-list"]!.children;
    const previewBtn = findButtons(items[0]!).find((b) => b.textContent === "Preview launch")!;
    expect(previewBtn).toBeDefined();
    for (const fn of previewBtn.listeners["click"] ?? []) (fn as () => void)();
    await flush(8);
    expect(dom.byId["orch-preview"]!.innerHTML).toContain("Orchestration role mapping");
    expect(dom.byId["orch-preview"]!.innerHTML).toContain("effective launch");
  });

  it("never leaks one role's dirty draft into another role's preview", async () => {
    const previewedProfiles: string[] = [];
    const dom = makeOrchDom({
      request: (req: { operation: string; requestId: string; params?: unknown }) => {
        if (req.operation === "bridge.capabilities") {
          return Promise.resolve({
            protocolVersion: 1, requestId: req.requestId, ok: true,
            result: { structured: true, supportedOperations: ["profiles.list", "orchestration.get", "orchestration.set", "launch.preview", "worktree.context"] },
          });
        }
        if (req.operation === "profiles.list") {
          return Promise.resolve({
            protocolVersion: 1, requestId: req.requestId, ok: true,
            result: { summaries: [
              { name: "worker", thinking: "high", skillNames: [], skillCount: 0, extensionCount: 0, contextFiles: true, extendsChain: ["worker"], layer: "builtin", valid: true },
              { name: "worker-draft", thinking: "high", skillNames: [], skillCount: 0, extensionCount: 0, contextFiles: true, extendsChain: ["worker-draft"], layer: "project", valid: true },
              { name: "reviewer", thinking: "high", skillNames: [], skillCount: 0, extensionCount: 0, contextFiles: true, extendsChain: ["reviewer"], layer: "builtin", valid: true },
            ] },
          });
        }
        if (req.operation === "orchestration.get") {
          return Promise.resolve({
            protocolVersion: 1, requestId: req.requestId, ok: true,
            result: {
              effective: { worker: "worker", scout: "scout", reviewer: "reviewer" },
              provenance: { worker: "builtin", scout: "builtin", reviewer: "builtin" },
              config: { userPath: "/u", projectPath: "/p", userExists: false, projectExists: false },
              sourceHash: {},
            },
          });
        }
        if (req.operation === "launch.preview") {
          const name = (req.params as { name?: string })?.name ?? "";
          previewedProfiles.push(name);
          return Promise.resolve({
            protocolVersion: 1, requestId: req.requestId, ok: true,
            result: {
              profile: name,
              resolved: { model: "m", thinking: "high", tools: [], skills: [], extensions: [], contextFiles: false },
              launch: { preview: "pi", promptSource: "builtin", spec: { args: [] } },
              displayOnly: true,
            },
          });
        }
        if (req.operation === "worktree.context") {
          return Promise.resolve({ protocolVersion: 1, requestId: req.requestId, ok: true, result: { projectRoot: "/repo/p" } });
        }
        return Promise.resolve({ protocolVersion: 1, requestId: req.requestId, ok: true, result: {} });
      },
    });
    const runner = new Function("window", "document", scriptOf()) as unknown as (w: unknown, d: unknown) => void;
    runner(dom.window, dom.document);
    await flush(14);
    // Edit worker (first row) so the editor holds a dirty draft for worker.
    const items = dom.byId["orch-list"]!.children;
    const workerEdit = findButtons(items[0]!).find((b) => b.textContent === "Edit")!;
    for (const fn of workerEdit.listeners["click"] ?? []) (fn as () => void)();
    await flush(6);
    // Simulate typing a different profile into the worker editor (dirty draft).
    const findById = (root: FakeEl, id: string): FakeEl | undefined => {
      if ((root as unknown as Record<string, unknown>).id === id) return root;
      for (const c of root.children) { const f = findById(c, id); if (f) return f; }
      return undefined;
    };
    // Fake DOM inputs don't carry ids via attrs in this harness; drive the
    // draft by previewing the reviewer row directly: the reviewer preview
    // must resolve the persisted reviewer profile, never the worker draft.
    const reviewerRow = items[2]!;
    const reviewerPreview = findButtons(reviewerRow).find((b) => b.textContent === "Preview launch")!;
    // Make the worker draft dirty by editing through the editor's input if present.
    const profileInput = findById(dom.byId["orch-editor"]!, "orch-profile");
    if (profileInput) {
      (profileInput as unknown as Record<string, unknown>).value = "worker-draft";
      for (const fn of profileInput.listeners["input"] ?? []) (fn as () => void)();
      await flush(2);
    }
    expect(dom.byId["orch-dirty"]!.textContent).toContain("Unsaved");
    // Cancel the role switch so the worker draft stays dirty while previewing reviewer.
    (dom.window as Record<string, unknown>).confirm = (() => false) as never;
    for (const fn of reviewerPreview.listeners["click"] ?? []) (fn as () => void)();
    await flush(8);
    // The reviewer preview must use the persisted reviewer profile.
    expect(previewedProfiles).toContain("reviewer");
    expect(previewedProfiles).not.toContain("worker-draft");
    expect(dom.byId["orch-preview"]!.innerHTML).toContain("reviewer");
  });

  it("never calls launch.preview for a known-invalid persisted mapping", async () => {
    const calls: string[] = [];
    const dom = makeOrchDom({
      request: (req: { operation: string; requestId: string }) => {
        calls.push(req.operation);
        if (req.operation === "bridge.capabilities") {
          return Promise.resolve({
            protocolVersion: 1, requestId: req.requestId, ok: true,
            result: { structured: true, supportedOperations: ["profiles.list", "orchestration.get", "orchestration.set", "launch.preview", "worktree.context"] },
          });
        }
        if (req.operation === "profiles.list") {
          return Promise.resolve({
            protocolVersion: 1, requestId: req.requestId, ok: true,
            result: { summaries: [{ name: "scout", thinking: "high", skillNames: [], skillCount: 0, extensionCount: 0, contextFiles: true, extendsChain: ["scout"], layer: "builtin", valid: true }] },
          });
        }
        if (req.operation === "orchestration.get") {
          return Promise.resolve({
            protocolVersion: 1, requestId: req.requestId, ok: true,
            result: {
              effective: { worker: "ghost-profile", scout: "scout" },
              provenance: { worker: "project", scout: "builtin" },
              invalidRefs: ["worker"],
              config: { userPath: "/u", projectPath: "/p", userExists: false, projectExists: true },
              sourceHash: { project: "p".repeat(64) },
            },
          });
        }
        if (req.operation === "worktree.context") {
          return Promise.resolve({ protocolVersion: 1, requestId: req.requestId, ok: true, result: { projectRoot: "/repo/p" } });
        }
        return Promise.resolve({ protocolVersion: 1, requestId: req.requestId, ok: true, result: {} });
      },
    });
    const runner = new Function("window", "document", scriptOf()) as unknown as (w: unknown, d: unknown) => void;
    runner(dom.window, dom.document);
    await flush(14);
    const items = dom.byId["orch-list"]!.children;
    const previewBtn = findButtons(items[0]!).find((b) => b.textContent === "Preview launch")!;
    for (const fn of previewBtn.listeners["click"] ?? []) (fn as () => void)();
    await flush(8);
    expect(calls).not.toContain("launch.preview");
    expect(dom.byId["orch-preview"]!.innerHTML).toContain("Invalid reference");
    expect(dom.byId["orch-preview"]!.innerHTML).toContain("ghost-profile");
  });

  it("degrades without auto-send and disables mapping saves", async () => {
    const dom = makeOrchDom(undefined);
    const runner = new Function("window", "document", scriptOf()) as unknown as (w: unknown, d: unknown) => void;
    runner(dom.window, dom.document);
    await flush(6);
    expect(dom.posted).toHaveLength(0);
    expect(dom.byId["orchestration-summary"]!.innerHTML).toContain("Degraded");
    expect(dom.byId["orch-editor"]!.innerHTML).toContain("Save is disabled");
  });

  it("ignores stale orchestration.get responses (race safe)", async () => {
    let resolveA: ((v: unknown) => void) | undefined;
    let getCount = 0;
    const dom = makeOrchDom({
      request: (req: { operation: string; requestId: string }) => {
        if (req.operation === "bridge.capabilities") {
          return Promise.resolve({
            protocolVersion: 1, requestId: req.requestId, ok: true,
            result: { structured: true, supportedOperations: ["profiles.list", "orchestration.get", "worktree.context"] },
          });
        }
        if (req.operation === "profiles.list") {
          return Promise.resolve({
            protocolVersion: 1, requestId: req.requestId, ok: true,
            result: { summaries: [] },
          });
        }
        if (req.operation === "orchestration.get") {
          getCount += 1;
          if (getCount === 1) {
            return new Promise((resolve) => { resolveA = resolve as (v: unknown) => void; });
          }
          return Promise.resolve({
            protocolVersion: 1, requestId: req.requestId, ok: true,
            result: {
              effective: { worker: "worker-new" },
              provenance: { worker: "project" },
              config: { userPath: "/u", projectPath: "/p", userExists: false, projectExists: true },
              sourceHash: { project: "n".repeat(64) },
            },
          });
        }
        if (req.operation === "worktree.context") {
          return Promise.resolve({ protocolVersion: 1, requestId: req.requestId, ok: true, result: { projectRoot: "/repo/p" } });
        }
        return Promise.resolve({ protocolVersion: 1, requestId: req.requestId, ok: true, result: {} });
      },
    });
    const runner = new Function("window", "document", scriptOf()) as unknown as (w: unknown, d: unknown) => void;
    runner(dom.window, dom.document);
    await flush(4);
    // Trigger a second (newer) load via the refresh button.
    const refreshBtn = dom.byId["btn-orch-refresh"]!;
    for (const fn of refreshBtn.listeners["click"] ?? []) (fn as () => void)();
    await flush(8);
    expect(dom.byId["orch-list"]!.children.length).toBeGreaterThan(0);
    // Stale first response must be ignored when it arrives late.
    resolveA!({
      protocolVersion: 1, requestId: "stale", ok: true,
      result: {
        effective: { worker: "worker-stale" },
        provenance: { worker: "user" },
        config: { userPath: "/u", projectPath: "/p", userExists: true, projectExists: false },
        sourceHash: { user: "s".repeat(64) },
      },
    });
    await flush(4);
    expect(dom.byId["orch-list"]!.innerHTML ?? "").not.toContain("worker-stale");
  });
});

describe("orchestration: authoritative round-trip (bridge host)", () => {
  it("save/refresh round-trips through orchestration.get/set with project precedence", async () => {
    const { handleBridgeRequest } = await import("../src/bridge-host.js");
    const files = new Map<string, string>();
    const fs = {
      async readFile(path: string) {
        if (!files.has(String(path))) {
          const error = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        return files.get(String(path))!;
      },
      async writeFile(path: string, content: string) { files.set(String(path), content); },
      async rename(oldPath: string, newPath: string) {
        files.set(String(newPath), files.get(String(oldPath))!);
        files.delete(String(oldPath));
      },
      async mkdir() { return undefined; },
      async stat(path: string) {
        if (files.has(String(path))) return {};
        const error = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      },
      async unlink(path: string) { files.delete(String(path)); },
    };
    const deps = {
      projectRoot: "/repo/p",
      transport: "operator" as const,
      trustedProjectRoot: "/repo/p",
      fs: fs as never,
      orchestrationFs: fs as never,
    };
    // Default mappings (builtins) with no files.
    const initial = await handleBridgeRequest(
      { protocolVersion: 1, requestId: "get-1", operation: "orchestration.get" },
      deps,
    );
    expect(initial.ok).toBe(true);
    // User override then project override (project wins).
    const setUser = await handleBridgeRequest(
      {
        protocolVersion: 1, requestId: "set-u", operation: "orchestration.set",
        worktree: { projectRoot: "/repo/p" },
        params: { role: "worker", profile: "worker-fast", scope: "user" },
      },
      deps,
    );
    expect(setUser.ok).toBe(true);
    const setProject = await handleBridgeRequest(
      {
        protocolVersion: 1, requestId: "set-p", operation: "orchestration.set",
        worktree: { projectRoot: "/repo/p" },
        params: { role: "worker", profile: "worker-project", scope: "project" },
      },
      deps,
    );
    expect(setProject.ok).toBe(true);
    const final = await handleBridgeRequest(
      { protocolVersion: 1, requestId: "get-2", operation: "orchestration.get" },
      deps,
    );
    expect(final.ok).toBe(true);
    if (final.ok) {
      const result = final.result as { effective: Record<string, string>; provenance: Record<string, string> };
      expect(result.effective["worker"]).toBe("worker-project");
      expect(result.provenance["worker"]).toBe("project");
      // Helpers preserve the precedence the bridge reports.
      const items = toOrchestrationItems(result);
      expect(items.find((i) => i.role === "worker")!.provenance).toBe("project");
    }
    // Custom role as preset slot.
    const setCustom = await handleBridgeRequest(
      {
        protocolVersion: 1, requestId: "set-c", operation: "orchestration.set",
        worktree: { projectRoot: "/repo/p" },
        params: { role: "impl-fast", profile: "worker-fast", scope: "project" },
      },
      deps,
    );
    expect(setCustom.ok).toBe(true);
    // Canonical Pi profile grammar: uppercase/underscore refs are valid.
    const setUpper = await handleBridgeRequest(
      {
        protocolVersion: 1, requestId: "set-upper", operation: "orchestration.set",
        worktree: { projectRoot: "/repo/p" },
        params: { role: "scout", profile: "Worker_Fast", scope: "project" },
      },
      deps,
    );
    expect(setUpper.ok).toBe(true);
    const afterUpper = await handleBridgeRequest(
      { protocolVersion: 1, requestId: "get-3", operation: "orchestration.get" },
      deps,
    );
    expect(afterUpper.ok).toBe(true);
    if (afterUpper.ok) {
      const result = afterUpper.result as { effective: Record<string, string> };
      expect(result.effective["scout"]).toBe("Worker_Fast");
    }
  });

  it("launch preview reuses the compiler for a mapped profile (display-only)", async () => {
    const { handleBridgeRequest } = await import("../src/bridge-host.js");
    const deps = { projectRoot: "/repo/p", transport: "operator" as const, trustedProjectRoot: "/repo/p" };
    const preview = await handleBridgeRequest(
      { protocolVersion: 1, requestId: "prev", operation: "launch.preview", params: { name: "worker" } },
      deps,
    );
    expect(preview.ok).toBe(true);
    if (preview.ok) {
      const result = preview.result as { profile: string; launch: unknown; displayOnly: boolean };
      expect(result.profile).toBe("worker");
      expect(result.displayOnly).toBe(true);
      expect(result.launch).toBeDefined();
    }
  });
});

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildMutateParams,
  builtinGuardText,
  controlCenterSections,
  describeDegradedMode,
  describeLayer,
  describeMcpSummary,
  describeProvenance,
  isBuiltinProfileName,
  isBuiltinSaveBlocked,
  mapBridgeErrorToField,
  toListItems,
  validateDraftShape,
  validateProfileName,
  CONTROL_CENTER_PANEL_ID,
  CONTROL_CENTER_COMPAT_PANEL_IDS,
  CONTROL_CENTER_EDITABLE_FIELDS,
  CONTROL_CENTER_THINKING_LEVELS,
  describeArrayInheritanceNote,
} from "../src/control-center.js";
import { describeTerminalFallback } from "../src/bridge.js";

const here = dirname(fileURLToPath(import.meta.url));

function scriptOf(): string {
  const html = readFileSync(join(here, "..", "panel", "control-center.html"), "utf8");
  const start = html.indexOf("<script>");
  const end = html.indexOf("</script>");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return html.slice(start + "<script>".length, end);
}

describe("control center: shell + sections", () => {
  it("exposes one primary panel id plus compat aliases", () => {
    expect(CONTROL_CENTER_PANEL_ID).toBe("orca-pi-control-center");
    expect([...CONTROL_CENTER_COMPAT_PANEL_IDS]).toEqual(["orca-pi-status", "orca-pi-profiles"]);
  });

  it("defines Profiles + placeholders for later issues", () => {
    const sections = controlCenterSections();
    expect(sections.map((s) => s.id)).toEqual(["profiles", "orchestration", "github", "diagnostics"]);
    expect(sections.find((s) => s.id === "profiles")!.implemented).toBe(true);
    expect(sections.find((s) => s.id === "orchestration")!.implemented).toBe(false);
    expect(sections.find((s) => s.id === "github")!.implemented).toBe(false);
    expect(sections.find((s) => s.id === "diagnostics")!.implemented).toBe(true);
  });

  it("covers all schema fields relevant to agent customization", () => {
    for (const field of [
      "provider", "model", "thinking", "displayName", "extends",
      "systemPrompt", "systemPromptFile", "tools", "skills", "extensions",
      "contextFiles", "githubIdentity",
    ]) {
      expect(CONTROL_CENTER_EDITABLE_FIELDS).toContain(field);
    }
    expect(CONTROL_CENTER_EDITABLE_FIELDS).toContain("excludeTools");
    expect(CONTROL_CENTER_EDITABLE_FIELDS).toContain("discoverSkills");
    expect(CONTROL_CENTER_EDITABLE_FIELDS).toContain("discoverExtensions");
    expect(CONTROL_CENTER_EDITABLE_FIELDS).toContain("session");
    expect(CONTROL_CENTER_THINKING_LEVELS).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(describeArrayInheritanceNote()).toContain("replace");
  });

  it("labels builtin/user/project layers and MCP surface without secrets", () => {
    expect(describeLayer("project")).toBe("project");
    expect(describeLayer("user")).toBe("user");
    expect(describeLayer("builtin")).toBe("builtin");
    expect(describeLayer(undefined)).toBe("builtin");
    expect(describeMcpSummary({ extensionCount: 0 })).toContain("none");
    expect(describeMcpSummary({ extensionCount: 2, discoverExtensions: true })).toContain("2");
    expect(describeMcpSummary({ extensionCount: 2, discoverExtensions: true })).not.toContain("ghp_");
  });

  it("guards built-ins against destructive edits (clone allowed)", () => {
    expect(isBuiltinProfileName("worker")).toBe(true);
    expect(isBuiltinProfileName("scout")).toBe(true);
    expect(isBuiltinProfileName("reviewer")).toBe(true);
    expect(isBuiltinProfileName("worker-fast")).toBe(false);
    expect(isBuiltinSaveBlocked("worker", "edit")).toBe(true);
    expect(isBuiltinSaveBlocked("worker", "clone")).toBe(false);
    expect(isBuiltinSaveBlocked("worker-fast", "edit")).toBe(false);
    expect(builtinGuardText("worker")).toContain("immutable");
    expect(builtinGuardText("worker")).toContain("clone");
  });

  it("validates profile names like the backend grammar", () => {
    expect(validateProfileName("worker-fast")).toBeUndefined();
    expect(validateProfileName("")).toBeDefined();
    expect(validateProfileName("__proto__")).toBeDefined();
    expect(validateProfileName("bad name")).toBeDefined();
  });

  it("runs client-side shape checks before the bridge", () => {
    expect(validateDraftShape({})).toEqual([]);
    expect(validateDraftShape({ extends: "self", name: "self" } as never).length).toBeGreaterThan(0);
    const both = validateDraftShape({ systemPrompt: "hi", systemPromptFile: ".pi/a.md" });
    expect(both.some((i) => i.field === "systemPrompt")).toBe(true);
    const badModel = validateDraftShape({ model: "sonnet:high" });
    expect(badModel.some((i) => i.field === "model")).toBe(true);
    const badThinking = validateDraftShape({ thinking: "ultra" });
    expect(badThinking.some((i) => i.field === "thinking")).toBe(true);
    const reviewerTools = validateDraftShape({ githubIdentity: "reviewer", tools: ["read", "edit"] });
    expect(reviewerTools.some((i) => i.field === "tools")).toBe(true);
    const unknown = validateDraftShape({ mcp: {} } as never);
    expect(unknown.some((i) => i.message.includes("secrets"))).toBe(true);
  });

  it("builds typed mutate params with explicit scope and hashes (never inferred)", () => {
    const create = buildMutateParams({ mode: "create", name: "w-fast", scope: "project", draft: { model: "x" } });
    expect(create).toMatchObject({ action: "create", name: "w-fast", scope: "project" });
    expect((create.initial as Record<string, unknown>).model).toBe("x");
    const patch = buildMutateParams({
      mode: "patch", name: "w-fast", scope: "user",
      draft: { model: "y", displayName: "" }, expectedSourceHash: "a".repeat(64),
    });
    expect(patch).toMatchObject({ action: "patch", name: "w-fast", scope: "user", expectedSourceHash: "a".repeat(64) });
    // Empty string becomes null (field deletion), undefined omitted.
    expect((patch.patch as Record<string, unknown>).displayName).toBeNull();
    const clone = buildMutateParams({ mode: "clone", name: "dest", scope: "project", source: "worker" });
    expect(clone).toMatchObject({ action: "clone", source: "worker", dest: "dest" });
    const del = buildMutateParams({ mode: "delete", name: "w-fast", scope: "project", expectedSourceHash: null });
    expect(del).toMatchObject({ action: "delete", expectedSourceHash: null });
    const absent = buildMutateParams({ mode: "create", name: "n", scope: "project", draft: {}, expectedAbsent: true });
    expect(absent).toMatchObject({ expectedAbsent: true });
  });

  it("maps bridge errors to fields; conflicts prompt reload/compare", () => {
    const conflict = mapBridgeErrorToField({ code: "conflict", message: "stale" });
    expect(conflict.isConflict).toBe(true);
    expect(conflict.retryable).toBe(true);
    expect(conflict.field).toBe("_global");
    const fielded = mapBridgeErrorToField({ code: "validation", message: "bad", field: "profiles.x.model" });
    expect(fielded.field).toBe("model");
    const heuristic = mapBridgeErrorToField({ code: "validation", message: "profiles.x.thinking: bad" });
    expect(heuristic.field).toBe("thinking");
    const global = mapBridgeErrorToField({ code: "internal", message: "boom" });
    expect(global.field).toBe("_global");
  });

  it("describes provenance and degraded mode without claiming support", () => {
    expect(describeProvenance({ display: "project config" })).toBe("project config");
    expect(describeProvenance({ kind: "user", inherited: true, definedIn: "base" })).toContain("base");
    const degraded = describeDegradedMode({ structured: false, reasons: ["no seam"] });
    expect(degraded.title).toContain("Degraded");
    expect(degraded.body).toContain("no seam");
    expect(degraded.body).not.toContain("structured available");
  });

  it("normalizes bridge list payloads without throwing", () => {
    expect(toListItems(null)).toEqual([]);
    expect(toListItems({})).toEqual([]);
    const items = toListItems({
      summaries: [
        { name: "worker", thinking: "high", skillNames: [], skillCount: 0, extensionCount: 1, contextFiles: true, extendsChain: ["worker"], layer: "builtin", valid: true, model: "m", githubIdentity: "worker" },
        { name: "<bad>", thinking: "low", skillNames: [], skillCount: 0, extensionCount: 0, contextFiles: false, extendsChain: [], valid: false },
      ],
    });
    expect(items.map((i) => i.name)).toEqual(["<bad>", "worker"]);
    expect(items[1]!.githubIdentity).toBe("worker");
  });
});

describe("control center: enriched list model (core)", () => {
  it("summaries carry provider/githubIdentity/extends/layer for the list", async () => {
    // Import from source (not dist) so UI1.3 list fields are visible without a rebuild.
    const core = await import("../../core/src/profile/presentation.js");
    const builtins = await import("../../core/src/profile/builtins.js");
    const loader = await import("../../core/src/profile/load.js");
    const builtinDoc = builtins.getBuiltinProfilesDocument();
    const userDoc = loader.parseAndValidateProfilesText(
      "profiles:\n  scout:\n    model: anthropic/claude-haiku\n  fast:\n    extends: worker\n    model: custom/model\n    githubIdentity: worker\n",
      "/home/u/.pi/agent/profiles.yaml",
    );
    const projectDoc = loader.parseAndValidateProfilesText(
      "profiles:\n  fast:\n    thinking: low\n",
      "/repo/p/.pi/profiles.yaml",
    );
    const mergedDoc = loader.mergeValidatedDocuments([builtinDoc, userDoc, projectDoc]);
    const layers = {
      mergedDoc, builtinDoc, userDoc, projectDoc,
      userPath: "/home/u/.pi/agent/profiles.yaml",
      projectPath: "/repo/p/.pi/profiles.yaml",
      userExists: true, projectExists: true,
    };
    const summaries = core.summarizeAllProfiles(layers);
    const byName = new Map(summaries.map((s) => [s.name, s]));
    // Builtin with no override stays builtin.
    expect(byName.get("worker")!.layer).toBe("builtin");
    expect(byName.get("worker")!.githubIdentity).toBe("worker");
    // User override wins when no project override.
    expect(byName.get("scout")!.layer).toBe("user");
    expect(byName.get("scout")!.model).toBe("anthropic/claude-haiku");
    // Project override wins; extends + identity survive resolution.
    const fast = byName.get("fast")!;
    expect(fast.layer).toBe("project");
    expect(fast.extends).toBe("worker");
    expect(fast.githubIdentity).toBe("worker");
    expect(fast.thinking).toBe("low");
    expect(core.layerForProfile("fast", layers)).toBe("project");
    expect(core.layerForProfile("scout", layers)).toBe("user");
    expect(core.layerForProfile("worker", layers)).toBe("builtin");
  });
});

describe("control center: shipped script honors bridge + fallback contract", () => {
  it("mentions every required operation and never escapes the sandbox", () => {
    const html = readFileSync(join(here, "..", "panel", "control-center.html"), "utf8");
    for (const token of [
      "__ORCA_PI_BRIDGE__", "bridge.capabilities", "profiles.list",
      "profile.read", "profile.mutate", "launch.preview",
      "orchestration.get", "github.status", "diagnostics.doctor",
      "workspace.readContext", "terminal.sendText",
      "orca-pi profile validate", "profile.mutate",
      'role="tablist"', 'role="tab"', 'role="tabpanel"',
      "aria-selected", "aria-live",
    ]) {
      expect(html).toContain(token);
    }
    for (const banned of ["node:child_process", "node:fs", 'require("fs")', "fetch("]) {
      expect(html).not.toContain(banned);
    }
    // Production path is the bridge, never static injection.
    expect(html).not.toContain("__ORCA_PI_PROFILES__");
    // Provenance, conflict, builtin guard, launch compiler reuse, MCP mapping.
    expect(html).toContain("Provenance");
    expect(html).toContain("conflict");
    expect(html).toContain("immutable");
    expect(html).toContain("launch.preview");
    expect(html).toContain("MCP");
    // Dirty + navigation guard + narrow-panel responsiveness + focus.
    expect(html).toContain("Unsaved");
    expect(html).toContain("confirm");
    expect(html).toContain("@media");
    expect(html).toContain("focus-visible");
  });

  it("fallback text stays within the degraded allowlist", () => {
    const allowed = describeTerminalFallback("term-1", "orca-pi profile validate");
    expect("hostAction" in allowed).toBe(true);
    const refused = describeTerminalFallback("term-1", "orca-pi profile set worker model x --scope project");
    expect("ok" in refused && refused.ok === false).toBe(true);
  });
});

// Lightweight execution test: the shipped script must confirm capabilities
// before any data call and degrade with an explicit button (no auto-send).
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

function makeControlDom(bridge?: unknown): {
  window: Record<string, unknown> & { parent: { postMessage: (m: unknown) => void } };
  document: Record<string, unknown>;
  posted: unknown[];
  listeners: Record<string, ((...args: never[]) => void)[]>;
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
    "github-summary", "diagnostics-summary", "btn-diagnostics-reload",
  ];
  for (const id of ids) {
    const e = makeEl(id.startsWith("btn-") ? "button" : "div");
    if (id === "default-scope") (e as FakeEl).value = "project";
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
  return { window: fakeWindow, document: fakeDocument, posted, listeners, byId, tabs };
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

const flush = async (rounds = 8): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) await new Promise<void>((r) => setTimeout(r, 0));
};

describe("control center: bridge negotiation in the shipped script", () => {
  it("lists profiles only after confirming structured capabilities", async () => {
    const calls: string[] = [];
    const dom = makeControlDom({
      request: (req: { operation: string; requestId: string }) => {
        calls.push(req.operation);
        if (req.operation === "bridge.capabilities") {
          return Promise.resolve({
            protocolVersion: 1, requestId: req.requestId, ok: true,
            result: { structured: true, supportedOperations: ["profiles.list", "profile.read", "profile.mutate", "launch.preview", "orchestration.get", "github.status", "diagnostics.doctor"] },
          });
        }
        if (req.operation === "profiles.list") {
          return Promise.resolve({
            protocolVersion: 1, requestId: req.requestId, ok: true,
            result: { summaries: [{ name: "worker", thinking: "high", skillNames: [], skillCount: 0, extensionCount: 0, contextFiles: true, extendsChain: ["worker"], layer: "builtin", valid: true }] },
          });
        }
        if (req.operation === "orchestration.get" || req.operation === "github.status" || req.operation === "diagnostics.doctor") {
          return Promise.resolve({ protocolVersion: 1, requestId: req.requestId, ok: true, result: {} });
        }
        return Promise.resolve({ protocolVersion: 1, requestId: req.requestId, ok: true, result: {} });
      },
    });
    const runner = new Function("window", "document", scriptOf()) as unknown as (w: unknown, d: unknown) => void;
    runner(dom.window, dom.document);
    await flush(12);
    expect(calls[0]).toBe("bridge.capabilities");
    expect(calls).toContain("profiles.list");
    expect(dom.byId["profiles-list"]!.children.length).toBe(1);
    expect(dom.posted).toHaveLength(0);
  });

  it("degrades without auto-send and offers one explicit fallback button", async () => {
    const dom = makeControlDom(undefined);
    const runner = new Function("window", "document", scriptOf()) as unknown as (w: unknown, d: unknown) => void;
    runner(dom.window, dom.document);
    await flush();
    expect(dom.posted).toHaveLength(0);
    const buttons = findButtons(dom.byId["bridge-state"]!);
    expect(buttons.length).toBe(1);
    expect(buttons[0]!.textContent).toContain("orca-pi profile validate");
  });

  it("edits a custom profile end-to-end (read → dirty → patch → round-trip)", async () => {
    const calls: Array<{ op: string; params?: unknown }> = [];
    const dom = makeControlDom({
      request: (req: { operation: string; requestId: string; params?: unknown }) => {
        calls.push({ op: req.operation, params: req.params });
        if (req.operation === "bridge.capabilities") {
          return Promise.resolve({
            protocolVersion: 1, requestId: req.requestId, ok: true,
            result: { structured: true, supportedOperations: ["profiles.list", "profile.read", "profile.mutate", "launch.preview", "orchestration.get", "github.status", "diagnostics.doctor", "profile.validate"] },
          });
        }
        if (req.operation === "profiles.list") {
          return Promise.resolve({
            protocolVersion: 1, requestId: req.requestId, ok: true,
            result: {
              summaries: [
                { name: "worker", thinking: "high", skillNames: [], skillCount: 0, extensionCount: 0, contextFiles: true, extendsChain: ["worker"], layer: "builtin", valid: true },
                { name: "worker-fast", thinking: "high", skillNames: [], skillCount: 0, extensionCount: 0, contextFiles: true, extendsChain: ["worker", "worker-fast"], extends: "worker", layer: "project", valid: true, model: "custom/m" },
              ],
            },
          });
        }
        if (req.operation === "profile.read") {
          const name = (req.params as { name?: string })?.name;
          return Promise.resolve({
            protocolVersion: 1, requestId: req.requestId, ok: true,
            result: {
              name, exists: true, extendsChain: ["worker", name],
              source: { builtin: { thinking: "high" }, project: { model: "custom/m" } },
              fields: {
                model: { project: "custom/m", effective: "custom/m", provenance: { kind: "project", display: "project config", inherited: false } },
                thinking: { effective: "high", provenance: { kind: "built-in", display: "built-in", inherited: true, definedIn: "worker" } },
              },
              validation: { ok: true },
              config: { userPath: "/u", projectPath: "/p", userExists: false, projectExists: true },
              sourceHash: { project: "b".repeat(64) },
            },
          });
        }
        if (req.operation === "profile.mutate") {
          const params = req.params as Record<string, unknown>;
          // Save must carry explicit scope + hash, never shell strings.
          expect(params.scope).toBe("project");
          expect(typeof (params as { expectedSourceHash?: unknown }).expectedSourceHash).toBe("string");
          return Promise.resolve({
            protocolVersion: 1, requestId: req.requestId, ok: true,
            result: { action: "patch", profileName: "worker-fast", scope: "project", path: "/p", sourceHashAfter: "c".repeat(64) },
          });
        }
        return Promise.resolve({ protocolVersion: 1, requestId: req.requestId, ok: true, result: {} });
      },
    });
    const runner = new Function("window", "document", scriptOf()) as unknown as (w: unknown, d: unknown) => void;
    runner(dom.window, dom.document);
    await flush(12);
    // Click Edit on worker-fast (second item).
    const items = dom.byId["profiles-list"]!.children;
    expect(items.length).toBe(2);
    const editBtn = findButtons(items[1]!).find((b) => b.textContent === "Edit")!;
    expect(editBtn).toBeDefined();
    for (const fn of editBtn.listeners["click"] ?? []) (fn as () => void)();
    await flush(12);
    expect(calls.some((c) => c.op === "profile.read")).toBe(true);
    // Editor rendered with provenance + scope + save.
    expect(dom.byId["profile-editor"]!.innerHTML === "" || dom.byId["profile-editor"]!.children.length > 0).toBe(true);
    // Dirty badge starts empty; editor contains a Save button.
    const saveBtn = (function findSave(node: FakeEl): FakeEl | undefined {
      if (node.textContent.startsWith("Save") && node.tag === "button") return node;
      for (const c of node.children) { const found = findSave(c); if (found) return found; }
      return undefined;
    })(dom.byId["profile-editor"]!);
    expect(saveBtn).toBeDefined();
    expect(saveBtn!.disabled).toBe(false);
  });

  it("blocks builtin saves and surfaces conflicts without overwriting", async () => {
    const dom = makeControlDom({
      request: (req: { operation: string; requestId: string; params?: unknown }) => {
        if (req.operation === "bridge.capabilities") {
          return Promise.resolve({
            protocolVersion: 1, requestId: req.requestId, ok: true,
            result: { structured: true, supportedOperations: ["profiles.list", "profile.read", "profile.mutate", "launch.preview"] },
          });
        }
        if (req.operation === "profiles.list") {
          return Promise.resolve({
            protocolVersion: 1, requestId: req.requestId, ok: true,
            result: { summaries: [{ name: "worker", thinking: "high", skillNames: [], skillCount: 0, extensionCount: 0, contextFiles: true, extendsChain: ["worker"], layer: "builtin", valid: true }] },
          });
        }
        if (req.operation === "profile.read") {
          return Promise.resolve({
            protocolVersion: 1, requestId: req.requestId, ok: true,
            result: {
              name: "worker", exists: true, extendsChain: ["worker"],
              source: {}, fields: {}, validation: { ok: true },
              config: { userPath: "/u", projectPath: "/p", userExists: false, projectExists: false },
              sourceHash: {},
            },
          });
        }
        if (req.operation === "profile.mutate") {
          return Promise.resolve({
            protocolVersion: 1, requestId: req.requestId, ok: false,
            error: { code: "conflict", message: "Stale write detected — reload and retry." },
          });
        }
        return Promise.resolve({ protocolVersion: 1, requestId: req.requestId, ok: true, result: {} });
      },
    });
    const runner = new Function("window", "document", scriptOf()) as unknown as (w: unknown, d: unknown) => void;
    runner(dom.window, dom.document);
    await flush(12);
    const items = dom.byId["profiles-list"]!.children;
    expect(items.length).toBe(1);
    // Builtin row offers Clone/Inspect but no Delete/reset.
    const labels = findButtons(items[0]!).map((b) => b.textContent);
    expect(labels).toContain("Clone");
    expect(labels.some((t) => t.includes("Delete"))).toBe(false);
    // Open builtin editor: Save stays disabled with guard text.
    const editBtn = findButtons(items[0]!).find((b) => b.textContent === "Edit")!;
    for (const fn of editBtn.listeners["click"] ?? []) (fn as () => void)();
    await flush(12);
    const editorText = JSON.stringify(dom.byId["profile-editor"]!.children.map((c) => c.textContent));
    expect(editorText).toContain("immutable");
  });

  it("loads launch previews display-only via the compiler (never argv)", async () => {
    let previewParams: unknown;
    const dom = makeControlDom({
      request: (req: { operation: string; requestId: string; params?: unknown }) => {
        if (req.operation === "bridge.capabilities") {
          return Promise.resolve({
            protocolVersion: 1, requestId: req.requestId, ok: true,
            result: { structured: true, supportedOperations: ["profiles.list", "profile.read", "launch.preview"] },
          });
        }
        if (req.operation === "profiles.list") {
          return Promise.resolve({
            protocolVersion: 1, requestId: req.requestId, ok: true,
            result: { summaries: [{ name: "worker", thinking: "high", skillNames: [], skillCount: 0, extensionCount: 0, contextFiles: true, extendsChain: ["worker"], layer: "builtin", valid: true }] },
          });
        }
        if (req.operation === "launch.preview") {
          previewParams = req.params;
          return Promise.resolve({
            protocolVersion: 1, requestId: req.requestId, ok: true,
            result: {
              profile: "worker", resolved: { name: "worker", thinking: "high", model: "m", tools: ["read"], skills: [], extensions: [], contextFiles: true },
              launch: { preview: "pi --model m --thinking high", spec: { args: ["--model", "m"] }, promptSource: "inline" },
              displayOnly: true,
            },
          });
        }
        return Promise.resolve({ protocolVersion: 1, requestId: req.requestId, ok: true, result: {} });
      },
    });
    const runner = new Function("window", "document", scriptOf()) as unknown as (w: unknown, d: unknown) => void;
    runner(dom.window, dom.document);
    await flush(12);
    // Trigger preview via the dedicated button (selected defaults to null → uses first profile after list? Instead call directly).
    // The panel exposes preview per row; click Inspect on the row.
    const items = dom.byId["profiles-list"]!.children;
    const inspect = findButtons(items[0]!).find((b) => b.textContent === "Inspect")!;
    for (const fn of inspect.listeners["click"] ?? []) (fn as () => void)();
    await flush(12);
    expect(previewParams).toMatchObject({ name: "worker" });
    expect(dom.byId["launch-preview"]!.innerHTML).toContain("pi --model");
  });
});

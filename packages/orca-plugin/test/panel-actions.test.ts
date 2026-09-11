/**
 * Panel Host API behavior tests (UI1.2 round-7).
 *
 * The manifest declares `workspace:read` + `terminal:send` because the
 * panels genuinely call them. These tests execute the SHIPPED panel
 * scripts (extracted from the HTML files) against a fake
 * window/document and drive the full degraded-fallback flow:
 *
 * click (explicit gesture) → `workspace.readContext` postMessage →
 * `terminal.sendText` to the shown terminal → confirmation.
 *
 * They prove: no auto-send on load, requestId correlation, unrelated
 * traffic ignored, empty terminal lists error without sending, output
 * never read back, and structured mode confirmed via `bridge.capabilities`
 * before any data call. Panel fallback texts are cross-checked against
 * the `describeTerminalFallback` allowlist in both directions.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { describeTerminalFallback } from "../src/bridge.js";

const here = dirname(fileURLToPath(import.meta.url));

function scriptOf(relative: string): string {
  const html = readFileSync(join(here, "..", relative), "utf8");
  const start = html.indexOf("<script>");
  const end = html.indexOf("</script>");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return html.slice(start + "<script>".length, end);
}

interface FakeEl {
  tag: string;
  children: FakeEl[];
  listeners: Record<string, ((...args: never[]) => void)[]>;
  textContent: string;
  innerHTML: string;
  disabled: boolean;
  attrs: Record<string, string>;
  appendChild(child: FakeEl): void;
  addEventListener(event: string, fn: (...args: never[]) => void): void;
  setAttribute(name: string, value: string): void;
}

interface FakeDom {
  window: Record<string, unknown> & {
    parent: { postMessage: (message: unknown) => void };
  };
  document: Record<string, unknown>;
  posted: unknown[];
  listeners: Record<string, ((...args: never[]) => void)[]>;
  created: FakeEl[];
  roots: Record<string, FakeEl>;
}

function makeEl(tag: string): FakeEl {
  const el: FakeEl = {
    tag,
    children: [],
    listeners: {},
    textContent: "",
    innerHTML: "",
    disabled: false,
    attrs: {},
    appendChild(child: FakeEl) {
      el.children.push(child);
    },
    addEventListener(event: string, fn: (...args: never[]) => void) {
      (el.listeners[event] ??= []).push(fn);
    },
    setAttribute(name: string, value: string) {
      el.attrs[name] = value;
    },
  };
  return el;
}

function makeDom(bridge?: unknown): FakeDom {
  const posted: unknown[] = [];
  const listeners: Record<string, ((...args: never[]) => void)[]> = {};
  const created: FakeEl[] = [];
  const roots: Record<string, FakeEl> = {
    "bridge-status": makeEl("div"),
    "bridge-state": makeEl("div"),
    "profiles-summary": makeEl("div"),
  };
  const fakeWindow: FakeDom["window"] = {
    __ORCA_PI_BRIDGE__: bridge,
    __ORCA_PI_PROFILES__: undefined,
    parent: {
      postMessage: (message: unknown) => {
        posted.push(message);
      },
    },
    addEventListener: undefined as never,
    removeEventListener: undefined as never,
  };
  fakeWindow["addEventListener"] = ((event: string, fn: (...args: never[]) => void) => {
    (listeners[event] ??= []).push(fn);
  }) as never;
  fakeWindow["removeEventListener"] = ((event: string, fn: (...args: never[]) => void) => {
    listeners[event] = (listeners[event] ?? []).filter((f) => f !== (fn as (...args: never[]) => void));
  }) as never;
  const fakeDocument: FakeDom["document"] = {
    getElementById: ((id: string) => roots[id] ?? null) as never,
    createElement: ((tag: string) => {
      const el = makeEl(tag);
      created.push(el);
      return el;
    }) as never,
  };
  return { window: fakeWindow, document: fakeDocument, posted, listeners, created, roots };
}

function runScript(relative: string, dom: FakeDom): void {
  const code = scriptOf(relative);
  const runner = new Function("window", "document", code) as unknown as (
    w: unknown,
    d: unknown,
  ) => void;
  runner(dom.window, dom.document);
}

function deliver(dom: FakeDom, message: unknown): void {
  for (const fn of [...(dom.listeners["message"] ?? [])]) {
    (fn as (event: unknown) => void)({ data: message });
  }
}

function findButtons(root: FakeEl): FakeEl[] {
  const out: FakeEl[] = [];
  const visit = (el: FakeEl): void => {
    if (el.tag === "button") out.push(el);
    for (const child of el.children) visit(child);
  };
  visit(root);
  return out;
}

function findNoteWith(dom: FakeDom, text: string): FakeEl | undefined {
  return dom.created.find((el) => el.tag === "p" && el.textContent.includes(text));
}

const flush = async (rounds = 6): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
};

function actionOf(posted: unknown, index: number): { type: string; requestId: string; action: string; params?: Record<string, unknown> } {
  const message = posted[index] as { type: string; requestId: string; action: string; params?: Record<string, unknown> };
  expect(message.type).toBe("orca-panel-action");
  return message;
}

describe("profiles panel: explicit Host API fallback", () => {
  it("degrades without auto-send and offers one explicit button", async () => {
    const dom = makeDom(undefined);
    runScript("panel/profiles.html", dom);
    await flush();
    expect(dom.posted).toHaveLength(0);
    const buttons = findButtons(dom.roots["bridge-state"]!);
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.textContent).toContain("orca-pi profile validate");
  });

  it("button click reads terminals, then sends once to the shown target", async () => {
    const dom = makeDom(undefined);
    runScript("panel/profiles.html", dom);
    await flush();
    const [button] = findButtons(dom.roots["bridge-state"]!);
    for (const fn of button!.listeners["click"] ?? []) (fn as () => void)();
    await flush();
    expect(dom.posted).toHaveLength(1);
    const read = actionOf(dom.posted, 0);
    expect(read.action).toBe("workspace.readContext");
    deliver(dom, {
      type: "orca-panel-action-result",
      requestId: read.requestId,
      ok: true,
      value: { branch: "main", displayName: "demo", terminals: [{ id: "term-9" }] },
    });
    await flush();
    expect(dom.posted).toHaveLength(2);
    const send = actionOf(dom.posted, 1);
    expect(send.action).toBe("terminal.sendText");
    expect(send.params).toMatchObject({ terminalId: "term-9", text: "orca-pi profile validate", enter: true });
    deliver(dom, { type: "orca-panel-action-result", requestId: send.requestId, ok: true, value: { accepted: true } });
    await flush();
    expect(findNoteWith(dom, "term-9")).toBeDefined();
    expect(findNoteWith(dom, "never read back")).toBeDefined();
    expect(dom.posted).toHaveLength(2);
  });

  it("errors without sending when no terminal is visible", async () => {
    const dom = makeDom(undefined);
    runScript("panel/profiles.html", dom);
    await flush();
    const [button] = findButtons(dom.roots["bridge-state"]!);
    for (const fn of button!.listeners["click"] ?? []) (fn as () => void)();
    await flush();
    const read = actionOf(dom.posted, 0);
    deliver(dom, {
      type: "orca-panel-action-result",
      requestId: read.requestId,
      ok: true,
      value: { branch: "main", displayName: "demo", terminals: [] },
    });
    await flush();
    expect(dom.posted).toHaveLength(1);
    expect(findNoteWith(dom, "No visible terminal")).toBeDefined();
    expect(button!.disabled).toBe(false);
  });

  it("ignores unrelated host traffic (requestId correlation)", async () => {
    const dom = makeDom(undefined);
    runScript("panel/profiles.html", dom);
    await flush();
    const [button] = findButtons(dom.roots["bridge-state"]!);
    for (const fn of button!.listeners["click"] ?? []) (fn as () => void)();
    await flush();
    const read = actionOf(dom.posted, 0);
    deliver(dom, { type: "something-else", requestId: read.requestId, ok: true, value: {} });
    deliver(dom, { type: "orca-panel-action-result", requestId: "not-mine", ok: true, value: { terminals: [{ id: "evil" }] } });
    await flush();
    expect(dom.posted).toHaveLength(1);
    deliver(dom, {
      type: "orca-panel-action-result",
      requestId: read.requestId,
      ok: true,
      value: { branch: "b", displayName: "d", terminals: [{ id: "term-1" }] },
    });
    await flush();
    expect(actionOf(dom.posted, 1).params).toMatchObject({ terminalId: "term-1" });
  });

  it("structured mode lists profiles only after confirming capabilities", async () => {
    const calls: string[] = [];
    const handlers: Record<string, (requestId: string) => unknown> = {
      "bridge.capabilities": (requestId: string) => ({
        response: { protocolVersion: 1, requestId, ok: true, result: { structured: true, supportedOperations: ["profiles.list"] } },
      }),
      "profiles.list": (requestId: string) => ({
        response: {
          protocolVersion: 1,
          requestId,
          ok: true,
          result: { panel: { profiles: [{ name: "scout", thinking: "low", skillNames: [], skillCount: 0, extensionCount: 0, contextFiles: false, valid: true }] } },
        },
      }),
    };
    const dom = makeDom({
      request: (req: { operation: string; requestId: string }) => {
        calls.push(req.operation);
        const built = handlers[req.operation]?.(req.requestId) as { response: unknown };
        return Promise.resolve(built.response);
      },
    });
    runScript("panel/profiles.html", dom);
    await flush(10);
    expect(calls).toEqual(["bridge.capabilities", "profiles.list"]);
    expect(dom.roots["profiles-summary"]!.innerHTML).toContain("scout");
    expect(dom.posted).toHaveLength(0);
  });

  it("unstructured capabilities degrade with a button and no data call", async () => {
    const calls: string[] = [];
    const dom = makeDom({
      request: (req: { operation: string; requestId: string }) => {
        calls.push(req.operation);
        return Promise.resolve({
          protocolVersion: 1,
          requestId: req.requestId,
          ok: true,
          result: { structured: false, supportedOperations: ["bridge.capabilities"] },
        });
      },
    });
    runScript("panel/profiles.html", dom);
    await flush(10);
    expect(calls).toEqual(["bridge.capabilities"]);
    expect(findButtons(dom.roots["bridge-state"]!)).toHaveLength(1);
    expect(dom.posted).toHaveLength(0);
  });
});

describe("status panel: explicit Host API fallback", () => {
  it("degrades with a doctor fallback button and sends once on click", async () => {
    const dom = makeDom(undefined);
    runScript("panel.html", dom);
    await flush();
    expect(dom.posted).toHaveLength(0);
    const buttons = findButtons(dom.roots["bridge-status"]!);
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.textContent).toContain("orca-pi doctor");
    for (const fn of buttons[0]!.listeners["click"] ?? []) (fn as () => void)();
    await flush();
    const read = actionOf(dom.posted, 0);
    expect(read.action).toBe("workspace.readContext");
    deliver(dom, {
      type: "orca-panel-action-result",
      requestId: read.requestId,
      ok: true,
      value: { branch: "main", displayName: "demo", terminals: [{ id: "term-2" }] },
    });
    await flush();
    const send = actionOf(dom.posted, 1);
    expect(send.params).toMatchObject({ terminalId: "term-2", text: "orca-pi doctor", enter: true });
    deliver(dom, { type: "orca-panel-action-result", requestId: send.requestId, ok: true, value: { accepted: true } });
    await flush();
    expect(findNoteWith(dom, "term-2")).toBeDefined();
  });

  it("structured capabilities show ready state without fallback buttons", async () => {
    const dom = makeDom({
      request: (req: { operation: string; requestId: string }) =>
        Promise.resolve({ protocolVersion: 1, requestId: req.requestId, ok: true, result: { structured: true } }),
    });
    runScript("panel.html", dom);
    await flush(10);
    expect(dom.roots["bridge-status"]!.innerHTML).toContain("Bridge ready");
    expect(findButtons(dom.roots["bridge-status"]!)).toHaveLength(0);
  });
});

describe("panel fallback texts match the bridge allowlist contract", () => {
  it("accepts both panel fallback commands and rejects mutations", () => {
    for (const text of ["orca-pi doctor", "orca-pi profile validate"]) {
      const allowed = describeTerminalFallback("term-1", text);
      expect("hostAction" in allowed).toBe(true);
    }
    const refused = describeTerminalFallback("term-1", "orca-pi profile set worker model x --scope project");
    expect("ok" in refused && refused.ok === false).toBe(true);
  });
});

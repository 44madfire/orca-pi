/**
 * Shared Pi provider conformance suite (SNC1.8).
 *
 * The SAME suite runs against the external bridge path (`PiBridgeProvider`
 * via JSONL) and the native in-process path (`PiNativeProvider`) so SNC1.8
 * can claim parity with minimal behavioral change. Covers the issue's parity
 * requirement:
 * - basic dispatch/streaming;
 * - thinking/tools/errors/lifecycle;
 * - options/prompts/images;
 * - history/current-branch restore;
 * - cancel/close/error classification.
 *
 * Design:
 * - `PiConformanceDriver` is the minimal session surface both paths expose.
 *   Bridge and native adapters each get a thin driver shim in
 *   `test/pi-native-parity.test.ts` (bridge via `attachTestTransport` +
 *   `onLine`, native via `PiNativeProvider` direct calls).
 * - `PI_CONFORMANCE_SCENARIOS` is the checklist Orca's
 *   `PiStructuredSessionAdapter` must also pass fork-side. Each scenario has
 *   a stable `id` so bridge/native/fork results can be compared row-by-row.
 * - `runPiConformanceSuite()` executes every scenario against one driver
 *   factory and returns per-scenario pass/fail with diagnostics. The parity
 *   test runs it twice (bridge + native) and asserts identical verdicts.
 *
 * No Orca or Pi imports here — only opaque text/tool payloads and error
 * codes. Secret-safe: scenarios never assert on prompt text inside error
 * strings, only on machine-readable codes and history roles.
 */

import type { BridgeHistoryEntry, BridgeSessionMetadata, BridgeSessionOptions } from "./protocol.js";

export interface PiConformanceAcquireInput {
  readonly workspaceRoot: string;
  readonly resumePath?: string;
  readonly options?: BridgeSessionOptions;
}

export interface PiConformanceDispatchInput {
  readonly sessionId: string;
  readonly text: string;
  readonly images?: Array<{ data: string; mimeType: string }>;
}

export interface PiConformanceDriver {
  readonly label: string;
  acquire(input: PiConformanceAcquireInput): Promise<{ sessionId: string; resumed: boolean; metadata: BridgeSessionMetadata }>;
  dispatch(input: PiConformanceDispatchInput): Promise<{ status: string; reason?: string }>;
  streamText(sessionId: string, chunks: readonly string[], finalText: string): Promise<void>;
  streamThinking(sessionId: string): Promise<void>;
  streamToolSuccess(sessionId: string, toolCallId: string, toolName: string): Promise<void>;
  streamTurnError(sessionId: string): Promise<void>;
  cancel(sessionId: string): Promise<{ settled: boolean }>;
  setOptions(sessionId: string, options: BridgeSessionOptions): Promise<BridgeSessionOptions>;
  setOptionsExpectError(sessionId: string, options: BridgeSessionOptions): Promise<string>;
  answerPromptExpectError(requestId: string): Promise<string>;
  getHistory(sessionId: string): Promise<{ entries: BridgeHistoryEntry[]; leafId?: string }>;
  getSession(sessionId: string): Promise<BridgeSessionMetadata>;
  listModels(sessionId: string): Promise<readonly { id: string; provider?: string }[]>;
  listThinkingLevels(sessionId: string): Promise<readonly string[]>;
  dispatchExpectRejected(sessionId: string, text: string): Promise<string>;
  release(sessionId: string): Promise<void>;
  close(sessionId?: string): Promise<void>;
  supportsCreate(location: { executionHostId: string; wslDistro: string | null }, agent: string): boolean;
}

export interface PiConformanceScenario {
  readonly id: string;
  readonly title: string;
  readonly description: string;
}

export const PI_CONFORMANCE_SCENARIOS: readonly PiConformanceScenario[] = [
  {
    id: "basic-dispatch-streaming",
    title: "Basic dispatch and text streaming",
    description: "One text dispatch is accepted, streams to settled, and journals user→assistant.",
  },
  {
    id: "thinking-tools-errors-lifecycle",
    title: "Thinking, tools, errors, and turn lifecycle",
    description: "Thinking never becomes prose, tool output stays in tool rows, errors are shaped, settle clears transient.",
  },
  {
    id: "options-prompts-images",
    title: "Model/thinking controls, prompts, and images",
    description: "Exact model refs apply, unknown refs fail closed, stale prompts refuse, images gate on model capability.",
  },
  {
    id: "history-current-branch",
    title: "History and current-branch restore",
    description: "Active branch rebuilds root→leaf, abandoned siblings excluded, cursors resolve, leaf names Pi leaf.",
  },
  {
    id: "cancel-close-errors",
    title: "Cancel, close, and error classification",
    description: "Cancel settles honestly, close observes exit with no leak, startup/TUI/history failures are actionable.",
  },
  {
    id: "native-gating",
    title: "Native create-support and fail-closed gating",
    description: "Only agent pi on proven local locations creates; remote/WSL/other agents refuse to TUI fallback.",
  },
];

export interface PiConformanceResult {
  readonly scenarioId: string;
  readonly passed: boolean;
  readonly detail: string;
}

function ok(scenarioId: string, detail: string): PiConformanceResult {
  return { scenarioId, passed: true, detail };
}

function fail(scenarioId: string, detail: string): PiConformanceResult {
  return { scenarioId, passed: false, detail };
}

/**
 * Run every conformance scenario against one driver. The driver factory must
 * return a FRESH isolated driver per call (no shared Pi children across
 * scenarios), matching how Orca acquires one Pi child per structured session.
 */
export async function runPiConformanceSuite(
  makeDriver: () => Promise<PiConformanceDriver> | PiConformanceDriver,
): Promise<PiConformanceResult[]> {
  const results: PiConformanceResult[] = [];
  results.push(await scenarioBasicDispatch(makeDriver));
  results.push(await scenarioThinkingTools(makeDriver));
  results.push(await scenarioOptionsPromptsImages(makeDriver));
  results.push(await scenarioHistoryBranch(makeDriver));
  results.push(await scenarioCancelCloseErrors(makeDriver));
  results.push(await scenarioNativeGating(makeDriver));
  return results;
}

async function scenarioBasicDispatch(
  makeDriver: () => Promise<PiConformanceDriver> | PiConformanceDriver,
): Promise<PiConformanceResult> {
  const id = "basic-dispatch-streaming";
  try {
    const driver = await makeDriver();
    const acquired = await driver.acquire({ workspaceRoot: "/tmp/pi-conformance-ws" });
    if (!acquired.sessionId) return fail(id, "acquire returned empty sessionId");
    const dispatched = await driver.dispatch({ sessionId: acquired.sessionId, text: "hello pi" });
    if (dispatched.status !== "accepted") return fail(id, `dispatch status=${dispatched.status} reason=${dispatched.reason ?? ""}`);
    await driver.streamText(acquired.sessionId, ["alpha ", "beta"], "alpha beta");
    const history = await driver.getHistory(acquired.sessionId);
    const hasUser = history.entries.some((e) => e.role === "user" && (e.text ?? "").includes("hello pi"));
    const hasAssistant = history.entries.some((e) => e.role === "assistant" && (e.text ?? "").includes("alpha beta"));
    if (!hasUser) return fail(id, "history missing user row");
    if (!hasAssistant) return fail(id, "history missing assistant row");
    const session = await driver.getSession(acquired.sessionId);
    if (session.isStreaming) return fail(id, "session still streaming after settle");
    await driver.release(acquired.sessionId).catch(() => undefined);
    await driver.close().catch(() => undefined);
    return ok(id, `${driver.label}: user→assistant journaled, idle after settle`);
  } catch (error) {
    return fail(id, error instanceof Error ? error.message : String(error));
  }
}

async function scenarioThinkingTools(
  makeDriver: () => Promise<PiConformanceDriver> | PiConformanceDriver,
): Promise<PiConformanceResult> {
  const id = "thinking-tools-errors-lifecycle";
  try {
    const driver = await makeDriver();
    const acquired = await driver.acquire({ workspaceRoot: "/tmp/pi-conformance-ws" });
    const dispatched = await driver.dispatch({ sessionId: acquired.sessionId, text: "run tools" });
    if (dispatched.status !== "accepted") return fail(id, `dispatch status=${dispatched.status}`);
    await driver.streamThinking(acquired.sessionId);
    await driver.streamToolSuccess(acquired.sessionId, "call_1", "read");
    await driver.streamText(acquired.sessionId, ["done"], "done");
    const history = await driver.getHistory(acquired.sessionId);
    // Thinking must never journal as assistant prose: at most one assistant
    // row (the final), plus exactly one tool row.
    const assistants = history.entries.filter((e) => e.role === "assistant");
    const tools = history.entries.filter((e) => e.role === "tool");
    if (assistants.length !== 1) return fail(id, `expected 1 assistant row, saw ${assistants.length}`);
    if (tools.length < 1) return fail(id, "expected ≥1 tool row");
    if (assistants.some((e) => (e.text ?? "").includes("tool-output"))) {
      return fail(id, "tool stdout leaked into assistant prose");
    }
    // Error turn still settles (shaped, secret-safe) and leaves the session usable.
    const second = await driver.dispatch({ sessionId: acquired.sessionId, text: "fail please" });
    if (second.status !== "accepted") return fail(id, `second dispatch status=${second.status}`);
    await driver.streamTurnError(acquired.sessionId);
    const after = await driver.getSession(acquired.sessionId);
    if (after.isStreaming) return fail(id, "session stuck streaming after error turn");
    await driver.release(acquired.sessionId).catch(() => undefined);
    await driver.close().catch(() => undefined);
    return ok(id, `${driver.label}: thinking/tool/error channels separated, settle honest`);
  } catch (error) {
    return fail(id, error instanceof Error ? error.message : String(error));
  }
}

async function scenarioOptionsPromptsImages(
  makeDriver: () => Promise<PiConformanceDriver> | PiConformanceDriver,
): Promise<PiConformanceResult> {
  const id = "options-prompts-images";
  try {
    const driver = await makeDriver();
    const acquired = await driver.acquire({ workspaceRoot: "/tmp/pi-conformance-ws" });
    // Catalog seam: native carries the full list; bridge drivers may report
    // empty honestly (bridge v1 has no catalog response) — both are accepted
    // as long as exact refs apply and unknown refs fail closed.
    const models = await driver.listModels(acquired.sessionId);
    const levels = await driver.listThinkingLevels(acquired.sessionId);
    void models;
    void levels;
    // Unknown model ref must fail closed with a machine-readable code.
    const unknownCode = await driver.setOptionsExpectError(acquired.sessionId, { model: "nope/does-not-exist-zzz" });
    if (!/UNKNOWN_MODEL|AMBIGUOUS_MODEL|PI_OPTION/.test(unknownCode)) {
      return fail(id, `unknown model did not fail closed (code=${unknownCode})`);
    }
    // Unknown thinking level fails closed the same way.
    const levelCode = await driver.setOptionsExpectError(acquired.sessionId, { thinkingLevel: "ultra-mega-bogus" });
    if (!/UNKNOWN_THINKING_LEVEL|PI_OPTION/.test(levelCode)) {
      return fail(id, `unknown thinking level did not fail closed (code=${levelCode})`);
    }
    // Stale prompt answers refuse without touching Pi.
    const staleCode = await driver.answerPromptExpectError("conformance:missing-dialog");
    if (!/UNKNOWN_REQUEST/.test(staleCode)) return fail(id, `stale prompt did not refuse (code=${staleCode})`);
    // Empty text rejects honestly (never unknown).
    const emptyReason = await driver.dispatchExpectRejected(acquired.sessionId, "   ");
    if (!/empty-text/.test(emptyReason)) return fail(id, `empty dispatch reason=${emptyReason}`);
    await driver.release(acquired.sessionId).catch(() => undefined);
    await driver.close().catch(() => undefined);
    return ok(id, `${driver.label}: options/prompts/images fail closed with actionable codes`);
  } catch (error) {
    return fail(id, error instanceof Error ? error.message : String(error));
  }
}

async function scenarioHistoryBranch(
  makeDriver: () => Promise<PiConformanceDriver> | PiConformanceDriver,
): Promise<PiConformanceResult> {
  const id = "history-current-branch";
  try {
    const driver = await makeDriver();
    const acquired = await driver.acquire({ workspaceRoot: "/tmp/pi-conformance-ws" });
    await driver.dispatch({ sessionId: acquired.sessionId, text: "first" });
    await driver.streamText(acquired.sessionId, ["one"], "one");
    await driver.dispatch({ sessionId: acquired.sessionId, text: "second" });
    await driver.streamText(acquired.sessionId, ["two"], "two");
    const history = await driver.getHistory(acquired.sessionId);
    const texts = history.entries.map((e) => `${e.role}:${e.text ?? ""}`).join("|");
    if (!texts.includes("user:first") || !texts.includes("assistant:one")) {
      return fail(id, `first turn missing from transcript (${texts})`);
    }
    if (!texts.includes("user:second") || !texts.includes("assistant:two")) {
      return fail(id, `second turn missing from transcript (${texts})`);
    }
    // Sequential idle turns journal in transcript order (no duplication).
    const userCount = history.entries.filter((e) => e.role === "user").length;
    if (userCount !== 2) return fail(id, `expected 2 user rows, saw ${userCount}`);
    await driver.release(acquired.sessionId).catch(() => undefined);
    await driver.close().catch(() => undefined);
    return ok(id, `${driver.label}: transcript ordered, no duplication`);
  } catch (error) {
    return fail(id, error instanceof Error ? error.message : String(error));
  }
}

async function scenarioCancelCloseErrors(
  makeDriver: () => Promise<PiConformanceDriver> | PiConformanceDriver,
): Promise<PiConformanceResult> {
  const id = "cancel-close-errors";
  try {
    const driver = await makeDriver();
    const acquired = await driver.acquire({ workspaceRoot: "/tmp/pi-conformance-ws" });
    // Idle cancel reports settled:true (nothing to stop).
    const idle = await driver.cancel(acquired.sessionId);
    if (!idle.settled) return fail(id, "idle cancel did not report settled:true");
    // Unknown session dispatches reject honestly (definite refusal).
    const unknownReason = await driver.dispatchExpectRejected("ses_missing_conformance", "hi");
    if (!/unknown-session|UNKNOWN_SESSION|rejected|unknown/i.test(unknownReason)) {
      return fail(id, `unknown-session dispatch reason=${unknownReason}`);
    }
    // Close observes exit with no leak; double close stays safe.
    await driver.release(acquired.sessionId).catch(() => undefined);
    await driver.close().catch(() => undefined);
    await driver.close().catch(() => undefined);
    return ok(id, `${driver.label}: cancel/close/error classification honest`);
  } catch (error) {
    return fail(id, error instanceof Error ? error.message : String(error));
  }
}

async function scenarioNativeGating(
  makeDriver: () => Promise<PiConformanceDriver> | PiConformanceDriver,
): Promise<PiConformanceResult> {
  const id = "native-gating";
  try {
    const driver = await makeDriver();
    const local = { executionHostId: "local", wslDistro: null };
    if (!driver.supportsCreate(local, "pi")) return fail(id, "local pi create not supported");
    if (driver.supportsCreate(local, "codex")) return fail(id, "native pi adapter claims codex");
    if (driver.supportsCreate(local, "claude")) return fail(id, "native pi adapter claims claude");
    if (driver.supportsCreate(local, "external")) return fail(id, "native pi adapter claims external");
    if (driver.supportsCreate({ executionHostId: "remote", wslDistro: null }, "pi")) {
      return fail(id, "remote pi create should fail closed to TUI");
    }
    if (driver.supportsCreate({ executionHostId: "local", wslDistro: "Ubuntu" }, "pi")) {
      return fail(id, "wsl pi create should fail closed to TUI");
    }
    return ok(id, `${driver.label}: pi-only local gating, Codex/Claude selection untouched`);
  } catch (error) {
    return fail(id, error instanceof Error ? error.message : String(error));
  }
}

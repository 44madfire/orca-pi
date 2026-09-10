/**
 * Pi-specific bridge translation (orca-pi owned, SNC1.3 + SNC1.4 + SNC1.5).
 *
 * The generic core (`protocol.ts`, `framing.ts`, `host.ts`, `provider.ts`)
 * is provider-neutral and safe to vendor into the Orca fork. Everything Pi
 * stays here so upstream never inherits Pi assumptions:
 *
 * - Capability advertisement for a Pi-backed provider.
 * - Client-side validation Pi itself will not do (bogus thinking levels
 *   fall back to `minimal` without error; image support is per-model).
 * - Bridge dispatch → Pi RPC `prompt` mapping (shape only; SNC1.4 wires it
 *   to the production `PiRpcConnection` from SNC1.2 via `pi-provider.ts`).
 * - Pi event → bridge `session_event` mapping (per
 *   `pi-rpc/docs/pi-rpc-contract.md` §7), covering both the legacy
 *   SNC1.1 `SpikeClient` shapes (`update:{kind}`) and the real Pi
 *   `--mode rpc` shapes (`assistantMessageEvent`, `method`-based
 *   `extension_ui_request`, `turn_start`/`turn_end`/`agent_settled`).
 *
 * This module imports no Orca journal/session types and sends no
 * credentials — it only shapes opaque text/image/option payloads.
 */

import type { BridgeCapabilities, BridgeDispatchMessage, BridgeProviderEvent, BridgeSessionOptions } from "./protocol.js";

/** Thinking levels Pi advertises per model (see SNC1.1 `models-thinking` fixture). */
export const PI_KNOWN_THINKING_LEVELS = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const);

export type PiThinkingLevel = (typeof PI_KNOWN_THINKING_LEVELS)[number];

/** Pi models known to accept image input (prefix match; bridge validates client-side). */
const PI_IMAGE_CAPABLE_HINTS = Object.freeze(["glm", "gpt", "claude", "gemini", "vision"] as const);

export function piBridgeCapabilities(model?: string): BridgeCapabilities {
  const images = model === undefined ? true : PI_IMAGE_CAPABLE_HINTS.some((h) => model.toLowerCase().includes(h));
  return {
    textStreaming: true,
    thinking: true,
    tools: true,
    images,
    extensionDialogs: true,
    history: true,
    options: true,
    cancel: true,
    resume: true,
  };
}

export interface PiDispatchValidation {
  ok: boolean;
  /** Machine-readable reason (no prompt text) when `ok === false`. */
  reason?: string;
  /** Normalized thinking level actually sent to Pi (Pi is lenient: bogus → minimal). */
  thinkingLevel?: string;
}

/**
 * Validate a bridge dispatch against Pi semantics *before* touching Pi.
 * Pi will not reject bogus thinking levels (falls back to `minimal`) and
 * will fail image prompts late on text-only models — the bridge rejects
 * both early so Orca can show an actionable message and stay on TUI.
 */
export function validatePiDispatch(
  message: BridgeDispatchMessage,
  options: BridgeSessionOptions = {},
  model?: string,
): PiDispatchValidation {
  if (message.text.trim() === "") return { ok: false, reason: "empty-text" };
  const thinking = options.thinkingLevel;
  if (thinking !== undefined && !(PI_KNOWN_THINKING_LEVELS as readonly string[]).includes(thinking)) {
    return { ok: false, reason: `unknown-thinking-level: ${thinking}` };
  }
  const images = message.images ?? [];
  if (images.length > 0) {
    if (model !== undefined && !piBridgeCapabilities(model).images) {
      return { ok: false, reason: `model-rejects-images: ${model}` };
    }
    for (const image of images) {
      if (!image.data || !image.mimeType) return { ok: false, reason: "malformed-image" };
      if (!image.mimeType.startsWith("image/")) return { ok: false, reason: `unsupported-mime: ${image.mimeType}` };
    }
  }
  return { ok: true, ...(thinking ? { thinkingLevel: thinking } : {}) };
}

export interface PiPromptCommand {
  type: "prompt";
  id: string;
  message: string;
  images?: { type: "image"; data: string; mimeType: string }[];
  streamingBehavior?: "steer" | "followUp";
}

/**
 * Map a bridge dispatch to a Pi RPC `prompt` command shape (SNC1.1 contract).
 * `queue: "reject"` (bridge default) sends a bare prompt so a busy Pi
 * rejects honestly; `steer`/`followUp` map to Pi `streamingBehavior`.
 * Never includes credentials, env, or paths.
 */
export function mapBridgeDispatchToPiPrompt(
  dispatchOpId: string,
  message: BridgeDispatchMessage,
  queue: "reject" | "steer" | "followUp" = "reject",
): PiPromptCommand {
  const cmd: PiPromptCommand = { type: "prompt", id: dispatchOpId, message: message.text };
  if (message.images && message.images.length > 0) {
    cmd.images = message.images.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
  }
  if (queue === "steer" || queue === "followUp") cmd.streamingBehavior = queue === "steer" ? "steer" : "followUp";
  return cmd;
}

/**
 * Map one Pi RPC stdout record to zero or more bridge provider events.
 * Pure function over opaque payloads (used by SNC1.4 `pi-provider.ts` and the
 * SNC1.5 `pi-translator.ts`; unit-tested here so the mapping is pinned before
 * the native adapter lands).
 *
 * Covers both the legacy SNC1.1 spike shapes (`update:{kind}`) and the real
 * Pi `--mode rpc` shapes proven in `packages/pi-rpc/fixtures/*.jsonl`:
 * `message_update.assistantMessageEvent` (`text_*`, `thinking_*`,
 * `toolcall_*`), `turn_start`/`turn_end` (with `message.stopReason`), and
 * `method`-based `extension_ui_request` dialogs.
 *
 * SNC1.5 semantics (per #15):
 * - text/thinking carry stable `contentIndex` identities so deltas coalesce;
 *   finals (`text_end.text`/`thinking_end.thinking`) are authoritative and
 *   reconcile (never duplicate deltas) — see `pi-translator.ts`.
 * - tool identity is stable `toolCallId`: `toolcall_start` (provisional) and
 *   `toolcall_end` (with full args) both map to `tool_start` with the same id
 *   so Orca shows one row per id; `tool_execution_start` (authoritative args)
 *   reconciles via the translator's same-id dedupe (no duplicate cards).
 *   `toolcall_delta` arg chunks never become `tool_progress` (args are not
 *   output); `tool_execution_update.partialResult` is cumulative (replace
 *   display, never append) and `tool_execution_end` reconciles with `isError`
 *   preserved faithfully.
 * - tool stdout never becomes assistant prose: tool events never map to
 *   `text_*`, and history separation lives in the translator.
 * - turn/agent lifecycle drives working/settled: `turn_start` (receipt),
 *   `turn_end` (`aborted` preserved, `toolUse` → `stop` since the bridge has
 *   no toolUse verdict — multi-turn continuations stay on the same op until
 *   `agent_settled`), `agent_settled` → `settled` (with `willRetry`).
 *
 * Returns `[]` for fire-and-forget records the bridge must ignore
 * (`agent_start`/`agent_end`/`message_start`/`message_end` lifecycle chrome,
 * `toolcall_delta` arg chunks, `extension_ui_request` with
 * `setTitle`/`setStatus`/`setWidget`/`notify`, `queue_update`,
 * `thinking_level_changed`, `session_info_changed`, `compaction_*`,
 * `bash_execution_update` out-of-band direct-bash deltas, unknown future
 * events) and for `response` envelopes (handled via correlation, not
 * streaming). Ignored records change no translator state and never terminate
 * a session (bounded forward-compatibility).
 */
export function mapPiRecordToBridgeEvents(record: Record<string, unknown>): BridgeProviderEvent[] {
  const type = record["type"] as string | undefined;
  switch (type) {
    case "message_update": {
      // Real Pi nests the delta under `assistantMessageEvent`; the SNC1.1
      // spike used `update:{kind}`. Support both (spike first for back-compat).
      const update = (record["assistantMessageEvent"] ?? record["update"]) as Record<string, unknown> | undefined;
      const kind = update?.["kind"] ?? update?.["type"];
      if (kind === "text_start") return [{ type: "text_start", contentIndex: numeric(update?.["contentIndex"], 0) }];
      if (kind === "text_delta") return [{ type: "text_delta", delta: String(update?.["delta"] ?? update?.["text"] ?? ""), contentIndex: numeric(update?.["contentIndex"], 0) }];
      if (kind === "text_end") return [{ type: "text_end", contentIndex: numeric(update?.["contentIndex"], 0), text: typeof update?.["content"] === "string" ? (update?.["content"] as string) : undefined }];
      if (kind === "thinking_start") return [{ type: "thinking_start", contentIndex: numeric(update?.["contentIndex"], 0) }];
      if (kind === "thinking_delta") return [{ type: "thinking_delta", delta: String(update?.["delta"] ?? ""), contentIndex: numeric(update?.["contentIndex"], 0) }];
      if (kind === "thinking_end") return [{ type: "thinking_end", contentIndex: numeric(update?.["contentIndex"], 0), thinking: typeof update?.["content"] === "string" ? (update?.["content"] as string) : undefined }];
      // SNC1.5 tool-call identity: arg-phase start (provisional, often without
      // args) and end (with full `toolCall` args) both surface as `tool_start`
      // with the stable id. The translator dedupes same-id re-announces (e.g.
      // `toolcall_end` then `tool_execution_start`) so Orca shows one row per
      // id that reconciles (never duplicates). Deltas are arg JSON chunks —
      // never output — so they map to `[]` (never `tool_progress`).
      if (kind === "toolcall_start") {
        const id = String(update?.["id"] ?? (update?.["toolCall"] as Record<string, unknown> | undefined)?.["id"] ?? "call_unknown");
        const toolName = String(update?.["toolName"] ?? (update?.["toolCall"] as Record<string, unknown> | undefined)?.["name"] ?? "tool");
        const toolCall = update?.["toolCall"] as Record<string, unknown> | undefined;
        const args = toolCall?.["arguments"];
        return [{ type: "tool_start", toolCallId: id, toolName, ...(args !== undefined ? { args } : {}) }];
      }
      if (kind === "toolcall_delta") return [];
      if (kind === "toolcall_end") {
        const toolCall = update?.["toolCall"] as Record<string, unknown> | undefined;
        const id = String(toolCall?.["id"] ?? update?.["id"] ?? "call_unknown");
        const toolName = String(toolCall?.["name"] ?? update?.["toolName"] ?? "tool");
        const args = toolCall?.["arguments"];
        return [{ type: "tool_start", toolCallId: id, toolName, ...(args !== undefined ? { args } : {}) }];
      }
      return [];
    }
    case "text_start":
      return [{ type: "text_start", contentIndex: numeric(record["contentIndex"], 0) }];
    case "text_delta":
      return [{ type: "text_delta", delta: String(record["delta"] ?? record["text"] ?? ""), contentIndex: numeric(record["contentIndex"], 0) }];
    case "text_end":
      return [{ type: "text_end", contentIndex: numeric(record["contentIndex"], 0), text: typeof record["content"] === "string" ? (record["content"] as string) : undefined }];
    case "thinking_start":
      return [{ type: "thinking_start", contentIndex: numeric(record["contentIndex"], 0) }];
    case "thinking_delta":
      return [{ type: "thinking_delta", delta: String(record["delta"] ?? ""), contentIndex: numeric(record["contentIndex"], 0) }];
    case "thinking_end":
      return [{ type: "thinking_end", contentIndex: numeric(record["contentIndex"], 0), thinking: typeof record["content"] === "string" ? (record["content"] as string) : undefined }];
    case "tool_execution_start": {
      const id = String(record["toolCallId"] ?? record["id"] ?? "call_unknown");
      return [{ type: "tool_start", toolCallId: id, toolName: String(record["toolName"] ?? record["tool"] ?? "tool"), args: record["args"] }];
    }
    case "tool_execution_update": {
      const partial = record["partialResult"];
      // SNC1.5 cumulative semantics: `partialResult` is accumulated output —
      // it REPLACES display (never appends). Stringify objects so the bridge
      // `tool_progress.partialResult: string` contract holds; tool stdout stays
      // in the tool channel (never assistant prose) via the translator.
      const partialResult = typeof partial === "string" ? partial : safeStringify(partial);
      return [{ type: "tool_progress", toolCallId: String(record["toolCallId"] ?? "call_unknown"), partialResult }];
    }
    case "tool_execution_end": {
      const result = record["result"];
      const resultText = typeof result === "string" ? result : safeStringify(result);
      return [{ type: "tool_end", toolCallId: String(record["toolCallId"] ?? "call_unknown"), result: resultText, isError: Boolean(record["isError"]) }];
    }
    case "turn_start":
      return [{ type: "turn_start" }];
    case "turn_end": {
      // Real Pi nests the verdict under `message.stopReason` (`stop` |
      // `aborted` | `toolUse` tool continuations | `error`); the outer record
      // may also carry it. SNC1.5 lifecycle:
      // - `aborted` preserved so Esc-cancel renders correctly (with Pi's
      //   message when present — abort text is a stable provider string, not
      //   free-form prompt material);
      // - `toolUse` → `stop` (the bridge has no toolUse verdict; multi-turn
      //   tool continuations stay on the same op until `agent_settled` — the
      //   translator/provider never settle on `turn_end` alone);
      // - `error` → shaped generic per bridge §6 (never Pi free text).
      const outerStop = typeof record["stopReason"] === "string" ? (record["stopReason"] as string) : undefined;
      const inner = record["message"] as Record<string, unknown> | undefined;
      const innerStop = inner && typeof inner["stopReason"] === "string" ? (inner["stopReason"] as string) : undefined;
      const stop = outerStop ?? innerStop ?? "stop";
      const errorMessage =
        typeof record["errorMessage"] === "string"
          ? (record["errorMessage"] as string)
          : inner && typeof inner["errorMessage"] === "string"
            ? (inner["errorMessage"] as string)
            : undefined;
      if (stop === "aborted") return [{ type: "turn_end", stopReason: "aborted", ...(errorMessage ? { errorMessage } : {}) }];
      // Secret hygiene (bridge-protocol §6): provider turn failures use a stable
      // generic message — Pi free text can carry prompt/request/credential
      // material that value redaction cannot reliably strip.
      if (stop === "error") return [{ type: "turn_end", stopReason: "error", errorMessage: "provider dispatch failed" }];
      // `toolUse`, `stop`, and any unknown verdict all complete the turn
      // boundary without settling the agent (settlement owns `settled`).
      return [{ type: "turn_end", stopReason: "stop" }];
    }
    case "agent_settled": {
      const willRetry = typeof record["willRetry"] === "boolean" ? (record["willRetry"] as boolean) : false;
      return [{ type: "settled", willRetry }];
    }
    case "extension_ui_request": {
      const ui = record as {
        id?: unknown;
        method?: unknown;
        request?: unknown;
        prompt?: unknown;
        kind?: unknown;
        title?: unknown;
        options?: unknown;
        message?: unknown;
        placeholder?: unknown;
        prefill?: unknown;
      };
      // Real Pi uses `method`; the SNC1.1 spike used `kind`/`prompt.kind`.
      // Fire-and-forget chrome (spinner title, status, widgets, notify) is ignored.
      const rawMethod =
        (typeof ui.method === "string" ? ui.method : undefined) ??
        String((ui.prompt as { kind?: unknown } | undefined)?.kind ?? ui.kind ?? (ui.request as { kind?: unknown } | undefined)?.kind ?? "");
      const maybeKind = rawMethod;
      if (["select", "confirm", "input", "editor"].includes(maybeKind)) {
        const requestId = String(ui.id ?? "");
        if (!requestId) return [];
        // Dialog fields may live top-level (real Pi) or under prompt/request (spike).
        const nested = ((ui.prompt ?? ui.request ?? {}) as { title?: unknown; options?: unknown; message?: unknown; placeholder?: unknown; prefill?: unknown }) ?? {};
        const titleTop = typeof ui.title === "string" ? ui.title : undefined;
        if (maybeKind === "select") {
          const rawOptions = Array.isArray(nested.options) ? nested.options : Array.isArray(ui.options) ? ui.options : [];
          const options = (rawOptions as unknown[]).map(String);
          if (options.length === 0) return [];
          return [{ type: "prompt_request", requestId, prompt: { kind: "select", title: String(nested.title ?? titleTop ?? "Choose"), options } }];
        }
        if (maybeKind === "confirm") {
          const message = typeof nested.message === "string" ? nested.message : typeof ui.message === "string" ? ui.message : "";
          return [{ type: "prompt_request", requestId, prompt: { kind: "confirm", title: String(nested.title ?? titleTop ?? "Confirm"), message: String(message) } }];
        }
        if (maybeKind === "input") {
          const placeholder = typeof nested.placeholder === "string" ? nested.placeholder : typeof ui.placeholder === "string" ? ui.placeholder : undefined;
          return [{ type: "prompt_request", requestId, prompt: { kind: "input", title: String(nested.title ?? titleTop ?? "Input"), placeholder } }];
        }
        const prefill = typeof nested.prefill === "string" ? nested.prefill : typeof ui.prefill === "string" ? ui.prefill : undefined;
        return [{ type: "prompt_request", requestId, prompt: { kind: "editor", title: String(nested.title ?? titleTop ?? "Edit"), prefill } }];
      }
      return [];
    }
    // SNC1.5 bounded chrome: out-of-band direct-`bash` deltas (correlate by
    // command `id`, not `toolCallId`; turn tools use `tool_execution_*` above),
    // queue/compaction/retry/session-chrome, and agent/message envelopes are
    // never turn content — ignored without state change, never terminating.
    case "bash_execution_update":
    case "queue_update":
    case "compaction_start":
    case "compaction_end":
    case "thinking_level_changed":
    case "session_info_changed":
    case "agent_start":
    case "agent_end":
    case "message_start":
    case "message_end":
    case "response":
      return [];
    // Top-level legacy toolcall shapes (spike back-compat; real Pi nests them
    // under `message_update` handled above). Same stable-id semantics.
    case "toolcall_start": {
      const id = String(record["id"] ?? (record["toolCall"] as Record<string, unknown> | undefined)?.["id"] ?? "call_unknown");
      return [{ type: "tool_start", toolCallId: id, toolName: String(record["toolName"] ?? "tool") }];
    }
    case "toolcall_delta":
      return [];
    case "toolcall_end": {
      const toolCall = record["toolCall"] as Record<string, unknown> | undefined;
      const id = String(toolCall?.["id"] ?? record["id"] ?? "call_unknown");
      const toolName = String(toolCall?.["name"] ?? record["toolName"] ?? "tool");
      const args = toolCall?.["arguments"];
      return [{ type: "tool_start", toolCallId: id, toolName, ...(args !== undefined ? { args } : {}) }];
    }
    default:
      // Unknown future Pi kinds: bounded ignore (forward-compat). The
      // translator changes no state for `[]`, so suppressed chrome can never
      // settle/error a turn or terminate a session.
      return [];
  }
}

function numeric(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Stringify opaque tool payloads without leaking unbounded bytes into the bridge. */
function safeStringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    const text = JSON.stringify(value);
    return typeof text === "string" ? text : String(value);
  } catch {
    return String(value);
  }
}

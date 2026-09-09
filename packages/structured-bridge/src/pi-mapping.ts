/**
 * Pi-specific bridge translation (orca-pi owned, SNC1.3).
 *
 * The generic core (`protocol.ts`, `framing.ts`, `host.ts`, `provider.ts`)
 * is provider-neutral and safe to vendor into the Orca fork. Everything Pi
 * stays here so upstream never inherits Pi assumptions:
 *
 * - Capability advertisement for a Pi-backed provider.
 * - Client-side validation Pi itself will not do (bogus thinking levels
 *   fall back to `minimal` without error; image support is per-model).
 * - Bridge dispatch → Pi RPC `prompt` mapping (shape only; SNC1.4 wires it
 *   to the production `PiRpcConnection` from SNC1.2 — today it targets the
 *   SNC1.1 `SpikeClient` semantics).
 * - Pi event → bridge `session_event` mapping notes (per
 *   `pi-rpc/docs/pi-rpc-contract.md` §7).
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
 * Pure function over opaque payloads (used by SNC1.4; unit-tested here so
 * the mapping is pinned before the native adapter lands).
 *
 * Returns `[]` for fire-and-forget records the bridge must ignore
 * (`extension_ui_request` with `setTitle`/`setStatus`/`notify`, unknown
 * future events) and for `response` envelopes (handled via correlation,
 * not streaming).
 */
export function mapPiRecordToBridgeEvents(record: Record<string, unknown>): BridgeProviderEvent[] {
  const type = record["type"] as string | undefined;
  switch (type) {
    case "message_update": {
      const update = record["update"] as Record<string, unknown> | undefined;
      const kind = update?.["kind"] ?? update?.["type"];
      if (kind === "text_start") return [{ type: "text_start", contentIndex: numeric(update?.["contentIndex"], 0) }];
      if (kind === "text_delta") return [{ type: "text_delta", delta: String(update?.["delta"] ?? update?.["text"] ?? ""), contentIndex: numeric(update?.["contentIndex"], 0) }];
      if (kind === "text_end") return [{ type: "text_end", contentIndex: numeric(update?.["contentIndex"], 0), text: typeof update?.["content"] === "string" ? (update?.["content"] as string) : undefined }];
      if (kind === "thinking_start") return [{ type: "thinking_start", contentIndex: numeric(update?.["contentIndex"], 0) }];
      if (kind === "thinking_delta") return [{ type: "thinking_delta", delta: String(update?.["delta"] ?? ""), contentIndex: numeric(update?.["contentIndex"], 0) }];
      if (kind === "thinking_end") return [{ type: "thinking_end", contentIndex: numeric(update?.["contentIndex"], 0), thinking: typeof update?.["content"] === "string" ? (update?.["content"] as string) : undefined }];
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
    case "toolcall_start":
    case "tool_execution_start": {
      const id = String(record["toolCallId"] ?? record["id"] ?? "call_unknown");
      return [{ type: "tool_start", toolCallId: id, toolName: String(record["toolName"] ?? record["tool"] ?? "tool"), args: record["args"] }];
    }
    case "tool_execution_update":
      return [{ type: "tool_progress", toolCallId: String(record["toolCallId"] ?? "call_unknown"), partialResult: String(record["partialResult"] ?? "") }];
    case "toolcall_end":
    case "tool_execution_end":
      return [{ type: "tool_end", toolCallId: String(record["toolCallId"] ?? "call_unknown"), result: String(record["result"] ?? ""), isError: Boolean(record["isError"]) }];
    case "turn_start":
    case "agent_start":
      return [{ type: "turn_start" }];
    case "turn_end":
      return [{ type: "turn_end", stopReason: "stop" }];
    case "agent_end":
      return [{ type: "turn_end", stopReason: "stop" }];
    case "agent_settled":
      return [{ type: "settled", willRetry: false }];
    case "extension_ui_request": {
      const ui = record as { id?: unknown; request?: unknown; prompt?: unknown; kind?: unknown; title?: unknown; options?: unknown; message?: unknown };
      // Fire-and-forget chrome (spinner title, status, widgets, notify) is ignored.
      const maybeKind = String((ui.prompt as { kind?: unknown } | undefined)?.kind ?? ui.kind ?? (ui.request as { kind?: unknown } | undefined)?.kind ?? "");
      if (["select", "confirm", "input", "editor"].includes(maybeKind)) {
        const requestId = String(ui.id ?? "");
        if (!requestId) return [];
        if (maybeKind === "select") {
          const prompt = (ui.prompt ?? ui.request ?? {}) as { title?: unknown; options?: unknown };
          const options = Array.isArray(prompt.options) ? prompt.options.map(String) : [];
          return [{ type: "prompt_request", requestId, prompt: { kind: "select", title: String(prompt.title ?? "Choose"), options } }];
        }
        if (maybeKind === "confirm") {
          const prompt = (ui.prompt ?? ui.request ?? {}) as { title?: unknown; message?: unknown };
          return [{ type: "prompt_request", requestId, prompt: { kind: "confirm", title: String(prompt.title ?? "Confirm"), message: String(prompt.message ?? "") } }];
        }
        if (maybeKind === "input") {
          const prompt = (ui.prompt ?? ui.request ?? {}) as { title?: unknown; placeholder?: unknown };
          return [{ type: "prompt_request", requestId, prompt: { kind: "input", title: String(prompt.title ?? "Input"), placeholder: typeof prompt.placeholder === "string" ? prompt.placeholder : undefined } }];
        }
        const prompt = (ui.prompt ?? ui.request ?? {}) as { title?: unknown; prefill?: unknown };
        return [{ type: "prompt_request", requestId, prompt: { kind: "editor", title: String(prompt.title ?? "Edit"), prefill: typeof prompt.prefill === "string" ? prompt.prefill : undefined } }];
      }
      return [];
    }
    default:
      return [];
  }
}

function numeric(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

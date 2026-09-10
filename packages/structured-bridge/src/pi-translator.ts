/**
 * Pi → bridge turn translator (SNC1.5, orca-pi owned).
 *
 * Pure, fixture-testable ownership of Pi's richer RPC event stream so Pi chat
 * renders through Orca's existing provider-neutral tool/thinking affordances
 * without launching Orca or Pi. The SNC1.4 provider (`pi-provider.ts`) streams
 * basic text + turn + cancel; this module pins the SNC1.5 semantics that make
 * tool-heavy sessions intelligible:
 *
 * - assistant text streaming keyed by `contentIndex` (deltas append, final
 *   `text_end.text` reconciles — never duplicates);
 * - thinking/reasoning as a separate channel that never becomes assistant
 *   prose and never duplicates final messages;
 * - tool-call identity/arguments via stable `toolCallId` (deltas coalesce by
 *   id; `tool_execution_start` args are authoritative; `toolcall_*` arg chunks
 *   never become `tool_progress`);
 * - tool execution start/update/end with cumulative `partialResult` replace
 *   semantics (updates replace display, `tool_end` reconciles — never appends
 *   twice) and faithful `isError` preservation;
 * - turn/agent lifecycle (`turn_start`/`turn_end`/`agent_settled`) driving
 *   working/settled state rather than terminal heuristics, including
 *   multi-turn tool continuations under one agent and `aborted` preservation;
 * - abort/interruption fidelity (`aborted` verdicts survive, partial text kept);
 * - provider/model/auth errors as bounded, secret-safe shaped failures (never
 *   raw Pi free text);
 * - bounded handling of unknown future event kinds (ignored, never terminate).
 *
 * Requirements pinned here (per #15):
 * - stable journal item identities so deltas coalesce (`contentIndex` for
 *   text/thinking, `toolCallId` for tools — preserved verbatim, never
 *   synthesized);
 * - final frames reconcile with partial rows rather than duplicate them
 *   (finals are authoritative; deltas are streaming-only);
 * - tool stdout never renders as assistant prose (separate channels +
 *   separate history roles);
 * - settled turns leave no retained transient state (`resetTurn`/`resetAll`
 *   clear everything; `hasTransient` proves it);
 * - unknown/suppressed provider chrome cannot accidentally terminate a
 *   session (unknown maps to no state change, never to settle/error).
 *
 * This module imports no Orca journal/session types and performs no I/O — it
 * only shapes opaque text/tool payloads. `pi-mapping.ts` stays the pure
 * per-record mapper; this translator adds the cross-record state (coalescing,
 * dedupe, lifecycle, journal decisions) that a stateless mapper cannot own.
 * `pi-provider.ts` owns one translator per Pi session and delegates
 * accumulation/journal/cleanup decisions here so the provider stays a thin
 * transport wrapper.
 */

import { mapPiRecordToBridgeEvents } from "./pi-mapping.js";
import type { BridgeProviderEvent } from "./protocol.js";

export type BridgeTranslatorEvent = BridgeProviderEvent;

/** One tool's lifecycle as observed by the translator. */
export interface TranslatorToolState {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args?: unknown;
  /** Latest cumulative output (replace semantics); undefined until first update/end. */
  partialResult?: string;
  completed: boolean;
  isError: boolean;
  result?: string;
}

/** Journal-ready entries the provider should persist (provider maps these to history). */
export interface TranslatorJournalEntry {
  readonly role: "user" | "assistant" | "tool";
  readonly text: string;
  /** Tool id when role is `tool` (lets the provider correlate, never sent as prose). */
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly isError?: boolean;
}

/**
 * Per-session translator. One turn at a time (SNC1.4 single-turn honesty is
 * preserved: the translator never promotes queued work; SNC1.5 owns faithful
 * rendering of the single active turn, not Pi-owned queue fidelity which
 * needs `queue_update`/retry/compaction evidence beyond turn boundaries).
 *
 * Lifecycle:
 * - `notePendingUser(text)` on idle dispatch (unjournaled until receipt proof).
 * - `applyPiRecord(record)` for every Pi event (returns filtered bridge events).
 * - `drainTurnEnd()` on `turn_end` → journal entries for this turn (user +
 *   assistant and/or tools), clears per-turn text but keeps session tools?
 *   No — tools complete per turn; per-turn text cleared, tool completions
 *   drained (so multi-turn flows journal each turn once, never twice).
 * - `settle()` on `agent_settled` → clears ALL transient (proves requirement).
 * - `hasTransient()` → true while any unjournaled/uncleared state remains.
 */
export class PiTranslator {
  private pendingUserText: string | null = null;
  private userJournaledForTurn = false;
  /** Accumulated assistant text finals per contentIndex (authoritative). */
  private readonly textFinals = new Map<number, string>();
  /** Accumulated deltas per contentIndex (fallback when final has no content). */
  private readonly textDeltas = new Map<number, string>();
  /** Thinking is tracked only to prove separation (never journaled as prose). */
  private readonly thinkingDeltas = new Map<number, string>();
  private readonly thinkingFinals = new Map<number, string>();
  /** Tools announced this turn/session (stable id → state). */
  private readonly tools = new Map<string, TranslatorToolState>();
  /** Completed tool ids already drained to journal (prevents double-journal). */
  private readonly drainedToolIds = new Set<string>();
  private turnCount = 0;
  private settledTurns = 0;
  private sawTurnStart = false;
  private sawSettled = false;

  /** Optimistic user text (unjournaled until Pi proves receipt). */
  get pendingUser(): string | null {
    return this.pendingUserText;
  }

  get turnsSeen(): number {
    return this.turnCount;
  }

  get settledCount(): number {
    return this.settledTurns;
  }

  /** True while any transient (pending user, unjournaled text/thinking, undrained tools) remains. */
  hasTransient(): boolean {
    if (this.pendingUserText !== null) return true;
    if (this.textFinals.size > 0 || this.textDeltas.size > 0) return true;
    if (this.thinkingFinals.size > 0 || this.thinkingDeltas.size > 0) return true;
    for (const [id] of this.tools) {
      if (!this.drainedToolIds.has(id)) return true;
    }
    return false;
  }

  /** Idle dispatch: retain unjournaled user until receipt proof (`turn_start`/`turn_end`). */
  notePendingUser(text: string): void {
    this.pendingUserText = text;
    this.userJournaledForTurn = false;
    this.sawTurnStart = false;
  }

  /** Definite refusal or idle reconciliation: drop the optimistic user, keep nothing. */
  clearPendingUser(): void {
    this.pendingUserText = null;
    this.userJournaledForTurn = false;
  }

  /**
   * Apply one Pi record through the pure mapper, update translator state,
   * and return the filtered bridge events (dedupe + reconcile, never fabricate).
   *
   * - `tool_start` for an already-announced `toolCallId` is dropped (the final
   *   reconciles: execution args are authoritative, same-id re-announce would
   *   duplicate the card — Orca coalesces by id, so one card per id).
   * - `text_end`/`thinking_end` finals are recorded as authoritative (deltas
   *   stay streaming-only; journaling uses finals, falling back to deltas only
   *   when the final carries no content).
   * - `turn_start` marks receipt proof (caller journals pending user first).
   * - `turn_end`/`settled` are passed through (caller drains journals, then
   *   calls `drainTurnEnd()`/`settle()`).
   * - Unknown/chrome records map to `[]` and change no state (bounded).
   */
  applyPiRecord(record: Record<string, unknown>): BridgeTranslatorEvent[] {
    const events = mapPiRecordToBridgeEvents(record);
    if (events.length === 0) return events;
    const out: BridgeTranslatorEvent[] = [];
    for (const event of events) {
      switch (event.type) {
        case "turn_start": {
          this.turnCount += 1;
          this.sawTurnStart = true;
          out.push(event);
          break;
        }
        case "text_start": {
          out.push(event);
          break;
        }
        case "text_delta": {
          const idx = event.contentIndex ?? 0;
          const prev = this.textDeltas.get(idx) ?? "";
          this.textDeltas.set(idx, prev + event.delta);
          out.push(event);
          break;
        }
        case "text_end": {
          const idx = event.contentIndex ?? 0;
          if (typeof event.text === "string") {
            // Authoritative final reconciles (replaces, never appends to deltas
            // for journaling — deltas stay streaming-only).
            this.textFinals.set(idx, event.text);
          } else if (!this.textFinals.has(idx) && !this.textDeltas.has(idx)) {
            // Empty final with no deltas: nothing to reconcile (no phantom text).
          }
          out.push(event);
          break;
        }
        case "thinking_start": {
          out.push(event);
          break;
        }
        case "thinking_delta": {
          const idx = event.contentIndex ?? 0;
          const prev = this.thinkingDeltas.get(idx) ?? "";
          this.thinkingDeltas.set(idx, prev + event.delta);
          out.push(event);
          break;
        }
        case "thinking_end": {
          const idx = event.contentIndex ?? 0;
          if (typeof event.thinking === "string") {
            this.thinkingFinals.set(idx, event.thinking);
          }
          out.push(event);
          break;
        }
        case "tool_start": {
          const existing = this.tools.get(event.toolCallId);
          if (existing) {
            // Same-id re-announce (toolcall_end then execution_start): reconcile
            // by keeping the first announcement's identity and updating args
            // only when the new event carries them authoritatively. Drop the
            // duplicate card so Orca shows one tool row per id.
            if (event.args !== undefined) {
              this.tools.set(event.toolCallId, { ...existing, args: event.args });
            }
            // Drop: no second card.
          } else {
            this.tools.set(event.toolCallId, {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              ...(event.args !== undefined ? { args: event.args } : {}),
              completed: false,
              isError: false,
            });
            out.push(event);
          }
          break;
        }
        case "tool_progress": {
          const tool = this.tools.get(event.toolCallId);
          if (tool) {
            // Cumulative replace semantics: latest wins (never appends).
            this.tools.set(event.toolCallId, { ...tool, partialResult: event.partialResult });
          } else {
            // Progress for an unannounced tool (e.g. execution without prior
            // start in a replay): track provisionally so the later `tool_end`
            // still journals faithfully, but do not fabricate a `tool_start`.
            this.tools.set(event.toolCallId, {
              toolCallId: event.toolCallId,
              toolName: "tool",
              partialResult: event.partialResult,
              completed: false,
              isError: false,
            });
          }
          out.push(event);
          break;
        }
        case "tool_end": {
          const tool = this.tools.get(event.toolCallId);
          if (tool) {
            this.tools.set(event.toolCallId, {
              ...tool,
              completed: true,
              isError: event.isError,
              result: event.result,
              // Final reconciles: authoritative result replaces partial display.
              partialResult: event.result,
            });
          } else {
            this.tools.set(event.toolCallId, {
              toolCallId: event.toolCallId,
              toolName: "tool",
              completed: true,
              isError: event.isError,
              result: event.result,
              partialResult: event.result,
            });
          }
          out.push(event);
          break;
        }
        case "turn_end":
        case "settled":
        case "prompt_request":
        case "error": {
          out.push(event);
          break;
        }
        default: {
          // Closed-world bridge events: forward (validation already pins shapes).
          out.push(event as never);
          break;
        }
      }
    }
    return out;
  }

  /**
   * Current assistant text for journaling: finals concatenated in index order
   * when any final exists, otherwise deltas concatenated (partial/aborted
   * turns where Pi never sent a final but did stream deltas). Empty string
   * means "tool-only turn — journal no assistant entry" (SNC1.5 owns tool
   * journaling separately so tool stdout never becomes prose).
   */
  currentAssistantText(): string {
    if (this.textFinals.size > 0) {
      const ordered = [...this.textFinals.entries()].sort((a, b) => a[0] - b[0]);
      return ordered.map(([, text]) => text).join("");
    }
    if (this.textDeltas.size > 0) {
      const ordered = [...this.textDeltas.entries()].sort((a, b) => a[0] - b[0]);
      return ordered.map(([, delta]) => delta).join("");
    }
    return "";
  }

  /** Thinking is never journaled as prose — exposed only for diagnostics/tests. */
  currentThinkingText(): string {
    if (this.thinkingFinals.size > 0) {
      return [...this.thinkingFinals.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t).join("");
    }
    if (this.thinkingDeltas.size > 0) {
      return [...this.thinkingDeltas.entries()].sort((a, b) => a[0] - b[0]).map(([, d]) => d).join("");
    }
    return "";
  }

  /** Undrained completed tools (for `turn_end` journaling). */
  undrainedTools(): TranslatorToolState[] {
    const out: TranslatorToolState[] = [];
    for (const tool of this.tools.values()) {
      if (tool.completed && !this.drainedToolIds.has(tool.toolCallId)) out.push(tool);
    }
    // Stable order by first-seen (Map insertion order).
    return out;
  }

  /**
   * Drain one turn's journal entries (called on `turn_end`):
   * pending user first (receipt proof order), then undrained tool completions,
   * then assistant text when non-empty. Marks everything drained and clears
   * per-turn text/thinking accumulators (tools stay until settled so a later
   * `tool_end` arriving after `turn_end` — e.g. abort races — still attributes).
   * Returns entries in journal order (user → tools → assistant).
   */
  drainTurnEnd(): TranslatorJournalEntry[] {
    const entries: TranslatorJournalEntry[] = [];
    if (this.pendingUserText !== null && !this.userJournaledForTurn) {
      entries.push({ role: "user", text: this.pendingUserText });
      this.pendingUserText = null;
      this.userJournaledForTurn = true;
    }
    for (const tool of this.undrainedTools()) {
      entries.push({
        role: "tool",
        text: tool.result ?? tool.partialResult ?? "",
        toolCallId: tool.toolCallId,
        toolName: tool.toolName,
        ...(tool.isError ? { isError: true as const } : {}),
      });
      this.drainedToolIds.add(tool.toolCallId);
    }
    const assistant = this.currentAssistantText();
    if (assistant !== "") {
      entries.push({ role: "assistant", text: assistant });
    }
    // Per-turn text/thinking cleared (finals reconciled, never duplicated on
    // the next turn). Tool states persist until `settle()` so late completions
    // still journal; drained ids prevent double-journal.
    this.textFinals.clear();
    this.textDeltas.clear();
    this.thinkingFinals.clear();
    this.thinkingDeltas.clear();
    this.userJournaledForTurn = false;
    return entries;
  }

  /**
   * Settle the agent (`agent_settled`): drain any remaining turn entries first
   * (a settle without a prior `turn_end` — robustness), then clear ALL
   * transient. After this, `hasTransient()` is false (requirement).
   */
  settle(): TranslatorJournalEntry[] {
    const entries = this.drainTurnEnd();
    this.settledTurns += 1;
    this.sawSettled = true;
    this.resetAll();
    return entries;
  }

  /** Clear per-turn accumulators without journaling (exit/error paths use `settle()` when journaling). */
  resetTurn(): void {
    this.textFinals.clear();
    this.textDeltas.clear();
    this.thinkingFinals.clear();
    this.thinkingDeltas.clear();
    this.userJournaledForTurn = false;
  }

  /** Clear everything (settled/exit/teardown — no retained transient). */
  resetAll(): void {
    this.pendingUserText = null;
    this.userJournaledForTurn = false;
    this.textFinals.clear();
    this.textDeltas.clear();
    this.thinkingFinals.clear();
    this.thinkingDeltas.clear();
    this.tools.clear();
    this.drainedToolIds.clear();
    this.sawTurnStart = false;
    this.sawSettled = false;
  }
}

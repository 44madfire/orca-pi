/**
 * Pi history reconstruction for SNC1.7 (orca-pi owned, pure, fixture-testable).
 *
 * Reconstructs only the active Pi branch (root → current `leafId`) for Orca
 * structured Native Chat resume, excluding abandoned sibling branches (e.g.
 * pre-`fork` chains that `get_entries` still carries but `get_tree` after a
 * fork no longer shows). Uses `get_entries` + `leafId` as the primary source
 * (single RPC, proven in SNC1.1 `state-tree` / `resume-branch` fixtures) with
 * `get_tree` as a fallback when the flat chain is broken. Never touches Orca
 * journal/session types and performs no I/O — the provider (`pi-provider.ts`)
 * owns fetching, journal replacement, and lease updates; this module only
 * shapes opaque entry payloads.
 *
 * Translation converges with the live SNC1.5 path (`pi-mapping.ts` +
 * `pi-translator.ts`):
 * - user text → `user` (text blocks only; image bytes never journaled, same
 *   as live `get_history` which carries text only);
 * - assistant text blocks → `assistant` (thinking blocks never become prose,
 *   same as live; tool-only assistants journal no `assistant` entry);
 * - assistant `toolCall` announcements are not journaled (live journals tool
 *   *results*, not announcements, so stdout never becomes prose);
 * - `toolResult` messages → `tool` (text blocks, same channel separation as
 *   live; `toolCallId`/`toolName`/`isError` are live-event concerns and are
 *   not part of the bridge history shape, which carries `role`/`text` only —
 *   live `journalTranslatorEntries` drops them the same way);
 * - `bashExecution` (direct `bash`, no LLM turn) → `tool` (execution output
 *   as tool-channel text; live streaming ignores out-of-band `bash_*` deltas
 *   but the finalized `bashExecution` message enters LLM context on the next
 *   prompt, so history preserves it as a tool entry rather than dropping
 *   context);
 * - thinking blocks (live `thinking_*` channel) are never journaled.
 *
 * Bounded policy for non-chat records (documented, never terminates):
 * - `model_change`, `thinking_level_change`, `session_info` (rename), and any
 *   `compaction_*` / `summary` / `custom` / unknown future entry types are
 *   skipped for the transcript but retained for chain continuity (the parent
 *   walk passes *through* them so `root → leaf` stays intact; only `message`
 *   entries produce history rows). This matches live, where `compaction_*`,
 *   `session_info_changed`, `queue_update`, etc. map to `[]` with no state
 *   change.
 * - Unknown message roles (future Pi roles) are skipped (bounded ignore,
 *   never fabricated as `user`/`assistant`/`tool`).
 * - Partial/aborted last turns are recovered honestly: a trailing `user`
 *   without a following `assistant` stays a lone `user` (no fabricated
 *   assistant); an `aborted` assistant still journals its text (partial
 *   survival, same as live `drainTurnEnd` which prefers finals but falls back
 *   to deltas for aborts). Nothing is synthesized as complete.
 *
 * Reconciliation (no duplication):
 * - Reconstructed entries use Pi entry `id` verbatim as the bridge history
 *   `id` (stable across restarts, unlike live `eN` ids) and preserve Pi
 *   `parentId` verbatim for exact handoff metadata (even when the parent is a
 *   skipped non-message entry — `parentId` is opaque cursor metadata, not a
 *   paging key; paging uses array order + `cursor`/`leafId`).
 * - The provider replaces session history wholesale on resume when idle (Pi
 *   is the source of truth after `switch_session`; live rows already landed
 *   in Pi converge by identical `(role, text)` order, so replacement never
 *   duplicates — it only re-ids the same transcript with stable Pi ids).
 *   While a turn streams the provider never rebuilds (live owns the turn).
 * - `leafId` always names the Pi session leaf (never the page end), even when
 *   the leaf itself is a skipped non-message entry (e.g. trailing
 *   `session_info` after rename) — the transcript ends at the last message
 *   but the cursor still names the true leaf for `since` resumption.
 *
 * Fail-closed diagnostics (actionable, secret-safe, no prompt text or paths):
 * - missing/empty entries with a leaf, unknown leaf, missing parent link,
 *   or parent cycle → `{ ok:false, code: PI_HISTORY_* }` (caller fails the
 *   `acquire`, never silently returns a truncated transcript).
 */

import type { BridgeHistoryEntry } from "./protocol.js";

export interface PiHistoryEntryLike {
  readonly type: string;
  readonly id: string;
  readonly parentId: string | null;
  readonly timestamp?: string;
  readonly [key: string]: unknown;
}

export interface PiHistoryTreeNodeLike {
  readonly entry: PiHistoryEntryLike;
  readonly children: readonly PiHistoryTreeNodeLike[];
}

export type HistoryReconstructionError =
  | { ok: false; code: "PI_HISTORY_EMPTY"; message: string }
  | { ok: false; code: "PI_HISTORY_LEAF_MISSING"; message: string }
  | { ok: false; code: "PI_HISTORY_CHAIN_BROKEN"; message: string }
  | { ok: false; code: "PI_HISTORY_CYCLE"; message: string };

export type ActiveBranchResult =
  | { ok: true; branch: PiHistoryEntryLike[] }
  | HistoryReconstructionError;

/**
 * Extract the active branch (root → leaf, inclusive) from a flat
 * `get_entries` list by walking `parentId` from `leafId` to the root.
 * Excludes abandoned sibling branches (entries not on the leaf chain).
 * Skipped non-message entries stay in the returned branch (chain continuity);
 * translation filters them later.
 */
export function extractActiveBranch(
  entries: readonly PiHistoryEntryLike[],
  leafId: string,
): ActiveBranchResult {
  if (!leafId || typeof leafId !== "string") {
    return { ok: false, code: "PI_HISTORY_LEAF_MISSING", message: "Pi history has no current leaf (reacquire the session)" };
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    return { ok: false, code: "PI_HISTORY_EMPTY", message: "Pi history is empty or unavailable (reacquire the session)" };
  }
  const byId = new Map<string, PiHistoryEntryLike>();
  for (const entry of entries) {
    if (entry && typeof entry.id === "string" && !byId.has(entry.id)) {
      byId.set(entry.id, entry);
    }
  }
  const leaf = byId.get(leafId);
  if (!leaf) {
    return { ok: false, code: "PI_HISTORY_LEAF_MISSING", message: "Pi current leaf is not in history (session moved or forked; reacquire)" };
  }
  const reversed: PiHistoryEntryLike[] = [];
  const seen = new Set<string>();
  let current: PiHistoryEntryLike | undefined = leaf;
  while (current) {
    if (seen.has(current.id)) {
      return { ok: false, code: "PI_HISTORY_CYCLE", message: "Pi history parent chain loops (incompatible history; reacquire)" };
    }
    seen.add(current.id);
    reversed.push(current);
    if (current.parentId === null || current.parentId === undefined) break;
    const parent = byId.get(current.parentId);
    if (!parent) {
      return {
        ok: false,
        code: "PI_HISTORY_CHAIN_BROKEN",
        message: "Pi history parent chain is broken (incompatible history; reacquire the session)",
      };
    }
    current = parent;
    if (reversed.length > entries.length + 1) {
      return { ok: false, code: "PI_HISTORY_CYCLE", message: "Pi history parent chain loops (incompatible history; reacquire)" };
    }
  }
  reversed.reverse();
  return { ok: true, branch: reversed };
}

/**
 * Extract the active branch from a `get_tree` response by flattening all
 * nodes and delegating to the flat-chain walk (single code path, so tree and
 * entries converge on the same branch). Orphan roots (extra tree roots from
 * well-formedness gaps) are tolerated: only the leaf chain survives.
 */
export function extractActiveBranchFromTree(
  tree: readonly PiHistoryTreeNodeLike[],
  leafId: string,
): ActiveBranchResult {
  if (!leafId || typeof leafId !== "string") {
    return { ok: false, code: "PI_HISTORY_LEAF_MISSING", message: "Pi history has no current leaf (reacquire the session)" };
  }
  if (!Array.isArray(tree) || tree.length === 0) {
    return { ok: false, code: "PI_HISTORY_EMPTY", message: "Pi history tree is empty or unavailable (reacquire the session)" };
  }
  const flat: PiHistoryEntryLike[] = [];
  const visit = (nodes: readonly PiHistoryTreeNodeLike[]): void => {
    for (const node of nodes) {
      if (!node || !node.entry) continue;
      flat.push(node.entry);
      if (Array.isArray(node.children) && node.children.length > 0) visit(node.children);
    }
  };
  visit(tree);
  return extractActiveBranch(flat, leafId);
}

function nowIso(): string {
  return new Date().toISOString();
}

function timestampOf(entry: PiHistoryEntryLike): string {
  const raw = entry.timestamp;
  if (typeof raw === "string" && raw !== "") return raw;
  return nowIso();
}

/**
 * Concatenate `text` blocks from a Pi message `content` array (opaque
 * payloads, text only). Thinking / image / toolCall blocks never contribute
 * (same separation as live: thinking streams separately and never journals as
 * prose; image bytes never journaled; tool announcements are not results).
 * Non-array `content` (string) passes through; anything else yields "".
 */
export function extractPiTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const rec = block as Record<string, unknown>;
    if (rec["type"] === "text" && typeof rec["text"] === "string") {
      out += rec["text"] as string;
    }
  }
  return out;
}

/**
 * Translate one Pi journal entry to zero or more bridge history entries
 * (same semantic mapping as live events; see module header for the bounded
 * policy). Never throws for unknown shapes (bounded ignore → `[]`).
 */
export function translatePiEntryToBridgeEntries(entry: PiHistoryEntryLike): BridgeHistoryEntry[] {
  try {
    if (!entry || entry.type !== "message") return [];
    const message = entry.message as Record<string, unknown> | undefined;
    if (!message || typeof message !== "object") return [];
    const role = message["role"];
    const timestamp = timestampOf(entry);
    const parentId = typeof entry.parentId === "string" && entry.parentId !== "" ? entry.parentId : undefined;
    const base = { id: entry.id, ...(parentId ? { parentId } : {}), timestamp };

    if (role === "user") {
      const text = extractPiTextContent(message["content"]);
      // Image-only turns still journal a (possibly empty) user row so the
      // turn survives for unknown-reconciliation without leaking bytes.
      return [{ ...base, role: "user" as const, ...(text !== "" ? { text } : { text: "" }) }];
    }
    if (role === "assistant") {
      const text = extractPiTextContent(message["content"]);
      // Tool-only assistants (content holds only toolCall/thinking blocks)
      // journal nothing — live `drainTurnEnd` journals no assistant entry for
      // tool-only turns either, so tool stdout never becomes prose.
      if (text === "") return [];
      return [{ ...base, role: "assistant" as const, text }];
    }
    if (role === "toolResult" || role === "tool_result" || role === "toolresult") {
      const text = extractPiTextContent(message["content"]);
      // Preserve the turn even when the result carries no text blocks (empty
      // tool output still proves the tool ran; live journals "" the same way
      // when result/partial are both absent).
      return [{ ...base, role: "tool" as const, text }];
    }
    if (role === "bashExecution" || role === "bash_execution" || role === "bashexecution") {
      const output = message["output"];
      const text = typeof output === "string" ? output : extractPiTextContent(message["content"]);
      return [{ ...base, role: "tool" as const, text }];
    }
    if (role === "system") {
      const text = extractPiTextContent(message["content"]);
      if (text === "" && typeof message["text"] === "string") {
        return [{ ...base, role: "system" as const, text: message["text"] as string }];
      }
      if (text === "") return [];
      return [{ ...base, role: "system" as const, text }];
    }
    // Unknown future roles: bounded ignore (never fabricated as chat).
    return [];
  } catch {
    return [];
  }
}

/**
 * Translate an active-branch entry list (root → leaf, including skipped
 * non-message entries) to bridge history in transcript order. Non-message
 * entries (`model_change`, `thinking_level_change`, `session_info`,
 * `compaction_*`, `summary`, `custom`, unknown) contribute no rows but keep
 * chain positions (their ids remain addressable as cursors via the provider's
 * chain index; see `pi-provider.ts`).
 */
export function translatePiBranchToBridgeHistory(branch: readonly PiHistoryEntryLike[]): BridgeHistoryEntry[] {
  const out: BridgeHistoryEntry[] = [];
  for (const entry of branch) {
    const rows = translatePiEntryToBridgeEntries(entry);
    for (const row of rows) out.push(row);
  }
  return out;
}

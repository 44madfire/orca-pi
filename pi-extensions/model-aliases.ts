/**
 * Model-aliases Pi extension.
 *
 * Rewrites the `subagent` tool's `model`/`thinking` params from a JSON alias
 * map, so orchestrators name tiers (`fast`, `balanced`, `review`, `max`)
 * instead of hardcoding provider models in prompts, skills, or agent files:
 *
 * ```jsonc
 * // ~/.pi/agent/model-aliases.json (global) — <cwd>/.pi/model-aliases.json
 * // (project) replaces the whole map
 * { "aliases": {
 *   "fast": { "model": "anthropic/claude-haiku-4-5", "thinking": "low" },
 *   "max":  { "model": "anthropic/claude-opus-4-6", "thinking": "max",
 *             "fallbacks": ["anthropic/claude-sonnet-4-6"] }
 * } }
 * ```
 *
 * Mechanism: a `tool_call` handler mutates `subagent` input in place before
 * execution (supported contract on Pi 0.84.4 and 1.x — no re-validation
 * happens after mutation, so values must already be tool-valid). No fork of
 * pi-subagents is required.
 *
 * Semantics:
 * - Only `input.model` naming a configured alias (case-insensitive) is
 *   touched. Absent model (inherit path) and literal/fuzzy strings pass
 *   through untouched.
 * - `thinking` is filled from the alias only when the caller omitted it;
 *   caller-explicit thinking always wins. Agent-file `locked` fields still
 *   apply downstream (a file pin overrules this rewrite).
 * - Fallbacks are availability-selected at rewrite time via the session
 *   model registry: first of `[primary, ...fallbacks]` with auth configured
 *   wins. If none is available, the alias is left in place so stock
 *   resolution fails loudly naming it (fail closed — surfaces auth gaps).
 * - No alias chaining: an alias value is used as-is (a model string).
 * - The map is re-read from disk on every intercepted call, so hand-edits
 *   apply without restart. `PI_MODEL_ALIASES_DEBUG=1` logs substitutions.
 */

import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  CustomToolCallEvent,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/** Alias-map filename in the agent dir (global) and `<cwd>/.pi/` (project). */
export const MODEL_ALIASES_FILE = "model-aliases.json" as const;

/** Tool this wrapper rewrites (registered by pi-subagents). */
export const SUBAGENT_TOOL_NAME = "subagent" as const;

/** Thinking levels accepted in alias entries (Pi 0.84.4–1.x vocabulary). */
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

/** One alias entry: primary model, optional tier thinking, optional fallbacks. */
export interface AliasTarget {
  model: string;
  thinking?: ThinkingLevelName;
  fallbacks?: string[];
}

/** Resolved substitution applied to a tool call. */
export interface AliasResolution {
  model: string;
  thinking?: ThinkingLevelName;
  /** Which candidate won (primary or a fallback); for debug logging. */
  via: string;
}

/**
 * Normalize a parsed alias map: lowercase keys, validate shapes, drop
 * garbage. Thinking outside the known vocabulary is dropped (entry kept);
 * entries without a usable primary model are dropped entirely.
 */
export function normalizeAliases(raw: unknown): Record<string, AliasTarget> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const container =
    "aliases" in (raw as Record<string, unknown>)
      ? (raw as Record<string, unknown>)["aliases"]
      : raw;
  if (!container || typeof container !== "object" || Array.isArray(container)) return {};
  const out: Record<string, AliasTarget> = {};
  for (const [key, value] of Object.entries(container as Record<string, unknown>)) {
    if (Object.keys(out).length >= 64) break;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const v = value as Record<string, unknown>;
    const name = key.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-_]*$/.test(name) || name.length > 64) continue;
    const model = typeof v["model"] === "string" ? (v["model"] as string).trim() : "";
    if (model.length === 0 || model.length > 256) continue;
    const entry: AliasTarget = { model };
    if (
      typeof v["thinking"] === "string" &&
      (THINKING_LEVELS as readonly string[]).includes((v["thinking"] as string).trim())
    ) {
      entry.thinking = (v["thinking"] as string).trim() as ThinkingLevelName;
    }
    if (Array.isArray(v["fallbacks"])) {
      const fallbacks = (v["fallbacks"] as unknown[])
        .filter((f): f is string => typeof f === "string")
        .map((f) => f.trim())
        .filter((f) => f.length > 0 && f.length <= 256)
        .slice(0, 8);
      if (fallbacks.length > 0) entry.fallbacks = fallbacks;
    }
    out[name] = entry;
  }
  return out;
}

/** Global agent dir: `PI_CODING_AGENT_DIR` or `~/.pi/agent`. No Pi imports needed. */
export function agentDirFromEnv(env: Record<string, string | undefined> = process.env): string {
  const dir = env["PI_CODING_AGENT_DIR"]?.trim();
  if (dir) return dir;
  return join(homedir(), ".pi", "agent");
}

function readMapFile(path: string): Record<string, AliasTarget> {
  try {
    if (!existsSync(path)) return {};
    return normalizeAliases(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return {};
  }
}

/**
 * Load the alias map: global file provides defaults, project file replaces
 * the whole map when present (even when empty — explicit clear).
 */
export function loadModelAliases(agentDir: string, projectRoot: string): Record<string, AliasTarget> {
  const global = readMapFile(join(agentDir, MODEL_ALIASES_FILE));
  const projectPath = join(projectRoot, ".pi", MODEL_ALIASES_FILE);
  if (!existsSync(projectPath)) return global;
  return readMapFile(projectPath);
}

/** Minimal availability surface (real registries carry more fields). */
export interface ModelAvailability {
  getAvailable(): Array<{ provider: string; id: string }>;
}

/**
 * Pick the first available candidate (`primary`, then `fallbacks`).
 * Returns undefined when none has auth configured — the caller then leaves
 * the alias in place so stock resolution fails loudly naming it.
 */
export function resolveAliasTarget(
  alias: AliasTarget,
  registry: ModelAvailability,
): AliasResolution | undefined {
  let available: Set<string>;
  try {
    available = new Set(
      registry.getAvailable().map((m) => `${m.provider}/${m.id}`.toLowerCase()),
    );
  } catch {
    return { model: alias.model, thinking: alias.thinking, via: alias.model };
  }
  const candidates = [alias.model, ...(alias.fallbacks ?? [])];
  for (const candidate of candidates) {
    if (available.has(candidate.toLowerCase())) {
      return { model: candidate, thinking: alias.thinking, via: candidate };
    }
  }
  return undefined;
}

/** Debug logging, opt-in only. */
function debug(message: string): void {
  if (process.env["PI_MODEL_ALIASES_DEBUG"] === "1") {
    console.error(`[model-aliases] ${message}`);
  }
}

export default function (pi: ExtensionAPI): void {
  pi.on("tool_call", (event, ctx: ExtensionContext) => {
    const toolEvent = event as CustomToolCallEvent;
    if (toolEvent.toolName !== SUBAGENT_TOOL_NAME) return;
    const input = toolEvent.input;
    if (!input || typeof input["model"] !== "string" || (input["model"] as string).trim() === "") {
      return;
    }
    const name = (input["model"] as string).trim().toLowerCase();
    const aliases = loadModelAliases(agentDirFromEnv(), ctx.cwd);
    const alias = aliases[name];
    if (!alias) return;
    const resolved = resolveAliasTarget(alias, ctx.modelRegistry);
    if (!resolved) {
      debug(`alias "${name}" has no available model; leaving for stock resolution to report`);
      return;
    }
    input["model"] = resolved.model;
    if (input["thinking"] === undefined && resolved.thinking !== undefined) {
      input["thinking"] = resolved.thinking;
    }
    debug(`alias "${name}" → ${resolved.model}${resolved.thinking ? `:${resolved.thinking}` : ""} (via ${resolved.via})`);
  });
}

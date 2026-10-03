/**
 * Model resolution: exact match ("provider/modelId") with fuzzy fallback.
 */
import type { Model } from "@earendil-works/pi-ai";

export interface ModelRegistry {
  find(provider: string, modelId: string): Model<any> | undefined;
  getAll(): Model<any>[];
  getAvailable?(): Model<any>[];
}

/** Successful model resolution — `model` is the resolved or inherited model instance. */
export interface ModelResolutionResult {
  model: Model<any> | undefined;
  error?: undefined;
}

/** Failed model resolution when the model was user-specified (params) — surface the error. */
export interface ModelResolutionError {
  model?: undefined;
  error: string;
}

/** Discriminated union returned by `resolveInvocationModel`. */
export type ModelResolution = ModelResolutionResult | ModelResolutionError;

/** True when `input` names a configured alias (case-insensitive, pre-expansion). */
export function isModelAlias(
  input: string,
  aliases?: Readonly<Record<string, string>>,
): boolean {
  if (!aliases) return false;
  const needle = input.trim().toLowerCase();
  return Object.keys(aliases).some((k) => k.toLowerCase() === needle);
}

/**
 * Resolve the effective model for an agent invocation.
 *
 * Encapsulates the fallback policy used in `Agent.execute`:
 * 1. No `modelInput` → inherit `parentModel`.
 * 2. `modelInput` resolves → return the resolved model.
 * 3. `modelInput` fails:
 *    - names an alias → return `{ error }` always: an alias is an explicit
 *      operator choice, so a broken alias must fail before spawn rather than
 *      inherit silently, whichever side supplied the string.
 *    - `modelFromParams` true  → return `{ error }` so the caller can surface it.
 *    - otherwise → silent fallback to `parentModel` (legacy agent-file typo
 *      behavior for non-alias strings).
 *
 * `modelFromParams` reports which side supplied the winning string, not merely whether
 * the caller passed one — a caller whose value an agent's `locked:` frontmatter discarded
 * did not win, so its typo is not the string being resolved here.
 */
export function resolveInvocationModel(
  parentModel: Model<any> | undefined,
  modelInput: string | undefined,
  modelFromParams: boolean,
  registry: ModelRegistry | undefined,
  aliases?: Readonly<Record<string, string>>,
): ModelResolution {
  if (!modelInput) return { model: parentModel };
  if (!registry) return { error: "No model registry available." };
  const resolved = resolveModel(modelInput, registry, aliases);
  if (typeof resolved !== "string") return { model: resolved };
  if (isModelAlias(modelInput, aliases)) return { error: resolved };
  if (modelFromParams) return { error: resolved };
  return { model: parentModel };
}

/** Outcome of alias expansion: a terminal string, a detected cycle, or a
 * chain longer than the hop budget. Cycle and depth are distinct failures —
 * a valid exactly-5-hop chain resolves normally. */
export type AliasExpansion =
  | { kind: "resolved"; value: string }
  | { kind: "cycle"; trail: string[] }
  | { kind: "depth"; trail: string[] };

/** Maximum alias-chain hops before depth exhaustion. */
export const MAX_ALIAS_HOPS = 5;

/**
 * Expand a named alias (case-insensitive) to its terminal string.
 * Returns the original input when it names no alias.
 */
export function expandModelAlias(
  input: string,
  aliases?: Readonly<Record<string, string>>,
): AliasExpansion {
  if (!aliases) return { kind: "resolved", value: input };
  let current = input.trim();
  const seen = new Set<string>([current.toLowerCase()]);
  const trail = [current];
  for (let i = 0; i < MAX_ALIAS_HOPS; i++) {
    const target = aliases[current.toLowerCase()];
    if (target === undefined) return { kind: "resolved", value: current };
    current = target.trim();
    trail.push(current);
    if (current.length === 0 || seen.has(current.toLowerCase())) {
      return { kind: "cycle", trail };
    }
    seen.add(current.toLowerCase());
  }
  // Budget consumed: a terminal value here is a valid exactly-at-budget chain.
  if (aliases[current.toLowerCase()] === undefined) {
    return { kind: "resolved", value: current };
  }
  return { kind: "depth", trail };
}

/**
 * Resolve a model string to a Model instance.
 * Tries alias expansion first, then exact match ("provider/modelId"),
 * then fuzzy match against all available models.
 * Returns the Model on success, or an error message string on failure.
 */
export function resolveModel(
  input: string,
  registry: ModelRegistry,
  aliases?: Readonly<Record<string, string>>,
): Model<any> | string {
  const expanded = expandModelAlias(input, aliases);
  if (expanded.kind === "cycle") {
    return `Model alias cycle detected for "${input}" (${expanded.trail.join(" → ")}). Check modelAliases in subagents.json.`;
  }
  if (expanded.kind === "depth") {
    return `Model alias chain for "${input}" exceeds ${MAX_ALIAS_HOPS} hops (${expanded.trail.join(" → ")}). Flatten modelAliases in subagents.json.`;
  }
  const effective = expanded.value;
  const aliasNote = effective.toLowerCase() !== input.trim().toLowerCase()
    ? ` (alias "${input.trim()}" → "${effective}")`
    : "";
  // Available models (those with auth configured)
  const all = registry.getAvailable?.() ?? registry.getAll();
  const availableSet = new Set(all.map(m => `${m.provider}/${m.id}`.toLowerCase()));

  // 1. Exact match: "provider/modelId" — only if available (has auth)
  const slashIdx = effective.indexOf("/");
  if (slashIdx !== -1) {
    const provider = effective.slice(0, slashIdx);
    const modelId = effective.slice(slashIdx + 1);
    if (availableSet.has(effective.toLowerCase())) {
      const found = registry.find(provider, modelId);
      if (found) return found;
    }
  }

  // 2. Fuzzy match against available models
  const bestMatch = findBestFuzzyMatch(all, effective.toLowerCase());
  if (bestMatch) {
    const found = registry.find(bestMatch.provider, bestMatch.id);
    if (found) return found;
  }

  // 3. No match — list available models
  const modelList = all
    .map(m => `  ${m.provider}/${m.id}`)
    .sort()
    .join("\n");
  return `Model not found: "${input}"${aliasNote}.\n\nAvailable models:\n${modelList}`;
}

/**
 * Score each candidate model — prefer exact id match > id contains > name
 * contains > provider+id contains — and return the best match at or above
 * the acceptance threshold (20), or undefined if nothing scores high enough.
 */
function findBestFuzzyMatch(all: Model<any>[], query: string): Model<any> | undefined {
  let bestMatch: Model<any> | undefined;
  let bestScore = 0;

  for (const m of all) {
    const id = m.id.toLowerCase();
    const name = m.name.toLowerCase();
    const full = `${m.provider}/${m.id}`.toLowerCase();

    let score = 0;
    if (id === query || full === query) {
      score = 100; // exact
    } else if (id.includes(query) || full.includes(query)) {
      score = 60 + (query.length / id.length) * 30; // substring, prefer tighter matches
    } else if (name.includes(query)) {
      score = 40 + (query.length / name.length) * 20;
    } else if (query.split(/[\s\-/]+/).every(part => id.includes(part) || name.includes(part) || m.provider.toLowerCase().includes(part))) {
      score = 20; // all parts present somewhere
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = m;
    }
  }

  return bestScore >= 20 ? bestMatch : undefined;
}

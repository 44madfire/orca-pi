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

/**
 * Resolve the effective model for an agent invocation.
 *
 * Encapsulates the three-branch fallback policy used in `Agent.execute`:
 * 1. No `modelInput` → inherit `parentModel`.
 * 2. `modelInput` resolves → return the resolved model.
 * 3. `modelInput` fails:
 *    - `modelFromParams` true  → return `{ error }` so the caller can surface it.
 *    - `modelFromParams` false → silent fallback to `parentModel`.
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
  if (modelFromParams) return { error: resolved };
  return { model: parentModel };
}

/**
 * Expand a named alias (case-insensitive) to its target string.
 * Follows chains up to 5 hops with cycle detection; returns the original
 * input when it names no alias, and null on a detected alias cycle.
 */
export function expandModelAlias(
  input: string,
  aliases?: Readonly<Record<string, string>>,
): string | null {
  if (!aliases) return input;
  let current = input.trim();
  const seen = new Set<string>();
  for (let i = 0; i < 5; i++) {
    const target = aliases[current.toLowerCase()];
    if (target === undefined) return current;
    if (seen.has(current.toLowerCase())) return null;
    seen.add(current.toLowerCase());
    current = target.trim();
    if (current.length === 0) return null;
  }
  return null;
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
  if (expanded === null) {
    return `Model alias cycle detected for "${input}". Check modelAliases in subagents.json.`;
  }
  const effective = expanded;
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

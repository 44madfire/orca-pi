/**
 * Inheritance resolution for Pi agent profiles (OP1.2 / JEF-6).
 *
 * Turns a merged `{ profiles }` map plus optional CLI overrides into one
 * normalized, immutable {@link ResolvedPiProfile}. Invalid references fail
 * before any Pi/Orca process starts:
 *
 * - unknown profile names (with "did you mean …" hints),
 * - unknown `extends` parents,
 * - `extends` cycles (with the full chain in the message).
 *
 * Merge semantics (v1):
 * - Scalars/booleans: child (or override) wins when defined, else parent.
 * - Arrays (`tools`, `excludeTools`, `skills`, `extensions`): child
 *   replaces the parent wholesale — no concat, no append syntax in v1.
 * - Prompt pair: defining `systemPrompt` clears an inherited
 *   `systemPromptFile` and vice versa, preserving mutual exclusivity.
 * - Built-in defaults fill whatever remains; CLI overrides apply last with
 *   the same replace/clear rules.
 *
 * Never reads prompt/skill file contents; never mutates inputs; results are
 * deeply frozen (`Object.freeze` on the profile and each array).
 */

import {
  BUILTIN_PROFILE_DEFAULTS,
  ProfileValidationError,
  validateProfileOverrides,
} from "./schema.js";
import type {
  ResolvedPiProfile,
  ValidatedPiProfile,
  ValidatedProfilesDocument,
} from "./types.js";

export type ProfileResolveErrorCode =
  | "unknown-profile"
  | "unknown-parent"
  | "extends-cycle"
  | "invalid-override";

/** Pre-launch resolution failure — actionable, with profile/chain context. */
export class ProfileResolveError extends Error {
  readonly code: ProfileResolveErrorCode;
  readonly profileName: string;
  readonly chain: readonly string[];
  readonly available: readonly string[];

  constructor(options: {
    code: ProfileResolveErrorCode;
    profileName: string;
    message: string;
    chain?: readonly string[];
    available?: readonly string[];
  }) {
    super(options.message);
    this.name = "ProfileResolveError";
    this.code = options.code;
    this.profileName = options.profileName;
    this.chain = options.chain ?? [];
    this.available = options.available ?? [];
  }
}

export interface ResolveProfileOptions {
  /** Explicit CLI overrides (precedence level 6). Validated; `extends` forbidden. */
  overrides?: unknown;
  /** Label used in override validation errors (e.g. `--model` source). */
  overridesLabel?: string;
}

function availableNames(
  document: ValidatedProfilesDocument | { profiles: Record<string, unknown> },
): string[] {
  return Object.keys(document.profiles).sort();
}

function suggest(name: string, available: readonly string[]): string {
  if (available.length === 0) return "";
  const lower = name.toLowerCase();
  const close = available.filter(
    (candidate) =>
      candidate.toLowerCase().includes(lower) || lower.includes(candidate.toLowerCase()),
  );
  const picks = (close.length > 0 ? close : available).slice(0, 3);
  return ` Available: ${picks.map((pick) => `"${pick}"`).join(", ")}${available.length > picks.length ? ` (and ${available.length - picks.length} more)` : ""}.`;
}

/**
 * Build the inheritance chain for `name`, root parent first.
 * Throws on unknown profiles/parents and on cycles.
 */
function buildExtendsChain(
  name: string,
  profiles: Record<string, ValidatedPiProfile>,
  available: readonly string[],
): string[] {
  if (!Object.hasOwn(profiles, name)) {
    throw new ProfileResolveError({
      code: "unknown-profile",
      profileName: name,
      available,
      message: `Unknown Pi profile "${name}".${suggest(name, available)} Check the "profiles" keys in user/global and project configs.`,
    });
  }
  const chain: string[] = [];
  const visiting: string[] = [];
  const visited = new Set<string>();
  let current: string | undefined = name;
  // Walk parent links from the leaf up, then reverse to root-first order.
  const leafToRoot: string[] = [];
  while (current !== undefined) {
    if (visiting.includes(current)) {
      const cycleStart = visiting.indexOf(current);
      const cycle = [...visiting.slice(cycleStart), current];
      throw new ProfileResolveError({
        code: "extends-cycle",
        profileName: name,
        chain: cycle,
        available,
        message: `Pi profile "extends" cycle detected: ${cycle.map((entry) => `"${entry}"`).join(" → ")}. v1 supports single-parent inheritance only; break the cycle so the chain terminates.`,
      });
    }
    // Own-property lookup only: inherited keys such as `toString` must not
    // resolve as phantom parents. Reserved names (`__proto__`, `constructor`,
    // `prototype`) are rejected at validation, and this guard keeps manually
    // constructed maps safe as well.
    const currentName = current as string;
    if (!Object.hasOwn(profiles, currentName)) {
      // `current` is a parent named via `extends` that does not exist.
      const child = leafToRoot.length > 0 ? leafToRoot[leafToRoot.length - 1] : name;
      throw new ProfileResolveError({
        code: "unknown-parent",
        profileName: child as string,
        chain: [...visiting],
        available,
        message: `Pi profile "${child}" extends unknown parent "${current}".${suggest(current as string, available)} Fix "extends" to name an existing profile or remove it.`,
      });
    }
    const profile: ValidatedPiProfile = profiles[currentName] as ValidatedPiProfile;
    visiting.push(current as string);
    leafToRoot.push(current as string);
    const parent: string | undefined = profile.extends;
    if (parent !== undefined && visited.has(`${current}→${parent}`)) {
      // Defensive: `visiting` already catches true cycles; this guards
      // against pathological re-walks.
      throw new ProfileResolveError({
        code: "extends-cycle",
        profileName: name,
        chain: [...visiting, parent],
        available,
        message: `Pi profile "extends" cycle detected involving "${parent}". Break the cycle so the chain terminates.`,
      });
    }
    current = parent;
  }
  // leafToRoot is [leaf, ..., root]; reverse for root-first merge order.
  chain.push(...leafToRoot.reverse());
  return chain;
}

interface MutableAccumulator {
  provider?: string;
  model?: string;
  thinking?: ResolvedPiProfile["thinking"];
  systemPrompt?: string;
  systemPromptFile?: string;
  tools?: string[];
  excludeTools?: string[];
  skills?: string[];
  extensions?: string[];
  contextFiles?: boolean;
  discoverSkills?: boolean;
  discoverExtensions?: boolean;
  session?: ResolvedPiProfile["session"];
  githubIdentity?: string;
  displayName?: string;
  description?: string;
}

function applyLayer(acc: MutableAccumulator, layer: ValidatedPiProfile): void {
  if (layer.provider !== undefined) acc.provider = layer.provider;
  if (layer.model !== undefined) acc.model = layer.model;
  if (layer.thinking !== undefined) acc.thinking = layer.thinking;
  // Prompt pair: setting one clears the other (mutual exclusivity across layers).
  if (layer.systemPrompt !== undefined) {
    acc.systemPrompt = layer.systemPrompt;
    acc.systemPromptFile = undefined;
  } else if (layer.systemPromptFile !== undefined) {
    acc.systemPromptFile = layer.systemPromptFile;
    acc.systemPrompt = undefined;
  }
  // v1 arrays replace wholesale (copies, never shared references).
  if (layer.tools !== undefined) acc.tools = [...layer.tools];
  if (layer.excludeTools !== undefined) acc.excludeTools = [...layer.excludeTools];
  if (layer.skills !== undefined) acc.skills = [...layer.skills];
  if (layer.extensions !== undefined) acc.extensions = [...layer.extensions];
  if (layer.contextFiles !== undefined) acc.contextFiles = layer.contextFiles;
  if (layer.discoverSkills !== undefined) acc.discoverSkills = layer.discoverSkills;
  if (layer.discoverExtensions !== undefined) acc.discoverExtensions = layer.discoverExtensions;
  if (layer.session !== undefined) acc.session = layer.session;
  if (layer.githubIdentity !== undefined) acc.githubIdentity = layer.githubIdentity;
  if (layer.displayName !== undefined) acc.displayName = layer.displayName;
  if (layer.description !== undefined) acc.description = layer.description;
}

/**
 * Resolve one profile into a normalized, frozen {@link ResolvedPiProfile}.
 * Never mutates `document` or `options.overrides`; never reads prompt/skill
 * file contents. Throws {@link ProfileResolveError} (unknown/cycle) or
 * {@link ProfileValidationError} (invalid overrides).
 */
export function resolveProfile(
  name: string,
  document: ValidatedProfilesDocument | { profiles: Record<string, ValidatedPiProfile>; sourceLabel?: string },
  options?: ResolveProfileOptions,
): ResolvedPiProfile {
  const profiles = document.profiles as Record<string, ValidatedPiProfile>;
  const available = availableNames(document);
  const chain = buildExtendsChain(name, profiles, available);

  const acc: MutableAccumulator = {};
  for (const entry of chain) {
    applyLayer(acc, profiles[entry]!);
  }

  // Explicit CLI overrides (level 6) apply last with identical semantics.
  if (options?.overrides !== undefined) {
    let validated: ValidatedPiProfile;
    try {
      validated = validateProfileOverrides(
        options.overrides,
        options.overridesLabel ?? "<cli-overrides>",
      );
    } catch (error) {
      if (error instanceof ProfileValidationError) {
        throw new ProfileResolveError({
          code: "invalid-override",
          profileName: name,
          chain,
          available,
          message: `Invalid CLI overrides for Pi profile "${name}":\n${error.issues.map((issue) => `  - ${issue.path}: ${issue.message}`).join("\n")}`,
        });
      }
      throw error;
    }
    applyLayer(acc, validated);
  }

  const resolved: ResolvedPiProfile = Object.freeze({
    name,
    extendsChain: Object.freeze([...chain]) as readonly string[],
    ...(acc.provider !== undefined ? { provider: acc.provider } : {}),
    ...(acc.model !== undefined ? { model: acc.model } : {}),
    thinking: acc.thinking ?? BUILTIN_PROFILE_DEFAULTS.thinking,
    ...(acc.systemPrompt !== undefined ? { systemPrompt: acc.systemPrompt } : {}),
    ...(acc.systemPromptFile !== undefined ? { systemPromptFile: acc.systemPromptFile } : {}),
    ...(acc.tools !== undefined ? { tools: Object.freeze([...acc.tools]) } : {}),
    ...(acc.excludeTools !== undefined
      ? { excludeTools: Object.freeze([...acc.excludeTools]) }
      : {}),
    ...(acc.skills !== undefined ? { skills: Object.freeze([...acc.skills]) } : {}),
    ...(acc.extensions !== undefined
      ? { extensions: Object.freeze([...acc.extensions]) }
      : {}),
    contextFiles: acc.contextFiles ?? BUILTIN_PROFILE_DEFAULTS.contextFiles,
    discoverSkills: acc.discoverSkills ?? BUILTIN_PROFILE_DEFAULTS.discoverSkills,
    discoverExtensions: acc.discoverExtensions ?? BUILTIN_PROFILE_DEFAULTS.discoverExtensions,
    session: acc.session ?? BUILTIN_PROFILE_DEFAULTS.session,
    ...(acc.githubIdentity !== undefined ? { githubIdentity: acc.githubIdentity } : {}),
    ...(acc.displayName !== undefined ? { displayName: acc.displayName } : {}),
    ...(acc.description !== undefined ? { description: acc.description } : {}),
  });
  return resolved;
}

/**
 * Resolve every profile in the document. Returns a frozen map
 * (`Object.freeze`d outer object of frozen profiles). Throws on the first
 * unresolvable profile (unknown parent/cycle).
 */
export function resolveAllProfiles(
  document: ValidatedProfilesDocument | { profiles: Record<string, ValidatedPiProfile>; sourceLabel?: string },
  options?: Pick<ResolveProfileOptions, "overridesLabel">,
): Readonly<Record<string, ResolvedPiProfile>> {
  const out: Record<string, ResolvedPiProfile> = {};
  for (const name of availableNames(document)) {
    out[name] = resolveProfile(name, document, { overridesLabel: options?.overridesLabel });
  }
  return Object.freeze(out);
}

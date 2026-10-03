// Persistence for pi-subagents operational settings.
// - Global:  ~/.pi/agent/subagents.json (agentDir injected at construction) — manual defaults, never written here
// - Project: <cwd>/.pi/subagents.json — written by /agents → Settings; overrides global on load

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type LayeredSettingsSource, loadLayeredSettings } from "#src/layered-settings";
import type { PromptInheritance } from "#src/types";
export interface SubagentsSettings {
  maxConcurrent?: number;
  /**
   * 0 = unlimited — the extension's single source of truth for that convention:
   * `normalizeMaxTurns()` in turn-limits.ts treats 0 → `undefined`, and the
   * `/agents` → Settings input prompt explicitly says "0 = unlimited".
   */
  defaultMaxTurns?: number;
  graceTurns?: number;
  /** Minutes a consumed agent's session is retained after its last relevance event. */
  consumedSessionRetentionMinutes?: number;
  /** Minutes an unconsumed agent's session is retained (safety cap). */
  unconsumedSessionRetentionMinutes?: number;
  /**
   * When false, a parent interrupt (ESC) leaves background and queued subagents
   * running. Foreground agents hold the parent's run signal directly, so they
   * abort on ESC either way.
   */
  abortAllOnInterrupt?: boolean;
  /**
   * When false, a background child is not given the `notify_parent` tool, so it
   * cannot interrupt the parent with a mid-run finding. Ask-back is unaffected.
   */
  midRunUpdates?: boolean;
  /**
   * Pi package sources whose extensions child sessions must not load, matched
   * against Pi's configured source string exactly (e.g. `npm:@scope/pkg`).
   * The package's skills, prompts, and themes stay available to children.
   */
  excludedExtensionPackages?: string[];
  /**
   * Prompt-inheritance strategy per provider, keyed by the provider id of the
   * child's resolved model. Every provider not listed inherits `"full"`.
   * The key is the provider rather than the agent because re-homing is a
   * property of the transport, and a per-spawn `model` override moves a child
   * between transports (ADR 0009).
   */
  promptInheritance?: Record<string, PromptInheritance>;
  /**
   * Named model aliases, e.g. `{ fast: "provider/model-id" }.
   * An agent's `model:` frontmatter or a `subagent(model=...)` param naming
   * an alias resolves to its target before exact/fuzzy registry lookup.
   * Keys are matched case-insensitively; values are plain model strings
   * (exact `provider/model-id` or fuzzy names — no `:thinking` suffix;
   * thinking stays in the separate `thinking:` field). A broken alias
   * always fails before spawn, never inherits silently. An explicit empty
   * object clears aliases inherited from the global layer; malformed
   * entries are ignored. Hand-edited only; no `/subagents:settings`
   * affordance. Re-read from disk on every spawn door, so hand-edits apply
   * without restart.
   */
  modelAliases?: Record<string, string>;
}

/**
 * The persisted form of the in-memory settings values.
 * `saveSettings` rewrites the whole project file from this shape, so every key
 * that must survive a `/subagents:settings` edit has to appear here.
 */
export interface SettingsSnapshot {
  maxConcurrent: number;
  defaultMaxTurns: number;
  graceTurns: number;
  consumedSessionRetentionMinutes: number;
  unconsumedSessionRetentionMinutes: number;
  abortAllOnInterrupt: boolean;
  midRunUpdates: boolean;
  /**
   * Present only when non-empty, so files that never set it gain no noise.
   * It must round-trip: the key has no `/subagents:settings` affordance, so a
   * hand-edited value would otherwise be erased by any unrelated setting change.
   */
  excludedExtensionPackages?: string[];
  /** Present only when non-empty, and round-tripped for the same reason. */
  promptInheritance?: Record<string, PromptInheritance>;
  /** Present only when non-empty, and round-tripped for the same reason. */
  modelAliases?: Record<string, string>;
}


/** Emit callback — a subset of `pi.events.emit` to keep helpers testable. */
export type SettingsEmit = (event: string, payload: unknown) => void;

const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_GRACE_TURNS = 5;
const DEFAULT_CONSUMED_RETENTION_MINUTES = 10;
const DEFAULT_UNCONSUMED_RETENTION_MINUTES = 720;
const DEFAULT_ABORT_ALL_ON_INTERRUPT = true;
const DEFAULT_MID_RUN_UPDATES = true;

/**
 * Owns all three in-memory settings values and their load/save/persist cycle.
 * Replaces the scattered free-function + SettingsAppliers callback pattern.
 */
export class SettingsManager {
  private _defaultMaxTurns: number | undefined = undefined;
  private _graceTurns: number = DEFAULT_GRACE_TURNS;
  private _maxConcurrent: number = DEFAULT_MAX_CONCURRENT;
  private _consumedSessionRetentionMinutes: number = DEFAULT_CONSUMED_RETENTION_MINUTES;
  private _unconsumedSessionRetentionMinutes: number = DEFAULT_UNCONSUMED_RETENTION_MINUTES;
  private _abortAllOnInterrupt: boolean = DEFAULT_ABORT_ALL_ON_INTERRUPT;
  private _midRunUpdates: boolean = DEFAULT_MID_RUN_UPDATES;
  private _excludedExtensionPackages: string[] = [];
  private _promptInheritance: Record<string, PromptInheritance> = {};
  private _modelAliases: Record<string, string> = {};

  private readonly emit: SettingsEmit;
  private readonly cwd: string;
  private readonly agentDir: string;
  private readonly onMaxConcurrentChanged: (() => void) | undefined;

  constructor(deps: { emit: SettingsEmit; cwd: string; agentDir: string; onMaxConcurrentChanged?: () => void }) {
    this.emit = deps.emit;
    this.cwd = deps.cwd;
    this.agentDir = deps.agentDir;
    this.onMaxConcurrentChanged = deps.onMaxConcurrentChanged;
  }

  // ── defaultMaxTurns: 0 or undefined → unlimited (undefined); else max(1, n) ──

  get defaultMaxTurns(): number | undefined {
    return this._defaultMaxTurns;
  }

  set defaultMaxTurns(n: number | undefined) {
    if (n == null || n === 0) {
      this._defaultMaxTurns = undefined;
    } else {
      this._defaultMaxTurns = Math.max(1, n);
    }
  }

  // ── graceTurns: minimum 1 ──

  get graceTurns(): number {
    return this._graceTurns;
  }

  set graceTurns(n: number) {
    this._graceTurns = Math.max(1, n);
  }

  // ── maxConcurrent: minimum 1 ──

  get maxConcurrent(): number {
    return this._maxConcurrent;
  }

  set maxConcurrent(n: number) {
    this._maxConcurrent = Math.max(1, n);
  }

  // ── retention windows: clamped to [1, RETENTION_MINUTES_CEILING] minutes ──

  get consumedSessionRetentionMinutes(): number {
    return this._consumedSessionRetentionMinutes;
  }

  set consumedSessionRetentionMinutes(n: number) {
    this._consumedSessionRetentionMinutes = clampRetentionMinutes(n);
  }

  get unconsumedSessionRetentionMinutes(): number {
    return this._unconsumedSessionRetentionMinutes;
  }

  set unconsumedSessionRetentionMinutes(n: number) {
    this._unconsumedSessionRetentionMinutes = clampRetentionMinutes(n);
  }

  // ── abortAllOnInterrupt: flipped via toggleAbortAllOnInterrupt(); no normalization ──

  get abortAllOnInterrupt(): boolean {
    return this._abortAllOnInterrupt;
  }

  // ── excludedExtensionPackages: hand-edited only; no /subagents:settings affordance ──

  get excludedExtensionPackages(): readonly string[] {
    return this._excludedExtensionPackages;
  }

  // ── modelAliases: hand-edited only; no /subagents:settings affordance ──

  /** Named model aliases (lowercased keys). Empty when none configured. */
  get modelAliases(): Readonly<Record<string, string>> {
    return this._modelAliases;
  }

  /**
   * Expand one alias level (case-insensitive). Returns the target string,
   * or undefined when `input` names no alias.
   */
  resolveAlias(input: string): string | undefined {
    return this._modelAliases[input.toLowerCase().trim()];
  }

  /**
   * Re-read only the alias map from disk (global + project layers).
   * Spawn doors call this before resolving models so hand-edits to
   * `subagents.json` apply without restart; other in-memory settings are
   * untouched and no lifecycle event fires. Missing/malformed files clear
   * the map, matching `load()` semantics.
   */
  reloadModelAliases(): void {
    const settings = loadSettings(this.agentDir, this.cwd);
    this._modelAliases = { ...(settings.modelAliases ?? {}) };
  }

  // ── promptInheritance: hand-edited only; no /subagents:settings affordance ──

  /**
   * The prompt-inheritance strategy a child on `provider` adopts.
   *
   * Unlisted providers, and a child that resolved no model at all, inherit
   * `"full"` — the default, which changes no existing child's prompt.
   */
  promptInheritanceFor(provider: string | undefined): PromptInheritance {
    if (provider === undefined) return "full";
    return this._promptInheritance[provider] ?? "full";
  }

  // ── Lifecycle methods ──

  /**
   * Load merged settings (global + project), apply to in-memory values,
   * and emit the `subagents:settings_loaded` lifecycle event.
   * Returns the raw loaded settings object.
   */
  load(): SubagentsSettings {
    const settings = loadSettings(this.agentDir, this.cwd);
    if (typeof settings.maxConcurrent === "number") this.maxConcurrent = settings.maxConcurrent;
    if (typeof settings.defaultMaxTurns === "number") this.defaultMaxTurns = settings.defaultMaxTurns;
    if (typeof settings.graceTurns === "number") this.graceTurns = settings.graceTurns;
    if (typeof settings.consumedSessionRetentionMinutes === "number")
      this.consumedSessionRetentionMinutes = settings.consumedSessionRetentionMinutes;
    if (typeof settings.unconsumedSessionRetentionMinutes === "number")
      this.unconsumedSessionRetentionMinutes = settings.unconsumedSessionRetentionMinutes;
    if (typeof settings.abortAllOnInterrupt === "boolean")
      this._abortAllOnInterrupt = settings.abortAllOnInterrupt;
    if (typeof settings.midRunUpdates === "boolean") this._midRunUpdates = settings.midRunUpdates;
    // Assigned unconditionally: removing the key from disk must clear the value.
    this._excludedExtensionPackages = [...(settings.excludedExtensionPackages ?? [])];
    this._promptInheritance = { ...settings.promptInheritance };
    this._modelAliases = { ...(settings.modelAliases ?? {}) };
    this.emit("subagents:settings_loaded", { settings });
    return settings;
  }

  /**
   * Snapshot current in-memory values for persistence.
   * `defaultMaxTurns` uses 0 as the on-disk marker for unlimited (undefined).
   */
  snapshot(): SettingsSnapshot {
    const snapshot: SettingsSnapshot = {
      maxConcurrent: this._maxConcurrent,
      defaultMaxTurns: this._defaultMaxTurns ?? 0,
      graceTurns: this._graceTurns,
      consumedSessionRetentionMinutes: this._consumedSessionRetentionMinutes,
      unconsumedSessionRetentionMinutes: this._unconsumedSessionRetentionMinutes,
      abortAllOnInterrupt: this._abortAllOnInterrupt,
      midRunUpdates: this._midRunUpdates,
    };
    if (this._excludedExtensionPackages.length > 0) {
      snapshot.excludedExtensionPackages = [...this._excludedExtensionPackages];
    }
    if (Object.keys(this._promptInheritance).length > 0) {
      snapshot.promptInheritance = { ...this._promptInheritance };
    }
    if (Object.keys(this._modelAliases).length > 0) {
      snapshot.modelAliases = { ...this._modelAliases };
    }
    return snapshot;
  }

  /**
   * Set maxConcurrent, notify interested parties, persist, and return the toast.
   * Owns the full consequence chain so callers just say what they want.
   */
  applyMaxConcurrent(n: number): { message: string; level: "info" | "warning" } {
    this.maxConcurrent = n; // setter normalizes: max(1, n)
    this.onMaxConcurrentChanged?.();
    return this.saveAndNotify(`Max concurrency set to ${this.maxConcurrent}`);
  }

  /**
   * Set defaultMaxTurns, persist, and return the toast.
   * Pass 0 for unlimited (maps to undefined internally).
   */
  applyDefaultMaxTurns(n: number): { message: string; level: "info" | "warning" } {
    this.defaultMaxTurns = n === 0 ? undefined : n; // setter normalizes further
    const label = this.defaultMaxTurns == null ? "unlimited" : String(this.defaultMaxTurns);
    return this.saveAndNotify(`Default max turns set to ${label}`);
  }

  /**
   * Set graceTurns, persist, and return the toast.
   */
  applyGraceTurns(n: number): { message: string; level: "info" | "warning" } {
    this.graceTurns = n; // setter normalizes: max(1, n)
    return this.saveAndNotify(`Grace turns set to ${this.graceTurns}`);
  }

  /** Set the consumed-session retention window (minutes), persist, and return the toast. */
  applyConsumedSessionRetentionMinutes(n: number): { message: string; level: "info" | "warning" } {
    this.consumedSessionRetentionMinutes = n; // setter normalizes: clamp [1, ceiling]
    return this.saveAndNotify(`Consumed-session retention set to ${this.consumedSessionRetentionMinutes} min`);
  }

  /** Set the unconsumed-session retention window (minutes), persist, and return the toast. */
  applyUnconsumedSessionRetentionMinutes(n: number): { message: string; level: "info" | "warning" } {
    this.unconsumedSessionRetentionMinutes = n; // setter normalizes: clamp [1, ceiling]
    return this.saveAndNotify(`Unconsumed-session retention set to ${this.unconsumedSessionRetentionMinutes} min`);
  }

  /**
   * Flip whether a parent interrupt (ESC) aborts every subagent, persist, and
   * return the toast. The manager owns the negation so callers just say "flip it".
   */
  toggleAbortAllOnInterrupt(): { message: string; level: "info" | "warning" } {
    this._abortAllOnInterrupt = !this._abortAllOnInterrupt;
    return this.saveAndNotify(
      `Abort all subagents on ESC: ${this._abortAllOnInterrupt ? "on" : "off"}`,
    );
  }

  get midRunUpdates(): boolean {
    return this._midRunUpdates;
  }

  /**
   * Flip whether a background child may interrupt the parent with a mid-run
   * update, persist, and return the toast.
   */
  toggleMidRunUpdates(): { message: string; level: "info" | "warning" } {
    this._midRunUpdates = !this._midRunUpdates;
    return this.saveAndNotify(
      `Mid-run updates from background subagents: ${this._midRunUpdates ? "on" : "off"}`,
    );
  }

  /**
   * Persist the current snapshot, emit `subagents:settings_changed`,
   * and return the toast the UI should display.
   */
  saveAndNotify(successMsg: string): { message: string; level: "info" | "warning" } {
    const snap = this.snapshot();
    const persisted = saveSettings(snap, this.cwd);
    this.emit("subagents:settings_changed", { settings: snap, persisted });
    return persistToastFor(successMsg, persisted);
  }
}

// Sanity ceilings — prevent hand-edited configs from asking for values that
// make no operational sense (e.g. 1e6 concurrent subagents). Permissive enough
// that any realistic power-user setting passes through.
const MAX_CONCURRENT_CEILING = 1024;
const MAX_TURNS_CEILING = 10_000;
const GRACE_TURNS_CEILING = 1_000;
// Retention windows: 1 minute floor, two-week ceiling (60 * 24 * 14).
const RETENTION_MINUTES_CEILING = 20_160;

/** Clamp a retention window to [1, RETENTION_MINUTES_CEILING] minutes. */
function clampRetentionMinutes(n: number): number {
  return Math.min(RETENTION_MINUTES_CEILING, Math.max(1, n));
}

/** True when a value is an integer minute count within the accepted retention range. */
function isRetentionMinutes(n: unknown): n is number {
  return Number.isInteger(n) && (n as number) >= 1 && (n as number) <= RETENTION_MINUTES_CEILING;
}

/** Drop fields that don't match the expected shape. Silent — garbage becomes absent. */
function sanitize(raw: unknown): SubagentsSettings {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: SubagentsSettings = {};
  if (
    Number.isInteger(r.maxConcurrent) &&
    (r.maxConcurrent as number) >= 1 &&
    (r.maxConcurrent as number) <= MAX_CONCURRENT_CEILING
  ) {
    out.maxConcurrent = r.maxConcurrent as number;
  }
  if (
    Number.isInteger(r.defaultMaxTurns) &&
    (r.defaultMaxTurns as number) >= 0 &&
    (r.defaultMaxTurns as number) <= MAX_TURNS_CEILING
  ) {
    out.defaultMaxTurns = r.defaultMaxTurns as number;
  }
  if (
    Number.isInteger(r.graceTurns) &&
    (r.graceTurns as number) >= 1 &&
    (r.graceTurns as number) <= GRACE_TURNS_CEILING
  ) {
    out.graceTurns = r.graceTurns as number;
  }
  if (isRetentionMinutes(r.consumedSessionRetentionMinutes)) {
    out.consumedSessionRetentionMinutes = r.consumedSessionRetentionMinutes;
  }
  if (isRetentionMinutes(r.unconsumedSessionRetentionMinutes)) {
    out.unconsumedSessionRetentionMinutes = r.unconsumedSessionRetentionMinutes;
  }
  if (typeof r.abortAllOnInterrupt === "boolean") {
    out.abortAllOnInterrupt = r.abortAllOnInterrupt;
  }
  if (typeof r.midRunUpdates === "boolean") {
    out.midRunUpdates = r.midRunUpdates;
  }
  if (Array.isArray(r.excludedExtensionPackages)) {
    const sources = r.excludedExtensionPackages
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean);
    out.excludedExtensionPackages = [...new Set(sources)];
  }
  const promptInheritance = sanitizePromptInheritance(r.promptInheritance);
  if (promptInheritance) {
    out.promptInheritance = promptInheritance;
  }
  const modelAliases = sanitizeModelAliases(r.modelAliases);
  if (modelAliases !== undefined) {
    out.modelAliases = modelAliases;
  }
  return out;
}

/**
 * Keep only string→string alias entries with sane keys/values.
 * Keys are lowercased (matched case-insensitively), trimmed, and limited to
 * `[a-z0-9][a-z0-9-_]*` (max 64 chars); values must be non-empty strings
 * (max 256 chars). An explicitly empty object is preserved as an explicit
 * clear of the other layer; malformed entries are dropped, and a value with
 * no surviving entries (but non-empty raw) is dropped as garbage.
 * Returns undefined when the key was absent or unusable.
 */
function sanitizeModelAliases(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (typeof value !== "string") continue;
    const name = key.trim().toLowerCase();
    const target = value.trim();
    if (!/^[a-z0-9][a-z0-9-_]*$/.test(name) || name.length > 64) continue;
    if (target.length === 0 || target.length > 256) continue;
    if (Object.keys(out).length >= 64) break;
    out[name] = target;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Keep only provider entries naming a known strategy, absent when none survive.
 *
 * Settings arrive from JSON, where the declared types are aspirations, so the
 * strategy is checked at run time rather than trusted.
 */
function sanitizePromptInheritance(
  raw: unknown,
): Record<string, PromptInheritance> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const rules: Record<string, PromptInheritance> = {};
  for (const [provider, strategy] of Object.entries(raw as Record<string, unknown>)) {
    if (strategy === "full" || strategy === "portable") {
      rules[provider] = strategy;
    }
  }
  return Object.keys(rules).length > 0 ? rules : undefined;
}

function projectPath(cwd: string): string {
  return join(cwd, ".pi", "subagents.json");
}

/** Load merged settings: global provides defaults, project overrides. */
export function loadSettings(agentDir: string, cwd: string): SubagentsSettings {
  return loadLayeredSettings({
    agentDir,
    cwd,
    filename: "subagents.json",
    sanitize,
    warnLabel: "pi-subagents",
  } satisfies LayeredSettingsSource<SubagentsSettings>);
}

/** Hand-edited keys with no `/subagents:settings` affordance. A snapshot omits
 * them when empty, so an unrelated save must not delete a user's explicit
 * value (including an explicit `{}` clear) from the project file. */
const PRESERVED_KEYS = ["excludedExtensionPackages", "promptInheritance", "modelAliases"] as const;

/**
 * Write project-local settings. Global is never touched from code.
 * Hand-edited keys already present in the project file survive an unrelated
 * save even when the snapshot omits them. Returns `true` on success, `false`
 * if the write (or mkdir) failed so the caller can surface a warning —
 * persistence isn't fatal but isn't silent.
 */
export function saveSettings(s: SubagentsSettings, cwd: string = process.cwd()): boolean {
  const path = projectPath(cwd);
  try {
    let prev: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        prev = parsed as Record<string, unknown>;
      }
    } catch {
      // Absent or malformed project file — nothing to preserve.
    }
    const merged: Record<string, unknown> = { ...s };
    for (const key of PRESERVED_KEYS) {
      if (!(key in merged) && key in prev) {
        merged[key] = prev[key];
      }
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(merged, null, 2), "utf-8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Format the user-facing toast for a settings mutation. Pure function —
 * routes the success/failure of `saveSettings` into the right message + level
 * so the UI layer (index.ts) stays a thin wire between input and notification.
 */
export function persistToastFor(
  successMsg: string,
  persisted: boolean,
): { message: string; level: "info" | "warning" } {
  return persisted
    ? { message: successMsg, level: "info" }
    : { message: `${successMsg} (session only; failed to persist)`, level: "warning" };
}

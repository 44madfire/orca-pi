/**
 * Typed orchestration role→profile mapping service (UI1.2).
 *
 * Orca owns task/DAG/worktree/run lifecycle; Orca-Pi owns only Pi-specific
 * execution policy: which Pi profile backs each logical role
 * (worker / scout / reviewer / custom). This module is the authoritative
 * store for that mapping — the UI and CLI both use it, never ad-hoc JSON
 * writes or a panel-local copy.
 *
 * ```text
 * Orca task / role / preset
 *         ↓
 * Orca-Pi mapping (this module)
 *         ↓
 * Pi profile (profile/resolver.ts)
 *         ↓
 * resolved launch policy (pi/build-pi-launch.ts)
 * ```
 *
 * Stores (JSON, precedence low → high):
 *   - builtins (compiled: worker→worker, scout→scout, reviewer→reviewer)
 *   - user/global  (`$PI_CODING_AGENT_DIR/orchestration.json` or
 *     `~/.pi/agent/orchestration.json`)
 *   - project      (`<projectRoot>/.pi/orchestration.json`)
 *
 * Writes are schema-validated and atomic (temp sibling + rename). Stale
 * writes fail with `conflict` via SHA-256 source hashes — never silently
 * overwritten. No secrets belong here (profile names only, never tokens).
 *
 * Windows + WSL: all paths use slash-normalized joins; `\\wsl.localhost`
 * and drive-letter roots are preserved as opaque prefixes (never
 * re-resolved against `process.cwd()`).
 */

import { createHash } from "node:crypto";

export type OrchestrationScope = "user" | "project";

export type OrchestrationErrorCode =
  | "missing-scope"
  | "invalid-role"
  | "invalid-profile"
  | "validation-failed"
  | "conflict"
  | "atomic-write-failed"
  | "load-failed";

export class OrchestrationConfigError extends Error {
  readonly code: OrchestrationErrorCode;
  readonly scope?: OrchestrationScope;
  readonly role?: string;

  constructor(options: {
    code: OrchestrationErrorCode;
    message: string;
    scope?: OrchestrationScope;
    role?: string;
    cause?: unknown;
  }) {
    super(options.message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "OrchestrationConfigError";
    this.code = options.code;
    if (options.scope !== undefined) this.scope = options.scope;
    if (options.role !== undefined) this.role = options.role;
  }
}

/** Built-in role defaults (lowest layer, always present). */
export const BUILTIN_ROLE_MAPPING: Readonly<Record<string, string>> = Object.freeze({
  worker: "worker",
  scout: "scout",
  reviewer: "reviewer",
});

export const ORCHESTRATION_CONFIG_VERSION = 1;

/** Profile-name rule shared with `profile/schema.ts` (no import to keep this module light). */
const ROLE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 64;
const RESERVED = new Set(["__proto__", "prototype", "constructor"]);

function assertValidRole(role: string): void {
  if (typeof role !== "string" || role.length === 0 || role.length > MAX_NAME_LENGTH || !ROLE_PATTERN.test(role) || RESERVED.has(role)) {
    throw new OrchestrationConfigError({
      code: "invalid-role",
      role,
      message: `Invalid orchestration role ${JSON.stringify(role)}: use 1-${MAX_NAME_LENGTH} chars matching ${ROLE_PATTERN} (e.g. "worker", "scout", "reviewer").`,
    });
  }
}

function assertValidProfileRef(profile: string, role: string): void {
  if (typeof profile !== "string" || profile.length === 0 || profile.length > MAX_NAME_LENGTH || !ROLE_PATTERN.test(profile) || RESERVED.has(profile)) {
    throw new OrchestrationConfigError({
      code: "invalid-profile",
      role,
      message: `Invalid profile reference ${JSON.stringify(profile)} for role ${JSON.stringify(role)}: use 1-${MAX_NAME_LENGTH} chars matching ${ROLE_PATTERN} (e.g. "worker-fast").`,
    });
  }
}

function assertValidScope(scope: unknown): asserts scope is OrchestrationScope {
  if (scope !== "user" && scope !== "project") {
    throw new OrchestrationConfigError({
      code: "missing-scope",
      message: `Explicit scope is required (expected "user" or "project", got ${JSON.stringify(scope)}). Destructive targets are never inferred.`,
    });
  }
}

export interface RoleMapping {
  readonly roles: Readonly<Record<string, string>>;
  /** Effective mapping after builtins < user < project merge. */
  readonly effective: Readonly<Record<string, string>>;
  /** Per-role provenance (`builtin`, `user`, `project`). */
  readonly provenance: Readonly<Record<string, "builtin" | "user" | "project">>;
  /** Roles whose referenced profile is syntactically valid but missing/invalid at resolve time (filled by callers with profile knowledge). */
  readonly invalidRefs?: readonly string[];
  readonly config: {
    readonly userPath: string;
    readonly projectPath: string;
    readonly userExists: boolean;
    readonly projectExists: boolean;
  };
  readonly sourceHash: {
    readonly user?: string;
    readonly project?: string;
  };
}

export interface OrchestrationFs {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, content: string, encoding: "utf8"): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  mkdir(path: string, options?: { recursive: boolean }): Promise<string | undefined>;
  stat?(path: string): Promise<unknown>;
  unlink?(path: string): Promise<void>;
}

export interface OrchestrationPathOptions {
  projectRoot?: string;
  userPath?: string;
  projectPath?: string;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  osHomedir?: () => string;
}

export interface OrchestrationReadOptions extends OrchestrationPathOptions {
  fs?: OrchestrationFs;
}

export interface OrchestrationWriteOptions extends OrchestrationReadOptions {
  /**
   * Optimistic-concurrency guard for the target scope file (SHA-256 of the
   * file as last seen by the caller). `string` = must still match;
   * `null` = must still be absent; `undefined` = skip caller check
   * (pre-write re-read still guards against races inside the lock).
   */
  expectedSourceHash?: string | null;
}

/** SHA-256 hex of raw file text (stale-write version). */
export function hashOrchestrationText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function normalizeSlashes(input: string): string {
  return input.replace(/\\/g, "/");
}

function joinPosix(...parts: string[]): string {
  return parts
    .map((part, index) => (index === 0 ? part.replace(/\/+$/, "") : part.replace(/^\/+|\/+$/g, "")))
    .filter((part) => part.length > 0)
    .join("/");
}

function defaultOsHomedir(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("node:os") as typeof import("node:os");
  return os.homedir();
}

/** Canonical user/global orchestration path (JSON, alongside profiles.yaml). */
export function getUserOrchestrationPath(options?: {
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  osHomedir?: () => string;
}): string {
  const env = options?.env ?? process.env;
  const base = env.PI_CODING_AGENT_DIR?.trim();
  if (base) return joinPosix(normalizeSlashes(base).replace(/\/+$/, ""), "orchestration.json");
  const explicitHome = options?.homedir?.trim();
  if (explicitHome) return joinPosix(normalizeSlashes(explicitHome).replace(/\/+$/, ""), ".pi/agent/orchestration.json");
  const envHome = env.HOME?.trim();
  if (envHome) return joinPosix(normalizeSlashes(envHome).replace(/\/+$/, ""), ".pi/agent/orchestration.json");
  try {
    const resolveHome = options?.osHomedir ?? defaultOsHomedir;
    const osHome = resolveHome().trim();
    if (osHome) return joinPosix(normalizeSlashes(osHome).replace(/\/+$/, ""), ".pi/agent/orchestration.json");
  } catch {
    // Fall through.
  }
  return "~/.pi/agent/orchestration.json";
}

/** Canonical project orchestration path (`<projectRoot>/.pi/orchestration.json`). */
export function getProjectOrchestrationPath(projectRoot: string): string {
  return joinPosix(normalizeSlashes(projectRoot).replace(/\/+$/, ""), ".pi/orchestration.json");
}

function resolvePaths(options: OrchestrationPathOptions, fallbackRoot = "."): {
  userPath: string;
  projectPath: string;
  projectRoot: string;
} {
  const userPath =
    options.userPath ??
    getUserOrchestrationPath({ env: options.env, homedir: options.homedir, osHomedir: options.osHomedir });
  const projectRoot = options.projectRoot ?? fallbackRoot;
  const projectPath = options.projectPath ?? getProjectOrchestrationPath(projectRoot);
  return { userPath, projectPath, projectRoot };
}

async function realFs(): Promise<OrchestrationFs> {
  const fs = await import("node:fs/promises");
  return {
    readFile: (p, enc) => fs.readFile(p, enc),
    writeFile: (p, c, enc) => fs.writeFile(p, c, enc),
    rename: (a, b) => fs.rename(a, b),
    mkdir: (p, opts) => fs.mkdir(p, opts),
    stat: (p) => fs.stat(p),
    unlink: (p) => fs.unlink(p),
  };
}

function isEnoent(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT";
}

function parentDirOf(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return ".";
  return filePath.slice(0, index);
}

interface LoadedLayer {
  roles: Record<string, string>;
  rawText?: string;
  hash?: string;
  exists: boolean;
}

function parseLayerText(text: string, sourceLabel: string): Record<string, string> {
  if (text.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new OrchestrationConfigError({
      code: "load-failed",
      message: `Malformed orchestration config in ${sourceLabel}: ${error instanceof Error ? error.message : String(error)}. Expected JSON like {"roles":{"worker":"worker-fast"}}.`,
      cause: error,
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new OrchestrationConfigError({
      code: "validation-failed",
      message: `Invalid orchestration config in ${sourceLabel}: expected an object with a "roles" map.`,
    });
  }
  const record = parsed as Record<string, unknown>;
  const rolesRaw = record["roles"] ?? record;
  if (!rolesRaw || typeof rolesRaw !== "object" || Array.isArray(rolesRaw)) {
    throw new OrchestrationConfigError({
      code: "validation-failed",
      message: `Invalid orchestration config in ${sourceLabel}: "roles" must be an object mapping role → profile name.`,
    });
  }
  const out: Record<string, string> = {};
  for (const [role, ref] of Object.entries(rolesRaw as Record<string, unknown>)) {
    assertValidRole(role);
    if (typeof ref !== "string") {
      throw new OrchestrationConfigError({
        code: "invalid-profile",
        role,
        message: `Invalid profile reference for role ${JSON.stringify(role)} in ${sourceLabel}: expected a profile name string, got ${JSON.stringify(ref)}.`,
      });
    }
    assertValidProfileRef(ref, role);
    out[role] = ref;
  }
  const version = record["version"];
  if (version !== undefined && version !== ORCHESTRATION_CONFIG_VERSION && version !== 1) {
    throw new OrchestrationConfigError({
      code: "validation-failed",
      message: `Unsupported orchestration config version ${JSON.stringify(version)} in ${sourceLabel} (supported: 1).`,
    });
  }
  return out;
}

async function loadLayer(filePath: string, fs: OrchestrationFs): Promise<LoadedLayer> {
  let rawText: string;
  try {
    rawText = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isEnoent(error)) return { roles: {}, exists: false };
    throw new OrchestrationConfigError({
      code: "load-failed",
      message: `Could not read ${filePath}: ${error instanceof Error ? error.message : String(error)}.`,
      cause: error,
    });
  }
  const hash = hashOrchestrationText(rawText);
  return { roles: parseLayerText(rawText, filePath), rawText, hash, exists: true };
}

function serializeRoles(roles: Record<string, string>): string {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(roles).sort()) sorted[key] = roles[key]!;
  return `${JSON.stringify({ version: ORCHESTRATION_CONFIG_VERSION, roles: sorted }, null, 2)}\n`;
}

function tempSibling(target: string): string {
  return `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function atomicWrite(target: string, content: string, fs: OrchestrationFs): Promise<void> {
  try {
    await fs.mkdir(parentDirOf(target), { recursive: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("EEXIST")) {
      throw new OrchestrationConfigError({
        code: "atomic-write-failed",
        message: `Could not create config directory for ${target}: ${message}. Original left unchanged.`,
        cause: error,
      });
    }
  }
  const temp = tempSibling(target);
  try {
    await fs.writeFile(temp, content, "utf8");
  } catch (error) {
    throw new OrchestrationConfigError({
      code: "atomic-write-failed",
      message: `Could not stage orchestration write to ${target}: ${error instanceof Error ? error.message : String(error)}. Original left unchanged.`,
      cause: error,
    });
  }
  try {
    await fs.rename(temp, target);
  } catch (error) {
    try {
      if (fs.unlink) await fs.unlink(temp);
    } catch {
      // Best effort.
    }
    throw new OrchestrationConfigError({
      code: "atomic-write-failed",
      message: `Atomic replace of ${target} failed: ${error instanceof Error ? error.message : String(error)}. Original left unchanged.`,
      cause: error,
    });
  }
}

/** In-process mutex per target path (serializes concurrent writes in this process). */
const mutexes = new Map<string, Promise<void>>();

async function withMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = mutexes.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = prev.then(() => mine);
  mutexes.set(key, chain);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (mutexes.get(key) === chain) mutexes.delete(key);
  }
}

/**
 * Read the effective role→profile mapping (builtins < user < project).
 * Missing files read as empty layers (fresh installs expose builtins).
 * `knownProfiles` (optional) marks `invalidRefs` for references with no
 * matching profile — the mapping itself never throws for dangling refs so
 * the UI can surface them before launch instead of hiding the config.
 */
export async function getRoleMapping(
  options: OrchestrationReadOptions & { knownProfiles?: readonly string[] } = {},
): Promise<RoleMapping> {
  const { userPath, projectPath } = resolvePaths(options, options.projectRoot ?? ".");
  const fs = options.fs ?? (await realFs());
  const [userLayer, projectLayer] = await Promise.all([
    loadLayer(userPath, fs),
    loadLayer(projectPath, fs),
  ]);
  const effective: Record<string, string> = { ...BUILTIN_ROLE_MAPPING };
  const provenance: Record<string, "builtin" | "user" | "project"> = {};
  for (const role of Object.keys(effective)) provenance[role] = "builtin";
  for (const [role, ref] of Object.entries(userLayer.roles)) {
    effective[role] = ref;
    provenance[role] = "user";
  }
  for (const [role, ref] of Object.entries(projectLayer.roles)) {
    effective[role] = ref;
    provenance[role] = "project";
  }
  let invalidRefs: string[] | undefined;
  if (options.knownProfiles !== undefined) {
    const known = new Set(options.knownProfiles);
    invalidRefs = Object.entries(effective)
      .filter(([, ref]) => !known.has(ref))
      .map(([role]) => role);
    if (invalidRefs.length === 0) invalidRefs = undefined;
  }
  const roles: Record<string, string> = {};
  for (const [role, ref] of Object.entries(effective).sort(([a], [b]) => (a < b ? -1 : 1))) {
    roles[role] = ref;
  }
  return {
    roles,
    effective: Object.freeze({ ...roles }),
    provenance: Object.freeze({ ...provenance }),
    ...(invalidRefs !== undefined ? { invalidRefs: Object.freeze([...invalidRefs]) } : {}),
    config: {
      userPath,
      projectPath,
      userExists: userLayer.exists,
      projectExists: projectLayer.exists,
    },
    sourceHash: {
      ...(userLayer.hash !== undefined ? { user: userLayer.hash } : {}),
      ...(projectLayer.hash !== undefined ? { project: projectLayer.hash } : {}),
    },
  };
}

/**
 * Set one role→profile mapping in an explicit scope (user or project).
 * Validates role/profile syntax; does not require the referenced profile
 * to exist yet (dangling refs surface via `getRoleMapping({knownProfiles})`
 * so the UI can show them before launch). Atomic + conflict-safe.
 */
export async function setRoleMapping(
  input: { role: string; profile: string; scope: OrchestrationScope },
  options: OrchestrationWriteOptions = {},
): Promise<{ role: string; profile: string; scope: OrchestrationScope; path: string; sourceHashAfter?: string }> {
  assertValidScope(input.scope);
  assertValidRole(input.role);
  assertValidProfileRef(input.profile, input.role);
  const { userPath, projectPath } = resolvePaths(options, options.projectRoot ?? ".");
  const target = input.scope === "user" ? userPath : projectPath;
  const fs = options.fs ?? (await realFs());
  return await withMutex(target, async () => {
    const before = await loadLayer(target, fs);
    if (options.expectedSourceHash !== undefined) {
      const expected = options.expectedSourceHash;
      if (expected === null) {
        if (before.exists) {
          throw new OrchestrationConfigError({
            code: "conflict",
            scope: input.scope,
            role: input.role,
            message: `Stale write for orchestration role "${input.role}" in ${input.scope} config (${target}): expected absent but file exists. Reload and retry. No data was overwritten.`,
          });
        }
      } else if ((before.hash ?? null) !== expected) {
        throw new OrchestrationConfigError({
          code: "conflict",
          scope: input.scope,
          role: input.role,
          message: `Stale write for orchestration role "${input.role}" in ${input.scope} config (${target}): file changed since read. Reload and retry. No data was overwritten.`,
        });
      }
    }
    // Re-read both layers for merge validation (cheap, already have target).
    const next = { ...before.roles, [input.role]: input.profile };
    const content = serializeRoles(next);
    await atomicWrite(target, content, fs);
    return {
      role: input.role,
      profile: input.profile,
      scope: input.scope,
      path: target,
      sourceHashAfter: hashOrchestrationText(content),
    };
  });
}

/**
 * Delete one role override from an explicit scope (falls back to the lower
 * layer; builtins can never be deleted, only overridden). Removing the last
 * override deletes nothing — an empty scope file is written as `{roles:{}}`
 * (never removes the file implicitly, so absence stays meaningful).
 */
export async function deleteRoleOverride(
  input: { role: string; scope: OrchestrationScope },
  options: OrchestrationWriteOptions = {},
): Promise<{ role: string; scope: OrchestrationScope; path: string; removed: boolean }> {
  assertValidScope(input.scope);
  assertValidRole(input.role);
  const { userPath, projectPath } = resolvePaths(options, options.projectRoot ?? ".");
  const target = input.scope === "user" ? userPath : projectPath;
  const fs = options.fs ?? (await realFs());
  return await withMutex(target, async () => {
    const before = await loadLayer(target, fs);
    if (options.expectedSourceHash !== undefined) {
      const expected = options.expectedSourceHash;
      if (expected === null) {
        if (before.exists) {
          throw new OrchestrationConfigError({
            code: "conflict",
            scope: input.scope,
            role: input.role,
            message: `Stale delete for orchestration role "${input.role}" in ${input.scope} config (${target}): expected absent but file exists. Reload and retry.`,
          });
        }
      } else if ((before.hash ?? null) !== expected) {
        throw new OrchestrationConfigError({
          code: "conflict",
          scope: input.scope,
          role: input.role,
          message: `Stale delete for orchestration role "${input.role}" in ${input.scope} config (${target}): file changed since read. Reload and retry.`,
        });
      }
    }
    if (!Object.hasOwn(before.roles, input.role)) {
      return { role: input.role, scope: input.scope, path: target, removed: false };
    }
    const next = { ...before.roles };
    delete next[input.role];
    await atomicWrite(target, serializeRoles(next), fs);
    return { role: input.role, scope: input.scope, path: target, removed: true };
  });
}

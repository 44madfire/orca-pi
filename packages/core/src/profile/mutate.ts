/**
 * Authoritative profile mutation service (UI1.1).
 *
 * One schema-safe mutation layer over the existing profile
 * schema/resolver/layering model, suitable for direct use by a plugin
 * bridge and by the CLI machine surface. Both UI and CLI invoke the same
 * typed operations — the UI never implements its own YAML writer.
 *
 * Pipeline per mutation:
 * ```
 * mutation request
 *    ↓
 * load target layer
 *    ↓
 * apply structured mutation
 *    ↓
 * schema validate source document
 *    ↓
 * merge builtins < user < project
 *    ↓
 * resolve inheritance/effective profile
 *    ↓
 * validate effective config
 *    ↓
 * atomic write
 * ```
 *
 * Source-of-truth rules:
 * - Built-in profiles are immutable (compiled defaults, no file).
 * - User/global and project YAML remain the authoritative stores.
 * - No second profile database is introduced.
 * - Correctness/atomicity wins over comment/order preservation.
 * - Inheritance cycles, invalid tools/thinking/model fields, invalid GitHub
 *   identity assignments, etc. reuse the same schema/resolver as
 *   launch-time code (`validateProfilesDocument` + `resolveProfile`).
 *
 * Atomicity / safety:
 * - Write to a temporary sibling and atomically replace via rename.
 * - Never leave a partially-written config after validation/write failure.
 * - Stale-write races are prevented by serializing the read → validate →
 *   commit path under a per-target mutation lock (in-process mutex plus a
 *   cross-process `<target>.lock` file). The lock file stores a JSON
 *   `{ pid, token }` payload. A stale-by-mtime entry is only reaped after
 *   proving the owner dead via process liveness (never on mtime alone, so
 *   suspension/sleep can never cause a live holder to be reaped), and both
 *   reap and release never remove a path that may hold a live owner, even
 *   temporarily: on content mismatch they do nothing and return, so a live
 *   successor keeps mutual exclusion and no third writer can slip in during
 *   a claim/restore window. There is no heartbeat rewrite and no
 *   rename-claim (a live holder is never stale). SHA-256 source hashes are
 *   compared against freshly loaded state inside the lock; a mismatch
 *   returns a `conflict` instead of silently overwriting newer edits.
 * - Failed mutations leave the original document unchanged.
 * - No secret values belong in profile mutations (schema rejects unknown
 *   fields with a secrets reminder; this layer never accepts tokens).
 *
 * This module never builds Pi argv (JEF-7 owns the launch compiler) and
 * never reads prompt/skill file contents.
 */

import { createHash } from "node:crypto";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  getBuiltinProfilesDocument,
  isBuiltinProfileName,
} from "./builtins.js";
import {
  getProjectProfilesPath,
  getUserProfilesPath,
  mergeValidatedDocuments,
  parseAndValidateProfilesText,
} from "./load.js";
import { getFieldProvenance } from "./presentation.js";
import {
  MAX_PROFILE_NAME_LENGTH,
  PROFILE_NAME_PATTERN,
  RESERVED_PROFILE_NAMES,
  ProfileValidationError,
  validateProfilesDocument,
  type ProfileIssue,
} from "./schema.js";
import { ProfileResolveError, resolveAllProfiles, resolveProfile } from "./resolve.js";
import type {
  ResolvedPiProfile,
  ValidatedPiProfile,
  ValidatedProfilesDocument,
} from "./types.js";

/** Explicit write target. Never inferred for destructive operations. */
export type MutationScope = "user" | "project";

export type MutationAction =
  | "create"
  | "clone"
  | "patch"
  | "set"
  | "unset"
  | "delete";

export type ProfileMutationErrorCode =
  | "missing-scope"
  | "invalid-name"
  | "already-exists"
  | "not-found"
  | "builtin-immutable"
  | "invalid-field"
  | "invalid-value"
  | "validation-failed"
  | "resolve-failed"
  | "conflict"
  | "atomic-write-failed"
  | "load-failed";

/**
 * Typed mutation failure. `issues` carries dotted-path field errors when
 * the failure came from schema validation; `code` is machine-readable for
 * UI/CLI handling (`conflict` → reload + retry, `already-exists` →
 * pick another name, ...).
 */
export class ProfileMutationError extends Error {
  readonly code: ProfileMutationErrorCode;
  readonly profileName?: string;
  readonly scope?: MutationScope;
  readonly issues?: ProfileIssue[];
  readonly sourceLabel?: string;

  constructor(options: {
    code: ProfileMutationErrorCode;
    message: string;
    profileName?: string;
    scope?: MutationScope;
    issues?: ProfileIssue[];
    sourceLabel?: string;
    cause?: unknown;
  }) {
    super(options.message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ProfileMutationError";
    this.code = options.code;
    if (options.profileName !== undefined) this.profileName = options.profileName;
    if (options.scope !== undefined) this.scope = options.scope;
    if (options.issues !== undefined) this.issues = options.issues;
    if (options.sourceLabel !== undefined) this.sourceLabel = options.sourceLabel;
  }
}

/** All v1 profile fields addressable by set/unset/patch. */
export const MUTABLE_PROFILE_FIELDS: readonly string[] = [
  "extends",
  "provider",
  "model",
  "thinking",
  "systemPrompt",
  "systemPromptFile",
  "tools",
  "excludeTools",
  "skills",
  "extensions",
  "contextFiles",
  "discoverSkills",
  "discoverExtensions",
  "session",
  "githubIdentity",
  "displayName",
  "description",
] as const;

export type MutableProfileField = (typeof MUTABLE_PROFILE_FIELDS)[number];

const MUTABLE_FIELD_SET = new Set<string>(MUTABLE_PROFILE_FIELDS);

/** Minimal filesystem surface for mutations (injectable for tests). */
export interface MutationFs {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, content: string, encoding: "utf8"): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  mkdir(path: string, options?: { recursive: boolean }): Promise<string | undefined>;
  stat?(path: string): Promise<unknown>;
  unlink?(path: string): Promise<void>;
  /**
   * List directory entries (names only) for the cross-process lock directory
   * (`<target>.lock.d`). Optional: when absent the transaction still
   * serializes within the process via an in-memory mutex, but two OS
   * processes could interleave (see below).
   */
  readdir?(path: string): Promise<string[]>;
  /**
   * Atomic exclusive create: resolves only when `path` did not exist and
   * this call created it; rejects with an `EEXIST`-coded error otherwise.
   * Used for lock-directory candidates (`<target>.lock.d/<unique>`), which
   * are unique per contender so creation never contends. Optional: when
   * absent (or when `readdir` is absent) the transaction still serializes
   * within the process via an in-memory mutex, but two OS processes could
   * interleave (see below).
   */
  writeExclusive?(path: string, content: string): Promise<void>;
}

export interface MutationPathOptions {
  projectRoot?: string;
  userPath?: string;
  projectPath?: string;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  osHomedir?: () => string;
}

export interface MutationWriteOptions extends MutationPathOptions {
  fs?: MutationFs;
  /**
   * Optimistic-concurrency guard for the target scope's file: SHA-256 of the
   * target file as last seen by the caller (from a previous read receipt).
   * - `string`: the file must still exist with exactly this hash.
   * - `null`: the file must still be absent ("I read this scope while the
   *   file did not exist" — e.g. builtin-only with no override file yet).
   * - `undefined` (omit): skip the caller-side check (the pre-write re-read
   *   guard still applies for `string` mismatches, but absence cannot be
   *   asserted). UI clients should always send an explicit `string` or
   *   `null` so two creators from "no file" cannot silently overwrite each
   *   other; a mismatch fails with `conflict` instead of overwriting.
   */
  expectedSourceHash?: string | null;
}

/** SHA-256 hex of raw file text (stale-write version). */
export function hashSourceText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function assertValidScope(scope: unknown): asserts scope is MutationScope {
  if (scope !== "user" && scope !== "project") {
    throw new ProfileMutationError({
      code: "missing-scope",
      message: `Explicit --scope is required (expected "user" or "project", got ${JSON.stringify(scope)}). Destructive targets are never inferred when both layers exist.`,
    });
  }
}

function assertValidProfileName(name: string, what = "profile"): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new ProfileMutationError({
      code: "invalid-name",
      profileName: name,
      message: `Invalid ${what} name ${JSON.stringify(name)}: use 1-${MAX_PROFILE_NAME_LENGTH} chars matching ${PROFILE_NAME_PATTERN} (e.g. "worker-fast").`,
    });
  }
  if (RESERVED_PROFILE_NAMES.has(name)) {
    throw new ProfileMutationError({
      code: "invalid-name",
      profileName: name,
      message: `Reserved ${what} name ${JSON.stringify(name)}: "__proto__", "constructor", and "prototype" must never become profile map keys. Rename the profile.`,
    });
  }
  if (!PROFILE_NAME_PATTERN.test(name) || name.length > MAX_PROFILE_NAME_LENGTH) {
    throw new ProfileMutationError({
      code: "invalid-name",
      profileName: name,
      message: `Invalid ${what} name ${JSON.stringify(name)}: use 1-${MAX_PROFILE_NAME_LENGTH} chars matching ${PROFILE_NAME_PATTERN} (e.g. "worker-fast").`,
    });
  }
}

function assertValidField(field: string): asserts field is MutableProfileField {
  if (!MUTABLE_FIELD_SET.has(field)) {
    throw new ProfileMutationError({
      code: "invalid-field",
      message: `Unknown profile field ${JSON.stringify(field)}: expected one of ${MUTABLE_PROFILE_FIELDS.join(", ")}. Profiles must never contain secrets/API keys.`,
    });
  }
}

function resolveMutationPaths(options: MutationPathOptions, projectRootFallback = "."): {
  userPath: string;
  projectPath: string;
} {
  const userPath =
    options.userPath ??
    getUserProfilesPath({ env: options.env, homedir: options.homedir, osHomedir: options.osHomedir });
  const projectRoot = options.projectRoot ?? projectRootFallback;
  const projectPath = options.projectPath ?? getProjectProfilesPath(projectRoot);
  return { userPath, projectPath };
}

function targetPathForScope(scope: MutationScope, paths: { userPath: string; projectPath: string }): string {
  return scope === "user" ? paths.userPath : paths.projectPath;
}

async function getRealFs(): Promise<MutationFs> {
  const fs = await import("node:fs/promises");
  return {
    readFile: (p, enc) => fs.readFile(p, enc),
    writeFile: (p, c, enc) => fs.writeFile(p, c, enc),
    rename: (a, b) => fs.rename(a, b),
    mkdir: (p, opts) => fs.mkdir(p, opts),
    stat: (p) => fs.stat(p),
    unlink: (p) => fs.unlink(p),
    readdir: (p) => fs.readdir(p) as Promise<string[]>,
    writeExclusive: (p, c) => fs.writeFile(p, c, { encoding: "utf8", flag: "wx" }).then(() => undefined),
  };
}

async function resolveFs(provided?: MutationFs): Promise<MutationFs> {
  if (provided) return provided;
  return await getRealFs();
}

function isEnoent(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function emptyLayerDocument(sourceLabel: string): ValidatedProfilesDocument {
  return { profiles: Object.create(null), sourceLabel };
}

function cloneLayerDocument(doc: ValidatedProfilesDocument): ValidatedProfilesDocument {
  const profiles: Record<string, ValidatedPiProfile> = Object.create(null);
  for (const [name, profile] of Object.entries(doc.profiles)) {
    const copy: ValidatedPiProfile = { ...profile };
    // Arrays are copied (never shared); undefined fields stay absent so
    // emptiness checks (`remaining`) are not polluted by explicit undefineds.
    if (profile.tools !== undefined) copy.tools = [...profile.tools];
    else delete copy.tools;
    if (profile.excludeTools !== undefined) copy.excludeTools = [...profile.excludeTools];
    else delete copy.excludeTools;
    if (profile.skills !== undefined) copy.skills = [...profile.skills];
    else delete copy.skills;
    if (profile.extensions !== undefined) copy.extensions = [...profile.extensions];
    else delete copy.extensions;
    profiles[name] = copy;
  }
  return { profiles, sourceLabel: doc.sourceLabel };
}

/** True when a layer entry holds no real fields (ignores metadata + undefined). */
function isEmptyLayerEntry(entry: ValidatedPiProfile): boolean {
  for (const [key, value] of Object.entries(entry)) {
    if (key === "sourceLabel") continue;
    if (value !== undefined) return false;
  }
  return true;
}

/** Strip per-profile `sourceLabel` metadata for file serialization. */
function toFilePayload(doc: ValidatedProfilesDocument): { profiles: Record<string, Record<string, unknown>> } {
  const profiles: Record<string, Record<string, unknown>> = {};
  for (const [name, profile] of Object.entries(doc.profiles)) {
    const { sourceLabel: _ignored, ...rest } = profile as ValidatedPiProfile & { sourceLabel?: string };
    void _ignored;
    const entry: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (value === undefined) continue;
      entry[key] = Array.isArray(value) ? [...value] : value;
    }
    profiles[name] = entry;
  }
  return { profiles };
}

/** Serialize a validated layer document to canonical YAML (no metadata). */
export function serializeProfilesDocument(doc: ValidatedProfilesDocument): string {
  const payload = toFilePayload(doc);
  const text = stringifyYaml(payload);
  return text.endsWith("\n") ? text : `${text}\n`;
}

interface LoadedLayer {
  doc: ValidatedProfilesDocument;
  rawText?: string;
  hash?: string;
  exists: boolean;
  path: string;
}

async function loadLayerFile(
  filePath: string,
  fs: MutationFs,
): Promise<LoadedLayer> {
  let rawText: string;
  try {
    rawText = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      return { doc: emptyLayerDocument(filePath), exists: false, path: filePath };
    }
    throw new ProfileMutationError({
      code: "load-failed",
      sourceLabel: filePath,
      message: `Could not read ${filePath}: ${error instanceof Error ? error.message : String(error)}.`,
    });
  }
  const hash = hashSourceText(rawText);
  if (rawText.trim().length === 0) {
    // Empty file recovers as an empty layer so a broken/blank config can be
    // repaired through the same mutation path (failure-safe).
    return { doc: emptyLayerDocument(filePath), rawText, hash, exists: true, path: filePath };
  }
  try {
    const doc = parseAndValidateProfilesText(rawText, filePath);
    return { doc, rawText, hash, exists: true, path: filePath };
  } catch (error) {
    if (error instanceof ProfileValidationError) {
      throw new ProfileMutationError({
        code: "load-failed",
        sourceLabel: filePath,
        issues: error.issues,
        message: `Existing config in ${filePath} is invalid — repair it first (orca-pi profile validate):\n${error.issues.map((issue) => `  - ${issue.path}: ${issue.message}`).join("\n")}`,
        cause: error,
      });
    }
    // parseAndValidate throws ProfileLoadError for malformed syntax.
    throw new ProfileMutationError({
      code: "load-failed",
      sourceLabel: filePath,
      message: error instanceof Error ? error.message : String(error),
      cause: error,
    });
  }
}

/**
 * Shared pair-lock base path for one user+project layer pair (P2).
 *
 * Used INSTEAD of the opposite scope's file lock when the opposite config
 * file is absent, so no lock metadata is materialized next to an untargeted
 * config. Keyed by the canonical absolute pair (scope order independent),
 * it lives under the OS temp dir — always writable when the target store
 * is. Same-OS transactions on one pair always overlap on at least one lock
 * (target, opposite, or pair); absence→created races that slip through
 * still fail on the both-layer pre-commit existence revalidation.
 */
function pairLockPath(userPath: string, projectPath: string): string {
  const key = [resolve(userPath), resolve(projectPath)].sort().join("\n");
  const hash = createHash("sha256").update(key, "utf8").digest("hex").slice(0, 32);
  return join(tmpdir(), `orca-pi-profiles-${hash}`, "pair");
}

function parentDirOf(filePath: string): string {  const normalized = filePath.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return ".";
  return filePath.slice(0, index);
}

function tempSiblingPath(targetPath: string): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${targetPath}.tmp-${process.pid}-${Date.now()}-${random}`;
}

async function atomicWriteText(
  targetPath: string,
  content: string,
  fs: MutationFs,
): Promise<void> {
  const parent = parentDirOf(targetPath);
  try {
    await fs.mkdir(parent, { recursive: true });
  } catch (error) {
    // mkdir race (parallel creators) is benign; other failures are fatal.
    if (!isEnoent(error)) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("EEXIST")) {
        throw new ProfileMutationError({
          code: "atomic-write-failed",
          sourceLabel: targetPath,
          message: `Could not create config directory ${parent}: ${message}. Original document left unchanged.`,
          cause: error,
        });
      }
    }
  }
  const tempPath = tempSiblingPath(targetPath);
  try {
    await fs.writeFile(tempPath, content, "utf8");
  } catch (error) {
    throw new ProfileMutationError({
      code: "atomic-write-failed",
      sourceLabel: targetPath,
      message: `Could not stage config write to ${targetPath}: ${error instanceof Error ? error.message : String(error)}. Original document left unchanged.`,
      cause: error,
    });
  }
  try {
    await fs.rename(tempPath, targetPath);
  } catch (error) {
    try {
      if (fs.unlink) await fs.unlink(tempPath);
    } catch {
      // Best-effort temp cleanup; the original target is untouched.
    }
    throw new ProfileMutationError({
      code: "atomic-write-failed",
      sourceLabel: targetPath,
      message: `Atomic replace of ${targetPath} failed: ${error instanceof Error ? error.message : String(error)}. Original document left unchanged.`,
      cause: error,
    });
  }
}

async function removeTargetFile(targetPath: string, fs: MutationFs): Promise<void> {
  // Single-filesystem boundary (P2): an injected adapter without `unlink`
  // must never escape to the real host filesystem. Fail closed instead of
  // deleting an unrelated host path that happens to share the name.
  if (typeof fs.unlink !== "function") {
    throw new ProfileMutationError({
      code: "atomic-write-failed",
      sourceLabel: targetPath,
      message: `Could not remove emptied config ${targetPath}: the injected filesystem does not support deletion. Original document left unchanged.`,
    });
  }
  try {
    await fs.unlink(targetPath);
  } catch (error) {
    if (isEnoent(error)) return;
    throw new ProfileMutationError({
      code: "atomic-write-failed",
      sourceLabel: targetPath,
      message: `Could not remove emptied config ${targetPath}: ${error instanceof Error ? error.message : String(error)}.`,
      cause: error,
    });
  }
}

/**
 * Mutual exclusion for the read → validate → commit path (P1: lost-update fix).
 *
 * The stale-hash re-read alone cannot close the race: two writers loading the
 * same hash H can both pass the check and then overwrite each other via
 * sequential temp-file renames. Every mutation therefore runs inside:
 *
 * 1. an in-process async mutex per target path (serializes concurrent
 *    mutations in this process — CLI, UI bridge, and tests alike), and
 * 2. a cross-process file lock (`<target>.lock`, created with exclusive
 *    `wx` semantics so exactly one OS process wins; stale locks older than
 *    `staleMs` are reaped). When the filesystem cannot do exclusive creates
 *    (`writeExclusive` absent, e.g. read-only test doubles), only layer 1
 *    applies and cross-process interleaving is possible but still detected
 *    by the post-lock fresh load + `expectedSourceHash` comparison below.
 *
 * The lock is held from *before* the initial load until after the atomic
 * replace, so the second writer always loads the first writer's committed
 * state: with a stale `expectedSourceHash` it fails `conflict` instead of
 * silently overwriting; without one it applies onto current data (regular
 * serialized last-writer-wins, never a stale-read overwrite).
 */
const processMutationMutexes = new Map<string, Promise<void>>();

async function withProcessMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = processMutationMutexes.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = prev.then(() => mine);
  processMutationMutexes.set(key, chain);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (processMutationMutexes.get(key) === chain) processMutationMutexes.delete(key);
  }
}

function isLockHeldError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ((error as { code?: unknown }).code === "EEXIST") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /EEXIST|already exists/i.test(message);
}

/** Permission-denied class: the store cannot be written by this process. */
function isPermissionDenied(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "EACCES" || code === "EPERM" || code === "EROFS";
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface MutationLockOptions {
  /** Max time to wait for another writer's lock (default 10_000ms). */
  timeoutMs?: number;
  /**
   * Ignored (kept for backward compatibility). Dead contenders are ignored
   * immediately via PID liveness — there is no mtime lease, so suspension or
   * sleep can never cause a live holder to be reaped.
   */
  staleMs?: number;
  /**
   * Injectable liveness probe (tests). Defaults to `process.kill(pid, 0)`:
   * ESRCH → dead, EPERM/success → alive, anything else → alive
   * (fail-closed). Suspension/sleep keeps the pid alive, so a suspended
   * holder is never ignored.
   */
  isProcessAlive?: (pid: number) => boolean;
  /**
   * What to do when this scope's lock cannot be coordinated because its
   * store denies writes (EACCES/EPERM/EROFS). `"throw"` (default) fails the
   * mutation; `"skip"` runs the body without holding this scope's lock.
   * `"skip"` is only safe for the NON-target scope of a transaction issued
   * against a readable opposite layer: a store that denies writes cannot
   * accept conflicting service commits through that layer either, while the
   * target lock plus both-layer pre-commit revalidation still guard the
   * commit. Used so a scoped mutation does not require write access to the
   * opposite config store (e.g. user edit inside a read-only checkout).
   */
  ifUnavailable?: "throw" | "skip";
}

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (!!error && typeof error === "object" && (error as { code?: unknown }).code === "ESRCH") {
      return false;
    }
    return true;
  }
}

interface LockTicket {
  fileName: string;
  pid: number | undefined;
  token: string;
  number: number;
  origin?: string;
  alive: boolean;
}

/**
 * Portable runtime identity for lock tickets (P1: Windows/WSL boundary).
 *
 * `process.kill(pid, 0)` is only meaningful inside the current OS/PID
 * namespace: a Windows PID cannot be probed from WSL and vice versa — and
 * WSL2 distributions on one machine run in SEPARATE PID namespaces despite
 * sharing hostname, `process.platform === "linux"`, and the same kernel
 * (so boot IDs match too). Tickets therefore carry their origin, including
 * the actual `WSL_DISTRO_NAME` (never a bare `wsl` literal that conflates
 * Ubuntu with Debian), and any ticket from a different origin is treated as
 * ALIVE (fail-closed: wait, never ignore, never GC) because its death
 * cannot be proven here. A crashed foreign writer blocks until timeout →
 * conflict, then an operator removes the lock dir; it can never be silently
 * treated as dead.
 */
export function lockOrigin(): string {
  let host = "unknown-host";
  try {
    host = hostname();
  } catch {
    // Best effort; an unknown host still namespaces correctly per process.
  }
  const distro = process.env.WSL_DISTRO_NAME;
  const namespace =
    typeof distro === "string" && distro.length > 0
      ? distro
      : process.env.WSL_INTEROP !== undefined
        ? "wsl-unknown-distro"
        : "native";
  return `${host}|${process.platform}|${namespace}`;
}

function makeLockToken(): string {
  return `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function choosingName(token: string): string {
  return `c-${token}.choosing`;
}

function numberName(token: string): string {
  return `n-${token}.json`;
}

function parseLockTicket(
  fileName: string,
  content: string,
  isAlive: (pid: number) => boolean,
  kind: "choosing" | "number",
  ownOrigin: string,
): LockTicket {
  try {
    const parsed = JSON.parse(content) as { pid?: unknown; token?: unknown; number?: unknown; origin?: unknown };
    if (
      typeof parsed.pid === "number" &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.token === "string" &&
      parsed.token.length > 0
    ) {
      // Cross-namespace tickets (different host/platform/WSL marker) can
      // never be proven dead from here: a foreign `process.kill` probe is
      // meaningless, so fail closed as alive. Missing origin means a legacy
      // same-process ticket (unmerged iterations only) — probe locally.
      const foreign = typeof parsed.origin === "string" && parsed.origin !== ownOrigin;
      const alive = foreign ? true : isAlive(parsed.pid);
      if (kind === "choosing") {
        return { fileName, pid: parsed.pid, token: parsed.token, number: 0, origin: typeof parsed.origin === "string" ? parsed.origin : undefined, alive };
      }
      if (typeof parsed.number === "number" && Number.isFinite(parsed.number)) {
        return { fileName, pid: parsed.pid, token: parsed.token, number: parsed.number, origin: typeof parsed.origin === "string" ? parsed.origin : undefined, alive };
      }
    }
  } catch {
    // Fall through to foreign-file handling below.
  }
  // Foreign/unparsable entries carry no provable liveness — fail-closed:
  // choosing files block (a contender may be mid-publication); number files
  // act as live holder with number 0 (oldest, blocks until timeout →
  // conflict, manual `rm` of the lock dir recovers). Production never writes
  // these (JSON format ships with UI1.1); this only affects foreign files.
  if (kind === "choosing") {
    return { fileName, pid: undefined, token: fileName, number: 0, alive: true };
  }
  return { fileName, pid: undefined, token: fileName, number: 0, alive: true };
}

interface LockListing {
  choosing: LockTicket[];
  numbers: LockTicket[];
}

async function listLockDir(
  fs: MutationFs,
  lockDir: string,
  isAlive: (pid: number) => boolean,
  ownOrigin?: string,
): Promise<LockListing> {
  const choosing: LockTicket[] = [];
  const numbers: LockTicket[] = [];
  if (typeof fs.readdir !== "function") return { choosing, numbers };
  let names: string[];
  try {
    names = await fs.readdir(lockDir);
  } catch (error) {
    if (isEnoent(error)) return { choosing, numbers };
    throw error;
  }
  for (const name of names) {
    if (name === "." || name === "..") continue;
    try {
      if (name.startsWith("c-") && name.endsWith(".choosing")) {
        const content = await fs.readFile(`${lockDir}/${name}`, "utf8");
        choosing.push(parseLockTicket(name, content, isAlive, "choosing", ownOrigin ?? lockOrigin()));
      } else if (name.startsWith("n-") && name.endsWith(".json")) {
        const content = await fs.readFile(`${lockDir}/${name}`, "utf8");
        numbers.push(parseLockTicket(name, content, isAlive, "number", ownOrigin ?? lockOrigin()));
      }
    } catch (error) {
      if (!isEnoent(error)) throw error;
      // An entry that vanishes mid-scan is a contender transitioning or
      // releasing — never an error. The only legal transition is
      // choosing → number under the SAME token (numbers are published
      // before the choosing flag is cleared; nothing is ever renamed), so a
      // vanished choosing flag is followed to its number file directly.
      // Without this, a snapshot containing `c-B.choosing` but predating
      // `n-B.json` would miss B's smaller ticket entirely after B
      // transitions, admitting two holders from the same source version.
      // A vanished number file means its owner released: safely ignored.
      if (name.startsWith("c-") && name.endsWith(".choosing")) {
        const token = name.slice("c-".length, -".choosing".length);
        try {
          const content = await fs.readFile(`${lockDir}/n-${token}.json`, "utf8");
          numbers.push(parseLockTicket(`n-${token}.json`, content, isAlive, "number", ownOrigin ?? lockOrigin()));
        } catch (followError) {
          if (!isEnoent(followError)) throw followError;
        }
      }
    }
  }
  return { choosing, numbers };
}

async function deleteOwnFiles(
  fs: MutationFs,
  lockDir: string,
  files: string[],
): Promise<void> {
  if (typeof fs.unlink !== "function") return;
  for (const f of files) {
    try {
      await fs.unlink(`${lockDir}/${f}`);
    } catch {
      // Best effort; dead files are ignored (never block) and GC'd by holders.
    }
  }
}

export async function withMutationLock<T>(
  targetPath: string,
  fs: MutationFs,
  fn: (ownLockFile: string | undefined) => Promise<T>,
  options: MutationLockOptions = {},
): Promise<T> {
  return await withProcessMutex(targetPath, async () => {
    // `"skip"` is used only for the NON-target scope by
    // runMutationTransaction: when that scope's store denies writes
    // (EACCES/EPERM/EROFS) the body runs without holding this scope's lock.
    // That stays safe because such a store cannot accept conflicting service
    // commits through that layer either, while the target lock plus
    // both-layer pre-commit revalidation still guard the commit.
    const ifUnavailable = options.ifUnavailable ?? "throw";
    // P1 (fresh-install path): the lock directory lives next to the target,
    // so the parent directory must exist before anything else. Real
    // `writeFile(..., { flag: "wx" })` never creates parents — without this
    // the first mutation on a fresh store would fail ENOENT on the lock.
    try {
      await fs.mkdir(parentDirOf(targetPath), { recursive: true });
    } catch (error) {
      if (ifUnavailable === "skip" && isPermissionDenied(error)) return await fn(undefined);
      throw new ProfileMutationError({
        code: "atomic-write-failed",
        sourceLabel: targetPath,
        message: `Could not create config directory ${parentDirOf(targetPath)}: ${error instanceof Error ? error.message : String(error)}. Original document left unchanged.`,
        cause: error,
      });
    }
    const writeExclusive = fs.writeExclusive;
    const canCoordinate =
      typeof writeExclusive === "function" &&
      typeof fs.readdir === "function" &&
      typeof fs.unlink === "function";
    const lockDir = `${targetPath}.lock.d`;
    const timeoutMs = options.timeoutMs ?? 10_000;
    const isAlive = options.isProcessAlive ?? defaultIsProcessAlive;
    const ownOrigin = lockOrigin();
    if (!canCoordinate) {
      // No cross-process coordination available (e.g. read-only test doubles):
      // in-process mutex above still serializes this process; cross-process
      // interleaving is possible but detected by the post-lock fresh load +
      // `expectedSourceHash` comparison below.
      return await fn(undefined);
    }
    try {
      await fs.mkdir(lockDir, { recursive: true });
    } catch (error) {
      if (ifUnavailable === "skip" && isPermissionDenied(error)) return await fn(undefined);
      throw new ProfileMutationError({
        code: "atomic-write-failed",
        sourceLabel: targetPath,
        message: `Could not create lock directory ${lockDir}: ${error instanceof Error ? error.message : String(error)}. Original document left unchanged.`,
        cause: error,
      });
    }
    // Bakery-style acquisition with unique files per contender. Each
    // participant only ever deletes its OWN choosing/number files — nobody
    // ever removes or renames another participant's file, even temporarily,
    // so a live holder's entries cannot go absent while it is active.
    // Priority (the ticket number) is chosen AFTER publishing the choosing
    // flag, from currently visible numbers, so a contender descheduled before
    // publication cannot retroactively outrank an active holder: it either
    // was visible via choosing (holders wait for it) or it picks a larger
    // number after seeing the holder. Dead pids are ignored (never waited
    // on), so suspension/sleep — pid still alive — can never cause a live
    // holder to be skipped.
    const failWithBusy = (): never => {
      throw new ProfileMutationError({
        code: "conflict",
        sourceLabel: targetPath,
        message:
          `Concurrent profile write in progress for ${targetPath}: another writer holds the mutation lock. ` +
          `Wait for it to finish, reload, and retry. No data was overwritten.`,
      });
    };
    // 1-2. Publish choosing BEFORE reading numbers (bakery door), then pick
    // number = 1 + max visible. Unique names: creation never contends; on
    // astronomical collision, clean up and retry with a fresh token.
    let token = "";
    let choosing = "";
    let numberFile = "";
    let ownNumber = 0;
    for (;;) {
      token = makeLockToken();
      choosing = choosingName(token);
      numberFile = numberName(token);
      try {
        await writeExclusive.call(fs, `${lockDir}/${choosing}`, JSON.stringify({ pid: process.pid, token, origin: ownOrigin }));
      } catch (error) {
        if (!isLockHeldError(error)) {
          if (ifUnavailable === "skip" && isPermissionDenied(error)) return await fn(undefined);
          throw error;
        }
        continue;
      }
      let maxSeen = 0;
      try {
        const listing = await listLockDir(fs, lockDir, isAlive, ownOrigin);
        for (const n of listing.numbers) {
          if (Number.isFinite(n.number) && n.number > maxSeen) maxSeen = n.number;
        }
      } catch (error) {
        if (!isEnoent(error)) {
          await deleteOwnFiles(fs, lockDir, [choosing]);
          if (ifUnavailable === "skip" && isPermissionDenied(error)) return await fn(undefined);
          throw error;
        }
      }
      ownNumber = maxSeen + 1;
      try {
        await writeExclusive.call(
          fs,
          `${lockDir}/${numberFile}`,
          JSON.stringify({ pid: process.pid, token, number: ownNumber, origin: ownOrigin }),
        );
        break;
      } catch (error) {
        await deleteOwnFiles(fs, lockDir, [choosing]);
        if (!isLockHeldError(error)) {
          if (ifUnavailable === "skip" && isPermissionDenied(error)) return await fn(undefined);
          throw error;
        }
      }
    }
    // Owner cleanup covers EVERYTHING after publication: election timeouts,
    // listing failures, and the body all remove our own files (never anyone
    // else's), so a timed-out contender cannot wedge the process with an
    // orphaned live candidate.
    let enteredBody = false;
    try {
      // 2b. (number already published above.)
      // 3. Clear choosing: our number is now visible, holders need not wait.
      await deleteOwnFiles(fs, lockDir, [choosing]);
      const isSmaller = (aNumber: number, aToken: string, bNumber: number, bToken: string): boolean => {
        if (aNumber !== bNumber) return aNumber < bNumber;
        return aToken < bToken;
      };
      // 4. Bakery wait: spin while any live contender is choosing (except our
      // cleared flag) or holds a smaller (number, token). Dead pids are
      // ignored immediately — never waited on, never removed to proceed.
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const listing = await listLockDir(fs, lockDir, isAlive, ownOrigin);
        let waitFor: string | undefined;
        for (const c of listing.choosing) {
          if (c.token === token) continue;
          if (!c.alive) continue;
          waitFor = c.fileName;
          break;
        }
        if (waitFor === undefined) {
          for (const n of listing.numbers) {
            if (n.token === token) continue;
            if (!n.alive) continue;
            if (isSmaller(n.number, n.token, ownNumber, token)) {
              waitFor = n.fileName;
              break;
            }
          }
        }
        if (waitFor === undefined) break;
        if (Date.now() >= deadline) failWithBusy();
        await sleepMs(15);
      }
      // 5. Holder: opportunistically GC proven-dead same-origin files (pid
      // dead, never a live file, never a foreign-origin file whose death
      // cannot be proven here). The only non-owner deletion in the protocol.
      if (typeof fs.unlink === "function") {
        try {
          const listing = await listLockDir(fs, lockDir, isAlive, ownOrigin);
          for (const entry of [...listing.choosing, ...listing.numbers]) {
            if (entry.token === token) continue;
            if (entry.alive) continue;
            if (entry.pid === undefined) continue;
            if (entry.origin !== undefined && entry.origin !== ownOrigin) continue;
            try {
              await fs.unlink(`${lockDir}/${entry.fileName}`);
            } catch {
              // Lost a race with another holder's GC; ignore.
            }
          }
        } catch {
          // Best-effort GC; election already succeeded.
        }
      }
      try {
        enteredBody = true;
        return await fn(numberFile);
      } finally {
        // Owner-only release: delete exactly our own number file.
        await deleteOwnFiles(fs, lockDir, [numberFile, choosing]);
      }
    } catch (error) {
      // Election/body failure (including timeout/conflict): remove our own
      // files before propagating so no orphaned live candidate wedges later
      // writes in this long-lived process. A pre-body permission denial
      // under `ifUnavailable: "skip"` instead runs the body uncoordinated.
      await deleteOwnFiles(fs, lockDir, [numberFile, choosing]);
      if (!enteredBody && ifUnavailable === "skip" && isPermissionDenied(error)) {
        return await fn(undefined);
      }
      throw error;
    }
  });
}

/**
 * Pre-write holder re-verification for one scope lock (fail-closed).
 *
 * Consistent with bakery acquisition: only live NUMBER tickets participate
 * in holdership. A live `choosing` flag from a contender that started after
 * this holder was elected does not displace it — that contender necessarily
 * picks a larger number once it reads the holder's published ticket — so
 * choosing files are deliberately ignored here (the acquisition wait loop,
 * not this check, is where choosing blocks entry). A missing/dead own
 * ticket or a smaller live number still aborts with `conflict`.
 */
async function assertStillHolder(
  fs: MutationFs,
  lockDir: string,
  lockContent: string,
  profileName: string,
  scope: MutationScope,
  sourceLabel: string,
): Promise<void> {
  const listing = await listLockDir(fs, lockDir, defaultIsProcessAlive, lockOrigin());
  const own = listing.numbers.find((n) => n.fileName === lockContent);
  let stillHolder = own !== undefined && own.alive;
  if (stillHolder) {
    for (const n of listing.numbers) {
      if (n.token === own!.token) continue;
      if (!n.alive) continue;
      if (n.number !== own!.number ? n.number < own!.number : n.token < own!.token) {
        stillHolder = false;
        break;
      }
    }
  }
  if (!stillHolder) {
    throw new ProfileMutationError({
      code: "conflict",
      profileName,
      scope,
      sourceLabel,
      message:
        `Concurrent profile write stole the mutation lock for "${profileName}" in ${scope} config (${sourceLabel}) before commit. Reload and retry. No data was overwritten.`,
    });
  }
}

/** Pre-write re-read guard: fail with `conflict` when the file changed. */
async function assertNoConcurrentChange(
  targetPath: string,
  hashBefore: string | undefined,
  existedBefore: boolean,
  fs: MutationFs,
  profileName: string,
  scope: MutationScope,
): Promise<void> {
  let currentHash: string | undefined;
  let currentExists = false;
  try {
    const currentText = await fs.readFile(targetPath, "utf8");
    currentHash = hashSourceText(currentText);
    currentExists = true;
  } catch (error) {
    if (isEnoent(error)) {
      currentExists = false;
      currentHash = undefined;
    } else {
      throw new ProfileMutationError({
        code: "load-failed",
        profileName,
        scope,
        sourceLabel: targetPath,
        message: `Could not re-read ${targetPath} before write: ${error instanceof Error ? error.message : String(error)}.`,
        cause: error,
      });
    }
  }
  if (currentExists !== existedBefore || currentHash !== hashBefore) {
    throw new ProfileMutationError({
      code: "conflict",
      profileName,
      scope,
      sourceLabel: targetPath,
      message:
        `Stale write detected for profile "${profileName}" in ${scope} config (${targetPath}): the file changed since it was read. ` +
        `Reload (orca-pi profile read ${profileName}) and retry with the fresh source hash. No data was overwritten.`,
    });
  }
}

/** Machine-readable per-field provenance for UI rendering. */
export interface MutationFieldProvenance {
  kind: "built-in" | "user" | "project";
  definedIn?: string;
  configPath?: string;
  inherited: boolean;
  display: string;
}

export interface ProfileMutationReceipt {
  action: MutationAction;
  profileName: string;
  sourceName?: string;
  scope: MutationScope;
  path: string;
  existedBefore: boolean;
  existsAfter: boolean;
  sourceHashBefore?: string;
  sourceHashAfter?: string;
  deleted: boolean;
  resolved?: ResolvedPiProfile;
  extendsChain?: readonly string[];
  provenance?: Record<string, MutationFieldProvenance>;
  sourceLabel?: string;
}

function buildProvenanceMap(
  profileName: string,
  chain: readonly string[],
  layers: {
    mergedDoc: ValidatedProfilesDocument;
    builtinDoc: ValidatedProfilesDocument;
    userDoc?: ValidatedProfilesDocument;
    projectDoc?: ValidatedProfilesDocument;
    userPath: string;
    projectPath: string;
  },
): Record<string, MutationFieldProvenance> {
  const out: Record<string, MutationFieldProvenance> = {};
  for (const field of MUTABLE_PROFILE_FIELDS) {
    const provenance = getFieldProvenance(profileName, field as never, chain, layers);
    out[field] = {
      kind: provenance.kind,
      ...(provenance.definedIn !== undefined ? { definedIn: provenance.definedIn } : {}),
      ...(provenance.configPath !== undefined ? { configPath: provenance.configPath } : {}),
      inherited: provenance.inherited,
      display: provenance.display,
    };
  }
  return out;
}

/** Editable layer values for one field (UI model). */
export interface EditableFieldView {
  builtin?: unknown;
  user?: unknown;
  project?: unknown;
  effective?: unknown;
  provenance: MutationFieldProvenance;
}

export interface EditableProfileView {
  name: string;
  exists: boolean;
  extendsChain: readonly string[];
  displayName?: string;
  description?: string;
  source: {
    builtin?: ValidatedPiProfile;
    user?: ValidatedPiProfile;
    project?: ValidatedPiProfile;
  };
  effective?: ResolvedPiProfile;
  fields: Record<string, EditableFieldView>;
  validation: {
    ok: boolean;
    error?: string;
    code?: string;
    issues?: ProfileIssue[];
  };
  config: {
    userPath: string;
    projectPath: string;
    userExists: boolean;
    projectExists: boolean;
  };
  sourceHash: {
    user?: string;
    project?: string;
  };
}

/**
 * Build the UI-facing editable view from already-loaded layers. Pure: never
 * touches the filesystem, never builds Pi argv (callers reuse the launch
 * compiler with `effective` when they need a preview).
 */
export function buildEditableView(
  name: string,
  layers: {
    mergedDoc: ValidatedProfilesDocument;
    builtinDoc: ValidatedProfilesDocument;
    userDoc?: ValidatedProfilesDocument;
    projectDoc?: ValidatedProfilesDocument;
    userPath: string;
    projectPath: string;
    userExists: boolean;
    projectExists: boolean;
  },
  hashes?: { user?: string; project?: string },
): EditableProfileView {
  const exists = Object.hasOwn(layers.mergedDoc.profiles, name);
  const builtin = Object.hasOwn(layers.builtinDoc.profiles, name)
    ? layers.builtinDoc.profiles[name]
    : undefined;
  const user = layers.userDoc && Object.hasOwn(layers.userDoc.profiles, name)
    ? layers.userDoc.profiles[name]
    : undefined;
  const project = layers.projectDoc && Object.hasOwn(layers.projectDoc.profiles, name)
    ? layers.projectDoc.profiles[name]
    : undefined;
  const strip = (entry?: ValidatedPiProfile): ValidatedPiProfile | undefined => {
    if (!entry) return undefined;
    const { sourceLabel: _ignored, ...rest } = entry;
    void _ignored;
    return { ...rest };
  };
  if (!exists) {
    const fields: Record<string, EditableFieldView> = {};
    for (const field of MUTABLE_PROFILE_FIELDS) {
      fields[field] = {
        ...(builtin?.[field as keyof ValidatedPiProfile] !== undefined
          ? { builtin: builtin?.[field as keyof ValidatedPiProfile] }
          : {}),
        ...(user?.[field as keyof ValidatedPiProfile] !== undefined
          ? { user: user?.[field as keyof ValidatedPiProfile] }
          : {}),
        ...(project?.[field as keyof ValidatedPiProfile] !== undefined
          ? { project: project?.[field as keyof ValidatedPiProfile] }
          : {}),
        provenance: { kind: "built-in", inherited: false, display: "built-in" },
      };
    }
    return {
      name,
      exists: false,
      extendsChain: [],
      source: {
        ...(builtin ? { builtin: strip(builtin) } : {}),
        ...(user ? { user: strip(user) } : {}),
        ...(project ? { project: strip(project) } : {}),
      },
      fields,
      validation: {
        ok: false,
        code: "unknown-profile",
        error: `Unknown Pi profile "${name}".`,
      },
      config: {
        userPath: layers.userPath,
        projectPath: layers.projectPath,
        userExists: layers.userExists,
        projectExists: layers.projectExists,
      },
      sourceHash: {
        ...(hashes?.user !== undefined ? { user: hashes.user } : {}),
        ...(hashes?.project !== undefined ? { project: hashes.project } : {}),
      },
    };
  }
  try {
    const resolved = resolveProfile(name, layers.mergedDoc);
    const chain = resolved.extendsChain;
    const fields: Record<string, EditableFieldView> = {};
    for (const field of MUTABLE_PROFILE_FIELDS) {
      const key = field as keyof ValidatedPiProfile;
      const provenance = getFieldProvenance(name, field as never, chain, layers);
      const effective = (resolved as unknown as Record<string, unknown>)[field];
      fields[field] = {
        ...(builtin?.[key] !== undefined ? { builtin: builtin?.[key] } : {}),
        ...(user?.[key] !== undefined ? { user: user?.[key] } : {}),
        ...(project?.[key] !== undefined ? { project: project?.[key] } : {}),
        ...(effective !== undefined ? { effective } : {}),
        provenance: {
          kind: provenance.kind,
          ...(provenance.definedIn !== undefined ? { definedIn: provenance.definedIn } : {}),
          ...(provenance.configPath !== undefined ? { configPath: provenance.configPath } : {}),
          inherited: provenance.inherited,
          display: provenance.display,
        },
      };
    }
    return {
      name,
      exists: true,
      extendsChain: chain,
      ...(resolved.displayName !== undefined ? { displayName: resolved.displayName } : {}),
      ...(resolved.description !== undefined ? { description: resolved.description } : {}),
      source: {
        ...(builtin ? { builtin: strip(builtin) } : {}),
        ...(user ? { user: strip(user) } : {}),
        ...(project ? { project: strip(project) } : {}),
      },
      effective: resolved,
      fields,
      validation: { ok: true },
      config: {
        userPath: layers.userPath,
        projectPath: layers.projectPath,
        userExists: layers.userExists,
        projectExists: layers.projectExists,
      },
      sourceHash: {
        ...(hashes?.user !== undefined ? { user: hashes.user } : {}),
        ...(hashes?.project !== undefined ? { project: hashes.project } : {}),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : undefined;
    const issues =
      error instanceof ProfileValidationError ? error.issues : undefined;
    const fields: Record<string, EditableFieldView> = {};
    for (const field of MUTABLE_PROFILE_FIELDS) {
      const key = field as keyof ValidatedPiProfile;
      fields[field] = {
        ...(builtin?.[key] !== undefined ? { builtin: builtin?.[key] } : {}),
        ...(user?.[key] !== undefined ? { user: user?.[key] } : {}),
        ...(project?.[key] !== undefined ? { project: project?.[key] } : {}),
        provenance: { kind: "built-in", inherited: false, display: "built-in" },
      };
    }
    return {
      name,
      exists: true,
      extendsChain: [],
      source: {
        ...(builtin ? { builtin: strip(builtin) } : {}),
        ...(user ? { user: strip(user) } : {}),
        ...(project ? { project: strip(project) } : {}),
      },
      fields,
      validation: {
        ok: false,
        error: message,
        ...(code !== undefined ? { code } : {}),
        ...(issues !== undefined ? { issues } : {}),
      },
      config: {
        userPath: layers.userPath,
        projectPath: layers.projectPath,
        userExists: layers.userExists,
        projectExists: layers.projectExists,
      },
      sourceHash: {
        ...(hashes?.user !== undefined ? { user: hashes.user } : {}),
        ...(hashes?.project !== undefined ? { project: hashes.project } : {}),
      },
    };
  }
}

/**
 * Read the editable source + effective view for one profile. Loads
 * builtins < user < project and returns per-layer values, effective
 * resolution, provenance, validation errors with field paths, and source
 * hashes for optimistic concurrency.
 */
/**
 * Read one layer tolerantly for the editable view (P1 read contract).
 *
 * Unlike `loadLayerFile` — which throws `load-failed` for schema-invalid or
 * unreadable files so mutations fail closed — the read path must still
 * return a structured `EditableProfileView` (with hashes when the bytes are
 * readable, plus validation issues/field paths) so the UI can render a
 * broken hand-edited config instead of receiving only `{ok:false,error}`.
 */
async function loadLayerTolerant(
  filePath: string,
  fs: MutationFs,
): Promise<
  | { ok: true; layer: LoadedLayer }
  | { ok: false; path: string; exists: boolean; hash?: string; error: ProfileMutationError }
> {
  try {
    return { ok: true, layer: await loadLayerFile(filePath, fs) };
  } catch (error) {
    if (!(error instanceof ProfileMutationError) || error.code !== "load-failed") throw error;
    // Preserve the source hash for the invalid view when the bytes stay
    // readable (schema-invalid case); otherwise surface existence without one.
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return { ok: false, path: filePath, exists: true, hash: hashSourceText(raw), error };
    } catch {
      return { ok: false, path: filePath, exists: true, hash: undefined, error };
    }
  }
}

export async function readEditableProfile(
  name: string,
  options: MutationWriteOptions = {},
): Promise<EditableProfileView> {
  assertValidProfileName(name);
  const paths = resolveMutationPaths(options);
  const fs = await resolveFs(options.fs);
  const builtinDoc = getBuiltinProfilesDocument();
  const [userRes, projectRes] = await Promise.all([
    loadLayerTolerant(paths.userPath, fs),
    loadLayerTolerant(paths.projectPath, fs),
  ]);
  const userLayer = userRes.ok ? userRes.layer : undefined;
  const projectLayer = projectRes.ok ? projectRes.layer : undefined;
  const layerFailures = [userRes, projectRes].filter((r) => !r.ok) as Array<
    Extract<Awaited<ReturnType<typeof loadLayerTolerant>>, { ok: false }>
  >;
  const layerHashes: { user?: string; project?: string } = {
    ...(userRes.ok
      ? userRes.layer.hash !== undefined
        ? { user: userRes.layer.hash }
        : {}
      : userRes.hash !== undefined
        ? { user: userRes.hash }
        : {}),
    ...(projectRes.ok
      ? projectRes.layer.hash !== undefined
        ? { project: projectRes.layer.hash }
        : {}
      : projectRes.hash !== undefined
        ? { project: projectRes.hash }
        : {}),
  };
  if (layerFailures.length > 0) {
    // At least one on-disk layer is schema-invalid or unreadable: build the
    // view from the remaining valid layers (builtins + whichever layer
    // parsed) and report the load failure as structured invalid view data —
    // hashes, per-layer existence, and field-path issues included — instead
    // of throwing, so hand-edited breakage stays renderable.
    const mergeDocs: ValidatedProfilesDocument[] = [builtinDoc];
    if (userLayer !== undefined && Object.keys(userLayer.doc.profiles).length > 0) {
      mergeDocs.push(userLayer.doc);
    }
    if (projectLayer !== undefined && Object.keys(projectLayer.doc.profiles).length > 0) {
      mergeDocs.push(projectLayer.doc);
    }
    const mergedDoc = mergeValidatedDocuments(mergeDocs);
    const issues = layerFailures.flatMap((f) => f.error.issues ?? []);
    const view = buildEditableView(
      name,
      {
        mergedDoc,
        builtinDoc,
        ...(userLayer !== undefined && Object.keys(userLayer.doc.profiles).length > 0
          ? { userDoc: userLayer.doc }
          : {}),
        ...(projectLayer !== undefined && Object.keys(projectLayer.doc.profiles).length > 0
          ? { projectDoc: projectLayer.doc }
          : {}),
        userPath: paths.userPath,
        projectPath: paths.projectPath,
        userExists: userRes.ok
          ? userRes.layer.exists && Object.keys(userRes.layer.doc.profiles).length > 0
          : userRes.exists,
        projectExists: projectRes.ok
          ? projectRes.layer.exists && Object.keys(projectRes.layer.doc.profiles).length > 0
          : projectRes.exists,
      },
      layerHashes,
    );
    view.validation = {
      ok: false,
      error: layerFailures.map((f) => f.error.message).join("\n"),
      code: "load-failed",
      ...(issues.length > 0 ? { issues } : {}),
    };
    return view;
  }
  if (!userRes.ok || !projectRes.ok) {
    // Narrowed above: any failure returns early, so both layers are loaded.
    throw new Error("unreachable: invalid layers return early");
  }
  const userLayerOk = userRes.layer;
  const projectLayerOk = projectRes.layer;
  const docs: ValidatedProfilesDocument[] = [builtinDoc];
  if (userLayerOk.exists) docs.push(userLayerOk.doc);
  // Empty-but-existing layers contribute nothing (no overrides).
  if (Object.keys(userLayerOk.doc.profiles).length === 0 && userLayerOk.exists) {
    docs.pop();
  }
  if (projectLayerOk.exists && Object.keys(projectLayerOk.doc.profiles).length > 0) {
    docs.push(projectLayerOk.doc);
  } else if (!userLayerOk.exists && projectLayerOk.exists && Object.keys(projectLayerOk.doc.profiles).length === 0) {
    // No-op: empty layer contributes nothing.
  }
  // Rebuild merge correctly: builtins + non-empty existing layers.
  const mergeDocsOk: ValidatedProfilesDocument[] = [builtinDoc];
  if (userLayerOk.exists && Object.keys(userLayerOk.doc.profiles).length > 0) mergeDocsOk.push(userLayerOk.doc);
  else if (!userLayerOk.exists) {
    // Missing layer contributes nothing.
  }
  if (projectLayerOk.exists && Object.keys(projectLayerOk.doc.profiles).length > 0) mergeDocsOk.push(projectLayerOk.doc);
  const mergedDoc = mergeValidatedDocuments(mergeDocsOk);
  void docs;
  return buildEditableView(
    name,
    {
      mergedDoc,
      builtinDoc,
      ...(Object.keys(userLayerOk.doc.profiles).length > 0 ? { userDoc: userLayerOk.doc } : {}),
      ...(Object.keys(projectLayerOk.doc.profiles).length > 0 ? { projectDoc: projectLayerOk.doc } : {}),
      userPath: paths.userPath,
      projectPath: paths.projectPath,
      userExists: userLayerOk.exists && Object.keys(userLayerOk.doc.profiles).length > 0,
      projectExists: projectLayerOk.exists && Object.keys(projectLayerOk.doc.profiles).length > 0,
    },
    {
      ...(userLayerOk.hash !== undefined ? { user: userLayerOk.hash } : {}),
      ...(projectLayerOk.hash !== undefined ? { project: projectLayerOk.hash } : {}),
    },
  );
}

// ---------------------------------------------------------------------------
// Pure layer appliers (no I/O, no validation — validation happens transactionally).
// ---------------------------------------------------------------------------

function ensureTargetEntry(
  target: ValidatedProfilesDocument,
  name: string,
): ValidatedPiProfile {
  const existing = Object.hasOwn(target.profiles, name) ? target.profiles[name] : undefined;
  if (existing) return existing;
  const entry: ValidatedPiProfile = {};
  target.profiles[name] = entry;
  return entry;
}

function clearOppositePrompt(entry: ValidatedPiProfile, setField: string): void {
  if (setField === "systemPrompt") {
    delete entry.systemPromptFile;
  } else if (setField === "systemPromptFile") {
    delete entry.systemPrompt;
  }
}

function applyCreatePure(
  target: ValidatedProfilesDocument,
  name: string,
  initial: Record<string, unknown> | undefined,
  targetLabel: string,
): void {
  const entry = ensureTargetEntry(target, name);
  if (!isEmptyLayerEntry(entry)) {
    throw new ProfileMutationError({
      code: "already-exists",
      profileName: name,
      message: `Profile "${name}" already exists in ${targetLabel}; pick another name or patch the existing profile.`,
    });
  }
  if (initial) {
    for (const [key, value] of Object.entries(initial)) {
      if (value === undefined) continue;
      (entry as Record<string, unknown>)[key] = Array.isArray(value) ? [...(value as unknown[])] : value;
    }
    if (initial.systemPrompt !== undefined) clearOppositePrompt(entry, "systemPrompt");
    else if (initial.systemPromptFile !== undefined) clearOppositePrompt(entry, "systemPromptFile");
  }
  entry.sourceLabel = targetLabel;
}

function applySetPure(
  target: ValidatedProfilesDocument,
  name: string,
  field: string,
  value: unknown,
  targetLabel: string,
): void {
  const entry = ensureTargetEntry(target, name);
  (entry as Record<string, unknown>)[field] = Array.isArray(value) ? [...(value as unknown[])] : value;
  clearOppositePrompt(entry, field);
  entry.sourceLabel = targetLabel;
}

function applyUnsetPure(
  target: ValidatedProfilesDocument,
  name: string,
  field: string,
): boolean {
  const entry = Object.hasOwn(target.profiles, name) ? target.profiles[name] : undefined;
  if (!entry || (entry as Record<string, unknown>)[field] === undefined) return false;
  delete (entry as Record<string, unknown>)[field];
  if (isEmptyLayerEntry(entry)) {
    delete target.profiles[name];
  }
  return true;
}

function applyPatchPure(
  target: ValidatedProfilesDocument,
  name: string,
  patch: Record<string, unknown>,
  targetLabel: string,
): void {
  const entry = ensureTargetEntry(target, name);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) {
      delete (entry as Record<string, unknown>)[key];
      continue;
    }
    (entry as Record<string, unknown>)[key] = Array.isArray(value) ? [...(value as unknown[])] : value;
    if (key === "systemPrompt" || key === "systemPromptFile") {
      // When patch sets one prompt field (non-null), clear the opposite in
      // the same layer entry to preserve mutual exclusivity.
      clearOppositePrompt(entry, key);
    }
  }
  if (isEmptyLayerEntry(entry)) {
    delete target.profiles[name];
    return;
  }
  entry.sourceLabel = targetLabel;
}

// ---------------------------------------------------------------------------
// Transaction core.
// ---------------------------------------------------------------------------

interface TransactionInput {
  action: MutationAction;
  profileName: string;
  sourceName?: string;
  field?: string;
  value?: unknown;
  patch?: Record<string, unknown>;
  initial?: Record<string, unknown>;
  scope: MutationScope;
}

async function runMutationTransaction(
  input: TransactionInput,
  options: MutationWriteOptions,
): Promise<ProfileMutationReceipt> {
  assertValidScope(input.scope);
  assertValidProfileName(input.profileName, input.action === "clone" ? "destination profile" : "profile");
  if (input.sourceName !== undefined) assertValidProfileName(input.sourceName, "source profile");
  if (input.field !== undefined) assertValidField(input.field);

  const paths = resolveMutationPaths(options);
  const targetPath = targetPathForScope(input.scope, paths);
  const fs = await resolveFs(options.fs);
  const builtinDoc = getBuiltinProfilesDocument();

  // Serialize the whole read → validate → commit path under the mutation
  // lock (P1: two writers loading the same hash must not both commit).
  // The `expectedSourceHash` comparison below runs against freshly loaded
  // state inside the lock, so a loser always sees the winner's commit.
  // P1 (cross-scope graph validation): every transaction loads BOTH layers
  // and validates the merged user+project graph, so user- and project-scope
  // mutations must serialize on BOTH locks. With one lock per target file, a
  // user write and a project write run concurrently, validate stale opposite
  // layers, and commit a graph neither validated (e.g. a cross-layer
  // extends cycle). Acquire both in deterministic path order (deadlock-free
  // since every transaction uses the same order; single acquisition when
  // both scopes resolve to the same file).
  // P2 (absent opposite store): probe opposite-file presence BEFORE locking.
  // When the opposite config file is absent we must not materialize lock
  // metadata next to it — coordinate through a shared pair lock under the
  // OS temp dir instead (keyed by the canonical layer pair).
  const oppositePath = input.scope === "user" ? paths.projectPath : paths.userPath;
  let oppositeExists = true;
  try {
    await fs.readFile(oppositePath, "utf8");
  } catch (error) {
    if (isEnoent(error)) oppositeExists = false;
  }
  const userHold = { dir: `${paths.userPath}.lock.d`, content: undefined as string | undefined };
  const projectHold = { dir: `${paths.projectPath}.lock.d`, content: undefined as string | undefined };
  // The target scope always requires its lock (throw on failure); the
  // opposite scope uses `ifUnavailable: "skip"` so a scoped mutation does
  // not need write access to the opposite config store (P1: read-only
  // checkout). Skipping stays safe: an unwritable opposite store cannot
  // accept conflicting service commits through that layer, the target lock
  // still serializes same-scope writers, and both layers are revalidated
  // immediately before commit while the target lock is held.
  const acquireBoth = async (
    fn: () => Promise<ProfileMutationReceipt>,
  ): Promise<ProfileMutationReceipt> => {
    const targetHold = input.scope === "user" ? userHold : projectHold;
    const oppositeHold = input.scope === "user" ? projectHold : userHold;
    if (paths.userPath === paths.projectPath) {
      return await withMutationLock(targetPath, fs, async (only) => {
        targetHold.content = only ?? undefined;
        return await fn();
      });
    }
    const pairPath = pairLockPath(paths.userPath, paths.projectPath);
    const oppositeLockPath = oppositeExists ? oppositePath : pairPath;
    const oppositeOpts: MutationLockOptions = oppositeExists ? { ifUnavailable: "skip" } : {};
    if (!oppositeExists) oppositeHold.dir = `${pairPath}.lock.d`;
    // Deterministic path order across all transactions: deadlock-free.
    const firstIsTarget = targetPath < oppositeLockPath;
    if (firstIsTarget) {
      return await withMutationLock(targetPath, fs, async (first) => {
        targetHold.content = first ?? undefined;
        return await withMutationLock(oppositeLockPath, fs, async (second) => {
          oppositeHold.content = second ?? undefined;
          return await fn();
        }, oppositeOpts);
      });
    }
    return await withMutationLock(oppositeLockPath, fs, async (first) => {
      oppositeHold.content = first ?? undefined;
      return await withMutationLock(targetPath, fs, async (second) => {
        targetHold.content = second ?? undefined;
        return await fn();
      });
    }, oppositeOpts);
  };
  return await acquireBoth(async () => {
  const userLockContent = userHold.content;
  const projectLockContent = projectHold.content;
  const [userLayer, projectLayer] = await Promise.all([
    loadLayerFile(paths.userPath, fs),
    loadLayerFile(paths.projectPath, fs),
  ]);

  const targetLayer = input.scope === "user" ? userLayer : projectLayer;

  // Caller-side optimistic concurrency: compare expected version to the
  // version observed at load time before doing any work. `null` asserts the
  // target file is still absent; a `string` asserts it still exists with
  // exactly that hash. Both are compared inside the lock against freshly
  // loaded state, so a loser always sees the winner's commit.
  if (options.expectedSourceHash !== undefined) {
    if (options.expectedSourceHash === null) {
      if (targetLayer.exists) {
        throw new ProfileMutationError({
          code: "conflict",
          profileName: input.profileName,
          scope: input.scope,
          sourceLabel: targetPath,
          message:
            `Stale write for profile "${input.profileName}" in ${input.scope} config (${targetPath}): expected no file (read while absent) ` +
            `but found source hash ${targetLayer.hash!.slice(0, 12)}…. Reload and retry. No data was overwritten.`,
        });
      }
    } else {
      const current = targetLayer.hash;
      if (current !== options.expectedSourceHash) {
        throw new ProfileMutationError({
          code: "conflict",
          profileName: input.profileName,
          scope: input.scope,
          sourceLabel: targetPath,
          message:
            `Stale write for profile "${input.profileName}" in ${input.scope} config (${targetPath}): expected source hash ${options.expectedSourceHash.slice(0, 12)}… ` +
            `but found ${current ? `${current.slice(0, 12)}…` : "no file"}. Reload and retry. No data was overwritten.`,
        });
      }
    }
  }

  // Effective view before mutation (builtins < user < project).
  const preMergeDocs: ValidatedProfilesDocument[] = [builtinDoc];
  if (Object.keys(userLayer.doc.profiles).length > 0) preMergeDocs.push(userLayer.doc);
  if (Object.keys(projectLayer.doc.profiles).length > 0) preMergeDocs.push(projectLayer.doc);
  const preMerged = mergeValidatedDocuments(preMergeDocs);
  const existsEffective = (candidate: string): boolean => Object.hasOwn(preMerged.profiles, candidate);

  // Per-action preconditions against the effective view (not just the target
  // layer) so shadowing and cross-layer deletes are explicit.
  if (input.action === "create") {
    if (existsEffective(input.profileName)) {
      const builtinHint = isBuiltinProfileName(input.profileName)
        ? ` "${input.profileName}" is a built-in profile and cannot be created; override individual fields with profile set/patch --scope ${input.scope} instead.`
        : "";
      throw new ProfileMutationError({
        code: "already-exists",
        profileName: input.profileName,
        scope: input.scope,
        message: `Profile "${input.profileName}" already exists; pick another name or patch the existing profile.${builtinHint}`,
      });
    }
  } else if (input.action === "clone") {
    const source = input.sourceName!;
    if (!existsEffective(source)) {
      throw new ProfileMutationError({
        code: "not-found",
        profileName: source,
        scope: input.scope,
        message: `Cannot clone unknown profile "${source}".`,
      });
    }
    if (existsEffective(input.profileName)) {
      throw new ProfileMutationError({
        code: "already-exists",
        profileName: input.profileName,
        scope: input.scope,
        message: `Cannot clone to "${input.profileName}": a profile with that name already exists. Pick another name or delete the existing ${input.scope} override first.`,
      });
    }
  } else if (input.action === "set" || input.action === "patch") {
    if (!existsEffective(input.profileName)) {
      throw new ProfileMutationError({
        code: "not-found",
        profileName: input.profileName,
        scope: input.scope,
        message: `Unknown Pi profile "${input.profileName}": create it first (orca-pi profile create ${input.profileName} --scope ${input.scope}).`,
      });
    }
  } else if (input.action === "unset" || input.action === "delete") {
    const hasInTarget = Object.hasOwn(targetLayer.doc.profiles, input.profileName);
    if (!hasInTarget) {
      if (input.action === "delete" && isBuiltinProfileName(input.profileName) && existsEffective(input.profileName)) {
        throw new ProfileMutationError({
          code: "builtin-immutable",
          profileName: input.profileName,
          scope: input.scope,
          message: `Built-in profile "${input.profileName}" cannot be deleted; remove its ${input.scope} override instead (no ${input.scope} override exists for "${input.profileName}" in ${targetPath}).`,
        });
      }
      const otherScope = input.scope === "user" ? "project" : "user";
      const hasElsewhere = existsEffective(input.profileName);
      const hint = hasElsewhere
        ? ` "${input.profileName}" exists outside ${input.scope} scope — re-run with --scope ${otherScope} to affect that layer, or create a ${input.scope} override first. Destructive targets are never inferred.`
        : "";
      throw new ProfileMutationError({
        code: "not-found",
        profileName: input.profileName,
        scope: input.scope,
        message:
          input.action === "delete"
            ? `No ${input.scope} profile "${input.profileName}" in ${targetPath}.${hint}`
            : `No ${input.scope} field "${input.field}" on profile "${input.profileName}" in ${targetPath}.${hint}`,
      });
    }
    if (input.action === "unset") {
      const entry = targetLayer.doc.profiles[input.profileName]!;
      if ((entry as Record<string, unknown>)[input.field!] === undefined) {
        throw new ProfileMutationError({
          code: "not-found",
          profileName: input.profileName,
          scope: input.scope,
          message: `No ${input.scope} field "${input.field}" on profile "${input.profileName}" in ${targetPath}. Nothing to unset.`,
        });
      }
    }
  }

  // Apply to an isolated copy; the originals stay untouched on failure.
  const mutatedTarget = cloneLayerDocument(targetLayer.doc);
  mutatedTarget.sourceLabel = targetPath;

  if (input.action === "create") {
    applyCreatePure(mutatedTarget, input.profileName, input.initial, targetPath);
  } else if (input.action === "clone") {
    const sourceEntry = preMerged.profiles[input.sourceName!];
    if (!sourceEntry) {
      throw new ProfileMutationError({
        code: "not-found",
        profileName: input.sourceName,
        scope: input.scope,
        message: `Cannot clone unknown profile "${input.sourceName}".`,
      });
    }
    const { sourceLabel: _ignored, ...copied } = sourceEntry;
    void _ignored;
    const dest: ValidatedPiProfile = {};
    for (const [key, value] of Object.entries(copied)) {
      (dest as Record<string, unknown>)[key] = Array.isArray(value) ? [...(value as unknown[])] : value;
    }
    // Merge caller-supplied initial overrides (e.g. displayName) on top.
    if (input.initial) {
      for (const [key, value] of Object.entries(input.initial)) {
        if (value === undefined) continue;
        (dest as Record<string, unknown>)[key] = Array.isArray(value) ? [...(value as unknown[])] : value;
      }
    }
    mutatedTarget.profiles[input.profileName] = { ...dest, sourceLabel: targetPath };
  } else if (input.action === "set") {
    const hasInTarget = Object.hasOwn(mutatedTarget.profiles, input.profileName);
    if (!hasInTarget) {
      // Delta override: only the changed field lands in the target layer so
      // user-vs-project precedence stays clean (no full copy of builtins).
      mutatedTarget.profiles[input.profileName] = { sourceLabel: targetPath };
    }
    applySetPure(mutatedTarget, input.profileName, input.field!, input.value, targetPath);
  } else if (input.action === "unset") {
     
    applyUnsetPure(mutatedTarget, input.profileName, input.field!);
     
  } else if (input.action === "patch") {
    const hasInTarget = Object.hasOwn(mutatedTarget.profiles, input.profileName);
    if (!hasInTarget) {
      mutatedTarget.profiles[input.profileName] = { sourceLabel: targetPath };
    }
    applyPatchPure(mutatedTarget, input.profileName, input.patch!, targetPath);
    // Patch that empties the entry removes it (delta cleanup).
    if (!Object.hasOwn(mutatedTarget.profiles, input.profileName)) {
      // Entry removed — falls through to delete-empty handling below.
    }
  } else if (input.action === "delete") {
    delete mutatedTarget.profiles[input.profileName];
  }

  // Schema-validate the mutated source document (when non-empty). An emptied
  // layer is valid as "no overrides" and is unlinked below instead of
  // written as an invalid `profiles: {}` file.
  let validatedTarget: ValidatedProfilesDocument | undefined;
  const mutatedCount = Object.keys(mutatedTarget.profiles).length;
  if (mutatedCount > 0) {
    try {
      validatedTarget = validateProfilesDocument(toFilePayload(mutatedTarget), targetPath);
    } catch (error) {
      if (error instanceof ProfileValidationError) {
        throw new ProfileMutationError({
          code: "validation-failed",
          profileName: input.profileName,
          scope: input.scope,
          issues: error.issues,
          sourceLabel: targetPath,
          message: `Invalid profile mutation for "${input.profileName}" in ${targetPath} (${error.issues.length} issue${error.issues.length === 1 ? "" : "s"}):\n${error.issues.map((issue) => `  - ${issue.path}: ${issue.message}`).join("\n")}\nOriginal document left unchanged.`,
          cause: error,
        });
      }
      throw error;
    }
  }

  // Merge + resolve inheritance/effective profile + validate effective config.
  const postUserDoc =
    input.scope === "user"
      ? validatedTarget ?? emptyLayerDocument(paths.userPath)
      : userLayer.doc;
  const postProjectDoc =
    input.scope === "project"
      ? validatedTarget ?? emptyLayerDocument(paths.projectPath)
      : projectLayer.doc;
  const postMergeDocs: ValidatedProfilesDocument[] = [builtinDoc];
  if (Object.keys(postUserDoc.profiles).length > 0) postMergeDocs.push(postUserDoc);
  if (Object.keys(postProjectDoc.profiles).length > 0) postMergeDocs.push(postProjectDoc);
  const postMerged = mergeValidatedDocuments(postMergeDocs);

  let resolved: ResolvedPiProfile | undefined;
  let provenance: Record<string, MutationFieldProvenance> | undefined;
  let extendsChain: readonly string[] | undefined;
  // Patch/unset that removed the last delta for a builtin-only name still
  // leaves the builtin — not a deletion. Only a delete of the final layer
  // entry for a non-builtin removes the profile entirely.
  const stillExists = Object.hasOwn(postMerged.profiles, input.profileName);
  const fullyDeleted =
    !stillExists &&
    (input.action === "delete" || input.action === "unset" || input.action === "patch");

  // P1 (descendant invalidation): validate the ENTIRE post-merge graph, not
  // just the touched profile. A parent edit/delete can orphan or invalidate
  // descendants (unknown parents, cycles, inherited reviewer write tools),
  // so every write must leave the resulting effective configuration fully
  // valid. Fail-closed: a commit that would leave any profile unresolvable
  // is rejected with the original document unchanged.
  let allResolved: Readonly<Record<string, ResolvedPiProfile>>;
  try {
    allResolved = resolveAllProfiles(postMerged);
  } catch (error) {
    if (error instanceof ProfileResolveError) {
      throw new ProfileMutationError({
        code: "resolve-failed",
        profileName: input.profileName,
        scope: input.scope,
        sourceLabel: targetPath,
        message:
          `Resulting profile graph is invalid after mutating "${input.profileName}" in ${targetPath}: ${error.message} ` +
          `Every write must leave all profiles resolvable (a parent edit/delete must not orphan descendants). Original document left unchanged.`,
        cause: error,
      });
    }
    if (error instanceof ProfileValidationError) {
      throw new ProfileMutationError({
        code: "validation-failed",
        profileName: input.profileName,
        scope: input.scope,
        issues: error.issues,
        sourceLabel: targetPath,
        message: `Resulting profile "${input.profileName}" is invalid:\n${error.issues.map((issue) => `  - ${issue.path}: ${issue.message}`).join("\n")}\nOriginal document left unchanged.`,
        cause: error,
      });
    }
    throw error;
  }

  if (!fullyDeleted) {
    resolved = allResolved[input.profileName];
    if (resolved === undefined) {
      throw new ProfileMutationError({
        code: "resolve-failed",
        profileName: input.profileName,
        scope: input.scope,
        sourceLabel: targetPath,
        message: `Resulting profile "${input.profileName}" vanished from the merged graph after mutation. Original document left unchanged.`,
      });
    }
    const layerContext = {
      mergedDoc: postMerged,
      builtinDoc,
      ...(Object.keys(postUserDoc.profiles).length > 0 ? { userDoc: postUserDoc } : {}),
      ...(Object.keys(postProjectDoc.profiles).length > 0 ? { projectDoc: postProjectDoc } : {}),
      userPath: paths.userPath,
      projectPath: paths.projectPath,
    };
    extendsChain = resolved.extendsChain;
    provenance = buildProvenanceMap(input.profileName, resolved.extendsChain, layerContext);
  } else if (input.action === "delete") {
    // Fully deleted custom profile — no resolved value remains.
    resolved = undefined;
  } else {
    // Unset/patch removed the last delta but the merged profile still
    // resolves via another layer/builtin — resolve above already handled it.
    // This branch is unreachable; kept for exhaustiveness.
  }

  // Compromise detection: verify we still hold BOTH scope locks before
  // committing (fail-closed). Same-process overlap is already excluded by
  // the in-process mutexes; with bakery candidates no compliant participant
  // ever deletes another's file, so losing holdership means a foreign writer
  // interfered — abort instead of committing a stale read.
  if (userLockContent !== undefined) {
    await assertStillHolder(fs, userHold.dir, userLockContent, input.profileName, input.scope, targetPath);
  }
  if (projectLockContent !== undefined) {
    await assertStillHolder(fs, projectHold.dir, projectLockContent, input.profileName, input.scope, targetPath);
  }

  // Stale-write guards immediately before commit (P1: both layers). The
  // merged-graph validation above depends on BOTH source files, and those
  // files stay authoritative (editors, scripts, older CLIs bypass the lock),
  // so re-check existence+hash for the target layer AND the opposite layer
  // while both locks are held. Either changing fails with `conflict` instead
  // of committing a graph that was never validated.
  const otherLayer = input.scope === "user" ? projectLayer : userLayer;
  const otherPath = input.scope === "user" ? paths.projectPath : paths.userPath;
  await assertNoConcurrentChange(otherPath, otherLayer.hash, otherLayer.exists, fs, input.profileName, input.scope);
  await assertNoConcurrentChange(targetPath, targetLayer.hash, targetLayer.exists, fs, input.profileName, input.scope);

  const existedBefore = targetLayer.exists;
  let existsAfter = true;
  let sourceHashAfter: string | undefined;

  if (validatedTarget === undefined) {
    // Emptied layer → remove the file so future loads see "no overrides"
    // instead of an invalid empty document.
    if (existedBefore) {
      await removeTargetFile(targetPath, fs);
    }
    existsAfter = false;
    sourceHashAfter = undefined;
  } else {
    const nextText = serializeProfilesDocument(validatedTarget);
    await atomicWriteText(targetPath, nextText, fs);
    sourceHashAfter = hashSourceText(nextText);
    existsAfter = true;
  }

  return {
    action: input.action,
    profileName: input.profileName,
    ...(input.sourceName !== undefined ? { sourceName: input.sourceName } : {}),
    scope: input.scope,
    path: targetPath,
    existedBefore,
    existsAfter,
    ...(targetLayer.hash !== undefined ? { sourceHashBefore: targetLayer.hash } : {}),
    ...(sourceHashAfter !== undefined ? { sourceHashAfter } : {}),
    deleted: fullyDeleted && input.action === "delete",
    ...(resolved !== undefined ? { resolved } : {}),
    ...(extendsChain !== undefined ? { extendsChain } : {}),
    ...(provenance !== undefined ? { provenance } : {}),
    ...(validatedTarget !== undefined ? { sourceLabel: targetPath } : {}),
  };
  });
}

// ---------------------------------------------------------------------------
// Typed convenience operations (one generic transaction underneath).
// ---------------------------------------------------------------------------

export interface CreateProfileInput {
  name: string;
  scope: MutationScope;
  initial?: Record<string, unknown>;
  expectedSourceHash?: string | null;
}

export async function createProfile(
  input: CreateProfileInput,
  options: MutationWriteOptions = {},
): Promise<ProfileMutationReceipt> {
  if (input.initial) {
    for (const key of Object.keys(input.initial)) assertValidField(key);
  }
  return await runMutationTransaction(
    {
      action: "create",
      profileName: input.name,
      scope: input.scope,
      ...(input.initial ? { initial: input.initial } : {}),
    },
    { ...options, ...(input.expectedSourceHash !== undefined ? { expectedSourceHash: input.expectedSourceHash } : {}) },
  );
}

export interface CloneProfileInput {
  source: string;
  dest: string;
  scope: MutationScope;
  initial?: Record<string, unknown>;
  expectedSourceHash?: string | null;
}

export async function cloneProfile(
  input: CloneProfileInput,
  options: MutationWriteOptions = {},
): Promise<ProfileMutationReceipt> {
  if (input.initial) {
    for (const key of Object.keys(input.initial)) assertValidField(key);
  }
  return await runMutationTransaction(
    {
      action: "clone",
      profileName: input.dest,
      sourceName: input.source,
      scope: input.scope,
      ...(input.initial ? { initial: input.initial } : {}),
    },
    { ...options, ...(input.expectedSourceHash !== undefined ? { expectedSourceHash: input.expectedSourceHash } : {}) },
  );
}

export interface PatchProfileInput {
  name: string;
  scope: MutationScope;
  patch: Record<string, unknown>;
  expectedSourceHash?: string | null;
}

export async function patchProfile(
  input: PatchProfileInput,
  options: MutationWriteOptions = {},
): Promise<ProfileMutationReceipt> {
  if (!input.patch || typeof input.patch !== "object" || Array.isArray(input.patch)) {
    throw new ProfileMutationError({
      code: "invalid-value",
      profileName: input.name,
      scope: input.scope,
      message: `Invalid patch for profile "${input.name}": expected an object of field → value (use null to delete a field), got ${JSON.stringify(input.patch)}.`,
    });
  }
  if (Object.keys(input.patch).length === 0) {
    throw new ProfileMutationError({
      code: "invalid-value",
      profileName: input.name,
      scope: input.scope,
      message: `Empty patch for profile "${input.name}": provide at least one field to change (e.g. {"model": "openai/gpt-5.6"}).`,
    });
  }
  for (const key of Object.keys(input.patch)) assertValidField(key);
  return await runMutationTransaction(
    { action: "patch", profileName: input.name, scope: input.scope, patch: input.patch },
    { ...options, ...(input.expectedSourceHash !== undefined ? { expectedSourceHash: input.expectedSourceHash } : {}) },
  );
}

export interface SetFieldInput {
  name: string;
  scope: MutationScope;
  field: string;
  value: unknown;
  expectedSourceHash?: string | null;
}

export async function setProfileField(
  input: SetFieldInput,
  options: MutationWriteOptions = {},
): Promise<ProfileMutationReceipt> {
  assertValidField(input.field);
  if (input.value === undefined) {
    throw new ProfileMutationError({
      code: "invalid-value",
      profileName: input.name,
      scope: input.scope,
      message: `Invalid value for field "${input.field}" on profile "${input.name}": value is required (use unset to delete a field).`,
    });
  }
  return await runMutationTransaction(
    { action: "set", profileName: input.name, scope: input.scope, field: input.field, value: input.value },
    { ...options, ...(input.expectedSourceHash !== undefined ? { expectedSourceHash: input.expectedSourceHash } : {}) },
  );
}

export interface UnsetFieldInput {
  name: string;
  scope: MutationScope;
  field: string;
  expectedSourceHash?: string | null;
}

export async function unsetProfileField(
  input: UnsetFieldInput,
  options: MutationWriteOptions = {},
): Promise<ProfileMutationReceipt> {
  assertValidField(input.field);
  return await runMutationTransaction(
    { action: "unset", profileName: input.name, scope: input.scope, field: input.field },
    { ...options, ...(input.expectedSourceHash !== undefined ? { expectedSourceHash: input.expectedSourceHash } : {}) },
  );
}

export interface DeleteProfileInput {
  name: string;
  scope: MutationScope;
  expectedSourceHash?: string | null;
}

export async function deleteProfile(
  input: DeleteProfileInput,
  options: MutationWriteOptions = {},
): Promise<ProfileMutationReceipt> {
  return await runMutationTransaction(
    { action: "delete", profileName: input.name, scope: input.scope },
    { ...options, ...(input.expectedSourceHash !== undefined ? { expectedSourceHash: input.expectedSourceHash } : {}) },
  );
}

/**
 * Parse raw YAML text for dry-run/preview flows without touching disk.
 * Shared with tests that assert layering without filesystem I/O.
 */
export function parseLayerForTest(text: string, sourceLabel: string): ValidatedProfilesDocument {
  return parseAndValidateProfilesText(text, sourceLabel);
}

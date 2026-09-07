/**
 * `orca-pi profile` mutation commands (UI1.1).
 *
 * JSON-first machine surface over the authoritative mutation service
 * (`@orca-pi/core` `profile/mutate.ts`). The CLI never implements its own
 * YAML writer — every write goes through `createProfile`/`cloneProfile`/
 * `patchProfile`/`setProfileField`/`unsetProfileField`/`deleteProfile`, so
 * UI and CLI observe the same effective configuration.
 *
 * Commands:
 *   orca-pi profile create <name> --scope <user|project> [--extends <parent>]
 *     [--data <json|@file>] [--expected-hash <hash>] [--json]
 *   orca-pi profile clone <source> <dest> --scope <user|project> [--json]
 *   orca-pi profile set <name> <field> <value> --scope <user|project> [--json]
 *   orca-pi profile unset <name> <field> --scope <user|project> [--json]
 *   orca-pi profile delete <name> --scope <user|project> [--json]
 *   orca-pi profile patch <name> --scope <user|project>
 *     (--patch <json|@file> | --data <json|@file> | --json <json|@file>) [--json]
 *   orca-pi profile read <name> [--json]
 *
 * `--scope` is always required for writes; destructive targets are never
 * inferred. `--json` selects the machine-readable receipt; human output is
 * a one-line summary. `--expected-hash` enables optimistic concurrency
 * (stale writes fail with `conflict` instead of overwriting).
 *
 * This module never builds Pi argv (JEF-7 owns the launch compiler).
 */

import {
  MUTABLE_PROFILE_FIELDS,
  ProfileMutationError,
  cloneProfile,
  createProfile,
  deleteProfile,
  patchProfile,
  readEditableProfile,
  setProfileField,
  unsetProfileField,
  type MutationScope,
  type ProfileMutationReceipt,
} from "@orca-pi/core";

export interface MutationCommandDeps {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  projectRoot: string;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  osHomedir?: () => string;
  fs?: Pick<typeof import("node:fs/promises"), "readFile" | "stat"> & Partial<
    Pick<typeof import("node:fs/promises"), "writeFile" | "rename" | "mkdir" | "unlink">
  >;
  userConfigPathOverride?: string;
  projectConfigPathOverride?: string;
}

export interface MutationCommandResult {
  exitCode: number;
}

function isHelpFlag(arg: string): boolean {
  return arg === "--help" || arg === "-h" || arg === "help";
}

type ParsedScopeOptions = {
  scope?: string;
  asJson: boolean;
  jsonPayload?: string;
  patchPayload?: string;
  dataPayload?: string;
  extendsParent?: string;
  expectedHash?: string;
  expectedAbsent?: boolean;
  userConfig?: string;
  projectConfig?: string;
  projectRoot?: string;
  positionals: string[];
  unknown: string[];
  help: boolean;
};

function takeFlagValue(
  args: readonly string[],
  index: number,
  flag: string,
): { value?: string; consumed: number; error?: string } {
  const current = args[index] as string;
  const eq = `${flag}=`;
  if (current.startsWith(eq)) {
    const value = current.slice(eq.length);
    if (!value) return { consumed: 1, error: `${flag} requires a value` };
    return { value, consumed: 1 };
  }
  const next = args[index + 1];
  if (next === undefined || next.startsWith("-")) {
    return { consumed: 1, error: `${flag} requires a value` };
  }
  return { value: next, consumed: 2 };
}

function parseMutationArgs(args: readonly string[]): ParsedScopeOptions {
  const out: ParsedScopeOptions = {
    asJson: false,
    positionals: [],
    unknown: [],
    help: false,
  };
  for (let index = 0; index < args.length;) {
    const arg = args[index] as string;
    if (arg === "--json") {
      // `--json <payload>` is accepted as a patch/data alias (issue's
      // suggested `patch --json @patch.json` shape); bare `--json` is the
      // machine-output flag. Peek: payload when next looks like JSON/@file.
      const next = args[index + 1];
      if (
        next !== undefined &&
        (next.startsWith("{") ||
          next.startsWith("[") ||
          next.startsWith("@") ||
          next.endsWith(".json"))
      ) {
        out.jsonPayload = next;
        out.asJson = true;
        index += 2;
      } else {
        out.asJson = true;
        index += 1;
      }
    } else if (arg === "--scope" || arg.startsWith("--scope=")) {
      const taken = takeFlagValue(args, index, "--scope");
      if (taken.error) {
        out.unknown.push(taken.error);
        index += taken.consumed;
      } else {
        out.scope = taken.value;
        index += taken.consumed;
      }
    } else if (arg === "--extends" || arg.startsWith("--extends=")) {
      const taken = takeFlagValue(args, index, "--extends");
      if (taken.error) {
        out.unknown.push(taken.error);
        index += taken.consumed;
      } else {
        out.extendsParent = taken.value;
        index += taken.consumed;
      }
    } else if (arg === "--patch" || arg.startsWith("--patch=")) {
      const taken = takeFlagValue(args, index, "--patch");
      if (taken.error) {
        out.unknown.push(taken.error);
        index += taken.consumed;
      } else {
        out.patchPayload = taken.value;
        index += taken.consumed;
      }
    } else if (arg === "--data" || arg.startsWith("--data=")) {
      const taken = takeFlagValue(args, index, "--data");
      if (taken.error) {
        out.unknown.push(taken.error);
        index += taken.consumed;
      } else {
        out.dataPayload = taken.value;
        index += taken.consumed;
      }
    } else if (arg === "--expected-hash" || arg.startsWith("--expected-hash=") || arg === "--if-match" || arg.startsWith("--if-match=")) {
      const flag = arg.startsWith("--if-match") ? "--if-match" : "--expected-hash";
      const taken = takeFlagValue(args, index, flag);
      if (taken.error) {
        out.unknown.push(taken.error);
        index += taken.consumed;
      } else {
        out.expectedHash = taken.value;
        index += taken.consumed;
      }
    } else if (arg === "--expected-absent") {
      out.expectedAbsent = true;
      index += 1;
    } else if (arg === "--user-config" || arg.startsWith("--user-config=")) {
      const taken = takeFlagValue(args, index, "--user-config");
      if (taken.error) {
        out.unknown.push(taken.error);
        index += taken.consumed;
      } else {
        out.userConfig = taken.value;
        index += taken.consumed;
      }
    } else if (arg === "--project-config" || arg.startsWith("--project-config=")) {
      const taken = takeFlagValue(args, index, "--project-config");
      if (taken.error) {
        out.unknown.push(taken.error);
        index += taken.consumed;
      } else {
        out.projectConfig = taken.value;
        index += taken.consumed;
      }
    } else if (arg === "--project-root" || arg.startsWith("--project-root=")) {
      const taken = takeFlagValue(args, index, "--project-root");
      if (taken.error) {
        out.unknown.push(taken.error);
        index += taken.consumed;
      } else {
        out.projectRoot = taken.value;
        index += taken.consumed;
      }
    } else if (isHelpFlag(arg)) {
      out.help = true;
      index += 1;
    } else if (arg.startsWith("--")) {
      out.unknown.push(arg);
      index += 1;
    } else {
      out.positionals.push(arg);
      index += 1;
    }
  }
  if (out.expectedAbsent === true && out.expectedHash !== undefined) {
    out.unknown.push("--expected-hash and --expected-absent must not be combined");
  }
  return out;
}

function requireScope(parsed: ParsedScopeOptions): MutationScope | undefined {
  if (parsed.scope !== "user" && parsed.scope !== "project") {
    return undefined;
  }
  return parsed.scope;
}

function mutationBaseOptions(
  deps: MutationCommandDeps,
  parsed: ParsedScopeOptions,
): import("@orca-pi/core").MutationWriteOptions {
  const effectiveProjectRoot = parsed.projectRoot ?? deps.projectRoot;
  const userPath = parsed.userConfig ?? deps.userConfigPathOverride;
  const projectPath = parsed.projectConfig ?? deps.projectConfigPathOverride;
  const fs = buildMutationFs(deps.fs);
  return {
    projectRoot: effectiveProjectRoot,
    ...(userPath !== undefined ? { userPath } : {}),
    ...(projectPath !== undefined ? { projectPath } : {}),
    ...(deps.env !== undefined ? { env: deps.env } : {}),
    ...(deps.homedir !== undefined ? { homedir: deps.homedir } : {}),
    ...(deps.osHomedir !== undefined ? { osHomedir: deps.osHomedir } : {}),
    ...(fs ? { fs } : {}),
    ...(parsed.expectedAbsent === true && parsed.expectedHash === undefined
      ? { expectedSourceHash: null }
      : parsed.expectedHash !== undefined && parsed.expectedAbsent !== true
        ? { expectedSourceHash: parsed.expectedHash }
        : {}),
  };
}

function buildMutationFs(
  injected: MutationCommandDeps["fs"],
): import("@orca-pi/core").MutationFs | undefined {
  if (!injected) return undefined;
  const hasWrite =
    typeof (injected as { writeFile?: unknown }).writeFile === "function" &&
    typeof (injected as { rename?: unknown }).rename === "function" &&
    typeof (injected as { mkdir?: unknown }).mkdir === "function";
  if (hasWrite) {
    return injected as unknown as import("@orca-pi/core").MutationFs;
  }
  // Read-only injected fs (existing list/show tests): fall through to the
  // real filesystem for writes via the service default. Reads still use the
  // injected layer through load indirection? The service resolves fs as a
  // whole, so we cannot mix. When the injected fs lacks write support we
  // return undefined so the service uses the real fs — callers that need
  // hermetic writes must inject a full MutationFs (see tests).
  return undefined;
}

async function resolveFsForPayload(
  deps: MutationCommandDeps,
): Promise<{ readFile(path: string, encoding: "utf8"): Promise<string> } | undefined> {
  if (deps.fs && typeof deps.fs.readFile === "function") {
    const readFile = deps.fs.readFile as unknown as (
      path: string,
      encoding: "utf8",
    ) => Promise<string>;
    return { readFile };
  }
  try {
    const fs = await import("node:fs/promises");
    return {
      readFile: (path: string, encoding: "utf8") => fs.readFile(path, encoding) as Promise<string>,
    };
  } catch {
    return undefined;
  }
}

async function loadPayloadText(
  raw: string,
  deps: MutationCommandDeps,
): Promise<string> {
  if (!raw.startsWith("@")) return raw;
  const filePath = raw.slice(1);
  if (!filePath) throw new Error(`Invalid payload ${JSON.stringify(raw)}: expected @<file> with a path.`);
  const fs = await resolveFsForPayload(deps);
  if (!fs) throw new Error(`Could not read payload file ${JSON.stringify(filePath)}: no filesystem available.`);
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(
      `Could not read payload file ${JSON.stringify(filePath)}: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
}

function parseJsonObject(text: string, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Invalid ${what} JSON: ${error instanceof Error ? error.message : String(error)}. Expected an object like {"model": "openai/gpt-5.6"}. Use @<file> to load from disk.`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid ${what}: expected a JSON object, got ${JSON.stringify(parsed)?.slice(0, 120)}.`);
  }
  return parsed as Record<string, unknown>;
}

function parseFieldValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return raw;
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

function formatMutationError(error: unknown): { message: string; code?: string } {
  if (error instanceof ProfileMutationError) {
    return { message: error.message, code: error.code };
  }
  return { message: error instanceof Error ? error.message : String(error) };
}

function emitMutationFailure(
  deps: MutationCommandDeps,
  error: unknown,
  asJson: boolean,
  action: string,
): MutationCommandResult {
  const { message, code } = formatMutationError(error);
  if (asJson) {
    const issues =
      error instanceof ProfileMutationError && error.issues ? error.issues : undefined;
    deps.stdout(
      `${JSON.stringify(
        {
          ok: false,
          action,
          error: message,
          ...(code ? { code } : {}),
          ...(issues ? { issues } : {}),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    deps.stderr(`error: ${message}\n`);
  }
  // Usage errors (missing scope / unknown flags) use exit 2 at the call
  // site; mutation failures (conflict/validation/not-found) use exit 1 here.
  const isUsage =
    error instanceof ProfileMutationError &&
    (error.code === "missing-scope" || error.code === "invalid-field" || error.code === "invalid-name");
  void isUsage;
  return { exitCode: 1 };
}

function emitReceipt(
  deps: MutationCommandDeps,
  receipt: ProfileMutationReceipt,
  asJson: boolean,
): MutationCommandResult {
  if (asJson) {
    deps.stdout(`${JSON.stringify({ ok: true, ...receipt }, null, 2)}\n`);
    return { exitCode: 0 };
  }
  const verb =
    receipt.action === "create"
      ? "Created"
      : receipt.action === "clone"
        ? `Cloned${receipt.sourceName ? ` ${receipt.sourceName} →` : ""}`
        : receipt.action === "set" || receipt.action === "patch"
          ? "Updated"
          : receipt.action === "unset"
            ? "Unset field for"
            : "Deleted";
  if (receipt.deleted) {
    deps.stdout(`${verb} profile "${receipt.profileName}" (${receipt.scope} config ${receipt.path}; profile fully removed).\n`);
  } else if (receipt.action === "delete") {
    deps.stdout(`Deleted ${receipt.scope} override for profile "${receipt.profileName}" (${receipt.path}).\n`);
  } else {
    const hash = receipt.sourceHashAfter ? ` hash ${receipt.sourceHashAfter.slice(0, 12)}…` : "";
    deps.stdout(`${verb} profile "${receipt.profileName}" in ${receipt.scope} config (${receipt.path};${hash}).\n`);
  }
  return { exitCode: 0 };
}

const MUTATION_USAGE = `orca-pi profile — mutate Pi role profiles (UI1.1 machine API)

Usage:
  orca-pi profile create <name> --scope <user|project> [--extends <parent>] [--data <json|@file>] [--expected-hash <hash>|--expected-absent] [--json]
  orca-pi profile clone <source> <dest> --scope <user|project> [--expected-hash <hash>|--expected-absent] [--json]
  orca-pi profile set <name> <field> <value> --scope <user|project> [--expected-hash <hash>|--expected-absent] [--json]
  orca-pi profile unset <name> <field> --scope <user|project> [--expected-hash <hash>|--expected-absent] [--json]
  orca-pi profile delete <name> --scope <user|project> [--expected-hash <hash>|--expected-absent] [--json]
  orca-pi profile patch <name> --scope <user|project> (--patch <json|@file> | --data <json|@file> | --json <json|@file>) [--expected-hash <hash>|--expected-absent]
  orca-pi profile read <name> [--json]

Mutable fields: ${MUTABLE_PROFILE_FIELDS.join(", ")}
Scopes: user, project (explicit --scope is always required for writes).
Payloads are JSON objects; use null to delete a field in patch. --expected-hash
enables optimistic concurrency (stale writes fail with conflict); --expected-absent
asserts the target scope file is still absent (both read while missing → first
create wins, second conflicts instead of silently replacing). The two flags
must not be combined.
`;

export function mutationUsage(): string {
  return MUTATION_USAGE;
}

export async function runProfileCreate(
  args: readonly string[],
  deps: MutationCommandDeps,
): Promise<MutationCommandResult> {
  const parsed = parseMutationArgs(args);
  if (parsed.help) {
    deps.stdout(MUTATION_USAGE);
    return { exitCode: 0 };
  }
  if (parsed.unknown.length > 0) {
    deps.stderr(`error: unknown profile create option(s): ${parsed.unknown.join(", ")}\n`);
    deps.stderr("usage: orca-pi profile create <name> --scope <user|project> [--extends <parent>] [--data <json|@file>] [--json]\n");
    return { exitCode: 2 };
  }
  const scope = requireScope(parsed);
  if (!scope) {
    deps.stderr(`error: profile create requires explicit --scope <user|project>. Destructive targets are never inferred.\n`);
    deps.stderr("usage: orca-pi profile create <name> --scope <user|project> [--extends <parent>] [--data <json|@file>] [--json]\n");
    return { exitCode: 2 };
  }
  if (parsed.positionals.length !== 1) {
    deps.stderr(`error: profile create requires exactly one <name> (got ${parsed.positionals.length}).\n`);
    deps.stderr("usage: orca-pi profile create <name> --scope <user|project> [--extends <parent>] [--data <json|@file>] [--json]\n");
    return { exitCode: 2 };
  }
  const name = parsed.positionals[0] as string;
  try {
    let initial: Record<string, unknown> | undefined;
    const rawPayload = parsed.dataPayload ?? parsed.jsonPayload;
    if (rawPayload !== undefined) {
      const text = await loadPayloadText(rawPayload, deps);
      initial = parseJsonObject(text, "create --data");
    }
    if (parsed.extendsParent !== undefined) {
      initial = { ...(initial ?? {}), extends: parsed.extendsParent };
    }
    if (parsed.patchPayload !== undefined) {
      throw new Error(`profile create does not accept --patch; use --data <json|@file> plus --extends <parent>.`);
    }
    const receipt = await createProfile(
      { name, scope, ...(initial ? { initial } : {}) },
      {
        ...mutationBaseOptions(deps, parsed),
        ...(parsed.expectedHash !== undefined ? { expectedSourceHash: parsed.expectedHash } : {}),
      },
    );
    return emitReceipt(deps, receipt, parsed.asJson);
  } catch (error) {
    return emitMutationFailure(deps, error, parsed.asJson, "create");
  }
}

export async function runProfileClone(
  args: readonly string[],
  deps: MutationCommandDeps,
): Promise<MutationCommandResult> {
  const parsed = parseMutationArgs(args);
  if (parsed.help) {
    deps.stdout(MUTATION_USAGE);
    return { exitCode: 0 };
  }
  if (parsed.unknown.length > 0) {
    deps.stderr(`error: unknown profile clone option(s): ${parsed.unknown.join(", ")}\n`);
    deps.stderr("usage: orca-pi profile clone <source> <dest> --scope <user|project> [--json]\n");
    return { exitCode: 2 };
  }
  const scope = requireScope(parsed);
  if (!scope) {
    deps.stderr(`error: profile clone requires explicit --scope <user|project>.\n`);
    deps.stderr("usage: orca-pi profile clone <source> <dest> --scope <user|project> [--json]\n");
    return { exitCode: 2 };
  }
  if (parsed.positionals.length !== 2) {
    deps.stderr(`error: profile clone requires <source> <dest> (got ${parsed.positionals.length}).\n`);
    deps.stderr("usage: orca-pi profile clone <source> <dest> --scope <user|project> [--json]\n");
    return { exitCode: 2 };
  }
  const [source, dest] = parsed.positionals as [string, string];
  try {
    if (parsed.patchPayload ?? parsed.dataPayload ?? parsed.jsonPayload ?? parsed.extendsParent) {
      throw new Error(`profile clone takes no --patch/--data/--extends; clone copies the source entry into --scope ${scope}.`);
    }
    const receipt = await cloneProfile(
      { source, dest, scope },
      {
        ...mutationBaseOptions(deps, parsed),
        ...(parsed.expectedHash !== undefined ? { expectedSourceHash: parsed.expectedHash } : {}),
      },
    );
    return emitReceipt(deps, receipt, parsed.asJson);
  } catch (error) {
    return emitMutationFailure(deps, error, parsed.asJson, "clone");
  }
}

export async function runProfileSet(
  args: readonly string[],
  deps: MutationCommandDeps,
): Promise<MutationCommandResult> {
  const parsed = parseMutationArgs(args);
  if (parsed.help) {
    deps.stdout(MUTATION_USAGE);
    return { exitCode: 0 };
  }
  if (parsed.unknown.length > 0) {
    deps.stderr(`error: unknown profile set option(s): ${parsed.unknown.join(", ")}\n`);
    deps.stderr("usage: orca-pi profile set <name> <field> <value> --scope <user|project> [--json]\n");
    return { exitCode: 2 };
  }
  const scope = requireScope(parsed);
  if (!scope) {
    deps.stderr(`error: profile set requires explicit --scope <user|project>.\n`);
    deps.stderr("usage: orca-pi profile set <name> <field> <value> --scope <user|project> [--json]\n");
    return { exitCode: 2 };
  }
  if (parsed.positionals.length !== 3) {
    deps.stderr(`error: profile set requires <name> <field> <value> (got ${parsed.positionals.length}).\n`);
    deps.stderr("usage: orca-pi profile set <name> <field> <value> --scope <user|project> [--json]\n");
    return { exitCode: 2 };
  }
  const [name, field, rawValue] = parsed.positionals as [string, string, string];
  try {
    if (parsed.patchPayload ?? parsed.dataPayload ?? parsed.jsonPayload ?? parsed.extendsParent) {
      throw new Error(`profile set takes a positional <value>; use profile patch for JSON objects.`);
    }
    const value = parseFieldValue(rawValue);
    const receipt = await setProfileField(
      { name, scope, field, value },
      {
        ...mutationBaseOptions(deps, parsed),
        ...(parsed.expectedHash !== undefined ? { expectedSourceHash: parsed.expectedHash } : {}),
      },
    );
    return emitReceipt(deps, receipt, parsed.asJson);
  } catch (error) {
    return emitMutationFailure(deps, error, parsed.asJson, "set");
  }
}

export async function runProfileUnset(
  args: readonly string[],
  deps: MutationCommandDeps,
): Promise<MutationCommandResult> {
  const parsed = parseMutationArgs(args);
  if (parsed.help) {
    deps.stdout(MUTATION_USAGE);
    return { exitCode: 0 };
  }
  if (parsed.unknown.length > 0) {
    deps.stderr(`error: unknown profile unset option(s): ${parsed.unknown.join(", ")}\n`);
    deps.stderr("usage: orca-pi profile unset <name> <field> --scope <user|project> [--json]\n");
    return { exitCode: 2 };
  }
  const scope = requireScope(parsed);
  if (!scope) {
    deps.stderr(`error: profile unset requires explicit --scope <user|project>.\n`);
    deps.stderr("usage: orca-pi profile unset <name> <field> --scope <user|project> [--json]\n");
    return { exitCode: 2 };
  }
  if (parsed.positionals.length !== 2) {
    deps.stderr(`error: profile unset requires <name> <field> (got ${parsed.positionals.length}).\n`);
    deps.stderr("usage: orca-pi profile unset <name> <field> --scope <user|project> [--json]\n");
    return { exitCode: 2 };
  }
  const [name, field] = parsed.positionals as [string, string];
  try {
    const receipt = await unsetProfileField(
      { name, scope, field },
      {
        ...mutationBaseOptions(deps, parsed),
        ...(parsed.expectedHash !== undefined ? { expectedSourceHash: parsed.expectedHash } : {}),
      },
    );
    return emitReceipt(deps, receipt, parsed.asJson);
  } catch (error) {
    return emitMutationFailure(deps, error, parsed.asJson, "unset");
  }
}

export async function runProfileDelete(
  args: readonly string[],
  deps: MutationCommandDeps,
): Promise<MutationCommandResult> {
  const parsed = parseMutationArgs(args);
  if (parsed.help) {
    deps.stdout(MUTATION_USAGE);
    return { exitCode: 0 };
  }
  if (parsed.unknown.length > 0) {
    deps.stderr(`error: unknown profile delete option(s): ${parsed.unknown.join(", ")}\n`);
    deps.stderr("usage: orca-pi profile delete <name> --scope <user|project> [--json]\n");
    return { exitCode: 2 };
  }
  const scope = requireScope(parsed);
  if (!scope) {
    deps.stderr(`error: profile delete requires explicit --scope <user|project>. Destructive targets are never inferred.\n`);
    deps.stderr("usage: orca-pi profile delete <name> --scope <user|project> [--json]\n");
    return { exitCode: 2 };
  }
  if (parsed.positionals.length !== 1) {
    deps.stderr(`error: profile delete requires exactly one <name> (got ${parsed.positionals.length}).\n`);
    deps.stderr("usage: orca-pi profile delete <name> --scope <user|project> [--json]\n");
    return { exitCode: 2 };
  }
  const name = parsed.positionals[0] as string;
  try {
    const receipt = await deleteProfile(
      { name, scope },
      {
        ...mutationBaseOptions(deps, parsed),
        ...(parsed.expectedHash !== undefined ? { expectedSourceHash: parsed.expectedHash } : {}),
      },
    );
    return emitReceipt(deps, receipt, parsed.asJson);
  } catch (error) {
    return emitMutationFailure(deps, error, parsed.asJson, "delete");
  }
}

export async function runProfilePatch(
  args: readonly string[],
  deps: MutationCommandDeps,
): Promise<MutationCommandResult> {
  const parsed = parseMutationArgs(args);
  if (parsed.help) {
    deps.stdout(MUTATION_USAGE);
    return { exitCode: 0 };
  }
  if (parsed.unknown.length > 0) {
    deps.stderr(`error: unknown profile patch option(s): ${parsed.unknown.join(", ")}\n`);
    deps.stderr("usage: orca-pi profile patch <name> --scope <user|project> (--patch <json|@file> | --data <json|@file> | --json <json|@file>)\n");
    return { exitCode: 2 };
  }
  const scope = requireScope(parsed);
  if (!scope) {
    deps.stderr(`error: profile patch requires explicit --scope <user|project>.\n`);
    deps.stderr("usage: orca-pi profile patch <name> --scope <user|project> (--patch <json|@file> | --data <json|@file> | --json <json|@file>)\n");
    return { exitCode: 2 };
  }
  if (parsed.positionals.length !== 1) {
    deps.stderr(`error: profile patch requires exactly one <name> (got ${parsed.positionals.length}).\n`);
    deps.stderr("usage: orca-pi profile patch <name> --scope <user|project> (--patch <json|@file> | --data <json|@file> | --json <json|@file>)\n");
    return { exitCode: 2 };
  }
  const name = parsed.positionals[0] as string;
  const rawPayload = parsed.patchPayload ?? parsed.dataPayload ?? parsed.jsonPayload;
  if (rawPayload === undefined) {
    deps.stderr(`error: profile patch requires a payload: --patch <json|@file> (or --data / --json <json|@file>).\n`);
    deps.stderr("usage: orca-pi profile patch <name> --scope <user|project> (--patch <json|@file> | --data <json|@file> | --json <json|@file>)\n");
    return { exitCode: 2 };
  }
  try {
    if (parsed.extendsParent !== undefined) {
      throw new Error(`profile patch does not accept --extends; include "extends" inside the patch object instead.`);
    }
    const text = await loadPayloadText(rawPayload, deps);
    const patch = parseJsonObject(text, "patch");
    const receipt = await patchProfile(
      { name, scope, patch },
      {
        ...mutationBaseOptions(deps, parsed),
        ...(parsed.expectedHash !== undefined ? { expectedSourceHash: parsed.expectedHash } : {}),
      },
    );
    return emitReceipt(deps, receipt, parsed.asJson);
  } catch (error) {
    return emitMutationFailure(deps, error, parsed.asJson, "patch");
  }
}

export async function runProfileRead(
  args: readonly string[],
  deps: MutationCommandDeps,
): Promise<MutationCommandResult> {
  let asJson = false;
  let name: string | undefined;
  let userConfig: string | undefined;
  let projectConfig: string | undefined;
  let projectRoot: string | undefined;
  const unknown: string[] = [];
  const takeValue = (flag: string, index: number): { value?: string; consumed: number } => {
    const current = args[index] as string;
    if (current.startsWith(`${flag}=`)) {
      const value = current.slice(flag.length + 1);
      if (!value) {
        unknown.push(`${flag} requires a value`);
        return { consumed: 1 };
      }
      return { value, consumed: 1 };
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("-")) {
      unknown.push(`${flag} requires a value`);
      return { consumed: 1 };
    }
    return { value, consumed: 2 };
  };
  for (let index = 0; index < args.length;) {
    const arg = args[index] as string;
    if (arg === "--json") {
      asJson = true;
      index += 1;
    } else if (arg === "--user-config" || arg.startsWith("--user-config=")) {
      const taken = takeValue("--user-config", index);
      if (taken.value !== undefined) userConfig = taken.value;
      index += taken.consumed;
    } else if (arg === "--project-config" || arg.startsWith("--project-config=")) {
      const taken = takeValue("--project-config", index);
      if (taken.value !== undefined) projectConfig = taken.value;
      index += taken.consumed;
    } else if (arg === "--project-root" || arg.startsWith("--project-root=")) {
      const taken = takeValue("--project-root", index);
      if (taken.value !== undefined) projectRoot = taken.value;
      index += taken.consumed;
    } else if (isHelpFlag(arg)) {
      deps.stdout(MUTATION_USAGE);
      return { exitCode: 0 };
    } else if (arg.startsWith("--")) {
      unknown.push(arg);
      index += 1;
    } else if (name === undefined) {
      name = arg;
      index += 1;
    } else {
      unknown.push(arg);
      index += 1;
    }
  }
  if (unknown.length > 0) {
    deps.stderr(`error: unknown profile read option(s): ${unknown.join(", ")}\n`);
    deps.stderr("usage: orca-pi profile read <name> [--json]\n");
    return { exitCode: 2 };
  }
  if (!name) {
    deps.stderr(`error: profile read requires a profile name\n`);
    deps.stderr("usage: orca-pi profile read <name> [--json]\n");
    return { exitCode: 2 };
  }
  try {
    const view = await readEditableProfile(name, {
      projectRoot: projectRoot ?? deps.projectRoot,
      ...(userConfig ?? deps.userConfigPathOverride ? { userPath: userConfig ?? deps.userConfigPathOverride } : {}),
      ...(projectConfig ?? deps.projectConfigPathOverride ? { projectPath: projectConfig ?? deps.projectConfigPathOverride } : {}),
      ...(deps.env !== undefined ? { env: deps.env } : {}),
      ...(deps.homedir !== undefined ? { homedir: deps.homedir } : {}),
      ...(deps.osHomedir !== undefined ? { osHomedir: deps.osHomedir } : {}),
      ...(buildMutationFs(deps.fs) ? { fs: buildMutationFs(deps.fs) } : {}),
    });
    if (asJson) {
      deps.stdout(`${JSON.stringify(view, null, 2)}\n`);
      return { exitCode: view.exists && view.validation.ok ? 0 : 1 };
    }
    if (!view.exists) {
      deps.stderr(`error: Unknown Pi profile "${name}".\n`);
      return { exitCode: 1 };
    }
    if (!view.validation.ok) {
      deps.stderr(`error: Profile "${name}" is invalid: ${view.validation.error}\n`);
      return { exitCode: 1 };
    }
    const lines: string[] = [];
    lines.push(`Profile: ${name}${view.displayName ? ` — ${view.displayName}` : ""}`);
    lines.push(`Extends chain: ${view.extendsChain.join(" → ") || "(none)"}`);
    lines.push(`Config: user ${view.config.userPath} < project ${view.config.projectPath}`);
    lines.push("");
    for (const field of Object.keys(view.fields).sort()) {
      const entry = view.fields[field] as {
        builtin?: unknown;
        user?: unknown;
        project?: unknown;
        effective?: unknown;
        provenance: { display: string };
      };
      const formatValue = (value: unknown): string => {
        if (value === undefined) return "(none)";
        if (Array.isArray(value)) return value.length === 0 ? "(none)" : value.join(", ");
        if (typeof value === "boolean") return value ? "true" : "false";
        return String(value);
      };
      lines.push(`  ${field}: ${formatValue(entry.effective)} [${entry.provenance.display}]`);
      if (entry.builtin !== undefined || entry.user !== undefined || entry.project !== undefined) {
        const parts: string[] = [];
        if (entry.builtin !== undefined) parts.push(`builtin=${formatValue(entry.builtin)}`);
        if (entry.user !== undefined) parts.push(`user=${formatValue(entry.user)}`);
        if (entry.project !== undefined) parts.push(`project=${formatValue(entry.project)}`);
        if (parts.length > 0) lines.push(`    layers: ${parts.join(" | ")}`);
      }
    }
    deps.stdout(`${lines.join("\n")}\n`);
    return { exitCode: 0 };
  } catch (error) {
    if (asJson) {
      deps.stdout(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`);
    } else {
      deps.stderr(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    return { exitCode: 1 };
  }
}

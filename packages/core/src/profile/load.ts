/**
 * Loading, parsing, and multi-layer merging for Pi agent profiles.
 *
 * Pure functions (`parseProfilesText`, `mergeValidatedDocuments`,
 * `listProfileNames`) never touch the filesystem, never read prompt/skill
 * file contents, and never execute shell — they only normalize the config
 * text itself. Thin `node:fs` helpers (`loadProfilesFile`,
 * `loadMergedProfiles`) wrap the pure layer for real CLI use and skip
 * missing files so user/global config is optional.
 *
 * Supported input: YAML (canonical, `.yaml`/`.yml`) or JSON (`.json`).
 * The parser is content-sniffed (JSON when the trimmed text starts with
 * `{`), so the file extension never changes semantics. Malformed input
 * throws {@link ProfileLoadError} with line/column context where available.
 */

import { parse as parseYaml } from "yaml";
import {
  ProfileValidationError,
  validateProfilesDocument,
} from "./schema.js";
import type { ValidatedProfilesDocument } from "./types.js";

/** Malformed YAML/JSON or unreadable config — thrown before validation. */
export class ProfileLoadError extends Error {
  readonly sourceLabel: string;
  /** Optional `line:col` hint extracted from the underlying parser. */
  readonly location?: string;

  constructor(sourceLabel: string, message: string, location?: string) {
    super(
      location
        ? `Failed to load Pi profiles from ${sourceLabel} (${location}): ${message}`
        : `Failed to load Pi profiles from ${sourceLabel}: ${message}`,
    );
    this.name = "ProfileLoadError";
    this.sourceLabel = sourceLabel;
    this.location = location;
  }
}

/**
 * Parse raw YAML/JSON text into an unvalidated value. Throws
 * {@link ProfileLoadError} with actionable diagnostics (including YAML
 * line/column when the parser provides it). Never interpolates env vars,
 * never executes shell, never reads other files.
 */
export function parseProfilesText(text: string, sourceLabel: string): unknown {
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new ProfileLoadError(
      sourceLabel,
      `config is empty. Expected YAML or JSON shaped like { profiles: { scout: { model: "anthropic/claude-haiku" } } }.`,
    );
  }
  const trimmed = text.trim();
  const looksLikeJson = trimmed.startsWith("{");
  if (looksLikeJson) {
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new ProfileLoadError(
        sourceLabel,
        `malformed JSON: ${error instanceof Error ? error.message : String(error)}. Hint: validate with \`node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" <file>\` or convert to YAML.`,
      );
    }
  }
  try {
    return parseYaml(text) as unknown;
  } catch (error) {
    const location = extractYamlLocation(error);
    const detail = error instanceof Error ? error.message : String(error);
    // `yaml` errors already include line/column; keep the first line plus hint.
    const firstLine = detail.split("\n")[0] ?? detail;
    throw new ProfileLoadError(
      sourceLabel,
      `malformed YAML: ${firstLine}. Hint: check indentation (spaces, not tabs), colons after keys, and list dashes.`,
      location,
    );
  }
}

function extractYamlLocation(error: unknown): string | undefined {
  if (error && typeof error === "object") {
    const withPos = error as {
      linePos?: { start?: { line?: number; col?: number } };
    };
    const start = withPos.linePos?.start;
    if (start && typeof start.line === "number" && typeof start.col === "number") {
      return `line ${start.line}, col ${start.col}`;
    }
  }
  return undefined;
}

/**
 * Parse YAML/JSON text and validate it into a {@link ValidatedProfilesDocument}.
 * Throws {@link ProfileLoadError} on malformed syntax or
 * {@link ProfileValidationError} on schema violations. Never mutates its
 * input; never reads prompt/skill files.
 */
export function parseAndValidateProfilesText(
  text: string,
  sourceLabel: string,
): ValidatedProfilesDocument {
  const raw = parseProfilesText(text, sourceLabel);
  return validateProfilesDocument(raw, sourceLabel);
}

/**
 * Merge validated documents in precedence order (earlier = lower
 * precedence, later wins). Used for user/global → project layering:
 *
 * ```ts
 * mergeValidatedDocuments([userDoc, projectDoc])
 * ```
 *
 * Same-profile fields merge per-field with later documents overriding
 * earlier ones; arrays replace wholesale (v1 has no append syntax).
 * Never mutates its inputs — merged profiles are fresh copies.
 */
export function mergeValidatedDocuments(
  documents: readonly ValidatedProfilesDocument[],
): ValidatedProfilesDocument {
  const merged: Record<string, ValidatedProfilesDocument["profiles"][string]> = {};
  const labels: string[] = [];
  for (const doc of documents) {
    labels.push(doc.sourceLabel);
    for (const [name, profile] of Object.entries(doc.profiles)) {
      const existing = merged[name];
      if (!existing) {
        merged[name] = {
          ...profile,
          tools: profile.tools ? [...profile.tools] : undefined,
          excludeTools: profile.excludeTools ? [...profile.excludeTools] : undefined,
          skills: profile.skills ? [...profile.skills] : undefined,
          extensions: profile.extensions ? [...profile.extensions] : undefined,
        };
        continue;
      }
      // Later documents win per-field; arrays replace (never concat).
      const next = { ...existing };
      for (const [key, value] of Object.entries(profile) as [
        keyof typeof profile,
        unknown,
      ][]) {
        if (key === "sourceLabel") continue;
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          (next as Record<string, unknown>)[key] = [...value];
        } else {
          (next as Record<string, unknown>)[key] = value;
        }
      }
      // Prompt-field clearing across layers mirrors inheritance: setting one
      // prompt field clears the other so the pair stays mutually exclusive.
      if (profile.systemPrompt !== undefined) {
        next.systemPrompt = profile.systemPrompt;
        next.systemPromptFile = undefined;
      } else if (profile.systemPromptFile !== undefined) {
        next.systemPromptFile = profile.systemPromptFile;
        next.systemPrompt = undefined;
      }
      next.sourceLabel = profile.sourceLabel ?? doc.sourceLabel;
      merged[name] = next;
    }
  }
  return {
    profiles: merged,
    sourceLabel: labels.length > 0 ? `merged(${labels.join(" < ")})` : "merged()",
  };
}

/** Sorted profile names without reading any prompt/skill file contents. */
export function listProfileNames(
  document: ValidatedProfilesDocument | { profiles: Record<string, unknown> },
): string[] {
  return Object.keys(document.profiles).sort();
}

/** Canonical user/global config path (`$PI_CODING_AGENT_DIR/profiles.yaml`). */
export function getUserProfilesPath(options?: {
  env?: NodeJS.ProcessEnv;
  homedir?: string;
}): string {
  const env = options?.env ?? process.env;
  const base = env.PI_CODING_AGENT_DIR?.trim();
  if (base) {
    return joinPosix(normalizeSlashes(base), "profiles.yaml");
  }
  const home = (options?.homedir ?? env.HOME ?? "~").trim() || "~";
  return joinPosix(normalizeSlashes(home), ".pi/agent/profiles.yaml");
}

/** Canonical project config path (`<projectRoot>/.pi/profiles.yaml`). */
export function getProjectProfilesPath(projectRoot: string): string {
  return joinPosix(normalizeSlashes(projectRoot), ".pi/profiles.yaml");
}

/**
 * Ordered candidate paths, low → high precedence:
 * `[user/global, project]`. Callers load existing files in this order and
 * merge with {@link mergeValidatedDocuments}.
 */
export function getCandidateConfigPaths(options: {
  projectRoot: string;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
}): readonly string[] {
  return [
    getUserProfilesPath({ env: options.env, homedir: options.homedir }),
    getProjectProfilesPath(options.projectRoot),
  ];
}

function normalizeSlashes(input: string): string {
  return input.replace(/\\/g, "/").replace(/\/+$/, "");
}

function joinPosix(...parts: string[]): string {
  return parts
    .map((part, index) => (index === 0 ? part.replace(/\/+$/, "") : part.replace(/^\/+|\/+$/g, "")))
    .filter((part) => part.length > 0)
    .join("/");
}

/**
 * Load one config file from disk, parse, and validate. Returns `undefined`
 * when the file does not exist (missing user/global config is not an
 * error). Throws {@link ProfileLoadError} on unreadable/malformed files or
 * {@link ProfileValidationError} on schema violations. Never reads
 * prompt/skill file contents.
 */
export async function loadProfilesFile(
  filePath: string,
  options?: { fs?: Pick<typeof import("node:fs/promises"), "readFile"> },
): Promise<ValidatedProfilesDocument | undefined> {
  const fs = options?.fs ?? (await import("node:fs/promises"));
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw new ProfileLoadError(
      filePath,
      `could not read file: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  try {
    return parseAndValidateProfilesText(text, filePath);
  } catch (error) {
    if (error instanceof ProfileLoadError || error instanceof ProfileValidationError) {
      throw error;
    }
    throw new ProfileLoadError(
      filePath,
      `unexpected parse failure: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
}

function isEnoent(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * Load and merge user/global + project configs in precedence order.
 * Missing files are skipped; malformed/invalid files throw. Returns the
 * merged document (possibly empty when no files exist). Never reads
 * prompt/skill file contents.
 */
export async function loadMergedProfiles(options: {
  projectRoot: string;
  userConfigPath?: string;
  projectConfigPath?: string;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  fs?: Pick<typeof import("node:fs/promises"), "readFile">;
}): Promise<ValidatedProfilesDocument> {
  const userPath =
    options.userConfigPath ?? getUserProfilesPath({ env: options.env, homedir: options.homedir });
  const projectPath = options.projectConfigPath ?? getProjectProfilesPath(options.projectRoot);
  const documents: ValidatedProfilesDocument[] = [];
  for (const filePath of [userPath, projectPath]) {
    const document = await loadProfilesFile(filePath, { fs: options.fs });
    if (document) documents.push(document);
  }
  return mergeValidatedDocuments(documents);
}

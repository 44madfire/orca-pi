/**
 * Prompt resolution for the deterministic Pi launcher (OP1.3 / JEF-7).
 *
 * - Inline `systemPrompt` is passed through untouched (literal, no shell).
 * - `systemPromptFile` is read **before launch** relative to the documented
 *   `projectRoot` and its contents are passed explicitly via
 *   `--system-prompt`. Listing/resolving profiles never reads files; only
 *   the launcher does, so ambient prompt discovery can stay disabled.
 * - Relative skill/extension paths use the same `joinProjectPath` helper
 *   (exported for `build-pi-launch.ts`) so nothing resolves against the
 *   process-global cwd by accident.
 */

import type { ResolvedPiProfile } from "../profile/types.js";

/** Where the effective prompt text came from. */
export type PiPromptSource = "inline" | "file" | "none";

/** Resolved prompt text plus provenance for diagnostics/inspect. */
export interface ResolvedPrompt {
  readonly text: string | undefined;
  readonly source: PiPromptSource;
  /** Project-relative path as declared in the profile (when `source=file`). */
  readonly fileRelativePath?: string;
  /** Absolute path that was read (when `source=file`). */
  readonly fileAbsolutePath?: string;
}

export type PiPromptFileErrorCode =
  | "missing-prompt-file"
  | "unreadable-prompt-file"
  | "empty-prompt-file"
  | "prompt-materialization-failed";

/**
 * Actionable pre-launch failure reading `systemPromptFile`.
 * Carries the profile name, the declared relative path, and the absolute
 * path that was attempted so engineers can fix config or create the file.
 */
export class PiLaunchError extends Error {
  readonly code: PiPromptFileErrorCode;
  readonly profileName: string;
  readonly promptFile: string;
  readonly resolvedPath: string;

  constructor(options: {
    code: PiPromptFileErrorCode;
    profileName: string;
    promptFile: string;
    resolvedPath: string;
    message: string;
  }) {
    super(options.message);
    this.name = "PiLaunchError";
    this.code = options.code;
    this.profileName = options.profileName;
    this.promptFile = options.promptFile;
    this.resolvedPath = options.resolvedPath;
  }
}

/** Injectable file reader (tests supply an in-memory map). */
export type PromptFileReader = (absolutePath: string) => Promise<string>;

async function defaultReadFile(absolutePath: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return await fs.readFile(absolutePath, "utf8");
}

function normalizeSlashes(input: string): string {
  return input.replace(/\\/g, "/");
}

function trimTrailingSlashes(input: string): string {
  return input.replace(/\/+$/, "");
}

/**
 * Join a project-relative path (already validated/normalized, e.g.
 * `.pi/skills/repo-search`) onto `projectRoot` deterministically.
 *
 * Uses forward slashes (Node's fs accepts them on Windows) and never
 * consults `process.cwd()`. `projectRoot` should be an absolute worktree
 * root; a relative root is joined as-is so tests stay deterministic.
 */
export function joinProjectPath(projectRoot: string, relativePath: string): string {
  const root = trimTrailingSlashes(normalizeSlashes(projectRoot));
  const rel = normalizeSlashes(relativePath).replace(/^\/+/, "");
  if (root.length === 0) return rel;
  if (rel.length === 0) return root;
  return `${root}/${rel}`;
}

/** True for ENOENT-style failures (missing file vs. unreadable file). */
function isEnoent(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (code === "ENOENT") return true;
  // In-memory test readers may throw plain Errors with ENOENT in message.
  if (error instanceof Error && /ENOENT/i.test(error.message)) return true;
  return false;
}

/**
 * Resolve the effective prompt text for a profile.
 *
 * - `systemPrompt` → `{ text, source: "inline" }` (no filesystem access).
 * - `systemPromptFile` → read `<projectRoot>/<file>` and return its
 *   contents as `{ text, source: "file", ... }`.
 * - Neither → `{ text: undefined, source: "none" }`.
 *
 * Throws {@link PiLaunchError} when the file is missing, unreadable, or
 * empty. Never interpolates env vars or executes shell — contents are
 * literal and passed as a single `--system-prompt` argv element.
 */
export async function resolvePromptText(
  profile: ResolvedPiProfile,
  options: {
    projectRoot: string;
    readFile?: PromptFileReader;
  },
): Promise<ResolvedPrompt> {
  if (profile.systemPrompt !== undefined) {
    return { text: profile.systemPrompt, source: "inline" };
  }
  if (profile.systemPromptFile === undefined) {
    return { text: undefined, source: "none" };
  }
  const relative = profile.systemPromptFile;
  const absolute = joinProjectPath(options.projectRoot, relative);
  const reader = options.readFile ?? defaultReadFile;
  let content: string;
  try {
    content = await reader(absolute);
  } catch (error) {
    if (isEnoent(error)) {
      throw new PiLaunchError({
        code: "missing-prompt-file",
        profileName: profile.name,
        promptFile: relative,
        resolvedPath: absolute,
        message:
          `Pi profile "${profile.name}" references missing prompt file "${relative}" ` +
          `(resolved to "${absolute}" against project root "${options.projectRoot}"). ` +
          `Create the file or point systemPromptFile at an existing project-relative path.`,
      });
    }
    throw new PiLaunchError({
      code: "unreadable-prompt-file",
      profileName: profile.name,
      promptFile: relative,
      resolvedPath: absolute,
      message:
        `Pi profile "${profile.name}" could not read prompt file "${relative}" ` +
        `(resolved to "${absolute}"): ${error instanceof Error ? error.message : String(error)}. ` +
        `Check file permissions and that the path is a readable UTF-8 text file.`,
    });
  }
  if (content.length === 0) {
    throw new PiLaunchError({
      code: "empty-prompt-file",
      profileName: profile.name,
      promptFile: relative,
      resolvedPath: absolute,
      message:
        `Pi profile "${profile.name}" prompt file "${relative}" ` +
        `(resolved to "${absolute}") is empty. ` +
        `Add prompt text to the file or use an inline systemPrompt instead.`,
    });
  }
  return {
    text: content,
    source: "file",
    fileRelativePath: relative,
    fileAbsolutePath: absolute,
  };
}

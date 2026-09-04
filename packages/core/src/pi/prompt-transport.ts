/**
 * Pi `--system-prompt` file-or-text compatibility transport (OP1.3 / JEF-7).
 *
 * Current Pi does **not** treat `--system-prompt <value>` as guaranteed
 * literal text. Its resource loader (`DefaultResourceLoader`,
 * `resolvePromptInput()` in Pi's `dist/core/resource-loader.js`) does:
 *
 * ```js
 * function resolvePromptInput(input, description) {
 *   if (!input) return undefined;
 *   if (existsSync(input)) {
 *     try { return stripBom(readFileSync(input, "utf-8")); }
 *     catch { return input; }
 *   }
 *   return input;
 * }
 * ```
 *
 * `existsSync(input)` resolves relative values against Pi's process cwd
 * (which is our `spec.cwd`). Therefore a valid profile with
 * `systemPrompt: "README.md"` launched from a cwd containing `README.md`
 * would silently receive the file's contents instead of the literal string.
 * The same collision occurs when a `systemPromptFile`'s *contents* happen
 * to equal an existing path. Directory collisions are safe (read fails with
 * EISDIR, Pi falls back to literal with a warning); only **file**
 * collisions corrupt the prompt.
 *
 * Compatibility strategy (tested, deterministic for the common case):
 * - Non-colliding prompts (the overwhelming common case, including all
 *   multi-line prompts on Windows and virtually all prompts on POSIX) are
 *   passed literally via `--system-prompt <text>` exactly as JEF-7 specifies
 *   — no temp files, byte-identical, structured single argv element.
 * - Colliding prompts (intended text equals an existing **file** in the
 *   launch cwd) are materialized to a deterministic content-addressed temp
 *   file (`<tmpdir>/orca-pi-prompts/orca-pi-prompt-<profile>-<hash16>.md`)
 *   and that temp path is passed via `--system-prompt <temp-path>`. Pi then
 *   takes its file branch and reads the exact intended text. Same
 *   `(profile, promptText, tmpdir)` always yields the same temp path.
 *
 * There is no Pi-supported flag that bypasses path auto-detection (both
 * `--system-prompt` and `--append-system-prompt` are file-or-text), so this
 * fallback is the Pi-contract-correct transport. A contract/regression test
 * simulates Pi's `existsSync`+`readFileSync` resolution against a cwd
 * containing the colliding file and proves Pi receives the intended text.
 */

import { isAbsolute, join, resolve as resolvePath } from "node:path";

export interface PiPromptTransportFs {
  /** True when `absPath` exists and is a regular file (not dir). */
  existsAsFile?: (absPath: string) => Promise<boolean>;
  writeFile?: (absPath: string, contents: string) => Promise<void>;
  mkdirp?: (dir: string) => Promise<void>;
  tmpdir?: () => string;
}

async function defaultExistsAsFile(absPath: string): Promise<boolean> {
  try {
    const fs = await import("node:fs/promises");
    const stat = await fs.stat(absPath);
    return stat.isFile();
  } catch {
    // ENOENT, ENOTDIR, EACCES, EINVAL (e.g. embedded NUL/newline on
    // Windows), or any other fs failure → treat as "not a colliding file",
    // matching Pi's fallback to literal (Pi warns on unreadable files but
    // still uses literal via its catch branch).
    return false;
  }
}

async function defaultWriteFile(absPath: string, contents: string): Promise<void> {
  const fs = await import("node:fs/promises");
  await fs.writeFile(absPath, contents, "utf8");
}

async function defaultMkdirp(dir: string): Promise<void> {
  const fs = await import("node:fs/promises");
  await fs.mkdir(dir, { recursive: true });
}

function defaultTmpdir(): string {
  // Lazy require keeps core importable where `node:os` is stubbed.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("node:os") as typeof import("node:os");
  return os.tmpdir();
}

function hashPromptText(text: string): string {
  // Content-addressed temp names: same prompt → same temp path (deterministic).
  // Lazy require keeps the import cost off the common literal path in constrained hosts.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require("node:crypto") as typeof import("node:crypto");
  return crypto.createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

function sanitizeProfileName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 32);
  return cleaned.length > 0 ? cleaned : "profile";
}

/**
 * Would Pi treat `promptText` as a file path (not literal) when launched
 * with `cwd`? Mirrors Pi's `existsSync(input)` check: absolute values are
 * checked directly, relative values against `cwd`. Only regular files count
 * (directories fall back to literal in Pi, albeit with a warning).
 */
export async function wouldPiTreatPromptAsFile(
  promptText: string,
  cwd: string,
  fs?: PiPromptTransportFs,
): Promise<boolean> {
  if (promptText.length === 0) return false;
  let candidate: string;
  try {
    candidate = isAbsolute(promptText) ? promptText : resolvePath(cwd, promptText);
  } catch {
    return false;
  }
  const existsAsFile = fs?.existsAsFile ?? defaultExistsAsFile;
  try {
    return await existsAsFile(candidate);
  } catch {
    return false;
  }
}

/**
 * Materialize `promptText` to a deterministic temp file and return its
 * absolute path. Content-addressed (`sha256(promptText)`), so repeated
 * builds with the same `(profileName, promptText, tmpdir)` reuse the same
 * path. Creates `<tmpdir>/orca-pi-prompts/` as needed.
 */
export async function materializePromptToTempFile(
  promptText: string,
  profileName: string,
  fs?: PiPromptTransportFs,
  tmpdirOverride?: string,
): Promise<string> {
  const tmpdirFn = fs?.tmpdir ?? defaultTmpdir;
  const base = tmpdirOverride ?? tmpdirFn();
  const dir = join(base, "orca-pi-prompts");
  const mkdirp = fs?.mkdirp ?? defaultMkdirp;
  const writeFile = fs?.writeFile ?? defaultWriteFile;
  await mkdirp(dir);
  const fileName = `orca-pi-prompt-${sanitizeProfileName(profileName)}-${hashPromptText(promptText)}.md`;
  const absPath = join(dir, fileName);
  await writeFile(absPath, promptText);
  return absPath;
}

export type PiPromptTransport = "literal" | "temp-file" | "none";

export interface ResolvedPromptArg {
  /** Value to place after `--system-prompt` in argv (literal or temp path). */
  readonly argvValue: string | undefined;
  readonly transport: PiPromptTransport;
  /** Temp file path when `transport === "temp-file"`. */
  readonly tempPath?: string;
  /** True when the temp fallback was used (Pi collision avoidance). */
  readonly viaTempFile: boolean;
}

/**
 * Resolve the `--system-prompt` argv value for `promptText`, applying the
 * file-or-text compatibility fallback only on collision. Pure (no writes)
 * for the common non-colliding case; writes one content-addressed temp file
 * only when `promptText` equals an existing file in `cwd`.
 */
export async function resolvePromptArgValue(
  promptText: string | undefined,
  options: {
    profileName: string;
    cwd: string;
    fs?: PiPromptTransportFs;
    tmpdir?: string;
  },
): Promise<ResolvedPromptArg> {
  if (promptText === undefined) {
    return { argvValue: undefined, transport: "none", viaTempFile: false };
  }
  const collides = await wouldPiTreatPromptAsFile(promptText, options.cwd, options.fs);
  if (!collides) {
    return { argvValue: promptText, transport: "literal", viaTempFile: false };
  }
  const tempPath = await materializePromptToTempFile(
    promptText,
    options.profileName,
    options.fs,
    options.tmpdir,
  );
  return { argvValue: tempPath, transport: "temp-file", tempPath, viaTempFile: true };
}

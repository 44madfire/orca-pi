/**
 * Redacted human-readable inspect formatter (OP1.3 / JEF-7).
 *
 * `orca-pi profile inspect <name>` prints resolved config + argv through
 * this module. The output is **display-only**: it shell-quotes one line for
 * easy comparison against the Pi CLI docs, but execution must always use
 * the structured {@link PiProcessSpec}`.args` array directly. This module
 * never spawns processes and `build-pi-launch.ts` never imports it, so the
 * formatter cannot become an execution path.
 *
 * Redaction: `--system-prompt` contents are shown as a short escaped
 * preview plus total length by default (`showFullPrompt: false`), so large
 * prompts don't flood logs. All flag *names* are always shown, so an
 * engineer can still verify every emitted flag against the Pi CLI docs.
 * Pass `showFullPrompt: true` (CLI `--show-prompt`) to print the full text.
 */

import type { ResolvedPiProfile } from "../profile/types.js";
import type { PiProcessSpec } from "./process-spec.js";
import type { PiLaunchResult } from "./build-pi-launch.js";

export interface FormatInspectOptions {
  /** Print full `--system-prompt` text instead of a redacted preview. */
  readonly showFullPrompt?: boolean;
  /** Preview length for redacted prompts (default 200). */
  readonly maxPromptPreview?: number;
}

const DEFAULT_PREVIEW = 200;

/**
 * POSIX-style quoting for **display only**. Never split or execute this
 * output — it exists so humans can eyeball the argv against Pi docs.
 */
export function quoteForDisplay(token: string): string {
  if (token.length === 0) return `""`;
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(token)) return token;
  // Double-quote with POSIX-ish escaping for readability.
  const escaped = token
    .replace(/\\/g, `\\\\`)
    .replace(/"/g, `\\"`)
    .replace(/\n/g, `\\n`)
    .replace(/\r/g, `\\r`)
    .replace(/\t/g, `\\t`);
  return `"${escaped}"`;
}

/**
 * Display-only single-line rendering of a spec.
 * WARNING: never execute this string — spawn `spec.command` with
 * `[...spec.args]` instead so quoting bugs cannot change semantics.
 */
export function formatPiSpecCommandForDisplay(spec: PiProcessSpec): string {
  return [spec.command, ...spec.args].map(quoteForDisplay).join(" ");
}

function escapePreview(text: string): string {
  return text
    .replace(/\\/g, `\\\\`)
    .replace(/\r/g, `\\r`)
    .replace(/\n/g, `\\n`)
    .replace(/\t/g, `\\t`)
    .replace(/"/g, `\\"`);
}

function summarizeList(
  values: readonly string[] | undefined,
  emptyLabel = "(none)",
): string {
  if (values === undefined) return `${emptyLabel} (unset)`;
  if (values.length === 0) return `(empty list)`;
  return values.join(", ");
}

function promptSummary(
  launch: PiLaunchResult,
  spec: PiProcessSpec,
  options: FormatInspectOptions,
): string {
  const max = options.maxPromptPreview ?? DEFAULT_PREVIEW;
  // Prefer the original intended text from the launch result (present even
  // when transport is temp-file, where spec.args carries the temp path).
  // Fall back to the argv value for older results without `promptText`.
  const index = spec.args.indexOf("--system-prompt");
  const hasFlag = index !== -1 && index + 1 < spec.args.length;
  if (!hasFlag && launch.promptText === undefined) return "(none)";
  const original = launch.promptText ?? (hasFlag ? (spec.args[index + 1] as string) : undefined);
  if (original === undefined) return "(none)";
  const where =
    launch.promptSource === "file"
      ? `file ${launch.promptFileRelativePath ?? "(unknown)"}`
      : launch.promptSource === "inline"
        ? "inline"
        : "unknown";
  const viaTemp =
    launch.promptTransport === "temp-file"
      ? `, via temp file ${launch.promptTempPath ?? "(unknown)"} — Pi file-or-text collision avoidance`
      : "";
  if (options.showFullPrompt) {
    return `${where} (${original.length} chars${viaTemp}): "${escapePreview(original)}"`;
  }
  const preview = original.length > max ? original.slice(0, max) : original;
  const suffix = original.length > max ? `... (+${original.length - max} more)` : "";
  return `${where} (${original.length} chars${viaTemp}): "${escapePreview(preview)}${suffix}"`;
}

/**
 * Render a redacted, human-readable inspect report.
 * Never used for execution — see module docs.
 */
export function formatPiInspect(
  profile: ResolvedPiProfile,
  launch: PiLaunchResult,
  options?: FormatInspectOptions,
): string {
  const opts = options ?? {};
  const spec = launch.spec;
  const lines: string[] = [];

  lines.push(`profile: ${profile.name} (extends: ${profile.extendsChain.length > 0 ? profile.extendsChain.join(" -> ") : "(none)"})`);
  lines.push(`  provider: ${profile.provider ?? "(none)"}`);
  lines.push(`  model: ${profile.model ?? "(none)"}`);
  lines.push(`  thinking: ${profile.thinking}`);
  lines.push(`  prompt: ${promptSummary(launch, spec, opts)}`);
  lines.push(`  tools: ${summarizeList(profile.tools)}`);
  lines.push(`  excludeTools: ${summarizeList(profile.excludeTools)}`);
  const skillsNote = profile.discoverSkills ? "discovery: on" : "discovery: off (--no-skills)";
  lines.push(`  skills: ${summarizeList(profile.skills)} (${skillsNote})`);
  const extNote = profile.discoverExtensions ? "discovery: on" : "discovery: off (--no-extensions)";
  lines.push(`  extensions: ${summarizeList(profile.extensions)} (${extNote})`);
  lines.push(
    `  contextFiles: ${profile.contextFiles ? "on" : "off (--no-context-files)"}`,
  );
  lines.push(
    `  session: ${profile.session}${profile.session === "ephemeral" ? " (--no-session)" : " (fresh: no session flags, never resumes)"}`,
  );
  if (profile.displayName !== undefined || profile.description !== undefined) {
    lines.push(
      `  display: ${profile.displayName ?? "(no displayName)"} — ${profile.description ?? "(no description)"} (display-only, ignored by launcher)`,
    );
  }
  lines.push(``);
  lines.push(`launch:`);
  lines.push(`  command: ${spec.command}`);
  lines.push(`  cwd: ${spec.cwd}`);
  const envKeys = Object.keys(spec.env);
  lines.push(`  env: ${envKeys.length === 0 ? "(none)" : envKeys.map((k) => `${k}=${spec.env[k]}`).join(" ")}`);
  lines.push(`  args (${spec.args.length}):`);
  for (let i = 0; i < spec.args.length; i++) {
    const token = spec.args[i] as string;
    if (token.startsWith("--") || token.startsWith("-")) {
      // Flag token: show value inline when the next token is its value.
      const next = spec.args[i + 1] as string | undefined;
      const flagTakesValue =
        next !== undefined &&
        !["--no-tools", "--no-skills", "--no-extensions", "--no-context-files", "--no-session"].includes(token);
      if (flagTakesValue && (token === "--provider" || token === "--model" || token === "--thinking" || token === "--tools" || token === "--exclude-tools" || token === "--skill" || token === "--extension")) {
        lines.push(`    ${token} ${quoteForDisplay(next)}`);
        i++;
      } else if (flagTakesValue && token === "--system-prompt") {
        const full = next;
        const max = opts.maxPromptPreview ?? DEFAULT_PREVIEW;
        if (launch.promptTransport === "temp-file") {
          // Temp-file transport: argv carries a short temp path whose file
          // contains the exact intended text (Pi file-or-text avoidance).
          const originalLen = launch.promptText?.length ?? full.length;
          lines.push(
            `    ${token} ${quoteForDisplay(full)} (temp file carrying ${originalLen}-char prompt — Pi collision avoidance)`,
          );
        } else if (opts.showFullPrompt) {
          lines.push(`    ${token} ${quoteForDisplay(full)} (${full.length} chars)`);
        } else {
          const preview = full.length > max ? `${full.slice(0, max)}... (+${full.length - max} more, ${full.length} total)` : `${full} (${full.length} chars)`;
          lines.push(`    ${token} ${quoteForDisplay(preview)} (redacted preview)`);
        }
        i++;
      } else {
        lines.push(`    ${token}`);
      }
    } else {
      lines.push(`    ${quoteForDisplay(token)}`);
    }
  }
  lines.push(``);
  lines.push(`  display command (DO NOT EXECUTE — display only, execution uses structured args):`);
  if (opts.showFullPrompt) {
    lines.push(`    ${formatPiSpecCommandForDisplay(spec)}`);
  } else {
    // Redacted display line: truncate --system-prompt so long prompts
    // never flood logs. Structured `spec.args` still carries the full text.
    const promptIndex = spec.args.indexOf("--system-prompt");
    if (promptIndex !== -1 && promptIndex + 1 < spec.args.length) {
      const full = spec.args[promptIndex + 1] as string;
      const max = opts.maxPromptPreview ?? DEFAULT_PREVIEW;
      const redacted =
        full.length > max ? `${full.slice(0, max)}... (+${full.length - max} more, ${full.length} total, redacted preview)` : full;
      const redactedArgs = [...spec.args];
      redactedArgs[promptIndex + 1] = redacted;
      lines.push(
        `    ${[spec.command, ...redactedArgs].map(quoteForDisplay).join(" ")}`,
      );
    } else {
      lines.push(`    ${formatPiSpecCommandForDisplay(spec)}`);
    }
  }
  lines.push(`  Pi CLI docs: https://github.com/up0to1/pi-mono/blob/main/packages/coding-agent/README.md`);

  return lines.join("\n");
}

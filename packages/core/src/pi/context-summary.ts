/**
 * Context-budget instrumentation (OP1.6 / JEF-10).
 *
 * `orca-pi profile inspect <name> --context-summary` reports a
 * regression/debug estimate of a profile's context cost: prompt size,
 * tool/skill/extension counts, and context-file policy. This is a heuristic
 * for comparing profiles and catching accidental bloat — not exact provider
 * token accounting (tokenizers differ per model/provider).
 */

import type { ResolvedPiProfile } from "../profile/types.js";

/** Heuristic context-cost estimate for one resolved profile. */
export interface ProfileContextSummary {
  readonly profileName: string;
  /** Prompt length in UTF-16 code units (`text.length`). */
  readonly promptChars: number;
  /** Prompt line count (empty prompt → 0). */
  readonly promptLines: number;
  /** Whitespace-separated word count (empty prompt → 0). */
  readonly promptWords: number;
  /**
   * Rough token estimate: `ceil(chars / 4)`. English prose averages ~4
   * chars/token; code/prompts vary widely. Debug/regression use only.
   */
  readonly estimatedTokens: number;
  readonly promptSource: "inline" | "file" | "none";
  readonly toolCount: number;
  readonly tools: readonly string[];
  readonly explicitSkillCount: number;
  readonly discoverSkills: boolean;
  readonly explicitExtensionCount: number;
  readonly discoverExtensions: boolean;
  readonly contextFiles: boolean;
  readonly thinking: string;
  readonly session: string;
  readonly hasModel: boolean;
}

/**
 * Token heuristic: ~4 chars per token. Documented as an estimate — never
 * substitute for provider usage/charging data.
 */
export function estimatePromptTokens(chars: number): number {
  if (chars <= 0) return 0;
  return Math.ceil(chars / 4);
}

/**
 * Summarize a resolved profile's context cost. `promptText` should be the
 * effective prompt (inline text or resolved file contents); when omitted,
 * the profile's inline `systemPrompt` length is used and file prompts report
 * 0 chars with `promptSource: "file"` (contents unknown without a launch).
 * Pure, never reads files.
 */
export function summarizeProfileContext(
  profile: ResolvedPiProfile,
  promptText?: string,
  promptSource?: "inline" | "file" | "none",
): ProfileContextSummary {
  const effectiveText =
    promptText ?? (profile.systemPrompt !== undefined ? profile.systemPrompt : "");
  const source: "inline" | "file" | "none" =
    promptSource ??
    (profile.systemPrompt !== undefined
      ? "inline"
      : profile.systemPromptFile !== undefined
        ? "file"
        : "none");
  // File prompts without resolved text: size unknown → report 0 with source.
  const chars =
    promptText !== undefined
      ? promptText.length
      : profile.systemPrompt !== undefined
        ? profile.systemPrompt.length
        : 0;
  const lines =
    chars === 0 ? 0 : effectiveText.length === 0 ? 0 : effectiveText.split("\n").length;
  const words =
    effectiveText.trim().length === 0 ? 0 : effectiveText.trim().split(/\s+/).length;
  const tools = profile.tools ?? [];
  const skills = profile.skills ?? [];
  const extensions = profile.extensions ?? [];
  return Object.freeze({
    profileName: profile.name,
    promptChars: chars,
    promptLines: lines,
    promptWords: words,
    estimatedTokens: estimatePromptTokens(chars),
    promptSource: source,
    toolCount: tools.length,
    tools: Object.freeze([...tools]) as readonly string[],
    explicitSkillCount: skills.length,
    discoverSkills: profile.discoverSkills,
    explicitExtensionCount: extensions.length,
    discoverExtensions: profile.discoverExtensions,
    contextFiles: profile.contextFiles,
    thinking: profile.thinking,
    session: profile.session,
    hasModel: profile.model !== undefined,
  });
}

/** Human-readable multi-line rendering for `profile inspect --context-summary`. */
export function formatContextSummary(summary: ProfileContextSummary): string {
  const lines: string[] = [];
  lines.push(`context summary for profile "${summary.profileName}" (estimates, not provider billing):`);
  lines.push(
    `  prompt: ${summary.promptChars} chars, ${summary.promptWords} words, ${summary.promptLines} lines, ~${summary.estimatedTokens} tokens (source: ${summary.promptSource})`,
  );
  lines.push(
    `  tools: ${summary.toolCount}${summary.tools.length > 0 ? ` (${summary.tools.join(", ")})` : " (unset — Pi defaults apply)"}`,
  );
  lines.push(
    `  skills: ${summary.explicitSkillCount} explicit, discovery ${summary.discoverSkills ? "on" : "off"}`,
  );
  lines.push(
    `  extensions: ${summary.explicitExtensionCount} explicit, discovery ${summary.discoverExtensions ? "on" : "off"}`,
  );
  lines.push(`  contextFiles: ${summary.contextFiles ? "on" : "off"}`);
  lines.push(`  thinking: ${summary.thinking}, session: ${summary.session}, model: ${summary.hasModel ? "set" : "(none — Pi default)"}`);
  return lines.join("\n");
}

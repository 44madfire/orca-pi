/**
 * Driver-context Pi extension.
 *
 * Injects the driver playbook (`playbook.md`, same directory) as a tagged
 * system-prompt section — but ONLY in sessions that register the `subagent`
 * tool, i.e. the driver session itself.
 *
 * Why an extension instead of a skill: the pi-subagents runtime inherits
 * parent skills into child sessions (only the `subagent`/`get_subagent_result`/
 * `steer_subagent` tools are stripped), so a skill body would leak driver-only
 * orchestration instructions into every leaf. Extension-appended sections are
 * rebuilt by each session's own extensions and never inherited, and the
 * `shouldInjectPlaybook` gate additionally no-ops in leaves (no `subagent`
 * tool) and in coordinator sessions (framework not loaded).
 *
 * Loaded via `profiles/driver.yaml` (`extensions:`), which is committed, so
 * the entry is valid in every Orca worktree by git construction.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** System-prompt section tag carrying the playbook. */
export const DRIVER_PLAYBOOK_SECTION = "driver_playbook" as const;

/** Tool whose presence identifies a driver session (registered by pi-subagents). */
export const SUBAGENT_TOOL_NAME = "subagent" as const;

/**
 * True when the session registers the `subagent` tool — i.e. this is the
 * driver, not a leaf (tools stripped by the recursion guard) or a
 * coordinator (framework not loaded).
 */
export function shouldInjectPlaybook(toolNames: readonly string[]): boolean {
  return toolNames.includes(SUBAGENT_TOOL_NAME);
}

/** Read the sibling playbook text. Empty when unreadable (fail silent, never break launch). */
export function loadPlaybook(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return readFileSync(join(here, "playbook.md"), "utf8").trim();
  } catch {
    return "";
  }
}

/** Minimal structural view of Pi's extension API — no Pi dependency required. */
export interface PlaybookToolInfo {
  name: string;
}

export interface PlaybookPromptOptions {
  sections: Record<string, string>;
}

export interface PlaybookAgentStartEvent {
  systemPromptOptions: PlaybookPromptOptions;
}

export interface PlaybookExtensionAPI {
  on(event: "before_agent_start", handler: (e: PlaybookAgentStartEvent) => void): void;
  getAllTools(): PlaybookToolInfo[];
}

export default function (pi: PlaybookExtensionAPI): void {
  const playbook = loadPlaybook();
  if (!playbook) return;
  pi.on("before_agent_start", (event) => {
    if (!shouldInjectPlaybook(pi.getAllTools().map((t) => t.name))) return;
    if (event.systemPromptOptions.sections[DRIVER_PLAYBOOK_SECTION]) return;
    event.systemPromptOptions.sections[DRIVER_PLAYBOOK_SECTION] = playbook;
  });
}

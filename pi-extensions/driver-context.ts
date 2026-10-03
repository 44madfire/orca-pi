/**
 * Driver-context Pi extension.
 *
 * Injects the driver playbook (`playbook.md`, same directory) for the driver
 * session — but ONLY in sessions that register the `subagent` tool.
 *
 * Why an extension instead of a skill: the pi-subagents runtime inherits
 * parent skills into child sessions (only the `subagent`/`get_subagent_result`/
 * `steer_subagent` tools are stripped), so a skill body would leak driver-only
 * orchestration instructions into every leaf. A `before_agent_start` handler
 * RETURN value replaces the prompt for the current turn only and is never
 * part of the inherited session state, and the `shouldInjectPlaybook` gate
 * additionally no-ops in leaves (no `subagent` tool) and in coordinator
 * sessions (framework not loaded).
 *
 * Pi-version contract: written against the Pi 0.84.4 API (the repo's stated
 * baseline; type-checked by `npm run typecheck:extensions`) and valid on Pi
 * 1.x too — it uses only `before_agent_start` + returned `systemPrompt` +
 * `getAllTools`, all present in both. It deliberately avoids the 1.x-only
 * `systemPromptOptions.sections` shape.
 *
 * Loaded via `profiles/driver.yaml` (`extensions:`), which is committed, so
 * the entry is valid in every Orca worktree by git construction.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

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

/** Render the turn prompt: base prompt plus the tagged playbook block. */
export function renderDriverPrompt(basePrompt: string, playbook: string): string {
  return `${basePrompt}\n\n<${DRIVER_PLAYBOOK_SECTION}>\n${playbook}\n</${DRIVER_PLAYBOOK_SECTION}>`;
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

export default function (pi: ExtensionAPI): void {
  const playbook = loadPlaybook();
  if (!playbook) return;
  pi.on("before_agent_start", (event: BeforeAgentStartEvent): BeforeAgentStartEventResult | void => {
    if (!shouldInjectPlaybook(pi.getAllTools().map((t) => t.name))) return;
    return { systemPrompt: renderDriverPrompt(event.systemPrompt, playbook) };
  });
}

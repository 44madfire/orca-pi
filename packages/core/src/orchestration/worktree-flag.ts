/**
 * Compact `--worktree` flag parsing (OP1.5 / JEF-9).
 *
 * The Pi-facing surface keeps one flag:
 *
 * ```text
 * --worktree current | new-child | new-top-level | <selector>
 * ```
 *
 * where `<selector>` is any existing-worktree selector Orca already
 * understands (`active`, `id:<repo>::<path>`, `name:...`, `path:...`,
 * `branch:...`, ...). New worktrees additionally require `--name` (plus
 * optional `--parent-worktree`, `--base-branch`, `--setup`); the parser
 * fails closed before any Orca effects when the combination is invalid.
 *
 * This module never touches Orca — it only maps CLI strings to the typed
 * {@link WorktreePolicy} JEF-8's supervised adapter already enforces.
 */

import type { WorktreePolicy, WorktreeSetupPolicy } from "../orca/receipts.js";

export class WorktreeFlagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeFlagError";
  }
}

export interface WorktreeFlagOptions {
  /** Raw `--worktree` value (defaults to `"current"` when omitted). */
  readonly worktree?: string;
  /** Required for `new-child` / `new-top-level` (Orca `--name`). */
  readonly name?: string;
  /** Explicit parent for `new-child` (`--parent-worktree`, default derived). */
  readonly parentWorktree?: string;
  /** Git base for new worktrees (`--base-branch`). */
  readonly baseBranch?: string;
  /** Setup policy for new worktrees (`--setup run|skip|inherit`). */
  readonly setup?: string;
}

const SETUP_VALUES: readonly WorktreeSetupPolicy[] = ["run", "skip", "inherit"];

function isSetupPolicy(value: string): value is WorktreeSetupPolicy {
  return (SETUP_VALUES as readonly string[]).includes(value);
}

/**
 * Parse compact worktree flags into a typed {@link WorktreePolicy}.
 *
 * @throws {@link WorktreeFlagError} on missing names, stray flags for
 * `current`/`existing`, or invalid `--setup` values. All failures happen
 * before any Orca process starts.
 */
export function parseWorktreeFlag(options?: WorktreeFlagOptions): WorktreePolicy {
  const raw = (options?.worktree ?? "current").trim();
  const name = options?.name?.trim();
  const parentWorktree = options?.parentWorktree?.trim();
  const baseBranch = options?.baseBranch?.trim();
  const setupRaw = options?.setup?.trim();

  let setup: WorktreeSetupPolicy | undefined;
  if (setupRaw !== undefined && setupRaw.length > 0) {
    if (!isSetupPolicy(setupRaw)) {
      throw new WorktreeFlagError(
        `Invalid --setup "${options?.setup}": expected one of run|skip|inherit.`,
      );
    }
    setup = setupRaw;
  }

  const normalized = raw.toLowerCase();
  if (normalized === "current" || normalized === "active") {
    if (name !== undefined && name.length > 0) {
      throw new WorktreeFlagError(
        `Invalid worktree flags: --name is only valid with --worktree new-child|new-top-level, not "${raw}".`,
      );
    }
    if (parentWorktree !== undefined && parentWorktree.length > 0) {
      throw new WorktreeFlagError(
        `Invalid worktree flags: --parent-worktree is only valid with --worktree new-child, not "${raw}".`,
      );
    }
    if (baseBranch !== undefined && baseBranch.length > 0) {
      throw new WorktreeFlagError(
        `Invalid worktree flags: --base-branch is only valid with --worktree new-child|new-top-level, not "${raw}".`,
      );
    }
    if (setup !== undefined) {
      throw new WorktreeFlagError(
        `Invalid worktree flags: --setup is only valid with --worktree new-child|new-top-level, not "${raw}".`,
      );
    }
    return { kind: "current" };
  }

  if (normalized === "new-child" || normalized === "new-top-level") {
    if (name === undefined || name.length === 0) {
      throw new WorktreeFlagError(
        `Invalid worktree flags: --worktree ${raw} requires --name <worktree-name> (e.g. --name my-worker).`,
      );
    }
    if (normalized === "new-top-level" && parentWorktree !== undefined && parentWorktree.length > 0) {
      throw new WorktreeFlagError(
        `Invalid worktree flags: --parent-worktree is only valid with --worktree new-child, not new-top-level.`,
      );
    }
    if (normalized === "new-child") {
      return {
        kind: "new-child",
        name,
        ...(parentWorktree !== undefined && parentWorktree.length > 0
          ? { parentWorktree }
          : {}),
        ...(baseBranch !== undefined && baseBranch.length > 0 ? { baseBranch } : {}),
        ...(setup !== undefined ? { setup } : {}),
      };
    }
    return {
      kind: "new-top-level",
      name,
      ...(baseBranch !== undefined && baseBranch.length > 0 ? { baseBranch } : {}),
      ...(setup !== undefined ? { setup } : {}),
    };
  }

  if (raw.length === 0) {
    throw new WorktreeFlagError(
      `Invalid --worktree "": expected current|new-child|new-top-level|<existing-selector> (e.g. active, id:<repo>::<path>, name:My Work).`,
    );
  }
  // Existing selector passthrough (validated by Orca at resolve time).
  if (name !== undefined && name.length > 0) {
    throw new WorktreeFlagError(
      `Invalid worktree flags: --name is only valid with --worktree new-child|new-top-level, not with existing selector "${raw}".`,
    );
  }
  if (parentWorktree !== undefined && parentWorktree.length > 0) {
    throw new WorktreeFlagError(
      `Invalid worktree flags: --parent-worktree is only valid with --worktree new-child, not with existing selector "${raw}".`,
    );
  }
  if (baseBranch !== undefined && baseBranch.length > 0) {
    throw new WorktreeFlagError(
      `Invalid worktree flags: --base-branch is only valid with --worktree new-child|new-top-level, not with existing selector "${raw}".`,
    );
  }
  if (setup !== undefined) {
    throw new WorktreeFlagError(
      `Invalid worktree flags: --setup is only valid with --worktree new-child|new-top-level, not with existing selector "${raw}".`,
    );
  }
  return { kind: "existing", selector: raw };
}

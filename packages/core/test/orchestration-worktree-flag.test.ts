import { describe, expect, it } from "vitest";
import { parseWorktreeFlag, WorktreeFlagError } from "../src/orchestration/worktree-flag.js";

describe("parseWorktreeFlag", () => {
  it("defaults to current", () => {
    expect(parseWorktreeFlag()).toEqual({ kind: "current" });
    expect(parseWorktreeFlag({})).toEqual({ kind: "current" });
    expect(parseWorktreeFlag({ worktree: "current" })).toEqual({ kind: "current" });
    expect(parseWorktreeFlag({ worktree: "active" })).toEqual({ kind: "current" });
  });

  it("parses existing selectors passthrough", () => {
    expect(parseWorktreeFlag({ worktree: "id:repo::/path" })).toEqual({
      kind: "existing",
      selector: "id:repo::/path",
    });
    expect(parseWorktreeFlag({ worktree: "name:My Work" })).toEqual({
      kind: "existing",
      selector: "name:My Work",
    });
  });

  it("requires --name for new worktrees", () => {
    expect(parseWorktreeFlag({ worktree: "new-child", name: "w" })).toMatchObject({
      kind: "new-child",
      name: "w",
    });
    expect(parseWorktreeFlag({ worktree: "new-top-level", name: "w" })).toMatchObject({
      kind: "new-top-level",
      name: "w",
    });
    expect(() => parseWorktreeFlag({ worktree: "new-child" })).toThrowError(WorktreeFlagError);
    expect(() => parseWorktreeFlag({ worktree: "new-top-level" })).toThrowError(WorktreeFlagError);
  });

  it("passes parent/base-branch/setup for new worktrees", () => {
    expect(
      parseWorktreeFlag({
        worktree: "new-child",
        name: "w",
        parentWorktree: "id:repo::/parent",
        baseBranch: "origin/main",
        setup: "run",
      }),
    ).toMatchObject({
      kind: "new-child",
      name: "w",
      parentWorktree: "id:repo::/parent",
      baseBranch: "origin/main",
      setup: "run",
    });
    expect(() => parseWorktreeFlag({ worktree: "new-child", name: "w", setup: "sometimes" })).toThrowError(
      WorktreeFlagError,
    );
  });

  it("rejects stray flags for current/existing", () => {
    expect(() => parseWorktreeFlag({ worktree: "current", name: "w" })).toThrowError(WorktreeFlagError);
    expect(() => parseWorktreeFlag({ worktree: "active", setup: "run" })).toThrowError(WorktreeFlagError);
    expect(() => parseWorktreeFlag({ worktree: "id:x", name: "w" })).toThrowError(WorktreeFlagError);
    expect(() => parseWorktreeFlag({ worktree: "new-top-level", name: "w", parentWorktree: "id:x" })).toThrowError(
      WorktreeFlagError,
    );
  });
});

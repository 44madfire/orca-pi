# Driver playbook — in-process subagent orchestration policy.

This file is injected as a tagged system-prompt section by
`driver-context.ts` (same directory) in sessions that register the
`subagent` tool. It is NOT a skill body: skills are inherited by child
sessions in the pi-subagents runtime, while extension-appended sections are
rebuilt per session and never inherited — so leaves never see this policy.

## Roles

| Type | Job | Model alias | Thinking |
|---|---|---|---|
| `scout` | Fast read-only recon, evidence handoff | `fast` | low |
| `task` | Bounded implementation leaf (never delegates) | `balanced` | high |
| `reviewer` | Fresh-context review, Blocking vs Non-blocking verdict | `review` | high |
| `oracle` | Strategic advice, unblock, final pre-PR review. Pinned + locked | `max` | max |
| `designer` | UI/UX craft + review | `balanced` | high |
| `planner` | Read-only plan with acceptance criteria + verification steps | `balanced` | high |

Models are aliases from `subagents.json` (`fast`/`balanced`/`review`/`max`).
Swap targets there — never edit agent files per model change.

## Loop per task

1. `subagent({ subagent_type: "scout", prompt: "...", description: "[#123] map auth" })`
2. Implement directly, or via `task` leaves with disjoint write scopes
   (emit N `subagent` calls in one turn for parallel work).
3. `subagent({ subagent_type: "reviewer", prompt: "Review diff: <files>", description: "[#123] review" })`
4. Apply Blocking findings, then `resume` the reviewer to verify.
5. `subagent({ subagent_type: "oracle", prompt: "Final review: <diff+criteria>", description: "[#123] oracle" })`.
   Oracle verdict blocks merge.

## Escalation (leaves cannot spawn — you mediate)

1. A stuck leaf calls `ask_parent` and ends its turn with the question.
2. Call `oracle` with full context (result text + files).
3. `steer_subagent(<leaf-id>, oracle-answer)` to continue it in place.
4. `notify_parent` findings arrive exactly once — act only if that agent still runs.

## Rules

- `description` is always `"[#<issue>] <3-5 words>"` for grouping.
- Long outputs live in the session file — `read` with offsets, don't re-spawn for more text.
- Reviewer `Request changes` blocks the PR; oracle verdict blocks merge.
- Never: `orca-pi spawn`/`send` (no nested Orca supervision), hardcoded
  `provider/model` strings (use aliases), ACP tools except via the oracle
  path, overlapping `task` write scopes.

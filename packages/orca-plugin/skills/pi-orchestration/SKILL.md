---
name: pi-orchestration
description: Delegate to in-process subagents (scout/task/reviewer/oracle/designer/planner) via the subagent tool with model aliases. Use when implementing inside a driver Pi session. Never use for Orca Tasks/Dispatches — that is orca-pi-orchestration.
---

# pi Orchestration (driver layer)

You are inside a **driver** session. Fan out with `subagent`, never with
`orca-pi spawn` (no nested Orca supervision).

## Roles

| Type | Job | Model alias | Tools |
|---|---|---|---|
| `scout` | Fast read-only recon, evidence handoff | `fast` / low | read-only |
| `task` | Bounded implementation chunk (leaf, never delegates) | `balanced` / high | full incl. edit/write |
| `reviewer` | Fresh-context review, Blocking vs Non-blocking verdict | `review` / high | read-only + bash |
| `oracle` | Strategic advice, unblock, final pre-PR review. Pinned + locked | `max` / max | read-only |
| `designer` | UI/UX craft + review | `balanced` / high | full |
| `planner` | Read-only plan with acceptance criteria + verification steps | `balanced` / high | read-only + bash |

Models are aliases from `subagents.json` (`fast/balanced/review/max`).
Swap targets there — never edit agent files per model change.

## Loop per task

```text
subagent({ subagent_type: "scout", prompt: "...", description: "[#123] map auth" })
→ implement (directly or via task leaf with disjoint write scopes)
→ subagent({ subagent_type: "reviewer", prompt: "Review diff: <files>", description: "[#123] review" })
→ apply Blocking findings → resume reviewer to verify
→ subagent({ subagent_type: "oracle", prompt: "Final review: <diff+criteria>", description: "[#123] oracle" })
```

Parallel: emit N `subagent` calls in one turn (disjoint scopes).
Dependent: chain via results, or `resume: <session-id>` to continue an agent.

## Escalation (leaves cannot spawn — you mediate)

1. Leaf stuck → it calls `ask_parent`, ends turn with the question.
2. You call `oracle` with full context (result text + files).
3. You `steer_subagent(<leaf-id>, oracle-answer)` to continue in place.
4. Mid-run findings arrive via `notify_parent` exactly once — act only if the agent still runs.

## Rules

- `description`: always `"[#<issue>] <3-5 words>"` for grouping.
- `resultCap`: long outputs live in the session file — `read` with offsets, don't re-spawn for more text.
- Reviewer verdict `Request changes` blocks the PR; oracle verdict blocks merge.
- Never: `orca-pi spawn/send`, hardcoded `provider/model` strings, ACP tools except via oracle path, broad `task` scopes that overlap.

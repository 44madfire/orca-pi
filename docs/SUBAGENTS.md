# Two-layer orchestration: Orca per issue, gotgenes per role

Orca supervises **processes** (durable, auditable, per-GitHub-issue).
Gotgenes supervises **turns** (surgical steer, bottom-up questions, cheap
resume). Use both, each where it wins.

```text
orchestrator-me (coordinator profile + orca-pi-orchestration skill)
  └─ orca-pi spawn driver --task "#123 ..." --worktree new-child   (per issue)
       └─ orchestrator-pi (driver profile + pi-orchestration skill + fork ext.)
            ├─ subagent(scout) → evidence handoff
            ├─ implement (directly or task leaves, disjoint scopes)
            ├─ subagent(reviewer) → Blocking? fix → resume reviewer
            └─ subagent(oracle, locked max) → final verdict before PR
```

## Separation (by absence, not instruction)

| Session | Gets | Never gets |
|---|---|---|
| coordinator | `orca-pi-orchestration` skill, `read+bash` (runs `orca-pi`) | `pi-orchestration`, pi-subagents ext., `acp_*` |
| driver | `pi-orchestration` skill, fork ext., full tools | `orca-pi-orchestration`, `orca-pi spawn` |
| leaves | role `.md` only, `tools:` allowlist | both skills, `acp_*` (except oracle path), nested `subagent*` (stripped by core) |

A coordinator has no `subagent` tool to misuse; a driver has no `orca-pi
spawn` to misuse. Skill descriptions route loading:
"supervising Pi workers through Orca Tasks/Dispatches" vs "delegating to
in-process subagents within this Pi session".

## Setup

1. Fork ext.: `git clone https://github.com/44madfire/pi-packages
   third-party/pi-packages` (branch `feat/model-aliases` until merged;
   see [PR #1](https://github.com/44madfire/pi-packages/pull/1)). Point the
   driver profile's `extensions` at
   `third-party/pi-packages/packages/pi-subagents/src/index.ts` via a
   project-local `profiles.yaml` override (schema requires project-relative
   paths — see `profiles/driver.yaml`).
2. Roles: `cp agents/*.md ~/.pi/agent/agents/` (project override:
   `<root>/.pi/agents/<name>.md`).
3. Aliases: merge `subagents/subagents.json.example` → `~/.pi/agent/subagents.json`,
   pointing `fast/balanced/review/max` at models you have auth for
   (`/login` subscriptions preferred over bridges; ACP only for providers Pi
   can't auth — oracle path only).
4. Validate: `orca-pi profile inspect coordinator|driver --project-root .`,
   `node scripts/check-skill-size.mjs`, `npm test`.

## Escalation (leaves can't nest)

Gotgenes removes `subagent` tools from every child — oracle queries are
driver-mediated: leaf `ask_parent` (ends turn) → driver calls `oracle` with
full context → driver `steer_subagent`s the leaf. `notify_parent` findings
arrive exactly once; act only if the agent still runs.

## Conventions

- `description: "[#<issue>] <3-5 words>"` on every spawn (grouping).
- Reviewer `Request changes` blocks the PR; oracle verdict blocks merge.
- `resultCap`: long outputs live in the session file — `read` with offsets.
- Model swaps happen ONLY in `subagents.json` `modelAliases`, never in agent files.

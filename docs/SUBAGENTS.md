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
| coordinator | `orca-pi-orchestration` skill, `read+bash` (runs `orca-pi`) | pi-subagents ext., `subagent*` tools, `acp_*` |
| driver | vendored framework + `driver-context` ext. (policy as tagged section), full tools, no skills | `orca-pi-orchestration`, `orca-pi spawn` mandate |
| leaves | role `.md` only, `tools:` allowlist | nested `subagent*` (stripped by core); `pi-orchestration` skill is a pointer stub, and the `driver_playbook` section is rebuilt per session so leaves never see it |

A coordinator has no `subagent` tool to misuse. Shell caveat: the driver
keeps `bash` for implementation, so `orca-pi spawn` remains *executable*
there — the boundary is enforced where the platform allows
(tools/skills/extensions) and audited elsewhere: any non-coordinator
dispatch is a bug, visible in `orca-pi status` sweeps; fence with
`orca-pi stop` and report.

## Setup

1. Framework: already vendored at `third-party/pi-subagents` (pinned; see
   `VENDOR.md`). Refresh with `node scripts/vendor-pi-subagents.mjs`
   (defaults track the fork until upstream PR #1 merges, then `--ref main`).
   Because it is committed, `profiles/driver.yaml`'s extension entries are
   valid in every Orca worktree by git construction.
2. Install profiles (one-time, same flow as `profiles/examples.yaml`): copy
   the `coordinator:`/`driver:` blocks into `$PI_CODING_AGENT_DIR/profiles.yaml`
   or `<projectRoot>/.pi/profiles.yaml`.
3. Roles: `cp agents/*.md ~/.pi/agent/agents/` (project override:
   `<root>/.pi/agents/<name>.md`).
4. Aliases: merge `subagents/subagents.json.example` → `~/.pi/agent/subagents.json`,
   pointing `fast/balanced/review/max` at models you have auth for
   (`/login` subscriptions preferred over bridges; ACP only for providers Pi
   can't auth — oracle path only).
5. Validate: `orca-pi profile inspect coordinator|driver --project-root .`,
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

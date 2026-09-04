---
name: orca-pi-orchestration
description: Coordinate role-specialized Orca-supervised Pi workers via the compact orca-pi CLI (spawn, status, send, wait, stop) without loading Orca's full orchestration guide. Use when supervising Pi workers through Orca Tasks/Dispatches.
---

# orca-pi Orchestration

Use `orca-pi` when you supervise Pi workers through Orca. Do not load
`orca skills get orchestration --full` for normal worker lifecycle — the
compact commands below cover it.

Orca owns Runs, Tasks, Dispatches, worktrees, and completion. `orca-pi`
only carries Orca's identities with stable receipts. Never treat terminal
output as completion/status authority — use `status`/`wait`.

## Profiles by role

Choose a profile by role; never reproduce model/tool/skill settings here:

- `scout` — read-only inspection, evidence-backed handoff.
- `worker` — bounded implementation with validation.
- `reviewer` — independent evaluation, no edits.

Role policy, models, tools, and prompts stay in profile config
(`orca-pi profiles list`, `orca-pi profile show <name>`).

## Commands

All commands support `--json` (preferred for agents). Human output is
concise by default.

```sh
orca-pi profiles list
orca-pi spawn <profile> --task <spec> --worktree current --json
orca-pi spawn worker --task-id <task-id> --json
orca-pi status --worker <dispatch> --json
orca-pi status --task <task-id> --json
orca-pi status --json
orca-pi send --worker <dispatch> --message <text> --json
orca-pi wait --worker <dispatch> --timeout 10m --json
orca-pi wait --task <task-id> --timeout 5m --json
orca-pi stop --worker <dispatch> --json
```

- `spawn` resolves the profile pre-launch (unknown profiles fail before
  Orca effects) and returns one receipt (`taskId`, `dispatchId`,
  `terminalHandle`, worktree). Use `--task` for inline specs,
  `--task-id` for existing Tasks.
- `status` reads Task/Dispatch state. Bare `status` sweeps workers
  (tasks need a bound Run).
- `send` delivers coordinator follow-up mail (`--to dispatch:<id>`);
  it never sends `worker_done`/`heartbeat` (worker-owned signals).
- `wait` polls Orca state with backoff until `completed`/`failed` or
  `--timeout` (e.g. `30s`, `5m`, `1h`; default `15m`). Timeouts mean
  "still running", never failure.
- `stop` fences the worker terminal idempotently (`alreadyStopped`
  on repeats). It never marks the Task complete/failed.

## Worktree policy

- `current` (default): coordinator checkout, no setup rerun.
- `new-child` / `new-top-level`: require `--name`; isolated checkouts.
- Existing selector (`active`, `id:…`, `name:…`, `path:…`): shared checkout.

New worktrees accept `--base-branch`/`--setup`; `current`/existing
reject them. Keep workers in `current` unless isolation requires otherwise.

## Flow

```sh
orca-pi spawn scout --task "Map auth flow; cite files" --json
orca-pi wait --task <scout-task> --timeout 10m --json
orca-pi spawn worker --task "Implement fix per scout handoff" --json
orca-pi send --worker <dispatch> --message "Prefer X; see Y" --json
orca-pi wait --worker <dispatch> --timeout 15m --json
orca-pi spawn reviewer --task "Review diff for <task>" --json
orca-pi stop --worker <dispatch> --json
```

After each `worker_done`, reuse the worker for a follow-up Task, or
release/stop it before waiting again. For full Orca semantics, load the
upstream guide explicitly; do not copy it here.

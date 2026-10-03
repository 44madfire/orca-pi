# agents/

Gotgenes subagent role definitions for the driver layer
(`profiles/driver.yaml` + `pi-orchestration` skill). These are **templates** —
copy them into Pi's agent directory; they are not loaded from this repo
directly.

## Install

```sh
# 1. Framework is vendored in this repo (third-party/pi-subagents, see VENDOR.md).
#    No clone needed. Refresh after upstream changes:
#    node scripts/vendor-pi-subagents.mjs

# 2. Copy roles to Pi's global agent dir
mkdir -p ~/.pi/agent/agents
cp agents/*.md ~/.pi/agent/agents/

# 3. Merge aliases into Pi settings (create if absent)
# See subagents/subagents.json.example — copy modelAliases into
# ~/.pi/agent/subagents.json and point each alias at a real
# provider/model-id you have auth for.
```

Project overrides: copy any file to `<projectRoot>/.pi/agents/<name>.md` —
project wins over global for the same filename.

## Roles

| File | Job | Model alias | Thinking | Mode |
|---|---|---|---|---|
| `scout.md` | Read-only recon, evidence handoff | `fast` | low | replace |
| `task.md` | Bounded implementation leaf | `balanced` | high | append |
| `reviewer.md` | Fresh-context review, verdict blocks PR | `review` | high | replace |
| `oracle.md` | Strategic advice, final review. Pinned + `locked` | `max` | max | replace |
| `designer.md` | UI/UX craft + review | `balanced` | high | append |
| `planner.md` | Read-only plan with acceptance criteria | `balanced` | high | replace |

Adapted from `oh-my-opencode-slim` role prompts; OpenCode-only tools
(`glob`, `ast_grep_search`, `context7`, `gh_grep`) mapped to Pi built-ins
(`find`/`ls`, `grep`, repo `read`). Pi built-ins are only
`read/bash/edit/write/grep/find/ls` — agent `tools:` must stay within that
set plus explicitly installed extension tools.

## Leaf rule

Gotgenes strips `subagent`/`get_subagent_result`/`steer_subagent` from every
child unconditionally — leaves **cannot nest**. Escalation is always
driver-mediated: leaf `ask_parent` (ends its turn) → driver calls `oracle` →
driver continues the leaf via `subagent` with `resume:` (`steer_subagent`
rejects ended turns). `task.md`/`scout.md` restate the no-nesting rule so the
model doesn't try.

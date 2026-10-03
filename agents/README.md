# agents/

Gotgenes subagent role definitions for the driver layer
(`profiles/driver.yaml` + `pi-extensions/`). These are **templates** —
copy them into Pi's agent directory; they are not loaded from this repo
directly. Files intentionally carry no `model`/`thinking` — tiers resolve
per call from `model-aliases.json` via the model-aliases extension.

## Install

```sh
# 1. Framework (pinned stock, no fork): one-time per machine
pi install npm:@gotgenes/pi-subagents@22.0.0
#    optionally also declare it in ~/.pi/agent/settings.json:
#    { "packages": ["npm:@gotgenes/pi-subagents@22.0.0"] }

# 2. Copy roles to Pi's global agent dir
mkdir -p ~/.pi/agent/agents
cp agents/*.md ~/.pi/agent/agents/

# 3. Install the alias map (create if absent)
# See model-aliases/model-aliases.json.example — copy to
# ~/.pi/agent/model-aliases.json and point each alias at a real
# provider/model-id you have auth for.
```

Project overrides: copy any file to `<projectRoot>/.pi/agents/<name>.md` —
project wins over global for the same filename.

## Roles

| File | Job | Spawn alias | Mode |
|---|---|---|---|
| `scout.md` | Read-only recon, evidence handoff | `fast` | replace |
| `task.md` | Bounded implementation leaf | `balanced` | append |
| `reviewer.md` | Fresh-context review, verdict blocks PR | `review` | replace |
| `oracle.md` | Strategic advice, final review (model per call) | `max` | replace |
| `designer.md` | UI/UX craft + review | `balanced` | append |
| `planner.md` | Read-only plan with acceptance criteria | `balanced` | replace |

Pass the alias as the spawn's `model` (the model-aliases extension
substitutes tiers + fallbacks; see `pi-extensions/playbook.md` for the full
mapping table).

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

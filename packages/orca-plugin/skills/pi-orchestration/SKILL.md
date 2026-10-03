---
name: pi-orchestration
description: Pointer to the driver playbook. The policy itself is injected by the pi-extensions/driver-context extension in driver sessions only; this skill carries no orchestration instructions so inheriting it is harmless. Human entry point for the driver layer — see docs/SUBAGENTS.md.
---

# pi Orchestration (pointer)

Driver orchestration policy is **not** stored here. It lives in
`pi-extensions/playbook.md` and is injected as a tagged system-prompt
section by `pi-extensions/driver-context.ts`, which only activates in
sessions registering the `subagent` tool (the driver).

Why: the pi-subagents runtime inherits parent skills into child sessions,
so a skill body would leak driver-only instructions into every leaf.
Extension-appended sections are rebuilt per session and never inherited.

- Driver profile: `profiles/driver.yaml` (loads the vendored framework +
  `driver-context` extension; no skills attached).
- Roles: `agents/*.md`. Aliases: `subagents/subagents.json.example`.
- Full design: `docs/SUBAGENTS.md`.

---
name: orca-pi-github
description: Push branches and open PRs as orca-pi-worker[bot] via scoped broker (setup-git + github exec). Use when worker needs git push / gh pr create without touching global config.
---

# orca-pi GitHub worker

In worker terminals `ORCA_PI_GITHUB_IDENTITY=worker` is already injected — inherit it, don't pass `--identity` (explicit `--identity` must match the profile's `githubIdentity`).

## Push + PR

```sh
orca-pi github setup-git --identity worker --path .
git commit -m "…"
git push origin HEAD   # git only; gh still needs exec below
orca-pi github exec -- git push origin HEAD
orca-pi github exec -- gh pr create --title "…" --body "…"
orca-pi github exec -- gh pr edit <n> --add-label "…"
```

- `setup-git` is worktree-scoped (never `--global`/`--system`); it resets inherited helpers so the worker helper wins deterministically.
- `gh` ignores git helpers — always use `exec` for `gh` writes.
- SSH remotes fail closed (`ssh-guard`, exit 128); use HTTPS.

## Rules

- Never ambient `GH_TOKEN`/PAT, never `exec -- env` (child sees short-lived `GH_TOKEN`), never secrets in prompts/task text/logs.
- Tokens resolve via `ORCA_PI_GITHUB_WORKER_TOKEN` or App mint (`…_APP_ID` + `…_PRIVATE_KEY_PATH` + `…_INSTALLATION_ID`); mint outside LLM (`orca-pi github mint --identity worker`).
- Worker never reviews: formal `review`/`check` stay on reviewer identity. Verify author is `orca-pi-worker[bot]`, not `44madfire`.
- Diagnostics (non-secret): `orca-pi github auth status --identity worker`, `orca-pi github identity doctor --repo 44madfire/orca-pi`.

See `docs/GITHUB_IDENTITIES.md` for App perms and trust model.

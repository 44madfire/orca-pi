# GitHub identities — worker bot, reviewer bot, human (OP1.12)

Target actor model for normal development:

```text
Orca-Pi Worker    -> orca-pi-worker[bot]    -> branches / pushes / PR creation
Orca-Pi Reviewer  -> orca-pi-reviewer[bot]  -> formal reviews + orca-pi/agent-review check
ChatGPT / human   -> 44madfire               -> independent review + final merge authority
```

Invariant:

```text
worker bot != reviewer bot != 44madfire
```

A PR authored by the worker bot is therefore reviewable/approvable by both
the reviewer bot and `44madfire` without GitHub self-review restrictions.
Do not reconfigure or impersonate the ChatGPT GitHub connector — it acts as
`44madfire`, which is distinct from worker-authored PRs. The same
`44madfire` identity may perform ChatGPT-assisted review and the final human
squash merge; the important property is that it is not the PR author.

## App permissions

**Worker App** (`orca-pi-worker` suggested slug, install only on
`44madfire/orca-pi` initially):

- Contents: write (branches/pushes)
- Pull requests: write (PR create/update)
- Metadata: read
- Checks: none

**Reviewer App** (`orca-pi-reviewer` suggested slug, install only on
`44madfire/orca-pi` initially):

- Contents: read only (never write)
- Pull requests: write (formal reviews)
- Checks: write (`orca-pi/agent-review`)
- Metadata: read

Never grant Contents: write to the reviewer. Never commit private keys,
installation tokens, webhook secrets, or PATs.

## Profile → actor propagation (authoritative)

`ResolvedPiProfile.githubIdentity` controls the effective GitHub actor
automatically:

```text
ResolvedPiProfile.githubIdentity
          |
          +-- worker   -> Worker App credential
          +-- reviewer -> Reviewer App credential
```

- Built-ins: `worker → worker`, `reviewer → reviewer`, `scout → (none)`.
- `spawn` records `githubIdentity` in the receipt and prefixes the worker
  terminal command with per-terminal env
  (`ORCA_PI_GITHUB_IDENTITY=<identity> ORCA_PI_PROFILE=<profile> pi …`) —
  scoped to that terminal, never global `git config` or ambient `GH_TOKEN`.
- Inside a worker terminal, prefer inheritance — do not repeat `--identity`:

```sh
# Worker terminal (ORCA_PI_GITHUB_IDENTITY=worker already set):
orca-pi github exec -- git push origin HEAD
orca-pi github exec -- gh pr create --title "…" --body "…"

# Reviewer terminal (ORCA_PI_GITHUB_IDENTITY=reviewer):
orca-pi github review --pr <url> --verdict request-changes --body @/tmp/review.md
orca-pi github check complete --repo 44madfire/orca-pi --sha <sha> --verdict request-changes --summary "…"
```

- Explicit `--identity` is retained for diagnostics/admin use but must
  match the profile: reviewer profiles cannot select worker credentials
  (Contents: write) and worker profiles cannot select reviewer credentials
  (Checks: write). Mismatches fail closed. `--profile <name>` may be used
  instead of `--identity` to inherit explicitly.

## Out-of-LLM credential mint/refresh

Installation tokens are short-lived. Mint/refresh outside model context:

```sh
# One-time App bootstrap (non-secret steps only; values never printed):
orca-pi github setup --identity worker --repo 44madfire/orca-pi
orca-pi github setup --identity reviewer --repo 44madfire/orca-pi

# Required env (shell profile / OS secret store → env, never prompt/task/profile text):
#   ORCA_PI_GITHUB_WORKER_APP_ID, ORCA_PI_GITHUB_WORKER_PRIVATE_KEY_PATH,
#   ORCA_PI_GITHUB_WORKER_INSTALLATION_ID, ORCA_PI_GITHUB_WORKER_LOGIN
#   ORCA_PI_GITHUB_REVIEWER_APP_ID, ORCA_PI_GITHUB_REVIEWER_PRIVATE_KEY_PATH,
#   ORCA_PI_GITHUB_REVIEWER_INSTALLATION_ID, ORCA_PI_GITHUB_REVIEWER_LOGIN
#
# Private-key paths support ~ (HOME), Windows C:\… and WSL /mnt/c/… forms.
# Store .pem files with mode 0600 outside the repo.

# Mint (outside LLM context; prints expiry/installation/cache-path only):
orca-pi github mint --identity worker
orca-pi github mint --identity reviewer

# Verify (non-secret diagnostics only):
orca-pi github auth status --identity worker
orca-pi github auth status --identity reviewer
orca-pi github identity doctor --repo 44madfire/orca-pi --ambient 44madfire
```

`ensureInstallationToken` order: in-memory cache → fresh
`ORCA_PI_GITHUB_<IDENT>_TOKEN` → disk cache
(`<config-dir>/github-tokens/<identity>.json`, mode 0600) → App private-key
mint. Expiry is recorded and refreshed before expiration (5-minute skew).
Existing reviewer fail-closed installation-token verification
(`GET /installation/repositories` + trusted App login + distinct-from-author)
remains intact; worker writes use the parallel worker preflight.

A reproducible helper wraps the same flow:

```sh
node scripts/setup-github-apps.mjs --repo 44madfire/orca-pi
node scripts/setup-github-apps.mjs --repo 44madfire/orca-pi --json
```

It never prints secrets — only var names, permissions, and next actions.

## Worker Git/GitHub ergonomics (scoped broker)

Prefer the broker over raw tokens in agent env:

```sh
# Scoped child-process execution (GH_TOKEN/GITHUB_TOKEN only for the child):
orca-pi github exec --identity worker -- git push origin HEAD
orca-pi github exec --identity worker -- gh pr create --title "…" --body "…"
orca-pi github exec --identity worker -- gh pr edit <n> --add-label "…"

# Repo-local git helper (per worktree, never --global/--system):
orca-pi github setup-git --identity worker --path /path/to/worker-checkout
# Then normal ergonomics work inside that checkout:
git push origin HEAD
gh pr create --title "…" --body "…"
```

`setup-git` runs `git -C <path> config --local credential.helper
"orca-pi github git-credential --identity worker"` — `--local` only.
`git-credential get` mints via the out-of-LLM provider and pipes
`username=x-access-token / password=<token>` to git (never logged);
`store`/`erase` are no-ops (tokens are short-lived). `exec --identity
reviewer -- git push …` is refused (Contents: read only).

## Reviewer isolation

- Reviewer profiles carry no Pi `edit`/`write` tools (schema + resolve +
  launch guards; `extends` cannot smuggle them in).
- Reviewer cannot push (`exec` blocks `git push`; App has Contents: read).
- Reviewer can submit formal reviews and publish/update
  `orca-pi/agent-review` (installation-token preflight + distinct-actor
  guard before any POST).
- Reviewer cannot select/use the worker credential slot (effective-identity
  guard).
- Reviewer remains distinct from the PR author (same-account PATs are not
  distinct identities).

## Diagnostics

```sh
orca-pi github auth status --identity worker
orca-pi github auth status --identity reviewer
orca-pi github auth status --profile worker
orca-pi github identity doctor
orca-pi github identity doctor --repo 44madfire/orca-pi --ambient 44madfire --json
```

`doctor` reports only non-secret info: expected identity + permissions,
App/bot login, installation id, repository access, permission validation,
token configured/refreshable + expiry, and whether
worker/reviewer/ambient actors are distinct.

## Manual E2E acceptance (post-merge to main)

1. Pull latest `main`, build/install `orca-pi` (`npm ci && npm run build`).
2. Run safe diagnostics for `worker` and `reviewer`
   (`auth status` + `identity doctor --repo 44madfire/orca-pi`).
3. `orca-pi github setup --identity worker/reviewer` → complete any
   remaining non-secret operator steps (App create/install, `.pem` mode
   0600, env exports); `orca-pi github mint --identity worker/reviewer`.
4. Launch a worker task in a test branch/worktree:
   `orca-pi spawn worker --task "…" --worktree new-child --name e2e-…`.
5. Inside the worker checkout: `orca-pi github setup-git --identity worker
   --path .`, commit, `orca-pi github exec --identity worker -- git push`,
   `orca-pi github exec --identity worker -- gh pr create …`.
6. Verify GitHub shows PR author as the worker bot, **not `44madfire`**.
7. Launch reviewer: `orca-pi spawn reviewer --task-id <id>` or run
   `orca-pi github review --profile reviewer …` + `check …` from a reviewer
   terminal; verify review/check appear as the reviewer bot.
8. Verify reviewer has no content-write (`exec --identity reviewer -- git
   push` must refuse; App permissions show Contents: read).
9. Ask ChatGPT to review the same PR via the existing GitHub connector;
   verify GitHub accepts approval/review from `44madfire` (not the author).
10. Human/ChatGPT-assisted squash merge remains the final step (no
    auto-merge exists).

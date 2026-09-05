# orca-pi

Orca–Pi orchestration (**OP1.1 / JEF-5** scaffold + **OP1.2 / JEF-6** Pi agent
profiles + **OP1.3 / JEF-7** deterministic Pi argv launcher + **OP1.6 / JEF-10**
default scout/worker/reviewer profiles + **OP1.7 / JEF-11** profile management
UX + **OP1.4 / JEF-8** supervised worker adapter + **OP1.5 / JEF-9** compact
Pi-facing orchestration CLI/skill): a thin Orca plugin
plus a separately testable companion `orca-pi` CLI/library.

Orca owns Runs/Tasks/Dispatches/worktrees and completion; `orca-pi` is a thin
Pi-facing wrapper that never couples orchestration logic to Orca's
experimental plugin-worker internals.

Ownership boundary: JEF-7 owns `ResolvedPiProfile` → `ProcessSpec` and the
redacted launch-spec formatter; JEF-11 owns CLI commands,
provenance/display presentation, validation UX, and the Orca sidebar, and
consumes JEF-7's formatter via injection rather than implementing another one.

## Architectural split

1. **Thin Orca plugin** (`packages/orca-plugin/`) — contributes UI/config/
   skills/commands where supported. It performs no process spawning: the
   plugin worker's capability model is still evolving
   (`stablyai/orca#15637`), so unrestricted Node `child_process` access inside
   the plugin is explicitly **not** a long-term dependency.
2. **Companion `orca-pi` CLI/library** (`packages/cli/` + `packages/core/`) —
   owns version reporting, `doctor` diagnostics, profile loading,
   deterministic Pi argv construction (OP1.3 / JEF-7), supervised Pi worker
   launches (OP1.4 / JEF-8), and the compact Pi-facing orchestration surface
   (OP1.5 / JEF-9: `spawn`/`status`/`send`/`wait`/`stop` plus the
   `orca-pi-orchestration` skill). All Orca calls use the public `orca` CLI
   (`--json`).

```text
orca-pi/
├── packages/
│   ├── core/          # version + doctor + manifest validator + profiles + launcher + supervised adapter + compact orchestration (no Electron)
│   ├── cli/           # `orca-pi` executable (thin wrapper over core)
│   └── orca-plugin/   # Orca manifest, panel/skill/command contributions
├── profiles/          # Pi agent profile schema docs + defaults + examples (OP1.2 / JEF-6 + OP1.6 / JEF-10)
├── prompts/           # Default scout/worker/reviewer role prompts (OP1.6 / JEF-10)
├── scripts/           # skill-size regression guard (OP1.5 / JEF-9)
├── docs/              # targeted Orca plugin API/version notes + manual evals
└── README.md
```

Core/CLI code is testable without Electron/Orca Desktop: `doctor` and the CLI
`run()` entry take an injected `ProcessRunner`, and unit tests use fake
executables.

## Prerequisites

- Node.js `>= 18` and npm.
- Orca Desktop with the `orca` CLI on PATH
  ([CLI overview](https://www.onorca.dev/docs/cli/overview)).
- Pi coding agent with the `pi` CLI on PATH
  ([coding-agent README](https://github.com/up0to1/pi-mono/blob/main/packages/coding-agent/README.md)).

This scaffold was developed against Orca app `1.4.196` and Pi `0.84.4`.
See `docs/ORCA_PLUGIN_API.md` for the targeted plugin API/version and for
how to re-validate against a new Orca release.

## Local development

```sh
npm install
npm run build      # tsc -b → packages/*/dist
npm run typecheck  # tsc -b --verbose
npm run lint       # eslint .
npm test           # vitest run
```

## Continuous integration

GitHub Actions workflow `.github/workflows/ci.yml` runs on every pull
request targeting `main` and on pushes to `main` (single stable `verify`
job, `contents: read`). To reproduce CI locally, run from the repo root
with Node 22:

```sh
npm ci
npm run build
npm test
npm run lint
```

Run the CLI from source after building:

```sh
node packages/cli/dist/main.js --version
node packages/cli/dist/main.js doctor
node packages/cli/dist/main.js doctor --json
node packages/cli/dist/main.js profiles list
node packages/cli/dist/main.js profile show scout
node packages/cli/dist/main.js profile inspect scout --project-root .
node packages/cli/dist/main.js profile inspect scout --project-root . --context-summary
node packages/cli/dist/main.js profile validate
node packages/cli/dist/main.js profile path
node packages/cli/dist/main.js status --json
node scripts/check-skill-size.mjs
node packages/cli/dist/main.js github auth status --identity reviewer
node packages/cli/dist/main.js github auth status --profile worker
node packages/cli/dist/main.js github identity doctor --repo 44madfire/orca-pi
node packages/cli/dist/main.js github setup --identity worker --repo 44madfire/orca-pi
node scripts/setup-github-apps.mjs --repo 44madfire/orca-pi
node packages/cli/dist/main.js github review --identity reviewer --pr https://github.com/octo/hello-world/pull/123 --verdict request-changes --body @/tmp/review.md
node packages/cli/dist/main.js github check start --identity reviewer --repo octo/hello-world --sha <head-sha>
node packages/cli/dist/main.js github check complete --identity reviewer --repo octo/hello-world --sha <head-sha> --verdict approve --summary "No blocking findings."
```

Or link it globally for the `orca-pi` name:

```sh
npm link --workspaces=false ./packages/cli
orca-pi --version
orca-pi doctor
```

## Behavior

- `orca-pi --version` prints the release version (`0.1.0`).
- `orca-pi doctor` verifies `orca` and `pi` are on PATH and reports versions.
  It is strictly read-only: it only spawns `<exe> --version` (plus
  `orca status --json` as a fallback, since `orca --version` currently prints
  usage without a version) and never mutates configuration.
  - Exit `0` when both CLIs report versions; exit `1` with actionable install
    hints when either is missing or versionless.
- `orca-pi --help` prints usage; unknown commands/flags exit `2`.
- `orca-pi profiles list [--json]` lists merged profiles with effective
  model/thinking/tool/skill counts plus user/project precedence and file
  locations. Exit `0` even when no profiles exist (with creation hints).
- `orca-pi profile show <name> [--json] [--show-prompt]` shows effective
  values plus provenance (`built-in`, user config, project config,
  inherited profile). Redacts large prompt bodies unless `--show-prompt`.
- `orca-pi profile inspect <name> [--project-root <path>] [--cwd <path>] [--user-config <path>] [--project-config <path>] [--json] [--show-prompt] [--context-summary]`
  prints JEF-11 presentation (provenance, context policy) plus JEF-7's
  deterministic Pi argv in redacted human-readable form (read-only, never
  launches Pi). `--json` prints structured `{ profile, provenance, spec, … }`;
  `--show-prompt` prints the full prompt text (default truncates to a
  preview + length). `--context-summary` adds a context-budget estimate
  (prompt chars/words/lines, ~tokens, tool/skill/extension counts,
  context-file policy; heuristic, not provider billing). The display
  formatter is never used for execution —
  launching always uses the structured `{ command, args, cwd, env }` array.
- Fresh installs expose built-in `scout`, `worker`, and `reviewer`
  (model-agnostic defaults in `packages/core/src/profile/builtins.ts`,
  mirrored in `profiles/scout.yaml`/`worker.yaml`/`reviewer.yaml` and
  `prompts/*.md`). Override models while retaining role policy:
  `profiles: { scout: { model: <fast-model> } }`. See `profiles/README.md`
  and `docs/EVALS.md` for role policy and manual evals.
- `orca-pi profile validate [<name>] [--json]` validates all (or one)
  profile with file/source/field diagnostics. Exit `0` when valid, `1` when
  invalid or unreadable.
- `orca-pi profile path [--project|--user] [--json]` prints the authoritative
  user/global and project locations (script-friendly with `--project`/`--user`).
  Never parses file contents, so it stays usable when config is malformed
  (recovery UX; content diagnostics belong to `validate`).
- `orca-pi spawn <profile> (--task <spec>|--task-id <id>) [--worktree <policy>] [--identity <name>] [--json]`
  resolves the role profile pre-launch (unknown profiles fail before any Orca
  effects) then launches an Orca-supervised Pi worker via JEF-8's adapter.
  Returns one frozen receipt (`taskId`, `dispatchId`, `terminalHandle`,
  worktree, Pi argv, `githubIdentity`). `--worktree` is `current` (default), `new-child` /
  `new-top-level` (require `--name`), or an existing selector (`active`,
  `id:…`, `name:…`, `path:…`). `--identity` is diagnostics/admin only and must
  match the profile's `githubIdentity` (cross-role overrides fail closed). The
  terminal command is prefixed per-process with `ORCA_PI_GITHUB_IDENTITY` +
  `ORCA_PI_PROFILE` so agents inherit without repeating `--identity` and without
  touching global git/GH config. Exit `1` on profile/Orca failures.
- `orca-pi status [--worker <dispatch|terminal>|--task <id>] [--json]`
  inspects Orca Task/Dispatch state (never terminal-text inference). Bare
  `status` sweeps workers (plus tasks when a Run is bound). Exit `0` with a
  stable receipt; exit `1` for unknown workers/tasks.
- `orca-pi send --worker <handle> --message <text> [--subject <text>] [--json]`
  delivers coordinator follow-up mail (`send --to dispatch:<id>`), preserving
  provenance. Never sends `worker_done`/`heartbeat` (worker-owned signals).
- `orca-pi wait (--worker <handle>|--task <id>) [--timeout <duration>] [--json]`
  polls Orca state with backoff until `completed`/`failed` or timeout
  (`500ms`, `30s`, `5m`, `1h`; plain numbers mean seconds; default `15m`).
  Exit `0` on `completed`, `1` on `failed`/`timeout`. Timeouts mean
  "still running", never failure.
- `orca-pi stop --worker <handle> [--json]` fences one worker terminal
  (`worker-stop`) idempotently (`alreadyStopped` on repeats). It never marks
  the Task complete/failed — Orca owns completion; the observed `taskStatus`
  is reported unchanged.

Compact orchestration keeps only minimal handle mappings
(`<projectRoot>/.pi/orca-pi-workers.json`, best-effort); Orca remains the
source of truth for completion/status.
- GitHub agent identities + automated review checks (OP1.9 / JEF-15 + OP1.12 worker/reviewer Apps):
  Worker App (`orca-pi-worker[bot]`, Contents: write) creates/updates PRs while the
  dedicated Reviewer GitHub App (`orca-pi-reviewer[bot]`, Contents: read) submits
  formal `COMMENT`/`REQUEST_CHANGES`/`APPROVE` reviews and publishes the deterministic
  `orca-pi/agent-review` check (`in_progress` → `success`/`failure`) for branch
  protection/rulesets. Human (`44madfire`, including ChatGPT-assisted review) remains
  merge authority (no auto-merge). `worker bot != reviewer bot != 44madfire`, so worker PRs
  are approvable by both reviewer bot and human. Review/check writes fail closed:
  reviewer-only with installation-token proof (`GET /installation/repositories`,
  IAT-supported unlike `GET /user`) for the trusted configured App login +
  distinct-from-PR-author guard before any POST (same-account PATs never write);
  worker pushes/PRs fail closed via the parallel worker App preflight; `check start`
  reuses the deterministic run (idempotent), review retries dedupe via response-state matching.
  Launch role is authoritative: `githubIdentity` from the resolved profile controls the
  effective actor (`--profile` or spawn-injected `ORCA_PI_GITHUB_IDENTITY` inherits;
  explicit `--identity` must match the profile, no escalation). Worker git/GH writes run
  as the worker App via a scoped broker (per-process `exec` env / per-repo `setup-git`
  `--local` helper, never `--global`). See `docs/GITHUB_IDENTITIES.md`.
  - `orca-pi github auth status [--identity <name>] [--profile <name>] [--json]` — credential presence
    (source label + expiry, never values).
  - `orca-pi github review [--identity reviewer] [--profile <name>] --pr <url|number|owner/repo#n> --verdict <approve|request-changes|comment> --body <text|@file> [--repo <owner/repo>] [--json]`
  - `orca-pi github check start|complete [--identity reviewer] [--profile <name>] --repo <owner/repo> --sha <sha> ...` (idempotent: reuses the deterministic run for the SHA).
  - `orca-pi github doctor [--repo <owner/repo>] [--ambient <login>] [--json]` / `orca-pi github identity doctor` — non-secret diagnostics (App login/ids, perms, expiry, distinctness).
  - `orca-pi github setup --identity <name> [--repo <owner/repo>]` — idempotent non-secret App bootstrap steps (Apps require UI/admin; no secrets committed).
  - `orca-pi github mint --identity <name>` — out-of-LLM installation-token mint/refresh (private key from `..._PRIVATE_KEY_PATH`, WSL/Windows aware; prints metadata only).
  - `orca-pi github exec [--identity <name>] [--profile <name>] -- <command...>` — scoped broker (`GH_TOKEN` only for the child; reviewer `git push` refused).
  - `orca-pi github setup-git --identity worker [--path <repo-path>]` — pins repo-local credential helper (`--local`, never `--global`).
  - Profiles reference logical identities (`githubIdentity: worker|reviewer`), never secrets;
    tokens resolve at runtime via `ORCA_PI_GITHUB_<IDENTITY>_TOKEN` (+ optional `..._EXPIRES_AT`) or App mint
    (`..._APP_ID` + `..._PRIVATE_KEY_PATH` + `..._INSTALLATION_ID` + `..._LOGIN`).
    Reviewer holds Contents: read only — `githubIdentity: reviewer` with `edit`/`write` tools fails validation.

## Orca plugin

- Manifest: `packages/orca-plugin/orca-plugin.json` (manifest v1:
  `manifestVersion: 1`, `pluginApi: 1`, `engines.orca: ">=1.4.0"`, no
  capabilities). Install identity: `44madfire.orca-pi`.
- Panels (`contributes.panels`, declarative sandboxed HTML, no worker):
  - `orca-pi-status` (`panel.html`) — plugin/CLI version plus `orca-pi doctor`
    and profile CLI pointers.
  - `orca-pi-profiles` (`panel/profiles.html`, OP1.7 / JEF-11) — read-only
    Pi profiles sidebar: effective model/thinking, tool count, skill
    names/count, extension count, context-file policy, validation state.
    Live data comes from `orca-pi profiles list --json`; without a supported
    host bridge the panel shows CLI fallback content. Conservative actions
    only: validate, show/open/copy config location, refresh/reload. Editing
    happens in config files — the panel keeps no local store.
  - Feature detection (`detectPanelSupport()` in `src/panel.ts`) reports
    read-only support vs `cli-only` fallback; unsupported APIs degrade
    gracefully without blocking orchestration.
- No commands yet: manifest v1 treats action-less commands as worker
  commands requiring a `main` entry, and `action` aliases must come from the
  host's closed built-in list — so a command waits for a later ticket with a
  real worker or a suitable built-in action.
- The plugin is declarative-only: no `main` worker entry, `capabilities: []`.
- Skills (`skills/`, installed through Orca's skill flow, not the plugin
  manifest — v1 has no `skills` contribution point):
  - `orca-pi-doctor/SKILL.md` (OP1.1) — read-only `doctor` diagnostics.
  - `orca-pi-orchestration/SKILL.md` (OP1.5 / JEF-9) — compact Pi-facing
    orchestration: when to use `orca-pi`, the five semantic commands, role
    profiles, worktree policy, and Orca-authority rules. No model/tool
    lists, no full orchestration guide copy. Load in Pi via
    `pi --skill packages/orca-plugin/skills/orca-pi-orchestration`.
    Size: ~3.4KB (~840 tokens, 83 lines) vs upstream
    `orca skills get orchestration --full` ~42.5KB (~10.6k tokens, 440
    lines) — ~8%. Guarded by `node scripts/check-skill-size.mjs`
    (budget ≤6000 bytes / ≤1600 tokens).
- Dependency-free entry `src/index.ts` (`activate()`, `renderPluginStatus()`)
  proves the artifact loads without Electron.

### Manual smoke test (Orca Desktop)

1. Build: `npm run build`.
2. In Orca, load the folder `packages/orca-plugin/` via the development
   plugin loader (it must contain `orca-plugin.json` at its root).
3. Verify Orca loads it and the `Orca-Pi Status` panel appears,
   without destabilizing Orca.
4. In a terminal, verify `orca-pi doctor` reports your Orca/Pi versions.

If your Orca build reports a manifest error, update
`packages/core/src/pluginManifest.ts`, `orca-plugin.json`, and
`docs/ORCA_PLUGIN_API.md` together — they are tested as a unit
(`packages/orca-plugin/test/manifest.test.ts`).

## Profiles (OP1.2 / JEF-6) + deterministic launcher (OP1.3 / JEF-7) + defaults (OP1.6 / JEF-10) + management UX (OP1.7 / JEF-11)

- Built-in model-agnostic defaults (`scout`, `worker`, `reviewer`) in
  `packages/core/src/profile/builtins.ts` (fresh installs work with no config
  files), mirrored in `profiles/scout.yaml`/`worker.yaml`/`reviewer.yaml`
  and `prompts/*.md`. Declarative overrides in
  `profiles/examples.yaml` (copy to `$PI_CODING_AGENT_DIR/profiles.yaml` or
  `<projectRoot>/.pi/profiles.yaml`).
- Schema/loader/resolver in `@orca-pi/core` (`packages/core/src/profile/`):
  `validateProfilesDocument`, `parseAndValidateProfilesText`,
  `mergeValidatedDocuments`, `resolveProfile` → one frozen
  `ResolvedPiProfile`. Invalid config fails pre-launch with dotted-path
  diagnostics; see `profiles/README.md` for fields, precedence, and
  security rules.
- Deterministic Pi argv launcher in `@orca-pi/core` (`packages/core/src/pi/`):
  `buildPiLaunch(resolved, { projectRoot, cwd })` → frozen
  `{ command: "pi", args, cwd, env }` (structured, no shell strings).
  `systemPromptFile` is read against `projectRoot` and passed explicitly via
  `--system-prompt`; relative skill/extension paths resolve against
  `projectRoot`; `cwd` preserves the Orca worktree selection; task text is
  never embedded (Orca `dispatch --inject` owns injection in JEF-8); lean
  profiles visibly emit `--no-skills`/`--no-extensions`/`--no-context-files`
  then only explicit `--skill`/`--extension` entries; `ephemeral` emits
  `--no-session` while `fresh` emits no session flags and never resumes.
  Pi file-or-text contract: current Pi treats `--system-prompt <value>` as
  file-or-text (`existsSync` → read file, else literal). Non-colliding
  prompts travel literally (common case, byte-identical); when the intended
  text equals an existing file in `cwd`, the launcher materializes it to a
  deterministic content-addressed temp file and passes the temp path so Pi's
  file branch reads the exact intended text (see `prompt-transport.ts` and
  `pi-prompt-contract.test.ts`).
- Presentation (`packages/core/src/profile/presentation.ts`, JEF-11):
  effective values plus per-field provenance, redacted prompt display
  (`--show-prompt` reveals), `toPanelModel()` metadata-only sidebar model.
  Never loads skill/prompt file contents for metadata; shortens `~` in human
  output except in explicit `profile path`. `profile inspect` wires the
  production preview as `formatPiInspect(resolved, await buildPiLaunch(…))`
  via async `LaunchPreviewProvider` injection (JEF-11 never builds argv).

## Compact orchestration (OP1.5 / JEF-9): scout → worker → reviewer with only compact commands

A Pi coordinator runs the normal worker lifecycle without loading Orca's
full orchestration guide — only `orca-pi` plus the `orca-pi-orchestration`
skill:

```sh
# 1. Scout (read-only inspection, evidence-backed handoff)
orca-pi spawn scout --task "Map the auth flow; cite files/symbols and uncertainties" --json
orca-pi wait --task <scout-task-id> --timeout 10m --json

# 2. Worker (bounded implementation)
orca-pi spawn worker --task "Implement the fix per the scout handoff; keep the diff scoped" --json
orca-pi send --worker <worker-dispatch> --message "Prefer approach X; see file Y for the pattern" --json
orca-pi wait --worker <worker-dispatch> --timeout 15m --json

# 3. Reviewer (independent evaluation, no edits)
orca-pi spawn reviewer --task "Review the diff for <worker-task-id> against acceptance criteria" --json
orca-pi wait --task <reviewer-task-id> --timeout 10m --json

# Fence a worker terminal when done (idempotent; never marks the Task complete)
orca-pi stop --worker <worker-dispatch> --json

# Inspect at any time (Orca-state only, never terminal text)
orca-pi status --worker <dispatch> --json
orca-pi status --task <task-id> --json
```

Orca owns completion/status throughout: `status`/`wait` read
Task/Dispatch state, `send` is structured inbox mail (not injection),
and `stop` fences the terminal without completing the Task.

## Non-goals (OP1.1 + OP1.2 + OP1.3 + OP1.7 + OP1.4 + OP1.5)

- No transcript parsing.
- No Orca core fork.
- No panel-local config store or undocumented filesystem/network bridge.
- No coordinator-side completion authority (Orca Task/Dispatch state only).
- No role-specific model/tool duplication outside profile config.

## Upstream references

- Orca pluggable harness proposal: `https://github.com/stablyai/orca/issues/13306`
- Orca plugin capability limitations: `https://github.com/stablyai/orca/issues/15637`
- Orca CLI overview: `https://www.onorca.dev/docs/cli/overview`
- Pi coding-agent CLI: `https://github.com/up0to1/pi-mono/blob/main/packages/coding-agent/README.md`

# profiles/

Declarative Pi agent profiles (OP1.2 / JEF-6 + OP1.6 / JEF-10 defaults):
reusable role definitions such as `scout`, `worker`, and `reviewer` with
independent model, reasoning, prompt, tools, skills, extensions, and context
policy.

Fresh installs expose built-in `scout`, `worker`, and `reviewer` with no
config files (model-agnostic — see below). The schema, loader, resolver, and
defaults live in `@orca-pi/core`:

- `packages/core/src/profile/types.ts` — static shapes (`PiProfileInput`,
  `ResolvedPiProfile`, …)
- `packages/core/src/profile/schema.ts` — runtime validator
  (`validateProfilesDocument`, `validateProfileOverrides`,
  `BUILTIN_PROFILE_DEFAULTS`)
- `packages/core/src/profile/builtins.ts` — JEF-10 default role policy
  (`getBuiltinProfilesDocument()`, `SCOUT/WORKER/REVIEWER_SYSTEM_PROMPT`)
- `packages/core/src/profile/load.ts` — YAML/JSON parsing, multi-layer
  merging, and `node:fs` helpers (`parseAndValidateProfilesText`,
  `mergeValidatedDocuments`, `loadMergedProfiles`)
- `packages/core/src/profile/resolve.ts` — inheritance flattening into one
  frozen `ResolvedPiProfile` (`resolveProfile`, `resolveAllProfiles`)
- `packages/core/src/pi/context-summary.ts` — context-budget estimates
  (`summarizeProfileContext`, `formatContextSummary`)

Shipped files in this directory:

- `scout.yaml`, `worker.yaml`, `reviewer.yaml` — per-role defaults with
  inline prompts (mirror the built-ins; copy a block to override).
- `examples.yaml` — fuller example (`readonly` base with
  `scout`/`worker`/`reviewer` children plus model/skill examples).
- `../prompts/scout.md`, `../prompts/worker.md`, `../prompts/reviewer.md` —
  human-readable copies of the built-in prompts (tests enforce sync).

## Built-in defaults (JEF-10)

| Role | Tools | Thinking | Context | Session | Prompt |
|---|---|---|---|---|---|
| `scout` | `read,grep,find,ls` | `low` | `contextFiles: false`, no explicit skills/extensions | `ephemeral` | Evidence-backed handoff; no modifications |
| `worker` | `read,grep,find,ls,bash,edit,write` | `high` | `contextFiles: true`, no explicit skills/extensions | `ephemeral` | Inspect-before-edit, scoped change, focused validation |
| `reviewer` | `read,grep,find,ls,bash` (no `edit`/`write`) | `high` | `contextFiles: false`, no explicit skills/extensions | `ephemeral` | Fresh-context review, Blocking vs Non-blocking |

Ambient discovery is off for all three (`discoverSkills/discoverExtensions:
false`). Sessions are `ephemeral` (`--no-session`) so reviewer runs never
resume worker context. Prompts never duplicate Orca `worker_done`/heartbeat
lifecycle instructions (Orca injects those).

## Model overrides (retain role policy)

Built-ins omit `model`/`provider`. Select models in your own config:

```yaml
profiles:
  scout:
    model: <fast-model>
  worker:
    model: <coding-model>
  reviewer:
    model: <reasoning-model>
```

Later layers win per-field; arrays replace wholesale. A model-only override
keeps the default tools/thinking/prompt/context for that role (tested in
`profile.defaults.test.ts`).

## Example

```yaml
profiles:
  readonly:
    tools: [read, grep, find, ls]
    skills: []
    extensions: []
    contextFiles: false

  scout:
    extends: readonly
    model: anthropic/claude-haiku
    thinking: low
    systemPromptFile: .pi/agents/scout.md
    skills: [.pi/skills/repo-search]

  worker:
    model: anthropic/claude-sonnet
    thinking: high
    systemPromptFile: .pi/agents/worker.md
    tools: [read, grep, find, ls, bash, edit, write]
    skills: [.pi/skills/project, .pi/skills/testing]
    contextFiles: true
```

## Field reference (v1)

Profile names matching `^[A-Za-z0-9][A-Za-z0-9_-]*$` are accepted except the reserved `__proto__`, `constructor`, and `prototype` (prototype-pollution/phantom-parent risk). Parent lookups require an own entry, so `extends: toString` fails as unknown-parent unless `toString` is explicitly defined.

| Field | Pi mapping | Notes |
|---|---|---|
| `extends` | — | Optional single parent; cycles/unknown parents fail pre-launch. |
| `provider` | `--provider` | Optional (e.g. `anthropic`, `openai-codex`). |
| `model` | `--model` | Single model ID (`provider/id`, Pi exact/fuzzy match; variant colons like `openrouter/foo:exacto` allowed). Globs (`*`, `?`) belong to Pi's separate `--models` scope and are rejected, as is a terminal recognized thinking suffix (`:high`, ...); use the separate `thinking:` field. Literal — never shell-expanded. |
| `thinking` | `--thinking` | `off\|minimal\|low\|medium\|high\|xhigh\|max`. |
| `systemPrompt` | `--system-prompt` | Inline text. Mutually exclusive with `systemPromptFile`. |
| `systemPromptFile` | `--system-prompt` (via file read at launch) | Project-relative path (e.g. `.pi/agents/scout.md`). Listing/resolving never reads file contents. |
| `tools` | `--tools` | Allowlist. Pi built-ins validated (`read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls`); custom/extension tools allowed when they match `^[A-Za-z0-9][A-Za-z0-9_-]*$`. |
| `excludeTools` | `--exclude-tools` | Same name rules as `tools`. |
| `skills` | `--skill` (repeatable) | Project-relative paths. |
| `extensions` | `-e`/`--extension` (repeatable) | Project-relative paths. |
| `contextFiles` | `--no-context-files` (when `false`) | Default `false`. |
| `discoverSkills` | `--no-skills` (when `false`) | Default `false` — ambient discovery is explicit opt-in. |
| `discoverExtensions` | `--no-extensions` (when `false`) | Default `false`. |
| `session` | `--no-session` (when `ephemeral`) | `ephemeral` (default, no session file) or `fresh` (new saved session). Profiles can never resume (`--continue`/`--resume`/`--session`/`--fork` require explicit CLI overrides). |
| `githubIdentity` | — (GitHub helpers only; Pi launcher ignores it) | Logical GitHub automation identity (`worker`, `reviewer`, or custom `^[A-Za-z0-9][A-Za-z0-9_-]*$`). Names a credential slot resolved at launch/runtime via `ORCA_PI_GITHUB_<IDENTITY>_TOKEN` — never a secret. `reviewer` must not list `edit`/`write` tools (Contents: read only). Built-ins: `worker → worker`, `reviewer → reviewer`, `scout` unset. |
| `displayName`/`description` | — | Display-only; never affects execution semantics (JEF-11 UX). |

Unknown fields are rejected — profiles must never contain secrets/API keys
(keep credentials in env vars or Pi auth storage).

## Configuration precedence (low → high)

1. built-in defaults (JEF-10: `scout`/`worker`/`reviewer` role policy in
   `builtins.ts`, plus `BUILTIN_PROFILE_DEFAULTS`: `thinking: medium`,
   `contextFiles/discoverSkills/discoverExtensions: false`,
   `session: ephemeral`)
2. user/global config (`$PI_CODING_AGENT_DIR/profiles.yaml`,
   fallback `~/.pi/agent/profiles.yaml`)
3. project config (`<projectRoot>/.pi/profiles.yaml`)
4. inherited profile (`extends` chain, root first)
5. selected profile
6. explicit CLI overrides (validated; `extends` forbidden)

Same-profile fields merge per-field with later layers winning. **Arrays
replace wholesale in v1** — there is no append syntax; a child (or later
config layer, or override) that sets `tools`/`skills`/`extensions` replaces
the parent's list entirely. Defining `systemPrompt` clears an inherited
`systemPromptFile` and vice versa.

Helpers: `getCandidateConfigPaths({ projectRoot })` returns
`[userPath, projectPath]` in merge order; `mergeValidatedDocuments` merges
in order; `resolveProfile(name, merged, { overrides })` flattens
inheritance and applies overrides last. `loadMergedProfiles` prepends
builtins by default (`includeBuiltins: false` only for raw layer tests).

## GitHub agent identities (OP1.9 / JEF-15)

Worker creates/updates PRs (human/machine-user credential); the dedicated
Reviewer GitHub App submits formal reviews and the deterministic
`orca-pi/agent-review` check (branch-protection ready). Human merges.

```yaml
profiles:
  worker:
    githubIdentity: worker
  reviewer:
    githubIdentity: reviewer
```

- Reviewer App permissions: Contents: read, Pull requests: write, Checks: write, Metadata: read. Never Contents: write.
- Tokens resolve at runtime (`ORCA_PI_GITHUB_<IDENTITY>_TOKEN` + optional `..._EXPIRES_AT` ISO-8601, optional verified `ORCA_PI_GITHUB_REVIEWER_LOGIN`); mint/refresh outside LLM context. Never place keys/tokens/secrets in prompts, task text, logs, or Linear.
- Same-account PATs are not distinct actors — install the reviewer App for a separate actor. Review/check writes fail closed: installation-token proof (`GET /installation/repositories`, IAT-supported) for the trusted configured App login (`ORCA_PI_GITHUB_REVIEWER_LOGIN` + `..._INSTALLATION_ID`) + PR-author distinctness before any POST; `--identity worker` is refused; never `GET /user` (unsupported for IATs), never token-prefix inference.
- Resolved profiles fail closed too: `githubIdentity: reviewer` with inherited `edit`/`write` (via `extends`) is rejected at resolve/validate/show/inspect/launch time (`invalid-github-identity`).
- CLI: `orca-pi github auth status --identity reviewer`, `orca-pi github review ...`, `orca-pi github check start|complete ...` (see root `README.md`). `check start` is idempotent (reuses the run for the SHA); identical review retries dedupe. Helpers redact token-like values from output/errors.

## Security / context rules

- Project-relative fields (`systemPromptFile`, `skills`, `extensions`)
  reject absolute paths, `~`, URLs, backslashes, and any `..` escape —
  configs stay portable and cannot reference outside the project.
- Listing (`listProfileNames`) and resolving (`resolveProfile`) never read
  prompt/skill file contents and never mutate their inputs; resolved
  profiles keep normalized relative paths for the launcher (`buildPiLaunch`
  in `packages/core/src/pi/`, OP1.3 / JEF-7) to read at launch time.
- Parsing never executes shell or interpolates `$VAR`/backticks — all
  strings are literal; model/tool/path grammars reject shell metacharacters.
- Invalid config fails before any Pi/Orca process starts:
  `ProfileLoadError` (malformed YAML/JSON) or `ProfileValidationError` /
  `ProfileResolveError` (schema, unknown parent, cycle) with dotted paths
  and fix hints.

## Pi references

- Launcher (`packages/core/src/pi/`): `buildPiLaunch(resolved, { projectRoot, cwd })`
  → frozen `{ command: "pi", args, cwd, env }`. Inspect with
  `orca-pi profile inspect <name> [--project-root <path>] [--json] [--show-prompt] [--context-summary]`
  (redacted display-only formatter; execution always uses structured args).
- Context summary (`context-summary.ts`): `summarizeProfileContext` reports
  prompt chars/words/lines, `ceil(chars/4)` token estimate, tool count,
  explicit/discovered skill/extension counts, and context-file policy.
  Regression/debug heuristic only — not provider token accounting.
- Prompt transport (`prompt-transport.ts`): current Pi treats
  `--system-prompt <value>` as file-or-text (`existsSync` → read file, else
  literal). Non-colliding prompts travel literally; colliding prompts
  (intended text equals an existing file in launch `cwd`) are materialized
  to a deterministic temp file so Pi reads the exact intended text.
  Contract tests in `pi-prompt-contract.test.ts` simulate Pi resolution.
- CLI options (`--model`, `--thinking`, `--tools`, `--skill`,
  `--extension`, `--no-context-files`, session flags):
  <https://github.com/up0to1/pi-mono/blob/main/packages/coding-agent/README.md>
- Skills (Agent Skills standard, discovery, `--skill`/`--no-skills`):
  <https://github.com/can1357/pi-mono/blob/main/packages/coding-agent/docs/skills.md>

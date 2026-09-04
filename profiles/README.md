# profiles/

Declarative Pi agent profiles (OP1.2 / JEF-6): reusable role definitions such
as `scout`, `worker`, and `reviewer` with independent model, reasoning,
prompt, tools, skills, extensions, and context policy.

The schema, loader, and resolver live in `@orca-pi/core`:

- `packages/core/src/profile/types.ts` — static shapes (`PiProfileInput`,
  `ResolvedPiProfile`, …)
- `packages/core/src/profile/schema.ts` — runtime validator
  (`validateProfilesDocument`, `validateProfileOverrides`,
  `BUILTIN_PROFILE_DEFAULTS`)
- `packages/core/src/profile/load.ts` — YAML/JSON parsing, multi-layer
  merging, and `node:fs` helpers (`parseAndValidateProfilesText`,
  `mergeValidatedDocuments`, `loadMergedProfiles`)
- `packages/core/src/profile/resolve.ts` — inheritance flattening into one
  frozen `ResolvedPiProfile` (`resolveProfile`, `resolveAllProfiles`)

See `examples.yaml` in this directory for a copy-paste starting point
(`readonly` base with `scout`/`worker` children, matching the JEF-6 shape).

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
| `displayName`/`description` | — | Display-only; never affects execution semantics (JEF-11 UX). |

Unknown fields are rejected — profiles must never contain secrets/API keys
(keep credentials in env vars or Pi auth storage).

## Configuration precedence (low → high)

1. built-in defaults (`BUILTIN_PROFILE_DEFAULTS`: `thinking: medium`,
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
inheritance and applies overrides last.

## Security / context rules

- Project-relative fields (`systemPromptFile`, `skills`, `extensions`)
  reject absolute paths, `~`, URLs, backslashes, and any `..` escape —
  configs stay portable and cannot reference outside the project.
- Listing (`listProfileNames`) and resolving (`resolveProfile`) never read
  prompt/skill file contents and never mutate their inputs; resolved
  profiles keep normalized relative paths for the launcher (JEF-7) to read
  at launch time.
- Parsing never executes shell or interpolates `$VAR`/backticks — all
  strings are literal; model/tool/path grammars reject shell metacharacters.
- Invalid config fails before any Pi/Orca process starts:
  `ProfileLoadError` (malformed YAML/JSON) or `ProfileValidationError` /
  `ProfileResolveError` (schema, unknown parent, cycle) with dotted paths
  and fix hints.

## Pi references

- CLI options (`--model`, `--thinking`, `--tools`, `--skill`,
  `--extension`, `--no-context-files`, session flags):
  <https://github.com/up0to1/pi-mono/blob/main/packages/coding-agent/README.md>
- Skills (Agent Skills standard, discovery, `--skill`/`--no-skills`):
  <https://github.com/can1357/pi-mono/blob/main/packages/coding-agent/docs/skills.md>

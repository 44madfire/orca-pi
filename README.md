# orca-pi

Orca–Pi orchestration (**OP1.1 / JEF-5** scaffold + **OP1.2 / JEF-6** Pi agent
profiles + **OP1.3 / JEF-7** deterministic Pi argv launcher): a thin Orca plugin
plus a separately testable companion `orca-pi` CLI/library.

Later tickets add Orca Tasks/Dispatches — without coupling orchestration logic
to Orca's experimental plugin-worker internals.

## Architectural split

1. **Thin Orca plugin** (`packages/orca-plugin/`) — contributes UI/config/
   skills/commands where supported. It performs no process spawning: the
   plugin worker's capability model is still evolving
   (`stablyai/orca#15637`), so unrestricted Node `child_process` access inside
   the plugin is explicitly **not** a long-term dependency.
2. **Companion `orca-pi` CLI/library** (`packages/cli/` + `packages/core/`) —
   owns version reporting, `doctor` diagnostics, profile loading,
   deterministic Pi argv construction (OP1.3 / JEF-7), and calls to the
   public `orca` CLI in later tickets.

```text
orca-pi/
├── packages/
│   ├── core/          # version + doctor + plugin-manifest validator + Pi profiles + Pi launcher (no Electron)
│   ├── cli/           # `orca-pi` executable (thin wrapper over core)
│   └── orca-plugin/   # Orca manifest, panel/skill/command contributions
├── profiles/          # Pi agent profile schema docs + examples (OP1.2 / JEF-6)
├── docs/              # targeted Orca plugin API/version notes
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
node packages/cli/dist/main.js profile inspect scout --project-root .
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
- `orca-pi profile inspect <name>` prints the resolved profile plus its
  deterministic Pi argv in redacted human-readable form (read-only, never
  launches Pi). `--json` prints the full structured `{ profile, spec }`;
  `--show-prompt` prints the full prompt text (default truncates to a
  preview + length). The display formatter is never used for execution —
  launching always uses the structured `{ command, args, cwd, env }` array.

## Orca plugin

- Manifest: `packages/orca-plugin/orca-plugin.json` (manifest v1:
  `manifestVersion: 1`, `pluginApi: 1`, `engines.orca: ">=1.4.0"`, no
  capabilities). Install identity: `44madfire.orca-pi`.
- Placeholder panel `panel.html` (`contributes.panels`: `orca-pi-status`)
  showing the plugin/CLI version and pointing at `orca-pi doctor` for live
  diagnostics.
- No commands yet: manifest v1 treats action-less commands as worker
  commands requiring a `main` entry, and `action` aliases must come from the
  host's closed built-in list — so a command waits for a later ticket with a
  real worker or a suitable built-in action.
- The plugin is declarative-only: no `main` worker entry, `capabilities: []`.
- Placeholder skill `skills/orca-pi-doctor/SKILL.md`. Note: manifest v1 has
  no `skills` contribution point, so the skill ships as repo documentation
  and is installed through Orca's skill flow, not the plugin manifest.
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

## Profiles (OP1.2 / JEF-6) + deterministic launcher (OP1.3 / JEF-7)

- Declarative roles (`scout`, `worker`, `reviewer`, …) in
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

## Non-goals (OP1.1 + OP1.2 + OP1.3)

- No Orca Tasks/Dispatches yet (OP1.4 / JEF-8 owns the supervised adapter).
- No transcript parsing.
- No Orca core fork.

## Upstream references

- Orca pluggable harness proposal: `https://github.com/stablyai/orca/issues/13306`
- Orca plugin capability limitations: `https://github.com/stablyai/orca/issues/15637`
- Orca CLI overview: `https://www.onorca.dev/docs/cli/overview`
- Pi coding-agent CLI: `https://github.com/up0to1/pi-mono/blob/main/packages/coding-agent/README.md`

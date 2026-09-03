# orca-pi

Orca–Pi orchestration scaffold (**OP1.1 / JEF-5**): a thin Orca plugin plus a
separately testable companion `orca-pi` CLI.

Later tickets add Pi agent profiles (JEF-6), deterministic Pi argv launching,
and Orca Tasks/Dispatches — without coupling orchestration logic to Orca's
experimental plugin-worker internals.

## Architectural split

1. **Thin Orca plugin** (`packages/orca-plugin/`) — contributes UI/config/
   skills/commands where supported. It performs no process spawning: the
   plugin worker's capability model is still evolving
   (`stablyai/orca#15637`), so unrestricted Node `child_process` access inside
   the plugin is explicitly **not** a long-term dependency.
2. **Companion `orca-pi` CLI/library** (`packages/cli/` + `packages/core/`) —
   owns version reporting, `doctor` diagnostics today, and profile loading, Pi
   argv construction, and calls to the public `orca` CLI in later tickets.

```text
orca-pi/
├── packages/
│   ├── core/          # version + doctor + plugin-manifest validator (no Electron)
│   ├── cli/           # `orca-pi` executable (thin wrapper over core)
│   └── orca-plugin/   # Orca manifest, panel/skill/command contributions
├── profiles/          # reserved for OP1.2 (no profiles yet)
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

Run the CLI from source after building:

```sh
node packages/cli/dist/main.js --version
node packages/cli/dist/main.js doctor
node packages/cli/dist/main.js doctor --json
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

## Orca plugin

- Manifest: `packages/orca-plugin/orca.plugin.json`
  (`orcaApiVersion: 1.4.x`, `minOrcaAppVersion: 1.4.0`).
- Placeholder command `orca-pi.showStatus` (`commands.json`).
- Placeholder panel `panel.html` showing the plugin/CLI version and pointing
  at `orca-pi doctor` for live diagnostics.
- Placeholder skill `skills/orca-pi-doctor/SKILL.md`.
- Dependency-free entry `src/index.ts` (`activate()`, `renderPluginStatus()`)
  proves the artifact loads without Electron.

### Manual smoke test (Orca Desktop)

1. Build: `npm run build`.
2. Install the contents of `packages/orca-plugin/` as a plugin in Orca
   (per your Orca build's plugin-install flow).
3. Verify Orca loads it and the `Orca–Pi Status` panel / `Orca-Pi: Show Status`
   command appear, without destabilizing Orca.
4. In a terminal, verify `orca-pi doctor` reports your Orca/Pi versions.

If your Orca build reports a different plugin-manifest schema, update
`packages/core/src/pluginManifest.ts`, `orca.plugin.json`, and
`docs/ORCA_PLUGIN_API.md` together — they are tested as a unit
(`packages/orca-plugin/test/manifest.test.ts`).

## Non-goals (OP1.1)

- No agent profiles yet (OP1.2 / JEF-6 owns `profiles/`).
- No Orca Tasks/Dispatches.
- No transcript parsing.
- No Orca core fork.

## Upstream references

- Orca pluggable harness proposal: `https://github.com/stablyai/orca/issues/13306`
- Orca plugin capability limitations: `https://github.com/stablyai/orca/issues/15637`
- Orca CLI overview: `https://www.onorca.dev/docs/cli/overview`
- Pi coding-agent CLI: `https://github.com/up0to1/pi-mono/blob/main/packages/coding-agent/README.md`

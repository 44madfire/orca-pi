# Orca plugin API target (OP1.1)

This scaffold targets the Orca plugin surface as of **Orca app `1.4.196`**
(`orca` CLI reporting `result.runtime.appVersion: 1.4.196`), verified against
the upstream manifest schema on `main` (2026-09-03).

## Manifest v1

- File: **`orca-plugin.json`** at the plugin root
  (`PLUGIN_MANIFEST_FILENAME` upstream).
- Shape: `manifestVersion: 1`, kebab-case `id` + `publisher` (canonical
  install identity `<publisher>.<id>`, e.g. `44madfire.orca-pi`), semver
  `version`, `engines: { "orca": ">=x.y.z" }` (closed grammar — only the
  `>=x.y.z` form is accepted), `pluginApi: 1`, `capabilities: []`.
- `contributes` (strict object): `panels`, `commands`, `events`,
  `languagePacks`, `keybindings`, `vmRecipes`, `agents`.
  - Panel: kebab-case `id`, `title`, optional Lucide `icon`, `entry` — an
    HTML file rendered in a sandboxed frame. Entry paths must be safe
    plugin-relative paths: **no `./` prefix or dot segments**, no absolute
    paths, no Windows-forbidden characters.
  - Command: portable id (`[A-Za-z0-9]+([._-][A-Za-z0-9]+)*`, so dots are
    fine), `title`, optional `context: global | worktree`, optional `action`.
    `action` must be a **known built-in action alias** (closed list, e.g.
    `view.tasks`, `sidebar.search.toggle`) — the host rejects anything else.
    Commands **without** `action` are worker commands and additionally
    require a `main` worker entry (same for non-empty `events`, which also
    need an `events:subscribe` capability). OP1.1 therefore ships no
    commands: no suitable built-in action exists for a status placeholder,
    and a worker is out of scope.
  - Events (closed set): `worktree.created`, `worktree.removed`,
    `agent.status.changed`.
  - There is **no `skills` contribution point** in v1 — skills ship
    separately through Orca's skill flow, not the plugin manifest.
  - `agents` (path contributions) will matter for OP1.2 profiles (JEF-6).
- `main` (Node worker entry) is optional. This scaffold omits it: the plugin
  is declarative-only, so no worker capability is needed and unrestricted
  `child_process` in a plugin worker is never on the table.

Upstream sources (public `stablyai/orca`, `src/shared/plugins/`):

- `plugin-manifest.ts` — manifest v1 schema, panel/command/event shapes.
- `plugin-manifest-fields.ts` — id/path/command-id rules.
- `plugin-manifest-contribution-validation.ts` — duplicate detection, action
  alias gate, keybinding→command references.
- `plugin-command-actions.ts` — closed built-in action list.
- `plugin-content-pack-contributions.ts` — language packs, keybindings,
  vm recipes, agent profiles.
- Background issues: [#13306](https://github.com/stablyai/orca/issues/13306)
  (pluggable harness), [#15637](https://github.com/stablyai/orca/issues/15637)
  (capability limitations).

`packages/core/src/pluginManifest.ts` mirrors these rules (action aliases are
shape-checked only — the host is authoritative) and
`packages/orca-plugin/test/manifest.test.ts` validates the shipped
`orca-plugin.json` against it on every `npm test`.

Other references:

- Orca CLI overview: `https://www.onorca.dev/docs/cli/overview`.
- Pi coding-agent CLI: `https://github.com/up0to1/pi-mono/blob/main/packages/coding-agent/README.md`.

## Re-validating against a new Orca release

1. Note the new app version from `orca status --json`
   (`result.runtime.appVersion`).
2. Re-read the upstream files above; update `TARGET_ORCA_APP_VERSION` in
   `packages/core/src/version.ts`, `engines.orca` in
   `packages/orca-plugin/orca-plugin.json`, and this file.
3. Run the manual smoke test in `README.md` (load the plugin folder in Orca,
   verify it loads without destabilizing Orca).
4. Record the outcome in the release notes / Linear update.

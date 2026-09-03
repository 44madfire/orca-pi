# Orca plugin API target (OP1.1)

This scaffold targets the Orca plugin surface as of **Orca app `1.4.196`**
(`orca` CLI reporting `result.runtime.appVersion: 1.4.196`).

## What we assume

- The plugin ships as a static artifact: `orca.plugin.json` (manifest) +
  `panel.html` + `commands.json` + `skills/`, with an optional dependency-free
  `dist/index.js` that only describes contributions.
- The plugin worker **must not** rely on unrestricted Node `child_process`
  access. All process spawning lives in the companion `orca-pi` CLI, which the
  plugin invokes only through Orca-supported capabilities (where available) or
  by asking the user to run `orca-pi doctor` in a terminal.

## Why this shape

- Upstream pluggable-harness proposal: `stablyai/orca#13306`
  (`src/shared/plugins/plugin-content-pack-contributions.ts`,
  `src/shared/plugins/plugin-artifact-validation.ts`).
- Plugin capability limitations: `stablyai/orca#15637`
  (`src/shared/plugins/plugin-capabilities.ts`,
  `src/main/plugins/plugin-event-bus.ts`).
- Orca CLI overview: `https://www.onorca.dev/docs/cli/overview`.
- Pi coding-agent CLI: `https://github.com/up0to1/pi-mono/blob/main/packages/coding-agent/README.md`.

The exact manifest schema for third-party plugins is still stabilizing
upstream. `packages/core/src/pluginManifest.ts` therefore defines our
best-effort forward-compatible manifest shape (`name`, `displayName`,
`version`, `description`, `orcaApiVersion`, `contributions.commands`,
`contributions.panels`, `contributions.skills`) and `packages/orca-plugin`
validates the shipped `orca.plugin.json` against it in `npm test`.

## Re-validating against a new Orca release

1. Note the new app version from `orca status --json`
   (`result.runtime.appVersion`).
2. Update `TARGET_ORCA_APP_VERSION` in `packages/core/src/version.ts`,
   `minOrcaAppVersion` in `packages/orca-plugin/orca.plugin.json`, and this file.
3. Run the manual smoke test in `README.md` (install the plugin in Orca,
   verify it loads without destabilizing Orca).
4. Record the outcome in the release notes / Linear update.

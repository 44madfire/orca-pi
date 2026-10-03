# Vendored pi-subagents (DO NOT EDIT — refresh with `node scripts/vendor-pi-subagents.mjs`)

- Source: https://github.com/44madfire/pi-packages.git (`packages/pi-subagents`)
- Pinned commit: 76b85c21b7490f2b4c1f2842acb1964cf7fda5a5
- Branch at vendor time: `feat/model-aliases` (upstream PR #1 — re-vendor from `main` once merged)
- Vendored: 2026-10-03 — `src/`, `package.json`, `LICENSE`, `docs/configuration.md`
  (tests, media, and remaining docs intentionally excluded; ~660KB)
- Sanity gate passed: `modelAliases` in `src/settings.ts`, `expandModelAlias` in
  `src/session/model-resolver.ts`

Why vendored instead of referenced: Orca `new-child` worktrees only reproduce
tracked files, so a machine-local clone path would not exist at worker launch.
A committed copy keeps `profiles/driver.yaml`'s extension entries valid in
every worktree by git construction.

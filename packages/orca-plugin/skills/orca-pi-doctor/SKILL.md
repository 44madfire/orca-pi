# orca-pi-doctor

Thin Orca skill placeholder (OP1.1 scaffold). It documents the read-only
diagnostic flow; execution lives in the companion `orca-pi` CLI so the plugin
worker never needs unrestricted process spawning.

Note: manifest v1 has no `skills` contribution point, so this skill is not
wired into `orca-plugin.json` — install it through Orca's skill flow.

## Use

Run in a terminal (not from the plugin worker):

```sh
orca-pi --version
orca-pi doctor
orca-pi doctor --json
```

## Expected

- `orca-pi doctor` exits `0` when both `orca` and `pi` are on PATH with
  parseable versions, and exits `1` otherwise.
- Missing executables produce actionable install hints; the command never
  mutates configuration.

## Targets

- Orca app `1.4.196`, plugin API `1.4.x` (see `docs/ORCA_PLUGIN_API.md`).

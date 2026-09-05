# Spike runner (SNC1.1)

Minimal strict LF-only client + live capture against a real Pi binary.

## Layout

- `../src/spike-client.ts` — the spike client (strict JSONL, id correlation).
- `../src/jsonl.ts` — LF-only framing (no `readline`).
- `capture.mjs` — regenerates `../fixtures/*.jsonl` + `baseline.json` from a
  real `pi --mode rpc` binary (offline probes + cheap online LLM turns).
- This README — procedure and cost controls.

## Prerequisites

- `pi` on PATH (validated: `0.84.4`).
- Provider auth in `PI_CODING_AGENT_DIR` (or `~/.pi/agent` for manual runs).
- Network for LLM turns; `--offline` probes need no network.

## Regenerate fixtures (isolated, cheap)

```sh
# From repo root:
node packages/pi-rpc/spike/capture.mjs --offline-only
node packages/pi-rpc/spike/capture.mjs --full  # includes ~8 short LLM turns (glm-5.3-flash, low thinking)
```

`capture.mjs` always uses an isolated temp `PI_CODING_AGENT_DIR` (auth copied,
settings minimal) so global `~/.pi/agent/settings.json` is never mutated by
`set_steering_mode` / `set_auto_compaction` probes. It prints per-scenario
record counts and rewrites fixtures already normalized
(`<SESSION_ID>`, `<ENTRY_ID>`, `<TIMESTAMP_*>`, `<SESSION_FILE>`, …).

Cost control for `--full`: two text turns, one thinking turn, two tool turns,
one image turn, one abort turn, one queue turn — all on
`opencode-go/glm-5.3-flash` with `low` thinking except the thinking probe
(`high`). Each prompt constrains output length explicitly.

## Manual one-off probe

```sh
node -e "import('./packages/pi-rpc/dist/spike-client.js')"
```

Prefer `SpikeClient` from `@orca-pi/pi-rpc` in Node scripts:

```js
import { SpikeClient } from "@orca-pi/pi-rpc";
const c = new SpikeClient({ piArgs: ["--no-session", "--offline"] });
await c.start();
const state = await c.waitResponse({ id: "s1", type: "get_state" });
console.log(state);
await c.close();
```

## What the spike proves

- LF-only framing incl. literal U+2028/U+2029 (`bash-rpc` fixture).
- Startup/idle, text, thinking, tools, abort, queue, state/tree/leaf,
  models/thinking switch, images, extension UI, resume/branch, malformed,
  exit — see `../docs/pi-rpc-contract.md` and `../fixtures/README.md`.

# Spike runner (SNC1.1)

Minimal strict LF-only client + live capture against a real Pi binary.

## Layout

- `../src/spike-client.ts` — the spike client (strict JSONL, id correlation).
- `../src/jsonl.ts` — LF-only framing (no `readline`).
- `capture.mjs` — captures `../fixtures/*.jsonl` + `baseline.json` live from
  a real `pi --mode rpc` binary through the spike client (one process per
  fixture, so each file is internally coherent). Each scenario normalizes
  with a fresh `createRecordNormalizer()` (identity-preserving numbered
  aliases) and writes LF-only JSONL.
- This README — procedure and cost controls.

## Prerequisites

- A Pi binary: `PI_RPC_PI_CLI` env override (binary or bundle `cli.js`),
  else `pi` on PATH (verified with `--version`), else the global npm
  bundle. Validated against `0.85.1`.
- Provider auth in `~/.pi/agent` (copied into an isolated temp
  `PI_CODING_AGENT_DIR` per run) for `--full`.
- Network for LLM turns and the model catalog; `--offline-only` needs none
  of the LLM turns (catalog reads still prefer network).

## Regenerate fixtures (isolated, cheap)

```sh
# From repo root (build first so capture uses fresh ../dist):
npm run build
node packages/pi-rpc/spike/capture.mjs --offline-only
node packages/pi-rpc/spike/capture.mjs --full  # ~10 short LLM turns (glm-5.3-flash)
node packages/pi-rpc/spike/capture.mjs --full --only abort-queue  # one fixture
```

`--offline-only` captures `startup-idle`, `bash-rpc`, `models-thinking`,
`malformed-exit` (with the observed stdin-EOF exit row), and `baseline.json`
— no LLM calls. `--full` additionally captures `text-streaming`,
`thinking`, `tool-execution`, `abort-queue` (incl. the live
prompt-while-streaming rejection on the aborted turn), `state-tree` (with
`--session-dir`, so `sessionFile` is present), `images`, `extension-ui`
(temp extension exercising select/confirm/input/editor/cancel,
auto-answered), and `resume-branch` (session dir +
switch/fork/clone/new). Every run uses an isolated temp
`PI_CODING_AGENT_DIR` (auth copied, settings minimal) so global
`~/.pi/agent/settings.json` is never mutated by `set_steering_mode` /
`set_auto_compaction` probes, plus an isolated cwd with a deterministic
`probe-note.json` tool-input file and ambient-off flags
(`--no-skills --no-prompt-templates --no-extensions --no-context-files`,
explicit `--extension` still loads) so regeneration is machine-independent.
Each fixture print shows record counts.

Cost control for `--full`: short constrained prompts on
`opencode-go/glm-5.3-flash` with `low` thinking except the thinking probe
(`high`); the abort turn is capped (~100 words) and aborts on the first
streamed delta.

## Manual one-off probe

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

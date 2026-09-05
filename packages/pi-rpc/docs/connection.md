# Pi RPC Production Connection (SNC1.2)

Production-quality, Orca-independent transport for `pi --mode rpc`,
built on the SNC1.1 contract (`pi-rpc-contract.md`, `fixtures/*.jsonl`).

> Rule: `packages/pi-rpc` knows about Pi, not Orca. It never imports Orca
> journal/session types. The SNC1.3 bridge owns Pi → Orca translation.

## Usage

```ts
import { PiRpcConnection, buildPiRpcLaunch } from "@orca-pi/pi-rpc";

// Transport-neutral launch (mirrors JEF-7 field→flag mapping, no TUI flags).
const spec = buildPiRpcLaunch({
  profile: {
    provider: "opencode-go",
    model: "glm-5.3-flash",
    thinking: "low",
    tools: ["read", "bash"],
    discoverSkills: false,
    discoverExtensions: false,
    contextFiles: false,
  },
  cwd: "/worktree",
  env: { PI_CODING_AGENT_DIR: "/tmp/isolated-agent" },
});

const conn = new PiRpcConnection({
  piCommand: spec.command,
  piArgs: spec.args, // `--mode rpc` is idempotent; connection adds it if missing
  cwd: spec.cwd,
  env: { ...process.env, ...spec.env },
});
await conn.start();

conn.onEvent((ev) => console.log("event", ev.type));
conn.onExtensionUiRequest((req) => {
  // Dialogs (select/confirm/input/editor) need a response; fire-and-forget
  // (notify/setTitle/…) are safe to ignore.
});

await conn.prompt("Say hi");
await conn.waitForSettled(); // completion, not the prompt accept response
await conn.close(); // EOF → exit 0, then SIGTERM → SIGKILL with cleanup
```

## Accepted / rejected / ambiguous

- **Accepted**: `request()` resolves (`success: true`). For `prompt` this
  means queued/handled, not completed — completion is `agent_end` +
  `agent_settled` (use `waitForSettled()`).
- **Rejected** (`PiRpcError` code `"rejected"`, `ambiguous: false`): Pi
  definitively refused (`success: false` + `error`); no partial state change
  per contract (e.g. prompt-while-streaming without `streamingBehavior`).
- **Ambiguous** (`ambiguous: true`): transport failed after the write
  succeeded (`request-timeout`, `process-exited`, `transport-closed`), so the
  caller cannot know if Pi processed the command. Re-read state
  (`get_state`, `get_entries` with `since`) before retrying; never retry
  blindly.

## Lifecycle / framing / diagnostics

- **Framing**: strict LF-only JSONL. Writes are `JSON.stringify(cmd)+"\n"`
  (never CRLF); reads split stdout on `\n` only via `JsonlFramer` (never
  `readline` — it splits on U+2028/U+2029, valid inside JSON strings).
  CRLF input is tolerated (one trailing `\r` stripped); malformed lines emit
  `onMalformedLine` and never break correlation.
- **Correlation**: every `request()` carries an `id` (generated when omitted)
  and resolves by `id`, never by arrival order. `abort` responses may arrive
  after `agent_settled`; `bash_execution_update.id` correlates the `bash`
  command; `tool_*` frames correlate by `toolCallId` (`partialResult`
  replaces display).
- **Deadlines**: every request has a bounded timeout (`defaultTimeoutMs`,
  default 30s, per-request override). Timeouts are ambiguous.
- **Startup**: `start()` classifies spawn errors (`spawn-failed`, incl.
  ENOENT hint), early exits (`startup-failed` with stderr tail), and outer
  timeouts (`startup-timeout`). It never leaks the child on failure.
- **Stderr**: bounded ring buffer (default 16KB), redacted (`bearer`,
  `sk-…`, `eyJ…`, `rt.…`, user paths → `[REDACTED]`) and tail-truncated.
  Errors carry only command name + id + redacted tail — never prompt text,
  image bytes, or credentials.
- **Close**: graceful stdin EOF, then SIGTERM → SIGKILL after `graceMs`
  (default 2s per stage, bounded even when Pi ignores signals). Remaining
  in-flight requests reject as ambiguous `transport-closed`. All stdout/
  stderr/process listeners are removed, stdio destroyed, subscriptions
  cleared. Idempotent; safe idle or active.
- **Surprises** (from fixtures): bogus thinking levels succeed with fallback
  (validate client-side via `getAvailableThinkingLevels()`); `switch_session`
  to a missing path succeeds as a new empty session (confirm in UX); `fork`
  abandons the current branch; `clone` fails closed until saved; empty
  `get_last_assistant_text` returns `{}` (mapped to `null`).

## Launch reuse / TUI exclusion

`buildPiRpcLaunch()` mirrors the transport-neutral subset of
`packages/core/src/pi/build-pi-launch.ts` (provider/model/thinking,
system-prompt literal, tools/exclude-tools, skills/extensions,
prompt-templates, context-files, session dir/file/name, `--mode rpc`)
without importing Orca profile types. TUI-only flags are explicitly rejected
in `extraArgs`: `--theme`, `--use-theme`, `--no-themes`, `--tui-mode`,
`--verbose`, `--print`, `--export`, positional messages, `--models` cycling,
`--approve`, `--continue`/`--resume` pickers. Session resume over RPC uses
typed `switch_session`, not CLI pickers. `resolvePiRpcEnv()` applies an
explicit overlay over a base (default `process.env`) with no hidden ambient
config; tests must set an isolated `PI_CODING_AGENT_DIR`.

## Tests

- `test/connection.test.ts` — framing, fragmentation, U+2028/U+2029,
  interleaving, timeout/exit/malformed, close idle/active, secret-safe
  errors, listener/process cleanup.
- `test/fixtures-replay.test.ts` — replays all 12 SNC1.1 fixtures through a
  live connection with matching accepted/rejected outcomes.
- `test/launch-errors.test.ts` — argv mapping, TUI rejection, redaction.
- `test/smoke.test.ts` — optional real-Pi offline smoke (`PI_RPC_SMOKE=1`).

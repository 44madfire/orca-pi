# Pi RPC Production Connection (SNC1.2)

Production-quality, Orca-independent transport for `pi --mode rpc`,
built on the SNC1.1 contract (`pi-rpc-contract.md`, `fixtures/*.jsonl`).

> Rule: `packages/pi-rpc` knows about Pi, not Orca. It never imports Orca
> journal/session types. The SNC1.3 bridge owns Pi → Orca translation.

## Usage

```ts
import { buildPiLaunch } from "@orca-pi/core/dist/pi/index.js";
import { PiRpcConnection, toPiRpcProcessSpec } from "@orca-pi/pi-rpc";

// Single-compiler rule: profiles are compiled ONLY by core's buildPiLaunch()
// (JEF-7: projectRoot-relative paths, file-vs-literal --system-prompt
// collision fallback). pi-rpc adapts the resolved spec to RPC transport.
const { spec } = await buildPiLaunch(profile, {
  projectRoot: "/worktree",
  cwd: "/worktree",
  env: { PI_CODING_AGENT_DIR: "/tmp/isolated-agent" },
});
const rpc = toPiRpcProcessSpec(spec);

const conn = new PiRpcConnection({
  piCommand: rpc.command,
  piArgs: [...rpc.args], // `--mode rpc` already appended, idempotent
  cwd: rpc.cwd,
  env: { ...process.env, ...rpc.env },
});
await conn.start(); // gated on a get_state readiness probe by default

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
  after `agent_settled` — see `abortAndWaitForSettled()` below;
  `bash_execution_update.id` correlates the `bash` command; `tool_*` frames
  correlate by `toolCallId` (`partialResult` replaces display).
- **Deadlines**: every request has a bounded timeout (`defaultTimeoutMs`,
  default 30s, per-request override). Timeouts are ambiguous.
- **Startup**: `start()` classifies spawn errors (`spawn-failed`, incl.
  ENOENT hint), early exits (`startup-failed` with stderr tail), and outer
  timeouts (`startup-timeout`). Readiness is gated on a real RPC round-trip
  (bounded internal `get_state` probe) unless `startupProbe: false`: in Node,
  `spawn` only means the OS process was created, so invalid args/config can
  emit `spawn` then exit non-zero on the next turn. The probe turns that into
  `startup-failed` instead of a false-ready connection. It never leaks the
  child on failure.
- **Stderr**: bounded ring buffer (default 16KB), redacted (`bearer`,
  `sk-…`, `eyJ…`, `rt.…`, user paths → `[REDACTED]`) and tail-truncated.
  Errors carry only command name + id + redacted tail — never prompt text,
  image bytes, or credentials.
- **Close / unexpected exit / stream errors**: graceful stdin EOF, then
  SIGTERM → SIGKILL after `graceMs` (default 2s per stage, bounded even when
  Pi ignores signals). Remaining in-flight requests reject as ambiguous
  `transport-closed`. Unexpected deaths reject in-flight as ambiguous
  `process-exited` and funnel through the same finalization (stdio destroyed,
  process ref cleared, subscriptions released); `close()` afterwards returns
  the cached exit info. Async `stdin`/`stdout`/`stderr` stream failures
  (e.g. EPIPE, which surfaces via `error` events rather than synchronous
  `write()` throws) and child `error` events are likewise terminal without
  waiting for a later `exit` that Node does not guarantee: in-flight work
  rejects as ambiguous `transport-closed` (secret-safe, command name + id
  only) with the same ownership release. All stream/process listeners are
  removed, stdio destroyed, subscriptions cleared. Idempotent; safe idle or
  active.
- **Abort sequencing**: because the `abort` response can arrive *after*
  `agent_settled`, `await abort(); await waitForSettled()` waits for the
  *next* settle and can time out. Register the waiter first, or use
  `abortAndWaitForSettled()`, which registers `waitForSettled()` before
  sending `abort` and awaits both concurrently.
- **Surprises** (from fixtures): bogus thinking levels succeed with fallback
  (validate client-side via `getAvailableThinkingLevels()`); `switch_session`
  to a missing path succeeds as a new empty session (confirm in UX); `fork`
  abandons the current branch; `clone` fails closed until saved; empty
  `get_last_assistant_text` returns `{}` (mapped to `null`).

## Launch reuse / TUI exclusion

Profiles are compiled only by core's `buildPiLaunch()`; `toPiRpcProcessSpec()`
adapts the resolved `{command, args, cwd, env}` to RPC transport (TUI check +
idempotent `--mode rpc`, frozen). Already-resolved values — absolute
`--skill`/`--extension` paths, collision-safe `--system-prompt` (literal or
content-addressed temp path) — pass through untouched, so JEF-7 prompt
collision/path semantics are preserved by construction. TUI-only flags are
explicitly rejected: `--theme`, `--use-theme`, `--no-themes`, `--tui-mode`,
`--verbose`, `--print`, `--export`, positional messages, `--models` cycling,
`--approve`, `--continue`/`--resume` pickers. Session resume over RPC uses
typed `switch_session`, not CLI pickers. `resolvePiRpcEnv()` applies an
explicit overlay over a base (default `process.env`) with no hidden ambient
config; tests must set an isolated `PI_CODING_AGENT_DIR`.

## Tests

- `test/connection.test.ts` — framing, fragmentation, U+2028/U+2029,
  interleaving, startup probe gating, timeout/exit/malformed, close
  idle/active, unexpected-exit cleanup, abort sequencing, secret-safe errors,
  listener/process cleanup.
- `test/fixtures-replay.test.ts` — replays all 12 SNC1.1 fixtures through a
  live connection with matching accepted/rejected outcomes.
- `test/launch-errors.test.ts` — spec adapter passthrough, TUI rejection,
  redaction.
- `test/smoke.test.ts` — optional real-Pi offline smoke (`PI_RPC_SMOKE=1`).

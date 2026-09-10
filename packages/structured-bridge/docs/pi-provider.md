# Pi Provider — First Real Pi Structured Chat (SNC1.4)

> Status: implemented in `packages/structured-bridge/src/pi-provider.ts` (+
> `pi-provider-cli.js`) with fixture-driven mapping in `pi-mapping.ts`.
> Proves #14 without touching Orca core: the fork vendors only
> `framing.ts` + `protocol.ts` + `host.ts`; `pi-provider.ts` stays in
> `orca-pi` like `provider.ts` + `mock-provider-cli.js` + `pi-mapping.ts`.

## 1. What it does

One `pi --mode rpc` child per bridge session (`cwd` = acquire
`workspaceRoot`, the exact Orca-selected workspace). Transport-neutral
profile configuration travels via `resolvePiSpec` (callers pass
`buildPiLaunch()` output; overlays merge via `resolvePiRpcEnv(overlay,
process.env)` so ambient PATH/auth/config survives, `piEnv` wins on conflict,
spawn-only never the bridge); TUI-only flags are rejected fail-closed via
`toPiRpcProcessSpec`; `--mode rpc` is appended idempotently. No terminal
keystroke injection anywhere on this path.

- `hello` → `hello_ok{provider:{id:"pi"},capabilities}` with SNC1.4-truthful
  flags (`options:false`, `resume:false`: model/thinking controls are SNC1.6,
  history/branch/resume is SNC1.7, so Orca never exposes diverging controls)
- `acquire{workspaceRoot,options?}` → spawn + `start()` + `get_state` →
  `acquired{metadata{sessionId,providerSessionId,workspaceRoot,model?,thinkingLevel?,messageCount,isStreaming:false}}`
- `dispatch{text,images?,queue?}` → `validatePiDispatch` (+ leading-`/`
  extension-command rejection for SNC1.6) → idle Pi `prompt` →
  `dispatch_ack{accepted|rejected|unknown}` + streamed `session_event`s.
  Busy-session dispatches (including `steer`/`followUp`) are honestly
  rejected — one turn at a time; Pi-owned queue fidelity is SNC1.5.
- `cancel{targetOpId?}` → Pi `abort()` only when the target is the live turn
  (omitted target means Esc-for-active); stale targets are honest no-ops →
  `cancelled{settled}` + Pi `turn_end{aborted}`/`settled`
- `answer_prompt` → Pi `extension_ui_response` (select/input/editor `{value}`,
  confirm `{confirmed}`, cancel `{cancelled:true}`)
- `release`/`close{mode}` → bounded `PiRpcConnection.close()` per child
  (graceful: EOF→SIGTERM→SIGKILL with the configured grace; `force`: kill-first
  `close(grace, { force: true })` — SIGKILL immediately with no EOF/SIGTERM,
  then a non-zero bounded observation window; `close(0)` cannot observe a real
  child), then `released`/`closed` carrying the observed Pi exit (first
  signaled/non-zero wins, unobserved stays `{null,null}`, never laundered
  clean).
  Provider `dispose()` (also awaited to completion on SIGTERM/SIGINT/stdin-EOF)
  closes every Pi child with observed exit (no leaked processes/listeners).

## 2. Delivery honesty

- `accepted` only after Pi `prompt success:true` on an idle session (Pi
  definitely owns the single active turn). One turn at a time: there is no
  Pi-owned queue in SNC1.4, so every accepted op completes with Pi's own
  `turn_end` + authoritative `agent_settled` under its own op — no synthesized
  completions, no cross-op attribution.
- `rejected` only for definite refusal (`success:false`, empty text, unknown
  session, Pi-exited reacquire hint, and any dispatch — including
  `steer`/`followUp` — while a turn streams). The busy rejection is definite:
  Pi never saw the prompt, so it is safe to retry after idle or cancel.
  Queued Pi-owned delivery needs user-message/`queue_update` evidence plus
  retry/compaction boundaries owned by the SNC1.5 lifecycle translator, so
  SNC1.4 declines the queue rather than guessing ownership from turn
  boundaries (which misattributes tool continuations/retries and fabricates
  history).
- `unknown` for ambiguity (timeout/exit/close after the write on an idle
  session). Pending-op state (`activeOpId`/`isStreaming` + unjournaled
  `pendingUserText`) is retained *before* the write; `turn_start` proves
  receipt (journaling the pending user immediately, so exit-before-`turn_end`
  still leaves history evidence), then `turn_end` journals user→assistant in
  order. Idle reconciliation (`get_state`) clears unlanded pending turns
  (history stays clean); fully landed turns that settle before the timeout
  journal once (no duplication). Sequential idle turns journal naturally in
  transcript order. The provider sends `unknown` fast; callers reconcile via
  history and never auto-resend.

## 3. Streaming

`PiRpcConnection.onEvent` → `mapPiRecordToBridgeEvents` → bridge
`session_event` with the active dispatch `opId`:

```text
Pi turn_start                    → turn_start
Pi message_update text_start/delta/end → text_start/delta/end
Pi turn_end{stop/aborted}        → turn_end{stop/aborted}
Pi agent_settled                 → settled (+ journal + finishTurn)
Pi extension_ui_request dialog   → prompt_request (pendingPrompt for answer)
Pi tool_execution_*              → tool_start/progress/end (SNC1.5 owns faithful rendering)
agent_start/agent_end/message_start/end, toolcall deltas,
notify/setTitle/setStatus, queue_update → ignored ([])
```

`isStreaming` follows the single active turn; `cancelled.settled` reports actual
state (`true` only when idle). Assistant text accumulates from authoritative
`text_end.text` into `get_history` (user + assistant) for `unknown`
reconciliation. Multi-turn tool flows journal per `turn_end` under the same op
and complete once per `agent_settled` (SNC1.5 owns per-turn journal identities
and queued-delivery boundaries).

## 4. Failures (secret-safe, actionable)

- Missing Pi binary → `PI_STARTUP_FAILED` (spawn-failed hint).
- Early exit / bad args / auth / model → `PI_STARTUP_FAILED` /
  `PI_STATE_FAILED` quoting only `PiRpcError.toSecretSafeString()` (safe by
  construction: command name + id + redacted tail) — foreign error text is
  never forwarded, so no prompt text, paths, or token-shaped values leak.
  Pi free-text `turn_end{error}` collapses to the stable generic
  `provider dispatch failed` per bridge §6.
- TUI-only launch flags → `PI_TUI_FLAG` (fall back to normal Pi TUI).
- Pi death mid-turn → shaped `turn_end{error}` + `settled` (UI unsticks);
  already-journaled turns survive so `unknown` reconciles without duplicates;
  next dispatch reports `rejected: pi-exited (reacquire)` until explicit
  reacquire (resume is SNC1.7).
- Malformed bridge lines → `BAD_MESSAGE`/`PARSE_ERROR` (never crash).

## 5. Run it

```sh
npm run build
# Mock (no Pi):
node packages/structured-bridge/dist/mock-provider-cli.js
# Pi-backed (real Pi on PATH, isolated dir recommended):
node packages/structured-bridge/dist/pi-provider-cli.js
node packages/structured-bridge/dist/pi-provider-cli.js --pi-command pi --pi-arg --offline
ORCA_PI_PI_COMMAND=pi ORCA_PI_PI_ARGS="--offline" node packages/structured-bridge/dist/pi-provider-cli.js
```

Orca dev shell:

```sh
export ORCA_PI_BRIDGE_COMMAND="node /path/to/orca-pi/packages/structured-bridge/dist/pi-provider-cli.js"
# Orca fork with --enable-external-structured-bridge, then normal Native Chat
# outbox send flow: acquire → dispatch{accepted} → streamed reply → settled,
# Esc → cancelTurn, close → release + bounded dispose (no resident helper).
```

Missing/incompatible bridge still falls back to the ordinary Pi TUI path
(host `probeSupport(){available:false}`); packaged Orca never requires it.

## 6. Scope guard

SNC1.4 is basic text chat. Thinking/tool/error translation beyond text +
turn + cancel is SNC1.5; model/thinking controls, prompts, images are
SNC1.6; history/branch/resume is SNC1.7 (which will reconstruct from Pi
`get_entries`/`get_tree` instead of the live-turn journal used here).
`set_options` stores + acks; `get_history`/`get_session` serve live-turn
state.

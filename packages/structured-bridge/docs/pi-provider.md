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
`buildPiLaunch()` output); TUI-only flags are rejected fail-closed via
`toPiRpcProcessSpec`; `--mode rpc` is appended idempotently. No terminal
keystroke injection anywhere on this path.

- `hello` → `hello_ok{provider:{id:"pi"},capabilities:piBridgeCapabilities()}`
- `acquire{workspaceRoot,options?}` → spawn + `start()` + `get_state` →
  `acquired{metadata{sessionId,providerSessionId,workspaceRoot,model?,thinkingLevel?,messageCount,isStreaming:false}}`
- `dispatch{text,images?,queue?}` → `validatePiDispatch` → Pi `prompt`
  (with `streamingBehavior` for `steer`/`followUp`) →
  `dispatch_ack{accepted|rejected|unknown}` + streamed `session_event`s
- `cancel` → Pi `abort()` → `cancelled{settled}` + Pi `turn_end{aborted}`/`settled`
- `answer_prompt` → Pi `extension_ui_response` (select/input/editor `{value}`,
  confirm `{confirmed}`, cancel `{cancelled:true}`)
- `release`/`close` → bounded `PiRpcConnection.close()` per child, then
  `released`/`closed`; provider SIGTERM/stdin-EOF closes every Pi child
  (no leaked processes/listeners).

## 2. Delivery honesty

- `accepted` only after Pi `prompt success:true` (Pi definitely owns it).
- `rejected` only for definite refusal (`success:false`, empty text,
  unknown session, busy + `queue:reject`, Pi-exited reacquire hint).
- `unknown` for ambiguity (timeout/exit/close after the write). The provider
  sends `unknown` fast instead of waiting for the host deadline; callers
  reconcile via `get_history` before retrying and never auto-resend.

## 3. Streaming

`PiRpcConnection.onEvent` → `mapPiRecordToBridgeEvents` → bridge
`session_event` with the active dispatch `opId`:

```text
Pi turn_start                    → turn_start
Pi message_update text_start/delta/end → text_start/delta/end
Pi turn_end{stop/aborted}        → turn_end{stop/aborted}
Pi agent_settled                 → settled (+ journal + finishTurn/queue drain)
Pi extension_ui_request dialog   → prompt_request (pendingPrompt for answer)
Pi tool_execution_*              → tool_start/progress/end (SNC1.5 owns faithful rendering)
agent_start/agent_end/message_start/end, toolcall deltas,
notify/setTitle/setStatus, queue_update → ignored ([])
```

`isStreaming` follows the active turn; `cancelled.settled` reports actual
state (`true` only when idle). Assistant text accumulates from authoritative
`text_end.text` into `get_history` (user + assistant) for `unknown`
reconciliation. Multi-turn tool flows settle once per `agent_settled`
(SNC1.5 owns per-turn journal identities).

## 4. Failures (secret-safe, actionable)

- Missing Pi binary → `PI_STARTUP_FAILED` (spawn-failed hint).
- Early exit / bad args / auth / model → `PI_STARTUP_FAILED` /
  `PI_STATE_FAILED` with bounded redacted diagnostics (no prompt text, no
  credentials/paths).
- TUI-only launch flags → `PI_TUI_FLAG` (fall back to normal Pi TUI).
- Pi death mid-turn → shaped `turn_end{error}` + `settled` (UI unsticks);
  queued steer/followUp dropped; next dispatch reports
  `rejected: pi-exited (reacquire)` until explicit reacquire (resume is SNC1.7).
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

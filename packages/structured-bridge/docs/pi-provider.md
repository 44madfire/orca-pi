# Pi Provider — Real Pi Structured Chat (SNC1.4 + SNC1.5)

> Status: SNC1.4 basic text chat plus SNC1.5 thinking/tools/errors/lifecycle
> translation, implemented in `packages/structured-bridge/src/pi-provider.ts`
> (+ `pi-provider-cli.js`) with fixture-driven mapping in `pi-mapping.ts` and
> the pure, fixture-testable turn translator in `src/pi-translator.ts`
> (`test/pi-translator.test.ts` replays real SNC1.1 fixtures with no Orca/Pi).
> Proves #14 and #15 without touching Orca core: the fork vendors only
> `framing.ts` + `protocol.ts` + `host.ts`; `pi-provider.ts` (+ `pi-mapping.ts`
> + `pi-translator.ts`) stays in `orca-pi` like `provider.ts` +
> `mock-provider-cli.js`.

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

## 3. Streaming (SNC1.5 translator)

`PiRpcConnection.onEvent` → `PiTranslator.applyPiRecord` (wrapping
`mapPiRecordToBridgeEvents` with dedupe/coalescing) → bridge `session_event`
with the active dispatch `opId` (see `src/pi-translator.ts`, fixture-tested in
`test/pi-translator.test.ts` without Orca or Pi):

```text
Pi turn_start                                 → turn_start (journals pending user)
Pi message_update text_start/delta/end        → text_start/delta/end (stable contentIndex)
Pi message_update thinking_*/text_* interleave → thinking_*/text_* (separate channels)
Pi message_update toolcall_start/end          → tool_start (stable toolCallId, provisional→authoritative)
Pi tool_execution_start                       → tool_start (dedupe same id → one card)
Pi tool_execution_update (cumulative)         → tool_progress (replace display)
Pi tool_execution_end (+isError)              → tool_end (reconciles, isError faithful)
Pi turn_end{stop/aborted/toolUse}             → turn_end{stop/aborted} (toolUse→stop; journals user→tools→assistant)
Pi agent_settled{willRetry}                   → settled (drains remainder, clears ALL transient)
Pi extension_ui_request dialog                → prompt_request (pendingPrompt for answer)
agent_start/agent_end/message_start/end, toolcall_delta,
bash_execution_update, queue_update, compaction_*, thinking_level_changed,
session_info_changed, notify/setTitle/setStatus, responses, unknown → [] (bounded)
```

`isStreaming` follows the single active turn (lifecycle-driven, not terminal
heuristics); `cancelled.settled` reports actual state (`true` only when idle).
Assistant text journals from authoritative `text_end.text` (falling back to
deltas only for aborted partials with no final) into `get_history` (user +
tools + assistant) for `unknown` reconciliation — finals reconcile, never
duplicate deltas. Thinking streams separately and never journals as prose.
Tool stdout stays in tool events/history (never assistant text). Multi-turn
tool flows journal per `turn_end` under the same op and complete once per
authoritative `agent_settled`; settled clears translator transient +
cancelled-op + pending-prompt state so settled turns retain nothing
(`hasTransient()===false`). Unknown/suppressed chrome maps to `[]` with no
state change and never terminates a session.

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

SNC1.4 was basic text chat; SNC1.5 lands faithful thinking/tool/error/
lifecycle translation (this doc §3 + `pi-translator.ts` + fixture replay).
Queued `steer`/`followUp` while busy stays honestly rejected (Pi-owned queue
fidelity needs `queue_update`/retry/compaction evidence beyond turn
boundaries — still deferred, not guessed). Model/thinking controls, prompts,
images are SNC1.6; history/branch/resume is SNC1.7 (which will reconstruct
from Pi `get_entries`/`get_tree` instead of the live-turn journal used here).
`set_options` stores + acks; `get_history`/`get_session` serve live-turn
state (now user + tools + assistant).

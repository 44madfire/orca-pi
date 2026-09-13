# Pi Provider — Real Pi Structured Chat (SNC1.4 + SNC1.5 + SNC1.6 + SNC1.7)

> Status: SNC1.4 basic text chat plus SNC1.5 thinking/tools/errors/lifecycle
> translation plus SNC1.6 model/thinking controls, interactive prompts, and
> structured images plus SNC1.7 history/current-branch/resume, implemented in
> `packages/structured-bridge/src/pi-provider.ts` (+ `pi-provider-cli.js`)
> with fixture-driven mapping in `pi-mapping.ts`, the pure turn translator in
> `src/pi-translator.ts`, and the pure history reconstructor in
> `src/pi-history.ts` (`test/pi-history.test.ts` + `test/pi-provider-snc17.test.ts`
> pin #17 with no Orca/Pi).
> Proves #14, #15, #16, and #17 without touching Orca core: the fork vendors only
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

- `hello` → `hello_ok{provider:{id:"pi"},capabilities}` with SNC1.7-truthful
  flags (`options:true` — model/thinking/prompt/image controls are live —
  `resume:true`: history/branch/resume is live via Pi `get_entries`/`get_tree`,
  so Orca may expose its shared Native Chat resume paths)
- `acquire{workspaceRoot,options?}` → spawn + `start()` + `get_state` + live
  `applyPiOptions(model/thinking/autoCompaction)` →
  `acquired{metadata{sessionId,providerSessionId,workspaceRoot,model?,thinkingLevel?,messageCount,isStreaming:false}}`
  with provider-confirmed values (bad refs fail closed with
  `UNKNOWN_MODEL` / `AMBIGUOUS_MODEL` / `UNKNOWN_THINKING_LEVEL`, no leaked
  child, Orca stays on TUI)
- `dispatch{text,images?,queue?}` → `validatePiDispatch` + live image gating
  (hint floor + cached-catalog `model-rejects-images`) → idle Pi `prompt` →
  `dispatch_ack{accepted|rejected|unknown}` + streamed `session_event`s.
  Busy-session dispatches (including `steer`/`followUp`) are honestly
  rejected — one turn at a time; Pi-owned queue fidelity stays deferred.
  Idle `/` extension commands run immediately without a turn (no history
  entries, per the Pi contract); busy `/` stays honestly rejected to avoid
  concurrent attribution without queue evidence; `/` with images is
  rejected (`extension-command-images-unsupported`).
- `set_options{model?,thinkingLevel?,queueMode?,autoCompaction?}` → live Pi
  `get_available_models` / `set_model`, `get_available_thinking_levels` /
  `set_thinking_level`, `set_auto_compaction` with exact-match semantics
  (no fuzzy/wildcard) → `options_updated` with provider-confirmed values
  (Orca-normal persistence: `session.options` + `metadata` hold confirmed
  state; `acquire` restores the same way). Two-phase discipline: every
  requested field passes capability preflight (model/thinking/autoCompaction)
  and read-only validation before any mutating RPC issues. Thinking levels
  are current-model-scoped, so a compound `{model, thinking}` validates the
  level against the TARGET model after the switch, with best-effort rollback
  to the incumbent on mismatch. Validation failures leave Pi and the lease
  untouched; a mid-apply *transport* failure reports `error` and the host
  reconciles actual Pi state via `get_session`. Failures return shaped `error`
  (`UNKNOWN_MODEL` / `AMBIGUOUS_MODEL` / `UNKNOWN_THINKING_LEVEL` /
  `PI_OPTION_FAILED` / `PI_OPTION_UNSUPPORTED`), never a diverging ack;
  a mid-apply *transport* failure also reports `error` and the host
  reconciles actual Pi state via `get_session`.
- `get_session` → best-effort `get_state` refresh (provider-confirmed
  model/thinking/counts/streaming) + cached lease fallback (never fails on
  transient state reads). `thinking_level_changed` Pi events also update
  the lease live.
- `cancel{targetOpId?}` → retire that op's pending dialogs (SNC1.6 provider-
  cancellation retirement) + Pi `abort()` only when the target is the live
  turn (omitted target means Esc-for-active); stale targets are honest
  no-ops (never abort live turns, never touch live prompts) →
  `cancelled{settled}` + Pi `turn_end{aborted}`/`settled`
- `answer_prompt` → exactly-once Pi `extension_ui_response` (select/input/
  editor `{value}`, confirm `{confirmed}`, cancel `{cancelled:true}`) with
  stable per-session `requestId` identity (`<sessionId>:<piId>` — Pi children
  are independently spawned processes with only process-local dialog ids, so
  the bridge namespaces them and retains the raw Pi id for the response);
  duplicates / unknown / retired ids refuse
  with `UNKNOWN_REQUEST` (never re-sent, never broadcast); benign `ANSWERED`
  ack resolves the host without echoing values
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
Pi agent_settled{willRetry}                   → settled (drains remainder, clears ALL transient + retires op prompts)
Pi extension_ui_request dialog                → prompt_request (stable requestId, multi-dialog map, exactly-once)
Pi thinking_level_changed{level}              → lease update (no bridge event; get_session reports confirmed)
agent_start/agent_end/message_start/end, toolcall_delta,
bash_execution_update, queue_update, compaction_*, session_info_changed,
notify/setTitle/setStatus, responses, unknown → [] (bounded)
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


## 3b. History / current branch / resume (SNC1.7)

`src/pi-history.ts` (pure, fixture-testable) + `PiBridgeProvider`
`acquire{resumePath}` / `get_history{leafId}` (see `test/pi-history.test.ts`
+ `test/pi-provider-snc17.test.ts`, no Orca/Pi):

```text
acquire{resumePath} → switch_session → get_entries(+leafId)/get_tree fallback
  → active branch root→leaf (abandoned fork siblings excluded)
  → translate (same mapping as live) → acquired{resumed, metadata}
get_history → rebuilt + live-appended transcript, leafId = Pi leaf
```

- Active branch only: flat `get_entries` + `leafId` parent walk is primary
  (single RPC); `get_tree` flattened to the same walk is the fallback when
  the flat chain is broken. Both converge; abandoned siblings never render.
- Convergent translation: user text → `user` (image bytes never journaled);
  assistant text → `assistant` (thinking never prose; tool-only assistants
  journal nothing); `toolResult`/`bashExecution` → `tool` (tool stdout never
  assistant prose); `model_change`/`thinking_level_change`/`session_info`/
  `compaction_*`/`summary`/`custom`/unknown → skipped for the transcript but
  kept for chain continuity (same bounded-ignore as live `[]`).
- Reconciliation without duplication: rebuilt rows use Pi entry `id` verbatim
  (stable across restarts) with Pi `parentId` preserved for handoff metadata;
  resume replaces wholesale when idle (Pi is the source of truth after
  `switch_session`; landed live rows converge by identical `(role, text)`
  order). Streaming turns are never rebuilt mid-turn (live owns them).
- Same-session resume after helper/provider restart: new provider + same
  `resumePath` → identical transcript + stable ids + Pi leaf (Orca owns
  `resumePath` for handoff; the provider never echoes paths — only opaque
  `providerSessionId`/`leafId` cross the bridge).
- Partial/aborted recovery: trailing `user` without `assistant` stays lone
  `user` (no fabricated completion); `aborted` assistants still journal text.
- Fail-closed (actionable, secret-safe, no prompt text or paths):
  `PI_RESUME_UNSUPPORTED` (minimal transport), `PI_RESUME_FAILED`
  (switch failure), `PI_HISTORY_EMPTY` / `PI_HISTORY_LEAF_MISSING` /
  `PI_HISTORY_CHAIN_BROKEN` / `PI_HISTORY_CYCLE` (never silent truncation),
  `PI_HISTORY_INCOMPATIBLE` (messages exist but all roles unknown),
  `PI_HISTORY_BUSY` (rebuild while streaming). Missing-file-creates-empty
  (Pi contract) returns `resumed:false` honestly, not an error.
- `get_history{cursor,limit}` pages the transcript; `leafId` always names the
  Pi leaf (never the page end); cursors naming skipped non-message entries
  resolve via the cached Pi chain to strictly-after rows. `leafId`/chain
  refresh best-effort in the background after each settle (never blocking).

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
SNC1.6 lands model/thinking controls, interactive prompts, and structured
images (this doc §§1–4 + `test/pi-provider-snc16.test.ts`): Orca's existing
shared Native Chat option/prompt/image controls drive Pi with no renderer
fork (capabilities `options:true`); unsupported images / unknown models /
thinking fail closed with actionable codes; prompts are exactly-once with
stable identity and acquisition-fenced retirement. Queued `steer`/`followUp`
while busy stays honestly rejected (Pi-owned queue fidelity needs
`queue_update`/retry/compaction evidence beyond turn boundaries — still
deferred, not guessed). History/branch/resume is SNC1.7 (which reconstructs from Pi `get_entries`/`get_tree` via `pi-history.ts` instead of the live-turn journal alone). `get_history` serves live-turn state (user + tools + assistant,
text only — image bytes never journaled); `get_session` serves
provider-confirmed lease state.

# Structured-Session Bridge Protocol v1 (SNC1.3 — development seam)

Status: **development/test bridge**, not a replacement Native Chat stack.
Orca keeps ownership of journal, lease/fencing, outbox/idempotency,
rendering, and client synchronization. This seam lets Pi-specific
structured-session logic run **out of process** and be **hot-swapped**
without rebuilding Electron for every change.

Target: a small temporary Orca dev branch (see `orca-integration.md`).
If upstream declines the generic seam, this package still carries the full
contract plus mock so `orca-pi` development is unblocked.

## 1. Transport

- **Stdio JSONL, LF-only** (`src/framing.ts` — vendored with the host).
  `JSON.stringify(msg) + "\n"`; split stdout on `\n` only; strip one
  trailing `\r`; never use `readline` (it splits U+2028/U+2029, valid
  inside JSON strings); byte-safe via `StringDecoder`.
- Local development first: the provider is a **local child process**
  spawned at an explicit dev-only path (`ORCA_PI_BRIDGE_COMMAND`, e.g.
  `node …/mock-provider-cli.js` or the Pi bridge). No TCP/remote/mobile
  claims unless proven separately.
- Every record carries `v: 1`. Any other `v` is rejected fail-closed
  (`bad-version` → fallback to Pi TUI, see §7).

## 2. Message map

`opId` is a host-generated unique id per request (see `createOpId()`).
Provider responses echo it. Streaming `session_event` records for a turn
carry the originating dispatch `opId` for correlation.

### Host → provider (h2p)

| `kind` | Purpose | Key fields |
|---|---|---|
| `hello` | Capability negotiation | `opId`, `host{id,version,protocol:1}`, `workspaceRoot` |
| `acquire` | Create/resume a structured session | `opId`, `workspaceRoot`, `resumePath?`, `sessionId?`, `options?` |
| `release` | Drop one session (journal stays in Orca) | `opId`, `sessionId` |
| `dispatch` | Send one text message | `opId`, `sessionId`, `message{text,images?}`, `queue?` (`reject`\|`steer`\|`followUp`, default `reject`) |
| `cancel` | Cancel the active turn | `opId`, `sessionId`, `targetOpId?` |
| `answer_prompt` | Answer an options dialog | `opId`, `requestId`, `value?`, `cancelled` |
| `set_options` | Model/thinking/queue/compaction | `opId`, `sessionId`, `options{model?,thinkingLevel?,queueMode?,autoCompaction?}` |
| `get_history` | Journal slice (Orca reconciles) | `opId`, `sessionId`, `cursor?`, `limit?` |
| `get_session` | Session metadata | `opId`, `sessionId` |
| `close` | Graceful/force provider shutdown | `opId`, `mode`, `sessionId?` |

### Provider → host (p2h)

| `kind` | Purpose | Key fields |
|---|---|---|
| `hello_ok` | Accept the bridge | `opId`, `provider{id,version,protocol:1}`, `capabilities` |
| `hello_error` | Refuse (incompatible/unknown) | `opId`, `error{code,message}` |
| `acquired` | Session ready | `opId`, `sessionId`, `resumed`, `metadata` |
| `released` | Session dropped | `opId`, `sessionId` |
| `dispatch_ack` | Honest delivery verdict | `opId`, `sessionId`, `status: accepted\|rejected`, `reason?` |
| `cancelled` | Cancel observed | `opId`, `sessionId`, `targetOpId`, `settled` |
| `options_updated` | Options applied | `opId`, `sessionId`, `options` |
| `history` | Entries + cursor | `opId`, `sessionId`, `entries[]`, `nextCursor?`, `leafId?` |
| `session` | Metadata snapshot | `opId`, `sessionId`, `metadata` |
| `session_event` | Stream into Orca journal/UI | `sessionId`, `opId?`, `event` (see §3) |
| `closed` | Close observed | `opId`, `sessionId?`, `exit{code,signal}` |
| `exiting` | Provider lifecycle | `exit{code,signal}`, `reason` |
| `error` | Shaped failure (incl. benign `ANSWERED` ack for `answer_prompt`) | `opId?`, `sessionId?`, `error{code,message}` |

The provider **never** sends `unknown`: the host synthesizes
`dispatch{unknown}` on timeout/exit/malformed ack.

## 3. Provider events (`session_event.event`)

Turn lifecycle (Orca renders through the existing shared Native Chat UI):

```text
turn_start
text_start{contentIndex?} → text_delta{delta}* → text_end{text?}
thinking_start → thinking_delta* → thinking_end   (optional channel)
tool_start{toolCallId,toolName,args?} → tool_progress{partialResult}* → tool_end{result,isError}
turn_end{stopReason: stop|aborted|error}
settled{willRetry?}
```

- Concatenate `text_delta` by `contentIndex`; `text_end.text` is authoritative.
- `thinking` preserves signatures opaquely; absence is valid (low thinking).
- `tool` correlation is by `toolCallId`; `partialResult` **replaces** display.
- Completion is `settled`, not the `dispatch_ack`. `abort` arrives as
  `turn_end{aborted}` then `settled`; the host `cancel` ack may arrive first.
- Options dialogs arrive as `prompt_request{requestId,prompt{kind…}}`
  (`select`/`confirm`/`input`/`editor`); the host replies `answer_prompt`.
  Fire-and-forget chrome (`setTitle`/`setStatus`/`notify`/…) is never sent
  over this bridge — providers must not depend on it.
  `session_event` is a closed world: only the `type` values above validate;
  unknown types are dropped, never forwarded to listeners as trusted
  state. `prompt_request` carries the full dialog shape per prompt kind
  (`select` needs non-empty string `options`; `confirm` needs `message`;
  `input`/`editor` titles required, `placeholder`/`prefill` strings when
  present) so UI code can rely on the fields existing.

Example (mock, LF-only, one line each):

```json
{"v":1,"kind":"hello","opId":"hello_1","host":{"id":"orca","version":"0.1.0","protocol":1},"workspaceRoot":"/tmp/ws"}
{"v":1,"kind":"hello_ok","opId":"hello_1","provider":{"id":"mock","version":"0.1.0","protocol":1},"capabilities":{"textStreaming":true,"thinking":true,"tools":true,"images":true,"extensionDialogs":true,"history":true,"options":true,"cancel":true,"resume":true}}
{"v":1,"kind":"acquire","opId":"acq_1","workspaceRoot":"/tmp/ws"}
{"v":1,"kind":"acquired","opId":"acq_1","sessionId":"ses_1","resumed":false,"metadata":{"sessionId":"ses_1","workspaceRoot":"/tmp/ws","messageCount":0,"isStreaming":false,"createdAt":"2026-01-01T00:00:00.000Z"}}
{"v":1,"kind":"dispatch","opId":"dsp_1","sessionId":"ses_1","message":{"text":"hello"}}
{"v":1,"kind":"dispatch_ack","opId":"dsp_1","sessionId":"ses_1","status":"accepted"}
{"v":1,"kind":"session_event","sessionId":"ses_1","opId":"dsp_1","event":{"type":"turn_start"}}
{"v":1,"kind":"session_event","sessionId":"ses_1","opId":"dsp_1","event":{"type":"text_delta","delta":"mock response"}}
{"v":1,"kind":"session_event","sessionId":"ses_1","opId":"dsp_1","event":{"type":"settled","willRetry":false}}
```

## 4. Capabilities

`hello_ok.capabilities{textStreaming,thinking,tools,images,extensionDialogs,history,options,cancel,resume}`.
Missing capabilities degrade gracefully: the host must not offer UI the
provider lacks (e.g. no image picker when `images:false`). The mock
advertises all-true; the Pi mapping (`pi-mapping.ts`) gates `images` on
the model and always offers text/thinking/tools/dialogs/history/options/
cancel/resume.

## 5. Options / history / session metadata

- `BridgeSessionOptions` is a closed shape: `model`/`thinkingLevel`
  strings, `queueMode` ∈ `reject|steer|followUp`, `autoCompaction`
  boolean (extra keys stay forward-compatible; wrong types fail closed
  at validation). The same shape is enforced on `acquire.options`,
  `set_options.options`, and `options_updated.options`, and on the
  optional `model`/`thinkingLevel`/`providerSessionId` metadata fields —
  so a malformed helper can never get a typed `42` persisted into
  session metadata. Pi *value* validation (bogus thinking levels,
  text-only-model images) additionally lives in `pi-mapping.ts` because
  Pi itself is lenient.
- `BridgeHistoryEntry{id,parentId?,role,text?,timestamp}` + `leafId` give
  Orca a durable cursor for `unknown`-dispatch reconciliation:
  `get_history{cursor}` returns strictly-after entries; when `limit`
  truncates, the reply carries `nextCursor` (last returned id) for the next
  page, while `leafId` always names the session leaf (never the page end).
  Absent `nextCursor` means the page reached the leaf. `limit` must be a
  positive integer: `0`/negative/fractional limits are rejected
  fail-closed (`get_history-bad-limit` on the wire,
  `BridgeProtocolError` at the host API) so a caller can never stall on
  an empty first page that looks like the leaf.
- `BridgeSessionMetadata{sessionId,providerSessionId?,workspaceRoot,model?,thinkingLevel?,messageCount,isStreaming,createdAt}`
  is the minimal identity Orca's structured lease needs. No paths beyond
  `workspaceRoot`, no env, no credentials (§6).

## 6. Secret hygiene

Forbidden on the wire in **both** directions (`FORBIDDEN_BRIDGE_KEYS`):
`env`, `processEnv`, `auth`, `credentials`, `apiKey`, `token`,
`refreshToken`, `bearer`, `secret(s)`, `password` (case/underscore
insensitive, substring-suffix match). `validateBridgeMessage()` returns
`credential-field`; both sides drop/send `error{BAD_MESSAGE}` instead of
processing. Key screening alone cannot catch secret *values* inside free
text, so provider turn failures use a stable generic message
(`turn_end{error, errorMessage:"provider dispatch failed"}`) and never
forward raw exception text, which can carry prompt fragments, tokens, or
request payloads. Stderr is bounded (`MAX_STDERR_BYTES`) and every
`redactSecretsFromText()` pattern replaces *all* occurrences; errors
never include prompt text — only opIds, kinds, and codes.

## 7. Failure semantics (fail closed)

| Situation | Host behavior | Orca UX |
|---|---|---|
| Missing binary / spawn error | `probeSupport() → {available:false}` | Ordinary Pi TUI, untouched |
| Hello timeout / `hello_error` / version mismatch | `available:false`, `reason` kept, helper torn down (no resident process) | Pi TUI + one-line notice |
| `dispatch` while unavailable/disposed/never-started | `{status:rejected, reason: bridge-unavailable…}` (explicit `ensureStarted`/`restart` may still start fresh) | Fall back to TUI send |
| `dispatch` with `queue` outside `reject\|steer\|followUp` | wire rejection (`dispatch-bad-queue`), never accepted/queued | Fix the sender; busy sessions keep honest accept/reject |
| `dispatch` after a previously healthy provider exited *or* errored (even with no `exit` after `error`) | `{status:rejected, reason: bridge-unavailable…}` — no implicit respawn; explicit `restart()` respawns | Fall back to TUI; offer explicit reconnect |
| Provider `dispatch_ack{rejected}` | `{status:rejected}` | Surface `reason`, keep TUI available |
| Dispatch timeout / malformed ack / exit racing an in-flight send | `{status:unknown}` | "Check history before retrying — never auto-resend" |
| Malformed provider line | Ignored; waiter deadline → `unknown` | No crash, no journal corruption |
| `cancel`/`history`/`options` transport failure | Throw `BridgeUnavailableError` (not silent) | Toast + TUI fallback |

`queue: reject` (default) makes busy-provider dispatches reject honestly;
`steer`/`followUp` map to Pi `streamingBehavior` in `pi-mapping.ts`.

## 8. Lifecycle / teardown

Every stage is bounded; teardown never hangs (regression: fake ignoring
EOF/SIGTERM/SIGKILL still resolves within ~3 graces):

- `close{graceful}`: host sends `close` (≤3s for `closed`), EOFs stdin and
  waits `closeGraceMs` (default 2s), then SIGTERM and waits `killGraceMs`
  (default: `closeGraceMs`), then SIGKILL and waits `killGraceMs`, then
  synthetic `{code:null,signal:null}` finalization.
- `close{force}`: skips `close`/EOF, SIGKILL + `killGraceMs` wait +
  synthetic finish. `dispose()`: graceful then force, reader detach, timer
  clear, listener/session clear. Idempotent and joins Orca teardown — no
  leaked helper processes or `data`/`exit` listeners.
- Provider exits 0 on stdin EOF; `exiting{code,signal,reason}` precedes
  abnormal exits. Exit, terminal child `error`, or async stdin/stdout/stderr
  stream `error` all funnel through one terminal finalizer: provider/
  capabilities/sessions invalidated, every listener detached, the failing
  child SIGKilled + stdio destroyed while still reachable, then ownership
  cleared (`support.available:false`; `error` without a later `exit` is
  treated the same since Node does not guarantee `exit` after `error`, and
  async EPIPE never surfaces as an uncaught stream exception).
  Post-failure `dispatch` rejects as `bridge-unavailable` until explicit
  `restart()`. In-flight sends racing the failure resolve `unknown`.
  Explicit restart = new OS process + fresh `hello` + `acquire`; sessions do
  not survive restarts (mock proves this; Pi resume is SNC1.7).
- `dispose()` attempts the bridge `close` handshake whenever the child is
  healthy (even mid-teardown), then falls back to bounded EOF/kill; a dead
  or failed child skips the handshake and goes straight to bounded process
  teardown.
- Failed hello/version negotiation tears down the helper (bounded force
  path) so falling back to Pi TUI never leaves a resident process.

## 9. Mock test hooks (deterministic, documented)

The mock provider (`MockExternalProvider`, `mock-provider-cli.js`) honors:

- Any text → `accepted` + `turn_start` → chunked `text_delta`
  (`mock response for: <text>`) → `text_end` → `turn_end{stop}` → `settled`.
- `__prompt_select__` → `prompt_request{select}` then pauses until
  `answer_prompt` resumes the turn (tests options/dialogs).
- `cancel` mid-stream → `turn_end{aborted}` → `settled`.
- Busy session + `queue:reject` (default) → `dispatch_ack{rejected}`.
- Busy session + `queue:steer|followUp` → `dispatch_ack{accepted}` and the
  request streams FIFO after the active turn settles (never concurrently;
  `activeOpId` keeps identifying the running turn for cancel). Base treats
  both modes as FIFO; Pi-specific steer-before-next-call vs after-settle
  ordering is SNC1.4 transport concern.
- `__throw__` → accepted, then the turn fails asynchronously with
  `turn_end{error}` + `settled` (covers provider-failure recovery).
- `cancel` replies `settled:true` only when nothing is streaming (idle);
  cancelling an active turn replies `settled:false` with the `settled`
  event to follow.
- New instance = empty sessions (restart-independence proof).

## 10. Pi mapping (orca-pi owned, not Orca core)

`src/pi-mapping.ts` pins the SNC1.1 contract before SNC1.4 wires the
production `PiRpcConnection`:

- `piBridgeCapabilities(model?)` — images gated on model hints.
- `validatePiDispatch()` — rejects empty text, unknown thinking levels,
  malformed/unsupported images (Pi would silently coerce or fail late).
- `mapBridgeDispatchToPiPrompt()` — bridge `queue` → Pi
  `streamingBehavior`; images preserved opaquely.
- `mapPiRecordToBridgeEvents()` — Pi `message_update`/`tool_*`/
  `agent_*`/`extension_ui_request` → bridge events; fire-and-forget UI
  and `response` envelopes map to `[]` (never streamed).

## 11. Versioning

`BRIDGE_PROTOCOL_VERSION = 1`. Host hello carries `protocol:1`; provider
must echo `protocol:1` in `hello_ok` or send `hello_error{
INCOMPATIBLE_PROTOCOL }`. Any `v !== 1` record is dropped. A future v2
negotiates via a new `hello` field — v1 hosts fail closed rather than
guessing.

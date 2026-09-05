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

- `BridgeSessionOptions{model?,thinkingLevel?,queueMode?,autoCompaction?}`
  is opaque to the generic core; Pi validation lives in `pi-mapping.ts`
  (bogus thinking levels and text-only-model images are rejected
  client-side because Pi itself is lenient).
- `BridgeHistoryEntry{id,parentId?,role,text?,timestamp}` + `leafId` give
  Orca a durable cursor (`get_history{cursor}` returns strictly-after
  entries) for `unknown`-dispatch reconciliation.
- `BridgeSessionMetadata{sessionId,providerSessionId?,workspaceRoot,model?,thinkingLevel?,messageCount,isStreaming,createdAt}`
  is the minimal identity Orca's structured lease needs. No paths beyond
  `workspaceRoot`, no env, no credentials (§6).

## 6. Secret hygiene

Forbidden on the wire in **both** directions (`FORBIDDEN_BRIDGE_KEYS`):
`env`, `processEnv`, `auth`, `credentials`, `apiKey`, `token`,
`refreshToken`, `bearer`, `secret(s)`, `password` (case/underscore
insensitive, substring-suffix match). `validateBridgeMessage()` returns
`credential-field`; both sides drop/send `error{BAD_MESSAGE}` instead of
processing. Stderr is bounded (`MAX_STDERR_BYTES`) and
`redactSecretsFromText()`-scrubbed; errors never include prompt text —
only opIds, kinds, and codes.

## 7. Failure semantics (fail closed)

| Situation | Host behavior | Orca UX |
|---|---|---|
| Missing binary / spawn error | `probeSupport() → {available:false}` | Ordinary Pi TUI, untouched |
| Hello timeout / `hello_error` / version mismatch | `available:false`, `reason` kept | Pi TUI + one-line notice |
| `dispatch` while unavailable/disposed | `{status:rejected, reason: bridge-unavailable…}` | Fall back to TUI send |
| Provider `dispatch_ack{rejected}` | `{status:rejected}` | Surface `reason`, keep TUI available |
| Dispatch timeout / exit / malformed ack | `{status:unknown}` | "Check history before retrying — never auto-resend" |
| Malformed provider line | Ignored; waiter deadline → `unknown` | No crash, no journal corruption |
| `cancel`/`history`/`options` transport failure | Throw `BridgeUnavailableError` (not silent) | Toast + TUI fallback |

`queue: reject` (default) makes busy-provider dispatches reject honestly;
`steer`/`followUp` map to Pi `streamingBehavior` in `pi-mapping.ts`.

## 8. Lifecycle / teardown

- `close{graceful}`: host sends `close`, waits ≤3s for `closed`, EOFs
  stdin, waits `closeGraceMs` (default 2s), then SIGTERM.
- `close{force}` / `dispose()`: SIGKILL path, reader detach, timer clear,
  listener clear. `dispose()` is idempotent and joins Orca teardown —
  no leaked helper processes or `data`/`exit` listeners.
- Provider exits 0 on stdin EOF; `exiting{code,signal,reason}` precedes
  abnormal exits. Restart = new OS process + fresh `hello` + `acquire`;
  sessions do not survive restarts (mock proves this; Pi resume is SNC1.7).

## 9. Mock test hooks (deterministic, documented)

The mock provider (`MockExternalProvider`, `mock-provider-cli.js`) honors:

- Any text → `accepted` + `turn_start` → chunked `text_delta`
  (`mock response for: <text>`) → `text_end` → `turn_end{stop}` → `settled`.
- `__prompt_select__` → `prompt_request{select}` then pauses until
  `answer_prompt` resumes the turn (tests options/dialogs).
- `cancel` mid-stream → `turn_end{aborted}` → `settled`.
- Busy session + `queue:reject` (default) → `dispatch_ack{rejected}`.
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

# Orca Integration (SNC1.3 dev branch)

> Status: the Orca-side seam is implemented **and hooked into the runtime**
> on the writable fork `44madfire/orca` branch
> `snc1.3-external-structured-bridge` (commit `ad8784810e`, based on upstream
> `main@f2d5711b`; interim upstream drift verified additive-only).
> Fork review unit: https://github.com/44madfire/orca/pull/1 (draft,
> fork-internal; upstream PR to `stablyai/orca` follows in SNC1.8 after
> Pi-backed proof). This package remains the bridge protocol/host/provider
> testbed prerequisite for #13; host-callback assertions in
> `test/host.test.ts` stay a "Native Chat stand-in" — the adapter-level
> proof lives fork-side (18 tests incl. live-process mock E2E + router
> routing), and the **manual UI gate** below is what actually puts pixels
> on screen.

How the Orca fork wires the generic seam without widening the
public plugin surface. The canonical fork/branch is recorded above; until
an upstream PR lands, this package carries the full seam + mock so
`orca-pi` development stays unblocked.

## 1. What was vendored (canonical fork state)

Vendored verbatim into the fork dev branch under
`src/main/native-chat/agent-session-wire/external/` (temporary, small
enough to carry even if upstream declines the seam):

```text
packages/structured-bridge/src/framing.ts   → orca/.../external/bridge-framing.ts
packages/structured-bridge/src/protocol.ts  → orca/.../external/bridge-protocol.ts
packages/structured-bridge/src/host.ts      → orca/.../external/bridge-host.ts (+ providerPid getter)
```

Plus fork-side (provider-neutral, no Pi imports):

```text
orca/.../external/external-structured-bridge-config.ts  # dev-only flag + ORCA_PI_BRIDGE_COMMAND
orca/.../external/external-structured-session-adapter.ts # StructuredAgentSessionAdapter impl
orca/.../external/external-structured-session-adapter.test.ts # 18 tests incl. live-process E2E
orca/.../external/README.md # fork-side dev setup + failure semantics
```

`provider.ts` + `mock-provider-cli.js` + `pi-mapping.ts` stay in
`orca-pi` (provider side). Orca core must never import Pi assumptions.

Wrap the host in a thin `ExternalStructuredSessionAdapter` that implements
Orca's current `StructuredAgentSessionAdapter` contract by delegating to
`BridgeHost` and translating `session_event` records into Orca journal
appends + Native Chat renders. Keep the existing native adapter untouched;
select via explicit dev config (§2).

## 2. Development-only configuration (no manifest widening)

Do **not** add arbitrary process execution to the public plugin manifest.
Use an explicit dev-only path:

```sh
# Dev shell only — never shipped, never in the manifest:
export ORCA_PI_BRIDGE_COMMAND="node /path/to/orca-pi/packages/structured-bridge/dist/mock-provider-cli.js"
# Pi-backed provider (SNC1.4):
export ORCA_PI_BRIDGE_COMMAND="node /path/to/orca-pi/packages/structured-bridge/dist/pi-provider-cli.js"
```

Orca reads this only when `--enable-external-structured-bridge` (dev flag)
is present, plus `--bridge-command <path>` override. Missing/incompatible
bridge → `probeSupport(){available:false}` → ordinary Pi TUI path,
untouched. Packaged Orca never requires the bridge.

## 3. Wiring (as implemented fork-side)

```ts
import { ExternalStructuredSessionAdapter } from './external/external-structured-session-adapter.js'

const adapter = new ExternalStructuredSessionAdapter({
  resolveWorkspacePath: (workspaceId) => resolveWorkspace(workspaceId),
  readProcessStartTime,
})
// Dev gate first — ordinary Pi TUI path stays untouched when unsupported:
if (!adapter.supportsCreate(location, 'external')) return openPiTuiTerminal()

const acquired = await adapter.acquire({ identity, fence, spawnToken, events: sink })
// adapter routes session_event → sink appends carrying Native Chat blocks:
// text_delta → assistant streaming bubble, thinking_* → reasoning channel,
// tool_* → tool-call card, prompt_request → approval/question dialog,
// settled → activity cleared, input re-enabled.

// Outbox send flow:
const outcome = await adapter.dispatch({ sessionId, clientMessageId, body, fence })
if (outcome.state === 'accepted') leaseToProvider(sessionId, outcome.providerIdentity)
else if (outcome.state === 'rejected') toastAndOfferTui(outcome.reason)
else /* unknown */ reconcileViaHistoryThenConfirmBeforeRetry(sessionId)

// Esc cancels the active turn:
await adapter.cancelTurn({ sessionId, turnId: activeOpId, fence })

// Teardown joins Orca teardown (release + bounded dispose, no resident helper):
disposables.push(() => adapter.disposeSession(sessionId))
```

The pre-adapter `BridgeHost` sketch from earlier revisions is superseded by
the adapter above; raw-host usage remains valid for transport debugging only.

## 4. Manual E2E (mock, no Pi)

```sh
# Terminal 1 — build + run the mock provider standalone:
npm run build
node packages/structured-bridge/dist/mock-provider-cli.js
# (type JSONL hello/acquire/dispatch lines; observe hello_ok/acquired/
#  dispatch_ack/session_event records — all LF-only)

# Terminal 2 — host + mock over a real OS process (vitest does this too):
npm test -- packages/structured-bridge/test/host.test.ts
```

Expected: mock creates a real bridge session, streams
`mock response for: …` through `session_event` into the host callback
(the stand-in for Orca's Native Chat journal/UI), `settled` re-enables
input, restart (dispose + new host) starts empty, and killing the mock
makes the host report `available:false` / `dispatch{rejected}` so the Pi
TUI path remains.

Fork-side Native Chat proof (real adapter, not a stand-in) runs headlessly
without Pi or Electron:

```sh
# In a checkout of 44madfire/orca @ snc1.3-external-structured-bridge:
vitest run src/main/native-chat/agent-session-wire/external
# 18 tests: config gating, fail-closed acquire, accepted mock turn streamed
# into journal-sink Native Chat blocks, unknown preservation, prompt
# request/answer-once, option validation, teardown, plus a live-OS-process
# BridgeHost + inline mock E2E (acquire → dispatch → streamed fake response
# → settled, then restart-independence).
```

## 5. Fork landing record (SNC1.3)

- [x] Vendored `framing.ts` + `protocol.ts` + `host.ts` (+ `providerPid`
  getter) into `44madfire/orca@snc1.3-external-structured-bridge` under
  `src/main/native-chat/agent-session-wire/external/` with the thin
  `ExternalStructuredSessionAdapter` against the current
  `StructuredAgentSessionAdapter` contract (delegates to `BridgeHost`,
  translates `session_event` → journal appends + Native Chat renders, Orca
  keeps journal/lease/fencing/outbox/rendering/sync ownership).
- [x] Explicit dev-only flag (`--enable-external-structured-bridge`) +
  `ORCA_PI_BRIDGE_COMMAND` path (no plugin-manifest widening), fail-closed
  fallback to the Pi TUI path.
- [x] Runtime hookup (`ad8784810e`, rebased onto upstream `main@f2d5711b`):
  first-class `external` provider handle (+ `EXTERNAL_BRIDGE_DIR` pin,
  opaque journal mapping), optional router member, RPC attach schemas
  accept external, runtime installs the adapter only when dev-configured
  (production codex/claude pair untouched; teardown joined). Entry point:
  client-supplied-location `agentSession.ensure` with provider+agent
  `external`. Worktree-intent create, tab pickers, and TUI handoff stay
  out of scope (SNC1.4/SNC1.9).
- [x] Mock provider proves the adapter path headlessly (real `BridgeHost` +
  live OS process → real adapter session → streamed fake response into
  journal-sink Native Chat blocks → `settled`; restart starts empty;
  teardown leaves no resident helper). Manual gate (Gates 0–6) passed against
  the dev app with the mock provider: real session + streamed Native Chat
  reply, restart independence, fallback matrix, clean teardown, no upstream
  drift — fork `44madfire/orca@ad8784810e`, PR `44madfire/orca#1` (draft;
  upstream follows in SNC1.8).
- [ ] Open the upstream PR(s) to `stablyai/orca` (small provider-neutral
  seam) or carry the temporary dev branch.

Remaining temps before any upstream PR: empty model catalog, text-only
dispatch. Tracked in the fork `external/README.md`.

## 6. Upstream strategy

Keep the Orca PR minimal and provider-neutral: three vendored files +
the adapter wrapper + dev-flag config + teardown wiring + mock E2E test.
No Pi imports, no credential/env plumbing, no remote/mobile claims, no
manifest capability widening. Pi translation (`pi-mapping.ts`, Pi provider
process) stays in `orca-pi` and is referenced only as an example
provider — upstream reviews a small honest seam, not a Pi stack.

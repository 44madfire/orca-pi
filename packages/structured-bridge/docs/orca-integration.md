# Orca Integration (SNC1.3 dev branch)

How the future Orca fork wires the generic seam without widening the
public plugin surface. Until the fork exists, this package carries the
full seam + mock so `orca-pi` development is unblocked.

## 1. What to vendor

Copy three files into the Orca dev branch (temporary, small enough to
carry even if upstream declines the seam):

```text
packages/structured-bridge/src/framing.ts   → orca/.../bridge/framing.ts
packages/structured-bridge/src/protocol.ts  → orca/.../bridge/protocol.ts
packages/structured-bridge/src/host.ts      → orca/.../bridge/host.ts
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

## 3. Wiring sketch (Orca fork)

```ts
import { BridgeHost } from "./bridge/host.js";

const bridge = new BridgeHost({
  bridgeCommand: process.env.ORCA_PI_BRIDGE_COMMAND ?? "",
  bridgeArgs: [],
  workspaceRoot: orcaSelectedCwd, // exact Orca workspace/cwd (SNC1.4)
  env: { /* explicit overlay only; never dump process.env over the bridge */ },
});

const support = await bridge.probeSupport();
if (!support.available) {
  // Fail closed: keep the normal Pi TUI path. One-line notice, no crash.
  return openPiTuiTerminal();
}

const { sessionId } = await bridge.acquire({ options: { model, thinkingLevel } });
bridge.onSessionEvent(({ event }) => {
  // Append to Orca journal + render in Native Chat:
  // text_delta → streaming bubble, thinking_* → thinking channel,
  // tool_* → tool card, prompt_request → options dialog,
  // settled → re-enable input.
});
bridge.onLifecycle(({ kind, message }) => logger.warn(`bridge ${kind}: ${message}`));

// Outbox send flow (SNC1.4):
const outcome = await bridge.dispatch({ sessionId, text });
if (outcome.status === "accepted") leaseToProvider(sessionId, outcome.opId);
else if (outcome.status === "rejected") toastAndOfferTui(outcome.reason);
else /* unknown */ reconcileViaHistoryThenConfirmBeforeRetry(sessionId);

// Esc cancels the active turn (SNC1.4):
await bridge.cancel(sessionId, activeOpId);

// Teardown joins Orca teardown:
disposables.push(() => bridge.dispose());
```

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

## 5. Upstream strategy

Keep the Orca PR minimal and provider-neutral: three vendored files +
the adapter wrapper + dev-flag config + teardown wiring + mock E2E test.
No Pi imports, no credential/env plumbing, no remote/mobile claims, no
manifest capability widening. Pi translation (`pi-mapping.ts`, Pi provider
process) stays in `orca-pi` and is referenced only as an example
provider — upstream reviews a small honest seam, not a Pi stack.

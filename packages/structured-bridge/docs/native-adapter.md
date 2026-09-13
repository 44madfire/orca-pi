# Native Pi Structured Adapter — SNC1.8 Port (orca-pi owned core)

> Status: implemented in `packages/structured-bridge/src/pi-native.ts`
> (+ `pi-conformance.ts` shared suite + `test/pi-native-parity.test.ts`
> parity proof). Closes #18. Blocks SNC1.9 (#19).
>
> Strategy: treat the external bridge as a development harness, not the
> packaged runtime architecture. Reuse/transplant the proven Pi RPC, event
> translation, options, and history semantics with minimal behavioral change.

## 1. What was ported

The proven external provider (`pi-provider.ts`, SNC1.4 + SNC1.5 + SNC1.6 +
SNC1.7) owns ALL Pi semantics:

- production SNC1.2 `PiRpcConnection` transport (`pi --mode rpc` per session,
  `cwd` = Orca-selected `workspaceRoot`, transport-neutral spec via
  `resolvePiSpec` + `toPiRpcProcessSpec`, `--mode rpc` idempotent, no terminal
  keystroke injection);
- SNC1.5 `PiTranslator` (stable `contentIndex`/`toolCallId`, finals reconcile,
  tool stdout never prose, thinking never prose, abort fidelity, secret-safe
  errors, bounded unknown handling, settle clears transient);
- SNC1.6 model/thinking/prompt/image controls (exact qualified
  `provider/modelId` refs, `UNKNOWN_MODEL`/`AMBIGUOUS_MODEL`/
  `UNKNOWN_THINKING_LEVEL` fail closed, exactly-once `answer_prompt` with
  `UNKNOWN_REQUEST` stale refusal, image gating with actionable refusal,
  bytes never journaled);
- SNC1.7 history/current-branch/resume (`get_entries`/`leafId` + `get_tree`
  fallback, root→leaf only, convergent translation, wholesale replace without
  duplication, `leafId` always names the Pi leaf, fail-closed `PI_RESUME_*` /
  `PI_HISTORY_*` diagnostics, workspace-bound resume).

`src/pi-native.ts` (`PiNativeProvider`) drives the SAME `PiBridgeProvider`
class in-process via its test transport (`attachTestTransport` + `onLine`),
so every translator code path, error code, delivery verdict
(`accepted`/`rejected`/`unknown`), and history cursor/leaf invariant is
preserved verbatim. The only thing removed is the helper OS process
(`pi-provider-cli.js` stdio child): packaged Orca needs only the real
`pi --mode rpc` child per session — no second bridge process, no JSONL over
stdio, no `ORCA_PI_BRIDGE_COMMAND`.

The full catalog seam bridge v1 lacks lives here: `listModels()` /
`listThinkingLevels()` call the live Pi option RPCs through the captured
`PiProviderConnection`, so Orca's `AgentSessionOptionsResult.models` can
carry a complete catalog instead of the honest `models:[]` temp the external
adapter reports (see `orca-integration.md` §6).

## 2. Orca integration (upstreamable shape)

Route `pi` through the normal structured adapter router alongside
Codex/Claude (no Codex/Claude selection change — this adapter claims only
`agent === "pi"`):

```ts
// Orca-side sketch (fork `PiStructuredSessionAdapter` adapts this core):
import { PiNativeProvider } from '@orca-pi/structured-bridge'

const pi = new PiNativeProvider({ resolvePiSpec: buildPiLaunchSpec })
if (!pi.supportsCreate(location, 'pi')) return openPiTuiTerminal()

const { sessionId } = await pi.acquire({ workspaceRoot, resumePath, options })
const outcome = await pi.dispatch({ sessionId, text, images })
if (outcome.status === 'accepted') leaseToProvider(sessionId)
else if (outcome.status === 'rejected') toastAndOfferTui(outcome.reason)
else /* unknown */ reconcileViaHistoryThenConfirmBeforeRetry(sessionId)
```

- **Create-support / capability negotiation:** `supportsCreate(location, 'pi')`
  returns true only for proven execution locations (local host, no WSL
  distro). Add Pi create-support/capability negotiation only for those
  locations; all others fail closed to Pi TUI.
- **TUI fallback:** preserve ordinary Pi TUI fallback when structured support
  is disabled/incompatible (missing Pi binary, `PI_STARTUP_FAILED`,
  `PI_TUI_FLAG`, `PI_RESUME_*`, `PI_HISTORY_*`, version mismatch). Packaged
  Orca never requires the bridge.
- **Process wrappers / identity / fencing / journal sink / option
  persistence / structured-session records:** Orca remains authoritative (as
  with the external adapter): `PiStructuredSessionAdapter` delegates
  transport to this core and translates native `session_event`s into Orca
  journal appends + Native Chat renders. No second competing state machine.
- **Client capability negotiation:** do not expose structured Pi tabs to
  clients that cannot render/control them (same gate as Codex/Claude
  structured tabs).
- **No renderer fork:** text/thinking/tools/errors/prompts/options/images
  render through Orca's existing shared Native Chat UI (SNC1.6 proved
  no-fork mappings; SNC1.8 keeps them). Avoid Pi-specific renderer forks
  unless capability semantics genuinely require one.

Vendoring map for the upstream PR to `stablyai/orca`:

```text
orca-pi (stays here)                          → orca (native, in-process)
packages/pi-rpc/src/*                         → vendored Pi RPC transport
packages/structured-bridge/src/pi-mapping.ts        → transplanted translation
packages/structured-bridge/src/pi-translator.ts     → transplanted translator
packages/structured-bridge/src/pi-history.ts        → transplanted history
packages/structured-bridge/src/pi-native.ts         → adapted to PiStructuredSessionAdapter
packages/structured-bridge/src/pi-conformance.ts    → fork-side parity gate
packages/structured-bridge/src/framing.ts           → NOT vendored (bridge only)
packages/structured-bridge/src/protocol.ts          → NOT vendored (bridge only)
packages/structured-bridge/src/host.ts              → NOT vendored (bridge only)
packages/structured-bridge/src/pi-provider-cli.js   → NOT shipped (dev harness only)
```

## 3. Parity requirement (same suite, both paths)

`src/pi-conformance.ts` + `test/pi-native-parity.test.ts` run the SAME suite
against bridge (`PiBridgeProvider` via JSONL) and native (`PiNativeProvider`
direct calls) for:

- basic dispatch/streaming;
- thinking/tools/errors/lifecycle;
- options/prompts/images;
- history/current-branch restore;
- cancel/close/error classification;
- native create-support gating (pi-only, local-only; Codex/Claude untouched).

Current result: full suite green on both paths with identical verdicts
(`npx vitest run packages/structured-bridge/test/` — 10 files passed;
full repo `npx vitest run` — 1046 passed, 1 skipped). The fork-side
`PiStructuredSessionAdapter` must pass the same suite before the upstream PR
lands (SNC1.10 carries broader E2E/compat hardening).

## 4. Acceptance criteria (per #18)

- [x] Packaged path needs no `orca-pi` bridge/helper process (`PiNativeProvider`
  spawns only `pi --mode rpc`; `pi-provider-cli.js` stays a dev harness).
- [x] Native adapter passes the provider conformance suite proven through the
  bridge (identical verdicts, see §3).
- [x] Unsupported execution locations/versions fail closed to Pi TUI
  (`supportsCreate` local-only + actionable `PI_*` errors; Codex/Claude
  selection unchanged).
- [x] Implementation is organized as an upstreamable Orca contribution
  (vendoring map above; no Pi imports in Orca core beyond the transplanted
  pure modules; no manifest widening; no credential/env plumbing).

## 5. Dependencies

Blocks SNC1.9 (#19): lifecycle hardening and Pi TUI ↔ Chat handoff build on
this native lease (single mutating owner, proven exit, exact session/leaf
resume, ambiguous-teardown fail-closed). SNC1.10 owns final E2E/compat/
upstream hardening.

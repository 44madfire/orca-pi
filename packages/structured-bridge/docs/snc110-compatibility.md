# SNC1.10 Compatibility, E2E Coverage, and Upstream Hardening

Owner: `44madfire/orca-pi` (this repository). Orca-side work from issue #19
landed separately in `44madfire/orca` and is out of scope here.

> Scope boundary (stated plainly): this change delivers the **provider-owned
> slice** of #20 — the gate logic, both provider-side enforcement points
> (pre-spawn advertisement check with `requireCompat` evidence mode, plus
> post-start live RPC verification), the vendored caller contract
> (`BridgeHost.acquire({compat})`), deterministic coverage, and the opt-in
> smoke. It does **not** land the Orca-side production wiring
> (`requireCompat: true`, the bounded `pi --version` probe, evidence on
> every production acquire), which lives in the Orca repository and is
> tracked as follow-up work — so this PR is `Related to #20`, not
> `Closes #20`. Merging it leaves the production default (`requireCompat:
> false`) unchanged until that companion lands.

## 1. What SNC1.10 adds in this repo

| Piece | Location | Notes |
|---|---|---|
| Compatibility + capability gates | `src/pi-compat.ts` | Pure, process-free: Pi version floor (SemVer prerelease-aware), honest execution-location matrix, capability probing over version checks, combined `gatePiStructuredSession()` entry point, and the pre-spawn `checkAcquireCompat()` verdict consumed by both acquisition paths. No shell strings, no process execution, no credentials. Only `import type` from `protocol.ts`, so the module stays runtime-import-free and safe to vendor. |
| Gate unit tests | `test/pi-compat.test.ts` | Deterministic, offline. |
| Full-lifecycle E2E (bridge + native) | `test/pi-snc110-e2e.test.ts` | Scripted fake Pi, no binary, no credentials. Covers the §2 checklist on both paths. |
| Opt-in real-Pi smoke | `test/pi-live-smoke.test.ts` | `ORCA_PI_LIVE_SMOKE=1` only; skipped otherwise. Env failures skip with `LIVE-SMOKE-ENV`, never fail. |
| This document | `docs/snc110-compatibility.md` | Honest platform/version boundary. |

The Orca fork vendors `framing.ts` + `protocol.ts` + `host.ts` only
(provider-neutral). `pi-compat.ts` is additionally safe to vendor: it
imports nothing and owns no transport.

## 2. Runtime wiring (the gate is enforced, not advisory)

`PiBridgeProvider` (`acquire{compat}` wire field) and `PiNativeProvider`
(`acquire({compat})` input) run `checkAcquireCompat()` **before** spec
resolution, the hello handshake, and any Pi child creation. A refused gate
fails with `PI_COMPAT_LOCATION` / `PI_COMPAT_VERSION` /
`PI_COMPAT_CAPABILITY` naming the Pi TUI fallback, and no Pi connection is
constructed (asserted: the connection factory is never called). Absent
`compat` dimensions are skipped, preserving existing behavior for callers
that gate elsewhere — **unless** the deployer sets `requireCompat: true`
(a `PiBridgeProvider`/`PiNativeProvider` construction option), in which
case an acquire without usable `compat.piVersion` evidence is refused
pre-spawn with `PI_COMPAT_EVIDENCE_MISSING`. The vendored `BridgeHost`
forwards `acquire({compat})` to the wire verbatim, so the production
caller contract lives in this repo.

Orca production wiring (one-time, Orca repo — REQUIRED for the merged
production path; tracked as follow-up, not landed by this PR):

```ts
// Backend init: probe once, bounded, out of band (argv array, no shell).
const piVersion = await probePiVersionBounded("pi"); // `pi --version`, 5s
const pi = new PiNativeProvider({ createConnection, requireCompat: true });
// Per acquire: version PLUS the capability set production relies on ride
// the call — a version alone fails closed production mode (round-4 P1).
// Refusal throws PI_COMPAT_* (TUI fallback).
const requiredCapabilities = ["textStreaming", "options", "history", "cancel", "resume"];
await pi.acquire({ workspaceRoot, resumePath, compat: { piVersion, requiredCapabilities } });
// Bridge path equivalent:
// host.acquire({ resumePath, compat: { piVersion, requiredCapabilities } }).
```

`supportsCreate` stays the location first-line; this gate is pre-spawn
defense in depth that cannot be skipped once `requireCompat` is set.
Companion Orca work must also flip `requireCompat: true` — until it lands,
production defaults (`requireCompat: false`) are unchanged by this PR.

## 3. Deterministic E2E checklist (no credentials, no binary)

`test/pi-snc110-e2e.test.ts` runs every row on **both** paths:

- acquire/create gating (local `pi` only; remote/WSL/other agents refuse);
- provider-confirmed text, thinking, and tool events in one turn
  (thinking never prose, tool stdout never prose);
- cancel (idle `settled:true`; active turn aborts via Pi `abort`);
- model + thinking changes (provider-confirmed) and fail-closed refs
  (`UNKNOWN_MODEL` / `AMBIGUOUS_MODEL` / `UNKNOWN_THINKING_LEVEL`);
- interactive prompt exactly once (retry → `UNKNOWN_REQUEST`, Pi hit once);
- unknown delivery without resend (one Pi `prompt` call; reconcile via history);
- image support (accepted, bytes never journaled) + refusal on text-only models;
- history current leaf + branched resume (abandoned siblings excluded,
  `leafId` names the leaf);
- unexpected exit + recovery (rejected dispatch naming reacquire, fresh
  session works, bounded teardown);
- structured → TUI → structured round trip (release proves Pi exit;
  reacquire shows the full chain with no duplication);
- restart restoration (new provider instance + same resume file);
- unsupported-version TUI fallback (compat gate);
- no cross-session leakage (histories/prompts fenced; stale ids refuse);
- bounded/redacted stderr, secret-safe errors, no credential fields on the
  wire, argv-only transport (never a shell string).

## 4. Support matrix (honest)

| Dimension | Proven (fixture/test evidence) | Expected, unproven | Unsupported (fail closed to Pi TUI) |
|---|---|---|---|
| Pi version | `0.85.1` (`fixtures/baseline.json`) | Newer versions (version floor passes; **capability probing** decides per-feature support) | Older than `0.85.1`, unparseable versions |
| Execution location | Local host, no WSL (`supportsCreate` + `gatePiStructuredSession`) | — | Remote/SSH/mobile/paired hosts, any WSL distro |
| OS platform | `win32` local (all fixtures captured on win32) | darwin/linux local (same stdio transport, no platform-specific code — **no passing run recorded in this repo yet**) | Any platform claim beyond the above without a recorded run |
| Transport | `pi --mode rpc` stdio, LF-only JSONL, argv arrays | — | Shell-string transport, terminal keystroke injection |
| Live Pi + credentials | — (never in deterministic CI) | Opt-in smoke (`ORCA_PI_LIVE_SMOKE=1`, local host only) | Remote/SSH/mobile/paired live runs |

Capability rule: prefer probing (`get_available_models`,
`get_available_thinking_levels`, `get_entries`/`leafId`, advertised
bridge capabilities) over version-string checks. The version gate is a
coarse floor only. Enforcement is two-layer: (1) pre-spawn, required
capabilities are checked against the static advertisement (cheap refusal
before any Pi child exists); (2) post-start, capabilities with a dedicated
live RPC probe (`options`/`images` via the catalogs, `history`/`resume`
via entries/tree) are re-verified against the RUNNING Pi before the
session is exposed — refusal closes the just-started child (no leak).
Flags without a pre-turn probe (`textStreaming`, `thinking`, `tools`,
`cancel`, `extensionDialogs`) stay advertisement-checked pre-spawn and
runtime-enforced per-turn. See `splitProbedCapabilities()`.

## 5. Security / reliability evidence

- Stderr is a bounded, redacted tail (`MAX_STDERR_BYTES`, secret + path
  patterns) — see the redaction tests in `pi-snc110-e2e.test.ts` and
  `packages/pi-rpc/src/errors.ts`.
- Errors carry codes + command names + request ids only — never prompt
  text, image bytes, credentials, or raw session paths.
- Fixtures are normalized (aliases, `<IMAGE_DATA>`, `<SESSION_FILE>`) and
  `fixtures.test.ts` fails closed on token-like patterns.
- Bridge wire rejects credential fields in both directions
  (`FORBIDDEN_BRIDGE_KEYS` / `validateBridgeMessage`).
- `unknown` delivery is never auto-resent (single Pi `prompt` call
  asserted); recovery is explicit history reconciliation.
- Public APIs construct argv arrays only; TUI-only flags reject
  fail-closed; no arbitrary process execution was added.
- Teardown is bounded (EOF → SIGTERM → SIGKILL with synthetic
  finalization); release proves Pi exit; prompts/turns retire on
  settle/cancel/exit/release fences.

## 6. Known boundaries / unproven (do not claim)

- No live-Pi run is recorded in deterministic CI (by design — no
  credentials). Run `ORCA_PI_LIVE_SMOKE=1 npm test -- pi-live-smoke` on a
  win32 local host and report the `platform=`/`piVersion=` line.
- darwin/linux local structured Pi: expected-compatible, zero recorded
  runs here. WSL, remote/SSH, mobile, paired: unsupported, no evidence,
  fail closed.
- Compaction success shape, retry event loop, `cycle_model` live cycle,
  and `export_html` bytes follow the upstream `rpc.md` docs without
  live-captured fixtures (see `pi-rpc-contract.md` §5) — treated as
  supported-per-docs, not proven.
- The structured → TUI → structured round trip in `pi-snc110-e2e.test.ts`
  proves the provider seam (release/exit + resume/reconcile with no
  duplication). Launching the real Pi TUI and Orca-side handoff ownership
  are Orca-fork concerns (issue #19), not asserted here.

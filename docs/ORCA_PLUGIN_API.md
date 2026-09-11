# Orca plugin API target (UI1.2 bridge + current Host API)

## Upstream audit (2026-09-11)

Re-audited against `stablyai/orca` `main` at
**`9aa0f7e77d366c23a3cc8de2da32ae550d397dc0`**
(“Update README downloads badge”, 2026-09-11T12:36:35Z).

Host API v0 (`src/shared/plugins/plugin-host-api.ts`) is **unchanged** from
the issue-creation snapshot: an experimental, separately-versioned public
facade where every method carries params + result schemas plus
capability/mutation metadata. Handlers (bound in main) delegate to runtime
services; the raw runtime-RPC registry is never exposed.

### Panel-callable (sandboxed iframe → host, `panel: true`)

| Method | Capability | Scope | Mutation |
| --- | --- | --- | --- |
| `workspace.readContext` | `workspace:read` | `active-worktree` | no |
| `terminal.sendText` | `terminal:send` | `explicit-terminal` | yes (audit-logged `plugin:<id>`) |
| `notifications.show` | `notifications:show` | `desktop` | yes |

- `workspace.readContext` takes no params; returns `{branch, displayName,
  terminals: [{id}]}` or `null`. Terminals of the **focused** worktree only,
  so callers can address a specific terminal id — the API has **no “active
  terminal” write target**.
- `terminal.sendText` requires `{terminalId, text (1–4096), enter}`.
  **Explicit target only**: a focus change must never redirect a delayed
  plugin write into another pane (design-doc rule).
- `notifications.show` takes `{title (1–120), body (≤1000)}`.

### Worker-callable only (`panel: false`; workers can call every method)

| Method | Capability |
| --- | --- |
| `storage.get/set/delete/keys` | `storage` |
| `secrets.get/set/delete` | `secrets` |
| `settings.get/set` | `settings:own` |
| `events.subscribe` | `events:subscribe` |

Storage caps keep per-plugin storage an honest key-value store, not a
database (`256 KiB`/value, `5 MiB` total, 1024 keys; reserved keys
`__proto__`/`prototype`/`constructor` rejected). Secrets values are capped
at `64 KiB`. Settings are the plugin’s **own** settings only.

### What is still missing

The capability set is still the closed v0 set
(`src/shared/plugins/plugin-capabilities.ts`):

```text
workspace:read, terminal:send, notifications:show,
storage, secrets, events:subscribe, settings:own
```

There is **no general/scoped `process:exec` or filesystem API**; upstream
comments say scoped kinds (`net:fetch` hosts, `process:exec` globs) arrive
in later phases. The manifest shape is already forward-compatible (strict
`{kind}` objects so scoped fields can be added per-kind later).

### Panel bridge transport (`plugin-panel-bridge.ts`)

- Sandboxed iframe (`sandbox="allow-scripts"`, opaque origin) ↔ host
  renderer via `postMessage`. Neither side trusts origins; the host verifies
  the sending window’s identity and re-validates every payload; main
  re-checks capabilities before executing.
- Request: `{type: "orca-panel-action", requestId (1–128), action
  (panel-callable only), params?}`. Param/result schemas come from the Host
  API v0 spec table — the panel bridge is a transport, not a second
  contract.
- Result: `{type: "orca-panel-action-result", requestId, ok, value?,
  errorCode?, error?}` with `errorCode` in `invalid_request`,
  `unknown_method`, `capability_denied`, `consent_required`,
  `panel_forbidden`, `invalid_params`, `rate_limited`, `unavailable`,
  `action_failed`.
- Budgets: `64 KiB`/message, 30 messages/`10s` per plugin; liveness
  ping/pong on a reserved lane (`10s` interval, `5s` timeout → errored
  badge). Busy-loop detection is valid only while the runtime frame-process
  gate confirms the sandbox stays outside the host renderer.
- Panel CSP (`plugin-panel-shell.ts`): `default-src 'none'; connect-src
  'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src
  data:; font-src data:; base-uri 'none'; form-action 'none'`. Panels are
  documents, never browsing contexts (`window.open` neutered, link/form
  navigation prevented). Design tokens are a curated allowlist
  (`--background`, `--foreground`, `--card`, …); growing it is additive,
  renaming/dropping is breaking.

### Worker transport (`plugin-host-protocol.ts`)

Out-of-process `child_process.fork` channel, Zod-validated on both sides
(the child runs third-party code — nothing it sends is trusted
structurally): `init {pluginId, pluginRoot, mainEntry,
grantedCapabilities}` → `ready {commands}`, `invokeCommand
{callId, commandId, args?}` ↔ `commandResult`, `deliverEvent
{eventId, event, payload}` ↔ `eventAck`, worker→host `hostCall
{callId, method, params?}` ↔ `hostResult`, plus `log`/`fatal`.
Timeouts: ready `10s`, invoke `30s`, idle reap `5min`, max 5 active
workers (excess queues).

Upstream sources (`src/shared/plugins/`): `plugin-host-api.ts`,
`plugin-capabilities.ts`, `plugin-panel-bridge.ts`,
`plugin-panel-shell.ts`, `plugin-host-protocol.ts`, `plugin-manifest.ts`,
`plugin-manifest-fields.ts`,
`plugin-manifest-contribution-validation.ts`, `plugin-command-actions.ts`,
`plugin-content-pack-contributions.ts`.

## Transport strategy (why sidecar now, seam next, degraded fallback always)

1. **Native structured worker/host path** — not sufficient in current Orca.
   The worker can call only `storage`/`secrets`/`settings`/`events`; it
   cannot read the authoritative profile YAML or run the Orca-Pi services
   without a second copy in `settings`/`storage` (explicitly forbidden) or
   unrestricted `child_process` (never on the table). The audited Host API
   v0 also offers no panel↔bridge seam of its own (no
   `plugin-service.invoke`, no scoped `process:exec`/filesystem API), and
   the worker `orca` API exposes no `appVersion`/`pluginApi` — so versions
   and consent must never be assumed. Option 1 cannot serve live
   profile/config data today.
2. **CLI sidecar (implemented, current transport).** `orca-pi bridge
   --request '<json|@file>'` executes one versioned `BridgeRequest` per
   call through `bridge-host.ts` and prints a versioned `BridgeResponse`
   (see `packages/cli/src/commands/bridge.ts`). Two authority modes
   (explicit `--transport`):
   - `operator` (default): a human invoking the CLI directly. The local
     shell already authorizes the call, so the seam consent gate does not
     apply — but root pinning to `--project-root` still does. Never use
     this mode to forward untrusted panel requests.
   - `seam`: the seam adapter forwarding a panel request. Host facts
     (`--host-app-version` / `--host-plugin-api` /
     `--granted-capability`) plus the invocation-as-handshake gate every
     structured operation exactly like the panel path; unknown facts
     degrade fail-closed. `bridge.capabilities` reports
     `permittedOperations` — what the chosen transport will actually
     permit — alongside the panel-oriented `structured` signal (the two
     always agree on `"seam"`).
   Panels reach the bridge where the seam harness injects
   `window.__ORCA_PI_BRIDGE__.request` (contract below); the worker entry
   (`worker-entry.mjs`) stays degraded until the harness signals
   `ORCA_PI_BRIDGE_SEAM=1` / `seamAvailable`.
3. **Narrow Orca core seam / scoped execution capability** — the
   upstreamable future. Orca-Pi already expects an Orca fork for structured
   Native Chat; a small generic seam is acceptable **iff** it is designed
   for upstreaming and contains **no Pi-specific policy**. Proposed seam
   (generic, host-owned): `plugin-service.invoke {service:
   "orca-pi.bridge", request: <versioned BridgeRequest>}` behind a new
   capability (e.g. `service:invoke` with an allowlisted service id),
   validated with the same Zod-on-both-sides discipline as
   `plugin-host-protocol.ts`, audit-logged as `plugin:<id>`. Crucially the
   seam must **inject the absolute project root / worktree id host-side**:
   `workspace.readContext` returns only `{branch, displayName,
   terminals: [{id}]}` — no filesystem path — so panels cannot supply
   `projectRoot` from readContext, and panel-supplied roots must be
   treated as untrusted until the host provisions them. Orca core would own
   only the generic invoke + capability gate + root injection; all Pi
   policy lives in `packages/orca-plugin/src/bridge*.ts` + `@orca-pi/core`.
   This repo implements the service side now (`bridge-host.ts` dispatcher
   + `worker.ts` core + `worker-entry.mjs` activation) so it binds behind
   the seam without a panel rewrite.
4. **`terminal.sendText` degraded fallback** — clearly-labeled, explicit
   user actions only, implemented for real in both panels (a fallback
   button, tested end-to-end in `panel-actions.test.ts`). Allowed text is
   allowlisted to read-only `orca-pi doctor | profiles list | profile
   show/inspect/validate/path/read`; mutations are never offered this
   way. The button handler calls `workspace.readContext` for an explicit
   `terminalId` (never “active”), shows the target, then sends once —
   never on load, never parsed back into the UI. It is not the primary
   architecture.

**Not solved** by storing a second copy of profiles in plugin
`settings`/`storage` (divergence risk — forbidden and tested). Stock Orca
without the seam harness stays explicitly degraded/read-only; no
"structured available" claim is made there (negotiation is seam-gated
and fail-closed — see below).

## Seam adapter + fork-side injection contract

The harness-side adapter lives in this repo
(`packages/orca-plugin/src/seam-adapter.ts`, `createSeamAdapter`); the
`window.__ORCA_PI_BRIDGE__` injection lives in the Orca fork's panel host
(this repo cannot modify Orca's panel loader — the contract below is what
the fork implements).

Adapter responsibilities (all tested):

- Bind one adapter per harness-authorized worktree (absolute root).
- Validate each panel request, but **stamp the host-owned `worktree`
  scope before full `BridgeRequest` validation**: panels cannot know
  filesystem paths, so a correct panel mutation omits `worktree`
  entirely — and validation requires an absolute root for writes.
  Validating the unstamped input first would reject exactly the requests
  the adapter exists to complete. Panel-supplied scope never survives
  stamping (overwritten wholesale, not merged).
- Resolve host facts **fresh on every forwarded request**: versions may
  be static or provided, but consent grants MUST come from a per-request
  provider function (`grantedCapabilities: () => [...]`) — creation
  rejects any static-grants configuration outright, so no supported
  adapter setup can forward a revoked grant. This matches the audited
  Orca bridge, which re-checks capabilities in main for every action.
- Forward facts and invoke `orca-pi bridge --transport seam
  --request … --project-root <root> --host-app-version …
  --host-plugin-api … --granted-capability … --json`, so missing consent
  blocks reads and mutations at the dispatcher (`auth/setup`).
- Verify the sidecar response with a real versioned-envelope validator
  (`validateBridgeResponse`: object shape, `protocolVersion`,
  `requestId` echo, `ok` discriminant, success/error fields against the
  closed code set) — never a cast. Version skew degrades to
  `unsupported`; any other malformation becomes `internal`. Transport
  failures degrade to `internal` without trusting output.

Fork-side injection contract (`window.__ORCA_PI_BRIDGE__`):

- Shape: `{ request(req: BridgeRequest): Promise<BridgeResponse> }`.
- Installed only inside approved plugin panels (never ambient pages),
  before panel scripts run, bound to the panel's worktree session.
- `request` forwards through the adapter above (never directly to the
  dispatcher, never with panel-chosen roots or grants).
- Panels confirm `bridge.capabilities` reports `structured: true` (and the
  op in `supportedOperations`) before any data call; otherwise they stay
  on the explicit CLI fallback. The dispatcher re-checks everything
  regardless — the panel check is UX, the host gate is security.

## Bridge contract (owned by Orca-Pi)

- Code: `packages/orca-plugin/src/bridge.ts` (pure protocol),
  `bridge-host.ts` (Node dispatcher over `@orca-pi/core`),
  `worker.ts` (bridge core) + `worker-entry.mjs` (Orca entry,
  default-exported `activate(orca)`), `packages/cli/src/commands/bridge.ts`
  (sidecar transport).
- Versioned: `bridgeVersion 1.0.0`, `protocolVersion 1`. Requests carry
  `{protocolVersion, requestId ([A-Za-z0-9._-]{1,128}, echoed), operation
  (allowlisted, see below), worktree? {projectRoot, worktreeId?,
  terminalId?}, params?}`. Responses echo `{protocolVersion, requestId}`
  with `{ok: true, result}` or `{ok: false, error: {code, message, field?,
  retryable?, detail?}}`.
- Operations (12): `bridge.capabilities`, `worktree.context`,
  `profiles.list`, `profile.read`, `profile.validate`, `profile.mutate`
  (`create/clone/patch/set/unset/delete` via UI1.1 core service),
  `launch.preview` (JEF-7 compiler, sanitized/redacted, display-only),
  `orchestration.get/set` (typed role→profile mapping, atomic + conflict-safe),
  `github.status` / `github.doctor` (redacted only — no token/private key
  ever returned), `diagnostics.doctor` (orca/pi versions + bridge support).
- Errors: `validation` (incl. allowlist rejects for `exec`/`shell`/arbitrary
  ops and `untrusted-scope` rejections when a request root leaves the
  transport-authorized root), `conflict` (stale source hash → reload+retry),
  `unsupported` (wrong protocol/host or unreachable transport),
  `auth/setup` (missing consent/setup with actionable next steps),
  `internal`, plus narrow `not-found` / `already-exists`.
- Worktree/project scoping is explicit and race-safe: mutating ops require
  an **absolute** `worktree.projectRoot` captured at submission (relative
  roots are rejected — they would resolve against the worker's cwd, not a
  verified worktree); the host derives `<projectRoot>/.pi/...` for project
  scope (arbitrary `userPath` / `projectPath` overrides from the panel are
  rejected). When the transport authorized one root (sidecar
  `--project-root`, seam-injected worktree root), request roots must
  normalize-equal it — `untrusted-scope` mismatches are rejected before
  any read or write, in every scope. Delayed requests can never be
  redirected by focus changes. `workspace.readContext` is good for
  terminal identity (explicit `terminalId`) but carries no filesystem
  paths — absolute roots arrive via the seam/sidecar injection.
- Enforcement lives at the host boundary, not in the UI: on the seam
  transport, anything beyond `bridge.capabilities` / `worktree.context` /
  `diagnostics.doctor` requires negotiated `structured` support
  (versions + `workspace:read` consent + handshake) — otherwise reads and
  mutations are rejected (`auth/setup` for consent, `unsupported` for
  reachability). The sidecar transport (local operator invocation) skips
  the consent gate — the operator's shell is the authority — but keeps
  root pinning. Orchestration writes hold the shared cross-process bakery
  lock from load to replace, so concurrent sidecar processes serialize
  and losers conflict instead of losing updates.
- `window.__ORCA_PI_PROFILES__` injection is **deprecated** (legacy
  read-only fallback only, labeled as such) — production panels use
  `window.__ORCA_PI_BRIDGE__.request` (future seam) with explicit degraded
  CLI fallback otherwise. Panels never scrape terminal output or YAML.

## Manifest / consent

- File `packages/orca-plugin/orca-plugin.json` (`main:
  "worker-entry.mjs"`, the ESM Orca entry default-exporting
  `activate(orca)`): declares **only** the capabilities the shipped
  panels genuinely call — `workspace:read` (fallback terminal target via
  `workspace.readContext`) and `terminal:send` (ONE explicit
  user-gesture `terminal.sendText` of an allowlisted read-only command;
  verified end-to-end by `panel-actions.test.ts` against the shipped
  scripts). No `storage` / `secrets` / `settings:own` / `events:subscribe`
  / `notifications:show` — nothing unused is declared, so consent stays
  minimal and honest.
- No unrestricted process/network/filesystem permissions. Worker
  filesystem access is scoped to the explicit `projectRoot` via core
  services (no shell strings, no `child_process`).
- `detectPanelSupport()` / `negotiateBridgeCapabilities()` feature-detect
  Host API methods/version + granted capabilities **plus the seam
  handshake**, fail-closed: unknown versions, unknown grants, or a missing
  seam all degrade to read-only (no optimistic defaults — the worker `orca`
  API exposes no versions, so absent means unknown, never current).
  Unsupported hosts or missing consent → explicit degraded read-only UI
  (reason + version + capability status + actionable CLI fallback), never
  silent divergence and never a "structured available" claim without the
  transport to back it.
- `packages/core/src/pluginManifest.ts` mirrors the v1 rules (closed
  capability kinds, contribution limits, `events:subscribe` gate) so `ok:
  true` means the manifest is expected to pass Orca validation; `test/`
  validates the shipped artifact on every `npm test`.

## Security boundary

- Panel cannot request arbitrary command execution (allowlist enforced in
  `parseBridgeRequest` + `makeBridgeRequest`, tested with `exec`/`shell`
  probes).
- Mutations are typed allowlisted ops, not shell strings; built-ins are
  immutable; writes are schema-validated + atomic + conflict-checked.
- No GitHub token/private key is ever returned (`assertNoSecrets`
  defense-in-depth over core’s redacted reports; `github.status`/`doctor`
  carry `redacted: true`).
- Project-profile mutations are scoped to the current/explicit
  worktree/project root; delayed requests carry the submission-time scope.
  Panel-supplied roots are never trusted: the seam adapter stamps the
  harness-authorized root over them, and the dispatcher pins request roots
  to the transport-authorized root (`untrusted-scope` rejection).
- Authority modes are separated: the CLI's default `operator` transport is
  local-shell authority (never for forwarded panel requests); the seam
  adapter always uses `--transport seam` with host-reported facts so
  missing consent blocks reads and mutations at the dispatcher.

## Compatibility

- Capability negotiation (`negotiateBridgeCapabilities`) is additive:
  unknown future capabilities are ignored (never required); unknown future
  operations degrade to `unsupported` with an actionable message — later
  Host API additions do not require rewriting the panel.
- Read-only/degraded mode is kept for older Orca builds (`engines.orca
  >=1.4.0` still installs everywhere; pre-1.4 / non-v1 `pluginApi` /
  missing `workspace:read` → `cli-only` + an explicit user-gesture
  `terminal.sendText` fallback button, never auto-sent, output never
  parsed back).
- Windows + WSL: `normalizeProjectRoot` / `isAbsoluteProjectRoot` preserve
  `C:/`, UNC, and `\\wsl.localhost\…` prefixes (slash-normalized, no
  `process.cwd()` resolution); atomic writes use sibling-temp + rename;
  lock/consent paths are slash-safe. Tests cover drive-letter, UNC/WSL,
  and POSIX roots plus traversal-safe scope handling.

Other references:

- Orca CLI overview: `https://www.onorca.dev/docs/cli/overview`.
- Pi coding-agent CLI: `https://github.com/up0to1/pi-mono/blob/main/packages/coding-agent/README.md`.

## Re-validating against a new Orca release

1. Note the new app version from `orca status --json`
   (`result.runtime.appVersion`).
2. Re-read the upstream files listed above; confirm the Host API v0 table,
   capability set, and panel/worker transports. If a scoped
   `process:exec`/filesystem API has landed, evaluate it against the seam
   proposal before adopting (upstreamable, no Pi policy in core).
3. Update `TARGET_ORCA_APP_VERSION` in `packages/core/src/version.ts`,
   `BRIDGE_TARGET_ORCA_APP_VERSION` / `BRIDGE_UPSTREAM_COMMIT` in
   `packages/orca-plugin/src/bridge.ts`, `engines.orca` in
   `packages/orca-plugin/orca-plugin.json`, and this file (commit SHA +
   date + table deltas).
4. Run the manual smoke test in `README.md` (load the plugin folder in Orca,
   verify it loads without destabilizing Orca; verify structured vs degraded
   paths).
5. Record the outcome in the release notes / Linear update.

# Orca-Pi Native Panel → Worker RPC Migration Design

**Date:** 2026-09-16

**Status:** Approved design for `44madfire/orca-pi`.

## Goal

Migrate the Orca-Pi Control Center from the bespoke injected `window.__ORCA_PI_BRIDGE__` + seam-adapter + CLI-sidecar transport to Orca's new generic **panel → own plugin worker RPC** transport, while preserving the existing Orca-Pi versioned `BridgeRequest`/`BridgeResponse` domain protocol and authoritative core services.

The end state is:

```text
Orca-Pi Control Center panel
        |
        | Orca generic panel RPC: method = "bridge.request"
        v
Orca-Pi plugin worker
        |
        | trusted worktree context supplied by Orca
        v
Orca-Pi bridge dispatcher
        |
        v
@orca-pi/core authoritative services
   |- profiles
   |- orchestration mapping
   |- launch compiler
   |- GitHub identity diagnostics
   `- diagnostics
```

No Orca-Pi-specific UI, profile policy, filesystem policy, GitHub policy, or orchestration policy moves into Orca.

## Dependency

This design depends on the companion Orca fork design:

`44madfire/orca/docs/superpowers/specs/2026-09-16-plugin-panel-worker-rpc-design.md`

Required Orca primitives:

- `orca.rpc.register(method, handler)` in the plugin worker;
- panel message transport for private self-RPC;
- session-bound plugin identity derived by Orca;
- per-request trusted worktree context containing host-owned `path` only when `workspace:read` is granted;
- fresh per-request granted-capability snapshot;
- structured request/response with existing panel budgets and worker lifecycle.

## Architectural decision

Retain Orca-Pi's application/domain bridge, replace only its production UI transport.

### Keep

- `BridgeRequest` / `BridgeResponse` versioning and validators;
- allowlisted Orca-Pi operations;
- profile mutation service and atomic/conflict-safe writes;
- orchestration service;
- launch preview compiler;
- redacted GitHub diagnostics;
- diagnostics operation;
- `bridge-host.ts` or equivalent dispatcher over `@orca-pi/core`;
- CLI/operator bridge for scripting, tests, diagnostics, and recovery;
- explicit degraded behavior on Orca hosts that do not support panel worker RPC.

### Remove from the normal Control Center path

- `window.__ORCA_PI_BRIDGE__` host injection;
- `createSeamAdapter` / seam harness;
- spawning `orca-pi bridge --transport seam` per panel call;
- `ORCA_PI_BRIDGE_SEAM` environment handshake;
- forwarding host app version/pluginApi/grants through CLI flags solely to make the seam work;
- custom fork-side Orca-Pi service injection;
- panel-generated or seam-generated trusted filesystem scope.

## Domain protocol remains Orca-Pi-owned

The following operation set remains private to Orca-Pi and must not appear in Orca core:

```text
bridge.capabilities
worktree.context
profiles.list
profile.read
profile.validate
profile.mutate
launch.preview
orchestration.get
orchestration.set
github.status
github.doctor
diagnostics.doctor
```

`BridgeRequest` continues to carry:

```ts
{
  protocolVersion: 1
  requestId: string
  operation: BridgeOperation
  worktree?: BridgeWorktreeScope
  params?: unknown
}
```

but for the panel-RPC transport **the panel is no longer authoritative for `worktree`**. The worker adapter overwrites any caller-provided worktree object with the trusted Orca RPC context before validating/dispatching the request.

## Worker integration

The plugin entry registers exactly one private RPC method for the Control Center domain protocol:

```ts
orca.rpc.register('bridge.request', async (rawRequest, context) => {
  return worker.handlePanelRequest(rawRequest, context)
})
```

Avoid registering one Orca RPC method per domain operation. The versioned `BridgeRequest` protocol already provides Orca-Pi's application method namespace and validation.

### Trusted adapter

Introduce one focused adapter between generic Orca RPC context and the existing bridge dispatcher.

Conceptually:

```ts
async function handlePanelRequest(
  raw: unknown,
  context: PluginPanelRpcContext,
): Promise<BridgeResponse> {
  if (!context.worktree) {
    return bridgeFail(requestId(raw), 'auth/setup', 'workspace access is unavailable')
  }

  const trustedRoot = context.worktree.path
  const candidate = isRecord(raw)
    ? {
        ...raw,
        worktree: {
          projectRoot: trustedRoot,
          worktreeId: context.worktree.worktreeId,
        },
      }
    : raw

  return handleBridgeRequest(candidate, {
    transport: 'worker-rpc',
    trustedProjectRoot: trustedRoot,
    hostInfo: {
      grantedCapabilities: context.grantedCapabilities,
      seamAvailable: true,
    },
  })
}
```

Exact implementation may simplify `hostInfo` once legacy negotiation is removed, but the security order is mandatory:

1. receive untrusted panel payload;
2. overwrite panel-supplied scope wholesale with host-owned context;
3. validate the stamped `BridgeRequest`;
4. dispatch under the same trusted root;
5. return a validated `BridgeResponse`.

Never validate a write request requiring a root before stamping the trusted root, because the correctly designed panel no longer supplies it.

## Worktree authority and race semantics

The Orca RPC context is the authority for each request.

Required behavior:

```text
user presses Save while worktree A is active
        ↓
Orca captures A and invokes worker RPC
        ↓
user focuses B
        ↓
Orca-Pi request still resolves/writes against A
```

The panel MUST NOT call `workspace.readContext` to infer a filesystem root, and MUST NOT send a project root in normal structured requests.

`BridgeRequest.worktree` remains in the domain protocol because:

- CLI/operator transport still needs explicit project-root scoping;
- tests can exercise scope validation directly;
- internal dispatcher invariants continue to pin every filesystem operation to an explicit root.

For worker-RPC panel transport, the field is always host-stamped.

## Capability semantics

`orca-pi` already requests `workspace:read`; the new Orca RPC context uses that grant to decide whether trusted worktree context is present.

Required rules:

- If `context.worktree` is null, structured profile/orchestration/project operations fail closed with an actionable `auth/setup`/`unsupported` response as appropriate.
- Per-request `context.grantedCapabilities` is authoritative for that request.
- Do not trust the worker's activation-time `orca.grantedCapabilities` snapshot for delayed requests after consent changes.
- No `terminal:send` capability is needed for the primary structured path. Keep it only as long as the explicit legacy/degraded terminal fallback remains supported.

## Bridge capability negotiation

The old `seamAvailable` handshake existed to distinguish a stock Orca worker from a custom injected structured path. Native worker RPC makes transport reachability self-evident.

Target simplification:

```text
panel can successfully invoke bridge.request
        ↓
structured transport is available
```

`bridge.capabilities` should remain as an Orca-Pi domain operation because it is useful for protocol/version/operation discovery, but its `structured` result no longer depends on `ORCA_PI_BRIDGE_SEAM` or custom host injection.

The worker-RPC transport should report only operations actually permitted by the current host-owned worktree context/capabilities.

## Control Center transport

Replace the current panel helper:

```js
function bridge() { return window.__ORCA_PI_BRIDGE__; }
```

with a generic Orca panel-RPC client in the panel document.

Conceptual wrapper:

```js
function callWorker(method, params) {
  // post { type: 'orca-panel-rpc', requestId, method, params }
  // resolve matching orca-panel-rpc-result
}

function request(operation, params) {
  return callWorker('bridge.request', {
    protocolVersion: 1,
    requestId: newRequestId('cc'),
    operation,
    params,
  })
}
```

Do not duplicate Orca's session token, plugin key, worktree path, or grants in panel JavaScript. Those are host transport details.

### Feature detection

On panel startup:

1. attempt one native `bridge.request` for `bridge.capabilities`;
2. if the Orca panel-RPC message/result path is unavailable or returns transport-level unknown/unavailable, enter the explicit degraded UI;
3. if the RPC succeeds, use the returned Orca-Pi capabilities/operation set for all subsequent feature gating.

Do not feature-detect by parsing Orca version strings when the actual transport can be probed.

## Degraded compatibility path

Older Orca versions without panel worker RPC remain supported in a bounded degraded mode while that compatibility is still useful.

Allowed degraded behavior:

- clearly label structured configuration as unavailable;
- expose read-only/help/status information already safe to show;
- retain the existing explicit, user-triggered `terminal.sendText` fallback only for allowlisted read-only CLI commands if desired;
- never auto-send terminal commands;
- never parse terminal output back into structured UI state;
- never offer profile/orchestration mutations through terminal text.

The new native structured path is the default and documentation target.

## CLI/operator bridge

Keep the CLI bridge as a separate operator interface:

```text
human/script -> orca-pi bridge --request ... --project-root ...
```

This remains useful for:

- automation;
- diagnostics;
- deterministic tests;
- recovery;
- inspecting the domain protocol without Orca.

Remove only the `seam` transport behavior that exists to forward untrusted panel requests through a subprocess. Operator transport still pins the explicit project root and validates requests.

## Migration of current modules

### `packages/orca-plugin/src/bridge.ts`

Keep:

- protocol/version constants;
- request/response types;
- operation allowlist;
- worktree validation;
- response validators;
- domain error codes.

Adjust comments/docs that describe the seam as the production target.

### `packages/orca-plugin/src/bridge-host.ts`

Keep as the authoritative dispatcher over `@orca-pi/core`.

Add/rename transport mode to model native worker RPC if transport-specific behavior remains necessary. Prefer reducing transport conditionals rather than adding another parallel branch.

### `packages/orca-plugin/src/worker.ts`

Change from "negotiates a future seam" to the real structured worker endpoint.

Responsibilities:

- accept host RPC context per request;
- stamp trusted scope;
- invoke bridge host;
- return BridgeResponse;
- avoid caching per-request grants/worktree as durable authority.

### `packages/orca-plugin/worker-entry.mjs`

Register `bridge.request` via `orca.rpc.register`.

Do not register dozens of domain methods and do not spawn a child process.

### `packages/orca-plugin/src/seam-adapter.ts`

Delete after the native worker-RPC path and compatibility tests prove it is no longer referenced.

### CLI bridge command

Retain operator mode. Remove `--transport seam` and seam-only host-fact flags once no tests or supported workflows depend on them.

### Control Center panel

Replace custom bridge injection usage with native panel RPC while preserving existing Profiles / Orchestration / GitHub / Diagnostics UI and domain request calls.

## Windows + WSL constraint

The target environment includes Windows Orca Desktop with worktrees/projects that may live in WSL.

The migration MUST NOT guess or independently translate worktree paths in the panel.

Rules:

- consume `context.worktree.path` exactly as supplied by Orca;
- reuse existing Orca-Pi cross-platform/path handling where the core already supports Windows/UNC/WSL roots;
- preserve `normalizeProjectRoot`/absolute-root security behavior for domain validation;
- add explicit fixtures for POSIX, drive-letter, UNC, and `\\wsl.localhost\...` roots;
- if the plugin worker cannot access an Orca-provided execution-host path in a real target configuration, fail closed and document the generic execution-location gap; do not add a Pi-specific Orca escape hatch inside this migration.

## Secrets and GitHub identity safety

Native panel RPC does not relax existing redaction requirements.

- `github.status` / `github.doctor` return redacted status only.
- No token/private key crosses the panel RPC boundary.
- No credential material appears in BridgeResponse errors, plugin logs, DOM, notifications, or test snapshots.
- RPC parameters from the panel never contain secrets that the worker can obtain directly from its existing configured secret sources.

## PR decomposition

### NPRPC-1 — Register `bridge.request` on the Orca plugin worker and bind trusted RPC context

Implement the native worker endpoint while leaving the old panel transport temporarily intact.

Must prove:

- worker registers exactly the expected private RPC method;
- trusted Orca worktree path overwrites panel `worktree` input;
- panel-supplied `worktreeId`/`terminalId` do not survive unless intentionally reattached from trusted host context;
- fresh per-request grants control structured availability;
- profile/orchestration writes remain pinned to the trusted root;
- malformed requests still return existing BridgeResponse validation errors;
- no CLI subprocess is spawned by native worker RPC;
- direct bridge-host/core unit tests remain unchanged/green.

### NPRPC-2 — Move Control Center to native Orca panel RPC

Replace `window.__ORCA_PI_BRIDGE__` usage with the generic `orca-panel-rpc` request/result client.

Must prove:

- startup `bridge.capabilities` negotiation succeeds through native RPC;
- Profiles CRUD/validation/launch preview requests use native RPC;
- orchestration get/set uses native RPC;
- GitHub/diagnostics requests use native RPC;
- request IDs correlate under concurrent UI calls;
- transport failure enters explicit degraded state;
- no panel request contains plugin key, session token, worktree root, or grants;
- old Orca host behavior remains safely degraded.

### NPRPC-3 — Remove bespoke seam/sidecar production transport and simplify negotiation

After NPRPC-1/2 are green, delete the superseded transport.

Must remove only code made obsolete by native RPC:

- seam adapter;
- `__ORCA_PI_BRIDGE__` injection assumptions;
- `ORCA_PI_BRIDGE_SEAM` handshake;
- seam transport CLI mode and seam-only host-fact plumbing;
- tests/documentation asserting the custom seam is the production target.

Must retain operator CLI bridge and all domain protocol/core behavior.

Add architecture-regression tests where practical so production panel transport cannot silently return to subprocess spawning/custom injection.

### NPRPC-4 — Full Control Center E2E, compatibility, Windows/WSL, and security regression

Exercise the assembled real path with a compatible Orca build:

```text
panel -> Orca panel RPC -> Orca-Pi worker -> bridge host -> core -> response
```

Required scenarios:

- fresh built-in profile listing;
- create/edit/reset/delete project profile;
- stale source-hash conflict and reload;
- launch preview uses saved profile;
- role mapping change persists and resolves correctly;
- redacted GitHub status/doctor;
- diagnostics/capabilities;
- worktree focus changes during an in-flight request do not retarget scope;
- consent revoke/degraded behavior;
- worker restart and panel reload;
- older Orca host without RPC;
- Windows drive root fixture;
- WSL/UNC root fixture and manual target smoke where available;
- no secret leakage;
- no UI request starts `orca-pi bridge --transport seam` or any equivalent sidecar.

## Test strategy

### Unit/contract tests

Keep tests around `BridgeRequest`/`BridgeResponse` as the domain boundary. Add focused tests for the native RPC context adapter.

Required cases:

- host context missing;
- `workspace:read` unavailable;
- trusted root overwrites malicious panel root;
- trusted root mismatch cannot be escaped by nested params;
- stale hash conflict preserved;
- malformed operation preserved as validation error;
- bridge protocol mismatch preserved as unsupported;
- arbitrary `exec`/`shell` operation remains rejected;
- POSIX/drive/UNC/WSL roots normalize and compare as expected.

### Panel tests

Use a fake generic Orca RPC parent harness, not `__ORCA_PI_BRIDGE__`.

Required cases:

- request message shape;
- request/result correlation;
- success and domain error rendering;
- transport error rendering;
- concurrent calls;
- capability-based button enablement;
- degraded old-host UI;
- no sensitive/authority fields emitted by the panel.

### Worker integration tests

Invoke the registered handler with fake Orca `PluginPanelRpcContext` and real temp configuration files.

Prove:

- create/read/mutate under trusted root;
- malicious caller root ignored;
- focus-context identity stays fixed for one call;
- grants are read per invocation;
- no sidecar spawn;
- errors remain bounded/redacted.

### End-to-end tests

Prefer deterministic temp repos/files and fake GitHub credential providers over screenshot-only tests. Manual Orca Desktop smoke remains appropriate for visual panel behavior and Windows/WSL integration that cannot be hermetically reproduced in CI.

## Documentation changes

Update docs so the normal architecture reads:

```text
Install Orca-Pi plugin
-> open Orca-Pi Control Center
-> native Orca panel-to-worker RPC
-> authoritative Orca-Pi core services
```

CLI bridge documentation moves to automation/debugging/recovery, not UI transport.

`docs/ORCA_PLUGIN_API.md` should clearly separate:

- current native panel-worker RPC target;
- legacy seam history if retained for migration notes;
- minimum compatible Orca version/commit once the Orca PRs land;
- degraded behavior for older hosts.

## Acceptance criteria

- The Control Center performs structured Profiles, Orchestration, GitHub, and Diagnostics operations through Orca's generic panel→worker RPC.
- The panel never supplies authoritative worktree paths, grants, plugin identity, or session identity.
- The worker stamps host-owned scope before domain request validation.
- UI and CLI continue to operate over the same authoritative Orca-Pi core/config data.
- The normal UI path spawns no CLI sidecar and depends on no custom Orca-Pi injection.
- Legacy seam-only code is removed after migration, while operator CLI bridge remains available.
- Older Orca hosts degrade explicitly and safely.
- Windows/WSL path behavior is tested and does not introduce a Pi-specific Orca exception.
- No secrets cross the panel transport.

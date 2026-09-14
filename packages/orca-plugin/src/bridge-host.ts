/**
 * Orca-Pi bridge host dispatcher (UI1.2).
 *
 * Executes versioned {@link BridgeRequest}s via the authoritative
 * Orca-Pi application/config services (`@orca-pi/core`) and returns
 * versioned {@link BridgeResponse}s with stable request IDs and
 * machine-readable errors (`validation`, `conflict`, `unsupported`,
 * `auth/setup`, `internal`, plus `not-found` / `already-exists`).
 *
 * Security boundary (enforced here, tested in `test/bridge-host.test.ts`):
 * - Allowlisted operations only — the panel cannot request arbitrary
 *   command execution (no `exec`/`shell`/`command` op exists).
 * - Profile mutations route through UI1.1's core service
 *   (`create/clone/patch/set/unset/delete`), never ad-hoc YAML writes.
 * - No second profile store: reads/writes use only the authoritative
 *   user/project YAML via core; `storage`/`settings` are never used.
 * - No token/private key is ever returned: GitHub ops return redacted
 *   status/doctor reports only (core guarantees this; this host asserts
 *   it defensively before responding).
 * - Project-profile mutations are scoped to the explicit
 *   `worktree.projectRoot` captured at submission; the host never uses
 *   "active worktree at execution time", so delayed requests cannot be
 *   redirected by focus changes.
 * - Arbitrary `userPath`/`projectPath` overrides are NOT accepted from
 *   the panel — the host derives `<projectRoot>/.pi/...` for project
 *   scope and the global path from env/home for user scope.
 *
 * Runs in Node (CLI sidecar today; Orca worker behind the future generic
 * scoped-exec/plugin-service seam tomorrow). Never imports
 * `node:child_process`/Electron; never spawns processes itself except via
 * injected `runner` for read-only `diagnostics.doctor` probes.
 */

import {
  BRIDGE_OPERATIONS,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_VERSION,
  bridgeFail,
  bridgeOk,
  DEGRADED_SAFE_OPERATIONS,
  mapMutationCodeToBridge,
  negotiateBridgeCapabilities,
  normalizeProjectRoot,
  parseBridgeRequest,
  type BridgeErrorCode,
  type BridgeRequest,
  type BridgeResponse,
} from "./bridge.js";
import type {
  DoctorCheck,
  DoctorReport,
  GithubDoctorReport,
  MutationScope,
  OrchestrationScope,
} from "@orca-pi/core";
import { DIAGNOSTICS_DETAIL_LIMIT, redactDiagnosticsText, sanitizeDiagnosticsDetail } from "./control-center.js";

export interface BridgeHostDeps {
  /** Explicit project root fallback when a request carries no worktree scope (reads only). */
  projectRoot?: string;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  osHomedir?: () => string;
  /** Injectable profile/config filesystem (tests use memfs; prod uses node:fs). */
  fs?: import("@orca-pi/core").MutationFs;
  /** Injectable orchestration-config filesystem (defaults to `fs` when omitted). */
  orchestrationFs?: import("@orca-pi/core").OrchestrationFs;
  /** Injectable GitHub fetch (tests stub; prod uses global fetch). Unit tests never hit github.com. */
  fetchFn?: import("@orca-pi/core").GithubFetchFn;
  /** Injectable process runner for read-only `diagnostics.doctor` (orca/pi --version probes). */
  runner?: import("@orca-pi/core").ProcessRunner;
  /** Host version info for `bridge.capabilities` (unknown/absent fields degrade fail-closed). */
  hostInfo?: { appVersion?: string; pluginApi?: number; grantedCapabilities?: readonly string[]; seamAvailable?: boolean };
  /** Injectable credential fs for GitHub doctor (tests stub; prod resolves node:fs). */
  providerFs?: import("@orca-pi/core").CredentialProviderFs;
  /**
   * Injectable runtime context for `diagnostics.doctor` (tests stub;
   * prod derives from `process.version`/`process.platform`/`process.arch`
   * plus WSL env). Unknown/absent fields degrade to truthful unknown
   * states — never synthesized as healthy.
   */
  runtimeInfo?: { nodeVersion?: string; platform?: string; arch?: string; wsl?: string };
  /**
   * Transport carrying this request (authority basis).
   * - `"seam"` (default): panel path. Structured operations require
   *   negotiated `structured` support (versions + `workspace:read` consent
   *   + seam handshake); anything beyond `DEGRADED_SAFE_OPERATIONS` is
   *   rejected while unstructured, so "missing consent → degraded" is a
   *   host-enforced property, not UI metadata.
   * - `"operator"`: local shell authority (`orca-pi bridge`, the default
   *   CLI mode). A human invoking the CLI directly already authorizes the
   *   call, so the consent gate does not apply — but root pinning below
   *   still does. Never use this mode to forward untrusted panel
   *   requests; the seam adapter always uses `"seam"`.
   */
  transport?: "seam" | "operator";
  /**
   * Authoritative root the transport authorized (sidecar `--project-root`,
   * seam-injected worktree root). When set, a request-supplied
   * `worktree.projectRoot` must normalize-equal it; mismatches are
   * rejected before dispatch so one worktree can never address another's
   * config. Applies to every scope — user/global reads/writes included.
   */
  trustedProjectRoot?: string;
}

function defaultProjectRoot(deps: BridgeHostDeps, request?: BridgeRequest): string {
  const explicit = request?.worktree?.projectRoot;
  if (explicit !== undefined && explicit.length > 0) return explicit;
  if (deps.projectRoot !== undefined && deps.projectRoot.length > 0) return deps.projectRoot;
  try {
    return process.cwd();
  } catch {
    return ".";
  }
}

function baseMutationOptions(deps: BridgeHostDeps, projectRoot: string): import("@orca-pi/core").MutationWriteOptions {
  return {
    projectRoot,
    ...(deps.env !== undefined ? { env: deps.env } : {}),
    ...(deps.homedir !== undefined ? { homedir: deps.homedir } : {}),
    ...(deps.osHomedir !== undefined ? { osHomedir: deps.osHomedir } : {}),
    ...(deps.fs !== undefined ? { fs: deps.fs } : {}),
  };
}

function baseOrchestrationOptions(deps: BridgeHostDeps, projectRoot: string): import("@orca-pi/core").OrchestrationReadOptions {
  const fs = (deps.orchestrationFs ?? deps.fs) as import("@orca-pi/core").OrchestrationFs | undefined;
  return {
    projectRoot,
    ...(deps.env !== undefined ? { env: deps.env } : {}),
    ...(deps.homedir !== undefined ? { homedir: deps.homedir } : {}),
    ...(deps.osHomedir !== undefined ? { osHomedir: deps.osHomedir } : {}),
    ...(fs !== undefined ? { fs } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Defensive secret scan: GitHub/diagnostics bridge results must never carry tokens/keys. */
function assertNoSecrets(value: unknown, where: string): void {
  let text: string;
  try {
    text = JSON.stringify(value) ?? "";
  } catch {
    return;
  }
  const probes: Array<{ re: RegExp; label: string }> = [
    { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: "private key material" },
    { re: /\bghp_[A-Za-z0-9]{10,}/, label: "GitHub PAT" },
    { re: /\bgho_[A-Za-z0-9]{10,}/, label: "GitHub OAuth token" },
    { re: /\bghu_[A-Za-z0-9]{10,}/, label: "GitHub user token" },
    { re: /\bghs_[A-Za-z0-9]{10,}/, label: "GitHub server token" },
    { re: /\bghr_[A-Za-z0-9]{10,}/, label: "GitHub refresh token" },
    { re: /\bgithub_pat_[A-Za-z0-9_]{10,}/, label: "GitHub fine-grained PAT" },
    { re: /x-access-token:[^\s"']+/, label: "GitHub bearer token" },
  ];
  for (const probe of probes) {
    if (probe.re.test(text)) {
      throw new Error(`Refusing to return ${probe.label} to the panel via ${where} (redacted status only).`);
    }
  }
  // Token/private-key values are never echoed under any `*token*` or
  // `*private*key*` key with a non-trivial string value (covers `token`,
  // `ORCA_PI_GITHUB_WORKER_TOKEN`, `privateKey`, ...). Redacted reports
  // use `configured`/`sourceLabel`/`tokenRefreshable` booleans/labels
  // instead, and `sourceLabel` values (e.g. `"sourceLabel":
  // "ORCA_PI_GITHUB_WORKER_TOKEN"`) never match (key has no `token`).
  if (/"[^"]*token[^"]*"\s*:\s*"[^"]{8,}"/i.test(text)) {
    throw new Error(`Refusing to return token values to the panel via ${where} (redacted status only).`);
  }
  if (/"[^"]*private[_-]?key[^"]*"\s*:\s*"[^"]{8,}"/i.test(text)) {
    throw new Error(`Refusing to return private-key values to the panel via ${where} (redacted status only).`);
  }
}

/**
 * Collect redactable secret values from an env mapping without logging
 * them (mirrors `core.collectSecretsFromEnv` for the sync error path).
 * Any `*TOKEN*`/`*SECRET*`/`*PRIVATE_KEY*` value plus token-shaped
 * values (`ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`/`github_pat_`) in any var
 * is collected; callers only ever replace these values with
 * placeholders, never echo them.
 */
function collectEnvSecretsForBridgeError(env: NodeJS.ProcessEnv | Record<string, string | undefined>): string[] {
  const secrets: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string" || value.length === 0) continue;
    const upper = key.toUpperCase();
    if (upper.includes("TOKEN") || upper.includes("SECRET") || upper.includes("PRIVATE_KEY")) {
      secrets.push(value);
      continue;
    }
    if (/^(ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)/.test(value) && value.length >= 12) {
      secrets.push(value);
    }
  }
  return secrets;
}

/**
 * Sanitize a bridge error message before it crosses the bridge (defense
 * in depth). Redacts explicit env-backed secret values first (arbitrary
 * `*TOKEN*`/`*SECRET*`/`*PRIVATE_KEY*` values, not just known prefixes),
 * then token/key patterns (var-name labels like `*_TOKEN` stay intact
 * for actionable guidance), and bounds to `DIAGNOSTICS_DETAIL_LIMIT`
 * chars so a secret-bearing throw (runner stdout, provider fetch body,
 * panel-echoed value) can never reach the DOM via error rendering.
 * Actionable non-secret text survives. Never echoes secret values.
 */
function sanitizeBridgeErrorMessage(message: string, secrets: readonly string[] = []): string {
  let out = message;
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue;
    out = out.split(secret).join("<redacted>");
  }
  const redacted = redactDiagnosticsText(out);
  if (redacted.length <= DIAGNOSTICS_DETAIL_LIMIT) return redacted;
  return `${redacted.slice(0, DIAGNOSTICS_DETAIL_LIMIT)}… [truncated]`;
}

/**
 * Execute one versioned bridge request. Never throws — failures become
 * `ok: false` responses with stable requestId + machine-readable code.
 */
export async function handleBridgeRequest(data: unknown, deps: BridgeHostDeps = {}): Promise<BridgeResponse> {
  const parsed = parseBridgeRequest(data);
  if (!parsed.ok) {
    // parseBridgeRequest already chose validation vs unsupported.
    return {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      requestId: parsed.requestId,
      ok: false,
      error: parsed.error,
    };
  }
  const { request } = parsed;
  try {
    const gate = enforceTransportGate(request, deps);
    if (gate) return gate;
    const result = await dispatch(request, deps);
    return bridgeOk(request.requestId, result);
  } catch (error) {
    const secrets = collectEnvSecretsForBridgeError(deps.env ?? process.env);
    return toBridgeError(request.requestId, error, secrets);
  }
}

/**
 * Host-side transport enforcement (round-3 hardening).
 *
 * 1. Root pinning: when the transport authorized one root
 *    (`trustedProjectRoot`), a request-supplied `worktree.projectRoot` must
 *    normalize-equal it. A mismatch is rejected with `validation` before
 *    any read or write, so a request smuggled through one worktree's seam
 *    can never address another worktree's config (any scope).
 * 2. Structured gate (seam transport only): while negotiation reports
 *    unstructured, only `DEGRADED_SAFE_OPERATIONS` are served. Reads of
 *    config data and all mutations are rejected — `auth/setup` when the
 *    block is consent, `unsupported` when it is reachability — so degraded
 *    mode is enforced here, not merely advertised to the UI.
 *
 * Returns a rejection response, or undefined when the request may proceed.
 */
function enforceTransportGate(request: BridgeRequest, deps: BridgeHostDeps): BridgeResponse | undefined {
  const trusted = deps.trustedProjectRoot;
  if (trusted !== undefined && request.worktree?.projectRoot !== undefined) {
    if (normalizeProjectRoot(request.worktree.projectRoot) !== normalizeProjectRoot(trusted)) {
      return bridgeFail(request.requestId, "validation", `Untrusted worktree.projectRoot ${JSON.stringify(request.worktree.projectRoot)}: this transport authorized ${JSON.stringify(normalizeProjectRoot(trusted))} and requests outside it are rejected before any read or write.`, { detail: "untrusted-scope" });
    }
  }
  const transport = deps.transport ?? "seam";
  if (transport === "operator") return undefined;
  if ((DEGRADED_SAFE_OPERATIONS as readonly string[]).includes(request.operation)) return undefined;
  const negotiation = negotiateBridgeCapabilities(deps.hostInfo);
  if (negotiation.structured) return undefined;
  if (!negotiation.consentOk) {
    return bridgeFail(
      request.requestId,
      "auth/setup",
      `Refusing ${request.operation}: workspace:read consent is unverified for this transport (grants unknown or missing). Grant the capability and retry through the seam, or run the read-only CLI fallback. No data was read or written.`,
    );
  }
  return bridgeFail(
    request.requestId,
    "unsupported",
    `Refusing ${request.operation}: the structured bridge is unreachable on this transport (no seam handshake or unknown host version). Serve it via the \`orca-pi bridge\` sidecar or the degraded CLI fallback. No data was read or written.`,
  );
}

function toBridgeError(requestId: string, error: unknown, secrets: readonly string[] = []): BridgeResponse {
  if (error && typeof error === "object" && "code" in error && "message" in error) {
    const record = error as { code: unknown; message: unknown };
    if (typeof record.code === "string" && typeof record.message === "string") {
      // Core mutation/orchestration errors carry UI1.1 codes — map them.
      const mapped = mapMutationCodeToBridge(record.code);
      // `auth/setup` surfaces when GitHub setup is required (see below);
      // core `load-failed` on missing config stays `internal` with action.
      // Sanitize before crossing: a panel-echoed value or core throw
      // carrying a token/key pattern must never reach the DOM via errors.
      return bridgeFail(requestId, mapped, sanitizeBridgeErrorMessage(record.message, secrets), { detail: record.code });
    }
  }
  if (error instanceof Error) {
    // Explicit unsupported/auth signals thrown with a prefix marker.
    if (error.message.startsWith("[unsupported] ")) {
      return bridgeFail(requestId, "unsupported", sanitizeBridgeErrorMessage(error.message.slice("[unsupported] ".length), secrets));
    }
    if (error.message.startsWith("[auth/setup] ")) {
      return bridgeFail(requestId, "auth/setup", sanitizeBridgeErrorMessage(error.message.slice("[auth/setup] ".length), secrets));
    }
    return bridgeFail(requestId, "internal", sanitizeBridgeErrorMessage(error.message, secrets));
  }
  return bridgeFail(requestId, "internal", sanitizeBridgeErrorMessage(String(error), secrets));
}

async function dispatch(request: BridgeRequest, deps: BridgeHostDeps): Promise<unknown> {
  switch (request.operation) {
    case "bridge.capabilities":
      return capabilitiesResult(deps);
    case "worktree.context":
      return worktreeContextResult(request, deps);
    case "profiles.list":
      return await profilesListResult(request, deps);
    case "profile.read":
      return await profileReadResult(request, deps);
    case "profile.validate":
      return await profileValidateResult(request, deps);
    case "profile.mutate":
      return await profileMutateResult(request, deps);
    case "launch.preview":
      return await launchPreviewResult(request, deps);
    case "orchestration.get":
      return await orchestrationGetResult(request, deps);
    case "orchestration.set":
      return await orchestrationSetResult(request, deps);
    case "github.status":
      return await githubStatusResult(request, deps);
    case "github.doctor":
      return await githubDoctorResult(request, deps);
    case "diagnostics.doctor":
      return await diagnosticsDoctorResult(request, deps);
    default: {
      const exhaustive: never = request.operation;
      throw new Error(`[unsupported] Unknown bridge operation ${JSON.stringify(exhaustive)}.`);
    }
  }
}

function capabilitiesResult(deps: BridgeHostDeps): unknown {
  const negotiation = negotiateBridgeCapabilities(deps.hostInfo);
  const transport = deps.transport ?? "seam";
  // `structured` is the panel-path signal (versions + consent +
  // handshake). `permittedOperations` is what THIS dispatcher will serve:
  // identical on the seam transport, the full set under local operator
  // authority. Operators consult `permittedOperations`; panels consult
  // `structured`. The two always agree on `"seam"`.
  const permittedOperations: readonly unknown[] =
    transport === "operator" ? BRIDGE_OPERATIONS : negotiation.supportedOperations;
  return {
    ...negotiation,
    permittedOperations,
    upstream: {
      commit: "9aa0f7e77d366c23a3cc8de2da32ae550d397dc0",
      appVersion: "1.4.196+ (re-audited 2026-09-11; Host API v0 unchanged — no process:exec/filesystem API)",
    },
    transport: {
      mode: transport,
      primary:
        transport === "operator"
          ? "local operator shell (`orca-pi bridge`, default mode): the invoking shell already authorizes the call; root pinning still applies"
          : "seam harness (`orca-pi bridge --transport seam` or the adapter): host-reported versions/grants/handshake gate every structured operation; generic scoped-exec/plugin-service seam is the upstreamable future — no Pi policy in Orca core",
      degraded: "explicit user-triggered terminal.sendText for read-only CLI commands only (never auto-sent, never parsed)",
      noSecondStore: true,
    },
  };
}

function worktreeContextResult(request: BridgeRequest, deps: BridgeHostDeps): unknown {
  const projectRoot = defaultProjectRoot(deps, request);
  return {
    projectRoot,
    ...(request.worktree?.worktreeId !== undefined ? { worktreeId: request.worktree.worktreeId } : {}),
    ...(request.worktree?.terminalId !== undefined ? { terminalId: request.worktree.terminalId } : {}),
    explicit: request.worktree !== undefined,
    note: request.worktree !== undefined
      ? "Explicit scope captured at submission — the bridge never re-reads the focused worktree at execution time, so delayed requests cannot be redirected by focus changes. Host workspace.readContext supplies branch/display name/terminal identity only (never filesystem paths); the absolute projectRoot above arrives via the seam/sidecar injection and is re-validated here."
      : "No explicit scope on this read. Mutating operations require worktree.projectRoot from the seam/sidecar injection (workspace.readContext carries no filesystem path). Panels obtain terminal identity via host workspace.readContext for explicit terminal.sendText targeting.",
  };
}

function asCoreReadFs(
  fs: import("@orca-pi/core").MutationFs | undefined,
): Pick<typeof import("node:fs/promises"), "readFile"> | undefined {
  if (fs === undefined) return undefined;
  return { readFile: fs.readFile as unknown as typeof import("node:fs/promises").readFile };
}

async function profilesListResult(request: BridgeRequest, deps: BridgeHostDeps): Promise<unknown> {
  const core = await import("@orca-pi/core");
  const projectRoot = defaultProjectRoot(deps, request);
  const readFs = asCoreReadFs(deps.fs);
  const merged = await core.loadMergedProfiles({
    projectRoot,
    ...(deps.env !== undefined ? { env: deps.env } : {}),
    ...(deps.homedir !== undefined ? { homedir: deps.homedir } : {}),
    ...(deps.osHomedir !== undefined ? { osHomedir: deps.osHomedir } : {}),
    ...(readFs !== undefined ? { fs: readFs } : {}),
  });
  const userPath = core.getUserProfilesPath({
    ...(deps.env !== undefined ? { env: deps.env } : {}),
    ...(deps.homedir !== undefined ? { homedir: deps.homedir } : {}),
    ...(deps.osHomedir !== undefined ? { osHomedir: deps.osHomedir } : {}),
  });
  const projectPath = core.getProjectProfilesPath(projectRoot);
  // Existence probes (best-effort, never throw — missing files are normal).
  const [userExists, projectExists] = await Promise.all([
    fileExists(deps.fs, userPath),
    fileExists(deps.fs, projectPath),
  ]);
  const layers: import("@orca-pi/core").ProfileLayerContext = {
    mergedDoc: merged,
    builtinDoc: core.getBuiltinProfilesDocument(),
    userPath,
    projectPath,
    userExists,
    projectExists,
  };
  // Attach per-layer docs for provenance when available (best-effort).
  try {
    const readFs = asCoreReadFs(deps.fs);
    const [userDoc, projectDoc] = await Promise.all([
      core.loadProfilesFile(userPath, readFs !== undefined ? { fs: readFs } : {}).catch(() => undefined),
      core.loadProfilesFile(projectPath, readFs !== undefined ? { fs: readFs } : {}).catch(() => undefined),
    ]);
    if (userDoc) (layers as { userDoc?: unknown }).userDoc = userDoc;
    if (projectDoc) (layers as { projectDoc?: unknown }).projectDoc = projectDoc;
  } catch {
    // Provenance falls back to merged labels — never blocks the list.
  }
  const summaries = core.summarizeAllProfiles(layers);
  const panel = core.toPanelModel(layers);
  return { summaries, panel, provenance: "authoritative YAML (builtins < user < project); no second store" };
}

async function fileExists(
  fs: import("@orca-pi/core").MutationFs | undefined,
  path: string,
): Promise<boolean> {
  try {
    if (fs?.stat) {
      await fs.stat(path);
      return true;
    }
    const nodeFs = await import("node:fs/promises");
    await nodeFs.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function profileReadResult(request: BridgeRequest, deps: BridgeHostDeps): Promise<unknown> {
  const params = asParams(request.params, request.requestId);
  const name = params["name"];
  if (typeof name !== "string" || name.length === 0) {
    throw profileValidationError(`profile.read requires params.name (non-empty profile name).`);
  }
  const core = await import("@orca-pi/core");
  const projectRoot = defaultProjectRoot(deps, request);
  const view = await core.readEditableProfile(name, baseMutationOptions(deps, projectRoot));
  return view;
}

async function profileValidateResult(request: BridgeRequest, deps: BridgeHostDeps): Promise<unknown> {
  const core = await import("@orca-pi/core");
  const projectRoot = defaultProjectRoot(deps, request);
  const params = asParams(request.params, request.requestId);
  const readFs = asCoreReadFs(deps.fs);
  const merged = await core.loadMergedProfiles({
    projectRoot,
    ...(deps.env !== undefined ? { env: deps.env } : {}),
    ...(deps.homedir !== undefined ? { homedir: deps.homedir } : {}),
    ...(deps.osHomedir !== undefined ? { osHomedir: deps.osHomedir } : {}),
    ...(readFs !== undefined ? { fs: readFs } : {}),
  });
  const entries = core.validateAllProfiles({ mergedDoc: merged });
  const name = params["name"];
  if (typeof name === "string" && name.length > 0) {
    const entry = entries.find((item) => item.name === name);
    if (!entry) {
      const err = new Error(`Unknown Pi profile ${JSON.stringify(name)}.`) as Error & { code?: string };
      err.code = "not-found";
      throw err;
    }
    return { entries: [entry], ok: entry.valid };
  }
  return { entries, ok: entries.every((item) => item.valid) };
}

type MutationAction = "create" | "clone" | "patch" | "set" | "unset" | "delete";

const MUTATION_ACTIONS: readonly string[] = ["create", "clone", "patch", "set", "unset", "delete"];

async function profileMutateResult(request: BridgeRequest, deps: BridgeHostDeps): Promise<unknown> {
  const params = asParams(request.params, request.requestId);
  const action = params["action"];
  if (typeof action !== "string" || !MUTATION_ACTIONS.includes(action)) {
    throw profileValidationError(
      `profile.mutate requires params.action to be one of ${MUTATION_ACTIONS.join(", ")} (got ${JSON.stringify(action)}). Arbitrary operations are rejected — the panel cannot request shell execution.`,
    );
  }
  const scope = params["scope"];
  if (scope !== "user" && scope !== "project") {
    const err = new Error(
      `profile.mutate requires explicit params.scope "user" or "project" (got ${JSON.stringify(scope)}). Destructive targets are never inferred.`,
    ) as Error & { code?: string };
    err.code = "missing-scope";
    throw err;
  }
  if (request.worktree?.projectRoot === undefined) {
    const err = new Error(
      `profile.mutate requires explicit worktree.projectRoot (captured at submission — delayed requests must never be redirected by focus changes).`,
    ) as Error & { code?: string };
    err.code = "missing-scope";
    throw err;
  }
  const core = await import("@orca-pi/core");
  const projectRoot = request.worktree.projectRoot;
  const base = baseMutationOptions(deps, projectRoot);
  const withHash = withExpectedHash(base, params);
  const op = action as MutationAction;
  switch (op) {
    case "create": {
      const name = requireString(params["name"], "params.name");
      const initial = params["initial"] !== undefined ? requireObject(params["initial"], "params.initial") : undefined;
      const extendsParent = params["extends"] !== undefined ? requireString(params["extends"], "params.extends") : undefined;
      // Core takes inheritance inside `initial` (like `profile create
      // --extends`, which folds it there) — never as a sibling that would
      // be silently ignored.
      const mergedInitial = { ...(initial ?? {}), ...(extendsParent !== undefined ? { extends: extendsParent } : {}) };
      return await core.createProfile(
        { name, scope: scope as MutationScope, ...(Object.keys(mergedInitial).length > 0 ? { initial: mergedInitial } : {}) },
        withHash,
      );
    }
    case "clone": {
      const source = requireString(params["source"] ?? params["from"], "params.source");
      const dest = requireString(params["dest"] ?? params["name"], "params.dest");
      return await core.cloneProfile({ source, dest, scope: scope as MutationScope }, withHash);
    }
    case "patch": {
      const name = requireString(params["name"], "params.name");
      const patch = requireObject(params["patch"] ?? params["data"], "params.patch");
      return await core.patchProfile({ name, scope: scope as MutationScope, patch }, withHash);
    }
    case "set": {
      const name = requireString(params["name"], "params.name");
      const field = requireString(params["field"], "params.field");
      if (!("value" in params)) throw profileValidationError("profile.mutate set requires params.value.");
      return await core.setProfileField({ name, scope: scope as MutationScope, field, value: params["value"] }, withHash);
    }
    case "unset": {
      const name = requireString(params["name"], "params.name");
      const field = requireString(params["field"], "params.field");
      return await core.unsetProfileField({ name, scope: scope as MutationScope, field }, withHash);
    }
    case "delete": {
      const name = requireString(params["name"], "params.name");
      return await core.deleteProfile({ name, scope: scope as MutationScope }, withHash);
    }
    default: {
      const exhaustive: never = op;
      throw profileValidationError(`Unsupported mutation action ${JSON.stringify(exhaustive)}.`);
    }
  }
}

async function launchPreviewResult(request: BridgeRequest, deps: BridgeHostDeps): Promise<unknown> {
  const core = await import("@orca-pi/core");
  const params = asParams(request.params, request.requestId);
  const name = requireString(params["name"], "params.name");
  const showFullPrompt = params["showFullPrompt"] === true;
  const projectRoot = defaultProjectRoot(deps, request);
  const readFs = asCoreReadFs(deps.fs);
  const merged = await core.loadMergedProfiles({
    projectRoot,
    ...(deps.env !== undefined ? { env: deps.env } : {}),
    ...(deps.homedir !== undefined ? { homedir: deps.homedir } : {}),
    ...(deps.osHomedir !== undefined ? { osHomedir: deps.osHomedir } : {}),
    ...(readFs !== undefined ? { fs: readFs } : {}),
  });
  let resolved: import("@orca-pi/core").ResolvedPiProfile;
  try {
    resolved = core.resolveProfile(name, merged);
  } catch (error) {
    const err = new Error(error instanceof Error ? error.message : String(error)) as Error & { code?: string };
    err.code = "not-found";
    throw err;
  }
  // Reuse the existing JEF-7 launch compiler — never build argv in the bridge.
  const launch = await core.buildPiLaunch(resolved, { projectRoot, cwd: projectRoot });
  const preview = core.formatPiInspect(resolved, launch, { showFullPrompt });
  const sanitized = core.sanitizeLaunchPreviewForDisplay(
    {
      preview,
      spec: launch.spec,
      promptSource: launch.promptSource,
      ...(launch.promptFileRelativePath !== undefined ? { promptFileRelativePath: launch.promptFileRelativePath } : {}),
      ...(launch.promptFileAbsolutePath !== undefined ? { promptFileAbsolutePath: launch.promptFileAbsolutePath } : {}),
      promptTransport: launch.promptTransport,
      ...(launch.promptTempPath !== undefined ? { promptTempPath: launch.promptTempPath } : {}),
      ...(launch.promptText !== undefined ? { promptText: launch.promptText } : {}),
    },
    { showFullPrompt },
  );
  return { profile: name, resolved, launch: sanitized, displayOnly: true };
}

async function orchestrationGetResult(request: BridgeRequest, deps: BridgeHostDeps): Promise<unknown> {
  const core = await import("@orca-pi/core");
  const projectRoot = defaultProjectRoot(deps, request);
  const readFs = asCoreReadFs(deps.fs);
  const merged = await core
    .loadMergedProfiles({
      projectRoot,
      ...(deps.env !== undefined ? { env: deps.env } : {}),
      ...(deps.homedir !== undefined ? { homedir: deps.homedir } : {}),
      ...(deps.osHomedir !== undefined ? { osHomedir: deps.osHomedir } : {}),
      ...(readFs !== undefined ? { fs: readFs } : {}),
    })
    .catch(() => undefined);
  let knownProfiles: readonly string[] | undefined;
  if (merged) {
    try {
      knownProfiles = core.listProfileNames(merged);
    } catch {
      knownProfiles = undefined;
    }
  }
  const mapping = await core.getRoleMapping({
    ...baseOrchestrationOptions(deps, projectRoot),
    ...(knownProfiles !== undefined ? { knownProfiles } : {}),
  });
  return { ...mapping, ownership: "Orca owns task/DAG/worktree/run lifecycle; this mapping owns only role→profile policy." };
}

async function orchestrationSetResult(request: BridgeRequest, deps: BridgeHostDeps): Promise<unknown> {
  const params = asParams(request.params, request.requestId);
  const role = requireString(params["role"], "params.role");
  const scope = params["scope"];
  if (scope !== "user" && scope !== "project") {
    const err = new Error(
      `orchestration.set requires explicit params.scope "user" or "project" (got ${JSON.stringify(scope)}).`,
    ) as Error & { code?: string };
    err.code = "missing-scope";
    throw err;
  }
  if (request.worktree?.projectRoot === undefined) {
    const err = new Error(`orchestration.set requires explicit worktree.projectRoot (race-safe scoping).`) as Error & {
      code?: string;
    };
    err.code = "missing-scope";
    throw err;
  }
  const core = await import("@orca-pi/core");
  const projectRoot = request.worktree.projectRoot;
  const base = baseOrchestrationOptions(deps, projectRoot);
  const withHash = withExpectedHash(base, params) as import("@orca-pi/core").OrchestrationWriteOptions;
  if (params["clear"] === true) {
    return await core.deleteRoleOverride({ role, scope: scope as OrchestrationScope }, withHash);
  }
  const profile = requireString(params["profile"], "params.profile");
  return await core.setRoleMapping({ role, profile, scope: scope as OrchestrationScope }, withHash);
}

async function githubStatusResult(request: BridgeRequest, deps: BridgeHostDeps): Promise<unknown> {
  const core = await import("@orca-pi/core");
  const params = asParams(request.params, request.requestId);
  const identity = params["identity"] !== undefined ? requireString(params["identity"], "params.identity") : undefined;
  const profile = params["profile"] !== undefined ? requireString(params["profile"], "params.profile") : undefined;
  if (identity !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(identity)) {
    throw profileValidationError(`github.status params.identity must be a portable identity name (got ${JSON.stringify(identity)}).`);
  }
  // Redacted credential status only — never tokens/keys. Reuse the
  // read-only production status path (env → disk cache, no mint).
  const cache = core.createInstallationTokenCache();
  const identities = identity !== undefined ? [identity] : ["worker", "reviewer"];
  const out: Record<string, unknown> = {};
  for (const id of identities) {
    const status = await core.describeProductionCredentialStatus(id, {
      env: deps.env ?? process.env,
      cache,
      ...(deps.providerFs !== undefined ? { providerFs: deps.providerFs } : {}),
      ...(deps.homedir !== undefined ? { homedir: deps.homedir } : {}),
      ...(deps.osHomedir !== undefined ? { osHomedir: deps.osHomedir } : {}),
    });
    out[id] = status;
  }
  const result = {
    identities: out,
    ...(profile !== undefined ? { profile } : {}),
    redacted: true,
    note: "Redacted status only — no token/private key is ever returned to the panel. Mint/refresh happens outside the panel via `orca-pi github mint`.",
  };
  assertNoSecrets(result, "github.status");
  return result;
}

async function githubDoctorResult(request: BridgeRequest, deps: BridgeHostDeps): Promise<unknown> {
  const core = await import("@orca-pi/core");
  const params = asParams(request.params, request.requestId);
  let repo: { owner: string; repo: string } | undefined;
  const rawRepo = params["repo"];
  if (typeof rawRepo === "string" && rawRepo.trim().length > 0) {
    const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(rawRepo.trim());
    if (!match) throw profileValidationError(`github.doctor params.repo must be "owner/repo" (got ${JSON.stringify(rawRepo)}).`);
    repo = { owner: match[1]!, repo: match[2]! };
  } else if (isRecord(rawRepo)) {
    const owner = (rawRepo as Record<string, unknown>)["owner"];
    const name = (rawRepo as Record<string, unknown>)["repo"];
    if (typeof owner !== "string" || typeof name !== "string") {
      throw profileValidationError(`github.doctor params.repo must be "owner/repo" or {owner, repo}.`);
    }
    repo = { owner, repo: name };
  }
  const ambient = params["ambient"] !== undefined ? requireString(params["ambient"], "params.ambient") : undefined;
  const report: GithubDoctorReport = await core.doctorGithubIdentities({
    env: deps.env ?? process.env,
    ...(deps.fetchFn !== undefined ? { fetchFn: deps.fetchFn } : {}),
    ...(repo !== undefined ? { repo } : {}),
    ...(ambient !== undefined ? { ambientLogin: ambient } : {}),
    ...(deps.providerFs !== undefined ? { providerFs: deps.providerFs } : {}),
    ...(deps.homedir !== undefined ? { homedir: deps.homedir } : {}),
    ...(deps.osHomedir !== undefined ? { osHomedir: deps.osHomedir } : {}),
  });
  assertNoSecrets(report, "github.doctor");
  return { ...report, redacted: true };
}

async function diagnosticsDoctorResult(request: BridgeRequest, deps: BridgeHostDeps): Promise<unknown> {
  const core = await import("@orca-pi/core");
  const secrets = core.collectSecretsFromEnv(deps.env ?? process.env);
  let cli: DoctorReport | string | undefined;
  if (deps.runner) {
    try {
      const raw = await core.doctor(deps.runner);
      cli = sanitizeDoctorReportForBridge(raw, secrets);
    } catch (error) {
      // The runner itself threw (not a normal probe detail): core rethrows
      // non-ENOENT runner failures, and the generic bridge error path
      // would return `error.message` verbatim. Collapse to a sanitized
      // degraded note instead so secret-bearing throw text can never
      // cross the bridge via the error response (or reach the DOM
      // through the panel's error rendering). Actionable non-secret text
      // survives redaction/bounding; the CLI fallback stays explicit.
      const detail = sanitizeDiagnosticsDetail(
        error instanceof Error ? error.message : String(error),
        DIAGNOSTICS_DETAIL_LIMIT,
        secrets,
      );
      cli = `(CLI probes failed: ${detail} — run \`orca-pi doctor\` for live orca/pi versions)`;
    }
  }
  const negotiation = negotiateBridgeCapabilities(deps.hostInfo);
  const host = collectDiagnosticsHost(deps, negotiation);
  const runtime = collectDiagnosticsRuntime(deps);
  const transport = deps.transport ?? "seam";
  const result = {
    orcaPiVersion: core.ORCA_PI_VERSION,
    bridgeVersion: BRIDGE_VERSION,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    ...(cli !== undefined ? { cli } : { cli: "(no runner injected — CLI probes unavailable; run `orca-pi doctor` for live orca/pi versions)" }),
    bridge: negotiation,
    host,
    runtime,
    transport: { mode: transport },
    target: { appVersion: "1.4.196+", pluginApi: 1, upstreamCommit: "9aa0f7e77d366c23a3cc8de2da32ae550d397dc0" },
  };
  assertNoSecrets(result, "diagnostics.doctor");
  return result;
}

/**
 * Collect allowlisted host context for `diagnostics.doctor` (never throws,
 * never secrets). Host-reported Orca app version / pluginApi degrade to
 * unknown when absent (never synthesized from `target` desired versions),
 * and granted capabilities are allowlisted to the closed Host capability
 * set so a compromised host cannot smuggle arbitrary strings to the DOM.
 */
function collectDiagnosticsHost(
  deps: BridgeHostDeps,
  negotiation: { versionsOk: boolean; consentOk: boolean; seamHandshake: boolean; structured: boolean },
): Record<string, unknown> {
  const info = deps.hostInfo;
  const out: Record<string, unknown> = {
    versionsOk: negotiation.versionsOk === true,
    consentOk: negotiation.consentOk === true,
    seamHandshake: negotiation.seamHandshake === true,
    structured: negotiation.structured === true,
  };
  if (typeof info?.appVersion === "string") {
    // eslint-disable-next-line no-control-regex
    const trimmed = info.appVersion.trim().slice(0, 64).replace(/[\0-\x1f\x7f]/g, "");
    if (/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(trimmed)) out["appVersion"] = trimmed;
  }
  if (typeof info?.pluginApi === "number" && Number.isInteger(info.pluginApi) && info.pluginApi >= 0 && info.pluginApi <= 999) {
    out["pluginApi"] = info.pluginApi;
  }
  if (Array.isArray(info?.grantedCapabilities)) {
    const allowlisted = (info.grantedCapabilities as unknown[])
      .filter((c): c is string =>
        typeof c === "string" &&
        ( ["workspace:read", "terminal:send", "notifications:show", "storage", "secrets", "events:subscribe", "settings:own"] as readonly string[] ).includes(c),
      )
      .slice(0, 16);
    out["grantedCapabilities"] = allowlisted;
  } else if (info !== undefined) {
    out["grantedCapabilities"] = [];
  }
  return out;
}

/**
 * Collect allowlisted OS/runtime context for `diagnostics.doctor` (never
 * throws, never secrets). Node/platform/arch come from injected
 * `runtimeInfo` (tests) or `process.*` (prod), bounded to 32 chars and
 * restricted to token shapes. WSL is derived from `WSL_DISTRO_NAME` /
 * `WSL_INTEROP` presence only (distro name sanitized, never raw env
 * dumps) with truthful native/unknown states.
 */
function collectDiagnosticsRuntime(deps: BridgeHostDeps): Record<string, unknown> {
  const env = deps.env ?? process.env;
  const injected = deps.runtimeInfo;
  const rawNode = injected?.nodeVersion ?? (typeof process.version === "string" ? process.version : undefined);
  const rawPlatform = injected?.platform ?? (typeof process.platform === "string" ? process.platform : undefined);
  const rawArch = injected?.arch ?? (typeof process.arch === "string" ? process.arch : undefined);
  const out: Record<string, unknown> = {};
  const asToken = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    // eslint-disable-next-line no-control-regex
    const trimmed = value.trim().slice(0, 32).replace(/[\0-\x1f\x7f]/g, "");
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/.test(trimmed)) return undefined;
    return trimmed;
  };
  const node = asToken(rawNode);
  const platform = asToken(rawPlatform);
  const arch = asToken(rawArch);
  if (node !== undefined) out["node"] = node;
  if (platform !== undefined) out["platform"] = platform;
  if (arch !== undefined) out["arch"] = arch;
  const rawWsl = injected?.wsl;
  const wslPattern = /^(native|unknown|wsl-unknown-distro|wsl:[A-Za-z0-9._-]+)$/;
  if (typeof rawWsl === "string" && wslPattern.test(rawWsl.trim().slice(0, 64))) {
    out["wsl"] = rawWsl.trim().slice(0, 64);
  } else {
    out["wsl"] = detectWslContext(env, platform);
  }
  return out;
}

function detectWslContext(env: NodeJS.ProcessEnv | Record<string, string | undefined>, platform: string | undefined): string {
  if (platform === undefined) return "unknown";
  if (platform !== "linux") return "native";
  const distroRaw = typeof env["WSL_DISTRO_NAME"] === "string" ? (env["WSL_DISTRO_NAME"] as string).trim().slice(0, 64) : "";
  const distro = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(distroRaw) ? distroRaw : undefined;
  if (distro) return `wsl:${distro}`;
  const hasInterop = typeof env["WSL_INTEROP"] === "string" && (env["WSL_INTEROP"] as string).length > 0;
  if (hasInterop) return "wsl-unknown-distro";
  // A bare WSL_DISTRO_NAME that failed sanitization still signals WSL.
  if (typeof env["WSL_DISTRO_NAME"] === "string" && (env["WSL_DISTRO_NAME"] as string).trim().length > 0) return "wsl-unknown-distro";
  return "native";
}

/**
 * Sanitize a core DoctorReport before it crosses the bridge (P1).
 *
 * `core.doctor` embeds arbitrary orca/pi runner stdout/stderr in
 * `detail`; a CLI/helper echoing a GitHub token or private key would
 * otherwise reach the panel DOM. Each detail is redacted (explicit env
 * secrets + token/key patterns) and bounded to
 * `DIAGNOSTICS_DETAIL_LIMIT` chars; only allowlisted fields
 * (`executable`/`found`/`version`/`detail`/`ok`) survive. Actionable
 * non-secret diagnostics (found/version/hints) are preserved.
 */
function sanitizeDoctorReportForBridge(report: DoctorReport, secrets: readonly string[] = []): DoctorReport {
  const sanitizeCheck = (check: DoctorCheck): DoctorCheck => ({
    executable: check.executable,
    found: check.found === true,
    ...(typeof check.version === "string" && check.version.length > 0 ? { version: check.version.slice(0, 64) } : {}),
    detail: sanitizeDiagnosticsDetail(check.detail, DIAGNOSTICS_DETAIL_LIMIT, secrets),
  });
  return {
    orca: sanitizeCheck(report.orca),
    pi: sanitizeCheck(report.pi),
    ok: report.ok === true,
  };
}

// ---------------------------------------------------------------------------
// Param helpers
// ---------------------------------------------------------------------------

function asParams(params: unknown, requestId: string): Record<string, unknown> {
  void requestId;
  if (params === undefined) return {};
  if (!isRecord(params)) {
    throw profileValidationError(`params must be an object when present (got ${typeof params}).`);
  }
  return params as Record<string, unknown>;
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw profileValidationError(`${what} must be a non-empty string (got ${JSON.stringify(value)}).`);
  }
  return value;
}

function requireObject(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw profileValidationError(`${what} must be an object (got ${typeof value === "string" ? value.slice(0, 80) : typeof value}). Profiles must never contain secrets/API keys.`);
  }
  return value as Record<string, unknown>;
}

function profileValidationError(message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = "validation-failed";
  return err;
}

function withExpectedHash<T extends object>(
  base: T,
  params: Record<string, unknown>,
): T & { expectedSourceHash?: string | null } {
  const raw = params["expectedSourceHash"] ?? params["expectedHash"] ?? params["ifMatch"];
  if (raw === undefined || raw === null) {
    if (params["expectedAbsent"] === true) return { ...base, expectedSourceHash: null };
    return base;
  }
  if (typeof raw !== "string" || !/^[0-9a-f]{64}$/i.test(raw)) {
    throw profileValidationError(`params.expectedSourceHash must be a SHA-256 hex string or null (with expectedAbsent:true for absent).`);
  }
  return { ...base, expectedSourceHash: raw.toLowerCase() };
}

export type { BridgeErrorCode, BridgeRequest, BridgeResponse };

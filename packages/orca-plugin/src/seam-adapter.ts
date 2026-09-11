/**
 * Seam-harness adapter (UI1.2, round-4).
 *
 * Harness-side piece that connects an Orca host to the versioned bridge
 * without trusting panel input:
 *
 * ```text
 * sandboxed panel
 *   ↕ postMessage (host panel bridge: workspace.readContext etc.)
 * Orca fork: panel loader + seam harness
 *   - injects window.__ORCA_PI_BRIDGE__.request (see injection contract
 *     in docs/ORCA_PLUGIN_API.md; implemented fork-side, specified here)
 *   - forwards each panel request through THIS adapter
 *       ↕ spawn: `orca-pi bridge --transport seam ...`
 * Orca-Pi bridge host (bridge-host.ts, transport "seam")
 *   ↕
 * authoritative config services
 * ```
 *
 * The adapter host-provisions scope and consent on every call:
 * - `worktree.projectRoot` is STAMPED from the harness-authorized root,
 *   overwriting anything the panel supplied (panels cannot select scope;
 *   `workspace.readContext` carries no filesystem path).
 * - Host facts (app version, pluginApi, granted capabilities) are supplied
 *   by the harness via `--host-app-version` / `--host-plugin-api` /
 *   `--granted-capability`, so missing consent blocks reads and mutations
 *   at the dispatcher (`auth/setup`) instead of executing.
 *
 * Harness-side Node only (the fork's panel host): it spawns the sidecar,
 * so it must never run in the sandboxed panel or the plugin worker. The
 * spawn function is injectable for tests; the default uses
 * `node:child_process` with a bounded timeout and buffer.
 */

import {
  BRIDGE_PROTOCOL_VERSION,
  parseBridgeRequest,
  type BridgeOperation,
  type BridgeResponse,
} from "./bridge.js";

export interface SeamHostFacts {
  appVersion?: string;
  pluginApi?: number;
  grantedCapabilities?: readonly string[];
}

export interface SeamAdapterOptions {
  /**
   * Harness-authorized absolute project root (authoritative scope).
   * Stamped onto every forwarded request; panel-supplied roots never
   * survive. Must be absolute (POSIX, drive-letter, or UNC/WSL).
   */
  projectRoot: string;
  /** orca-pi binary (default `"orca-pi"` on PATH; harness may pass absolute). */
  orcaPiBin?: string;
  /**
   * Host-reported facts forwarded with every request (absent = unknown =
   * degraded). Accepts a **provider function** (preferred: resolved fresh
   * on every forwarded request so consent revocation takes effect
   * immediately) or a static snapshot object. The audited Orca panel
   * bridge re-checks capabilities in main for every action; a static
   * snapshot would keep forwarding stale grants after revocation.
   */
  hostFacts?: SeamHostFacts | (() => SeamHostFacts);
  /** Injectable spawn (tests); defaults to bounded `execFile`. */
  spawn?: (
    bin: string,
    args: readonly string[],
  ) => Promise<{ stdout: string; stderr: string; code: number }>;
  /** Spawn timeout in ms (default 30_000). */
  timeoutMs?: number;
}

export interface SeamAdapter {
  /** Forward `bridge.capabilities` (what this transport will permit). */
  capabilities(requestId?: string): Promise<BridgeResponse>;
  /**
   * Validate, stamp host scope, and forward one panel request.
   * Never throws: transport failures become `ok: false` (`internal`).
   */
  forward(data: unknown): Promise<BridgeResponse>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;

async function defaultSpawn(
  bin: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const runFile = promisify(execFile);
  try {
    const out = await runFile(bin, [...args], { timeout: timeoutMs, maxBuffer: DEFAULT_MAX_BUFFER });
    return { stdout: String(out.stdout ?? ""), stderr: String(out.stderr ?? ""), code: 0 };
  } catch (error) {
    const execError = error as { stdout?: unknown; stderr?: unknown; code?: unknown; killed?: unknown };
    return {
      stdout: typeof execError.stdout === "string" ? execError.stdout : "",
      stderr: typeof execError.stderr === "string" ? execError.stderr : String(error).slice(0, 2000),
      code: typeof execError.code === "number" ? execError.code : 1,
    };
  }
}

function internalError(requestId: string, message: string): BridgeResponse {
  return {
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    requestId,
    ok: false,
    error: { code: "internal", message },
  };
}

/**
 * Create a seam adapter. The harness creates one per authorized worktree
 * (bound to its absolute root) and exposes `forward` as
 * `window.__ORCA_PI_BRIDGE__.request` inside approved panels only.
 */
export function createSeamAdapter(options: SeamAdapterOptions): SeamAdapter {
  const bin = options.orcaPiBin ?? "orca-pi";
  const root = options.projectRoot;
  const resolveFacts = (): SeamHostFacts =>
    typeof options.hostFacts === "function" ? options.hostFacts() : (options.hostFacts ?? {});
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawn = options.spawn ?? ((b, a) => defaultSpawn(b, a, timeoutMs));

  async function invoke(stamped: Record<string, unknown>, facts: SeamHostFacts): Promise<BridgeResponse> {
    const requestId = typeof stamped["requestId"] === "string" ? (stamped["requestId"] as string) : "unknown";
    const args: string[] = [
      "bridge",
      "--request",
      JSON.stringify(stamped),
      "--transport",
      "seam",
      "--project-root",
      root,
    ];
    if (facts.appVersion !== undefined) args.push("--host-app-version", facts.appVersion);
    if (facts.pluginApi !== undefined) args.push("--host-plugin-api", String(facts.pluginApi));
    for (const capability of facts.grantedCapabilities ?? []) {
      args.push("--granted-capability", capability);
    }
    args.push("--json");
    let result: { stdout: string; stderr: string; code: number };
    try {
      result = await spawn(bin, args);
    } catch (error) {
      return internalError(requestId, `Seam adapter could not invoke the orca-pi sidecar: ${error instanceof Error ? error.message : String(error)}.`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      const hint = result.stderr.trim().slice(0, 500);
      return internalError(
        requestId,
        `Seam adapter received a non-JSON sidecar response (exit ${result.code})${hint ? `: ${hint}` : "."} No data was trusted.`,
      );
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      (parsed as { requestId?: unknown }).requestId !== requestId
    ) {
      return internalError(requestId, "Seam adapter rejected a sidecar response with a mismatched requestId. No data was trusted.");
    }
    return parsed as BridgeResponse;
  }

  return {
    async capabilities(requestId = "seam-capabilities-1"): Promise<BridgeResponse> {
      return await invoke(
        {
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          requestId,
          operation: "bridge.capabilities" satisfies BridgeOperation,
        },
        resolveFacts(),
      );
    },
    async forward(data: unknown): Promise<BridgeResponse> {
      // Stamp the host-owned scope BEFORE full BridgeRequest validation:
      // panels cannot know filesystem paths (workspace.readContext
      // exposes none), so a correctly-designed panel mutation omits
      // `worktree` entirely — and `parseBridgeRequest` requires an
      // absolute root for writes. Validating the unstamped panel input
      // first would reject exactly the requests the adapter exists to
      // complete. The spread below is the only pre-validation needed to
      // copy the envelope safely; non-objects fall through to
      // `parseBridgeRequest` for the proper validation error.
      const candidate =
        data !== null && typeof data === "object" && !Array.isArray(data)
          ? { ...(data as Record<string, unknown>), worktree: { projectRoot: root } }
          : data;
      const parsed = parseBridgeRequest(candidate);
      if (!parsed.ok) {
        return {
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          requestId: parsed.requestId,
          ok: false,
          error: parsed.error,
        };
      }
      // Host-provisioned scope: any panel-supplied worktree claim was
      // already replaced wholesale above — panels never select the
      // filesystem scope (a panel-provided worktreeId/terminalId is
      // dropped with it; the harness re-attaches host-known terminal
      // identity when needed).
      const stamped: Record<string, unknown> = {
        ...(parsed.request as unknown as Record<string, unknown>),
        worktree: { projectRoot: root },
      };
      return await invoke(stamped, resolveFacts());
    },
  };
}

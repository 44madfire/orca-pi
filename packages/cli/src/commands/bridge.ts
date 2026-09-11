/**
 * `orca-pi bridge` CLI sidecar (UI1.2).
 *
 * The actual current transport for the versioned panel↔bridge protocol:
 * the seam harness (or an operator) invokes one bridge request per CLI
 * call and receives a versioned `BridgeResponse` with a stable request ID
 * and a machine-readable error code. The invocation itself is the seam
 * handshake, so `bridge.capabilities` reached this way reports
 * `seamAvailable: true`; host facts the sidecar cannot observe (Orca app
 * version, pluginApi, granted capabilities) stay unknown unless the caller
 * passes `--host-app-version` / `--host-plugin-api` /
 * `--granted-capability` explicitly (fail-closed when omitted).
 *
 * ```text
 * orca-pi bridge --request '<json|@file>' [--project-root <path>]
 *   [--host-app-version <x.y.z>] [--host-plugin-api <n>]
 *   [--granted-capability <kind> ...] [--json]
 * ```
 *
 * `--request` is a single `BridgeRequest` object (inline JSON or `@file`).
 * `--json` prints the full `BridgeResponse`; human output prints a
 * one-line status plus pretty result. Exit codes: 0 for `ok: true`, 1 for
 * `ok: false` (bridge error), 2 for usage errors. This module never builds
 * Pi argv and never exposes secrets — GitHub ops stay redacted.
 */

import { handleBridgeRequest } from "@orca-pi/orca-plugin";

export interface BridgeCommandDeps {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  projectRoot: string;
  runner: import("@orca-pi/core").ProcessRunner;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  osHomedir?: () => string;
  fs?: Pick<typeof import("node:fs/promises"), "readFile" | "stat"> & Partial<
    Pick<typeof import("node:fs/promises"), "writeFile" | "rename" | "mkdir" | "unlink" | "readdir">
  >;
  fetchFn?: import("@orca-pi/core").GithubFetchFn;
  providerFs?: import("@orca-pi/core").CredentialProviderFs;
}

export interface BridgeCommandResult {
  exitCode: number;
}

export const BRIDGE_USAGE =
  "usage: orca-pi bridge --request '<json|@file>' [--project-root <path>] [--host-app-version <x.y.z>] [--host-plugin-api <n>] [--granted-capability <kind> ...] [--json]\n";

function isHelpFlag(arg: string): boolean {
  return arg === "--help" || arg === "-h" || arg === "help";
}

function takeValue(args: readonly string[], index: number, flag: string): { value?: string; consumed: number; error?: string } {
  const current = args[index] as string;
  const eq = `${flag}=`;
  if (current.startsWith(eq)) {
    const value = current.slice(eq.length);
    if (!value) return { consumed: 1, error: `${flag} requires a value` };
    return { value, consumed: 1 };
  }
  const next = args[index + 1];
  if (next === undefined || next.startsWith("-")) return { consumed: 1, error: `${flag} requires a value` };
  return { value: next, consumed: 2 };
}

async function readPayload(raw: string, deps: BridgeCommandDeps): Promise<string> {
  if (!raw.startsWith("@")) return raw;
  const filePath = raw.slice(1);
  if (!filePath) throw new Error(`Invalid payload ${JSON.stringify(raw)}: expected @<file> with a path.`);
  const readFile = deps.fs?.readFile as unknown as
    | ((path: string, encoding: "utf8") => Promise<string>)
    | undefined;
  if (readFile) return await readFile(filePath, "utf8");
  const fs = await import("node:fs/promises");
  return (await fs.readFile(filePath, "utf8")) as string;
}

function asBridgeFs(
  fs: BridgeCommandDeps["fs"],
): import("@orca-pi/core").MutationFs | undefined {
  if (!fs) return undefined;
  const out: Record<string, unknown> = {};
  if (typeof fs.readFile === "function") out["readFile"] = fs.readFile;
  if (typeof (fs as Record<string, unknown>)["writeFile"] === "function") {
    out["writeFile"] = (fs as Record<string, unknown>)["writeFile"];
  }
  if (typeof (fs as Record<string, unknown>)["rename"] === "function") {
    out["rename"] = (fs as Record<string, unknown>)["rename"];
  }
  if (typeof (fs as Record<string, unknown>)["mkdir"] === "function") {
    out["mkdir"] = (fs as Record<string, unknown>)["mkdir"];
  }
  if (typeof fs.stat === "function") out["stat"] = fs.stat;
  if (typeof (fs as Record<string, unknown>)["unlink"] === "function") {
    out["unlink"] = (fs as Record<string, unknown>)["unlink"];
  }
  if (typeof (fs as Record<string, unknown>)["readdir"] === "function") {
    out["readdir"] = (fs as Record<string, unknown>)["readdir"];
  }
  if (Object.keys(out).length === 0) return undefined;
  return out as unknown as import("@orca-pi/core").MutationFs;
}

export async function runBridgeCommand(
  args: readonly string[],
  deps: BridgeCommandDeps,
): Promise<BridgeCommandResult> {
  let requestRaw: string | undefined;
  let projectRoot: string | undefined;
  let hostAppVersion: string | undefined;
  let hostPluginApi: number | undefined;
  const grantedCapabilities: string[] = [];
  let asJson = false;
  const unknown: string[] = [];
  let help = false;

  for (let index = 0; index < args.length; ) {
    const arg = args[index] as string;
    if (arg === "--json") {
      asJson = true;
      index += 1;
    } else if (arg === "--request" || arg.startsWith("--request=")) {
      const taken = takeValue(args, index, "--request");
      if (taken.error) unknown.push(taken.error);
      else requestRaw = taken.value;
      index += taken.consumed;
    } else if (arg === "--project-root" || arg.startsWith("--project-root=")) {
      const taken = takeValue(args, index, "--project-root");
      if (taken.error) unknown.push(taken.error);
      else projectRoot = taken.value;
      index += taken.consumed;
    } else if (arg === "--host-app-version" || arg.startsWith("--host-app-version=")) {
      const taken = takeValue(args, index, "--host-app-version");
      if (taken.error) unknown.push(taken.error);
      else hostAppVersion = taken.value;
      index += taken.consumed;
    } else if (arg === "--host-plugin-api" || arg.startsWith("--host-plugin-api=")) {
      const taken = takeValue(args, index, "--host-plugin-api");
      if (taken.error) unknown.push(taken.error);
      else if (taken.value !== undefined) {
        const parsed = Number(taken.value);
        if (!Number.isInteger(parsed)) unknown.push("--host-plugin-api must be an integer");
        else hostPluginApi = parsed;
      }
      index += taken.consumed;
    } else if (arg === "--granted-capability" || arg.startsWith("--granted-capability=")) {
      const taken = takeValue(args, index, "--granted-capability");
      if (taken.error) unknown.push(taken.error);
      else if (taken.value !== undefined) {
        for (const part of taken.value.split(",")) {
          const trimmed = part.trim();
          if (trimmed) grantedCapabilities.push(trimmed);
        }
      }
      index += taken.consumed;
    } else if (isHelpFlag(arg)) {
      help = true;
      index += 1;
    } else if (arg.startsWith("--")) {
      unknown.push(arg);
      index += 1;
    } else {
      unknown.push(arg);
      index += 1;
    }
  }

  if (help) {
    deps.stdout(BRIDGE_USAGE);
    return { exitCode: 0 };
  }
  if (unknown.length > 0) {
    deps.stderr(`error: unknown bridge option(s): ${unknown.join(", ")}\n`);
    deps.stderr(BRIDGE_USAGE);
    return { exitCode: 2 };
  }
  if (requestRaw === undefined) {
    deps.stderr(`error: orca-pi bridge requires --request '<json|@file>'.\n`);
    deps.stderr(BRIDGE_USAGE);
    return { exitCode: 2 };
  }

  let requestText: string;
  try {
    requestText = await readPayload(requestRaw, deps);
  } catch (error) {
    deps.stderr(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return { exitCode: 2 };
  }
  let request: unknown;
  try {
    request = JSON.parse(requestText);
  } catch (error) {
    deps.stderr(
      `error: --request must be a JSON BridgeRequest object: ${error instanceof Error ? error.message : String(error)}.\n`,
    );
    return { exitCode: 2 };
  }

  const effectiveProjectRoot =
    projectRoot !== undefined && projectRoot.length > 0 ? projectRoot : deps.projectRoot;
  const bridgeFs = asBridgeFs(deps.fs);
  const response = await handleBridgeRequest(request, {
    projectRoot: effectiveProjectRoot,
    ...(deps.env !== undefined ? { env: deps.env } : {}),
    ...(deps.homedir !== undefined ? { homedir: deps.homedir } : {}),
    ...(deps.osHomedir !== undefined ? { osHomedir: deps.osHomedir } : {}),
    ...(bridgeFs !== undefined ? { fs: bridgeFs, orchestrationFs: bridgeFs } : {}),
    ...(deps.fetchFn !== undefined ? { fetchFn: deps.fetchFn } : {}),
    ...(deps.runner !== undefined ? { runner: deps.runner } : {}),
    ...(deps.providerFs !== undefined ? { providerFs: deps.providerFs } : {}),
    hostInfo: {
      ...(hostAppVersion !== undefined ? { appVersion: hostAppVersion } : {}),
      ...(hostPluginApi !== undefined ? { pluginApi: hostPluginApi } : {}),
      ...(grantedCapabilities.length > 0 ? { grantedCapabilities } : {}),
      // The sidecar invocation itself proves the transport: this request
      // reached the bridge host, so the seam handshake holds here.
      seamAvailable: true,
    },
  });

  if (asJson) {
    deps.stdout(`${JSON.stringify(response, null, 2)}\n`);
  } else if (response.ok) {
    const operation =
      request !== null && typeof request === "object" && "operation" in request
        ? String((request as { operation: unknown }).operation)
        : "bridge";
    deps.stdout(`bridge ${operation}: ok (${response.requestId})\n${JSON.stringify(response.result, null, 2)}\n`);
  } else {
    deps.stderr(`bridge: ${response.error.code}: ${response.error.message}\n`);
  }
  return { exitCode: response.ok ? 0 : 1 };
}

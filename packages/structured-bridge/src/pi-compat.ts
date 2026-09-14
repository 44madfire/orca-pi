/**
 * Pi structured compatibility + capability gates (SNC1.10, orca-pi owned).
 *
 * Deterministic, credential-free, process-free gating for the native and
 * bridge Pi paths. This module spawns nothing, reads no config, and takes
 * no credentials: it is pure version/location/capability logic so CI can
 * exercise every gate without a Pi binary, and Orca can fail closed to the
 * ordinary Pi TUI path with an actionable reason.
 *
 * Gating preference (per issue #20): capability probing over brittle
 * version checks. The version gate below is a coarse floor only
 * (`MIN_KNOWN_GOOD_PI_VERSION`, the single version with live-captured
 * fixture evidence); per-feature support is decided by probing live Pi
 * RPCs (`get_available_models`, `get_available_thinking_levels`,
 * `get_entries`/`leafId`) and advertised bridge capabilities, never by
 * parsing a version string alone.
 *
 * Platform honesty: live fixtures (`packages/pi-rpc/fixtures/*`) were
 * captured on `win32` against Pi `0.85.1` only. Local-host structured Pi
 * is therefore *proven* on win32; darwin/linux local hosts are
 * expected-compatible (same `pi --mode rpc` stdio transport, no
 * platform-specific code on this path) but explicitly unproven in this
 * repository. WSL, remote/SSH, mobile, and paired execution locations
 * are unsupported without lifecycle/filesystem/capability evidence and
 * fail closed to Pi TUI. Nothing here claims them.
 *
 * No shell strings, no argv construction, no process execution: public
 * APIs take and return plain data. Transport construction stays in
 * `pi-provider.ts` (`resolvePiSpec` + `toPiRpcProcessSpec`, argv arrays
 * only, never a shell string).
 */

/** Structured fallback target when gates refuse: the ordinary Pi TUI. */
export const PI_TUI_FALLBACK = "pi-tui" as const;

/**
 * Minimum known-good Pi version: the only version with live-captured
 * RPC fixture evidence (`packages/pi-rpc/fixtures/baseline.json`).
 */
export const MIN_KNOWN_GOOD_PI_VERSION = "0.85.1" as const;

/** Bridge protocol version this provider speaks (mirrors `protocol.ts`). */
export const PI_RPC_PROTOCOL_VERSION = 1 as const;

export interface PiVersionSupport {
  /** True when structured Pi may proceed (subject to capability probing). */
  readonly supported: boolean;
  /** Machine-readable reason (safe for logs/toasts; no paths/secrets). */
  readonly reason: string;
  /** Fallback target when `supported === false` (always Pi TUI). */
  readonly fallback: typeof PI_TUI_FALLBACK;
}

/** Parse `major.minor.patch` (leading `v`/whitespace tolerated). */
export function parsePiVersion(raw: string): { major: number; minor: number; patch: number } | null {
  if (typeof raw !== "string") return null;
  const match = raw.trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) return null;
  return { major, minor, patch };
}

/** Compare two parsed versions: negative / zero / positive. */
export function comparePiVersions(
  a: { major: number; minor: number; patch: number },
  b: { major: number; minor: number; patch: number },
): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

/**
 * Coarse version floor for structured Pi. Newer versions pass with a
 * "probe-capabilities" note (probing, not the version string, decides
 * per-feature support); older or unparseable versions fail closed to
 * Pi TUI with an actionable reason.
 */
export function checkPiVersionSupport(rawVersion: string): PiVersionSupport {
  const parsed = parsePiVersion(rawVersion);
  if (!parsed) {
    return {
      supported: false,
      reason: `unsupported-pi-version: unparseable version (minimum known-good ${MIN_KNOWN_GOOD_PI_VERSION})`,
      fallback: PI_TUI_FALLBACK,
    };
  }
  const floor = parsePiVersion(MIN_KNOWN_GOOD_PI_VERSION);
  if (!floor) {
    return { supported: false, reason: "unsupported-pi-version: internal version floor misconfigured", fallback: PI_TUI_FALLBACK };
  }
  if (comparePiVersions(parsed, floor) < 0) {
    return {
      supported: false,
      reason: `unsupported-pi-version: ${parsed.major}.${parsed.minor}.${parsed.patch} < minimum known-good ${MIN_KNOWN_GOOD_PI_VERSION} (update Pi or use Pi TUI)`,
      fallback: PI_TUI_FALLBACK,
    };
  }
  return {
    supported: true,
    reason: `pi-version-ok: ${parsed.major}.${parsed.minor}.${parsed.patch} >= ${MIN_KNOWN_GOOD_PI_VERSION} (confirm per-feature support by capability probing)`,
    fallback: PI_TUI_FALLBACK,
  };
}

/** Minimal execution-location shape mirrored from Orca (no Orca import). */
export interface PiCompatLocation {
  readonly executionHostId: string;
  readonly wslDistro: string | null;
}

/** Proven local execution host id (mirrors Orca's `LOCAL_EXECUTION_HOST_ID`). */
export const PI_COMPAT_LOCAL_HOST_ID = "local" as const;

/** Agent string the Pi adapter owns (alongside Codex/Claude). */
export const PI_COMPAT_AGENT = "pi" as const;

export interface PiLocationSupport {
  readonly supported: boolean;
  readonly reason: string;
  readonly fallback: typeof PI_TUI_FALLBACK;
}

/**
 * Honest execution-location gate: only the local host (no WSL distro)
 * may create structured Pi sessions. Remote/SSH/mobile/paired hosts and
 * WSL fail closed to Pi TUI — lifecycle, filesystem, and capability
 * negotiation are unvalidated there, so no claim is made.
 */
export function checkPiLocationSupport(location: PiCompatLocation, agent: string): PiLocationSupport {
  if (agent !== PI_COMPAT_AGENT) {
    return {
      supported: false,
      reason: `agent-not-owned: ${agent} is not served by the Pi adapter (Codex/Claude selection unchanged)`,
      fallback: PI_TUI_FALLBACK,
    };
  }
  if (location.executionHostId !== PI_COMPAT_LOCAL_HOST_ID) {
    return {
      supported: false,
      reason: `unsupported-location: execution host "${location.executionHostId}" is not proven for structured Pi (local host only; use Pi TUI)`,
      fallback: PI_TUI_FALLBACK,
    };
  }
  if (location.wslDistro !== null) {
    return {
      supported: false,
      reason: `unsupported-location: WSL distro "${location.wslDistro}" is not proven for structured Pi (use Pi TUI)`,
      fallback: PI_TUI_FALLBACK,
    };
  }
  return { supported: true, reason: "location-ok: local host structured Pi", fallback: PI_TUI_FALLBACK };
}

/** Capability set probed from the live Pi provider (all optional booleans). */
export interface PiProbedCapabilities {
  readonly textStreaming?: boolean;
  readonly thinking?: boolean;
  readonly tools?: boolean;
  readonly images?: boolean;
  readonly extensionDialogs?: boolean;
  readonly history?: boolean;
  readonly options?: boolean;
  readonly cancel?: boolean;
  readonly resume?: boolean;
}

export interface PiCapabilityNegotiation {
  readonly structured: boolean;
  readonly reason: string;
  readonly fallback: typeof PI_TUI_FALLBACK;
  /** Capabilities the host must hide (no UI offered for these). */
  readonly unsupported: readonly string[];
}

/**
 * Capability probing over version checks: given the features a session
 * needs and what the live provider advertises, decide structured vs
 * TUI fallback and name exactly which capabilities the host must hide.
 * Unknown (absent) capabilities count as unsupported — the host must
 * not offer UI the provider has not proven.
 */
export function negotiatePiCapabilities(
  required: readonly string[],
  probed: PiProbedCapabilities,
): PiCapabilityNegotiation {
  const unsupported = required.filter(
    (name) => (probed as unknown as Record<string, unknown>)[name] !== true,
  );
  if (unsupported.length === 0) {
    return { structured: true, reason: "capabilities-ok: all required features probed", fallback: PI_TUI_FALLBACK, unsupported: [] };
  }
  return {
    structured: false,
    reason: `unsupported-capabilities: ${unsupported.join(",")} (use Pi TUI)`,
    fallback: PI_TUI_FALLBACK,
    unsupported,
  };
}

export interface PiStructuredGateInput {
  readonly location: PiCompatLocation;
  readonly agent: string;
  readonly piVersion: string;
  readonly requiredCapabilities?: readonly string[];
  readonly probedCapabilities?: PiProbedCapabilities;
}

export interface PiStructuredGate {
  readonly structured: boolean;
  readonly reason: string;
  readonly fallback: typeof PI_TUI_FALLBACK;
}

/**
 * Single entry point combining location, version-floor, and capability
 * gates. Location and version must pass; capability probing then
 * decides per-feature support. Every refusal names Pi TUI as the
 * fallback — structured Pi is never the only path.
 */
export function gatePiStructuredSession(input: PiStructuredGateInput): PiStructuredGate {
  const location = checkPiLocationSupport(input.location, input.agent);
  if (!location.supported) return { structured: false, reason: location.reason, fallback: PI_TUI_FALLBACK };
  const version = checkPiVersionSupport(input.piVersion);
  if (!version.supported) return { structured: false, reason: version.reason, fallback: PI_TUI_FALLBACK };
  const required = input.requiredCapabilities ?? [];
  if (required.length > 0) {
    const negotiated = negotiatePiCapabilities(required, input.probedCapabilities ?? {});
    if (!negotiated.structured) return { structured: false, reason: negotiated.reason, fallback: PI_TUI_FALLBACK };
  }
  return { structured: true, reason: `${location.reason}; ${version.reason}`, fallback: PI_TUI_FALLBACK };
}

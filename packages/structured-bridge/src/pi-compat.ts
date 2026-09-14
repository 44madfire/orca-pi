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

export interface ParsedPiVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Dot-separated prerelease identifiers (`undefined` when absent; `+build` never captured). */
  readonly prerelease?: readonly string[];
}

/**
 * Parse `major.minor.patch[-prerelease][+build]` (leading `v`/whitespace
 * tolerated). Prerelease is preserved for precedence; `+build` metadata is
 * ignored per SemVer. A release without prerelease outranks the same
 * release with one (`0.85.1-beta.1` < `0.85.1`), so floor betas never
 * slip through as known-good.
 */
export function parsePiVersion(raw: string): ParsedPiVersion | null {
  if (typeof raw !== "string") return null;
  const match = raw
    .trim()
    .replace(/^v/i, "")
    .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) return null;
  const prerelease = match[4] !== undefined && match[4] !== "" ? Object.freeze(match[4].split(".")) : undefined;
  return prerelease === undefined ? { major, minor, patch } : { major, minor, patch, prerelease };
}

function compareIdentifiers(a: string, b: string): number {
  const aNum = /^\d+$/.test(a) ? Number(a) : null;
  const bNum = /^\d+$/.test(b) ? Number(b) : null;
  if (aNum !== null && bNum !== null) return aNum < bNum ? -1 : aNum > bNum ? 1 : 0;
  if (aNum !== null) return -1;
  if (bNum !== null) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Compare two parsed versions: negative / zero / positive (SemVer precedence). */
export function comparePiVersions(a: ParsedPiVersion, b: ParsedPiVersion): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  const aPre = a.prerelease;
  const bPre = b.prerelease;
  if (aPre === undefined && bPre === undefined) return 0;
  if (aPre !== undefined && bPre === undefined) return -1;
  if (aPre === undefined && bPre !== undefined) return 1;
  const len = Math.min(aPre!.length, bPre!.length);
  for (let i = 0; i < len; i += 1) {
    const cmp = compareIdentifiers(aPre![i]!, bPre![i]!);
    if (cmp !== 0) return cmp;
  }
  if (aPre!.length === bPre!.length) return 0;
  return aPre!.length < bPre!.length ? -1 : 1;
}

/**
 * Coarse version floor for structured Pi. Newer versions pass with a
 * "probe-capabilities" note (probing, not the version string, decides
 * per-feature support); older or unparseable versions fail closed to
 * Pi TUI with an actionable reason.
 */
/** Render a parsed version for diagnostics (prerelease preserved, build dropped). */
export function formatPiVersion(v: ParsedPiVersion): string {
  const base = `${v.major}.${v.minor}.${v.patch}`;
  return v.prerelease === undefined ? base : `${base}-${v.prerelease.join(".")}`;
}

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
      reason: `unsupported-pi-version: ${formatPiVersion(parsed)} < minimum known-good ${MIN_KNOWN_GOOD_PI_VERSION} (update Pi or use Pi TUI)`,
      fallback: PI_TUI_FALLBACK,
    };
  }
  return {
    supported: true,
    reason: `pi-version-ok: ${formatPiVersion(parsed)} >= ${MIN_KNOWN_GOOD_PI_VERSION} (confirm per-feature support by capability probing)`,
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

/**
 * Acquire-time compatibility input (wire-safe plain data).
 *
 * Every field is optional: absent dimensions are skipped, present ones
 * are enforced BEFORE any Pi child is spawned. Orca probes `pi --version`
 * once (bounded, out of band) and passes it here; the provider refuses a
 * failing gate with an actionable `PI_COMPAT_*` error naming the Pi TUI
 * fallback instead of starting structured Pi.
 */
export interface PiAcquireCompat {
  /** Probed `pi --version` output (floor-gated when present). */
  readonly piVersion?: string;
  /** Execution host id (location-gated for agent `pi` when present). */
  readonly executionHostId?: string;
  /** WSL distro (location-gated when non-null). */
  readonly wslDistro?: string | null;
  /** Required capabilities (probed against the advertised set when present). */
  readonly requiredCapabilities?: readonly string[];
}

export interface PiAcquireCompatVerdict {
  readonly allowed: boolean;
  /** Machine-readable code (`PI_COMPAT_*` on refusal; safe for logs/toasts). */
  readonly code: string;
  readonly reason: string;
  readonly fallback: typeof PI_TUI_FALLBACK;
}

/**
 * Pre-spawn acquisition gate consumed by BOTH provider paths
 * (`PiBridgeProvider.onPiAcquire` + `PiNativeProvider.acquire`) before any
 * spec resolution or Pi child creation. Pure: no I/O, no processes.
 * `advertised` is the provider's own capability advertisement (the same
 * object carried by `hello_ok`), so required capabilities are probed
 * against exactly what structured Pi would offer.
 */
export function checkAcquireCompat(
  compat: PiAcquireCompat,
  advertised: PiProbedCapabilities,
): PiAcquireCompatVerdict {
  if (compat.executionHostId !== undefined || compat.wslDistro !== undefined) {
    const location: PiCompatLocation = {
      executionHostId: compat.executionHostId ?? PI_COMPAT_LOCAL_HOST_ID,
      wslDistro: compat.wslDistro ?? null,
    };
    const verdict = checkPiLocationSupport(location, PI_COMPAT_AGENT);
    if (!verdict.supported) {
      return { allowed: false, code: "PI_COMPAT_LOCATION", reason: verdict.reason, fallback: PI_TUI_FALLBACK };
    }
  }
  if (compat.piVersion !== undefined) {
    const verdict = checkPiVersionSupport(compat.piVersion);
    if (!verdict.supported) {
      return { allowed: false, code: "PI_COMPAT_VERSION", reason: verdict.reason, fallback: PI_TUI_FALLBACK };
    }
  }
  const required = compat.requiredCapabilities ?? [];
  if (required.length > 0) {
    const negotiated = negotiatePiCapabilities(required, advertised);
    if (!negotiated.structured) {
      return { allowed: false, code: "PI_COMPAT_CAPABILITY", reason: negotiated.reason, fallback: PI_TUI_FALLBACK };
    }
  }
  return { allowed: true, code: "PI_COMPAT_OK", reason: "compat-ok: acquire-time gate passed", fallback: PI_TUI_FALLBACK };
}

/**
 * Required capabilities with a dedicated pre-turn live RPC probe.
 *
 * `options`/`images` verify against the live model + thinking catalogs
 * (plus the `set_model` verb for `options`); `history`/`resume` verify
 * against live entries/tree (with entries → tree fallback) plus
 * `switchSession` presence for `resume`. The remaining flags
 * (`textStreaming`, `thinking`, `tools`, `cancel`, `extensionDialogs`)
 * have no pre-turn probe: they are checked against the static adapter
 * advertisement pre-spawn and enforced per-turn at runtime (abort
 * fidelity, translator shaping, prompt retirement,
 * `PI_OPTION_UNSUPPORTED` on minimal transports). Operations whose only
 * safe evidence is presence (thinking/auto-compaction setters,
 * `switchSession`) are documented as declared in the probe messages and
 * the SNC1.10 compatibility doc — never presented as command-invoked.
 */
export const LIVE_PROBE_CAPABILITIES: readonly string[] = Object.freeze(["options", "images", "history", "resume"]);

/** Split required capabilities into live-probed vs adapter-declared. */
export function splitProbedCapabilities(required: readonly string[]): {
  readonly live: readonly string[];
  readonly declared: readonly string[];
} {
  const live = required.filter((name) => (LIVE_PROBE_CAPABILITIES as readonly string[]).includes(name));
  const declared = required.filter((name) => !(LIVE_PROBE_CAPABILITIES as readonly string[]).includes(name));
  return { live: Object.freeze([...live]), declared: Object.freeze([...declared]) };
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

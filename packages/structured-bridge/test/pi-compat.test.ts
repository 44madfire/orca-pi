/**
 * SNC1.10 compatibility + capability gate tests (deterministic, offline).
 *
 * Pins the pure `pi-compat.ts` gates with no Pi binary, no credentials,
 * and no OS processes:
 * - version floor (minimum known-good Pi, unparseable/older → TUI);
 * - honest execution-location matrix (local-only; WSL/remote fail closed);
 * - capability probing over version checks (missing caps degrade to TUI);
 * - combined gate entry point (every refusal names the Pi TUI fallback).
 */

import { describe, expect, it } from "vitest";
import {
  checkAcquireCompat,
  checkPiLocationSupport,
  checkPiVersionSupport,
  comparePiVersions,
  gatePiStructuredSession,
  MIN_KNOWN_GOOD_PI_VERSION,
  negotiatePiCapabilities,
  parsePiVersion,
  PI_TUI_FALLBACK,
  splitProbedCapabilities,
} from "../src/pi-compat.js";

describe("SNC1.10 Pi version floor (capability probing stays authoritative)", () => {
  it("parses strict semver with tolerated v-prefix and prerelease suffix", () => {
    expect(parsePiVersion("0.85.1")).toEqual({ major: 0, minor: 85, patch: 1 });
    expect(parsePiVersion("v0.85.1")).toEqual({ major: 0, minor: 85, patch: 1 });
    expect(parsePiVersion("  0.85.1  ")).toEqual({ major: 0, minor: 85, patch: 1 });
    expect(parsePiVersion("0.85.1-beta.1")).toEqual({ major: 0, minor: 85, patch: 1, prerelease: ["beta", "1"] });
    expect(parsePiVersion("0.85.1+build.7")).toEqual({ major: 0, minor: 85, patch: 1 });
    expect(parsePiVersion("0.85")).toBeNull();
    expect(parsePiVersion("latest")).toBeNull();
    expect(parsePiVersion("")).toBeNull();
  });

  it("compares versions numerically (not lexicographically)", () => {
    const v = (s: string) => parsePiVersion(s)!;
    expect(comparePiVersions(v("0.85.1"), v("0.85.1"))).toBe(0);
    expect(comparePiVersions(v("0.85.10"), v("0.85.9"))).toBeGreaterThan(0);
    expect(comparePiVersions(v("0.84.9"), v("0.85.1"))).toBeLessThan(0);
    expect(comparePiVersions(v("1.0.0"), v("0.99.99"))).toBeGreaterThan(0);
  });

  it("accepts the minimum known-good version and newer (probing confirms features)", () => {
    expect(MIN_KNOWN_GOOD_PI_VERSION).toBe("0.85.1");
    const floor = checkPiVersionSupport("0.85.1");
    expect(floor.supported).toBe(true);
    expect(floor.fallback).toBe(PI_TUI_FALLBACK);
    const newer = checkPiVersionSupport("0.99.0");
    expect(newer.supported).toBe(true);
    expect(newer.reason).toMatch(/capability probing/);
  });

  it("fails closed to Pi TUI on older or unparseable versions", () => {
    for (const raw of ["0.84.9", "0.1.0", "latest", "", "0.85"]) {
      const verdict = checkPiVersionSupport(raw);
      expect(verdict.supported).toBe(false);
      expect(verdict.fallback).toBe("pi-tui");
      expect(verdict.reason).toMatch(/unsupported-pi-version/);
    }
  });

  it("refuses floor prereleases (SemVer orders them before the release)", () => {
    // Regression: the floor is the final release; its own betas are older.
    const beta = checkPiVersionSupport("0.85.1-beta.1");
    expect(beta.supported).toBe(false);
    expect(beta.reason).toMatch(/unsupported-pi-version/);
    expect(beta.reason).toContain("0.85.1-beta.1");
    // Newer prereleases still pass the floor (probing decides features).
    expect(checkPiVersionSupport("0.86.0-rc.1").supported).toBe(true);
    // Build metadata never affects precedence.
    expect(checkPiVersionSupport(`${MIN_KNOWN_GOOD_PI_VERSION}+build.7`).supported).toBe(true);
  });
});

describe("SNC1.10 execution-location honesty (no remote/WSL/mobile claims)", () => {
  const local = { executionHostId: "local", wslDistro: null };

  it("supports only agent pi on the local host without a WSL distro", () => {
    const ok = checkPiLocationSupport(local, "pi");
    expect(ok.supported).toBe(true);
    expect(ok.fallback).toBe("pi-tui");
  });

  it("never claims Codex/Claude sessions (provider selection unchanged)", () => {
    for (const agent of ["codex", "claude", "external", ""]) {
      const verdict = checkPiLocationSupport(local, agent);
      expect(verdict.supported).toBe(false);
      expect(verdict.reason).toMatch(/agent-not-owned/);
      expect(verdict.fallback).toBe("pi-tui");
    }
  });

  it("fails closed on remote/SSH/mobile/paired hosts and on WSL", () => {
    const refused: Array<{ executionHostId: string; wslDistro: string | null }> = [
      { executionHostId: "remote", wslDistro: null },
      { executionHostId: "ssh", wslDistro: null },
      { executionHostId: "mobile", wslDistro: null },
      { executionHostId: "paired", wslDistro: null },
      { executionHostId: "local", wslDistro: "Ubuntu" },
      { executionHostId: "local", wslDistro: "Debian" },
    ];
    for (const location of refused) {
      const verdict = checkPiLocationSupport(location, "pi");
      expect(verdict.supported).toBe(false);
      expect(verdict.fallback).toBe("pi-tui");
      expect(verdict.reason).toMatch(/unsupported-location/);
    }
  });
});

describe("SNC1.10 capability probing over version checks", () => {
  it("keeps structured when every required capability probes true", () => {
    const verdict = negotiatePiCapabilities(["textStreaming", "history"], {
      textStreaming: true,
      history: true,
    });
    expect(verdict.structured).toBe(true);
    expect(verdict.unsupported).toEqual([]);
  });

  it("falls back to TUI and names hidden capabilities when probing fails", () => {
    const verdict = negotiatePiCapabilities(["textStreaming", "images", "resume"], {
      textStreaming: true,
      images: false,
    });
    expect(verdict.structured).toBe(false);
    expect(verdict.fallback).toBe("pi-tui");
    expect(verdict.unsupported).toEqual(["images", "resume"]);
    expect(verdict.reason).toMatch(/images/);
  });

  it("treats absent (unprobed) capabilities as unsupported", () => {
    const verdict = negotiatePiCapabilities(["cancel"], {});
    expect(verdict.structured).toBe(false);
    expect(verdict.unsupported).toEqual(["cancel"]);
  });
});

describe("SNC1.10 acquire-time gate (pre-spawn enforcement input)", () => {
  const advertised = { textStreaming: true, history: true };

  it("allows a passing gate and skips absent dimensions", () => {
    expect(checkAcquireCompat({}, advertised).allowed).toBe(true);
    expect(checkAcquireCompat({ piVersion: MIN_KNOWN_GOOD_PI_VERSION }, advertised).allowed).toBe(true);
    expect(
      checkAcquireCompat({ requiredCapabilities: ["textStreaming"] }, advertised).allowed,
    ).toBe(true);
  });

  it("refuses version/location/capability failures with PI_COMPAT_* codes", () => {
    expect(checkAcquireCompat({ piVersion: "0.1.0" }, advertised)).toMatchObject({
      allowed: false,
      code: "PI_COMPAT_VERSION",
      fallback: "pi-tui",
    });
    expect(checkAcquireCompat({ executionHostId: "remote" }, advertised)).toMatchObject({
      allowed: false,
      code: "PI_COMPAT_LOCATION",
      fallback: "pi-tui",
    });
    expect(checkAcquireCompat({ wslDistro: "Ubuntu" }, advertised)).toMatchObject({
      allowed: false,
      code: "PI_COMPAT_LOCATION",
      fallback: "pi-tui",
    });
    expect(checkAcquireCompat({ requiredCapabilities: ["images"] }, advertised)).toMatchObject({
      allowed: false,
      code: "PI_COMPAT_CAPABILITY",
      fallback: "pi-tui",
    });
  });
});

describe("SNC1.10 live vs declared capability split (round-3 P1)", () => {
  it("routes probed capabilities live and the rest to the advertisement", () => {
    expect(splitProbedCapabilities(["options", "images", "history", "resume"]).live).toEqual([
      "options",
      "images",
      "history",
      "resume",
    ]);
    const text = splitProbedCapabilities(["textStreaming", "thinking", "tools", "cancel", "extensionDialogs"]);
    expect(text.live).toEqual([]);
    expect(text.declared).toEqual(["textStreaming", "thinking", "tools", "cancel", "extensionDialogs"]);
    const mixed = splitProbedCapabilities(["options", "tools"]);
    expect(mixed.live).toEqual(["options"]);
    expect(mixed.declared).toEqual(["tools"]);
    expect(splitProbedCapabilities([])).toEqual({ live: [], declared: [] });
  });
});

describe("SNC1.10 combined structured gate (location + version + probing)", () => {
  const local = { executionHostId: "local", wslDistro: null };

  it("opens structured only when every gate passes", () => {
    const verdict = gatePiStructuredSession({
      location: local,
      agent: "pi",
      piVersion: MIN_KNOWN_GOOD_PI_VERSION,
      requiredCapabilities: ["textStreaming"],
      probedCapabilities: { textStreaming: true },
    });
    expect(verdict.structured).toBe(true);
    expect(verdict.fallback).toBe("pi-tui");
  });

  it("refuses in gate order: location, then version, then capabilities", () => {
    const badLocation = gatePiStructuredSession({
      location: { executionHostId: "remote", wslDistro: null },
      agent: "pi",
      piVersion: MIN_KNOWN_GOOD_PI_VERSION,
    });
    expect(badLocation.structured).toBe(false);
    expect(badLocation.reason).toMatch(/unsupported-location/);

    const badVersion = gatePiStructuredSession({
      location: local,
      agent: "pi",
      piVersion: "0.1.0",
    });
    expect(badVersion.structured).toBe(false);
    expect(badVersion.reason).toMatch(/unsupported-pi-version/);

    const badCaps = gatePiStructuredSession({
      location: local,
      agent: "pi",
      piVersion: MIN_KNOWN_GOOD_PI_VERSION,
      requiredCapabilities: ["images"],
      probedCapabilities: { images: false },
    });
    expect(badCaps.structured).toBe(false);
    expect(badCaps.reason).toMatch(/unsupported-capabilities/);
  });
});

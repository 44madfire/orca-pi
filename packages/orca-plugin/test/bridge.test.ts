/**
 * Versioned panel↔bridge protocol tests (UI1.2).
 *
 * Covers request IDs, allowlisted operations (no arbitrary shell),
 * explicit worktree/project scoping (race-safe), Windows/WSL paths,
 * capability negotiation + degraded fallback, and error-code mapping.
 * Pure — no I/O, no network.
 */
import { describe, expect, it } from "vitest";
import {
  BRIDGE_OPERATIONS,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_VERSION,
  bridgeFail,
  bridgeOk,
  describeTerminalFallback,
  isAbsoluteProjectRoot,
  makeBridgeRequest,
  mapMutationCodeToBridge,
  negotiateBridgeCapabilities,
  normalizeProjectRoot,
  parseBridgeRequest,
  validateBridgeResponse,
} from "../src/bridge.js";

describe("bridge protocol: request IDs and versioning", () => {
  it("accepts a well-formed request and echoes requestId", () => {
    const parsed = parseBridgeRequest({
      protocolVersion: 1,
      requestId: "req-1",
      operation: "profiles.list",
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.request.requestId).toBe("req-1");
      expect(parsed.request.operation).toBe("profiles.list");
    }
    expect(bridgeOk("req-1", { a: 1 })).toEqual({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      requestId: "req-1",
      ok: true,
      result: { a: 1 },
    });
    const failed = bridgeFail("req-1", "conflict", "stale");
    expect(failed).toMatchObject({ requestId: "req-1", ok: false });
    if (!failed.ok) expect(failed.error.code).toBe("conflict");
  });

  it("rejects bad requestIds with validation", () => {
    for (const bad of ["", "has space", "a".repeat(129), 42, undefined]) {
      const parsed = parseBridgeRequest({ protocolVersion: 1, requestId: bad, operation: "profiles.list" });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error.code).toBe("validation");
    }
  });

  it("rejects wrong protocol versions with unsupported", () => {
    const parsed = parseBridgeRequest({ protocolVersion: 99, requestId: "r1", operation: "profiles.list" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe("unsupported");
      expect(parsed.requestId).toBe("r1");
    }
  });

  it("exposes the required operation set", () => {
    for (const op of [
      "bridge.capabilities",
      "worktree.context",
      "profiles.list",
      "profile.read",
      "profile.validate",
      "profile.mutate",
      "launch.preview",
      "orchestration.get",
      "orchestration.set",
      "github.status",
      "github.doctor",
      "diagnostics.doctor",
    ] as const) {
      expect(BRIDGE_OPERATIONS).toContain(op);
    }
    expect(BRIDGE_VERSION).toBe("1.0.0");
    expect(BRIDGE_PROTOCOL_VERSION).toBe(1);
  });
});

describe("bridge protocol: no arbitrary command execution", () => {
  it.each(["exec", "shell", "command", "run", "terminal.exec", "process:exec", ""])(
    "rejects disallowed operation %j with validation",
    (operation) => {
      const parsed = parseBridgeRequest({ protocolVersion: 1, requestId: "r1", operation });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error.code).toBe("validation");
        expect(parsed.error.message).toMatch(/cannot request arbitrary command execution/);
      }
    },
  );

  it("makeBridgeRequest refuses to construct disallowed ops", () => {
    expect(() => makeBridgeRequest("r1", "exec" as never)).toThrow(/Disallowed bridge operation/);
    expect(() => makeBridgeRequest("bad id!", "profiles.list")).toThrow(/requestId/);
    const req = makeBridgeRequest("r1", "profiles.list", { worktree: { projectRoot: "/r" } });
    expect(req.requestId).toBe("r1");
  });
});

describe("bridge protocol: explicit worktree/project scoping (race-safe)", () => {
  it("requires worktree.projectRoot for mutating ops", () => {
    for (const operation of ["profile.mutate", "orchestration.set"] as const) {
      const missing = parseBridgeRequest({ protocolVersion: 1, requestId: "r1", operation });
      expect(missing.ok).toBe(false);
      if (!missing.ok) expect(missing.error.message).toMatch(/worktree\.projectRoot is required/);
    }
  });

  it("allows reads without scope but preserves explicit scope", () => {
    const bare = parseBridgeRequest({ protocolVersion: 1, requestId: "r1", operation: "profiles.list" });
    expect(bare.ok).toBe(true);
    const scoped = parseBridgeRequest({
      protocolVersion: 1,
      requestId: "r2",
      operation: "profiles.list",
      worktree: { projectRoot: "C:\\repo\\p", worktreeId: "repo::/x", terminalId: "term-1" },
    });
    expect(scoped.ok).toBe(true);
    if (scoped.ok) {
      expect(scoped.request.worktree?.projectRoot).toBe("C:/repo/p");
      expect(scoped.request.worktree?.terminalId).toBe("term-1");
    }
  });

  it("rejects control characters and oversized scopes", () => {
    const bad = parseBridgeRequest({
      protocolVersion: 1,
      requestId: "r1",
      operation: "profile.mutate",
      worktree: { projectRoot: "/r\u0000x" },
    });
    expect(bad.ok).toBe(false);
  });

  it("requires absolute projectRoot for mutating ops (never worker-cwd-relative)", () => {
    for (const operation of ["profile.mutate", "orchestration.set"] as const) {
      for (const projectRoot of ["relative/path", "../../somewhere", ".", "repo\\p"]) {
        const parsed = parseBridgeRequest({
          protocolVersion: 1,
          requestId: "r1",
          operation,
          worktree: { projectRoot },
        });
        expect(parsed.ok).toBe(false);
        if (!parsed.ok) {
          expect(parsed.error.code).toBe("validation");
          expect(parsed.error.message).toMatch(/absolute/);
        }
      }
      // Absolute roots (POSIX, drive-letter, UNC/WSL) are accepted.
      for (const projectRoot of ["/repo/p", "C:/repo/p", "C:\\repo\\p", "\\\\wsl.localhost\\Ubuntu\\repo"]) {
        const parsed = parseBridgeRequest({
          protocolVersion: 1,
          requestId: "r1",
          operation,
          worktree: { projectRoot },
        });
        expect(parsed.ok).toBe(true);
      }
    }
  });

  it("still allows relative roots for reads (normalized, never executed)", () => {
    const parsed = parseBridgeRequest({
      protocolVersion: 1,
      requestId: "r1",
      operation: "profiles.list",
      worktree: { projectRoot: "relative/path" },
    });
    expect(parsed.ok).toBe(true);
  });
});

describe("bridge protocol: Windows + WSL paths", () => {
  it("normalizes slashes while preserving UNC/WSL and drive roots", () => {
    expect(normalizeProjectRoot("C:\\repo\\p\\")).toBe("C:/repo/p");
    expect(normalizeProjectRoot("\\\\wsl.localhost\\Ubuntu\\repo")).toBe("//wsl.localhost/Ubuntu/repo");
    expect(normalizeProjectRoot("/repo/p//")).toBe("/repo/p");
  });

  it("preserves bare roots so they stay absolute", () => {
    expect(normalizeProjectRoot("C:/")).toBe("C:/");
    expect(normalizeProjectRoot("C:\\")).toBe("C:/");
    expect(normalizeProjectRoot("/")).toBe("/");
    expect(isAbsoluteProjectRoot(normalizeProjectRoot("C:/"))).toBe(true);
  });

  it("detects absolute scopes (POSIX, drive-letter, UNC)", () => {
    expect(isAbsoluteProjectRoot("/repo/p")).toBe(true);
    expect(isAbsoluteProjectRoot("C:/repo/p")).toBe(true);
    expect(isAbsoluteProjectRoot("C:\\repo\\p")).toBe(true);
    expect(isAbsoluteProjectRoot("\\\\wsl.localhost\\Ubuntu\\repo")).toBe(true);
    expect(isAbsoluteProjectRoot("relative/path")).toBe(false);
    expect(isAbsoluteProjectRoot("")).toBe(false);
  });
});

describe("bridge protocol: capability negotiation + degraded fallback", () => {
  const HOST = {
    appVersion: "1.4.196",
    pluginApi: 1,
    grantedCapabilities: ["workspace:read", "terminal:send"],
    seamAvailable: true,
  };

  it("negotiates structured support only with the seam handshake", () => {
    const res = negotiateBridgeCapabilities(HOST);
    expect(res.supported).toBe(true);
    expect(res.structured).toBe(true);
    expect(res.degraded).toBe(false);
    expect(res.fallback).toBe("structured");
    expect(res.supportedOperations).toContain("profile.mutate");
    expect(res.bridgeVersion).toBe(BRIDGE_VERSION);
    expect(res.versionsOk).toBe(true);
    expect(res.consentOk).toBe(true);
    expect(res.seamHandshake).toBe(true);
  });

  it("stays degraded without the seam handshake even when versions/caps look right", () => {
    const { seamAvailable: _dropped, ...noSeam } = HOST;
    void _dropped;
    const res = negotiateBridgeCapabilities(noSeam);
    expect(res.supported).toBe(true);
    expect(res.structured).toBe(false);
    expect(res.degraded).toBe(true);
    expect(res.fallback).toBe("cli-only");
    expect(res.supportedOperations).not.toContain("profile.mutate");
    expect(res.reasons.join("\n")).toMatch(/seam/);
  });

  it("degrades fail-closed on unknown versions or grants (never assumes current)", () => {
    expect(negotiateBridgeCapabilities().structured).toBe(false);
    expect(negotiateBridgeCapabilities({ seamAvailable: true }).supported).toBe(false);
    expect(negotiateBridgeCapabilities({ seamAvailable: true }).reasons.join("\n")).toMatch(/unknown/);
  });

  it("degrades explicitly on old hosts, future pluginApi, and missing consent", () => {
    const old = negotiateBridgeCapabilities({ appVersion: "1.3.0", pluginApi: 1, seamAvailable: true, grantedCapabilities: HOST.grantedCapabilities });
    expect(old.supported).toBe(false);
    expect(old.structured).toBe(false);
    expect(old.degraded).toBe(true);
    expect(old.fallback).toBe("cli-only");
    const future = negotiateBridgeCapabilities({ appVersion: "1.4.196", pluginApi: 99, seamAvailable: true, grantedCapabilities: HOST.grantedCapabilities });
    expect(future.supported).toBe(false);
    expect(future.structured).toBe(false);
    const noConsent = negotiateBridgeCapabilities({
      appVersion: "1.4.196",
      pluginApi: 1,
      seamAvailable: true,
      grantedCapabilities: ["terminal:send"],
    });
    expect(noConsent.structured).toBe(false);
    expect(noConsent.degraded).toBe(true);
    expect(noConsent.reasons.join("\n")).toMatch(/workspace:read/);
  });

  it("ignores unknown future capabilities (additive, no rewrite needed)", () => {
    const res = negotiateBridgeCapabilities({
      ...HOST,
      grantedCapabilities: ["workspace:read", "terminal:send", "future:thing"],
    });
    expect(res.structured).toBe(true);
  });

  it("notes that storage/settings/secrets are intentionally unused (no second store)", () => {
    const res = negotiateBridgeCapabilities({
      ...HOST,
      grantedCapabilities: ["workspace:read", "terminal:send", "storage", "settings:own", "secrets"],
    });
    expect(res.reasons.join("\n")).toMatch(/no second profile store/);
  });
});

describe("bridge protocol: degraded terminal.sendText descriptors", () => {
  it("requires an explicit terminalId (never active)", () => {
    const res = describeTerminalFallback("", "orca-pi doctor");
    expect("ok" in res && res.ok === false).toBe(true);
  });

  it("allowlists read-only CLI text and refuses mutations/shell", () => {
    const ok = describeTerminalFallback("term-1", "orca-pi profile validate");
    expect("hostAction" in ok && ok.hostAction).toBe("terminal.sendText");
    if ("hostAction" in ok) {
      expect(ok.terminalId).toBe("term-1");
      // Submitted, not merely typed: the click is the explicit gesture and
      // the text is allowlisted read-only, so `enter: false` would report
      // success while producing no command output.
      expect(ok.enter).toBe(true);
      expect(ok.degraded).toBe(true);
    }
    for (const bad of [
      "orca-pi profile set foo model bar --scope project",
      "rm -rf /",
      "orca-pi spawn worker --task x",
    ]) {
      const refused = describeTerminalFallback("term-1", bad);
      expect("ok" in refused && refused.ok === false).toBe(true);
    }
  });
});

describe("bridge protocol: error-code mapping", () => {
  it("maps core mutation codes onto bridge codes", () => {
    expect(mapMutationCodeToBridge("conflict")).toBe("conflict");
    expect(mapMutationCodeToBridge("already-exists")).toBe("already-exists");
    expect(mapMutationCodeToBridge("not-found")).toBe("not-found");
    expect(mapMutationCodeToBridge("builtin-immutable")).toBe("validation");
    expect(mapMutationCodeToBridge("missing-scope")).toBe("validation");
    expect(mapMutationCodeToBridge("atomic-write-failed")).toBe("internal");
    expect(mapMutationCodeToBridge("something-new")).toBe("internal");
  });
});

describe("bridge protocol: response validation", () => {
  it("accepts well-formed success and error responses", () => {
    const ok = validateBridgeResponse(
      { protocolVersion: 1, requestId: "r1", ok: true, result: { a: 1 } },
      "r1",
    );
    expect(ok.ok).toBe(true);
    const err = validateBridgeResponse(
      { protocolVersion: 1, requestId: "r1", ok: false, error: { code: "conflict", message: "stale" } },
      "r1",
    );
    expect(err.ok).toBe(true);
  });

  it("maps version skew to unsupported for clean degradation", () => {
    const res = validateBridgeResponse(
      { protocolVersion: 99, requestId: "r1", ok: true, result: {} },
      "r1",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("unsupported");
  });

  it("maps every other malformation to internal without trusting data", () => {
    const bad: unknown[] = [
      null,
      "string",
      [],
      // Note: {} (missing protocolVersion) maps to `unsupported`, not
      // `internal` — version skew degrades cleanly (covered above).
      { protocolVersion: 1, requestId: "r2", ok: true, result: {} },
      { protocolVersion: 1, requestId: "r1", ok: true },
      { protocolVersion: 1, requestId: "r1", ok: "yes", result: {} },
      { protocolVersion: 1, requestId: "r1", ok: false },
      { protocolVersion: 1, requestId: "r1", ok: false, error: { code: "bogus", message: "x" } },
      { protocolVersion: 1, requestId: "r1", ok: false, error: { code: "conflict" } },
      { protocolVersion: 1, requestId: "r1", ok: false, error: "boom" },
    ];
    for (const value of bad) {
      const res = validateBridgeResponse(value, "r1");
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe("internal");
    }
  });
});

/**
 * GitHub identities + Diagnostics UI1.5 tests.
 *
 * Proves the Control Center GitHub and Diagnostics sections render redacted,
 * role-scoped health via the authoritative typed bridge operations — never
 * secrets, never shell, never panel-local persistence.
 *
 * Covers (deterministic, no network):
 * - configured / missing / expired credential states
 * - swapped-identity (same actor for worker+reviewer)
 * - wrong-permission / wrong-repository (repo access-test failures)
 * - degraded-host (consent/seam gating preserved)
 * - redaction (no token/key material in bridge results or display text)
 * - bridge/panel behavior (typed role-scoped ops, CLI parity, panel tokens)
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { handleBridgeRequest, type BridgeHostDeps } from "../src/bridge-host.js";
import {
  buildGithubDoctorParams,
  buildGithubStatusParams,
  containsSecretMaterial,
  controlCenterSections,
  describeConfigHealth,
  describeDiagnosticsCli,
  describeGithubDoctorItem,
  describeGithubStatusItem,
  describeReviewActor,
  describeTokenFreshness,
  describeWorktreeHealth,
  diagnosticsHeadline,
  GITHUB_DEFAULT_AMBIENT,
  GITHUB_DEFAULT_REPO,
  GITHUB_IDENTITIES,
  githubMappedSummary,
  githubSetupActions,
  HUMAN_REVIEW_ACTOR,
  isSecretFreePayload,
  mapGithubErrorToField,
  REVIEW_ACTOR_NOTE,
  toDiagnosticsBridgeHealth,
  toDiagnosticsCliHealth,
  toDiagnosticsConfigHealth,
  toDiagnosticsWorktreeHealth,
  toGithubActorSummary,
  toGithubDoctorItems,
  toGithubMappedProfiles,
  toGithubStatusItems,
  toOrchestrationItems,
  validateGithubDoctorParams,
} from "../src/control-center.js";

const here = dirname(fileURLToPath(import.meta.url));
function controlHtml(): string {
  return readFileSync(join(here, "..", "panel", "control-center.html"), "utf8");
}

// ---------------------------------------------------------------------------
// Fixtures (synthetic redacted payloads — never contain secrets)
// ---------------------------------------------------------------------------

function statusPayload() {
  return {
    identities: {
      worker: { identity: "worker", configured: true, sourceLabel: "ORCA_PI_GITHUB_WORKER_TOKEN", expiresAt: "2030-01-01T00:00:00.000Z", expired: false },
      reviewer: { identity: "reviewer", configured: true, sourceLabel: "/home/u/.pi/agent/github-tokens/reviewer.json (cache-file)", expiresAt: "2030-06-01T00:00:00.000Z", expired: false },
    },
    redacted: true,
  };
}

function doctorReport(overrides?: Record<string, unknown>) {
  const base = {
    worker: {
      identity: "worker",
      expectedPermissions: { contents: "write", pullRequests: "write", checks: "none", metadata: "read" },
      configured: true,
      sourceLabel: "ORCA_PI_GITHUB_WORKER_TOKEN",
      expiresAt: "2030-01-01T00:00:00.000Z",
      expired: false,
      appLogin: "orca-pi-worker[bot]",
      appLoginConfigured: true,
      installationId: "111",
      installationIdConfigured: true,
      tokenRefreshable: true,
      refreshVars: { appIdVar: "ORCA_PI_GITHUB_WORKER_APP_ID", keyVar: "ORCA_PI_GITHUB_WORKER_PRIVATE_KEY_PATH", installationVar: "ORCA_PI_GITHUB_WORKER_INSTALLATION_ID" },
      iatProved: true,
      repoAccess: true,
      permissionsValid: true,
      permissionDetail: "ok: installation 111 covers 44madfire/orca-pi with expected permissions (verified via App JWT).",
    },
    reviewer: {
      identity: "reviewer",
      expectedPermissions: { contents: "read", pullRequests: "write", checks: "write", metadata: "read" },
      configured: true,
      sourceLabel: "ORCA_PI_GITHUB_REVIEWER_TOKEN",
      expiresAt: "2030-01-01T00:00:00.000Z",
      expired: false,
      appLogin: "orca-pi-reviewer[bot]",
      appLoginConfigured: true,
      installationId: "222",
      installationIdConfigured: true,
      tokenRefreshable: true,
      refreshVars: { appIdVar: "ORCA_PI_GITHUB_REVIEWER_APP_ID", keyVar: "ORCA_PI_GITHUB_REVIEWER_PRIVATE_KEY_PATH", installationVar: "ORCA_PI_GITHUB_REVIEWER_INSTALLATION_ID" },
      iatProved: true,
      repoAccess: true,
      permissionsValid: true,
      permissionDetail: "ok: installation 222 covers 44madfire/orca-pi with expected permissions (verified via App JWT).",
    },
    workerLogin: "orca-pi-worker[bot]",
    reviewerLogin: "orca-pi-reviewer[bot]",
    ambientLogin: "44madfire",
    distinctWorkerReviewer: true,
    distinctFromAmbient: true,
    distinctDetail: "orca-pi-worker[bot] != orca-pi-reviewer[bot] != 44madfire : distinct (ok)",
    setupNeeded: [],
    ok: true,
    redacted: true,
  };
  return { ...base, ...(overrides ?? {}) };
}

// ---------------------------------------------------------------------------
// Pure helpers: sections + identities + human actor
// ---------------------------------------------------------------------------

describe("ui1.5: sections + actor model", () => {
  it("marks GitHub + Diagnostics implemented with redacted blurbs", () => {
    const sections = controlCenterSections();
    const github = sections.find((s) => s.id === "github")!;
    expect(github.implemented).toBe(true);
    expect(github.blurb).toMatch(/redacted/i);
    expect(github.blurb).toMatch(/44madfire/);
    const diagnostics = sections.find((s) => s.id === "diagnostics")!;
    expect(diagnostics.implemented).toBe(true);
    expect(diagnostics.blurb).toMatch(/diagnostics\.doctor/);
  });

  it("tracks worker/reviewer slots and 44madfire as review actor (never a slot)", () => {
    expect([...GITHUB_IDENTITIES]).toEqual(["worker", "reviewer"]);
    expect(HUMAN_REVIEW_ACTOR).toBe("44madfire");
    expect(GITHUB_DEFAULT_REPO).toBe("44madfire/orca-pi");
    expect(GITHUB_DEFAULT_AMBIENT).toBe("44madfire");
    expect(REVIEW_ACTOR_NOTE).toContain("44madfire");
    expect(REVIEW_ACTOR_NOTE).toMatch(/never a credential slot/);
    expect(GITHUB_IDENTITIES).not.toContain("44madfire");
  });
});

// ---------------------------------------------------------------------------
// Pure helpers: github.status rows (configured / missing / expired)
// ---------------------------------------------------------------------------

describe("ui1.5: github.status rows", () => {
  it("normalizes configured worker+reviewer in canonical order", () => {
    const items = toGithubStatusItems(statusPayload());
    expect(items.map((i) => i.identity)).toEqual(["worker", "reviewer"]);
    expect(items[0]!.configured).toBe(true);
    expect(items[0]!.sourceLabel).toBe("ORCA_PI_GITHUB_WORKER_TOKEN");
    expect(items[0]!.expiresAt).toContain("2030");
    expect(describeGithubStatusItem(items[0]!)).toContain("configured via");
    expect(describeGithubStatusItem(items[0]!)).not.toMatch(/ghp_|ghu_|ghs_|PRIVATE KEY/);
    expect(describeTokenFreshness(items[0]!)).toContain("2030");
  });

  it("surfaces missing credentials with operator setup guidance", () => {
    const items = toGithubStatusItems({
      identities: {
        worker: { configured: false, sourceLabel: "ORCA_PI_GITHUB_WORKER_TOKEN" },
        reviewer: { configured: false, sourceLabel: "ORCA_PI_GITHUB_REVIEWER_TOKEN" },
      },
    });
    expect(items.every((i) => i.configured === false)).toBe(true);
    expect(describeGithubStatusItem(items[0]!)).toContain("missing");
    expect(describeGithubStatusItem(items[0]!)).toContain("orca-pi github setup --identity worker");
    expect(describeTokenFreshness(items[0]!)).toContain("missing");
  });

  it("surfaces expired tokens without values", () => {
    const items = toGithubStatusItems({
      identities: {
        worker: { configured: false, sourceLabel: "ORCA_PI_GITHUB_WORKER_TOKEN", expired: true },
      },
    });
    expect(items[0]!.expired).toBe(true);
    expect(describeGithubStatusItem(items[0]!)).toContain("expired");
    expect(describeGithubStatusItem(items[0]!)).toContain("mint a fresh installation token");
    expect(JSON.stringify(items)).not.toMatch(/ghs_|ghp_|PRIVATE KEY/);
  });

  it("never throws on malformed payloads", () => {
    expect(toGithubStatusItems(null)).toEqual([]);
    expect(toGithubStatusItems({})).toEqual([]);
    expect(toGithubStatusItems({ identities: null })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Pure helpers: github.doctor rows + actor binding
// ---------------------------------------------------------------------------

describe("ui1.5: github.doctor rows + actor binding", () => {
  it("normalizes healthy worker+reviewer with permissions + repo proof", () => {
    const items = toGithubDoctorItems(doctorReport());
    expect(items.map((i) => i.identity)).toEqual(["worker", "reviewer"]);
    expect(items[0]!.expectedPermissions.contents).toBe("write");
    expect(items[1]!.expectedPermissions.contents).toBe("read");
    expect(items[0]!.tokenRefreshable).toBe(true);
    expect(items[0]!.iatProved).toBe(true);
    expect(items[0]!.repoAccess).toBe(true);
    expect(items[0]!.permissionsValid).toBe(true);
    expect(describeGithubDoctorItem(items[0]!)).toContain("contents=write");
    expect(describeGithubDoctorItem(items[1]!)).toContain("contents=read");
    expect(describeGithubDoctorItem(items[0]!)).toContain("repo access ok");
  });

  it("represents swapped-identity (same actor) as NOT distinct", () => {
    const swapped = doctorReport({
      workerLogin: "same-bot[bot]",
      reviewerLogin: "SAME-BOT[bot]",
      distinctWorkerReviewer: false,
      distinctFromAmbient: false,
      distinctDetail: 'same-bot[bot] != SAME-BOT[bot] : NOT distinct (same actor)',
      setupNeeded: ['worker and reviewer resolve to the same actor ("same-bot[bot]") — provision distinct GitHub Apps (worker != reviewer).'],
      ok: false,
    });
    const summary = toGithubActorSummary(swapped)!;
    expect(summary.distinctWorkerReviewer).toBe(false);
    expect(summary.ok).toBe(false);
    expect(describeReviewActor(summary)).toContain("NOT distinct");
    expect(githubSetupActions(swapped).join("\n")).toMatch(/same actor|distinct/i);
  });

  it("surfaces wrong-permission as access-ok-but-mismatch (never silent)", () => {
    const mismatch = doctorReport({
      worker: {
        ...(doctorReport().worker as Record<string, unknown>),
        repoAccess: true,
        permissionsValid: false,
        permissionDetail: "permission mismatch (via App JWT): contents=read (want write).",
      },
      setupNeeded: ["worker: permission mismatch (via App JWT): contents=read (want write)."],
      ok: false,
    });
    const items = toGithubDoctorItems(mismatch);
    expect(items[0]!.permissionsValid).toBe(false);
    expect(describeGithubDoctorItem(items[0]!)).toContain("permission mismatch");
    expect(githubSetupActions(mismatch).join("\n")).toContain("permission mismatch");
  });

  it("surfaces wrong-repository as repo access FAILED (fail closed)", () => {
    const noAccess = doctorReport({
      worker: {
        ...(doctorReport().worker as Record<string, unknown>),
        repoAccess: false,
        permissionsValid: false,
        repoError: "GitHub returned 404 for /repos/o/r/installation with the App JWT. The App is not installed on o/r.",
        permissionDetail: "GitHub returned 404 for /repos/o/r/installation with the App JWT. The App is not installed on o/r.",
      },
      setupNeeded: ["worker: repository verification failed — GitHub returned 404."],
      ok: false,
    });
    const items = toGithubDoctorItems(noAccess);
    expect(items[0]!.repoAccess).toBe(false);
    expect(describeGithubDoctorItem(items[0]!)).toContain("FAILED");
    expect(githubSetupActions(noAccess).length).toBeGreaterThan(0);
  });

  it("always shows 44madfire as human review actor, never a slot", () => {
    const summary = toGithubActorSummary(doctorReport())!;
    expect(summary.ambientLogin).toBe("44madfire");
    expect(describeReviewActor(summary)).toContain("44madfire");
    expect(describeReviewActor(summary)).toContain("never a credential slot");
    // Ambient defaults to 44madfire when the report carries none.
    const bare = toGithubActorSummary({ workerLogin: "w[bot]", reviewerLogin: "r[bot]", distinctDetail: "x", ok: false })!;
    expect(bare.ambientLogin).toBe("44madfire");
    expect(describeReviewActor(bare)).toContain("44madfire");
  });
});

// ---------------------------------------------------------------------------
// Pure helpers: params, validation, error mapping, mapped profiles
// ---------------------------------------------------------------------------

describe("ui1.5: role-scoped params + validation + mapped profiles", () => {
  it("builds typed status/doctor params (explicit scope, never secrets)", () => {
    expect(buildGithubStatusParams()).toEqual({});
    expect(buildGithubStatusParams({ identity: "worker" })).toEqual({ identity: "worker" });
    expect(buildGithubStatusParams({ profile: "worker" })).toEqual({ profile: "worker" });
    expect(() => buildGithubStatusParams({ identity: "bad name!" })).toThrow(/Invalid github identity/);
    expect(buildGithubDoctorParams()).toEqual({});
    expect(buildGithubDoctorParams({ repo: "44madfire/orca-pi", ambient: "44madfire" })).toEqual({
      repo: "44madfire/orca-pi",
      ambient: "44madfire",
    });
    expect(() => buildGithubDoctorParams({ repo: "not-a-repo" })).toThrow(/Invalid repo/);
    expect(() => buildGithubDoctorParams({ ambient: "not a login!!" })).toThrow(/Invalid ambient/);
    expect(JSON.stringify(buildGithubStatusParams({ identity: "worker" }))).not.toMatch(/token|secret|key/i);
  });

  it("validates doctor inputs client-side (server remains authoritative)", () => {
    expect(validateGithubDoctorParams({})).toEqual([]);
    expect(validateGithubDoctorParams({ repo: "44madfire/orca-pi", ambient: "44madfire" })).toEqual([]);
    expect(validateGithubDoctorParams({ repo: "bad" }).some((i) => i.field === "repo")).toBe(true);
    expect(validateGithubDoctorParams({ ambient: "bad login!!" }).some((i) => i.field === "ambient")).toBe(true);
  });

  it("maps github bridge errors to repo/ambient/identity/profile fields", () => {
    expect(mapGithubErrorToField({ code: "validation", message: "bad", field: "params.repo" }).field).toBe("repo");
    expect(mapGithubErrorToField({ code: "validation", message: "bad", field: "ambient" }).field).toBe("ambient");
    expect(mapGithubErrorToField({ code: "auth/setup", message: "consent" }).field).toBe("_global");
    expect(mapGithubErrorToField({ code: "conflict", message: "stale" }).isConflict).toBe(true);
  });

  it("joins orchestration roles with profile identities (mapped profiles)", () => {
    const orch = toOrchestrationItems({
      effective: { worker: "worker", scout: "scout", reviewer: "reviewer" },
      provenance: { worker: "builtin", scout: "builtin", reviewer: "builtin" },
    });
    const rows = toGithubMappedProfiles(
      [
        { name: "worker", githubIdentity: "worker" },
        { name: "reviewer", githubIdentity: "reviewer" },
        { name: "scout" },
      ],
      orch,
    );
    expect(rows.find((r) => r.role === "worker")!.githubIdentity).toBe("worker");
    expect(rows.find((r) => r.role === "reviewer")!.githubIdentity).toBe("reviewer");
    expect(rows.find((r) => r.role === "scout")!.githubIdentity).toBeUndefined();
    expect(githubMappedSummary(rows)).toContain("worker→worker");
    expect(githubMappedSummary(rows)).toContain("reviewer→reviewer");
    const invalid = toGithubMappedProfiles([], [{ role: "worker", profile: "ghost", provenance: "project", invalid: true }]);
    expect(githubMappedSummary(invalid)).toContain("invalid");
  });
});

// ---------------------------------------------------------------------------
// Pure helpers: diagnostics (CLI + bridge + config + worktree)
// ---------------------------------------------------------------------------

describe("ui1.5: diagnostics display", () => {
  it("normalizes CLI health (agrees with `orca-pi doctor`)", () => {
    const health = toDiagnosticsCliHealth({
      cli: {
        orca: { executable: "orca", found: true, version: "1.4.196", detail: "orca 1.4.196" },
        pi: { executable: "pi", found: true, version: "0.84.4", detail: "pi 0.84.4" },
        ok: true,
      },
    })!;
    expect(health.ok).toBe(true);
    expect(describeDiagnosticsCli(health)).toContain("orca 1.4.196");
    expect(describeDiagnosticsCli(health)).toContain("pi 0.84.4");
    expect(describeDiagnosticsCli(health)).toContain("ready");
    expect(toDiagnosticsCliHealth({ cli: "(no runner)" })).toBeUndefined();
    expect(describeDiagnosticsCli(undefined)).toContain("orca-pi doctor");
  });

  it("normalizes bridge + worktree + config health", () => {
    const bridge = toDiagnosticsBridgeHealth({
      bridge: { structured: true, degraded: false, versionsOk: true, consentOk: true, seamHandshake: true, supportedOperations: ["profiles.list"], reasons: ["ok"] },
    })!;
    expect(bridge.structured).toBe(true);
    const worktree = toDiagnosticsWorktreeHealth({ projectRoot: "/repo/p", explicit: true, worktreeId: "repo::/x" })!;
    expect(worktree.explicit).toBe(true);
    expect(describeWorktreeHealth(worktree)).toContain("explicit scope");
    expect(describeWorktreeHealth(undefined)).toContain("unavailable");
    const config = toDiagnosticsConfigHealth({ entries: [{ valid: true }, { valid: false }], ok: false })!;
    expect(config.invalidCount).toBe(1);
    expect(describeConfigHealth(config)).toContain("1 invalid");
    expect(describeConfigHealth({ ok: true, invalidCount: 0, total: 3 })).toContain("all 3 valid");
    expect(diagnosticsHeadline({ cli: { ok: true }, bridge: { structured: true }, config: { ok: true } })).toContain("ready");
    expect(diagnosticsHeadline({ cli: { ok: false }, bridge: { structured: false }, config: { ok: false } })).toContain("action needed");
  });
});

// ---------------------------------------------------------------------------
// Redaction: no secret material in display text or payloads
// ---------------------------------------------------------------------------

describe("ui1.5: redaction (no secrets in DOM/logs/errors)", () => {
  it("detects token/key material in text", () => {
    expect(containsSecretMaterial("ok")).toBe(false);
    expect(containsSecretMaterial("sourceLabel ORCA_PI_GITHUB_WORKER_TOKEN")).toBe(false);
    expect(containsSecretMaterial("ghp_abcdefghij123456")).toBe(true);
    expect(containsSecretMaterial("ghu_abcdefghij123456")).toBe(true);
    expect(containsSecretMaterial("ghs_abcdefghij123456")).toBe(true);
    expect(containsSecretMaterial("-----BEGIN PRIVATE KEY-----")).toBe(true);
    expect(containsSecretMaterial("x-access-token:abc123")).toBe(true);
  });

  it("accepts redacted payloads, rejects raw token payloads", () => {
    expect(isSecretFreePayload(statusPayload())).toBe(true);
    expect(isSecretFreePayload(doctorReport())).toBe(true);
    expect(isSecretFreePayload({ token: "ghs_abcdefghij123456" })).toBe(false);
    expect(isSecretFreePayload({ token: "raw-secret-value-123" })).toBe(false);
    // Var names alone never trigger (labels, not values).
    expect(isSecretFreePayload({ sourceLabel: "ORCA_PI_GITHUB_WORKER_TOKEN" })).toBe(true);
  });

  it("keeps every display string secret-free", () => {
    const statusItems = toGithubStatusItems(statusPayload());
    const doctorItems = toGithubDoctorItems(doctorReport());
    const texts = [
      ...statusItems.map(describeGithubStatusItem),
      ...statusItems.map(describeTokenFreshness),
      ...doctorItems.map(describeGithubDoctorItem),
      describeReviewActor(toGithubActorSummary(doctorReport())!),
      ...githubSetupActions(doctorReport()),
      githubMappedSummary(toGithubMappedProfiles([{ name: "worker", githubIdentity: "worker" }], toOrchestrationItems({ effective: { worker: "worker" }, provenance: {} }))),
      describeDiagnosticsCli(toDiagnosticsCliHealth({ cli: { orca: { found: true, version: "1.4.196", detail: "d" }, pi: { found: true, version: "0.84.4", detail: "d" }, ok: true } })),
      REVIEW_ACTOR_NOTE,
    ];
    for (const text of texts) {
      expect(containsSecretMaterial(text)).toBe(false);
      expect(isSecretFreePayload({ text })).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Bridge behavior: redacted, role-scoped, degraded, CLI parity
// ---------------------------------------------------------------------------

function memFs() {
  const files = new Map<string, string>();
  const api = {
    files,
    async readFile(path: string) {
      const key = String(path);
      if (!files.has(key)) {
        const error = new Error(`ENOENT: ${key}`) as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return files.get(key)!;
    },
    async writeFile(path: string, content: string) {
      files.set(String(path), content);
    },
    async rename(oldPath: string, newPath: string) {
      const from = String(oldPath);
      const to = String(newPath);
      if (!files.has(from)) {
        const error = new Error(`ENOENT: ${from}`) as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      files.set(to, files.get(from)!);
      files.delete(from);
    },
    async mkdir() {
      return undefined;
    },
    async stat(path: string) {
      if (files.has(String(path))) return {};
      const error = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    },
    async unlink(path: string) {
      files.delete(String(path));
    },
  };
  return api;
}

function bridgeDeps(overrides?: Partial<BridgeHostDeps>): BridgeHostDeps {
  const fs = memFs();
  return {
    projectRoot: "/repo/p",
    transport: "operator",
    env: { HOME: "/home/u" } as NodeJS.ProcessEnv,
    homedir: "/home/u",
    fs,
    orchestrationFs: fs,
    fetchFn: async () => {
      throw new Error("no network in tests");
    },
    runner: {
      async run(exe: string) {
        if (exe === "orca") return { exitCode: 0, stdout: "orca 1.4.196", stderr: "" };
        return { exitCode: 0, stdout: "pi 0.84.4", stderr: "" };
      },
    } as unknown as import("@orca-pi/core").ProcessRunner,
    providerFs: {
      async readFile() {
        const error = new Error("ENOENT") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      },
      async writeFile() {},
      async mkdir() {},
    },
    ...overrides,
  };
}

describe("ui1.5: bridge github.status (configured / missing / expired / redacted)", () => {
  it("reports configured worker status without values", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const res = await handleBridgeRequest(
      { protocolVersion: 1, requestId: "s1", operation: "github.status", params: { identity: "worker" } },
      bridgeDeps({ env: { HOME: "/home/u", ORCA_PI_GITHUB_WORKER_TOKEN: "ghs_configured-12345678", ORCA_PI_GITHUB_WORKER_EXPIRES_AT: future } as NodeJS.ProcessEnv }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      const text = JSON.stringify(res.result);
      expect(text).toContain("worker");
      expect(text).toContain("redacted");
      expect(isSecretFreePayload(res.result)).toBe(true);
      expect(text).not.toContain("ghs_configured-12345678");
    }
  });

  it("reports missing credentials with source labels (no values)", async () => {
    const res = await handleBridgeRequest(
      { protocolVersion: 1, requestId: "s2", operation: "github.status", params: {} },
      bridgeDeps({ env: { HOME: "/home/u" } as NodeJS.ProcessEnv }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      const items = toGithubStatusItems(res.result);
      expect(items.length).toBe(2);
      expect(items.every((i) => i.configured === false)).toBe(true);
      expect(isSecretFreePayload(res.result)).toBe(true);
    }
  });

  it("reports expired tokens as expired (no values)", async () => {
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const res = await handleBridgeRequest(
      { protocolVersion: 1, requestId: "s3", operation: "github.status", params: { identity: "worker" } },
      bridgeDeps({ env: { HOME: "/home/u", ORCA_PI_GITHUB_WORKER_TOKEN: "ghs_expired-12345678", ORCA_PI_GITHUB_WORKER_EXPIRES_AT: past } as NodeJS.ProcessEnv }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      const text = JSON.stringify(res.result);
      expect(text).not.toContain("ghs_expired-12345678");
      expect(isSecretFreePayload(res.result)).toBe(true);
    }
  });

  it("rejects non-portable identity names (no exec, typed validation)", async () => {
    const res = await handleBridgeRequest(
      { protocolVersion: 1, requestId: "s4", operation: "github.status", params: { identity: "bad name!" } },
      bridgeDeps(),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("validation");
  });
});

describe("ui1.5: bridge github.doctor + diagnostics.doctor (redacted, CLI parity)", () => {
  it("returns redacted doctor without network (fail-closed proofs, no values)", async () => {
    const res = await handleBridgeRequest(
      { protocolVersion: 1, requestId: "d1", operation: "github.doctor", params: {} },
      bridgeDeps({
        env: { HOME: "/home/u", ORCA_PI_GITHUB_WORKER_TOKEN: "ghs_w-12345678", ORCA_PI_GITHUB_REVIEWER_TOKEN: "ghs_r-12345678" } as NodeJS.ProcessEnv,
      }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      const text = JSON.stringify(res.result);
      expect(text).not.toContain("ghs_w-12345678");
      expect(text).not.toContain("ghs_r-12345678");
      expect(text).not.toMatch(/BEGIN.*PRIVATE KEY/);
      expect(isSecretFreePayload(res.result)).toBe(true);
      expect((res.result as { redacted?: boolean }).redacted).toBe(true);
    }
  });

  it("validates repo shape for the access-test (typed, no exec)", async () => {
    const res = await handleBridgeRequest(
      { protocolVersion: 1, requestId: "d2", operation: "github.doctor", params: { repo: "not-a-repo" } },
      bridgeDeps(),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("validation");
  });

  it("diagnostics.doctor agrees with the CLI doctor (same runner, same versions)", async () => {
    const deps = bridgeDeps();
    const res = await handleBridgeRequest({ protocolVersion: 1, requestId: "diag1", operation: "diagnostics.doctor" }, deps);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const result = res.result as Record<string, unknown>;
      const cli = result["cli"] as { orca: { version?: string }; pi: { version?: string }; ok: boolean };
      expect(cli.orca.version).toBe("1.4.196");
      expect(cli.pi.version).toBe("0.84.4");
      expect(cli.ok).toBe(true);
      expect(result["bridgeVersion"]).toBe("1.0.0");
      expect(describeDiagnosticsCli(toDiagnosticsCliHealth(result))).toContain("1.4.196");
      expect(isSecretFreePayload(result)).toBe(true);
    }
  });
});

describe("ui1.5: degraded-host enforcement (existing capability rules preserved)", () => {
  it("rejects github reads while unstructured, keeps diagnostics.doctor available", async () => {
    const unstructured = { ...bridgeDeps(), transport: "seam" as const };
    for (const operation of ["github.status", "github.doctor", "profiles.list", "orchestration.get"]) {
      const res = await handleBridgeRequest({ protocolVersion: 1, requestId: "g1", operation }, unstructured);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(["auth/setup", "unsupported"]).toContain(res.error.code);
    }
    for (const operation of ["bridge.capabilities", "worktree.context", "diagnostics.doctor"]) {
      const res = await handleBridgeRequest({ protocolVersion: 1, requestId: "g2", operation }, unstructured);
      expect(res.ok).toBe(true);
    }
  });

  it("rejects with unsupported when consent holds but the seam is missing", async () => {
    const noSeam: BridgeHostDeps = {
      ...bridgeDeps(),
      transport: "seam",
      hostInfo: { appVersion: "1.4.199", pluginApi: 1, grantedCapabilities: ["workspace:read", "terminal:send"], seamAvailable: false },
    };
    const res = await handleBridgeRequest({ protocolVersion: 1, requestId: "g3", operation: "github.status" }, noSeam);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("unsupported");
  });
});

// ---------------------------------------------------------------------------
// Panel behavior: structured ops, redacted display, human actor, no shell
// ---------------------------------------------------------------------------

describe("ui1.5: panel honors the typed redacted contract", () => {
  it("wires role-scoped refresh/doctor/access-test over typed ops", () => {
    const html = controlHtml();
    for (const token of [
      "github.status",
      "github.doctor",
      "diagnostics.doctor",
      "profile.validate",
      "worktree.context",
      "orchestration.get",
      "btn-github-refresh",
      "btn-github-worker",
      "btn-github-reviewer",
      "btn-github-doctor",
      "github-repo",
      "github-ambient",
      "github-doctor",
      "github-actor",
      "github-setup",
      "github-mapped",
      "diagnostics-runtime",
      "diagnostics-bridge",
      "diagnostics-config",
      "diagnostics-worktree",
      "btn-diagnostics-reload",
      "44madfire",
      "never a credential slot",
      "Redacted",
      "installation",
      "permissions",
      "Refreshable",
      "Mapped Pi profiles",
      "orca-pi github mint",
      "orca-pi github auth status",
      "orca-pi doctor",
      "loadGithubStatus",
      "loadGithubDoctor",
      "loadDiagnostics",
      "githubStatusToken",
      "githubDoctorToken",
      "diagnosticsToken",
    ]) {
      expect(html).toContain(token);
    }
  });

  it("never escapes the sandbox or dumps raw payloads", () => {
    const html = controlHtml();
    for (const banned of ["node:child_process", "node:fs", "require(\"fs\")", "fetch(", "__ORCA_PI_PROFILES__"]) {
      expect(html).not.toContain(banned);
    }
    // No raw payload dump: allowlisted field rendering only.
    expect(html).not.toContain("JSON.stringify(res.result).slice(0, 3000)");
    expect(html).not.toContain("JSON.stringify(res.result, null, 2).slice(0, 5000)");
    // No secret value ever rendered: panel reads allowlisted keys only.
    expect(html).not.toMatch(/\.token\b/);
    expect(html).not.toContain("privateKey");
    expect(containsSecretMaterial(html)).toBe(false);
  });
});

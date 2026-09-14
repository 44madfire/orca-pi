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
  describeConfigPaths,
  describeDiagnosticsCli,
  describeDiagnosticsHost,
  describeDiagnosticsRuntime,
  describeGithubDoctorItem,
  describeGithubStatusItem,
  describeReviewActor,
  describeTokenFreshness,
  describeWorktreeHealth,
  diagnosticsHeadline,
  diagnosticsOverviewRows,
  DIAGNOSTICS_DETAIL_LIMIT,
  DIAGNOSTICS_HOST_CAPABILITIES,
  DIAGNOSTICS_OVERVIEW_LIMIT,
  GITHUB_DEFAULT_AMBIENT,
  GITHUB_DEFAULT_REPO,
  GITHUB_IDENTITIES,
  githubMappedSummary,
  githubSetupActions,
  HUMAN_REVIEW_ACTOR,
  isSecretFreePayload,
  mapGithubErrorToField,
  mergeGithubStatusSnapshots,
  redactDiagnosticsText,
  REVIEW_ACTOR_NOTE,
  sanitizeDiagnosticsDetail,
  toDiagnosticsBridgeHealth,
  toDiagnosticsGithubHealth,
  toDiagnosticsCliHealth,
  toDiagnosticsConfigHealth,
  toDiagnosticsConfigPaths,
  toDiagnosticsHostHealth,
  toDiagnosticsRuntimeHealth,
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
    expect(describeGithubStatusItem(items[0]!)).not.toMatch(/ghp_|gho_|ghu_|ghs_|PRIVATE KEY/);
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
    expect(JSON.stringify(items)).not.toMatch(/ghs_|ghp_|gho_|PRIVATE KEY/);
  });

  it("never throws on malformed payloads", () => {
    expect(toGithubStatusItems(null)).toEqual([]);
    expect(toGithubStatusItems({})).toEqual([]);
    expect(toGithubStatusItems({ identities: null })).toEqual([]);
  });

  it("drops smuggled token values via typed allowlisting (gho_ never reaches display)", () => {
    // Synthetic OAuth token — never a real credential. A compromised bridge
    // payload smuggling raw values must still render as redacted status
    // only: allowlisted fields survive, token values never pass through.
    const oauthToken = "gho_smuggledoauth0123456789";
    const items = toGithubStatusItems({
      identities: {
        worker: {
          configured: true,
          sourceLabel: "ORCA_PI_GITHUB_WORKER_TOKEN",
          token: oauthToken,
          ORCA_PI_GITHUB_WORKER_TOKEN: oauthToken,
        },
      },
    });
    expect(items.length).toBe(1);
    expect(JSON.stringify(items)).not.toContain(oauthToken);
    expect(containsSecretMaterial(JSON.stringify(items))).toBe(false);
    expect(isSecretFreePayload({ items })).toBe(true);
    for (const item of items) {
      expect(containsSecretMaterial(describeGithubStatusItem(item))).toBe(false);
      expect(containsSecretMaterial(describeTokenFreshness(item))).toBe(false);
    }
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
    expect(diagnosticsHeadline({ cli: { ok: true }, bridge: { structured: true }, config: { ok: true }, worktree: { ok: true }, github: { ok: true } })).toContain("ready");
    expect(diagnosticsHeadline({ cli: { ok: false }, bridge: { structured: false }, config: { ok: false }, worktree: { ok: false }, github: { ok: false } })).toContain("action needed");
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
    expect(containsSecretMaterial("gho_oauth1234567890ab")).toBe(true);
    expect(containsSecretMaterial("ghu_abcdefghij123456")).toBe(true);
    expect(containsSecretMaterial("ghs_abcdefghij123456")).toBe(true);
    expect(containsSecretMaterial("ghr_refresh1234567890")).toBe(true);
    expect(containsSecretMaterial("github_pat_ABCDEF1234567890")).toBe(true);
    expect(containsSecretMaterial("-----BEGIN PRIVATE KEY-----")).toBe(true);
    expect(containsSecretMaterial("x-access-token:abc123")).toBe(true);
  });

  it("accepts redacted payloads, rejects raw token payloads", () => {
    expect(isSecretFreePayload(statusPayload())).toBe(true);
    expect(isSecretFreePayload(doctorReport())).toBe(true);
    expect(isSecretFreePayload({ token: "ghs_abcdefghij123456" })).toBe(false);
    expect(isSecretFreePayload({ token: "gho_oauth1234567890ab" })).toBe(false);
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

// ---------------------------------------------------------------------------
// P1 regression: diagnostics.doctor never leaks runner stdout/stderr secrets
// ---------------------------------------------------------------------------

describe("ui1.5/p1: diagnostics detail sanitization (no runner secret crosses)", () => {
  const LEAK_TOKEN = "ghp_leakedsecret0123456789";
  const LEAK_KEY = "-----BEGIN PRIVATE KEY-----\nMIIEvwIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----";

  it("redacts token/key patterns from free text (pure)", () => {
    expect(redactDiagnosticsText("all clear")).toBe("all clear");
    expect(redactDiagnosticsText(`saw ${LEAK_TOKEN} here`)).not.toContain(LEAK_TOKEN);
    expect(redactDiagnosticsText(`saw ${LEAK_TOKEN} here`)).toContain("<redacted-token>");
    const oauthToken = "gho_oauthleaked0123456789";
    expect(redactDiagnosticsText(`saw ${oauthToken} here`)).not.toContain(oauthToken);
    expect(redactDiagnosticsText(`saw ${oauthToken} here`)).toContain("<redacted-token>");
    expect(containsSecretMaterial(oauthToken)).toBe(true);
    expect(isSecretFreePayload({ token: oauthToken })).toBe(false);
    expect(redactDiagnosticsText(`key ${LEAK_KEY} end`)).not.toContain("BEGIN PRIVATE KEY");
    expect(redactDiagnosticsText(`key ${LEAK_KEY} end`)).toContain("[redacted-private-key]");
    // Var-name labels alone are not values — left intact for actionable guidance.
    expect(redactDiagnosticsText("see ORCA_PI_GITHUB_WORKER_TOKEN")).toContain("ORCA_PI_GITHUB_WORKER_TOKEN");
  });

  it("bounds long details (actionable prefix survives, tail truncated)", () => {
    const long = `hint: run \`orca-pi doctor\`. ` + "x".repeat(DIAGNOSTICS_DETAIL_LIMIT + 200);
    const out = sanitizeDiagnosticsDetail(long);
    expect(out.length).toBeLessThanOrEqual(DIAGNOSTICS_DETAIL_LIMIT + "… [truncated]".length);
    expect(out).toContain("orca-pi doctor");
    expect(out).toContain("[truncated]");
    expect(sanitizeDiagnosticsDetail(undefined)).toBe("(no detail)");
    expect(sanitizeDiagnosticsDetail("")).toBe("(no detail)");
  });

  it("redacts explicit env secret values (non-token-like) when provided", () => {
    const secret = "my-ultra-secret-value-9999";
    const out = sanitizeDiagnosticsDetail(`Output: ${secret} happened`, DIAGNOSTICS_DETAIL_LIMIT, [secret]);
    expect(out).not.toContain(secret);
    expect(out).toContain("<redacted>");
  });

  it("toDiagnosticsCliHealth sanitizes details from a compromised payload", () => {
    const health = toDiagnosticsCliHealth({
      cli: {
        orca: { executable: "orca", found: false, detail: `boom ${LEAK_TOKEN} ${LEAK_KEY}` },
        pi: { executable: "pi", found: false, detail: "plain failure, see install hint" },
        ok: false,
      },
    })!;
    expect(containsSecretMaterial(health.orca.detail)).toBe(false);
    expect(isSecretFreePayload(health)).toBe(true);
    expect(health.pi.detail).toContain("install hint");
  });

  it("bridge diagnostics.doctor redacts secret-like runner output, keeps actionable diagnostics", async () => {
    const envSecret = "env-echoed-secret-4242";
    const leakyRunner = {
      async run(exe: string) {
        if (exe === "pi") {
          return { exitCode: 1, stdout: `helper said ${LEAK_TOKEN}`, stderr: `${LEAK_KEY} plus ${envSecret}` };
        }
        // orca: --version yields nothing, status --json fails with secret output.
        return { exitCode: 1, stdout: `status blew up with ${LEAK_TOKEN}`, stderr: `trace ${envSecret}` };
      },
    } as unknown as import("@orca-pi/core").ProcessRunner;
    const res = await handleBridgeRequest(
      { protocolVersion: 1, requestId: "leak1", operation: "diagnostics.doctor" },
      bridgeDeps({
        runner: leakyRunner,
        env: { HOME: "/home/u", ORCA_PI_GITHUB_WORKER_TOKEN: envSecret } as NodeJS.ProcessEnv,
      }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      const text = JSON.stringify(res.result);
      expect(text).not.toContain(LEAK_TOKEN);
      expect(text).not.toContain("BEGIN PRIVATE KEY");
      expect(text).not.toContain(envSecret);
      expect(containsSecretMaterial(text)).toBe(false);
      expect(isSecretFreePayload(res.result)).toBe(true);
      const cli = (res.result as Record<string, unknown>)["cli"] as {
        orca: { detail: string; found: boolean };
        pi: { detail: string; found: boolean };
      };
      // Actionable non-secret diagnostics survive: exit-code context + hints.
      expect(cli.pi.detail.length).toBeLessThanOrEqual(DIAGNOSTICS_DETAIL_LIMIT + 20);
      expect(cli.orca.detail.length).toBeLessThanOrEqual(DIAGNOSTICS_DETAIL_LIMIT + 20);
      expect(`${cli.pi.detail} ${cli.orca.detail}`).toMatch(/exit code|Install|not found|no.*version/i);
    }
  });

  it("panel renders sanitized (bounded/redacted) details, never raw cli.*.detail", () => {
    const html = controlHtml();
    expect(html).toContain("sanitizeDiagnosticsDetail");
    expect(html).toContain("redactDiagnosticsText");
    expect(html).toContain("sanitizeDiagnosticsDetail(cli.orca.detail)");
    expect(html).toContain("sanitizeDiagnosticsDetail(cli.pi.detail)");
    expect(html).not.toContain('esc(cli.orca.detail || "")');
    expect(html).not.toContain('esc(cli.pi.detail || "")');
    expect(containsSecretMaterial(html)).toBe(false);
  });

  it("generic bridge errors redact arbitrary env-backed secrets, not just known prefixes", async () => {
    // Synthetic fixtures only — never real credentials. Covers the generic
    // `toBridgeError` path (not just runner-detail sanitization): an
    // arbitrary `*TOKEN*` value with no known prefix plus a `gho_` OAuth
    // token must both be redacted from the error message without echoing
    // values, while actionable non-secret guidance survives.
    const arbitrarySecret = "env-arbitrary-secret-value-7788";
    const oauthToken = "gho_oauthbridgecheck0123456789";
    const badIdentity = `bad ${arbitrarySecret} ${oauthToken} name!`;
    const res = await handleBridgeRequest(
      { protocolVersion: 1, requestId: "bridge-err1", operation: "github.status", params: { identity: badIdentity } },
      bridgeDeps({ env: { HOME: "/home/u", ORCA_PI_GITHUB_WORKER_TOKEN: arbitrarySecret } as NodeJS.ProcessEnv }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const text = JSON.stringify(res.error);
      expect(text).not.toContain(arbitrarySecret);
      expect(text).not.toContain(oauthToken);
      expect(containsSecretMaterial(text)).toBe(false);
      expect(isSecretFreePayload(res.error)).toBe(true);
      // Actionable validation guidance survives redaction.
      expect(text).toMatch(/portable identity|expected/i);
      // Operator/CLI-only mint boundary preserved: no token minting in errors.
      expect(text).not.toMatch(/mint.*token|installation-token.*gho_/i);
    }
  });

  it("a throwing runner never leaks secret-bearing throw text via error response or payload", async () => {
    // Synthetic fixtures only — never real credentials.
    const throwToken = "ghp_thrownsecret0123456789";
    const throwKey = "-----BEGIN RSA PRIVATE KEY-----\nMIIBthrowkeymaterial\n-----END RSA PRIVATE KEY-----";
    const throwingRunner = {
      async run() {
        throw new Error(`spawn orca failed: helper echoed ${throwToken} and ${throwKey}`);
      },
    } as unknown as import("@orca-pi/core").ProcessRunner;
    const res = await handleBridgeRequest(
      { protocolVersion: 1, requestId: "throw1", operation: "diagnostics.doctor" },
      bridgeDeps({ runner: throwingRunner }),
    );
    // Collapsed to a degraded success — never an `internal` error carrying
    // the verbatim throw text (the Diagnostics DOM renders error messages).
    expect(res.ok).toBe(true);
    if (res.ok) {
      const text = JSON.stringify(res.result);
      expect(text).not.toContain(throwToken);
      expect(text).not.toContain("BEGIN RSA PRIVATE KEY");
      expect(text).not.toContain("MIIBthrowkeymaterial");
      expect(containsSecretMaterial(text)).toBe(false);
      expect(isSecretFreePayload(res.result)).toBe(true);
      // Actionable non-secret fallback survives: explicit CLI fallback.
      expect(text).toContain("orca-pi doctor");
      const cli = (res.result as Record<string, unknown>)["cli"];
      expect(typeof cli).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// P2 race: mapped role→profile→identity rerenders after every profiles.list
// ---------------------------------------------------------------------------

describe("ui1.5/p2: mapped profiles stay fresh regardless of response order", () => {
  const profilesPayload = [
    { name: "worker", githubIdentity: "worker" },
    { name: "reviewer", githubIdentity: "reviewer" },
    { name: "scout" },
  ];
  const orchPayload = {
    effective: { worker: "worker", scout: "scout", reviewer: "reviewer" },
    provenance: { worker: "builtin", scout: "builtin", reviewer: "builtin" },
  };

  function join(profiles: readonly unknown[], orchItems: ReturnType<typeof toOrchestrationItems>) {
    return toGithubMappedProfiles(profiles, orchItems);
  }

  it("profiles-first and orchestration-first converge to the same mapped rows", () => {
    // Order A: profiles.list wins first, orchestration.get second.
    const orchAfterProfiles = toOrchestrationItems(orchPayload, profilesPayload.map((p) => p.name));
    const rowsA = join(profilesPayload, orchAfterProfiles);
    // Order B: orchestration.get wins first (profiles unknown → blank, not
    // wrong), then profiles.list arrives and the rerender fills identities.
    const orchBeforeProfiles = toOrchestrationItems(orchPayload, []);
    const rowsBlank = join([], orchBeforeProfiles);
    expect(rowsBlank.find((r) => r.role === "worker")!.githubIdentity).toBeUndefined();
    const orchAfterLateProfiles = toOrchestrationItems(orchPayload, profilesPayload.map((p) => p.name));
    const rowsB = join(profilesPayload, orchAfterLateProfiles);
    expect(rowsB).toEqual(rowsA);
    expect(rowsB.find((r) => r.role === "worker")!.githubIdentity).toBe("worker");
    expect(rowsB.find((r) => r.role === "reviewer")!.githubIdentity).toBe("reviewer");
    expect(rowsB.find((r) => r.role === "scout")!.githubIdentity).toBeUndefined();
    expect(githubMappedSummary(rowsB)).toContain("worker→worker");
  });

  it("profile-identity edits propagate on the next profiles.list join", () => {
    const orchItems = toOrchestrationItems(orchPayload, ["worker", "scout", "reviewer"]);
    const before = join([{ name: "worker", githubIdentity: "worker" }], orchItems);
    expect(before.find((r) => r.role === "worker")!.githubIdentity).toBe("worker");
    const after = join([{ name: "worker", githubIdentity: "reviewer" }], orchItems);
    expect(after.find((r) => r.role === "worker")!.githubIdentity).toBe("reviewer");
  });

  it("panel rerenders mapped after every profiles.list + orchestration update", () => {
    const html = controlHtml();
    const bodyOf = (fn: string): string => {
      const start = html.indexOf(`function ${fn}(`);
      expect(start).toBeGreaterThan(-1);
      const next = html.indexOf("\n        function ", start + 1);
      return html.slice(start, next === -1 ? start + 8000 : next);
    };
    // Every profiles.list success path rerenders the mapped view.
    expect(bodyOf("refreshListOnly")).toContain("renderGithubMapped()");
    expect(bodyOf("refreshAll")).toContain("renderGithubMapped()");
    // Every orchestration.get success path rerenders the mapped view.
    expect(bodyOf("loadOrchestration")).toContain("renderGithubMapped()");
    expect(bodyOf("refreshOrchListOnly")).toContain("renderGithubMapped()");
  });
});

// ---------------------------------------------------------------------------
// P2 diagnostics readiness: unknown config is never "ready"
// ---------------------------------------------------------------------------

describe("ui1.5/p2: diagnostics headline never claims ready without validation", () => {
  const healthy = { cli: { ok: true }, bridge: { structured: true }, config: { ok: true }, worktree: { ok: true }, github: { ok: true } };
  it("requires explicit ok:true on every leg for ready", () => {
    expect(
      diagnosticsHeadline(healthy),
    ).toContain("ready");
    // Unknown (pending/unavailable/malformed/failed) legs are action-needed.
    expect(diagnosticsHeadline({ ...healthy, config: undefined })).toContain(
      "action needed",
    );
    expect(diagnosticsHeadline({ ...healthy, config: undefined })).toMatch(
      /pending\/unavailable/,
    );
    expect(diagnosticsHeadline({ cli: healthy.cli, bridge: healthy.bridge, worktree: healthy.worktree })).toContain("action needed");
    expect(
      diagnosticsHeadline({ ...healthy, config: { ok: false } }),
    ).toContain("action needed");
    expect(
      diagnosticsHeadline({ ...healthy, config: { ok: false } }),
    ).toMatch(/profiles need attention/);
  });

  it("requires an explicit healthy worktree result (pending/unavailable/failed never ready)", () => {
    const cliBridgeConfig = { cli: { ok: true }, bridge: { structured: true }, config: { ok: true }, github: { ok: true } };
    // Regression: CLI, bridge, and config all healthy, but worktree.context
    // rejects (pending) or fails — the headline must stay action-needed.
    expect(diagnosticsHeadline({ ...cliBridgeConfig, worktree: undefined })).toContain("action needed");
    expect(diagnosticsHeadline({ ...cliBridgeConfig, worktree: undefined })).toMatch(/worktree scope pending\/unavailable/);
    expect(diagnosticsHeadline({ ...cliBridgeConfig })).toContain("action needed");
    expect(diagnosticsHeadline({ ...cliBridgeConfig, worktree: { ok: false } })).toContain("action needed");
    expect(diagnosticsHeadline({ ...cliBridgeConfig, worktree: { ok: false } })).toMatch(/worktree scope unavailable/);
    expect(diagnosticsHeadline({ ...cliBridgeConfig, worktree: { ok: true } })).toContain("ready");
    // GitHub is required even when the four core legs are healthy.
    expect(diagnosticsHeadline({ cli: { ok: true }, bridge: { structured: true }, config: { ok: true }, worktree: { ok: true } })).toContain("action needed");
  });

  it("treats malformed/unavailable validate payloads as unknown (never valid)", () => {
    expect(toDiagnosticsConfigHealth(null)).toBeUndefined();
    expect(toDiagnosticsConfigHealth({})).toBeUndefined();
    // Entries without an explicit ok flag are malformed → unknown.
    expect(toDiagnosticsConfigHealth({ entries: [{ valid: true }] })).toBeUndefined();
    // Server ok:true contradicted by invalid entries fails closed.
    expect(toDiagnosticsConfigHealth({ entries: [{ valid: true }, { valid: false }], ok: true })!.ok).toBe(false);
    expect(toDiagnosticsConfigHealth({ entries: [{ valid: true }], ok: true })!.ok).toBe(true);
    // Unknown config never headlines as ready even with healthy CLI/bridge.
    expect(
      diagnosticsHeadline({
        cli: { ok: true },
        bridge: { structured: true },
        config: toDiagnosticsConfigHealth({ entries: [{ valid: true }] }) as never,
      }),
    ).toContain("action needed");
  });

  it("panel headline requires configOk === true and handles rejection/unavailable", () => {
    const html = controlHtml();
    expect(html).toContain("configOk === true");
    expect(html).not.toMatch(/configOk !== false\)/);
    expect(html).toContain("profiles validation pending/unavailable");
    // profile.validate uses explicit ok:true (malformed never ready).
    expect(html).toContain("res.result.ok === true && invalid === 0");
    expect(html).not.toContain("res.result.ok !== false && invalid === 0");
    // Rejected validate requests fail closed and still update the headline.
    expect(html).toContain("profile validation failed (bridge request failed)");
  });
});

// ---------------------------------------------------------------------------
// P2 scoped-refresh merge: partial github.status never hides the sibling
// ---------------------------------------------------------------------------

describe("ui1.5/p2: scoped status merges into the panel snapshot", () => {
  const fullSnapshot = {
    identities: {
      worker: { identity: "worker", configured: true, sourceLabel: "ORCA_PI_GITHUB_WORKER_TOKEN", expired: false },
      reviewer: { identity: "reviewer", configured: true, sourceLabel: "ORCA_PI_GITHUB_REVIEWER_TOKEN", expired: false },
    },
    redacted: true,
  };
  const workerOnly = {
    identities: {
      worker: { identity: "worker", configured: true, sourceLabel: "ORCA_PI_GITHUB_WORKER_TOKEN", expiresAt: "2030-01-01T00:00:00.000Z", expired: false },
    },
    redacted: true,
  };
  const reviewerOnly = {
    identities: {
      reviewer: { identity: "reviewer", configured: false, sourceLabel: "ORCA_PI_GITHUB_REVIEWER_TOKEN" },
    },
    redacted: true,
  };

  it("Refresh worker preserves Reviewer (scoped next wins per identity)", () => {
    const merged = mergeGithubStatusSnapshots(fullSnapshot, workerOnly);
    const items = toGithubStatusItems(merged);
    expect(items.map((i) => i.identity).sort()).toEqual(["reviewer", "worker"]);
    // Fresh worker fields land; reviewer snapshot untouched.
    expect(items.find((i) => i.identity === "worker")!.expiresAt).toContain("2030");
    expect(items.find((i) => i.identity === "reviewer")!.configured).toBe(true);
    expect(isSecretFreePayload(merged)).toBe(true);
  });

  it("Refresh reviewer preserves Worker", () => {
    const merged = mergeGithubStatusSnapshots(fullSnapshot, reviewerOnly);
    const items = toGithubStatusItems(merged);
    expect(items.map((i) => i.identity).sort()).toEqual(["reviewer", "worker"]);
    expect(items.find((i) => i.identity === "reviewer")!.configured).toBe(false);
    expect(items.find((i) => i.identity === "worker")!.configured).toBe(true);
  });

  it("sequential scoped refreshes converge (worker then reviewer)", () => {
    const afterWorker = mergeGithubStatusSnapshots(fullSnapshot, workerOnly);
    const afterBoth = mergeGithubStatusSnapshots(afterWorker, reviewerOnly);
    const items = toGithubStatusItems(afterBoth);
    expect(items.find((i) => i.identity === "worker")!.expiresAt).toContain("2030");
    expect(items.find((i) => i.identity === "reviewer")!.configured).toBe(false);
  });

  it("never throws on malformed snapshots and drops non-record entries", () => {
    expect(mergeGithubStatusSnapshots(null, workerOnly)).toEqual(workerOnly);
    expect(toGithubStatusItems(mergeGithubStatusSnapshots(fullSnapshot, null))).toHaveLength(2);
    const poisoned = mergeGithubStatusSnapshots(fullSnapshot, {
      identities: { worker: { configured: true, sourceLabel: "x" }, evil: 42, "": { configured: true } },
    });
    const identities = (poisoned.identities as Record<string, unknown>);
    expect(Object.keys(identities).sort()).toEqual(["reviewer", "worker"]);
    expect(isSecretFreePayload(poisoned)).toBe(true);
  });

  it("panel merges scoped results before rendering", () => {
    const html = controlHtml();
    expect(html).toContain("mergeGithubStatus");
    expect(html).toContain("state.githubStatus = mergeGithubStatus(state.githubStatus, res.result)");
    expect(html).toContain("renderGithubStatus(state.githubStatus)");
    expect(html).not.toContain("state.githubStatus = res.result;");
  });
});

// ---------------------------------------------------------------------------
// UI1.5 Diagnostics: one-place redacted overview (runtime/bridge/worktree/
// profiles+paths/roles/launch/GitHub) + worktree-gated headline wiring
// ---------------------------------------------------------------------------

describe("ui1.5: diagnostics one-place overview rows", () => {
  const fullInput = {
    diagnostics: {
      orcaPiVersion: "0.1.0",
      bridgeVersion: "1.0.0",
      protocolVersion: 1,
      cli: {
        orca: { executable: "orca", found: true, version: "1.4.196", detail: "orca 1.4.196" },
        pi: { executable: "pi", found: true, version: "0.84.4", detail: "pi 0.84.4" },
        ok: true,
      },
      bridge: { structured: true, degraded: false, versionsOk: true, consentOk: true, seamHandshake: true, supportedOperations: ["profiles.list", "launch.preview"], reasons: [] },
    },
    validate: { entries: [{ name: "worker", valid: true }], ok: true },
    profilesList: {
      summaries: [{ name: "worker", thinking: "high", skillNames: [], skillCount: 0, extensionCount: 0, contextFiles: true, extendsChain: ["worker"], valid: true }],
      panel: {
        profiles: [],
        validation: { ok: true, invalidCount: 0 },
        config: { userPath: "/home/u/.pi/profiles.yaml", projectPath: "/repo/p/.pi/profiles.yaml", userExists: true, projectExists: false },
      },
    },
    orchestration: {
      effective: { worker: "worker", reviewer: "reviewer" },
      provenance: { worker: "builtin", reviewer: "builtin" },
    },
    knownProfiles: ["worker", "reviewer"],
    githubStatus: {
      identities: {
        worker: { configured: true, sourceLabel: "ORCA_PI_GITHUB_WORKER_TOKEN", expired: false },
        reviewer: { configured: true, sourceLabel: "ORCA_PI_GITHUB_REVIEWER_TOKEN", expired: false },
      },
      redacted: true,
    },
    githubDoctor: {
      workerLogin: "orca-pi-worker[bot]",
      reviewerLogin: "orca-pi-reviewer[bot]",
      ambientLogin: "44madfire",
      distinctWorkerReviewer: true,
      distinctFromAmbient: true,
      distinctDetail: "orca-pi-worker[bot] != orca-pi-reviewer[bot] != 44madfire : distinct (ok)",
      setupNeeded: [],
      ok: true,
    },
    launchPreviewSupported: true,
    worktree: { projectRoot: "/repo/p", explicit: true },
  };

  it("reports all required health in row order without secrets", () => {
    const rows = diagnosticsOverviewRows(fullInput);
    expect(rows.map((r) => r.label)).toEqual([
      "Runtime", "Bridge", "Worktree", "Profiles", "Roles", "Launch", "GitHub status", "GitHub doctor",
    ]);
    const byLabel = new Map(rows.map((r) => [r.label, r.detail]));
    expect(byLabel.get("Runtime")).toContain("orca 1.4.196");
    expect(byLabel.get("Runtime")).toContain("orca-pi 0.1.0");
    expect(byLabel.get("Bridge")).toContain("structured");
    expect(byLabel.get("Worktree")).toContain("/repo/p");
    expect(byLabel.get("Profiles")).toContain("all 1 valid");
    expect(byLabel.get("Profiles")).toContain("/home/u/.pi/profiles.yaml (present)");
    expect(byLabel.get("Profiles")).toContain("/repo/p/.pi/profiles.yaml (absent)");
    expect(byLabel.get("Roles")).toContain("worker→worker");
    expect(byLabel.get("Roles")).toContain("reviewer→reviewer");
    expect(byLabel.get("Launch")).toContain("launch.preview");
    expect(byLabel.get("GitHub status")).toContain("worker: configured");
    expect(byLabel.get("GitHub doctor")).toContain("distinct (ok)");
    for (const row of rows) {
      expect(containsSecretMaterial(row.detail)).toBe(false);
      expect(isSecretFreePayload({ detail: row.detail })).toBe(true);
    }
  });

  it("renders missing legs as pending/unavailable, never healthy", () => {
    const rows = diagnosticsOverviewRows({});
    expect(rows).toHaveLength(8);
    const text = rows.map((r) => `${r.label}: ${r.detail}`).join("\n");
    expect(text).toMatch(/unavailable|pending|not loaded|not run|no mappings/);
    expect(text).not.toMatch(/— ready/);
    expect(text).not.toContain("distinct (ok)");
    expect(text).not.toMatch(/all [1-9]\d* valid/);
    expect(text).not.toMatch(/all [1-9]\d* mapping/);
    for (const row of rows) expect(containsSecretMaterial(row.detail)).toBe(false);
  });

  it("extracts config paths allowlist-only (never values)", () => {
    expect(toDiagnosticsConfigPaths(null)).toBeUndefined();
    expect(toDiagnosticsConfigPaths({})).toBeUndefined();
    expect(toDiagnosticsConfigPaths({ panel: {} })).toBeUndefined();
    const paths = toDiagnosticsConfigPaths(fullInput.profilesList)!;
    expect(paths.userPath).toBe("/home/u/.pi/profiles.yaml");
    expect(paths.projectExists).toBe(false);
    expect(describeConfigPaths(undefined)).toContain("unavailable");
    expect(describeConfigPaths(paths)).toContain("absent");
    expect(isSecretFreePayload(paths)).toBe(true);
  });

  it("panel tracks the worktree leg and renders the one-place overview", () => {
    const html = controlHtml();
    // Five-leg headline with explicit worktree + GitHub gating.
    expect(html).toContain("renderDiagnosticsHeadline(cliOk, bridgeStructured, configOk, worktreeOk, githubOk");
    expect(html).toContain("worktree scope pending/unavailable");
    expect(html).toContain("worktree scope unavailable");
    expect(html).toContain("worktree scope confirmed");
    // worktree.context failure/rejection can never leave a ready headline.
    expect(html).toContain("worktreeOk = false");
    expect(html).toContain("worktree context failed (bridge request failed)");
    // Raw typed payloads feed the overview (in-memory state only).
    expect(html).toContain("state.profilesRaw");
    expect(html).toContain("state.diagnosticsValidate");
    expect(html).toContain("state.diagnosticsWorktree");
    // One-place surface with all required rows, sanitized before esc().
    expect(html).toContain('id="diagnostics-overview"');
    expect(html).toContain("function renderDiagnosticsOverview()");
    for (const label of ["Runtime", "Bridge", "Worktree", "Profiles", "Roles", "Launch", "GitHub status", "GitHub doctor"]) {
      expect(html).toContain(`"${label}"`);
    }
    expect(html).toContain("sanitizeDiagnosticsDetail(rows[i][1])");
    expect(containsSecretMaterial(html)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// UI1.5 gap fix: typed runtime/host context in the one-place overview
// (Orca app version, plugin API / Host capability status, Node/OS/WSL)
// ---------------------------------------------------------------------------

describe("ui1.5: diagnostics typed host/runtime context (no CLI-only overview)", () => {
  it("normalizes host health allowlist-only with truthful unknown states", () => {
    expect(toDiagnosticsHostHealth(null)).toBeUndefined();
    expect(toDiagnosticsHostHealth({})).toBeUndefined();
    const full = toDiagnosticsHostHealth({
      host: { appVersion: "1.4.197", pluginApi: 1, grantedCapabilities: ["workspace:read", "terminal:send", "bogus-cap"], versionsOk: true, consentOk: true, seamHandshake: true, structured: true },
      bridge: { structured: true, versionsOk: true, consentOk: true, seamHandshake: true, supportedOperations: [], reasons: [] },
      transport: { mode: "seam" },
    })!;
    expect(full.appVersion).toBe("1.4.197");
    expect(full.pluginApi).toBe(1);
    expect(full.grantedCapabilities).toEqual(["workspace:read", "terminal:send"]);
    expect(full.transportMode).toBe("seam");
    expect(describeDiagnosticsHost(full)).toContain("Orca app 1.4.197");
    expect(describeDiagnosticsHost(full)).toContain("pluginApi 1");
    expect(describeDiagnosticsHost(full)).toContain("workspace:read");
    expect(describeDiagnosticsHost(full)).toContain("transport seam");
    expect(isSecretFreePayload(full)).toBe(true);
    // Non-allowlisted caps and malformed versions are dropped, never rendered.
    const dirty = toDiagnosticsHostHealth({
      host: { appVersion: "not a version!!", pluginApi: 1.5, grantedCapabilities: ["workspace:read", "exec", 42] },
      bridge: { structured: false, supportedOperations: [], reasons: [] },
    })!;
    expect(dirty.appVersion).toBeUndefined();
    expect(dirty.pluginApi).toBeUndefined();
    expect(dirty.grantedCapabilities).toEqual(["workspace:read"]);
    expect(describeDiagnosticsHost(dirty)).toContain("(unknown version)");
    expect(describeDiagnosticsHost(dirty)).toContain("pluginApi unknown");
    // Missing legs never claim healthy: unknown renders as unknown/degraded.
    expect(describeDiagnosticsHost(undefined)).toContain("unknown");
    expect(describeDiagnosticsHost(undefined)).not.toContain("structured; transport seam");
    expect(describeDiagnosticsHost({})).toContain("unknown");
  });

  it("normalizes runtime health allowlist-only (Node/OS/WSL where available)", () => {
    expect(toDiagnosticsRuntimeHealth(null)).toBeUndefined();
    expect(toDiagnosticsRuntimeHealth({})).toBeUndefined();
    const win = toDiagnosticsRuntimeHealth({ runtime: { node: "v22.14.0", platform: "win32", arch: "x64", wsl: "native" } })!;
    expect(win.node).toBe("v22.14.0");
    expect(describeDiagnosticsRuntime(win)).toContain("Node v22.14.0");
    expect(describeDiagnosticsRuntime(win)).toContain("win32/x64");
    expect(describeDiagnosticsRuntime(win)).toContain("native Windows");
    const wsl = toDiagnosticsRuntimeHealth({ runtime: { node: "v20.0.0", platform: "linux", arch: "x64", wsl: "wsl:Ubuntu" } })!;
    expect(describeDiagnosticsRuntime(wsl)).toContain("WSL distro Ubuntu");
    const unknown = toDiagnosticsRuntimeHealth({ runtime: { wsl: "wsl-unknown-distro" } })!;
    expect(describeDiagnosticsRuntime(unknown)).toContain("WSL (distro unknown)");
    // Malformed/injected fields are dropped; overly long values never survive.
    const evil = toDiagnosticsRuntimeHealth({
      runtime: { node: "v22.14.0; rm -rf /", platform: "win32", arch: "x64", wsl: "native", extra: "ghp_leakedsecret0123456789" },
    })!;
    expect(evil.node).toBeUndefined();
    expect((evil as Record<string, unknown>)["extra"]).toBeUndefined();
    expect(describeDiagnosticsRuntime(evil)).toContain("(unknown)");
    expect(containsSecretMaterial(describeDiagnosticsRuntime(evil))).toBe(false);
    expect(describeDiagnosticsRuntime(undefined)).toContain("OS context unknown");
    expect(isSecretFreePayload(win)).toBe(true);
  });

  it("overview Runtime exposes host/runtime context, not only CLI versions", () => {
    const rows = diagnosticsOverviewRows({
      diagnostics: {
        orcaPiVersion: "0.1.0",
        bridgeVersion: "1.0.0",
        protocolVersion: 1,
        cli: {
          orca: { executable: "orca", found: true, version: "1.4.197", detail: "orca 1.4.197" },
          pi: { executable: "pi", found: true, version: "0.84.4", detail: "pi 0.84.4" },
          ok: true,
        },
        bridge: { structured: true, degraded: false, versionsOk: true, consentOk: true, seamHandshake: true, supportedOperations: ["profiles.list"], reasons: [] },
        host: { appVersion: "1.4.197", pluginApi: 1, grantedCapabilities: ["workspace:read"], versionsOk: true, consentOk: true, seamHandshake: true, structured: true },
        runtime: { node: "v22.14.0", platform: "win32", arch: "x64", wsl: "native" },
        transport: { mode: "seam" },
      },
      validate: { entries: [{ name: "worker", valid: true }], ok: true },
      orchestration: { effective: { worker: "worker" }, provenance: {} },
      knownProfiles: ["worker"],
    });
    const byLabel = new Map(rows.map((r) => [r.label, r.detail]));
    const runtime = byLabel.get("Runtime")!;
    expect(runtime).toContain("orca 1.4.197");
    expect(runtime).toContain("Orca app 1.4.197");
    expect(runtime).toContain("pluginApi 1");
    expect(runtime).toContain("workspace:read");
    expect(runtime).toContain("Node v22.14.0");
    expect(runtime).toContain("win32/x64");
    expect(runtime).toContain("native Windows");
    expect(byLabel.get("Bridge")).toContain("transport seam");
    for (const row of rows) {
      expect(containsSecretMaterial(row.detail)).toBe(false);
      expect(isSecretFreePayload({ detail: row.detail })).toBe(true);
      expect(row.detail.length).toBeLessThanOrEqual(DIAGNOSTICS_OVERVIEW_LIMIT + 5);
    }
  });

  it("overview renders missing host/runtime as unknown, never healthy", () => {
    const rows = diagnosticsOverviewRows({ diagnostics: { cli: { orca: { found: false, detail: "x" }, pi: { found: false, detail: "y" }, ok: false } } });
    const byLabel = new Map(rows.map((r) => [r.label, r.detail]));
    expect(byLabel.get("Runtime")).toMatch(/unknown/i);
    expect(byLabel.get("Runtime")).not.toContain("Orca app 1.4.197");
    expect(byLabel.get("Bridge")).toMatch(/unavailable|unknown|degraded/);
    expect(byLabel.get("Runtime")).not.toMatch(/native Windows.*ready|WSL distro.*ready/);
  });

  it("panel overview + drill-down render typed host/runtime (allowlisted, escaped)", () => {
    const html = controlHtml();
    for (const token of ["hostLineFor", "runtimeLineFor", "transportModeFor", "HOST_CAPS", "Orca app", "native Windows", "WSL distro", "transport"]) {
      expect(html).toContain(token);
    }
    // Drill-down boxes surface the same typed context.
    expect(html).toContain("<strong>Host</strong>");
    expect(html).toContain("<strong>OS runtime</strong>");
    expect(html).not.toMatch(/\.token\b/);
    expect(html).not.toContain("privateKey");
    expect(containsSecretMaterial(html)).toBe(false);
  });
});

describe("ui1.5: diagnostics.doctor bridge payload (typed host/runtime, secret-free)", () => {
  it("returns host/runtime/transport alongside CLI + bridge (bounded, allowlisted)", async () => {
    const res = await handleBridgeRequest(
      { protocolVersion: 1, requestId: "hr1", operation: "diagnostics.doctor" },
      bridgeDeps({
        transport: "seam",
        hostInfo: { appVersion: "1.4.197", pluginApi: 1, grantedCapabilities: ["workspace:read", "terminal:send", "nope"], seamAvailable: true },
        runtimeInfo: { nodeVersion: "v22.14.0", platform: "win32", arch: "x64", wsl: "native" },
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const result = res.result as Record<string, unknown>;
    const host = result["host"] as Record<string, unknown>;
    expect(host["appVersion"]).toBe("1.4.197");
    expect(host["pluginApi"]).toBe(1);
    expect(host["grantedCapabilities"]).toEqual(["workspace:read", "terminal:send"]);
    const runtime = result["runtime"] as Record<string, unknown>;
    expect(runtime["node"]).toBe("v22.14.0");
    expect(runtime["platform"]).toBe("win32");
    expect(runtime["wsl"]).toBe("native");
    expect((result["transport"] as Record<string, unknown>)["mode"]).toBe("seam");
    expect(isSecretFreePayload(result)).toBe(true);
    expect(containsSecretMaterial(JSON.stringify(result))).toBe(false);
    // Overview agrees with the bridge payload (same typed data, no scrape).
    const rows = diagnosticsOverviewRows({ diagnostics: result });
    const byLabel = new Map(rows.map((r) => [r.label, r.detail]));
    expect(byLabel.get("Runtime")).toContain("Orca app 1.4.197");
    expect(byLabel.get("Runtime")).toContain("Node v22.14.0");
  });

  it("derives WSL context truthfully and degrades unknown host versions", async () => {
    const wsl = await handleBridgeRequest(
      { protocolVersion: 1, requestId: "hr2", operation: "diagnostics.doctor" },
      bridgeDeps({
        env: { HOME: "/home/u", WSL_DISTRO_NAME: "Ubuntu" } as NodeJS.ProcessEnv,
        runtimeInfo: { nodeVersion: "v20.0.0", platform: "linux", arch: "x64" },
      }),
    );
    expect(wsl.ok).toBe(true);
    if (wsl.ok) {
      const runtime = (wsl.result as Record<string, unknown>)["runtime"] as Record<string, unknown>;
      expect(runtime["wsl"]).toBe("wsl:Ubuntu");
    }
    const unknown = await handleBridgeRequest(
      { protocolVersion: 1, requestId: "hr3", operation: "diagnostics.doctor" },
      bridgeDeps({ hostInfo: undefined, runtimeInfo: { nodeVersion: "v22.14.0", platform: "win32", arch: "x64", wsl: "native" } }),
    );
    expect(unknown.ok).toBe(true);
    if (unknown.ok) {
      const host = (unknown.result as Record<string, unknown>)["host"] as Record<string, unknown>;
      expect(host["appVersion"]).toBeUndefined();
      expect(host["pluginApi"]).toBeUndefined();
      expect(describeDiagnosticsHost(toDiagnosticsHostHealth(unknown.result))).toContain("unknown");
    }
  });

  it("never leaks injected secrets via payload or overview", async () => {
    const secret = "ghp_leakedsecret0123456789";
    const res = await handleBridgeRequest(
      { protocolVersion: 1, requestId: "hr4", operation: "diagnostics.doctor" },
      bridgeDeps({ env: { HOME: "/home/u", ORCA_PI_GITHUB_WORKER_TOKEN: secret } as NodeJS.ProcessEnv }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      const text = JSON.stringify(res.result);
      expect(text).not.toContain(secret);
      expect(isSecretFreePayload(res.result)).toBe(true);
    }
  });
});

describe("ui1.5: bridge error paths stay secret-free (hardened)", () => {
  it("redacts token patterns from validation errors instead of echoing values", async () => {
    const leaked = "ghp_leakedsecret0123456789";
    const res = await handleBridgeRequest(
      { protocolVersion: 1, requestId: "e-secret", operation: "github.doctor", params: { repo: `bad repo ${leaked}` } },
      bridgeDeps(),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).not.toContain(leaked);
      expect(res.error.message).toContain("<redacted-token>");
      expect(containsSecretMaterial(res.error.message)).toBe(false);
    }
  });

  it("rejects raw token/private-key payload shapes as secret-bearing", () => {
    expect(isSecretFreePayload({ token: "ghs_abcdefghij123456" })).toBe(false);
    expect(isSecretFreePayload({ ORCA_PI_GITHUB_WORKER_TOKEN: "raw-secret-value-123" })).toBe(false);
    expect(isSecretFreePayload({ privateKey: "raw-secret-value-123456" })).toBe(false);
    expect(isSecretFreePayload({ sourceLabel: "ORCA_PI_GITHUB_WORKER_TOKEN" })).toBe(true);
    expect(isSecretFreePayload({ tokenRefreshable: true })).toBe(true);
    expect(DIAGNOSTICS_HOST_CAPABILITIES).toContain("workspace:read");
  });
});

// ---------------------------------------------------------------------------
// Blockers: early-rejection sanitization (parse + transport gate)
// Every outgoing handleBridgeRequest error — including parseBridgeRequest
// failures and enforceTransportGate responses — passes through the same
// diagnostics redaction/bounding sanitizer. Stable request IDs and
// machine-readable codes preserved; no synthetic secret values echo.
// ---------------------------------------------------------------------------

describe("ui1.5/blocker: early-rejection errors are redacted + bounded (parse + gate)", () => {
  const SYN_GHP = "ghp_synthetictest0123456789ABCD";
  const SYN_GHO = "gho_synthetictest0123456789ABCD";
  const SYN_ENV = "env-synthetic-secret-99112233";
  const SYN_KEY = "-----BEGIN PRIVATE KEY-----\nMIIEsyntheticTestKeyMaterial0123456789\n-----END PRIVATE KEY-----";

  it("invalid protocolVersion echoes no token/private-key/env values (unsupported + stable id)", async () => {
    const res = await handleBridgeRequest(
      { protocolVersion: SYN_GHP, requestId: "early-proto1", operation: "profiles.list" },
      bridgeDeps({ env: { HOME: "/home/u", ORCA_PI_GITHUB_WORKER_TOKEN: SYN_ENV } as NodeJS.ProcessEnv }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.requestId).toBe("early-proto1");
      expect(res.error.code).toBe("unsupported");
      const text = JSON.stringify(res.error);
      expect(text).not.toContain(SYN_GHP);
      expect(text).not.toContain(SYN_ENV);
      expect(containsSecretMaterial(text)).toBe(false);
      expect(isSecretFreePayload(res.error)).toBe(true);
      expect(text).toContain("<redacted-token>");
      expect(res.error.message.length).toBeLessThanOrEqual(DIAGNOSTICS_DETAIL_LIMIT + 20);
    }
  });

  it("invalid operation echoes no token/private-key values (validation + stable id + detail)", async () => {
    const evilOp = `exec ${SYN_GHO} ${SYN_KEY}`;
    const res = await handleBridgeRequest(
      { protocolVersion: 1, requestId: "early-op1", operation: evilOp },
      bridgeDeps(),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.requestId).toBe("early-op1");
      expect(res.error.code).toBe("validation");
      const text = JSON.stringify(res.error);
      expect(text).not.toContain(SYN_GHO);
      expect(text).not.toContain("BEGIN PRIVATE KEY");
      expect(containsSecretMaterial(text)).toBe(false);
      expect(isSecretFreePayload(res.error)).toBe(true);
      expect(res.error.message).toContain("<redacted-token>");
      expect(res.error.message).toContain("[redacted-private-key]");
      // Machine-readable detail preserved for allowlist branch.
      expect((res.error as { detail?: string }).detail).toBe("allowlisted-operations-only");
    }
  });

  it("invalid worktree-root echoes no token/env values (validation + stable id)", async () => {
    const evilRoot = `relative-${SYN_GHP}-${SYN_ENV}`;
    const res = await handleBridgeRequest(
      {
        protocolVersion: 1,
        requestId: "early-wt1",
        operation: "profile.mutate",
        worktree: { projectRoot: evilRoot },
        params: { action: "create", name: "x", scope: "project" },
      },
      bridgeDeps({ env: { HOME: "/home/u", ORCA_PI_GITHUB_WORKER_TOKEN: SYN_ENV } as NodeJS.ProcessEnv }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.requestId).toBe("early-wt1");
      expect(res.error.code).toBe("validation");
      const text = JSON.stringify(res.error);
      expect(text).not.toContain(SYN_GHP);
      expect(text).not.toContain(SYN_ENV);
      expect(containsSecretMaterial(text)).toBe(false);
      expect(isSecretFreePayload(res.error)).toBe(true);
      expect(res.error.message).toMatch(/absolute/);
    }
  });

  it("trusted-root gate echoes no token/private-key/env values (validation + untrusted-scope)", async () => {
    const evilRoot = `/other/${SYN_GHO}`;
    const res = await handleBridgeRequest(
      { protocolVersion: 1, requestId: "early-trust1", operation: "profiles.list", worktree: { projectRoot: evilRoot } },
      bridgeDeps({
        transport: "operator",
        trustedProjectRoot: "/repo/p",
        env: { HOME: "/home/u", ORCA_PI_GITHUB_WORKER_TOKEN: SYN_ENV } as NodeJS.ProcessEnv,
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.requestId).toBe("early-trust1");
      expect(res.error.code).toBe("validation");
      expect((res.error as { detail?: string }).detail).toBe("untrusted-scope");
      const text = JSON.stringify(res.error);
      expect(text).not.toContain(SYN_GHO);
      expect(text).not.toContain(SYN_ENV);
      expect(containsSecretMaterial(text)).toBe(false);
      expect(isSecretFreePayload(res.error)).toBe(true);
    }
  });

  it("trusted-root gate with private-key material redacts key blocks (stable id + bounded)", async () => {
    const evilRoot = `relative------BEGIN PRIVATE KEY-----${SYN_ENV}`;
    const res = await handleBridgeRequest(
      { protocolVersion: 1, requestId: "early-trust2", operation: "profile.mutate", worktree: { projectRoot: evilRoot }, params: { action: "create", name: "y", scope: "project" } },
      bridgeDeps({
        transport: "operator",
        trustedProjectRoot: "/repo/p",
        env: { HOME: "/home/u", ORCA_PI_GITHUB_WORKER_TOKEN: SYN_ENV } as NodeJS.ProcessEnv,
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.requestId).toBe("early-trust2");
      const text = JSON.stringify(res.error);
      expect(text).not.toContain("BEGIN PRIVATE KEY");
      expect(text).not.toContain(SYN_ENV);
      expect(containsSecretMaterial(text)).toBe(false);
      expect(res.error.message.length).toBeLessThanOrEqual(DIAGNOSTICS_DETAIL_LIMIT + 20);
    }
  });

  it("long secret-bearing early rejections are bounded (actionable prefix survives)", async () => {
    const longOp = `exec ${SYN_GHP} ` + "x".repeat(2000);
    const res = await handleBridgeRequest(
      { protocolVersion: 1, requestId: "early-bound1", operation: longOp },
      bridgeDeps(),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.requestId).toBe("early-bound1");
      const text = JSON.stringify(res.error);
      expect(text).not.toContain(SYN_GHP);
      expect(res.error.message.length).toBeLessThanOrEqual(DIAGNOSTICS_DETAIL_LIMIT + 20);
      expect(res.error.message).toContain("[truncated]");
    }
  });
});

// ---------------------------------------------------------------------------
// Blocker: success-then-failed-reload never renders stale overview
// At the start of each loadDiagnostics run the panel clears per-run
// state.diagnostics / diagnosticsValidate / diagnosticsWorktree, and clears
// them on diagnostics.doctor failure/rejection too.
// ---------------------------------------------------------------------------

describe("ui1.5/blocker: diagnostics reload clears stale overview (success-then-failed-reload)", () => {
  it("panel clears per-run legs at start and on doctor failure (no stale render)", () => {
    const html = controlHtml();
    // Per-run clearing at the start of loadDiagnostics.
    expect(html).toContain("state.diagnostics = null;");
    expect(html).toContain("state.diagnosticsValidate = null;");
    expect(html).toContain("state.diagnosticsWorktree = null;");
    // Start clears before any leg lands and re-renders pending overview.
    const startIdx = html.indexOf("Per-run clearing");
    expect(startIdx).toBeGreaterThan(-1);
    // Doctor failure/rejection clears all three legs and re-renders.
    expect(html).toContain("diagnostics.doctor failure/rejection clears the per-run legs");
    expect(html).toContain("Could not load diagnostics.");
    // Failure paths still update the headline/overview (no frozen stale DOM).
    const failIdx = html.indexOf("Could not load diagnostics.");
    const doneAfterFail = html.indexOf("done();", failIdx);
    expect(doneAfterFail).toBeGreaterThan(failIdx);
    // Token guards keep concurrent successful legs from resurrecting stale runs.
    expect(html).toContain("myTok !== state.diagnosticsToken");
    expect(containsSecretMaterial(html)).toBe(false);
  });

  it("cleared overview renders pending, never the prior success rows", () => {
    const prior = diagnosticsOverviewRows({
      diagnostics: {
        orcaPiVersion: "0.1.0",
        bridgeVersion: "1.0.0",
        protocolVersion: 1,
        cli: {
          orca: { executable: "orca", found: true, version: "1.4.196", detail: "orca 1.4.196" },
          pi: { executable: "pi", found: true, version: "0.84.4", detail: "pi 0.84.4" },
          ok: true,
        },
        bridge: { structured: true, degraded: false, versionsOk: true, consentOk: true, seamHandshake: true, supportedOperations: ["profiles.list"], reasons: [] },
      },
      validate: { entries: [{ name: "worker", valid: true }], ok: true },
      profilesList: {
        panel: { config: { userPath: "/home/u/.pi/profiles.yaml", projectPath: "/repo/p/.pi/profiles.yaml", userExists: true, projectExists: false } },
      },
      orchestration: { effective: { worker: "worker" }, provenance: {} },
      knownProfiles: ["worker"],
      githubStatus: statusPayload(),
      githubDoctor: doctorReport(),
      launchPreviewSupported: true,
      worktree: { projectRoot: "/repo/p", explicit: true },
    });
    const priorText = prior.map((r) => `${r.label}: ${r.detail}`).join("\n");
    expect(priorText).toContain("orca 1.4.196");
    // After a failed reload the panel clears all three legs: diagnostics,
    // validate, worktree are null/pending — the overview must not reuse
    // the prior success rows.
    const cleared = diagnosticsOverviewRows({
      diagnostics: null,
      validate: null,
      worktree: null,
      profilesList: null,
      orchestration: null,
      githubStatus: null,
      githubDoctor: null,
    });
    const clearedText = cleared.map((r) => `${r.label}: ${r.detail}`).join("\n");
    expect(clearedText).not.toContain("orca 1.4.196");
    expect(clearedText).not.toContain("all 1 valid");
    expect(clearedText).toMatch(/unavailable|pending|not loaded|not run/);
    for (const row of cleared) {
      expect(containsSecretMaterial(row.detail)).toBe(false);
      expect(isSecretFreePayload({ detail: row.detail })).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Blocker: top-level readiness requires GitHub health
// Healthy runtime/config/worktree plus broken GitHub must never headline
// as overall ready.
// ---------------------------------------------------------------------------

describe("ui1.5/blocker: diagnostics readiness requires GitHub health", () => {
  const coreHealthy = { cli: { ok: true }, bridge: { structured: true }, config: { ok: true }, worktree: { ok: true } };

  it("healthy core plus broken GitHub is action-needed (never overall ready)", () => {
    expect(diagnosticsHeadline({ ...coreHealthy, github: { ok: true } })).toContain("ready");
    expect(diagnosticsHeadline({ ...coreHealthy, github: { ok: true } })).toContain("GitHub identities healthy");
    // Missing GitHub (never loaded) is pending, never ready.
    expect(diagnosticsHeadline({ ...coreHealthy })).toContain("action needed");
    expect(diagnosticsHeadline({ ...coreHealthy })).toMatch(/GitHub health pending\/unavailable/);
    expect(diagnosticsHeadline({ ...coreHealthy, github: undefined })).toContain("action needed");
    // Expired / attention-needed GitHub is not ready.
    expect(diagnosticsHeadline({ ...coreHealthy, github: { ok: false } })).toContain("action needed");
    expect(diagnosticsHeadline({ ...coreHealthy, github: { ok: false } })).toMatch(/GitHub needs attention/);
    // The banner never claims overall ready while GitHub is broken.
    expect(diagnosticsHeadline({ ...coreHealthy, github: { ok: false } })).not.toMatch(/Diagnostics: ready/);
    expect(diagnosticsHeadline({ ...coreHealthy })).not.toMatch(/Diagnostics: ready/);
  });

  it("toDiagnosticsGithubHealth requires configured status plus doctor ok:true", () => {
    // Healthy worker+reviewer plus distinct doctor is healthy.
    expect(toDiagnosticsGithubHealth(statusPayload(), doctorReport()))?.toEqual({ ok: true });
    // Missing either leg is pending (never ready).
    expect(toDiagnosticsGithubHealth(undefined, doctorReport())).toBeUndefined();
    expect(toDiagnosticsGithubHealth(statusPayload(), undefined)).toBeUndefined();
    expect(toDiagnosticsGithubHealth({ identities: {} }, doctorReport())).toBeUndefined();
    // Expired or missing status is attention-needed.
    expect(toDiagnosticsGithubHealth({ identities: { worker: { configured: true, sourceLabel: "x", expired: true } } }, doctorReport()))?.toEqual({ ok: false });
    expect(toDiagnosticsGithubHealth({ identities: { worker: { configured: false, sourceLabel: "x" } } }, doctorReport()))?.toEqual({ ok: false });
    // Doctor ok:false (swapped actors, repo failure, setup needed) is attention-needed.
    expect(toDiagnosticsGithubHealth(statusPayload(), { ...doctorReport(), ok: false }))?.toEqual({ ok: false });
    // Null doctor is still pending (never loaded), never ready.
    expect(toDiagnosticsGithubHealth(statusPayload(), null)).toBeUndefined();
    expect(toDiagnosticsGithubHealth(statusPayload(), {}))?.toEqual({ ok: false });
    const headline = diagnosticsHeadline({ ...coreHealthy, github: toDiagnosticsGithubHealth(statusPayload(), { ...doctorReport(), ok: false }) });
    expect(headline).toContain("action needed");
    expect(headline).toMatch(/GitHub needs attention/);
  });

  it("panel headline requires GitHub and refreshes on GitHub loads", () => {
    const html = controlHtml();
    expect(html).toContain("function githubOkForHeadline()");
    expect(html).toContain("function refreshDiagnosticsHeadline()");
    expect(html).toContain("githubOk === true");
    expect(html).toContain("GitHub health pending/unavailable");
    expect(html).toContain("GitHub needs attention");
    expect(html).toContain("GitHub identities healthy");
    // Diagnostics legs persist so GitHub refreshes can re-render readiness.
    expect(html).toContain("state.diagnosticsCliOk");
    expect(html).toContain("state.diagnosticsBridgeStructured");
    expect(html).toContain("state.diagnosticsConfigOk");
    expect(html).toContain("state.diagnosticsWorktreeOk");
    // GitHub loads re-render the headline (not just the overview).
    expect(html).toContain("refreshDiagnosticsHeadline();");
    expect(containsSecretMaterial(html)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Blockers: GitHub readiness requires BOTH canonical slots (worker +
// reviewer) + fail-closed GitHub refreshes (success-then-failure)
// ---------------------------------------------------------------------------

describe("ui1.5/blocker: github readiness requires worker+reviewer (no partial ready)", () => {
  const coreHealthy = { cli: { ok: true }, bridge: { structured: true }, config: { ok: true }, worktree: { ok: true } };
  const workerOnly = {
    identities: {
      worker: { identity: "worker", configured: true, sourceLabel: "ORCA_PI_GITHUB_WORKER_TOKEN", expiresAt: "2030-01-01T00:00:00.000Z", expired: false },
    },
    redacted: true,
  };
  const reviewerOnly = {
    identities: {
      reviewer: { identity: "reviewer", configured: true, sourceLabel: "ORCA_PI_GITHUB_REVIEWER_TOKEN", expired: false },
    },
    redacted: true,
  };

  it("worker-only healthy status plus doctor ok:true stays pending (never ready)", () => {
    // Regression: a scoped worker-only response merged into an empty
    // snapshot must remain pending until both rows are observed healthy.
    const merged = mergeGithubStatusSnapshots({ identities: {} }, workerOnly);
    const items = toGithubStatusItems(merged);
    expect(items.map((i) => i.identity)).toEqual(["worker"]);
    expect(toDiagnosticsGithubHealth(merged, doctorReport())).toBeUndefined();
    expect(toDiagnosticsGithubHealth(workerOnly, doctorReport())).toBeUndefined();
    expect(toDiagnosticsGithubHealth(reviewerOnly, doctorReport())).toBeUndefined();
    // Full worker+reviewer healthy plus doctor ok:true is the only ready shape.
    expect(toDiagnosticsGithubHealth(statusPayload(), doctorReport()))?.toEqual({ ok: true });
    // Headline mirrors the leg: partial stays pending, full is ready.
    expect(diagnosticsHeadline({ ...coreHealthy, github: toDiagnosticsGithubHealth(workerOnly, doctorReport()) as never })).toMatch(/pending\/unavailable/);
    expect(diagnosticsHeadline({ ...coreHealthy, github: toDiagnosticsGithubHealth(statusPayload(), doctorReport()) })).toContain("ready");
    expect(isSecretFreePayload(merged)).toBe(true);
  });

  it("unhealthy rows still fail closed even when a canonical slot is missing", () => {
    // Any observed unhealthy row is attention-needed (not pending).
    expect(toDiagnosticsGithubHealth({ identities: { worker: { configured: false, sourceLabel: "x" } } }, doctorReport()))?.toEqual({ ok: false });
    expect(toDiagnosticsGithubHealth({ identities: { reviewer: { configured: true, sourceLabel: "x", expired: true } } }, doctorReport()))?.toEqual({ ok: false });
    // Extra custom identities never substitute for the canonical pair.
    const customOnly = { identities: { custom: { configured: true, sourceLabel: "x" } }, redacted: true };
    expect(toDiagnosticsGithubHealth(customOnly, doctorReport())).toBeUndefined();
    const workerPlusCustom = {
      identities: {
        worker: { configured: true, sourceLabel: "x", expired: false },
        custom: { configured: true, sourceLabel: "x" },
      },
      redacted: true,
    };
    expect(toDiagnosticsGithubHealth(workerPlusCustom, doctorReport())).toBeUndefined();
  });

  it("panel headline requires both canonical rows (worker+reviewer)", () => {
    const html = controlHtml();
    expect(html).toContain("function githubOkForHeadline()");
    expect(html).toContain('if (sItems[ci].identity === "worker") hasWorker = true;');
    expect(html).toContain('if (sItems[ci].identity === "reviewer") hasReviewer = true;');
    expect(html).toContain("if (!hasWorker || !hasReviewer) return undefined;");
    expect(containsSecretMaterial(html)).toBe(false);
  });
});

describe("ui1.5/blocker: github refreshes fail closed (success-then-failure)", () => {
  const coreHealthy = { cli: { ok: true }, bridge: { structured: true }, config: { ok: true }, worktree: { ok: true } };

  it("success-then-status-failure leaves headline pending (no stale ready)", () => {
    // Healthy baseline headlines as ready.
    const healthyLeg = toDiagnosticsGithubHealth(statusPayload(), doctorReport());
    expect(healthyLeg)?.toEqual({ ok: true });
    expect(diagnosticsHeadline({ ...coreHealthy, github: healthyLeg })).toContain("ready");
    // Full status refresh failure clears the leg -> pending, never ready.
    const clearedLeg = toDiagnosticsGithubHealth(null, doctorReport());
    expect(clearedLeg).toBeUndefined();
    expect(diagnosticsHeadline({ ...coreHealthy, github: clearedLeg as never })).toMatch(/pending\/unavailable/);
    expect(diagnosticsHeadline({ ...coreHealthy, github: clearedLeg as never })).not.toMatch(/Diagnostics: ready/);
    // Scoped worker-refresh failure preserves the reviewer sibling but
    // stays pending (worker row unobserved) — never stale ready.
    const full = statusPayload();
    const reviewerKept = {
      identities: { reviewer: (full.identities as Record<string, unknown>)["reviewer"] },
      redacted: true,
    };
    expect(toGithubStatusItems(reviewerKept).map((i) => i.identity)).toEqual(["reviewer"]);
    expect(toDiagnosticsGithubHealth(reviewerKept, doctorReport())).toBeUndefined();
    expect(diagnosticsHeadline({ ...coreHealthy, github: toDiagnosticsGithubHealth(reviewerKept, doctorReport()) as never })).toMatch(/pending\/unavailable/);
    // Overview mirrors the cleared leg (no stale healthy rows).
    const clearedRows = diagnosticsOverviewRows({ githubStatus: null, githubDoctor: doctorReport() });
    const clearedStatus = clearedRows.find((r) => r.label === "GitHub status")!.detail;
    expect(clearedStatus).toMatch(/not loaded/);
    expect(clearedStatus).not.toContain("configured via");
  });

  it("success-then-doctor-failure leaves headline pending (no stale ready)", () => {
    const healthyLeg = toDiagnosticsGithubHealth(statusPayload(), doctorReport());
    expect(diagnosticsHeadline({ ...coreHealthy, github: healthyLeg })).toContain("ready");
    // Doctor refresh failure clears the leg -> pending, never ready.
    const clearedLeg = toDiagnosticsGithubHealth(statusPayload(), null);
    expect(clearedLeg).toBeUndefined();
    expect(diagnosticsHeadline({ ...coreHealthy, github: clearedLeg as never })).toMatch(/pending\/unavailable/);
    expect(diagnosticsHeadline({ ...coreHealthy, github: clearedLeg as never })).not.toMatch(/Diagnostics: ready/);
    // Doctor ok:false is attention-needed (distinct from pending).
    const failedLeg = toDiagnosticsGithubHealth(statusPayload(), { ...doctorReport(), ok: false });
    expect(failedLeg)?.toEqual({ ok: false });
    expect(diagnosticsHeadline({ ...coreHealthy, github: failedLeg })).toMatch(/GitHub needs attention/);
    const clearedRows = diagnosticsOverviewRows({ githubStatus: statusPayload(), githubDoctor: null });
    const clearedDoctor = clearedRows.find((r) => r.label === "GitHub doctor")!.detail;
    expect(clearedDoctor).toMatch(/not run yet/);
    expect(clearedDoctor).not.toContain("distinct (ok)");
  });

  it("panel marks pending at refresh start and clears plus rerenders on every completion path", () => {
    const html = controlHtml();
    // Scoped-preserving clear helper exists (drops only the targeted
    // identity, keeps the sibling; allowlisted redacted shape only).
    expect(html).toContain("function clearGithubStatusIdentity(prev, identity)");
    expect(html).toContain("if (k === identity) continue;");
    // Status: start marks pending (scoped-preserving clear vs full clear)
    // and rerenders headline + overview before the request lands.
    expect(html).toContain("Fail closed at refresh start: mark the targeted leg pending");
    expect(html).toContain("state.githubStatus = clearGithubStatusIdentity(state.githubStatus, identity);");
    expect(html).toContain("state.githubStatus = null;");
    // Doctor: start clears the leg to pending plus headline/overview.
    expect(html).toContain("Fail closed at refresh start: doctor leg pending");
    expect(html).toContain("state.githubDoctor = null;");
    // Status error + rejection clear the targeted leg and rerender
    // headline + overview (never leave stale healthy driving ready).
    expect(html).toContain("Fail closed on bridge error: clear the targeted leg");
    expect(html).toContain("Fail closed on rejection: same scoped-preserving clear");
    // Doctor error + rejection clear the leg, rerender actor/setup from
    // the cleared leg, plus headline + overview.
    expect(html).toContain("Fail closed on bridge error: clear the doctor leg");
    expect(html).toContain("Fail closed on rejection: same doctor-leg clear");
    expect(html).toContain("renderGithubActor(state.githubDoctor);");
    expect(html).toContain("renderGithubSetup(state.githubDoctor);");
    // Every completion path rerenders the Diagnostics headline and the
    // one-place overview (success already did; failures now do too).
    const bodyOf = (fn: string): string => {
      const start = html.indexOf(`function ${fn}(`);
      expect(start).toBeGreaterThan(-1);
      const next = html.indexOf("\n        function ", start + 1);
      return html.slice(start, next === -1 ? start + 12000 : next);
    };
    const statusBody = bodyOf("loadGithubStatus");
    expect(statusBody.match(/refreshDiagnosticsHeadline\(\);/g)!.length).toBeGreaterThanOrEqual(3);
    expect(statusBody.match(/renderDiagnosticsOverview\(\);/g)!.length).toBeGreaterThanOrEqual(3);
    const doctorBody = bodyOf("loadGithubDoctor");
    expect(doctorBody.match(/refreshDiagnosticsHeadline\(\);/g)!.length).toBeGreaterThanOrEqual(3);
    expect(doctorBody.match(/renderDiagnosticsOverview\(\);/g)!.length).toBeGreaterThanOrEqual(3);
    // No secrets, no mint/refresh smuggled into the fail-closed paths.
    expect(html).not.toMatch(/\.token\b/);
    expect(html).not.toContain("privateKey");
    expect(containsSecretMaterial(html)).toBe(false);
  });
});

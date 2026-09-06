import { describe, expect, it, vi } from "vitest";
import { doctorGithubIdentities, formatDoctorReport } from "../src/github/doctor.js";
import { operatorSetupStepsForIdentity, validateSetupForIdentity } from "../src/github/setup.js";
import { createInstallationTokenCache } from "../src/github/github-app-auth.js";
import type { GithubFetchFn } from "../src/github/types.js";

const WORKER_ENV = {
  ORCA_PI_GITHUB_WORKER_TOKEN: "ghs_worker-12345678",
  ORCA_PI_GITHUB_WORKER_LOGIN: "orca-pi-worker[bot]",
  ORCA_PI_GITHUB_WORKER_INSTALLATION_ID: "111",
  ORCA_PI_GITHUB_WORKER_APP_ID: "1001",
  ORCA_PI_GITHUB_WORKER_PRIVATE_KEY_PATH: "/keys/worker.pem",
};
const REVIEWER_ENV = {
  ORCA_PI_GITHUB_REVIEWER_TOKEN: "ghs_reviewer-12345678",
  ORCA_PI_GITHUB_REVIEWER_LOGIN: "orca-pi-reviewer[bot]",
  ORCA_PI_GITHUB_REVIEWER_INSTALLATION_ID: "222",
  ORCA_PI_GITHUB_REVIEWER_APP_ID: "1002",
  ORCA_PI_GITHUB_REVIEWER_PRIVATE_KEY_PATH: "/keys/reviewer.pem",
};

function okFetch(): GithubFetchFn {
  return vi.fn(async (url: string) => {
    if (url.includes("/installation/repositories")) {
      return { ok: true, status: 200, json: async () => ({ repositories: [] }), text: async () => "{}" };
    }
    if (url.includes("/installation")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          permissions: { contents: "read", pull_requests: "write", checks: "write", metadata: "read" },
        }),
        text: async () => "{}",
      };
    }
    throw new Error(`unexpected ${url}`);
  });
}

describe("doctor: non-secret diagnostics + distinctness", () => {
  it("reports missing config with setup actions and no secret values", async () => {
    const report = await doctorGithubIdentities({ env: {}, cache: createInstallationTokenCache() });
    expect(report.ok).toBe(false);
    expect(report.setupNeeded.length).toBeGreaterThan(0);
    expect(JSON.stringify(report)).not.toContain("ghs_");
    expect(formatDoctorReport(report)).toContain("worker bot != reviewer bot");
  });

  it("ok when both bots distinct and proofs pass (ambient human distinct)", async () => {
    const report = await doctorGithubIdentities({
      env: { ...WORKER_ENV, ...REVIEWER_ENV, GITHUB_ACTOR: "44madfire" },
      cache: createInstallationTokenCache(),
      fetchFn: okFetch(),
      repo: { owner: "44madfire", repo: "orca-pi" },
    });
    // Worker perms in the stub are reviewer-shaped (read) so worker shows a
    // permission mismatch — doctor must surface it without secrets.
    expect(report.workerLogin).toBe("orca-pi-worker[bot]");
    expect(report.reviewerLogin).toBe("orca-pi-reviewer[bot]");
    expect(report.ambientLogin).toBe("44madfire");
    expect(report.distinctWorkerReviewer).toBe(true);
    expect(report.distinctFromAmbient).toBe(true);
    expect(JSON.stringify(report)).not.toContain("ghs_worker-12345678");
    expect(JSON.stringify(report)).not.toContain("ghs_reviewer-12345678");
  });

  it("flags same-actor worker/reviewer", async () => {
    const report = await doctorGithubIdentities({
      env: {
        ORCA_PI_GITHUB_WORKER_TOKEN: "ghs_a-12345678",
        ORCA_PI_GITHUB_WORKER_LOGIN: "same-bot[bot]",
        ORCA_PI_GITHUB_WORKER_INSTALLATION_ID: "1",
        ORCA_PI_GITHUB_REVIEWER_TOKEN: "ghs_b-12345678",
        ORCA_PI_GITHUB_REVIEWER_LOGIN: "SAME-BOT[bot]",
        ORCA_PI_GITHUB_REVIEWER_INSTALLATION_ID: "2",
      },
      cache: createInstallationTokenCache(),
    });
    expect(report.distinctWorkerReviewer).toBe(false);
    expect(report.setupNeeded.join("\n")).toMatch(/same actor|distinct/i);
  });

  it("expired tokens surface as expired without values", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const report = await doctorGithubIdentities({
      env: {
        ORCA_PI_GITHUB_WORKER_TOKEN: "ghs_w-12345678",
        ORCA_PI_GITHUB_WORKER_EXPIRES_AT: past,
        ORCA_PI_GITHUB_WORKER_LOGIN: "orca-pi-worker[bot]",
        ORCA_PI_GITHUB_WORKER_INSTALLATION_ID: "1",
      },
      cache: createInstallationTokenCache(),
    });
    expect(report.worker.expired).toBe(true);
    expect(JSON.stringify(report)).not.toContain("ghs_w-12345678");
  });
});

describe("setup: idempotent non-secret operator steps", () => {
  it("worker steps pin Contents: write; reviewer pins Contents: read", () => {
    const workerSteps = operatorSetupStepsForIdentity("worker", { repo: "44madfire/orca-pi" });
    const reviewerSteps = operatorSetupStepsForIdentity("reviewer", { repo: "44madfire/orca-pi" });
    expect(workerSteps.join("\n")).toContain("Contents: write");
    expect(reviewerSteps.join("\n")).toContain("Contents: read");
    expect(workerSteps.join("\n")).toContain("44madfire/orca-pi");
    expect(workerSteps.join("\n")).not.toMatch(/ghs_|ghp_|BEGIN.*PRIVATE KEY/);
  });

  it("validation names missing vars without values", () => {
    const missing = validateSetupForIdentity("worker", {});
    expect(missing.ok).toBe(false);
    expect(missing.missing.join(",")).toContain("ORCA_PI_GITHUB_WORKER_APP_ID");
    expect(missing.guidance).toContain("orca-pi github setup");

    const ok = validateSetupForIdentity("worker", { ...WORKER_ENV });
    expect(ok.ok).toBe(true);
  });
});

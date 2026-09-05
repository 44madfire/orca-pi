import { describe, expect, it, vi } from "vitest";
import {
  assertWorkerIdentityForWrites,
  createInstallationTokenCache,
  resolveWorkerAppMetadata,
  verifyWorkerForWrites,
  WORKER_INSTALLATION_ID_ENV_VAR,
  WORKER_LOGIN_ENV_VAR,
} from "../src/github/github-app-auth.js";
import { assertDistinctGithubActors } from "../src/github/identity.js";
import type { GithubFetchFn } from "../src/github/types.js";

const WORKER_TOKEN = "ghs_worker-installation-token-12345678";
const WORKER_ENV = {
  ORCA_PI_GITHUB_WORKER_TOKEN: WORKER_TOKEN,
  [WORKER_LOGIN_ENV_VAR]: "orca-pi-worker[bot]",
  [WORKER_INSTALLATION_ID_ENV_VAR]: "654321",
};

describe("worker App metadata: fail-closed installation binding", () => {
  it("resolves verified login + installation id", () => {
    expect(resolveWorkerAppMetadata({ ...WORKER_ENV })).toEqual({
      login: "orca-pi-worker[bot]",
      installationId: "654321",
    });
  });

  it("missing metadata fails closed (names, never values)", () => {
    expect(() => resolveWorkerAppMetadata({})).toThrow(/Missing verified worker App identity/);
    expect(() => resolveWorkerAppMetadata({ [WORKER_LOGIN_ENV_VAR]: "x[bot]" })).toThrow(
      new RegExp(WORKER_INSTALLATION_ID_ENV_VAR),
    );
  });

  it("only the worker slot may perform Content-write", () => {
    expect(() => assertWorkerIdentityForWrites("worker")).not.toThrow();
    expect(() => assertWorkerIdentityForWrites("reviewer")).toThrow(/must use the dedicated worker/i);
    expect(() => assertWorkerIdentityForWrites("custom")).toThrow(/must use the dedicated worker/i);
  });
});

describe("worker preflight: IAT class + bot shape (never GET /user)", () => {
  it("happy path proves installation-token class", async () => {
    const fetchFn: GithubFetchFn = vi.fn(async (url: string) => {
      expect(url).toContain("/installation/repositories");
      expect(url.endsWith("/user")).toBe(false);
      return { ok: true, status: 200, json: async () => ({ repositories: [] }), text: async () => "{}" };
    });
    await expect(
      verifyWorkerForWrites("worker", { fetchFn, env: { ...WORKER_ENV }, cache: createInstallationTokenCache() }),
    ).resolves.toEqual({ workerLogin: "orca-pi-worker[bot]", installationId: "654321" });
    expect(fetchFn).toHaveBeenCalled();
  });

  it("human login in the worker slot is refused", async () => {
    const fetchFn: GithubFetchFn = async (url: string) => {
      if (url.includes("/installation/repositories")) return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
      throw new Error(`unexpected ${url}`);
    };
    const humanEnv = { ...WORKER_ENV, [WORKER_LOGIN_ENV_VAR]: "human-user" };
    await expect(
      verifyWorkerForWrites("worker", { fetchFn, env: humanEnv, cache: createInstallationTokenCache() }),
    ).rejects.toThrow(/does not look like a GitHub App bot/i);
  });

  it("reviewer identity never reaches worker preflight", async () => {
    const fetchFn: GithubFetchFn = vi.fn(async () => {
      throw new Error("must not be called");
    });
    await expect(
      verifyWorkerForWrites("reviewer", { fetchFn, env: { ...WORKER_ENV }, cache: createInstallationTokenCache() }),
    ).rejects.toThrow(/must use the dedicated worker/i);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("three-actor distinctness: worker != reviewer != human", () => {
  it("distinct bots + human pass", () => {
    expect(() =>
      assertDistinctGithubActors({ workerLogin: "orca-pi-worker[bot]", reviewerLogin: "orca-pi-reviewer[bot]" }),
    ).not.toThrow();
  });

  it("worker == reviewer fails (same App misconfiguration)", () => {
    expect(() =>
      assertDistinctGithubActors({ workerLogin: "orca-pi-worker[bot]", reviewerLogin: "ORCA-PI-WORKER[bot]" }),
    ).toThrow(/same actor/i);
  });

  it("automation == human fails (self-review risk)", () => {
    expect(() =>
      assertDistinctGithubActors({ workerLogin: "44madfire", reviewerLogin: "orca-pi-reviewer[bot]" }),
    ).not.toThrow();
    // Worker authored by the human account means ChatGPT/human cannot
    // independently approve (GitHub self-review restriction).
    expect(() =>
      assertDistinctGithubActors({ workerLogin: "44madfire", reviewerLogin: "44madfire" }),
    ).toThrow(/same actor/i);
  });

  it("errors never leak token values", () => {
    let message = "";
    try {
      assertDistinctGithubActors({ workerLogin: "x", reviewerLogin: "x" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain(WORKER_TOKEN);
  });
});

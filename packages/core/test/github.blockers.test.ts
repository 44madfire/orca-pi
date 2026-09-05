import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  ALLOWED_HOSTS_ENV_VAR,
  allowedHostsFromEnv,
  assertWorktreeHelperConfigured,
  buildWorkerExecEnv,
  credentialHostKey,
  defaultSshGuardCommand,
  extractGitSubcommand,
  gitConfigCommandsForSetup,
  isContentsWriteGitCommand,
  isHostAllowed,
  isWorkerMutationCommand,
  assertIdentityMayRunCommand,
  normalizeCredentialHost,
  setupRepoGitAuth,
} from "../src/github/git-auth.js";
import { fetchRepoInstallationWithJwt, doctorGithubIdentities } from "../src/github/doctor.js";
import { ensureInstallationToken, type CredentialProviderFs } from "../src/github/credential-provider.js";
import { createInstallationTokenCache } from "../src/github/token-cache.js";
import { toAuthError } from "../src/github/github-app-auth.js";
import { submitGithubReview } from "../src/github/review.js";
import { handleGitCredentialRequest } from "../src/github/git-auth.js";
import { verifyWorkerForWrites } from "../src/github/github-app-auth.js";
import type { GithubFetchFn } from "../src/github/types.js";

function memFs(files: Record<string, string> = {}): CredentialProviderFs & { written: Record<string, string> } {
  const written: Record<string, string> = {};
  return {
    written,
    async readFile(path: string) {
      if (Object.hasOwn(files, String(path))) return files[String(path)]!;
      if (Object.hasOwn(written, String(path))) return written[String(path)]!;
      const e = new Error(`ENOENT ${path}`) as NodeJS.ErrnoException;
      e.code = "ENOENT";
      throw e;
    },
    async writeFile(path: string, data: string) {
      written[String(path)] = data;
    },
    async mkdir() {},
  };
}

function testKey(): { pem: string; appId: string } {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" }) as string;
  return { pem, appId: "1001" };
}

describe("blocker 1: mint once, separate invocations reuse disk cache (no *_TOKEN)", () => {
  it("ensure -> disk -> review + git-credential get without env token", async () => {
    const { pem, appId } = testKey();
    const keyPath = "/keys/worker.pem";
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const fs = memFs({ [keyPath]: pem });
    const appEnv = {
      ORCA_PI_GITHUB_WORKER_APP_ID: appId,
      ORCA_PI_GITHUB_WORKER_PRIVATE_KEY_PATH: keyPath,
      ORCA_PI_GITHUB_WORKER_INSTALLATION_ID: "111",
      ORCA_PI_GITHUB_WORKER_LOGIN: "orca-pi-worker[bot]",
      HOME: "/home/u",
    };
    const mintFetch: GithubFetchFn = vi.fn(async (url: string) => {
      if (url.includes("/access_tokens")) {
        return { ok: true, status: 201, json: async () => ({ token: "ghs_disk-minted-12345678", expires_at: future }), text: async () => "{}" };
      }
      if (url.includes("/installation/repositories")) {
        return { ok: true, status: 200, json: async () => ({ repositories: [] }), text: async () => "{}" };
      }
      if (/\/pulls\/\d+$/.test(url)) {
        return { ok: true, status: 200, json: async () => ({ user: { login: "human-user" }, head: { sha: "abc1234abc1234abc1234abc1234abc1234abc12" } }), text: async () => "{}" };
      }
      if (url.includes("/reviews?")) return { ok: true, status: 200, json: async () => [], text: async () => "{}" };
      if (url.endsWith("/reviews")) return { ok: true, status: 200, json: async () => ({ id: 9 }), text: async () => "{}" };
      throw new Error(`unexpected ${url}`);
    });
    // Invocation 1 (mint): no env token, App config present -> mints + persists.
    const minted = await ensureInstallationToken("worker", {
      env: appEnv,
      fs,
      fetchFn: mintFetch,
      cache: createInstallationTokenCache(),
      homedir: "/home/u",
    });
    expect(minted.token).toBe("ghs_disk-minted-12345678");
    expect(Object.keys(fs.written).length).toBeGreaterThan(0);

    // Invocation 2 (separate process: fresh memory cache, same disk, no env token)
    // -> review succeeds via disk-warmed production chain.
    const review = await submitGithubReview(
      "worker" as never, // bypass reviewer-only guard? No — use reviewer identity for review path below.
      { owner: "o", repo: "r", pullNumber: 1, verdict: "comment", body: "hi" },
      { env: appEnv, fetchFn: mintFetch, cache: createInstallationTokenCache() },
    ).catch((e: unknown) => e);
    // worker review must be refused (reviewer-only) — proves preflight ran, not silent env miss.
    expect((review as Error).message).toMatch(/reviewer/i);

    // Reviewer disk path: mint reviewer token to disk, then review without env token.
    const reviewerKeyPath = "/keys/reviewer.pem";
    const fs2 = memFs({ [reviewerKeyPath]: pem });
    const reviewerEnv = {
      ORCA_PI_GITHUB_REVIEWER_APP_ID: appId,
      ORCA_PI_GITHUB_REVIEWER_PRIVATE_KEY_PATH: reviewerKeyPath,
      ORCA_PI_GITHUB_REVIEWER_INSTALLATION_ID: "222",
      ORCA_PI_GITHUB_REVIEWER_LOGIN: "orca-pi-reviewer[bot]",
      HOME: "/home/u",
    };
    await ensureInstallationToken("reviewer", {
      env: reviewerEnv,
      fs: fs2,
      fetchFn: mintFetch,
      cache: createInstallationTokenCache(),
      homedir: "/home/u",
    });
    const okReview = await submitGithubReview(
      "reviewer",
      { owner: "o", repo: "r", pullNumber: 1, verdict: "comment", body: "disk review works" },
      {
        env: reviewerEnv,
        fetchFn: mintFetch,
        cache: createInstallationTokenCache(),
        providerFs: fs2,
        homedir: "/home/u",
      },
    );
    expect(okReview.id).toBe(9);

    // git-credential get via disk (no env token) returns the minted password.
    const got = await handleGitCredentialRequest("reviewer", "get", { protocol: "https", host: "github.com" }, async () => {
      const { resolveProductionCredential } = await import("../src/github/production-credential.js");
      const c = await resolveProductionCredential("reviewer", { env: reviewerEnv, cache: createInstallationTokenCache(), providerFs: fs2, fetchFn: mintFetch, homedir: "/home/u" });
      return { token: c.token };
    });
    expect(got.stdout).toContain("ghs_disk-minted-12345678");
  });
});

describe("blocker 2: human PAT in worker slot never spawns / never reaches write API", () => {
  it("verifyWorkerForWrites rejects PAT (IAT proof 403)", async () => {
    const patFetch: GithubFetchFn = async (url: string) => {
      if (url.includes("/installation/repositories")) {
        return { ok: false, status: 403, json: async () => ({}), text: async () => "forbidden" };
      }
      throw new Error(`must not reach write API: ${url}`);
    };
    const patEnv = {
      ORCA_PI_GITHUB_WORKER_TOKEN: "ghp_human-pat-12345678",
      ORCA_PI_GITHUB_WORKER_LOGIN: "orca-pi-worker[bot]",
      ORCA_PI_GITHUB_WORKER_INSTALLATION_ID: "111",
    };
    await expect(
      verifyWorkerForWrites("worker", { fetchFn: patFetch, env: patEnv, cache: createInstallationTokenCache() }),
    ).rejects.toThrow(/installation-token|Reviewer|Worker|PAT/i);
  });
});

describe("blocker 3: JWT-only vs IAT auth classes", () => {
  it("repo installation uses JWT (not IAT) on JWT-only endpoint", async () => {
    const seen: { url: string; auth: string }[] = [];
    const fetchFn: GithubFetchFn = vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
      seen.push({ url, auth: init.headers.Authorization ?? "" });
      if (url.endsWith("/repos/o/r/installation")) {
        // Must be JWT (three dot-parts), not ghs_ IAT.
        expect(init.headers.Authorization).toMatch(/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
        expect(init.headers.Authorization).not.toContain("ghs_");
        return { ok: true, status: 200, json: async () => ({ id: 111, permissions: { contents: "write", pull_requests: "write", metadata: "read" } }), text: async () => "{}" };
      }
      throw new Error(`unexpected ${url}`);
    });
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs1", format: "pem" }) as string;
    const { createAppJwt } = await import("../src/github/credential-provider.js");
    const jwt = createAppJwt({ appId: "1001", privateKeyPem: pem, nowMs: 1_700_000_000_000 });
    const out = await fetchRepoInstallationWithJwt({ owner: "o", repo: "r", appJwt: jwt, fetchFn });
    expect(out.installationId).toBe("111");
    expect(seen[0]?.url).toContain("/repos/o/r/installation");
  });

  it("doctor with --repo but no key/fs fails closed (never silent OK)", async () => {
    const iatFetch: GithubFetchFn = async (url: string) => {
      if (url.includes("/installation/repositories")) {
        return { ok: true, status: 200, json: async () => ({ repositories: [] }), text: async () => "{}" };
      }
      throw new Error(`unexpected ${url}`);
    };
    const report = await doctorGithubIdentities({
      env: {
        ORCA_PI_GITHUB_WORKER_TOKEN: "ghs_w-12345678",
        ORCA_PI_GITHUB_WORKER_LOGIN: "orca-pi-worker[bot]",
        ORCA_PI_GITHUB_WORKER_INSTALLATION_ID: "111",
        ORCA_PI_GITHUB_REVIEWER_TOKEN: "ghs_r-12345678",
        ORCA_PI_GITHUB_REVIEWER_LOGIN: "orca-pi-reviewer[bot]",
        ORCA_PI_GITHUB_REVIEWER_INSTALLATION_ID: "222",
      },
      cache: createInstallationTokenCache(),
      fetchFn: iatFetch,
      repo: { owner: "o", repo: "r" },
      providerFs: memFs({}),
    });
    expect(report.ok).toBe(false);
    expect(report.worker.repoAccess).toBe(false);
    expect(report.setupNeeded.join("\n")).toMatch(/repository verification failed|private key/i);
  });
});

describe("blocker 4: deterministic worktree override beats ambient helper", () => {
  it("setup emits empty resets + host worker add in worktree scope", () => {
    const cmds = gitConfigCommandsForSetup({ repoPath: "/wt/w", helperCommand: "orca-pi github git-credential --identity worker" });
    expect(cmds.length).toBe(3);
    expect(cmds[0]?.args).toEqual(["-C", "/wt/w", "config", "--worktree", "--replace-all", "credential.helper", ""]);
    expect(cmds[1]?.args).toEqual(["-C", "/wt/w", "config", "--worktree", "--replace-all", "credential.https://github.com.helper", ""]);
    expect(cmds[2]?.args).toEqual(["-C", "/wt/w", "config", "--worktree", "--add", "credential.https://github.com.helper", "orca-pi github git-credential --identity worker"]);
  });

  it("ambient helper ahead without reset is rejected; with reset it passes", () => {
    const ambientFirst =
      "file:/home/u/.gitconfig\tcredential.helper=manager\n" +
      "file:/wt/w/.git/config\tcredential.helper=orca-pi github git-credential --identity worker\n";
    expect(() => assertWorktreeHelperConfigured(ambientFirst, { repoPath: "/wt/w" })).toThrow(/empty-reset/i);
    const withReset =
      "file:/home/u/.gitconfig\tcredential.helper=manager\n" +
      "file:/wt/w/.git/config.worktree\tcredential.helper=\n" +
      "file:/wt/w/.git/config.worktree\tcredential.helper=orca-pi github git-credential --identity worker\n";
    expect(() => assertWorktreeHelperConfigured(withReset, { repoPath: "/wt/w" })).not.toThrow();
  });

  it("setupRepoGitAuth runs resets + host add, never global", async () => {
    const seen: string[][] = [];
    const workerHelper = "orca-pi github git-credential --identity worker";
    const receipt = await setupRepoGitAuth(
      {
        async run(exe: string, args: readonly string[]) {
          seen.push([exe, ...args]);
          if (args.includes("--git-dir")) return { stdout: ".git\n", stderr: "", exitCode: 0 };
          if (args.includes("--git-common-dir")) return { stdout: ".git\n", stderr: "", exitCode: 0 };
          if (args.includes("--show-origin")) {
            return {
              stdout:
                "file:/wt/w/.git/config.worktree\t\n" +
                `file:/wt/w/.git/config.worktree\t${workerHelper}\n`,
              stderr: "",
              stderr: "",
              exitCode: 0,
            };
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      },
      { repoPath: "/wt/w" },
    );
    expect(receipt.scope).toBe("--worktree");
    expect(receipt.hostKey).toBe("credential.https://github.com.helper");
    const writes = seen.filter((a) => a.includes("config") && !a.includes("rev-parse") && !a.includes("--show-origin"));
    expect(writes.length).toBe(3);
    expect(seen.flat().join(" ")).not.toContain("--global");
  });
});

describe("hardening: git global-option bypass + identity-aware diagnostics", () => {
  it("extracts push past -C/-c/--git-dir forms", () => {
    expect(extractGitSubcommand(["git", "push"])).toBe("push");
    expect(extractGitSubcommand(["git", "-C", "/wt/w", "push", "origin", "x"])).toBe("push");
    expect(extractGitSubcommand(["git", "-c", "user.name=x", "push"])).toBe("push");
    expect(extractGitSubcommand(["git", "--git-dir=/x/.git", "push"])).toBe("push");
    expect(isContentsWriteGitCommand(["git", "-C", "/wt", "push"])).toBe(true);
    expect(() => assertIdentityMayRunCommand("reviewer", ["git", "-C", "/wt", "push"])).toThrow(/Contents: read only/i);
    expect(() => assertIdentityMayRunCommand("reviewer", ["git", "-c", "a=b", "push"])).toThrow(/Contents: read only/i);
  });

  it("worker mutation detection covers gh pr/api", () => {
    expect(isWorkerMutationCommand(["git", "push", "origin", "x"])).toBe(true);
    expect(isWorkerMutationCommand(["git", "-C", "/wt", "push"])).toBe(true);
    expect(isWorkerMutationCommand(["gh", "pr", "create", "--title", "x"])).toBe(true);
    expect(isWorkerMutationCommand(["gh", "pr", "view", "1"])).toBe(false);
    expect(isWorkerMutationCommand(["gh", "api", "--method", "POST", "repos/o/r/pulls"])).toBe(true);
    expect(isWorkerMutationCommand(["gh", "api", "repos/o/r/pulls/1"])).toBe(false);
  });

  it("toAuthError is identity-aware (worker vs reviewer)", () => {
    const worker403 = toAuthError("worker", 403, "/x")!;
    const reviewer403 = toAuthError("reviewer", 403, "/x")!;
    expect(worker403.message).toMatch(/Worker/i);
    expect(worker403.message).toMatch(/Contents: write/);
    expect(reviewer403.message).toMatch(/Reviewer/i);
    expect(reviewer403.message).toMatch(/Contents: read/);
    const worker404 = toAuthError("worker", 404, "/x")!;
    expect(worker404.message).toMatch(/Worker/i);
    expect(worker404.message).not.toMatch(/Reviewer GitHub App/);
  });
});

describe("blocker 3: credential helper host allowlisting (no leak to foreign hosts)", () => {
  it("refuses non-https, foreign, and missing hosts without resolving a token", async () => {
    let resolved = false;
    const resolveToken = async () => {
      resolved = true;
      return { token: "ghs_must-never-leak-12345678" };
    };
    for (const input of [
      { protocol: "https", host: "example.invalid" },
      { protocol: "http", host: "github.com" },
      { protocol: "", host: "github.com" },
      { protocol: "https", host: "" },
      {},
    ]) {
      resolved = false;
      const out = await handleGitCredentialRequest("worker", "get", input, resolveToken);
      expect(out.stdout).toBe("");
      expect(out.exitCode).toBe(0);
      expect(resolved).toBe(false);
    }
  });

  it("allows github.com (case-insensitive) and enterprise hosts via env", async () => {
    const resolveToken = async () => ({ token: "ghs_ok-12345678" });
    const ok = await handleGitCredentialRequest(
      "worker",
      "get",
      { protocol: "https", host: "GitHub.com" },
      resolveToken,
    );
    expect(ok.stdout).toContain("ghs_ok-12345678");
    const refused = await handleGitCredentialRequest(
      "worker",
      "get",
      { protocol: "https", host: "ghe.example.com" },
      resolveToken,
    );
    expect(refused.stdout).toBe("");
    const allowed = await handleGitCredentialRequest(
      "worker",
      "get",
      { protocol: "https", host: "ghe.example.com" },
      resolveToken,
      { allowedHosts: ["github.com", "ghe.example.com"] },
    );
    expect(allowed.stdout).toContain("ghs_ok-12345678");
    expect(normalizeCredentialHost("https://GitHub.com/foo")).toBe("github.com");
    expect(isHostAllowed("github.com", ["github.com"])).toBe(true);
    expect(isHostAllowed("example.invalid", ["github.com"])).toBe(false);
    expect(allowedHostsFromEnv({ [ALLOWED_HOSTS_ENV_VAR]: "ghe.example.com, GitHub.com" })).toEqual([
      "github.com",
      "ghe.example.com",
    ]);
    expect(credentialHostKey()).toBe("credential.https://github.com.helper");
    expect(credentialHostKey("ghe.example.com")).toBe("credential.https://ghe.example.com.helper");
  });
});

describe("blocker 2 (hardening): worker exec env is deterministically scoped", () => {
  it("buildWorkerExecEnv carries tokens, host override, and SSH guard", () => {
    const env = buildWorkerExecEnv("ghs_worker-12345678");
    expect(env.GH_TOKEN).toBe("ghs_worker-12345678");
    expect(env.GITHUB_TOKEN).toBe("ghs_worker-12345678");
    expect(env.ORCA_PI_GITHUB_IDENTITY).toBe("worker");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_CONFIG_COUNT).toBe("3");
    expect(env.GIT_CONFIG_KEY_0).toBe("credential.helper");
    expect(env.GIT_CONFIG_VALUE_0).toBe("");
    expect(env.GIT_CONFIG_KEY_1).toBe("credential.https://github.com.helper");
    expect(env.GIT_CONFIG_VALUE_1).toBe("");
    expect(env.GIT_CONFIG_KEY_2).toBe("credential.https://github.com.helper");
    expect(env.GIT_CONFIG_VALUE_2).toContain("git-credential --identity worker");
    expect(env.GIT_SSH_COMMAND).toBe(defaultSshGuardCommand());
    expect(JSON.stringify(env)).not.toContain("ghp_");
  });

  it("mutation classifier handles --method=POST equals form", () => {
    expect(isWorkerMutationCommand(["gh", "api", "--method=POST", "repos/o/r/pulls"])).toBe(true);
    expect(isWorkerMutationCommand(["gh", "api", "--method=GET", "repos/o/r/pulls"])).toBe(false);
  });
});

describe("blocker 4: cache bound to configured installation id", () => {
  function appEnvFor(installationId: string): Record<string, string> {
    return {
      ORCA_PI_GITHUB_WORKER_APP_ID: "1001",
      ORCA_PI_GITHUB_WORKER_PRIVATE_KEY_PATH: "/keys/worker.pem",
      ORCA_PI_GITHUB_WORKER_INSTALLATION_ID: installationId,
      ORCA_PI_GITHUB_WORKER_LOGIN: "orca-pi-worker[bot]",
      HOME: "/home/u",
    };
  }

  it("stale memory/disk entries for installation 111 are discarded after config moves to 222", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs1", format: "pem" }) as string;
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const mintFetch: GithubFetchFn = vi.fn(async (url: string) => {
      if (url.includes("/access_tokens")) {
        return { ok: true, status: 201, json: async () => ({ token: "ghs_fresh-222-12345678", expires_at: future }), text: async () => "{}" };
      }
      throw new Error("unexpected " + url);
    });
    const cache = createInstallationTokenCache();
    const staleExpires = new Date(Date.now() + 60 * 60 * 1000);
    cache.set("worker", { token: "ghs_stale-111-12345678", expiresAt: staleExpires, installationId: "111" });
    const diskPath = "/home/u/.pi/agent/github-tokens/worker.json";
    const fsWithStaleDisk = memFs({
      "/keys/worker.pem": pem,
      [diskPath]: JSON.stringify({ token: "ghs_stale-disk-111", expiresAt: future, installationId: "111" }),
    });
    const credential = await ensureInstallationToken("worker", {
      env: appEnvFor("222"),
      fs: fsWithStaleDisk,
      fetchFn: mintFetch,
      cache,
      homedir: "/home/u",
    });
    expect(credential.token).toBe("ghs_fresh-222-12345678");
    expect(credential.token).not.toContain("stale");
    expect(credential.installationId).toBe("222");
    expect(mintFetch).toHaveBeenCalled();
  });

  it("expired env tokens fall through to disk/App refresh instead of throwing", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs1", format: "pem" }) as string;
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const fs = memFs({ "/keys/worker.pem": pem });
    const mintFetch: GithubFetchFn = async (url: string) => {
      if (url.includes("/access_tokens")) {
        return { ok: true, status: 201, json: async () => ({ token: "ghs_refreshed-12345678", expires_at: future }), text: async () => "{}" };
      }
      throw new Error("unexpected " + url);
    };
    const credential = await ensureInstallationToken("worker", {
      env: {
        ORCA_PI_GITHUB_WORKER_TOKEN: "ghs_expired-env-12345678",
        ORCA_PI_GITHUB_WORKER_EXPIRES_AT: past,
        ORCA_PI_GITHUB_WORKER_APP_ID: "1001",
        ORCA_PI_GITHUB_WORKER_PRIVATE_KEY_PATH: "/keys/worker.pem",
        ORCA_PI_GITHUB_WORKER_INSTALLATION_ID: "111",
        HOME: "/home/u",
      },
      fs,
      fetchFn: mintFetch,
      cache: createInstallationTokenCache(),
      homedir: "/home/u",
    });
    expect(credential.token).toBe("ghs_refreshed-12345678");
  });

  it("expired env tokens still fail closed when refresh is impossible", async () => {
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    await expect(
      ensureInstallationToken("worker", {
        env: {
          ORCA_PI_GITHUB_WORKER_TOKEN: "ghs_expired-env-12345678",
          ORCA_PI_GITHUB_WORKER_EXPIRES_AT: past,
        },
        fs: memFs({}),
        cache: createInstallationTokenCache(),
      }),
    ).rejects.toMatchObject({ name: "GithubAuthError", code: "expired-token" });
  });
});



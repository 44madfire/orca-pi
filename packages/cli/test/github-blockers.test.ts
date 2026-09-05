import { describe, expect, it, vi } from "vitest";
import { runGithubCommand, type GithubCommandDeps } from "../src/commands/github.js";
import type { GithubFetchFn } from "@orca-pi/core";

function makeDeps(overrides?: Partial<GithubCommandDeps>): { deps: GithubCommandDeps; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const deps: GithubCommandDeps = {
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => err.push(text),
    env: overrides?.env ?? {},
    projectRoot: "/repo/p",
    ...(overrides?.fs ? { fs: overrides.fs } : {}),
    ...(overrides?.fetchFn ? { fetchFn: overrides.fetchFn } : {}),
    ...(overrides?.cache ? { cache: overrides.cache } : {}),
    ...(overrides?.runner ? { runner: overrides.runner } : {}),
    ...(overrides?.providerFs ? { providerFs: overrides.providerFs } : {}),
    ...(overrides?.stdinText ? { stdinText: overrides.stdinText } : {}),
    ...(overrides?.execSpawn ? { execSpawn: overrides.execSpawn } : {}),
  };
  return { deps, out, err };
}

function okPayload(data: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) };
}

const CRED = "protocol=https\nhost=github.com\n";

describe("blocker 1: separate invocations reuse disk cache (mint once, no TOKEN)", () => {
  it("mint -> auth status -> review -> git-credential get across invocations", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs1", format: "pem" }) as string;
    const keyPath = "/keys/reviewer.pem";
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const files: Record<string, string> = { [keyPath]: pem };
    const written: Record<string, string> = {};
    const providerFs = {
      async readFile(path: string) {
        const k = String(path);
        if (Object.hasOwn(files, k)) return files[k] as string;
        if (Object.hasOwn(written, k)) return written[k] as string;
        throw Object.assign(new Error("ENOENT " + k), { code: "ENOENT" });
      },
      async writeFile(path: string, data: string) {
        written[String(path)] = data;
      },
      async mkdir() {},
    };
    const appEnv = {
      ORCA_PI_GITHUB_REVIEWER_APP_ID: "1002",
      ORCA_PI_GITHUB_REVIEWER_PRIVATE_KEY_PATH: keyPath,
      ORCA_PI_GITHUB_REVIEWER_INSTALLATION_ID: "222",
      ORCA_PI_GITHUB_REVIEWER_LOGIN: "orca-pi-reviewer[bot]",
      HOME: "/home/u",
    };
    const fetchFn: GithubFetchFn = vi.fn(async (url: string) => {
      if (url.includes("/access_tokens")) return okPayload({ token: "ghs_cli-minted-12345678", expires_at: future }, 201);
      if (url.includes("/installation/repositories")) return okPayload({ repositories: [] }, 200);
      if (/\/pulls\/\d+$/.test(url)) return okPayload({ user: { login: "human-user" }, head: { sha: "feedfacefeedfacefeedfacefeedfacefeedface" } }, 200);
      if (url.includes("/reviews?")) return okPayload([], 200);
      if (url.endsWith("/reviews")) return okPayload({ id: 77 }, 200);
      throw new Error("unexpected " + url);
    });
    {
      const { deps, out } = makeDeps({ env: { ...appEnv }, fetchFn, providerFs });
      const r = await runGithubCommand(["mint", "--identity", "reviewer", "--json"], deps);
      expect(r.exitCode).toBe(0);
      expect(out.join("")).not.toContain("ghs_cli-minted-12345678");
    }
    {
      const { deps, out } = makeDeps({ env: { ...appEnv }, fetchFn, providerFs });
      const r = await runGithubCommand(["auth", "status", "--identity", "reviewer", "--json"], deps);
      expect(r.exitCode).toBe(0);
      const parsed = JSON.parse(out.join("")) as { configured: boolean; sourceLabel: string };
      expect(parsed.configured).toBe(true);
      expect(parsed.sourceLabel).toContain("cache-file");
      expect(out.join("")).not.toContain("ghs_cli-minted-12345678");
    }
    {
      const { deps, out } = makeDeps({ env: { ...appEnv }, fetchFn, providerFs });
      const r = await runGithubCommand(
        ["review", "--identity", "reviewer", "--pr", "o/r#1", "--verdict", "comment", "--body", "disk works"],
        deps,
      );
      expect(r.exitCode).toBe(0);
      expect(out.join("")).toContain("ok github review");
    }
    {
      const { deps, out } = makeDeps({
        env: { ...appEnv },
        fetchFn,
        providerFs,
        stdinText: async () => CRED,
      });
      const r = await runGithubCommand(["git-credential", "--identity", "reviewer", "get"], deps);
      expect(r.exitCode).toBe(0);
      expect(out.join("")).toContain("ghs_cli-minted-12345678");
    }
  });
});

describe("blocker 2: PAT in worker slot never spawns child / never reaches write API", () => {
  it("exec git push with PAT fails closed, no child spawned", async () => {
    const patFetch: GithubFetchFn = vi.fn(async (url: string) => {
      if (url.includes("/installation/repositories")) {
        return okPayload({}, 403);
      }
      throw new Error("must not reach write API: " + url);
    });
    let spawned = false;
    const { deps, err } = makeDeps({
      env: {
        ORCA_PI_GITHUB_WORKER_TOKEN: "ghp_human-pat-12345678",
        ORCA_PI_GITHUB_WORKER_LOGIN: "orca-pi-worker[bot]",
        ORCA_PI_GITHUB_WORKER_INSTALLATION_ID: "111",
      },
      fetchFn: patFetch,
      execSpawn: async () => {
        spawned = true;
        return 0;
      },
    });
    const r = await runGithubCommand(["exec", "--identity", "worker", "--", "git", "push", "origin", "HEAD"], deps);
    expect(r.exitCode).toBe(1);
    expect(spawned).toBe(false);
    expect(patFetch).toHaveBeenCalled();
    expect(err.join("")).not.toContain("ghp_human-pat-12345678");
  });

  it("exec gh pr create with PAT fails closed, no child spawned", async () => {
    const patFetch: GithubFetchFn = vi.fn(async (url: string) => {
      if (url.includes("/installation/repositories")) {
        return okPayload({}, 403);
      }
      throw new Error("must not reach write API: " + url);
    });
    let spawned = false;
    const { deps } = makeDeps({
      env: {
        ORCA_PI_GITHUB_WORKER_TOKEN: "ghp_human-pat-12345678",
        ORCA_PI_GITHUB_WORKER_LOGIN: "orca-pi-worker[bot]",
        ORCA_PI_GITHUB_WORKER_INSTALLATION_ID: "111",
      },
      fetchFn: patFetch,
      execSpawn: async () => {
        spawned = true;
        return 0;
      },
    });
    const r = await runGithubCommand(["exec", "--identity", "worker", "--", "gh", "pr", "create", "--title", "x"], deps);
    expect(r.exitCode).toBe(1);
    expect(spawned).toBe(false);
  });

  it("git-credential get with PAT fails closed, no password", async () => {
    const patFetch: GithubFetchFn = async (url: string) => {
      if (url.includes("/installation/repositories")) {
        return okPayload({}, 403);
      }
      throw new Error("must not reach: " + url);
    };
    const { deps, out, err } = makeDeps({
      env: {
        ORCA_PI_GITHUB_WORKER_TOKEN: "ghp_human-pat-12345678",
        ORCA_PI_GITHUB_WORKER_LOGIN: "orca-pi-worker[bot]",
        ORCA_PI_GITHUB_WORKER_INSTALLATION_ID: "111",
      },
      fetchFn: patFetch,
      stdinText: async () => CRED,
    });
    const r = await runGithubCommand(["git-credential", "--identity", "worker", "get"], deps);
    expect(r.exitCode).toBe(1);
    expect(out.join("")).not.toContain("password=");
    expect(err.join("")).not.toContain("ghp_human-pat-12345678");
  });
});

describe("worker exec is deterministically scoped (process override + SSH guard)", () => {
  const iatFetch: GithubFetchFn = vi.fn(async (url: string) => {
    if (url.includes("/installation/repositories")) {
      return { ok: true, status: 200, json: async () => ({ repositories: [] }), text: async () => "{}" };
    }
    throw new Error("unexpected " + url);
  });
  const workerEnv = {
    ORCA_PI_GITHUB_WORKER_TOKEN: "ghs_worker-12345678",
    ORCA_PI_GITHUB_WORKER_LOGIN: "orca-pi-worker[bot]",
    ORCA_PI_GITHUB_WORKER_INSTALLATION_ID: "111",
  };

  it("every worker exec preflights (even non-mutations) and injects git override + ssh guard", async () => {
    const seen: { command: string[]; env: Record<string, string> }[] = [];
    const { deps } = makeDeps({
      env: { ...workerEnv },
      fetchFn: iatFetch,
      execSpawn: async (command, options) => {
        seen.push({ command, env: options.env });
        return 0;
      },
    });
    const r = await runGithubCommand(["exec", "--identity", "worker", "--", "git", "status"], deps);
    expect(r.exitCode).toBe(0);
    expect(iatFetch).toHaveBeenCalled();
    const overlay = seen[0]?.env ?? {};
    expect(overlay.GH_TOKEN).toBe("ghs_worker-12345678");
    expect(overlay.GIT_CONFIG_COUNT).toBe("3");
    expect(overlay.GIT_CONFIG_KEY_2).toBe("credential.https://github.com.helper");
    expect(overlay.GIT_CONFIG_VALUE_2).toContain("git-credential --identity worker");
    expect(overlay.GIT_SSH_COMMAND).toContain("ssh-guard");
  });

  it("arbitrary executables still preflight (classifier cannot be bypassed)", async () => {
    let spawned = false;
    const patFetch: GithubFetchFn = async (url: string) => {
      if (url.includes("/installation/repositories")) {
        return { ok: false, status: 403, json: async () => ({}), text: async () => "forbidden" };
      }
      throw new Error("must not reach: " + url);
    };
    const { deps } = makeDeps({
      env: {
        ORCA_PI_GITHUB_WORKER_TOKEN: "ghp_human-pat-12345678",
        ORCA_PI_GITHUB_WORKER_LOGIN: "orca-pi-worker[bot]",
        ORCA_PI_GITHUB_WORKER_INSTALLATION_ID: "111",
      },
      fetchFn: patFetch,
      execSpawn: async () => {
        spawned = true;
        return 0;
      },
    });
    const r = await runGithubCommand(["exec", "--identity", "worker", "--", "python", "-c", "print(1)"], deps);
    expect(r.exitCode).toBe(1);
    expect(spawned).toBe(false);
  });

  it("ssh-guard fails closed with exit 128 and no secrets", async () => {
    const { deps, err } = makeDeps({ env: {} });
    const r = await runGithubCommand(["ssh-guard", "git@github.com", "git-upload-pack"], deps);
    expect(r.exitCode).toBe(128);
    expect(err.join("")).toMatch(/SSH remotes are not supported/i);
    expect(err.join("")).not.toMatch(/ghs_|ghp_/);
  });
});

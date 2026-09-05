import { describe, expect, it, vi } from "vitest";
import { runGithubCommand, type GithubCommandDeps } from "../src/commands/github.js";
import type { GithubFetchFn } from "@orca-pi/core";

function makeDeps(overrides?: Partial<GithubCommandDeps> & { fetchImpl?: GithubFetchFn }): {
  deps: GithubCommandDeps;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  const deps: GithubCommandDeps = {
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => err.push(text),
    env: overrides?.env ?? {},
    projectRoot: "/repo/p",
    ...(overrides?.fs ? { fs: overrides.fs } : {}),
    ...(overrides?.fetchFn ?? overrides?.fetchImpl ? { fetchFn: (overrides?.fetchFn ?? overrides?.fetchImpl) as GithubFetchFn } : {}),
    ...(overrides?.cache ? { cache: overrides.cache } : {}),
    ...(overrides?.runner ? { runner: overrides.runner } : {}),
    ...(overrides?.providerFs ? { providerFs: overrides.providerFs } : {}),
    ...(overrides?.stdinText ? { stdinText: overrides.stdinText } : {}),
    ...(overrides?.execSpawn ? { execSpawn: overrides.execSpawn } : {}),
  };
  return { deps, out, err };
}

const WORKER_ENV = {
  ORCA_PI_GITHUB_WORKER_TOKEN: "ghs_worker-12345678",
  ORCA_PI_GITHUB_WORKER_LOGIN: "orca-pi-worker[bot]",
  ORCA_PI_GITHUB_WORKER_INSTALLATION_ID: "111",
};
const REVIEWER_ENV = {
  ORCA_PI_GITHUB_REVIEWER_TOKEN: "ghs_reviewer-12345678",
  ORCA_PI_GITHUB_REVIEWER_LOGIN: "orca-pi-reviewer[bot]",
  ORCA_PI_GITHUB_REVIEWER_INSTALLATION_ID: "222",
};

describe("github auth status inherits profile identity (no --identity repeat)", () => {
  it("auth status --profile worker resolves without explicit --identity", async () => {
    const { deps, out } = makeDeps({ env: { ...WORKER_ENV } });
    const result = await runGithubCommand(["auth", "status", "--profile", "worker"], deps);
    expect(result.exitCode).toBe(0);
    expect(out.join("")).toContain('"worker"');
    expect(out.join("")).not.toContain("ghs_worker-12345678");
  });

  it("auth status inherits ORCA_PI_GITHUB_IDENTITY env (spawn terminal case)", async () => {
    const { deps, out } = makeDeps({
      env: { ...REVIEWER_ENV, ORCA_PI_GITHUB_IDENTITY: "reviewer" },
    });
    const result = await runGithubCommand(["auth", "status"], deps);
    expect(result.exitCode).toBe(0);
    expect(out.join("")).toContain('"reviewer"');
  });

  it("mismatched --identity vs --profile fails closed (reviewer cannot take worker)", async () => {
    const { deps, err } = makeDeps({ env: { ...WORKER_ENV, ...REVIEWER_ENV } });
    const result = await runGithubCommand(
      ["auth", "status", "--profile", "reviewer", "--identity", "worker"],
      deps,
    );
    expect(result.exitCode).toBe(1);
    expect(err.join("")).toMatch(/authoritative|cannot select worker/i);
  });
});

describe("github doctor/setup (non-secret diagnostics)", () => {
  it("doctor reports distinctness without secret values", async () => {
    const iatFetch: GithubFetchFn = vi.fn(async (url: string) => {
      const ok = (data: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) });
      if (url.includes("/installation/repositories")) return ok({ repositories: [] }, 200);
      throw new Error(`unexpected ${url}`);
    });
    const { deps, out } = makeDeps({ env: { ...WORKER_ENV, ...REVIEWER_ENV, GITHUB_ACTOR: "44madfire" }, fetchFn: iatFetch });
    const result = await runGithubCommand(["doctor", "--json"], deps);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(out.join("")) as { ok: boolean; distinctDetail: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.distinctDetail).toContain("orca-pi-worker[bot]");
    expect(out.join("")).not.toContain("ghs_worker-12345678");
  });

  it("identity doctor alias works", async () => {
    const { deps, out } = makeDeps({ env: {} });
    const result = await runGithubCommand(["identity", "doctor"], deps);
    expect(result.exitCode).toBe(1);
    expect(out.join("")).toContain("github identity doctor");
  });

  it("setup prints non-secret operator steps", async () => {
    const { deps, out } = makeDeps({ env: {} });
    const result = await runGithubCommand(["setup", "--identity", "worker"], deps);
    expect(result.exitCode).toBe(1);
    expect(out.join("")).toContain("Contents: write");
    expect(out.join("")).toContain("ORCA_PI_GITHUB_WORKER_APP_ID");
    expect(out.join("")).not.toMatch(/ghs_|BEGIN.*PRIVATE KEY/);
  });

  it("setup --json names missing vars", async () => {
    const { deps, out } = makeDeps({ env: {} });
    const result = await runGithubCommand(["setup", "--identity", "reviewer", "--json"], deps);
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(out.join("")) as { missing: string[] };
    expect(parsed.missing.join(",")).toContain("ORCA_PI_GITHUB_REVIEWER_APP_ID");
  });
});

describe("github mint/exec/setup-git broker (scoped, never prints secrets)", () => {
  it("mint with fresh env token prints metadata only", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const { deps, out } = makeDeps({
      env: { ORCA_PI_GITHUB_WORKER_TOKEN: "ghs_mint-12345678", ORCA_PI_GITHUB_WORKER_EXPIRES_AT: future },
      providerFs: {
        async readFile() {
          throw new Error("ENOENT");
        },
        async writeFile() {},
        async mkdir() {},
      },
    });
    const result = await runGithubCommand(["mint", "--identity", "worker", "--json"], deps);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(out.join("")) as { identity: string; expiresAt: string };
    expect(parsed.identity).toBe("worker");
    expect(parsed.expiresAt).toBe(future);
    expect(out.join("")).not.toContain("ghs_mint-12345678");
  });

  it("exec scopes env to the child and blocks reviewer push", async () => {
    const iatFetch: GithubFetchFn = vi.fn(async (url: string) => {
      const ok = (data: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) });
      if (url.includes("/installation/repositories")) return ok({ repositories: [] }, 200);
      throw new Error(`unexpected ${url}`);
    });
    const seen: { command: string[]; env: Record<string, string> }[] = [];
    const { deps } = makeDeps({
      env: { ...WORKER_ENV },
      fetchFn: iatFetch,
      execSpawn: async (command, options) => {
        seen.push({ command, env: options.env });
        return 0;
      },
    });
    const ok = await runGithubCommand(["exec", "--identity", "worker", "--", "git", "push", "origin", "HEAD"], deps);
    expect(ok.exitCode).toBe(0);
    expect(seen[0]?.command).toEqual(["git", "push", "origin", "HEAD"]);
    expect(seen[0]?.env.GH_TOKEN).toBe("ghs_worker-12345678");
    expect(seen[0]?.env.ORCA_PI_GITHUB_IDENTITY).toBe("worker");

    const { deps: rdeps, err } = makeDeps({
      env: { ...REVIEWER_ENV },
      execSpawn: async () => 0,
    });
    const blocked = await runGithubCommand(["exec", "--identity", "reviewer", "--", "git", "push", "origin", "HEAD"], rdeps);
    expect(blocked.exitCode).toBe(1);
    expect(err.join("")).toMatch(/Contents: read only|Refusing.*push/i);
  });

  it("exec inherits spawn env without --identity repeat", async () => {
    const iatFetch2: GithubFetchFn = vi.fn(async (url: string) => {
      const ok = (data: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) });
      if (url.includes("/installation/repositories")) return ok({ repositories: [] }, 200);
      throw new Error(`unexpected ${url}`);
    });
    const seen: string[][] = [];
    const { deps } = makeDeps({
      env: { ...WORKER_ENV, ORCA_PI_GITHUB_IDENTITY: "worker" },
      fetchFn: iatFetch2,
      execSpawn: async (command) => {
        seen.push(command);
        return 0;
      },
    });
    const result = await runGithubCommand(["exec", "--", "gh", "pr", "create", "--title", "x"], deps);
    expect(result.exitCode).toBe(0);
    expect(seen[0]).toEqual(["gh", "pr", "create", "--title", "x"]);
  });

  it("git-credential get pipes username/password (never logs framing)", async () => {
    const iatFetch3: GithubFetchFn = vi.fn(async (url: string) => {
      const ok = (data: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) });
      if (url.includes("/installation/repositories")) return ok({ repositories: [] }, 200);
      throw new Error(`unexpected ${url}`);
    });
    const { deps, out } = makeDeps({
      env: { ...WORKER_ENV },
      fetchFn: iatFetch3,
      stdinText: async () => "protocol=https\nhost=github.com\n",
    });
    const result = await runGithubCommand(["git-credential", "--identity", "worker", "get"], deps);
    expect(result.exitCode).toBe(0);
    expect(out.join("")).toContain("username=x-access-token");
    expect(out.join("")).toContain("ghs_worker-12345678");
  });

  it("setup-git pins --local and refuses reviewer", async () => {
    const seen: string[][] = [];
    const { deps, out } = makeDeps({
      env: {},
      runner: {
        async run(exe: string, args: readonly string[]) {
          seen.push([exe, ...args]);
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      },
    });
    const ok = await runGithubCommand(["setup-git", "--identity", "worker", "--path", "/wt/worker"], deps);
    expect(ok.exitCode).toBe(0);
    expect(out.join("")).toContain("--worktree");
    expect(seen.length).toBe(2);
    expect(seen[0]).toContain("--worktree");
    expect(seen[0]).toContain("--replace-all");
    expect(seen[1]).toContain("--worktree");
    expect(seen[1]).toContain("--add");
    expect(seen[0]).not.toContain("--global");

    const { deps: rdeps, err } = makeDeps({
      env: {},
      runner: {
        async run() {
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      },
    });
    const blocked = await runGithubCommand(["setup-git", "--identity", "reviewer", "--path", "/wt/x"], rdeps);
    expect(blocked.exitCode).toBe(1);
    expect(err.join("")).toMatch(/Contents: read only|must use the dedicated worker/i);
  });
});

describe("github review inherits profile (reviewer bot, no repeat)", () => {
  it("review --profile reviewer succeeds without --identity", async () => {
    const fetchFn: GithubFetchFn = vi.fn(async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
      const ok = (data: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) });
      if (url.includes("/installation/repositories")) return ok({ repositories: [] }, 200);
      if (/\/pulls\/\d+$/.test(url)) return ok({ user: { login: "human-user" }, head: { sha: "feedfacefeedfacefeedfacefeedfacefeedface" } }, 200);
      if (url.includes("/reviews?")) return ok([], 200);
      if (url.endsWith("/reviews")) return ok({ id: 7 }, 200);
      throw new Error(`unexpected ${init.method} ${url}`);
    });
    const { deps, out } = makeDeps({ env: { ...REVIEWER_ENV }, fetchFn });
    const result = await runGithubCommand(
      ["review", "--profile", "reviewer", "--pr", "o/r#1", "--verdict", "comment", "--body", "looks good"],
      deps,
    );
    expect(result.exitCode).toBe(0);
    expect(out.join("")).toContain("ok github review");
    expect(out.join("")).not.toContain("ghs_reviewer-12345678");
  });
});

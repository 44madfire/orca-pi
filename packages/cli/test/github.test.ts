import { describe, expect, it, vi } from "vitest";
import { run } from "../src/main.js";
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
    ...(overrides?.fs ? { fs: overrides.fs } : {}),
    ...(overrides?.fetchFn ?? overrides?.fetchImpl ? { fetchFn: (overrides?.fetchFn ?? overrides?.fetchImpl) as GithubFetchFn } : {}),
    ...(overrides?.cache ? { cache: overrides.cache } : {}),
  };
  return { deps, out, err };
}

const REVIEWER_BOT = "orca-pi-reviewer[bot]";
const REVIEWER_ENV = {
  ORCA_PI_GITHUB_REVIEWER_TOKEN: "ghs_secret-12345678",
  ORCA_PI_GITHUB_REVIEWER_LOGIN: REVIEWER_BOT,
  ORCA_PI_GITHUB_REVIEWER_INSTALLATION_ID: "123456",
};

/** Full mocked GitHub REST for review/check writes (IAT preflight + idempotency). Never mocks GET /user. */
function mockGithubFetch(options?: {
  prAuthor?: string;
  existingReviews?: unknown[];
  existingChecks?: unknown[];
}): { fetchFn: GithubFetchFn; posts: string[] } {
  const posts: string[] = [];
  const fetchFn: GithubFetchFn = vi.fn(async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const ok = (data: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) });
    if (url === "https://api.github.com/user") throw new Error("GET /user must never be called for installation tokens");
    if (url.includes("/installation/repositories") && init.method === "GET") {
      return ok({ total_count: 1, repositories: [{ id: 1, full_name: "o/r" }] }, 200);
    }
    if (/\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(url) && init.method === "GET") {
      return ok({ user: { login: options?.prAuthor ?? "human-user" } }, 200);
    }
    if (url.includes("/reviews?") && init.method === "GET") {
      return ok(options?.existingReviews ?? [], 200);
    }
    if (url.endsWith("/reviews") && init.method === "POST") {
      posts.push(url);
      return ok({ id: 42 }, 200);
    }
    if (url.includes("/check-runs?") && init.method === "GET") {
      return ok({ check_runs: options?.existingChecks ?? [] }, 200);
    }
    if (url.endsWith("/check-runs") && init.method === "POST") {
      posts.push(url);
      return ok({ id: 3001 }, 201);
    }
    if (/\/check-runs\/\d+$/.test(url) && init.method === "PATCH") {
      return ok({ id: 3001 }, 200);
    }
    throw new Error(`unexpected ${init.method} ${url}`);
  });
  return { fetchFn, posts };
}

function memFs(files: Record<string, string>): Pick<typeof import("node:fs/promises"), "readFile" | "stat"> {
  return {
    async readFile(path: unknown) {
      const key = String(path);
      if (Object.hasOwn(files, key)) return files[key]!;
      const error = new Error(`ENOENT: no such file ${key}`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    },
    async stat(path: unknown) {
      const key = String(path);
      if (Object.hasOwn(files, key)) return { isFile: () => true } as unknown as import("node:fs").Stats;
      const error = new Error(`ENOENT: no such file ${key}`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    },
  };
}

describe("orca-pi github auth status", () => {
  it("reports configured without leaking the token", async () => {
    const { deps, out } = makeDeps({ env: { ORCA_PI_GITHUB_REVIEWER_TOKEN: "ghs_secret-12345678" } });
    const result = await runGithubCommand(["auth", "status", "--identity", "reviewer"], deps);
    expect(result.exitCode).toBe(0);
    expect(out.join("")).toContain("ok github identity");
    expect(out.join("")).not.toContain("ghs_secret-12345678");
  });

  it("reports missing with exit 1 and actionable hint", async () => {
    const { deps, out } = makeDeps({ env: {} });
    const result = await runGithubCommand(["auth", "status", "--identity", "reviewer"], deps);
    expect(result.exitCode).toBe(1);
    expect(out.join("")).toContain("missing github identity");
  });

  it("supports --json without values", async () => {
    const { deps, out } = makeDeps({ env: { ORCA_PI_GITHUB_REVIEWER_TOKEN: "ghs_secret-12345678" } });
    const result = await runGithubCommand(["auth", "status", "--identity", "reviewer", "--json"], deps);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(out.join("")) as { configured: boolean; check: string };
    expect(parsed.configured).toBe(true);
    expect(parsed.check).toBe("orca-pi/agent-review");
    expect(out.join("")).not.toContain("ghs_secret-12345678");
  });

  it("rejects invalid identities with exit 2", async () => {
    const { deps, err } = makeDeps({ env: {} });
    const result = await runGithubCommand(["auth", "status", "--identity", "bad!!"], deps);
    expect(result.exitCode).toBe(2);
    expect(err.join("")).toContain("Invalid --identity");
  });
});

describe("orca-pi github review", () => {
  it("submits a review via the reviewer identity (mocked fetch + preflight)", async () => {
    const { fetchFn } = mockGithubFetch();
    const { deps, out } = makeDeps({ env: { ...REVIEWER_ENV }, fetchFn });
    const result = await runGithubCommand(
      ["review", "--identity", "reviewer", "--pr", "https://github.com/octo/hello-world/pull/9", "--verdict", "approve", "--body", "Looks good."],
      deps,
    );
    expect(result.exitCode).toBe(0);
    expect(out.join("")).toContain("ok github review");
    expect(fetchFn).toHaveBeenCalled();
    expect(out.join("")).not.toContain("ghs_secret-12345678");
  });

  it("Blocking 1: same configured reviewer as author never reaches POST (exit 1, no duplicate)", async () => {
    const { fetchFn, posts } = mockGithubFetch({ prAuthor: "orca-pi-reviewer[bot]" });
    const { deps, err } = makeDeps({ env: { ...REVIEWER_ENV }, fetchFn });
    const result = await runGithubCommand(
      ["review", "--identity", "reviewer", "--pr", "octo/hello-world#9", "--verdict", "comment", "--body", "hi"],
      deps,
    );
    expect(result.exitCode).toBe(1);
    expect(posts).toEqual([]);
    expect(err.join("") + "").toMatch(/same actor|distinct/i);
  });

  it("Blocking 1: --identity worker is refused before any network write", async () => {
    const fetchFn: GithubFetchFn = vi.fn(async () => {
      throw new Error("must not be called");
    });
    const { deps, err } = makeDeps({ env: { ORCA_PI_GITHUB_WORKER_TOKEN: "ghp_worker-12345678" }, fetchFn });
    const result = await runGithubCommand(
      ["review", "--identity", "worker", "--pr", "octo/hello-world#9", "--verdict", "approve", "--body", "hi"],
      deps,
    );
    expect(result.exitCode).toBe(1);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(err.join("")).toMatch(/must use the dedicated reviewer GitHub App/i);
  });

  it("reads --body @file", async () => {
    const { fetchFn } = mockGithubFetch();
    const { deps, out } = makeDeps({
      env: { ...REVIEWER_ENV },
      fs: { readFile: async () => "file body findings" },
      fetchFn,
    });
    const result = await runGithubCommand(
      ["review", "--identity", "reviewer", "--pr", "octo/hello-world#7", "--verdict", "comment", "--body", "@/tmp/review.md"],
      deps,
    );
    expect(result.exitCode).toBe(0);
    expect(out.join("")).toContain("ok github review");
  });

  it("requires --pr/--verdict/--body with exit 2", async () => {
    const { deps, err } = makeDeps({ env: {} });
    const result = await runGithubCommand(["review", "--identity", "reviewer", "--pr", "octo/hello-world#1"], deps);
    expect(result.exitCode).toBe(2);
    expect(err.join("")).toContain("Missing --verdict");
  });
});

describe("orca-pi github check", () => {
  it("starts a check run (idempotent create when none exists)", async () => {
    const { fetchFn } = mockGithubFetch({ existingChecks: [] });
    const { deps, out } = makeDeps({
      env: { ...REVIEWER_ENV },
      fetchFn,
    });
    const result = await runGithubCommand(
      ["check", "start", "--identity", "reviewer", "--repo", "octo/hello-world", "--sha", "abc1234def5678abc1234def5678abc1234def56"],
      deps,
    );
    expect(result.exitCode).toBe(0);
    expect(out.join("")).toContain("orca-pi/agent-review");
  });

  it("Blocking 3: repeating check start reuses the run (CLI-level retry, no duplicate POST)", async () => {
    const sha = "abc1234def5678abc1234def5678abc1234def56";
    const existing = [{ id: 3001, name: "orca-pi/agent-review", head_sha: sha, status: "in_progress" }];
    const posts: string[] = [];
    const fetchFn: GithubFetchFn = vi.fn(async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
      const ok = (data: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) });
      if (url === "https://api.github.com/user") throw new Error("GET /user must never be called for installation tokens");
      if (url.includes("/installation/repositories")) return ok({ repositories: [] }, 200);
      if (url.includes("/check-runs?")) return ok({ check_runs: existing }, 200);
      if (url.endsWith("/check-runs") && init.method === "POST") {
        posts.push(url);
        return ok({ id: 9999 }, 201);
      }
      if (/\/check-runs\/\d+$/.test(url)) return ok({ id: 3001 }, 200);
      throw new Error(`unexpected ${init.method} ${url}`);
    });
    const env = { ...REVIEWER_ENV };
    const first = await runGithubCommand(["check", "start", "--identity", "reviewer", "--repo", "o/r", "--sha", sha], makeDeps({ env, fetchFn }).deps);
    const second = await runGithubCommand(["check", "start", "--identity", "reviewer", "--repo", "o/r", "--sha", sha], makeDeps({ env, fetchFn }).deps);
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(posts).toEqual([]);
  });

  it("completes with failure for request-changes and success for approve", async () => {
    const mkFetch = (): GithubFetchFn => {
      const { fetchFn } = mockGithubFetch({ existingChecks: [] });
      return fetchFn;
    };
    const sha = "abc1234def5678abc1234def5678abc1234def56";
    const { deps: d1, out: o1 } = makeDeps({ env: { ORCA_PI_GITHUB_REVIEWER_TOKEN: "ghs_x-12345678", ORCA_PI_GITHUB_REVIEWER_LOGIN: REVIEWER_BOT, ORCA_PI_GITHUB_REVIEWER_INSTALLATION_ID: "1" }, fetchFn: mkFetch() });
    const r1 = await runGithubCommand(
      ["check", "complete", "--identity", "reviewer", "--repo", "o/r", "--sha", sha, "--verdict", "request-changes", "--summary", "blocking", "--check-run-id", "10", "--json"],
      d1,
    );
    expect(r1.exitCode).toBe(0);
    expect(JSON.parse(o1.join("")).conclusion).toBe("failure");

    const { deps: d2, out: o2 } = makeDeps({ env: { ORCA_PI_GITHUB_REVIEWER_TOKEN: "ghs_x-12345678", ORCA_PI_GITHUB_REVIEWER_LOGIN: REVIEWER_BOT, ORCA_PI_GITHUB_REVIEWER_INSTALLATION_ID: "1" }, fetchFn: mkFetch() });
    const r2 = await runGithubCommand(
      ["check", "complete", "--identity", "reviewer", "--repo", "o/r", "--sha", sha, "--verdict", "approve", "--summary", "clean", "--check-run-id", "11", "--json"],
      d2,
    );
    expect(r2.exitCode).toBe(0);
    expect(JSON.parse(o2.join("")).conclusion).toBe("success");
  });

  it("rejects unknown actions with exit 2", async () => {
    const { deps, err } = makeDeps({ env: {} });
    const result = await runGithubCommand(["check", "bogus", "--identity", "reviewer"], deps);
    expect(result.exitCode).toBe(2);
    expect(err.join("")).toContain('expected "start" or "complete"');
  });
});

describe("Blocking 2: inherited reviewer write access fails through the real profile path", () => {
  function cliDeps(files: Record<string, string>) {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      deps: {
        runner: { async run() { return { stdout: "", stderr: "", exitCode: 0 }; } },
        stdout: (t: string) => out.push(t),
        stderr: (t: string) => err.push(t),
        version: "0.1.0-test",
        projectRoot: "/repo/p",
        env: {},
        homedir: "/home/u",
        fs: memFs(files),
        userConfigPathOverride: "/home/u/.pi/agent/profiles.yaml",
        projectConfigPathOverride: "/repo/p/.pi/profiles.yaml",
      } as Parameters<typeof run>[1],
    };
  }

  it("profile validate rejects reviewer identity with inherited edit/write (extends)", async () => {
    // Custom profile (not the built-in "reviewer") so built-in safe tools
    // do not mask the inherited violation: base provides edit, child only
    // adds the reviewer identity slot.
    const projectYaml = `profiles:\n  base:\n    tools: [read, edit]\n  audit:\n    extends: base\n    githubIdentity: reviewer\n`;
    const { deps, out, err } = cliDeps({ "/repo/p/.pi/profiles.yaml": projectYaml });
    const result = await run(["profile", "validate", "audit"], deps);
    expect(result.exitCode).toBe(1);
    expect(out.join("") + err.join("")).toMatch(/source-write tools|invalid/i);
  });

  it("profile show rejects the same inherited violation (resolve boundary)", async () => {
    const projectYaml = `profiles:\n  base:\n    tools: [read, write]\n  audit:\n    extends: base\n    githubIdentity: reviewer\n`;
    const { deps, err } = cliDeps({ "/repo/p/.pi/profiles.yaml": projectYaml });
    const result = await run(["profile", "show", "audit"], deps);
    expect(result.exitCode).toBe(1);
    expect(err.join("")).toMatch(/source-write tools/i);
  });
});

describe("orca-pi github help", () => {
  it("prints usage for bare github", async () => {
    const { deps, out } = makeDeps({ env: {} });
    const result = await runGithubCommand([], deps);
    expect(result.exitCode).toBe(0);
    expect(out.join("")).toContain("orca-pi github");
  });
});

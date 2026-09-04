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
    ...(overrides?.fs ? { fs: overrides.fs } : {}),
    ...(overrides?.fetchFn ?? overrides?.fetchImpl ? { fetchFn: (overrides?.fetchFn ?? overrides?.fetchImpl) as GithubFetchFn } : {}),
    ...(overrides?.cache ? { cache: overrides.cache } : {}),
  };
  return { deps, out, err };
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
  it("submits a review via the reviewer identity (mocked fetch)", async () => {
    const fetchFn: GithubFetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 42 }),
      text: async () => "{}",
    }));
    const { deps, out } = makeDeps({ env: { ORCA_PI_GITHUB_REVIEWER_TOKEN: "ghs_secret-12345678" }, fetchFn });
    const result = await runGithubCommand(
      ["review", "--identity", "reviewer", "--pr", "https://github.com/octo/hello-world/pull/9", "--verdict", "approve", "--body", "Looks good."],
      deps,
    );
    expect(result.exitCode).toBe(0);
    expect(out.join("")).toContain("ok github review");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(out.join("")).not.toContain("ghs_secret-12345678");
  });

  it("reads --body @file", async () => {
    const fetchFn: GithubFetchFn = async () => ({ ok: true, status: 200, json: async () => ({ id: 7 }), text: async () => "{}" });
    const { deps, out } = makeDeps({
      env: { ORCA_PI_GITHUB_REVIEWER_TOKEN: "ghs_secret-12345678" },
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
  it("starts a check run", async () => {
    const fetchFn: GithubFetchFn = vi.fn(async (url, init) => {
      expect(init.method).toBe("POST");
      return { ok: true, status: 201, json: async () => ({ id: 3001 }), text: async () => "{}" };
    });
    const { deps, out } = makeDeps({
      env: { ORCA_PI_GITHUB_REVIEWER_TOKEN: "ghs_secret-12345678" },
      fetchFn,
    });
    const result = await runGithubCommand(
      ["check", "start", "--identity", "reviewer", "--repo", "octo/hello-world", "--sha", "abc1234def5678abc1234def5678abc1234def56"],
      deps,
    );
    expect(result.exitCode).toBe(0);
    expect(out.join("")).toContain("orca-pi/agent-review");
  });

  it("completes with failure for request-changes and success for approve", async () => {
    const mkFetch = (id: number): GithubFetchFn => async () => ({ ok: true, status: 200, json: async () => ({ id }), text: async () => "{}" });
    const sha = "abc1234def5678abc1234def5678abc1234def56";
    const { deps: d1, out: o1 } = makeDeps({ env: { ORCA_PI_GITHUB_REVIEWER_TOKEN: "ghs_x-12345678" }, fetchFn: mkFetch(1) });
    const r1 = await runGithubCommand(
      ["check", "complete", "--identity", "reviewer", "--repo", "o/r", "--sha", sha, "--verdict", "request-changes", "--summary", "blocking", "--check-run-id", "10", "--json"],
      d1,
    );
    expect(r1.exitCode).toBe(0);
    expect(JSON.parse(o1.join("")).conclusion).toBe("failure");

    const { deps: d2, out: o2 } = makeDeps({ env: { ORCA_PI_GITHUB_REVIEWER_TOKEN: "ghs_x-12345678" }, fetchFn: mkFetch(2) });
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

describe("orca-pi github help", () => {
  it("prints usage for bare github", async () => {
    const { deps, out } = makeDeps({ env: {} });
    const result = await runGithubCommand([], deps);
    expect(result.exitCode).toBe(0);
    expect(out.join("")).toContain("orca-pi github");
  });
});

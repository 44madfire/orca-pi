import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertWorktreeHelperConfigured,
  buildWorkerExecEnv,
  credentialHostKey,
  setupRepoGitAuth,
} from "../src/github/git-auth.js";
import type { ProcessRunner } from "../src/runner.js";

/** Real-git runner (spawns `git`, no mocks). Skips gracefully when git is missing. */
function realRunner(): ProcessRunner | undefined {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore", windowsHide: true });
  } catch {
    return undefined;
  }
  return {
    async run(executable: string, args: readonly string[]) {
      const result = spawnSync(executable, [...args], { encoding: "utf8", windowsHide: true });
      const status = result.status ?? 1;
      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: status,
      };
    },
  };
}

function git(args: readonly string[], cwd: string, env?: Record<string, string>): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? 1 };
}

describe("setup-git linked worktree integration (real git, no runner mocks)", () => {
  it("enables worktreeConfig and isolates the worker helper per linked worktree", async () => {
    const runner = realRunner();
    if (!runner) return;
    const base = mkdtempSync(join(tmpdir(), "orca-pi-wt-"));
    const main = join(base, "main");
    const linked = join(base, "linked");
    try {
      execFileSync("git", ["init", main], { stdio: "ignore", windowsHide: true });
      execFileSync("git", ["-C", main, "config", "user.email", "t@t.t"], { stdio: "ignore", windowsHide: true });
      execFileSync("git", ["-C", main, "config", "user.name", "t"], { stdio: "ignore", windowsHide: true });
      writeFileSync(join(main, "a.txt"), "hi\n");
      execFileSync("git", ["-C", main, "add", "a.txt"], { stdio: "ignore", windowsHide: true });
      execFileSync("git", ["-C", main, "commit", "-m", "init"], { stdio: "ignore", windowsHide: true });
      execFileSync("git", ["-C", main, "worktree", "add", linked], { stdio: "ignore", windowsHide: true });

      const receipt = await setupRepoGitAuth(runner, { repoPath: linked });
      expect(receipt.scope).toBe("--worktree");
      expect(receipt.hostKey).toBe(credentialHostKey());

      // Extension enabled in the common repo config (repo-scoped, never global).
      const ext = git(["config", "--get", "extensions.worktreeConfig"], linked);
      expect(ext.status).toBe(0);
      expect(ext.stdout.trim()).toBe("true");

      // Linked worktree exposes the deterministic host override ...
      const hostKey = credentialHostKey();
      const linkedHelpers = git(["config", "--show-origin", "--get-all", hostKey], linked);
      expect(linkedHelpers.status).toBe(0);
      expect(() =>
        assertWorktreeHelperConfigured(linkedHelpers.stdout, { repoPath: linked }),
      ).not.toThrow();
      expect(linkedHelpers.stdout).toContain("git-credential --identity worker");

      // ... while the main worktree does not inherit it (per-worktree isolation).
      const mainHelpers = git(["config", "--show-origin", "--get-all", hostKey], main);
      expect(mainHelpers.stdout).not.toContain("git-credential --identity worker");

      // Global config untouched by setup (worker helper must not leak there).
      const globalHelpers = git(["config", "--global", "--get-all", "credential.helper"], main);
      expect(globalHelpers.stdout).not.toContain("git-credential --identity worker");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("process overlay beats ambient helpers for github.com and withholds other hosts (real git credential fill)", async () => {
    const runner = realRunner();
    if (!runner) return;
    const base = mkdtempSync(join(tmpdir(), "orca-pi-fill-"));
    try {
      execFileSync("git", ["init", base], { stdio: "ignore", windowsHide: true });
      // Dummy helpers as portable node scripts (no shell dependency).
      const ambientHelper = join(base, "ambient-helper.mjs");
      const workerHelper = join(base, "worker-helper.mjs");
      const ambientCmd = `!node "${ambientHelper.split("\\").join("/")}"`;
      const workerCmd = `!node "${workerHelper.split("\\").join("/")}"`;
      writeFileSync(
        ambientHelper,
        "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{process.stdout.write('username=x-access-token\\npassword=AMBIENT_TOKEN\\n');});\n",
      );
      writeFileSync(
        workerHelper,
        "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{process.stdout.write('username=x-access-token\\npassword=WORKER_TOKEN\\n');});\n",
      );
      // Ambient generic helper at repo scope (simulates GCM holding the human credential).
      execFileSync("git", ["-C", base, "config", "credential.helper", ambientCmd], {
        stdio: "ignore",
        windowsHide: true,
      });
      const overlay = buildWorkerExecEnv("WORKER_TOKEN", {
        helperCommand: workerCmd,
      });
      const fill = (input: string, env?: Record<string, string>) =>
        spawnSync("git", ["credential", "fill"], {
          cwd: base,
          input,
          encoding: "utf8",
          windowsHide: true,
          env: { ...process.env, ...(env ?? {}) },
        });
      const githubInput = "protocol=https\nhost=github.com\n\n";
      const withOverlay = fill(githubInput, overlay);
      expect(withOverlay.status).toBe(0);
      expect(withOverlay.stdout).toContain("WORKER_TOKEN");
      expect(withOverlay.stdout).not.toContain("AMBIENT_TOKEN");
      const foreign = fill("protocol=https\nhost=example.invalid\n\n", overlay);
      expect(foreign.stdout).not.toContain("WORKER_TOKEN");
      expect(foreign.stdout).not.toContain("password=WORKER_TOKEN");
      const HIT = "WORKER_TOKEN:leaked";
      expect(foreign.stdout).not.toContain(HIT);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("SSH remotes fail closed via the guard (real git, no network)", async () => {
    const runner = realRunner();
    if (!runner) return;
    void runner;
    const base = mkdtempSync(join(tmpdir(), "orca-pi-ssh-"));
    try {
      execFileSync("git", ["init", base], { stdio: "ignore", windowsHide: true });
      execFileSync("git", ["-C", base, "config", "user.email", "t@t.t"], { stdio: "ignore", windowsHide: true });
      execFileSync("git", ["-C", base, "config", "user.name", "t"], { stdio: "ignore", windowsHide: true });
      execFileSync("git", ["-C", base, "remote", "add", "origin", "git@github.com:o/r.git"], {
        stdio: "ignore",
        windowsHide: true,
      });
      // Guard as a portable node script (mirrors `orca-pi github ssh-guard`: fail closed, exit 128).
      const guard = join(base, "ssh-guard.mjs");
      const guardFwd = guard.split("\\").join("/");
      writeFileSync(
        guard,
        "console.error('error: SSH remotes are not supported for worker Git operations');process.exit(128);\n",
      );
      const overlay = buildWorkerExecEnv("WORKER_TOKEN", { sshGuardCommand: `node "${guardFwd}"` });
      expect(overlay.GIT_SSH_COMMAND).toContain("ssh-guard");
      const ls = spawnSync("git", ["ls-remote", "origin"], {
        cwd: base,
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, ...overlay },
      });
      expect(ls.status).not.toBe(0);
      expect(`${ls.stderr}${ls.stdout}`).toMatch(/SSH remotes are not supported/i);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

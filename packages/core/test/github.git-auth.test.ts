import { describe, expect, it } from "vitest";
import {
  assertIdentityMayRunCommand,
  assertRepoLocalHelperConfigured,
  buildScopedEnvForIdentity,
  gitConfigArgsForSetup,
  handleGitCredentialRequest,
  isContentsWriteGitCommand,
  parseGitCredentialInput,
  redactGitCredentialOutput,
  setupRepoGitAuth,
} from "../src/github/git-auth.js";
import { GithubAuthError } from "../src/github/types.js";

describe("git-auth: scoped env never touches ambient", () => {
  it("builds a child-only overlay with GH_TOKEN pair", () => {
    const overlay = buildScopedEnvForIdentity("worker", "ghs_secret-12345678");
    expect(overlay.GH_TOKEN).toBe("ghs_secret-12345678");
    expect(overlay.GITHUB_TOKEN).toBe("ghs_secret-12345678");
    expect(overlay.ORCA_PI_GITHUB_IDENTITY).toBe("worker");
    expect(overlay.GIT_TERMINAL_PROMPT).toBe("0");
    // Overlay carries only scoped keys — callers spread it onto a child env.
    expect(Object.keys(overlay).sort()).toEqual(
      ["GH_TOKEN", "GITHUB_TOKEN", "GIT_TERMINAL_PROMPT", "ORCA_PI_GITHUB_IDENTITY"].sort(),
    );
  });
});

describe("git-auth: Contents-write guard", () => {
  it("detects git push as Contents-write", () => {
    expect(isContentsWriteGitCommand(["git", "push", "origin", "HEAD"])).toBe(true);
    expect(isContentsWriteGitCommand(["git", "push"])).toBe(true);
    expect(isContentsWriteGitCommand(["git", "pull"])).toBe(false);
    expect(isContentsWriteGitCommand(["git", "commit", "-m", "x"])).toBe(false);
    expect(isContentsWriteGitCommand(["gh", "pr", "create"])).toBe(false);
  });

  it("reviewer push is refused; worker push passes", () => {
    expect(() => assertIdentityMayRunCommand("reviewer", ["git", "push", "origin", "x"])).toThrow(
      GithubAuthError,
    );
    expect(() => assertIdentityMayRunCommand("worker", ["git", "push", "origin", "x"])).not.toThrow();
    expect(() => assertIdentityMayRunCommand("reviewer", ["git", "pull"])).not.toThrow();
  });
});

describe("git-auth: credential helper protocol", () => {
  it("parses key=value input", () => {
    expect(parseGitCredentialInput("protocol=https\nhost=github.com\npath=o/r\n")).toEqual({
      protocol: "https",
      host: "github.com",
      path: "o/r",
    });
  });

  it("get returns username/password; store/erase are no-ops", async () => {
    const get = await handleGitCredentialRequest("worker", "get", { host: "github.com" }, async () => ({
      token: "ghs_helper-12345678",
    }));
    expect(get.exitCode).toBe(0);
    expect(get.stdout).toContain("username=x-access-token");
    expect(get.stdout).toContain("password=ghs_helper-12345678");

    // Redaction helper scrubs the password line for any accidental log path.
    const redacted = redactGitCredentialOutput(get.stdout);
    expect(redacted).not.toContain("ghs_helper-12345678");
    expect(redacted).toContain("password=<redacted>");

    expect((await handleGitCredentialRequest("worker", "store", {}, async () => ({ token: "x" }))).stdout).toBe("");
    expect((await handleGitCredentialRequest("worker", "erase", {}, async () => ({ token: "x" }))).stdout).toBe("");
  });
});

describe("git-auth: repo-local setup never touches global", () => {
  it("builds git -C <path> config --local argv", () => {
    const { executable, args } = gitConfigArgsForSetup({
      repoPath: "/wt/worker",
      helperCommand: "orca-pi github git-credential --identity worker",
    });
    expect(executable).toBe("git");
    expect(args).toEqual([
      "-C",
      "/wt/worker",
      "config",
      "--local",
      "credential.helper",
      "orca-pi github git-credential --identity worker",
    ]);
    expect(args).not.toContain("--global");
    expect(args).not.toContain("--system");
  });

  it("refuses --global/--system scopes", () => {
    expect(() => gitConfigArgsForSetup({ repoPath: "/wt", helperCommand: "h", scope: "--global" })).toThrow(
      /never --global/,
    );
    expect(() => gitConfigArgsForSetup({ repoPath: "/wt", helperCommand: "h", scope: "--system" })).toThrow(
      /never --global/,
    );
  });

  it("setupRepoGitAuth invokes only --local via the runner", async () => {
    const seen: string[][] = [];
    const receipt = await setupRepoGitAuth(
      {
        async run(exe: string, args: readonly string[]) {
          seen.push([exe, ...args]);
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      },
      { repoPath: "/wt/worker" },
    );
    expect(receipt.helperCommand).toContain("git-credential --identity worker");
    expect(seen[0]).toContain("--local");
    expect(seen[0]).not.toContain("--global");
  });

  it("assertRepoLocalHelperConfigured requires a .git/config origin", () => {
    expect(() =>
      assertRepoLocalHelperConfigured("file:/home/u/.gitconfig\tcredential.helper=store\n", { repoPath: "/wt" }),
    ).toThrow(/not repo-local|remove any --global/i);
    expect(() =>
      assertRepoLocalHelperConfigured("file:/wt/.git/config\tcredential.helper=orca-pi github git-credential --identity worker\n"),
    ).not.toThrow();
    expect(() => assertRepoLocalHelperConfigured("", { repoPath: "/wt" })).toThrow(/No git credential.helper/i);
  });
});

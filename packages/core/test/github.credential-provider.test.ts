import { describe, expect, it, vi } from "vitest";
import {
  candidateSecretPaths,
  createAppJwt,
  describeAppConfigStatus,
  ensureInstallationToken,
  expandHomeInPath,
  isWindowsDrivePath,
  mintInstallationToken,
  normalizeSecretPath,
  tokenCacheFileForIdentity,
  windowsPathToWslPath,
  type CredentialProviderFs,
} from "../src/github/credential-provider.js";
import { createInstallationTokenCache } from "../src/github/github-app-auth.js";
import { GithubAuthError, type GithubFetchFn } from "../src/github/types.js";

function memProviderFs(files: Record<string, string> = {}): CredentialProviderFs & {
  written: Record<string, string>;
  mkdirs: string[];
} {
  const written: Record<string, string> = {};
  const mkdirs: string[] = [];
  return {
    written,
    mkdirs,
    async readFile(path: string) {
      const key = String(path);
      if (Object.hasOwn(files, key)) return files[key]!;
      if (Object.hasOwn(written, key)) return written[key]!;
      const error = new Error(`ENOENT: ${key}`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    },
    async writeFile(path: string, data: string) {
      written[String(path)] = data;
    },
    async mkdir(path: string) {
      mkdirs.push(String(path));
    },
  };
}

// Minimal RSA key for JWT shape tests (signing will fail gracefully if
// OpenSSL rejects it — tests assert error redaction, not live mint).
const FAKE_PEM = `-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----`;

describe("credential-provider: Windows/WSL path behavior", () => {
  it("detects Windows drive paths", () => {
    expect(isWindowsDrivePath("C:\\keys\\worker.pem")).toBe(true);
    expect(isWindowsDrivePath("C:/keys/worker.pem")).toBe(true);
    expect(isWindowsDrivePath("/mnt/c/keys/worker.pem")).toBe(false);
    expect(isWindowsDrivePath("~/.pi/key.pem")).toBe(false);
  });

  it("translates Windows paths to WSL mounts", () => {
    expect(windowsPathToWslPath("C:\\keys\\worker.pem")).toBe("/mnt/c/keys/worker.pem");
    expect(windowsPathToWslPath("D:/a/b.pem")).toBe("/mnt/d/a/b.pem");
    expect(windowsPathToWslPath("/mnt/c/a.pem")).toBe("/mnt/c/a.pem");
  });

  it("expands ~ via HOME", () => {
    expect(expandHomeInPath("~/.pi/key.pem", "/home/u")).toBe("/home/u/.pi/key.pem");
    expect(expandHomeInPath("~/k.pem", "/home/u")).toBe("/home/u/k.pem");
  });

  it("normalizes backslashes and expands home", () => {
    expect(normalizeSecretPath("~\\keys\\w.pem", { homedir: "/home/u" })).toBe("/home/u/keys/w.pem");
    expect(normalizeSecretPath("C:\\keys\\w.pem", {})).toBe("C:/keys/w.pem");
  });

  it("emits WSL candidates for drive paths", () => {
    const candidates = candidateSecretPaths("C:\\keys\\worker.pem", {});
    expect(candidates).toContain("C:/keys/worker.pem");
    expect(candidates).toContain("/mnt/c/keys/worker.pem");
  });

  it("cache file is outside the repo and per-identity", () => {
    const worker = tokenCacheFileForIdentity("worker", { env: { HOME: "/home/u" } });
    const reviewer = tokenCacheFileForIdentity("reviewer", { env: { HOME: "/home/u" } });
    expect(worker).toContain("github-tokens/worker.json");
    expect(reviewer).toContain("github-tokens/reviewer.json");
    expect(worker).not.toBe(reviewer);
    expect(worker).not.toContain("ghs_");
  });
});

describe("credential-provider: App JWT", () => {
  it("rejects missing App id without leaking", () => {
    expect(() => createAppJwt({ appId: "  ", privateKeyPem: FAKE_PEM })).toThrow(/App id/i);
  });

  it("rejects non-PEM keys with actionable guidance", () => {
    let error: unknown;
    try {
      createAppJwt({ appId: "123", privateKeyPem: "not-a-key" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(GithubAuthError);
    expect(String((error as Error).message)).toMatch(/PRIVATE KEY|pem/i);
    expect(String((error as Error).message)).not.toContain("not-a-key".repeat(2));
  });

  it("creates a three-part JWT with real RSA keys (deterministic iat/exp)", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs1", format: "pem" }) as string;
    const jwt = createAppJwt({ appId: "12345", privateKeyPem: pem, nowMs: 1_700_000_000_000 });
    expect(jwt.split(".")).toHaveLength(3);
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1] as string, "base64url").toString("utf8")) as {
      iss: string;
      iat: number;
      exp: number;
    };
    expect(payload.iss).toBe("12345");
    expect(payload.exp - payload.iat).toBe(660);
  });
});

describe("credential-provider: mint exchange", () => {
  it("mints via POST /app/installations/{id}/access_tokens", async () => {
    const seen: string[] = [];
    const fetchFn: GithubFetchFn = vi.fn(async (url: string, init) => {
      seen.push(`${init.method} ${url}`);
      expect(init.headers.Authorization?.startsWith("Bearer ")).toBe(true);
      return {
        ok: true,
        status: 201,
        json: async () => ({ token: "ghs_minted-12345678", expires_at: "2026-09-06T00:00:00Z" }),
        text: async () => "{}",
      };
    });
    const minted = await mintInstallationToken({ installationId: "999", appJwt: "jwt.header.sig", fetchFn });
    expect(minted.token).toBe("ghs_minted-12345678");
    expect(minted.expiresAt?.toISOString()).toBe("2026-09-06T00:00:00.000Z");
    expect(seen[0]).toContain("/app/installations/999/access_tokens");
  });

  it("maps 401/404 to actionable errors without leaking JWT", async () => {
    const jwt = "jwt.secret-value";
    const fetchFn: GithubFetchFn = async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => "bad" });
    let error: unknown;
    try {
      await mintInstallationToken({ installationId: "1", appJwt: jwt, fetchFn });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(GithubAuthError);
    expect(String((error as Error).message)).not.toContain(jwt);
  });
});

describe("credential-provider: ensureInstallationToken refresh/expiry", () => {
  it("prefers a fresh env token without minting", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const fs = memProviderFs();
    const fetchFn: GithubFetchFn = vi.fn(async () => {
      throw new Error("must not mint when env is fresh");
    });
    const credential = await ensureInstallationToken("worker", {
      env: { ORCA_PI_GITHUB_WORKER_TOKEN: "ghs_env-12345678", ORCA_PI_GITHUB_WORKER_EXPIRES_AT: future },
      fs,
      fetchFn,
      cache: createInstallationTokenCache(),
    });
    expect(credential.token).toBe("ghs_env-12345678");
    expect(credential.sourceLabel).toBe("ORCA_PI_GITHUB_WORKER_TOKEN");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("expired env tokens fail closed without leaking", async () => {
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    let error: unknown;
    try {
      await ensureInstallationToken("worker", {
        env: { ORCA_PI_GITHUB_WORKER_TOKEN: "ghs_expired-12345678", ORCA_PI_GITHUB_WORKER_EXPIRES_AT: past },
        fs: memProviderFs(),
        cache: createInstallationTokenCache(),
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(GithubAuthError);
    expect((error as GithubAuthError).code).toBe("expired-token");
    expect(String((error as Error).message)).not.toContain("ghs_expired-12345678");
  });

  it("reuses a fresh disk cache file without minting", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const cachePath = tokenCacheFileForIdentity("reviewer", { env: { HOME: "/home/u" } });
    const fs = memProviderFs({
      [cachePath]: JSON.stringify({ token: "ghs_disk-12345678", expiresAt: future, installationId: "123" }),
    });
    const fetchFn: GithubFetchFn = vi.fn(async () => {
      throw new Error("must not mint when disk cache is fresh");
    });
    const credential = await ensureInstallationToken("reviewer", {
      env: { HOME: "/home/u" },
      fs,
      fetchFn,
      cache: createInstallationTokenCache(),
      homedir: "/home/u",
    });
    expect(credential.token).toBe("ghs_disk-12345678");
    expect(credential.sourceLabel).toContain("cache-file");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("missing everything is actionable (names, never values)", async () => {
    let error: unknown;
    try {
      await ensureInstallationToken("worker", {
        env: {},
        fs: memProviderFs(),
        cache: createInstallationTokenCache(),
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(GithubAuthError);
    expect((error as GithubAuthError).code).toBe("missing-credential");
    expect(String((error as Error).message)).toContain("ORCA_PI_GITHUB_WORKER_APP_ID");
    expect(String((error as Error).message)).toContain("orca-pi github setup");
  });

  it("describeAppConfigStatus reports booleans, never values", () => {
    const status = describeAppConfigStatus("worker", {
      ORCA_PI_GITHUB_WORKER_APP_ID: "123",
      ORCA_PI_GITHUB_WORKER_PRIVATE_KEY_PATH: "/keys/w.pem",
    });
    expect(status.appIdConfigured).toBe(true);
    expect(status.privateKeyPathConfigured).toBe(true);
    expect(status.installationIdConfigured).toBe(false);
    expect(JSON.stringify(status)).not.toContain("/keys/w.pem");
  });
});

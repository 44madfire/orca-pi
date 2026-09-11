/**
 * Seam-adapter tests (UI1.2 round-4).
 *
 * Proves the harness-side adapter host-provisions scope and consent on
 * every forwarded panel request: panel-supplied roots are overwritten (not
 * trusted), host facts ride along for dispatcher enforcement, and
 * transport failures degrade to `internal` without trusting output.
 * Uses an injected fake spawn — no real processes.
 */
import { describe, expect, it } from "vitest";
import { createSeamAdapter } from "../src/seam-adapter.js";

function fakeSpawn(
  handler: (bin: string, args: readonly string[]) => { stdout: string; stderr: string; code: number },
): { calls: { bin: string; args: readonly string[] }[]; spawn: (bin: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string; code: number }> } {
  const calls: { bin: string; args: readonly string[] }[] = [];
  return {
    calls,
    spawn: (bin: string, args: readonly string[]) => {
      calls.push({ bin, args });
      return Promise.resolve(handler(bin, args));
    },
  };
}

function echoBridge(_bin: string, args: readonly string[]): { stdout: string; stderr: string; code: number } {
  const requestIndex = args.indexOf("--request");
  const request = JSON.parse(args[requestIndex + 1] as string) as { requestId: string; operation: string; worktree?: unknown };
  return {
    stdout: JSON.stringify({
      protocolVersion: 1,
      requestId: request.requestId,
      ok: true,
      result: { echo: request.operation, worktree: request.worktree ?? null, transport: args[args.indexOf("--transport") + 1] },
    }),
    stderr: "",
    code: 0,
  };
}

describe("seam adapter: host-provisioned scope and consent", () => {
  it("stamps the harness root over panel-supplied roots and uses seam transport", async () => {
    const fake = fakeSpawn(echoBridge);
    const adapter = createSeamAdapter({
      projectRoot: "/repo/p",
      hostFacts: { appVersion: "1.4.199", pluginApi: 1, grantedCapabilities: ["workspace:read"] },
      spawn: fake.spawn,
    });
    const res = await adapter.forward({
      protocolVersion: 1,
      requestId: "f1",
      operation: "profiles.list",
      worktree: { projectRoot: "/other" },
    });
    expect(res.ok).toBe(true);
    expect(fake.calls).toHaveLength(1);
    const args = fake.calls[0]!.args;
    expect(args).toContain("--transport");
    expect(args[args.indexOf("--transport") + 1]).toBe("seam");
    expect(args).toContain("--host-app-version");
    expect(args).toContain("--granted-capability");
    const sent = JSON.parse(args[args.indexOf("--request") + 1] as string) as { worktree: { projectRoot: string } };
    expect(sent.worktree.projectRoot).toBe("/repo/p");
    if (res.ok) {
      expect((res.result as { worktree: { projectRoot: string } }).worktree.projectRoot).toBe("/repo/p");
    }
  });

  it("rejects malformed panel requests before spawning", async () => {
    const fake = fakeSpawn(echoBridge);
    const adapter = createSeamAdapter({ projectRoot: "/repo/p", spawn: fake.spawn });
    const res = await adapter.forward({ protocolVersion: 1, requestId: "bad id!", operation: "profiles.list" });
    expect(res.ok).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });

  it("rejects mismatched requestIds and non-JSON output without trusting data", async () => {
    const mismatch = fakeSpawn(() => ({
      stdout: JSON.stringify({ protocolVersion: 1, requestId: "someone-else", ok: true, result: {} }),
      stderr: "",
      code: 0,
    }));
    const adapter = createSeamAdapter({ projectRoot: "/repo/p", spawn: mismatch.spawn });
    const res = await adapter.forward({ protocolVersion: 1, requestId: "f2", operation: "profiles.list" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("internal");

    const garbage = fakeSpawn(() => ({ stdout: "not json", stderr: "boom", code: 1 }));
    const adapter2 = createSeamAdapter({ projectRoot: "/repo/p", spawn: garbage.spawn });
    const res2 = await adapter2.forward({ protocolVersion: 1, requestId: "f3", operation: "profiles.list" });
    expect(res2.ok).toBe(false);
    if (!res2.ok) expect(res2.error.code).toBe("internal");
  });

  it("surfaces spawn failures as internal errors", async () => {
    const adapter = createSeamAdapter({
      projectRoot: "/repo/p",
      spawn: () => Promise.reject(new Error("ENOENT: orca-pi")),
    });
    const res = await adapter.forward({ protocolVersion: 1, requestId: "f4", operation: "profiles.list" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("internal");
  });

  it("capabilities() reports what the seam transport will permit", async () => {
    const fake = fakeSpawn(echoBridge);
    const adapter = createSeamAdapter({ projectRoot: "/repo/p", spawn: fake.spawn });
    const res = await adapter.capabilities("cap-1");
    expect(res.requestId).toBe("cap-1");
    expect(fake.calls).toHaveLength(1);
  });
});

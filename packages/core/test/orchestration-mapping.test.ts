import { describe, expect, it } from "vitest";
import {
  getWorkerMappingPath,
  loadWorkerMappings,
  recordWorkerMapping,
  resolveMapping,
} from "../src/orchestration/mapping-store.js";

function memMappingFs(files: Record<string, string> = {}) {
  const store: Record<string, string> = { ...files };
  return {
    files: store,
    async readFile(path: string) {
      if (Object.hasOwn(store, path)) return store[path]!;
      const error = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    },
    async writeFile(path: string, content: string) {
      store[path] = content;
    },
    async mkdir(): Promise<void> {
      return undefined;
    },
  };
}

describe("worker mapping store (minimal, Orca remains authoritative)", () => {
  it("builds a project-scoped path", () => {
    expect(getWorkerMappingPath("/repo/p")).toBe("/repo/p/.pi/orca-pi-workers.json");
  });

  it("reads missing files as empty", async () => {
    const fs = memMappingFs();
    expect(await loadWorkerMappings("/repo/p", fs)).toEqual({});
  });

  it("records under dispatch/terminal/task keys and resolves aliases", async () => {
    const fs = memMappingFs();
    await recordWorkerMapping(
      "/repo/p",
      {
        dispatchId: "dispatch_1",
        taskId: "task_1",
        terminalHandle: "term_1",
        profileName: "scout",
        createdAt: new Date(0).toISOString(),
      },
      fs,
    );
    const table = await loadWorkerMappings("/repo/p", fs);
    expect(resolveMapping(table, "dispatch_1")?.taskId).toBe("task_1");
    expect(resolveMapping(table, "term_1")?.dispatchId).toBe("dispatch_1");
    expect(resolveMapping(table, "task_1")?.terminalHandle).toBe("term_1");
    expect(resolveMapping(table, "unknown")).toBeUndefined();
  });

  it("skips corrupt entries without throwing", async () => {
    const fs = memMappingFs({
      "/repo/p/.pi/orca-pi-workers.json": JSON.stringify({
        "dispatch:good": {
          dispatchId: "d",
          taskId: "t",
          terminalHandle: "h",
          profileName: "scout",
          createdAt: new Date(0).toISOString(),
        },
        "dispatch:bad": { nonsense: true },
      }),
    });
    const table = await loadWorkerMappings("/repo/p", fs);
    expect(table["dispatch:good"]?.dispatchId).toBe("d");
    expect(table["dispatch:bad"]).toBeUndefined();
  });
});

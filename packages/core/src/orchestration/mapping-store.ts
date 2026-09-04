/**
 * Minimal worker-mapping store (OP1.5 / JEF-9).
 *
 * The compact CLI persists only the handle mapping Orca cannot derive from a
 * single flag: dispatch id <-> terminal handle <-> task id, plus profile and
 * worktree hints for human output. Orca remains the orchestration source of
 * truth — this file is a convenience index, never an authority for
 * completion/status. All status/wait/stop decisions re-read Orca live state.
 *
 * Default location: `<projectRoot>/.pi/orca-pi-workers.json`. The store is
 * best-effort: missing/corrupt files read as empty, and write failures are
 * surfaced but never block a successful spawn receipt (the receipt itself
 * already carries every id the coordinator needs).
 */

export interface WorkerMappingEntry {
  readonly dispatchId: string;
  readonly taskId: string;
  readonly terminalHandle: string;
  readonly profileName: string;
  readonly worktreeId?: string;
  readonly runId?: string;
  readonly createdAt: string;
}

export type WorkerMappingTable = Record<string, WorkerMappingEntry>;

export const WORKER_MAPPING_FILENAME = "orca-pi-workers.json";
export const WORKER_MAPPING_DIRNAME = ".pi";

export function getWorkerMappingPath(projectRoot: string): string {
  const normalized = projectRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  return `${normalized}/${WORKER_MAPPING_DIRNAME}/${WORKER_MAPPING_FILENAME}`;
}

export interface MappingFs {
  readFile(path: string, encoding: string): Promise<string>;
  writeFile(path: string, content: string, encoding: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
}

async function defaultFs(): Promise<MappingFs> {
  const fs = await import("node:fs/promises");
  return {
    readFile: (p, enc) => fs.readFile(p, enc as BufferEncoding) as Promise<string>,
    writeFile: (p, c, enc) => fs.writeFile(p, c, enc as BufferEncoding),
    mkdir: (p, opts) => fs.mkdir(p, opts).then(() => undefined),
  };
}

function dirnameOf(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx <= 0 ? "." : normalized.slice(0, idx);
}

/** Load the mapping table (missing/corrupt files read as empty, never throw). */
export async function loadWorkerMappings(
  projectRoot: string,
  fs?: MappingFs,
): Promise<WorkerMappingTable> {
  const mappingPath = getWorkerMappingPath(projectRoot);
  const io = fs ?? (await defaultFs());
  try {
    const text = await io.readFile(mappingPath, "utf8");
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: WorkerMappingTable = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const entry = value as Record<string, unknown>;
      if (
        typeof entry["dispatchId"] !== "string" ||
        typeof entry["taskId"] !== "string" ||
        typeof entry["terminalHandle"] !== "string" ||
        typeof entry["profileName"] !== "string"
      ) {
        continue;
      }
      out[key] = {
        dispatchId: entry["dispatchId"] as string,
        taskId: entry["taskId"] as string,
        terminalHandle: entry["terminalHandle"] as string,
        profileName: entry["profileName"] as string,
        ...(typeof entry["worktreeId"] === "string" ? { worktreeId: entry["worktreeId"] as string } : {}),
        ...(typeof entry["runId"] === "string" ? { runId: entry["runId"] as string } : {}),
        ...(typeof entry["createdAt"] === "string"
          ? { createdAt: entry["createdAt"] as string }
          : { createdAt: new Date(0).toISOString() }),
      };
    }
    return out;
  } catch {
    return {};
  }
}

/** Record one worker mapping under dispatch, terminal, and task keys. */
export async function recordWorkerMapping(
  projectRoot: string,
  entry: WorkerMappingEntry,
  fs?: MappingFs,
): Promise<{ path: string; persisted: boolean }> {
  const mappingPath = getWorkerMappingPath(projectRoot);
  const io = fs ?? (await defaultFs());
  const existing = await loadWorkerMappings(projectRoot, io);
  const next: WorkerMappingTable = { ...existing };
  next[`dispatch:${entry.dispatchId}`] = entry;
  next[`terminal:${entry.terminalHandle}`] = entry;
  next[`task:${entry.taskId}`] = entry;
  try {
    await io.mkdir(dirnameOf(mappingPath), { recursive: true });
    await io.writeFile(mappingPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return { path: mappingPath, persisted: true };
  } catch {
    return { path: mappingPath, persisted: false };
  }
}

/** Resolve a `--worker`/`--task` value via the local mapping table. */
export function resolveMapping(
  table: WorkerMappingTable,
  raw: string,
): WorkerMappingEntry | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  return (
    table[`dispatch:${trimmed}`] ??
    table[`terminal:${trimmed}`] ??
    table[`task:${trimmed}`] ??
    table[trimmed]
  );
}

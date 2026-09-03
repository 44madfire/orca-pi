/**
 * Minimal process-spawning abstraction.
 *
 * Core never touches `node:child_process` directly so unit tests can inject
 * fake executables and the library stays usable outside Node (and without
 * Electron/Orca Desktop). The CLI provides the real Node implementation
 * (see `runner.ts`).
 */
export interface CommandResult {
  stdout: string;
  stderr: string;
  /** Process exit code. `0` means success. */
  exitCode: number;
}

export interface ProcessRunner {
  run(executable: string, args: readonly string[]): Promise<CommandResult>;
}

/** Error thrown by runners when an executable cannot be started. */
export class ExecutableNotFoundError extends Error {
  readonly executable: string;
  constructor(executable: string, message?: string) {
    super(message ?? `Executable not found: ${executable}`);
    this.name = "ExecutableNotFoundError";
    this.executable = executable;
  }
}

/** Normalize runner failures into a stable discriminated shape. */
export function isNotFoundError(error: unknown): boolean {
  if (error instanceof ExecutableNotFoundError) return true;
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    return code === "ENOENT";
  }
  return false;
}

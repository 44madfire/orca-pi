import { spawn } from "node:child_process";
import {
  ExecutableNotFoundError,
  type CommandResult,
  type ProcessRunner,
} from "./runner.js";

/**
 * Real Node.js `ProcessRunner` used by the CLI.
 *
 * Lives in core (not the CLI) so panels/skills and future hosts can reuse
 * the same spawning semantics, but it imports only `node:child_process` —
 * never Electron or Orca Desktop APIs.
 *
 * Windows note: npm-shimmed CLIs such as `pi` resolve to a `.cmd` batch
 * file, which `spawn()` cannot execute directly (`shell: false` yields
 * ENOENT/EINVAL). On `win32` the command is therefore run through the
 * system shell as a single escaped command line; on POSIX the executable
 * is spawned directly with an argv array. Callers only ever pass the fixed
 * `doctor` argv (`--version`, `status --json`), so shell metacharacters
 * cannot be injected through this path.
 */
export function createNodeRunner(options?: {
  timeoutMs?: number;
}): ProcessRunner {
  const timeoutMs = options?.timeoutMs ?? 15_000;
  return {
    async run(
      executable: string,
      args: readonly string[],
    ): Promise<CommandResult> {
      return await new Promise<CommandResult>((resolve, reject) => {
        const useShell = process.platform === "win32";
        const child = useShell
          ? spawn(quoteCommand(executable, args), {
              windowsHide: true,
              timeout: timeoutMs,
              shell: true,
            })
          : spawn(executable, [...args], {
              windowsHide: true,
              timeout: timeoutMs,
            });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += String(chunk);
        });
        child.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });
        child.on("error", (error) => {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT") {
            reject(new ExecutableNotFoundError(executable));
            return;
          }
          reject(error);
        });
        child.on("close", (code) => {
          resolve({ stdout, stderr, exitCode: code ?? 1 });
        });
      });
    },
  };
}

/** Quote one argv token for `cmd.exe` when running through a shell. */
function quoteArg(token: string): string {
  if (/^[A-Za-z0-9_.:+=,@%/-]+$/.test(token)) return token;
  return `"${token.replace(/"/g, '""')}"`;
}

/** Join an executable plus argv into a single escaped command line. */
function quoteCommand(executable: string, args: readonly string[]): string {
  return [executable, ...args].map(quoteArg).join(" ");
}

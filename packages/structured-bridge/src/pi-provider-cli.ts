/**
 * Child-process entrypoint for the Pi-backed external provider (SNC1.4).
 *
 * Spawned by `BridgeHost` in real-process integration tests and by the Orca
 * dev branch for the first real Pi structured chat (`ORCA_PI_BRIDGE_COMMAND`):
 *
 *   node packages/structured-bridge/dist/pi-provider-cli.js
 *   node packages/structured-bridge/dist/pi-provider-cli.js --pi-command pi --pi-arg --model --pi-arg glm-5.3-flash
 *
 * Speaks strict LF-only JSONL on stdio (via `BridgeProvider.run`), keeps one
 * `pi --mode rpc` child per bridge session (cwd = acquire `workspaceRoot`,
 * the exact Orca-selected workspace), and exits 0 on stdin EOF (`close`
 * handshake + bounded Pi teardown) or SIGTERM. No Pi TUI, no terminal
 * keystroke injection, no credentials over the bridge.
 *
 * Transport-neutral profile configuration travels via `--pi-arg` (callers
 * should pass `buildPiLaunch()` output) or via the `resolvePiSpec` hook when
 * embedding this provider programmatically. TUI-only flags are rejected
 * fail-closed (`PI_TUI_FLAG`) so Orca falls back to the normal Pi TUI path.
 */

import { PiBridgeProvider } from "./pi-provider.js";

function parseCliArgs(argv: readonly string[]): { piCommand: string; piArgs: string[] } {
  let piCommand = process.env["ORCA_PI_PI_COMMAND"]?.trim() || "pi";
  const piArgs: string[] = [];
  const envArgs = process.env["ORCA_PI_PI_ARGS"]?.trim();
  if (envArgs) {
    // Space-separated fallback for dev shells (argv form is preferred).
    piArgs.push(...envArgs.split(/\s+/).filter((a) => a !== ""));
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--pi-command" && i + 1 < argv.length) {
      const value = argv[++i];
      if (value !== undefined && value.trim() !== "") piCommand = value;
    } else if ((arg === "--pi-arg" || arg === "--pi-args") && i + 1 < argv.length) {
      const value = argv[++i];
      if (value !== undefined) piArgs.push(value);
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "usage: pi-provider-cli.js [--pi-command <exe>] [--pi-arg <arg>...]\n" +
          "  Spawns one `pi --mode rpc` child per bridge session (cwd = acquire workspaceRoot).\n" +
          "  Env overrides: ORCA_PI_PI_COMMAND, ORCA_PI_PI_ARGS (space-separated).\n",
      );
      process.exit(0);
    }
  }
  return { piCommand, piArgs };
}

const { piCommand, piArgs } = parseCliArgs(process.argv.slice(2));
const provider = new PiBridgeProvider({ piCommand, piArgs });
const detach = provider.run(
  process.stdin as unknown as Parameters<PiBridgeProvider["run"]>[0],
  process.stdout as unknown as Parameters<PiBridgeProvider["run"]>[1],
);

let exiting = false;
function shutdown(signal: string): void {
  if (exiting) return;
  exiting = true;
  // Signal/EOF fallback path (host force-close or pipe EOF without a bridge
  // `close` handshake): boundedly close every Pi child with observed exit
  // before leaving, so no `pi --mode rpc` process leaks. The normal path is
  // the bridge `close` handshake (`onPiClose`); this covers the rest.
  void (async () => {
    try {
      // `dispose()` is bounded by `PiRpcConnection.close()` (EOF grace →
      // SIGTERM grace → SIGKILL grace → synthetic finish, never hangs), so
      // await it to completion: exiting early would cut off the force-kill
      // stages and leak the child when it ignores EOF.
      await provider.dispose();
    } catch {
      // Teardown is best-effort; never block process exit.
    }
    try {
      detach();
    } catch {
      // Cleanup must not throw.
    }
    // Give the final `closed` line one tick to flush before exiting.
    setTimeout(() => {
      void signal;
      process.exit(0);
    }, 20);
  })();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.stdin.on("end", () => shutdown("EOF"));

/**
 * Child-process entrypoint for the mock external provider (SNC1.3).
 *
 * Spawned by `BridgeHost` in real-process integration tests and by the
 * future Orca dev branch for manual E2E (`ORCA_PI_BRIDGE_COMMAND`):
 *
 *   node packages/structured-bridge/dist/mock-provider-cli.js
 *
 * Speaks strict LF-only JSONL on stdio, keeps no state beyond the process,
 * and exits 0 on stdin EOF (`close{graceful}`) or SIGTERM. No Pi, no
 * network, no secrets.
 */
import { MockExternalProvider } from "./provider.js";

const provider = new MockExternalProvider();
const detach = provider.run(
  process.stdin as unknown as Parameters<MockExternalProvider["run"]>[0],
  process.stdout as unknown as Parameters<MockExternalProvider["run"]>[1],
);

process.on("SIGTERM", () => {
  detach();
  process.exit(0);
});
process.stdin.on("end", () => {
  detach();
  // Give the final `closed` line one tick to flush before exiting.
  setTimeout(() => process.exit(0), 20);
});

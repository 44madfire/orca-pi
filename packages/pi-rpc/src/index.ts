/**
 * `@orca-pi/pi-rpc` barrel (SNC1.1).
 *
 * Real-Pi RPC contract proofs: strict LF-only JSONL framing, a minimal
 * spike client, fixture normalization/validation, and baseline metadata.
 * No Electron/Orca Desktop dependencies.
 */
export {
  attachJsonlReader,
  JsonlFramer,
  parseJsonLine,
  serializeJsonLine,
  splitJsonLines,
} from "./jsonl.js";
export {
  defaultPiCommand,
  SpikeClient,
  type SpikeClientOptions,
  type SpikeRecord,
  type WaitResponseOptions,
} from "./spike-client.js";
export {
  assertLfOnlyJsonl,
  assertSecretFreeLine,
  createRecordNormalizer,
  normalizeRecord,
  PLACEHOLDERS,
} from "./normalize.js";
export {
  collectBaseline,
  isPiBaseline,
  type BaselineModelSummary,
  type PiBaseline,
} from "./baseline.js";

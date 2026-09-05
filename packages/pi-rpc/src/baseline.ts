/**
 * Baseline Pi version / protocol metadata collection (SNC1.1).
 *
 * Records the real Pi binary version and the protocol-relevant surface
 * without secrets: no API keys, tokens, session contents, or absolute user
 * paths are ever collected here. Model catalog entries are reduced to
 * `{ provider, id, reasoning, supportsImages }` plus counts.
 */

import { execFile } from "node:child_process";

export interface BaselineModelSummary {
  provider: string;
  id: string;
  reasoning: boolean;
  supportsImages: boolean;
}

export interface PiBaseline {
  /** Raw `pi --version` output trimmed (e.g. "0.84.4"). */
  piVersion: string;
  /** `process.platform` of the capturing host. */
  platform: string;
  /** Node version used to drive the capture. */
  nodeVersion: string;
  /** UTC ISO timestamp of capture. */
  capturedAt: string;
  /** Number of models in the live catalog (offline runs report 0). */
  modelCount: number;
  /** Redacted model summaries (no costs/urls/tokens). */
  models: BaselineModelSummary[];
  /** Thinking levels observed for the default model. */
  thinkingLevels: string[];
  /** RPC framing contract (constant; asserted by tests + fixtures). */
  framing: "LF-only";
  /** Commands exercised by the fixture set. */
  commandsCovered: string[];
  /** Events observed on stdout during capture. */
  eventsObserved: string[];
}

function runPiVersion(piCommand: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(piCommand, ["--version"], { timeout: 15_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      const out = `${stdout}\n${stderr}`.trim();
      const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(out);
      resolve(match?.[1] ?? out);
    });
  });
}

export async function collectBaseline(piCommand = "pi"): Promise<PiBaseline> {
  const piVersion = await runPiVersion(piCommand);
  return {
    piVersion,
    platform: process.platform,
    nodeVersion: process.version,
    capturedAt: new Date().toISOString(),
    modelCount: -1, // filled by the capture script from get_available_models
    models: [],
    thinkingLevels: [],
    framing: "LF-only",
    commandsCovered: [],
    eventsObserved: [],
  };
}

/** Shape guard for the checked-in `fixtures/baseline.json`. */
export function isPiBaseline(value: unknown): value is PiBaseline {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["piVersion"] === "string" &&
    typeof v["platform"] === "string" &&
    typeof v["framing"] === "string" &&
    Array.isArray(v["models"])
  );
}

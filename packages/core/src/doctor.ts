import { isNotFoundError, type ProcessRunner } from "./runner.js";

/**
 * `orca-pi doctor` — read-only environment diagnostics.
 *
 * Verifies `orca` and `pi` are on PATH and reports their versions.
 * Must never mutate configuration: it only spawns `<exe> --version`
 * (and `orca status --json` as a fallback, since `orca --version` does not
 * currently print a version) and parses the output.
 */

export type DoctorExecutable = "orca" | "pi";

export interface DoctorCheck {
  executable: DoctorExecutable;
  found: boolean;
  /** Parsed version string, when detectable (e.g. "1.4.196", "0.84.4"). */
  version?: string;
  /** Human-readable detail: version output, or an actionable error. */
  detail: string;
}

export interface DoctorReport {
  orca: DoctorCheck;
  pi: DoctorCheck;
  /** True when both executables were found and produced a version. */
  ok: boolean;
}

export const ORCA_INSTALL_HINT =
  "Install Orca Desktop and ensure the `orca` CLI is on PATH. See https://www.onorca.dev/docs/cli/overview";
export const PI_INSTALL_HINT =
  "Install the Pi coding agent and ensure the `pi` CLI is on PATH. See https://github.com/up0to1/pi-mono/blob/main/packages/coding-agent/README.md";

/**
 * Detect shell "command not found" output. On Windows the runner executes
 * through `cmd.exe` (npm `.cmd` shims cannot be spawned directly), so a
 * missing executable surfaces as a non-zero exit with this text rather than
 * ENOENT. Normalize it to the same actionable "not found on PATH" shape.
 */
function looksLikeMissingExecutable(output: string): boolean {
  const normalized = output.toLowerCase();
  return (
    normalized.includes("not recognized as an internal or external command") ||
    normalized.includes("command not found") ||
    normalized.includes("was not recognised as an internal or external command")
  );
}

/** Extract the first semver-like token (e.g. "1.4.196", "0.84.4-beta.1"). */
export function parseVersionFromText(text: string): string | undefined {
  const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(text);
  return match?.[1];
}

/** Extract `result.runtime.appVersion` from `orca status --json` output. */
export function parseOrcaStatusJson(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      const result = (parsed as { result?: unknown }).result;
      if (result && typeof result === "object") {
        const runtime = (result as { runtime?: unknown }).runtime;
        if (runtime && typeof runtime === "object") {
          const appVersion = (runtime as { appVersion?: unknown }).appVersion;
          if (typeof appVersion === "string" && appVersion.length > 0) {
            return appVersion;
          }
        }
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function checkPi(runner: ProcessRunner): Promise<DoctorCheck> {
  try {
    const result = await runner.run("pi", ["--version"]);
    if (result.exitCode !== 0) {
      const output = `${result.stdout}\n${result.stderr}`.trim();
      if (output && looksLikeMissingExecutable(output)) {
        return {
          executable: "pi",
          found: false,
          detail: `\`pi\` was not found on PATH. ${PI_INSTALL_HINT}`,
        };
      }
      return {
        executable: "pi",
        found: false,
        detail:
          `The \`pi\` executable ran but exited with code ${result.exitCode}. ` +
          (output ? `Output: ${output}. ` : "") +
          PI_INSTALL_HINT,
      };
    }
    const combined = `${result.stdout}\n${result.stderr}`;
    const version = parseVersionFromText(combined);
    if (!version) {
      return {
        executable: "pi",
        found: true,
        detail:
          "`pi --version` produced no parseable version. " +
          `Raw output: ${combined.trim() || "(empty)"}. ` +
          PI_INSTALL_HINT,
      };
    }
    return { executable: "pi", found: true, version, detail: `pi ${version}` };
  } catch (error) {
    if (isNotFoundError(error)) {
      return {
        executable: "pi",
        found: false,
        detail: `\`pi\` was not found on PATH. ${PI_INSTALL_HINT}`,
      };
    }
    throw error;
  }
}

async function checkOrca(runner: ProcessRunner): Promise<DoctorCheck> {
  // Probe 1: `orca --version`. Current Orca CLIs print usage without a
  // version here, so a parse failure falls through to probe 2.
  try {
    const versionProbe = await runner.run("orca", ["--version"]);
    if (versionProbe.exitCode === 0) {
      const version = parseVersionFromText(
        `${versionProbe.stdout}\n${versionProbe.stderr}`,
      );
      if (version) {
        return {
          executable: "orca",
          found: true,
          version,
          detail: `orca ${version}`,
        };
      }
    }
  } catch (error) {
    if (isNotFoundError(error)) {
      return {
        executable: "orca",
        found: false,
        detail: `\`orca\` was not found on PATH. ${ORCA_INSTALL_HINT}`,
      };
    }
    throw error;
  }

  // Probe 2: `orca status --json` → result.runtime.appVersion.
  try {
    const status = await runner.run("orca", ["status", "--json"]);
    if (status.exitCode !== 0) {
      const output = `${status.stdout}\n${status.stderr}`.trim();
      if (output && looksLikeMissingExecutable(output)) {
        return {
          executable: "orca",
          found: false,
          detail: `\`orca\` was not found on PATH. ${ORCA_INSTALL_HINT}`,
        };
      }
      return {
        executable: "orca",
        found: false,
        detail:
          `The \`orca\` executable ran but neither \`--version\` nor \`status --json\` produced a version ` +
          `(status exit code ${status.exitCode}). ` +
          (output ? `Output: ${output}. ` : "") +
          ORCA_INSTALL_HINT,
      };
    }
    const version =
      parseOrcaStatusJson(status.stdout) ??
      parseVersionFromText(`${status.stdout}\n${status.stderr}`);
    if (!version) {
      return {
        executable: "orca",
        found: true,
        detail:
          "`orca` is on PATH but no version could be parsed from `status --json`. " +
          ORCA_INSTALL_HINT,
      };
    }
    return {
      executable: "orca",
      found: true,
      version,
      detail: `orca ${version}`,
    };
  } catch (error) {
    if (isNotFoundError(error)) {
      return {
        executable: "orca",
        found: false,
        detail: `\`orca\` was not found on PATH. ${ORCA_INSTALL_HINT}`,
      };
    }
    throw error;
  }
}

/** Run both checks. Never writes files, env vars, or configuration. */
export async function doctor(runner: ProcessRunner): Promise<DoctorReport> {
  const [orca, pi] = await Promise.all([checkOrca(runner), checkPi(runner)]);
  return {
    orca,
    pi,
    ok: orca.found && pi.found && Boolean(orca.version) && Boolean(pi.version),
  };
}

/** One-line-per-check human rendering for terminal output. */
export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    `${report.orca.found && report.orca.version ? "ok" : "missing"} orca${report.orca.version ? ` ${report.orca.version}` : ""} — ${report.orca.detail}`,
    `${report.pi.found && report.pi.version ? "ok" : "missing"} pi${report.pi.version ? ` ${report.pi.version}` : ""} — ${report.pi.detail}`,
  ];
  lines.push(
    report.ok
      ? "doctor: all required CLIs are available."
      : "doctor: one or more CLIs are missing — see details above.",
  );
  return lines.join("\n");
}

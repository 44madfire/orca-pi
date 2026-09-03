/**
 * Orca plugin manifest model + validator (OP1.1 scaffold).
 *
 * The Orca plugin API is still evolving (see docs/ORCA_PLUGIN_API.md and
 * upstream stablyai/orca#13306 / #15637). This module defines our
 * best-effort forward-compatible manifest shape and validates it locally so
 * `npm test` proves the shipped artifact is well-formed without requiring
 * Electron or Orca Desktop.
 */

export interface OrcaPluginCommandContribution {
  id: string;
  title: string;
  description?: string;
}

export interface OrcaPluginPanelContribution {
  id: string;
  title: string;
  /** Path to the panel entry (e.g. "./panel.html"), relative to the plugin root. */
  entry: string;
}

export interface OrcaPluginSkillContribution {
  /** Skill id exposed to Orca (e.g. "orca-pi-doctor"). */
  id: string;
  /** Path to the skill directory, relative to the plugin root. */
  path: string;
}

export interface OrcaPluginManifest {
  /** Unique plugin key, e.g. "orca-pi". */
  name: string;
  displayName: string;
  /** Semver plugin version — must track the orca-pi release line. */
  version: string;
  description: string;
  /**
   * Orca plugin-API range this artifact was authored against (e.g. "1.4.x").
   * See `TARGET_ORCA_API_RANGE` in version.ts.
   */
  orcaApiVersion: string;
  /** Minimum Orca app version that can load this artifact. */
  minOrcaAppVersion?: string;
  main?: string;
  contributions?: {
    commands?: OrcaPluginCommandContribution[];
    panels?: OrcaPluginPanelContribution[];
    skills?: OrcaPluginSkillContribution[];
  };
}

export interface ManifestValidation {
  ok: boolean;
  errors: string[];
}

const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate an unknown value as an `OrcaPluginManifest`. Pure function. */
export function validatePluginManifest(manifest: unknown): ManifestValidation {
  const errors: string[] = [];
  if (!isRecord(manifest)) {
    return { ok: false, errors: ["manifest must be a JSON object"] };
  }

  if (typeof manifest["name"] !== "string" || manifest["name"].length === 0) {
    errors.push('manifest.name must be a non-empty string (e.g. "orca-pi")');
  }
  if (
    typeof manifest["displayName"] !== "string" ||
    manifest["displayName"].length === 0
  ) {
    errors.push("manifest.displayName must be a non-empty string");
  }
  if (typeof manifest["version"] !== "string" || !SEMVER_RE.test(manifest["version"] as string)) {
    errors.push("manifest.version must be a semver string (e.g. \"0.1.0\")");
  }
  if (
    typeof manifest["description"] !== "string" ||
    manifest["description"].length === 0
  ) {
    errors.push("manifest.description must be a non-empty string");
  }
  if (
    typeof manifest["orcaApiVersion"] !== "string" ||
    manifest["orcaApiVersion"].length === 0
  ) {
    errors.push(
      'manifest.orcaApiVersion must be a non-empty range (e.g. "1.4.x")',
    );
  }

  const contributions = manifest["contributions"];
  if (contributions !== undefined) {
    if (!isRecord(contributions)) {
      errors.push("manifest.contributions must be an object when present");
    } else {
      const commands = contributions["commands"];
      if (commands !== undefined) {
        if (!Array.isArray(commands) || commands.length === 0) {
          errors.push("contributions.commands must be a non-empty array when present");
        } else {
          for (const [index, command] of commands.entries()) {
            if (!isRecord(command)) {
              errors.push(`contributions.commands[${index}] must be an object`);
              continue;
            }
            if (typeof command["id"] !== "string" || command["id"].length === 0) {
              errors.push(`contributions.commands[${index}].id must be a non-empty string`);
            }
            if (typeof command["title"] !== "string" || command["title"].length === 0) {
              errors.push(`contributions.commands[${index}].title must be a non-empty string`);
            }
          }
        }
      }
      const panels = contributions["panels"];
      if (panels !== undefined) {
        if (!Array.isArray(panels) || panels.length === 0) {
          errors.push("contributions.panels must be a non-empty array when present");
        } else {
          for (const [index, panel] of panels.entries()) {
            if (!isRecord(panel)) {
              errors.push(`contributions.panels[${index}] must be an object`);
              continue;
            }
            if (typeof panel["id"] !== "string" || panel["id"].length === 0) {
              errors.push(`contributions.panels[${index}].id must be a non-empty string`);
            }
            if (typeof panel["title"] !== "string" || panel["title"].length === 0) {
              errors.push(`contributions.panels[${index}].title must be a non-empty string`);
            }
            if (typeof panel["entry"] !== "string" || panel["entry"].length === 0) {
              errors.push(`contributions.panels[${index}].entry must be a non-empty relative path`);
            } else if (
              (panel["entry"] as string).startsWith("/") ||
              /^[a-zA-Z]:[\\/]/.test(panel["entry"] as string)
            ) {
              errors.push(`contributions.panels[${index}].entry must be plugin-relative, not absolute`);
            }
          }
        }
      }
      const skills = contributions["skills"];
      if (skills !== undefined) {
        if (!Array.isArray(skills)) {
          errors.push("contributions.skills must be an array when present");
        } else {
          for (const [index, skill] of skills.entries()) {
            if (!isRecord(skill)) {
              errors.push(`contributions.skills[${index}] must be an object`);
              continue;
            }
            if (typeof skill["id"] !== "string" || skill["id"].length === 0) {
              errors.push(`contributions.skills[${index}].id must be a non-empty string`);
            }
            if (typeof skill["path"] !== "string" || skill["path"].length === 0) {
              errors.push(`contributions.skills[${index}].path must be a non-empty relative path`);
            }
          }
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

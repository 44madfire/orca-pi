/**
 * Single source of truth for the orca-pi release line.
 *
 * Kept in code (rather than read from package.json at runtime) so the
 * companion CLI and the Orca plugin can share one version string without
 * filesystem coupling. Release tooling must bump this together with the
 * `version` fields in package.json files and `orca.plugin.json`.
 */
export const ORCA_PI_VERSION = "0.1.0";

/** Orca app version this scaffold was developed and smoke-tested against. */
export const TARGET_ORCA_APP_VERSION = "1.4.196";

/** Host-API major version (`pluginApi`) this scaffold targets. */
export const TARGET_ORCA_PLUGIN_API = 1;

/**
 * `orca-pi profile(s)` commands (OP1.7 / JEF-11).
 *
 * User-facing inspection/validation UX over the authoritative CLI/profile
 * file store. Reuses OP1.2 schema/resolver/presentation for all display
 * data; never creates a second config store.
 *
 * Commands (both `profile` and `profiles` accepted as aliases):
 *   orca-pi profiles list [--json]
 *   orca-pi profile show <name> [--json] [--show-prompt]
 *   orca-pi profile inspect <name> [--json] [--show-prompt] [--context-summary]
 *   orca-pi profile validate [<name>] [--json]
 *   orca-pi profile path [--project|--user] [--json]
 *
 * JEF-7 boundary: this module never builds Pi argv. `inspect` accepts an
 * optional injected {@link LaunchPreviewProvider} (JEF-7's redacted
 * launch-spec formatter); when absent it states that launch preview is
 * unavailable instead of implementing a second formatter.
 */

import {
  describeProfile,
  formatConfigPaths,
  formatProfileInspect,
  formatProfileShow,
  formatProfilesList,
  formatValidationReport,
  getProjectProfilesPath,
  getUserProfilesPath,
  loadProfilesFile,
  mergeValidatedDocuments,
  summarizeAllProfiles,
  validateAllProfiles,
  type LaunchPreviewProvider,
  type ProfileLayerContext,
  type ValidatedProfilesDocument,
} from "@orca-pi/core";
import { ProfileLoadError, ProfileValidationError } from "@orca-pi/core";
import { ProfileResolveError } from "@orca-pi/core";

export interface ProfilesCommandDeps {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Documented project root (defaults to `process.cwd()` in the CLI bootstrap). */
  projectRoot: string;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  osHomedir?: () => string;
  fs?: Pick<typeof import("node:fs/promises"), "readFile">;
  /**
   * JEF-7 seam: redacted launch-preview formatter. When omitted, `inspect`
   * omits argv preview with an explicit note (never builds argv itself).
   */
  getLaunchPreview?: LaunchPreviewProvider;
  userConfigPathOverride?: string;
  projectConfigPathOverride?: string;
}

export interface ProfilesCommandResult {
  exitCode: number;
}

const PROFILES_USAGE = `orca-pi profiles — inspect and validate Pi role profiles

Usage:
  orca-pi profiles list [--json]
  orca-pi profile show <name> [--json] [--show-prompt]
  orca-pi profile inspect <name> [--json] [--show-prompt] [--context-summary]
  orca-pi profile validate [<name>] [--json]
  orca-pi profile path [--project|--user] [--json]

The CLI/profile file is authoritative (user/global < project); the UI never
creates a second store. show/inspect redact large prompt bodies unless
--show-prompt is given. inspect never builds Pi argv itself — launch preview
comes from JEF-7's formatter when available.
`;

function resolvePaths(deps: ProfilesCommandDeps): {
  userPath: string;
  projectPath: string;
} {
  const userPath =
    deps.userConfigPathOverride ??
    getUserProfilesPath({
      env: deps.env,
      homedir: deps.homedir,
      osHomedir: deps.osHomedir,
    });
  const projectPath =
    deps.projectConfigPathOverride ??
    getProjectProfilesPath(deps.projectRoot);
  return { userPath, projectPath };
}

async function loadLayers(
  deps: ProfilesCommandDeps,
): Promise<ProfileLayerContext> {
  const { userPath, projectPath } = resolvePaths(deps);
  const fsOpts = deps.fs ? { fs: deps.fs } : {};
  const [userDoc, projectDoc] = await Promise.all([
    loadProfilesFile(userPath, fsOpts),
    loadProfilesFile(projectPath, fsOpts),
  ]);
  const docs: ValidatedProfilesDocument[] = [];
  if (userDoc) docs.push(userDoc);
  if (projectDoc) docs.push(projectDoc);
  const mergedDoc = mergeValidatedDocuments(docs);
  return {
    mergedDoc,
    ...(userDoc ? { userDoc } : {}),
    ...(projectDoc ? { projectDoc } : {}),
    userPath,
    projectPath,
    userExists: userDoc !== undefined,
    projectExists: projectDoc !== undefined,
  };
}

function formatLoadError(error: unknown): string {
  if (error instanceof ProfileLoadError) {
    const location = error.location ? ` (${error.location})` : "";
    return `Failed to load Pi profiles from ${error.sourceLabel}${location}:\n  ${error.message}`;
  }
  if (error instanceof ProfileValidationError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function isHelpFlag(arg: string): boolean {
  return arg === "--help" || arg === "-h" || arg === "help";
}

async function runList(
  args: readonly string[],
  deps: ProfilesCommandDeps,
): Promise<ProfilesCommandResult> {
  const asJson = args.includes("--json");
  const unknown = args.filter((arg) => arg !== "--json");
  if (unknown.length > 0) {
    if (unknown.some(isHelpFlag)) {
      deps.stdout(`${PROFILES_USAGE}`);
      return { exitCode: 0 };
    }
    deps.stderr(`error: unknown profiles list option(s): ${unknown.join(", ")}\n`);
    deps.stderr("usage: orca-pi profiles list [--json]\n");
    return { exitCode: 2 };
  }
  let layers: ProfileLayerContext;
  try {
    layers = await loadLayers(deps);
  } catch (error) {
    deps.stderr(`${formatLoadError(error)}\n`);
    return { exitCode: 1 };
  }
  const summaries = summarizeAllProfiles(layers);
  if (asJson) {
    deps.stdout(
      `${JSON.stringify(
        {
          profiles: summaries,
          config: {
            userPath: layers.userPath,
            projectPath: layers.projectPath,
            userExists: layers.userExists,
            projectExists: layers.projectExists,
          },
        },
        null,
        2,
      )}\n`,
    );
    return { exitCode: 0 };
  }
  deps.stdout(`${formatProfilesList(summaries, layers, { home: deps.homedir })}\n`);
  return { exitCode: 0 };
}

async function runShow(
  args: readonly string[],
  deps: ProfilesCommandDeps,
  options: { inspect: boolean },
): Promise<ProfilesCommandResult> {
  let asJson = false;
  let showPrompt = false;
  let contextSummary = false;
  let name: string | undefined;
  const unknown: string[] = [];
  for (const arg of args) {
    if (arg === "--json") asJson = true;
    else if (arg === "--show-prompt") showPrompt = true;
    else if (arg === "--context-summary") {
      if (!options.inspect) unknown.push(arg);
      else contextSummary = true;
    } else if (isHelpFlag(arg)) {
      deps.stdout(`${PROFILES_USAGE}`);
      return { exitCode: 0 };
    } else if (arg.startsWith("--")) unknown.push(arg);
    else if (name === undefined) name = arg;
    else unknown.push(arg);
  }
  if (unknown.length > 0) {
    deps.stderr(
      `error: unknown profile ${options.inspect ? "inspect" : "show"} option(s): ${unknown.join(", ")}\n`,
    );
    deps.stderr(
      options.inspect
        ? "usage: orca-pi profile inspect <name> [--json] [--show-prompt] [--context-summary]\n"
        : "usage: orca-pi profile show <name> [--json] [--show-prompt]\n",
    );
    return { exitCode: 2 };
  }
  if (!name) {
    deps.stderr(`error: missing profile name\n`);
    deps.stderr(
      options.inspect
        ? "usage: orca-pi profile inspect <name> [--json] [--show-prompt] [--context-summary]\n"
        : "usage: orca-pi profile show <name> [--json] [--show-prompt]\n",
    );
    return { exitCode: 2 };
  }
  let layers: ProfileLayerContext;
  try {
    layers = await loadLayers(deps);
  } catch (error) {
    deps.stderr(`${formatLoadError(error)}\n`);
    return { exitCode: 1 };
  }
  if (Object.keys(layers.mergedDoc.profiles).length === 0) {
    deps.stderr(
      `error: unknown Pi profile "${name}". No profiles found in:\n` +
        `  user/global: ${layers.userPath}${layers.userExists ? "" : " (missing — optional)"}\n` +
        `  project:     ${layers.projectPath}${layers.projectExists ? "" : " (missing — optional)"}\n` +
        `See profiles/examples.yaml for a starting point.\n`,
    );
    return { exitCode: 1 };
  }
  try {
    const detail = describeProfile(name, layers);
    const home = deps.homedir;
    if (asJson) {
      // JSON stays redacted unless --show-prompt: large prompt bodies are
      // replaced with a truncated preview plus an explicit flag.
      const resolved = detail.resolved;
      const prompt = resolved.systemPrompt;
      const promptTruncated =
        !showPrompt && prompt !== undefined && prompt.length > 240;
      const jsonResolved: Record<string, unknown> = { ...resolved };
      if (promptTruncated && typeof prompt === "string") {
        jsonResolved.systemPrompt = `${prompt.slice(0, 240)}…`;
      }
      const provenance: Record<string, string> = {
        provider: detail.provider.provenance.display,
        model: detail.model.provenance.display,
        thinking: detail.thinking.provenance.display,
        systemPrompt: detail.systemPrompt.provenance.display,
        systemPromptFile: detail.systemPromptFile.provenance.display,
        tools: detail.tools.provenance.display,
        excludeTools: detail.excludeTools.provenance.display,
        skills: detail.skills.provenance.display,
        extensions: detail.extensions.provenance.display,
        contextFiles: detail.contextFiles.provenance.display,
        discoverSkills: detail.discoverSkills.provenance.display,
        discoverExtensions: detail.discoverExtensions.provenance.display,
        session: detail.session.provenance.display,
      };
      const payload: Record<string, unknown> = {
        profile: jsonResolved,
        provenance,
        extendsChain: detail.extendsChain,
        ...(detail.sourceLabel ? { sourceLabel: detail.sourceLabel } : {}),
        config: {
          userPath: layers.userPath,
          projectPath: layers.projectPath,
          userExists: layers.userExists,
          projectExists: layers.projectExists,
        },
        redacted: !showPrompt,
        ...(promptTruncated ? { promptTruncated: true } : {}),
      };
      if (options.inspect) {
        let launchPreview: string | undefined;
        if (deps.getLaunchPreview) {
          try {
            launchPreview = deps.getLaunchPreview(detail.resolved);
          } catch (error) {
            payload.launchPreviewError =
              error instanceof Error ? error.message : String(error);
          }
        } else {
          payload.launchPreview = null;
          payload.launchPreviewNote =
            "unavailable — deterministic Pi argv is owned by JEF-7 (ResolvedPiProfile → ProcessSpec + redacted formatter)";
        }
        if (launchPreview !== undefined) payload.launchPreview = launchPreview;
        if (contextSummary) {
          payload.contextSummary = {
            thinking: detail.resolved.thinking,
            toolCount: detail.resolved.tools?.length,
            skillCount: detail.resolved.skills?.length ?? 0,
            extensionCount: detail.resolved.extensions?.length ?? 0,
            contextFiles: detail.resolved.contextFiles,
            session: detail.resolved.session,
          };
        }
      }
      deps.stdout(`${JSON.stringify(payload, null, 2)}\n`);
      return { exitCode: 0 };
    }
    if (options.inspect) {
      let launchPreview: string | undefined;
      if (deps.getLaunchPreview) {
        try {
          launchPreview = deps.getLaunchPreview(detail.resolved);
        } catch (error) {
          deps.stderr(
            `warning: launch preview failed: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      }
      deps.stdout(
        `${formatProfileInspect(detail, layers, {
          showPrompt,
          contextSummary,
          ...(launchPreview !== undefined ? { launchPreview } : {}),
          ...(home !== undefined ? { home } : {}),
        })}\n`,
      );
    } else {
      deps.stdout(
        `${formatProfileShow(detail, layers, {
          showPrompt,
          ...(home !== undefined ? { home } : {}),
        })}\n`,
      );
    }
    return { exitCode: 0 };
  } catch (error) {
    if (error instanceof ProfileResolveError) {
      deps.stderr(`error: ${error.message}\n`);
      deps.stderr(
        `  config: user ${layers.userPath} < project ${layers.projectPath}\n`,
      );
      return { exitCode: 1 };
    }
    deps.stderr(
      `error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return { exitCode: 1 };
  }
}

async function runValidate(
  args: readonly string[],
  deps: ProfilesCommandDeps,
): Promise<ProfilesCommandResult> {
  let asJson = false;
  let name: string | undefined;
  const unknown: string[] = [];
  for (const arg of args) {
    if (arg === "--json") asJson = true;
    else if (isHelpFlag(arg)) {
      deps.stdout(`${PROFILES_USAGE}`);
      return { exitCode: 0 };
    } else if (arg.startsWith("--")) unknown.push(arg);
    else if (name === undefined) name = arg;
    else unknown.push(arg);
  }
  if (unknown.length > 0) {
    deps.stderr(`error: unknown profile validate option(s): ${unknown.join(", ")}\n`);
    deps.stderr("usage: orca-pi profile validate [<name>] [--json]\n");
    return { exitCode: 2 };
  }
  let layers: ProfileLayerContext;
  try {
    layers = await loadLayers(deps);
  } catch (error) {
    const message = formatLoadError(error);
    if (asJson) {
      const { userPath, projectPath } = resolvePaths(deps);
      deps.stdout(
        `${JSON.stringify({ ok: false, error: message, config: { userPath, projectPath } }, null, 2)}\n`,
      );
    } else {
      deps.stderr(`${message}\n`);
    }
    return { exitCode: 1 };
  }
  if (name !== undefined && !Object.hasOwn(layers.mergedDoc.profiles, name)) {
    const available = Object.keys(layers.mergedDoc.profiles).sort();
    const hint =
      available.length > 0
        ? ` Available: ${available.slice(0, 3).map((entry) => `"${entry}"`).join(", ")}${available.length > 3 ? ` (and ${available.length - 3} more)` : ""}.`
        : " No profiles found — see profiles/examples.yaml.";
    const message = `Unknown Pi profile "${name}".${hint}`;
    if (asJson) {
      deps.stdout(
        `${JSON.stringify(
          {
            ok: false,
            error: message,
            available,
            config: {
              userPath: layers.userPath,
              projectPath: layers.projectPath,
            },
          },
          null,
          2,
        )}\n`,
      );
    } else {
      deps.stderr(`error: ${message}\n`);
    }
    return { exitCode: 1 };
  }
  const all = validateAllProfiles(layers);
  const entries = name !== undefined ? all.filter((entry) => entry.name === name) : all;
  const ok = entries.every((entry) => entry.valid);
  if (asJson) {
    deps.stdout(
      `${JSON.stringify(
        {
          ok,
          entries,
          config: {
            userPath: layers.userPath,
            projectPath: layers.projectPath,
            userExists: layers.userExists,
            projectExists: layers.projectExists,
          },
        },
        null,
        2,
      )}\n`,
    );
    return { exitCode: ok ? 0 : 1 };
  }
  deps.stdout(
    `${formatValidationReport(entries, layers, { home: deps.homedir })}\n`,
  );
  // Human validation failures go to stdout (report) with exit 1; usage errors
  // use stderr with exit 2 above.
  return { exitCode: ok ? 0 : 1 };
}

async function runPath(
  args: readonly string[],
  deps: ProfilesCommandDeps,
): Promise<ProfilesCommandResult> {
  let asJson = false;
  let only: "user" | "project" | undefined;
  const unknown: string[] = [];
  for (const arg of args) {
    if (arg === "--json") asJson = true;
    else if (arg === "--project") {
      if (only !== undefined) unknown.push(arg);
      else only = "project";
    } else if (arg === "--user") {
      if (only !== undefined) unknown.push(arg);
      else only = "user";
    } else if (isHelpFlag(arg)) {
      deps.stdout(`${PROFILES_USAGE}`);
      return { exitCode: 0 };
    } else unknown.push(arg);
  }
  if (unknown.length > 0) {
    deps.stderr(`error: unknown profile path option(s): ${unknown.join(", ")}\n`);
    deps.stderr("usage: orca-pi profile path [--project|--user] [--json]\n");
    return { exitCode: 2 };
  }
  const { userPath, projectPath } = resolvePaths(deps);
  // Existence is best-effort for `path` (it must work even when files are
  // missing — its job is to say where they would live).
  const fsOpts = deps.fs ? { fs: deps.fs } : {};
  let userDoc: ValidatedProfilesDocument | undefined;
  let projectDoc: ValidatedProfilesDocument | undefined;
  try {
    const rethrowConfigError = (error: unknown): undefined => {
      // Surface malformed/invalid files instead of reporting "missing".
      if (
        error instanceof ProfileLoadError ||
        error instanceof ProfileValidationError
      ) {
        throw error;
      }
      return undefined;
    };
    userDoc = await loadProfilesFile(userPath, fsOpts).then(
      (doc) => doc,
      rethrowConfigError,
    );
    projectDoc = await loadProfilesFile(projectPath, fsOpts).then(
      (doc) => doc,
      rethrowConfigError,
    );
  } catch (error) {
    deps.stderr(`${formatLoadError(error)}\n`);
    return { exitCode: 1 };
  }
  const layers = {
    userPath,
    projectPath,
    userExists: userDoc !== undefined,
    projectExists: projectDoc !== undefined,
  };
  if (asJson) {
    if (only === "user") {
      deps.stdout(
        `${JSON.stringify({ path: userPath, exists: layers.userExists }, null, 2)}\n`,
      );
    } else if (only === "project") {
      deps.stdout(
        `${JSON.stringify({ path: projectPath, exists: layers.projectExists }, null, 2)}\n`,
      );
    } else {
      deps.stdout(`${JSON.stringify(layers, null, 2)}\n`);
    }
    return { exitCode: 0 };
  }
  if (only !== undefined) {
    deps.stdout(`${only === "user" ? userPath : projectPath}\n`);
    return { exitCode: 0 };
  }
  deps.stdout(`${formatConfigPaths(layers, { home: deps.homedir })}\n`);
  return { exitCode: 0 };
}

/**
 * Route `profile`/`profiles` subcommands. `argv` is everything after the
 * `profile`/`profiles` word (e.g. `["show", "scout", "--json"]`).
 */
export async function runProfilesCommand(
  argv: readonly string[],
  deps: ProfilesCommandDeps,
): Promise<ProfilesCommandResult> {
  const [subcommand, ...rest] = argv;
  if (subcommand === undefined || isHelpFlag(subcommand)) {
    deps.stdout(`${PROFILES_USAGE}`);
    return { exitCode: 0 };
  }
  if (subcommand === "list") return await runList(rest, deps);
  if (subcommand === "show") return await runShow(rest, deps, { inspect: false });
  if (subcommand === "inspect")
    return await runShow(rest, deps, { inspect: true });
  if (subcommand === "validate") return await runValidate(rest, deps);
  if (subcommand === "path") return await runPath(rest, deps);
  deps.stderr(`error: unknown profiles subcommand: ${subcommand}\n`);
  deps.stderr(`${PROFILES_USAGE}`);
  return { exitCode: 2 };
}

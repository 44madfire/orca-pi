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
 *   orca-pi profile inspect <name> [--project-root <path>] [--cwd <path>]
 *     [--user-config <path>] [--project-config <path>] [--json]
 *     [--show-prompt] [--context-summary]
 *   orca-pi profile validate [<name>] [--json]
 *   orca-pi profile path [--project|--user] [--json]
 *
 * JEF-7 boundary: this module never builds Pi argv. `inspect` accepts an
 * optional injected async {@link LaunchPreviewProvider} (JEF-7's
 * build+format helper: `buildPiLaunch` may read `systemPromptFile`, then
 * `formatPiInspect` renders). The provider is awaited in human and JSON
 * paths; when absent, `inspect` states JEF-7 ownership instead of
 * implementing a second formatter.
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
  fs?: Pick<typeof import("node:fs/promises"), "readFile" | "stat">;
  /**
   * JEF-7 seam: async build+format helper (`buildPiLaunch` + `formatPiInspect`).
   * May perform `systemPromptFile` I/O, so it is awaited. When omitted,
   * `inspect` omits argv preview with an explicit note (never builds argv itself).
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
  orca-pi profile inspect <name> [--project-root <path>] [--cwd <path>] [--user-config <path>] [--project-config <path>] [--json] [--show-prompt] [--context-summary]
  orca-pi profile validate [<name>] [--json]
  orca-pi profile path [--project|--user] [--json]

The CLI/profile file is authoritative (user/global < project); the UI never
creates a second store. show/inspect redact large prompt bodies unless
--show-prompt is given. inspect never builds Pi argv itself — launch preview
comes from JEF-7's async build+format helper when injected.
`;

const PROFILE_INSPECT_USAGE =
  "usage: orca-pi profile inspect <name> [--project-root <path>] [--cwd <path>] [--user-config <path>] [--project-config <path>] [--json] [--show-prompt] [--context-summary]\n";

function resolvePaths(
  deps: ProfilesCommandDeps,
  overrides?: {
    projectRoot?: string;
    userConfigPath?: string;
    projectConfigPath?: string;
  },
): {
  userPath: string;
  projectPath: string;
  effectiveProjectRoot: string;
} {
  const effectiveProjectRoot = overrides?.projectRoot ?? deps.projectRoot;
  const userPath =
    overrides?.userConfigPath ??
    deps.userConfigPathOverride ??
    getUserProfilesPath({
      env: deps.env,
      homedir: deps.homedir,
      osHomedir: deps.osHomedir,
    });
  const projectPath =
    overrides?.projectConfigPath ??
    deps.projectConfigPathOverride ??
    getProjectProfilesPath(effectiveProjectRoot);
  return { userPath, projectPath, effectiveProjectRoot };
}

async function loadLayers(
  deps: ProfilesCommandDeps,
  overrides?: {
    projectRoot?: string;
    userConfigPath?: string;
    projectConfigPath?: string;
  },
): Promise<ProfileLayerContext> {
  const { userPath, projectPath } = resolvePaths(deps, overrides);
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

/**
 * Lightweight existence check for `profile path` (Blocking 2).
 *
 * `profile path` must remain usable when config is malformed: it reports
 * authoritative locations without parsing file contents (parsing/diagnosis
 * belongs to `profile validate`). Any successful read/stat means the file
 * exists, even if its YAML is broken; only ENOENT (and equivalent
 * not-found signals) means missing.
 */
async function fileExists(
  filePath: string,
  fs?: Pick<typeof import("node:fs/promises"), "readFile" | "stat">,
): Promise<boolean> {
  if (fs) {
    if (typeof (fs as { stat?: unknown }).stat === "function") {
      try {
        await (fs as Pick<typeof import("node:fs/promises"), "stat">).stat(filePath);
        return true;
      } catch (error) {
        if (isNotFoundFsError(error)) return false;
        // Unreadable-but-present files still count as existing for `path`.
        return true;
      }
    }
    try {
      await fs.readFile(filePath, "utf8");
      return true;
    } catch (error) {
      if (isNotFoundFsError(error)) return false;
      return true;
    }
  }
  try {
    const nodeFs = await import("node:fs/promises");
    await nodeFs.stat(filePath);
    return true;
  } catch (error) {
    if (isNotFoundFsError(error)) return false;
    return true;
  }
}

function isNotFoundFsError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (code === "ENOENT") return true;
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("ENOENT") ||
    message.toLowerCase().includes("no such file")
  );
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
  // JEF-7-aligned overrides: inspect resolves prompt files against
  // projectRoot/cwd, so it accepts the same location flags as JEF-7's
  // `profile inspect` (project wins over deps defaults).
  let projectRootOverride: string | undefined;
  let cwdOverride: string | undefined;
  let userConfigOverride: string | undefined;
  let projectConfigOverride: string | undefined;
  const unknown: string[] = [];
  const takeValue = (
    flag: string,
    index: number,
  ): { value?: string; consumed: number } => {
    const value = args[index + 1];
    if (value === undefined || value.startsWith("-")) {
      unknown.push(`${flag} requires a path value`);
      return { consumed: 1 };
    }
    return { value, consumed: 2 };
  };
  for (let index = 0; index < args.length;) {
    const arg = args[index] as string;
    if (arg === "--json") {
      asJson = true;
      index += 1;
    } else if (arg === "--show-prompt") {
      showPrompt = true;
      index += 1;
    } else if (arg === "--context-summary") {
      if (!options.inspect) unknown.push(arg);
      else contextSummary = true;
      index += 1;
    } else if (arg === "--project-root" && options.inspect) {
      const taken = takeValue(arg, index);
      if (taken.value !== undefined) projectRootOverride = taken.value;
      index += taken.consumed;
    } else if (arg === "--cwd" && options.inspect) {
      const taken = takeValue(arg, index);
      if (taken.value !== undefined) cwdOverride = taken.value;
      index += taken.consumed;
    } else if (arg === "--user-config" && options.inspect) {
      const taken = takeValue(arg, index);
      if (taken.value !== undefined) userConfigOverride = taken.value;
      index += taken.consumed;
    } else if (arg === "--project-config" && options.inspect) {
      const taken = takeValue(arg, index);
      if (taken.value !== undefined) projectConfigOverride = taken.value;
      index += taken.consumed;
    } else if (isHelpFlag(arg)) {
      deps.stdout(`${PROFILES_USAGE}`);
      return { exitCode: 0 };
    } else if (arg.startsWith("--")) {
      unknown.push(arg);
      index += 1;
    } else if (name === undefined) {
      name = arg;
      index += 1;
    } else {
      unknown.push(arg);
      index += 1;
    }
  }
  if (unknown.length > 0) {
    deps.stderr(
      `error: unknown profile ${options.inspect ? "inspect" : "show"} option(s): ${unknown.join(", ")}\n`,
    );
    deps.stderr(
      options.inspect
        ? PROFILE_INSPECT_USAGE
        : "usage: orca-pi profile show <name> [--json] [--show-prompt]\n",
    );
    return { exitCode: 2 };
  }
  if (!name) {
    deps.stderr(`error: missing profile name\n`);
    deps.stderr(
      options.inspect
        ? PROFILE_INSPECT_USAGE
        : "usage: orca-pi profile show <name> [--json] [--show-prompt]\n",
    );
    return { exitCode: 2 };
  }
  const layerOverrides =
    projectRootOverride !== undefined ||
    userConfigOverride !== undefined ||
    projectConfigOverride !== undefined
      ? {
          ...(projectRootOverride !== undefined
            ? { projectRoot: projectRootOverride }
            : {}),
          ...(userConfigOverride !== undefined
            ? { userConfigPath: userConfigOverride }
            : {}),
          ...(projectConfigOverride !== undefined
            ? { projectConfigPath: projectConfigOverride }
            : {}),
        }
      : undefined;
  let layers: ProfileLayerContext;
  try {
    layers = await loadLayers(deps, layerOverrides);
  } catch (error) {
    deps.stderr(`${formatLoadError(error)}\n`);
    return { exitCode: 1 };
  }
  const { effectiveProjectRoot } = resolvePaths(deps, layerOverrides);
  const effectiveCwd = cwdOverride ?? effectiveProjectRoot;
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
            launchPreview = await deps.getLaunchPreview(detail.resolved, {
              projectRoot: effectiveProjectRoot,
              cwd: effectiveCwd,
              showFullPrompt: showPrompt,
            });
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
          launchPreview = await deps.getLaunchPreview(detail.resolved, {
            projectRoot: effectiveProjectRoot,
            cwd: effectiveCwd,
            showFullPrompt: showPrompt,
          });
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
  // Recovery UX (Blocking 2): `profile path` never parses file contents.
  // It reports authoritative locations even when config is malformed —
  // content diagnostics belong to `profile validate`. Existence is a
  // lightweight stat/read probe only.
  const [userExists, projectExists] = await Promise.all([
    fileExists(userPath, deps.fs),
    fileExists(projectPath, deps.fs),
  ]);
  const layers = {
    userPath,
    projectPath,
    userExists,
    projectExists,
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

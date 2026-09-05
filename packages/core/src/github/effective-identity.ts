/**
 * Effective GitHub identity resolution (OP1.12).
 *
 * The role chosen at launch is authoritative for GitHub actor selection:
 *
 * ```text
 * ResolvedPiProfile.githubIdentity
 *           |
 *           +-- worker   -> Worker App credential
 *           +-- reviewer -> Reviewer App credential
 * ```
 *
 * Agents must not repeat an identity already fixed by their resolved
 * profile. Explicit `--identity` overrides are retained for
 * diagnostics/admin use but must never permit privilege escalation
 * (e.g. a reviewer profile selecting worker credentials).
 *
 * Trust model:
 * - `profile.githubIdentity` comes from validated profile config
 *   (builtins < user < project, flattened by `resolveProfile`) — trusted.
 * - `explicitIdentity` comes from model-authored command text
 *   (`--identity <name>`) — untrusted, must match the profile when the
 *   profile fixes one.
 * - `ORCA_PI_GITHUB_IDENTITY` env comes from the spawn-time terminal
 *   prefix (`spawn` injects `ORCA_PI_GITHUB_IDENTITY=<identity>` per
 *   worker terminal, never globally) or from operator export outside LLM
 *   context — trusted when it agrees with the profile, rejected on
 *   mismatch so a spoofed env cannot escalate.
 *
 * Never handles secret values — only logical identity names.
 */

import { GithubAuthError, type GithubIdentity } from "./types.js";
import { GITHUB_IDENTITY_PATTERN, MAX_GITHUB_IDENTITY_LENGTH } from "../profile/schema.js";

/** Env var carrying the spawn-resolved identity into worker terminals. */
export const EFFECTIVE_IDENTITY_ENV_VAR = "ORCA_PI_GITHUB_IDENTITY";
/** Env var carrying the spawn-resolved profile name (provenance only). */
export const EFFECTIVE_PROFILE_ENV_VAR = "ORCA_PI_PROFILE";

/** Canonical role identities (mirrors `WORKER/REVIEWER_IDENTITY`). */
export const WORKER_ROLE_IDENTITY = "worker" as const;
export const REVIEWER_ROLE_IDENTITY = "reviewer" as const;

function validateIdentityShape(identity: string, source: string): string {
  const trimmed = identity.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_GITHUB_IDENTITY_LENGTH ||
    !GITHUB_IDENTITY_PATTERN.test(trimmed)
  ) {
    throw new GithubAuthError(
      trimmed || identity,
      "unauthorized-installation",
      `Invalid GitHub identity ${JSON.stringify(identity)} from ${source}: expected 1-${MAX_GITHUB_IDENTITY_LENGTH} chars matching ${GITHUB_IDENTITY_PATTERN} (e.g. "worker", "reviewer").`,
    );
  }
  return trimmed;
}

/**
 * Resolve the effective identity from a resolved profile plus an optional
 * explicit override. Fails closed on any privilege-escalation attempt.
 *
 * Rules:
 * - Profile fixes `githubIdentity` + no explicit → profile identity.
 * - Profile fixes + explicit equal → profile identity.
 * - Profile fixes + explicit different → throw (escalation, both
 *   worker→reviewer and reviewer→worker are refused: any cross-role
 *   selection would grant unintended Contents/Checks write).
 * - Profile has none + explicit → explicit (diagnostics/admin).
 * - Profile has none + none → undefined (e.g. scout: no GitHub writes).
 */
export function resolveEffectiveGithubIdentity(
  profile: Pick<{ name?: string; githubIdentity?: string }, "name" | "githubIdentity">,
  options?: { explicitIdentity?: string },
): GithubIdentity | undefined {
  const profileIdentity = profile.githubIdentity?.trim() || undefined;
  const explicitRaw = options?.explicitIdentity;
  const explicit =
    explicitRaw !== undefined && explicitRaw.trim().length > 0
      ? validateIdentityShape(explicitRaw, "--identity")
      : undefined;
  const profileName = profile.name ?? "(profile)";

  if (profileIdentity) {
    validateIdentityShape(profileIdentity, `profile "${profileName}" githubIdentity`);
    if (explicit === undefined) return profileIdentity;
    if (explicit === profileIdentity) return profileIdentity;
    throw new GithubAuthError(
      explicit,
      "unauthorized-installation",
      `Refusing GitHub identity override for Pi profile "${profileName}": profile fixes githubIdentity "${profileIdentity}" but --identity "${explicit}" was requested. ` +
        `The launch role is authoritative — a reviewer profile cannot select worker credentials (Contents: write) and a worker profile cannot select reviewer credentials (Checks: write). ` +
        `Omit --identity to inherit "${profileIdentity}"${profileIdentity === "reviewer" ? " (reviewer holds Contents: read only)" : ""}, or launch the matching profile instead.`,
    );
  }
  return explicit;
}

/**
 * Resolve with `ORCA_PI_GITHUB_IDENTITY` env fallback (spawn-injected).
 *
 * Precedence: explicit `--identity` > profile `githubIdentity` >
 * `ORCA_PI_GITHUB_IDENTITY` env > undefined.
 *
 * When both profile and env are set they must agree — a mismatched env
 * fails closed (spoofed or stale terminal env must never escalate).
 */
export function resolveIdentityWithEnvFallback(
  profile: Pick<{ name?: string; githubIdentity?: string }, "name" | "githubIdentity">,
  options?: {
    explicitIdentity?: string;
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  },
): GithubIdentity | undefined {
  const env = options?.env;
  const envRaw = env?.[EFFECTIVE_IDENTITY_ENV_VAR];
  const envIdentity =
    typeof envRaw === "string" && envRaw.trim().length > 0
      ? validateIdentityShape(envRaw, `env ${EFFECTIVE_IDENTITY_ENV_VAR}`)
      : undefined;

  const viaProfile = resolveEffectiveGithubIdentity(profile, {
    ...(options?.explicitIdentity !== undefined
      ? { explicitIdentity: options.explicitIdentity }
      : {}),
  });

  if (viaProfile !== undefined) {
    if (envIdentity !== undefined && envIdentity !== viaProfile) {
      throw new GithubAuthError(
        envIdentity,
        "unauthorized-installation",
        `Refusing GitHub identity: Pi profile "${profile.name ?? "(profile)"}" resolves to "${viaProfile}" but ${EFFECTIVE_IDENTITY_ENV_VAR} carries "${envIdentity}". ` +
          `The launch role is authoritative — clear or correct ${EFFECTIVE_IDENTITY_ENV_VAR} (spawn injects it per worker terminal) and retry without an explicit --identity override.`,
      );
    }
    return viaProfile;
  }
  // No profile identity and no explicit override: inherit spawn env (the
  // worker-terminal case: `orca-pi github exec -- git push` without flags).
  if (options?.explicitIdentity !== undefined) {
    // Explicit was validated above (profile had none, so it passed through).
    return viaProfile;
  }
  return envIdentity;
}

/**
 * Quote `NAME=value` env prefixes for POSIX `bash` terminal commands
 * (Orca `terminal create --command`). Values are restricted to identity
 * grammar (`[A-Za-z0-9_-]`) so quoting is trivial, but we still
 * single-quote defensively.
 */
function quoteEnvValue(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Prefix a terminal shell command with per-process identity env
 * (`ORCA_PI_GITHUB_IDENTITY` + `ORCA_PI_PROFILE`). Scoped to the single
 * worker terminal — never touches global `git config` or ambient
 * `GH_TOKEN`. No secrets are embedded (logical names only).
 */
export function prefixTerminalCommandWithIdentity(
  command: string,
  options: { githubIdentity?: string; profileName?: string },
): string {
  const parts: string[] = [];
  if (options.githubIdentity && options.githubIdentity.trim().length > 0) {
    const identity = validateIdentityShape(options.githubIdentity, "profile githubIdentity");
    parts.push(`${EFFECTIVE_IDENTITY_ENV_VAR}=${quoteEnvValue(identity)}`);
  }
  if (options.profileName && options.profileName.trim().length > 0) {
    parts.push(`${EFFECTIVE_PROFILE_ENV_VAR}=${quoteEnvValue(options.profileName.trim())}`);
  }
  if (parts.length === 0) return command;
  return `${parts.join(" ")} ${command}`;
}

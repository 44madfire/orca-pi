/**
 * Pi agent profile barrel (OP1.2 / JEF-6).
 *
 * Import from `@orca-pi/core` (re-exported in `src/index.ts`) or directly
 * from `@orca-pi/core/dist/profile/index.js` in constrained hosts.
 */
export type {
  BuiltinProfileDefaults,
  PiProfileInput,
  PiProfilesDocumentInput,
  ProfileOverrides,
  ResolvedPiProfile,
  SessionMode,
  ThinkingLevel,
  ValidatedPiProfile,
  ValidatedProfilesDocument,
} from "./types.js";
export {
  BUILTIN_PROFILE_DEFAULTS,
  BUILTIN_TOOLS,
  MODEL_PATTERN,
  PROFILE_NAME_PATTERN,
  RESERVED_PROFILE_NAMES,
  PROVIDER_PATTERN,
  SESSION_MODES,
  THINKING_LEVELS,
  TOOL_NAME_PATTERN,
  normalizeProjectRelativePath,
  ProfileValidationError,
  validateProfileOverrides,
  validateProfilesDocument,
  type ProfileIssue,
} from "./schema.js";
export {
  getCandidateConfigPaths,
  getProjectProfilesPath,
  getUserProfilesPath,
  listProfileNames,
  loadMergedProfiles,
  loadProfilesFile,
  mergeValidatedDocuments,
  parseAndValidateProfilesText,
  parseProfilesText,
  ProfileLoadError,
} from "./load.js";
export {
  resolveAllProfiles,
  resolveProfile,
  ProfileResolveError,
  type ProfileResolveErrorCode,
  type ResolveProfileOptions,
} from "./resolve.js";

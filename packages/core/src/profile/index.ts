/**
 * Pi agent profile barrel (OP1.2 / JEF-6 + OP1.6 / JEF-10 defaults).
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
  BUILTIN_PROFILE_NAMES,
  BUILTIN_PROFILES_SOURCE,
  REVIEWER_SYSTEM_PROMPT,
  SCOUT_SYSTEM_PROMPT,
  WORKER_SYSTEM_PROMPT,
  getBuiltinProfilesDocument,
  isBuiltinProfileName,
} from "./builtins.js";
export { GITHUB_IDENTITY_PATTERN, MAX_GITHUB_IDENTITY_LENGTH, REVIEWER_FORBIDDEN_TOOLS, REVIEWER_GITHUB_IDENTITY, WORKER_GITHUB_IDENTITY } from "./schema.js";
export {
  BUILTIN_PROFILE_DEFAULTS,
  BUILTIN_TOOLS,
  MODEL_PATTERN,
  MODEL_THINKING_SUFFIX_PATTERN,
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
export {
  describeProfile,
  formatConfigPaths,
  formatProfileInspect,
  formatProfileShow,
  formatProfilesList,
  formatPromptForDisplay,
  formatValidationReport,
  getFieldProvenance,
  normalizeLaunchPreview,
  sanitizeLaunchPreviewForDisplay,
  shortenHomeForDisplay,
  summarizeAllProfiles,
  summarizeResolvedProfile,
  toPanelModel,
  truncatePromptPreview,
  validateAllProfiles,
  type FieldProvenance,
  type LaunchPreviewContext,
  type LaunchPreviewProvider,
  type LaunchPreviewResult,
  type ProfileDetail,
  type ProfileDetailField,
  type ProfileLayerContext,
  type ProfileSummary,
  type ProfileValidationEntry,
  type ProfilesPanelModel,
  type ProvenanceKind,
} from "./presentation.js";

/**
 * GitHub automation barrel (OP1.9 / JEF-15).
 *
 * Import from `@orca-pi/core` (re-exported in `src/index.ts`) or directly
 * from `@orca-pi/core/dist/github/index.js` in constrained hosts.
 */

export type {
  CheckConclusion,
  CheckRunInput,
  CheckStatus,
  GithubFetchFn,
  GithubHttpResponse,
  GithubIdentity,
  GithubRepoPermissions,
  ResolvedGithubCredential,
  ReviewEvent,
  ReviewFindings,
  ReviewPayload,
  ReviewProvenance,
  ReviewResultMeta,
  ReviewVerdict,
  SubmitReviewInput,
} from "./types.js";
export {
  AGENT_REVIEW_CHECK_NAME,
  GithubApiError,
  GithubAuthError,
  REVIEWER_IDENTITY,
  WORKER_IDENTITY,
  githubIdentityForProfile,
} from "./types.js";
export {
  KNOWN_GITHUB_IDENTITIES,
  assertDistinctGithubActors,
  assertReviewerHasNoWriteTools,
  collectSecretsFromEnv,
  expiryEnvVarForIdentity,
  githubPermissionsForIdentity,
  isReviewerIdentity,
  redactSecretsFromText,
  redactTokenLikeValues,
  sanitizeErrorForDisplay,
  tokenEnvVarForIdentity,
} from "./identity.js";
export {
  EXPIRY_SKEW_MS,
  createInstallationTokenCache,
  defaultTokenCache,
  type InstallationTokenCache,
  type TokenCacheEntry,
} from "./token-cache.js";
export {
  REVIEWER_INSTALLATION_ID_ENV_VAR,
  REVIEWER_LOGIN_ENV_VAR,
  WORKER_INSTALLATION_ID_ENV_VAR,
  WORKER_LOGIN_ENV_VAR,
  assertReviewerIdentityForWrites,
  assertWorkerIdentityForWrites,
  authHeaderForCredential,
  describeCredentialStatus,
  fetchAuthenticatedActor,
  fetchPullRequestAuthor,
  proveInstallationTokenClass,
  resolveGithubCredential,
  resolveReviewerAppMetadata,
  resolveWorkerAppMetadata,
  verifyReviewerForChecks,
  verifyReviewerForReview,
  verifyWorkerForWrites,
  type AuthenticatedGithubActor,
  type PullRequestMeta,
  type ReviewerAppMetadata,
  type WorkerAppMetadata,
} from "./github-app-auth.js";
export {
  describeProductionCredentialStatus,
  resolveProductionCredential,
  type ProductionCredentialOptions,
} from "./production-credential.js";
export {
  EFFECTIVE_IDENTITY_ENV_VAR,
  EFFECTIVE_PROFILE_ENV_VAR,
  prefixTerminalCommandWithIdentity,
  resolveEffectiveGithubIdentity,
  resolveIdentityWithEnvFallback,
} from "./effective-identity.js";
export {
  TOKEN_REFRESH_SKEW_MS,
  appIdEnvVarForIdentity,
  candidateSecretPaths,
  createAppJwt,
  describeAppConfigStatus,
  ensureInstallationToken,
  expandHomeInPath,
  installationIdEnvVarForIdentity,
  isWindowsDrivePath,
  loginEnvVarForIdentity,
  mintInstallationToken,
  normalizeSecretPath,
  privateKeyFileAliasForIdentity,
  privateKeyPathEnvVarForIdentity,
  tokenCacheFileForIdentity,
  windowsPathToWslPath,
  type CredentialProviderFs,
  type MintedInstallationToken,
} from "./credential-provider.js";
export {
  assertIdentityMayRunCommand,
  assertRepoLocalHelperConfigured,
  assertWorktreeHelperConfigured,
  buildScopedEnvForIdentity,
  defaultHelperCommand,
  extractGitSubcommand,
  gitConfigArgsForSetup,
  gitConfigCommandsForSetup,
  handleGitCredentialRequest,
  isContentsWriteGitCommand,
  isWorkerMutationCommand,
  parseGitCredentialInput,
  redactGitCredentialOutput,
  setupRepoGitAuth,
} from "./git-auth.js";
export {
  doctorGithubIdentities,
  fetchRepoInstallationWithJwt,
  formatDoctorReport as formatGithubDoctorReport,
  type GithubDoctorReport,
  type IdentityDoctorEntry,
} from "./doctor.js";
export {
  REVIEWER_APP_SLUG_SUGGESTION,
  TARGET_REPO,
  WORKER_APP_SLUG_SUGGESTION,
  operatorSetupStepsForIdentity,
  validateSetupForIdentity,
} from "./setup.js";
export {
  buildReviewPayload,
  findDuplicateReview,
  formatReviewBody,
  listPullReviews,
  parsePullRequestRef,
  parseReviewVerdict,
  reviewEventToState,
  submitGithubReview,
  verdictToReviewEvent,
  type ExistingPullReview,
} from "./review.js";
export {
  buildCheckCompletePayload,
  buildCheckStartPayload,
  buildCheckStartUpdatePayload,
  completeAgentReviewCheck,
  listCheckRunsForRef,
  selectCheckRunForUpdate,
  startAgentReviewCheck,
  verdictIsBlocking,
  verdictToCheckConclusion,
  type ExistingCheckRun,
} from "./check-run.js";
export { AGENT_REVIEW_CHECK_NAME as AGENT_REVIEW_CHECK_NAME_FROM_CHECKS } from "./check-run.js";

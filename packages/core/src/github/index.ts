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
  authHeaderForCredential,
  createInstallationTokenCache,
  defaultTokenCache,
  describeCredentialStatus,
  resolveGithubCredential,
  type InstallationTokenCache,
  type TokenCacheEntry,
} from "./github-app-auth.js";
export {
  buildReviewPayload,
  formatReviewBody,
  parsePullRequestRef,
  parseReviewVerdict,
  submitGithubReview,
  verdictToReviewEvent,
} from "./review.js";
export {
  buildCheckCompletePayload,
  buildCheckStartPayload,
  completeAgentReviewCheck,
  listCheckRunsForRef,
  selectCheckRunForUpdate,
  startAgentReviewCheck,
  verdictIsBlocking,
  verdictToCheckConclusion,
  type ExistingCheckRun,
} from "./check-run.js";
export { AGENT_REVIEW_CHECK_NAME as AGENT_REVIEW_CHECK_NAME_FROM_CHECKS } from "./check-run.js";

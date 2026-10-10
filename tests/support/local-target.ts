/**
 * P203/P206: the policy lives in scripts/lib/local-target.mjs so that plain-Node scripts, tsx
 * tools, Vitest, Playwright and CI share ONE definition of "local". This module only re-exports it
 * for the test code; see that file for the policy and its rationale.
 */
export {
  NonLocalTargetError,
  assertLocalOrDockerHostUrl,
  assertLocalTestTarget,
  assertLocalUrl,
  assertNotHostedKey,
  isLocalHostname,
} from '../../scripts/lib/local-target.mjs'

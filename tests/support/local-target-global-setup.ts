import { assertLocalTestTarget } from './local-target'

/**
 * P203: Vitest `globalSetup` for every suite that talks to a Supabase stack. Runs once, before any
 * test file, so a hosted target aborts the whole run with one specific message instead of letting
 * the first fixture create a user there. See tests/support/local-target.ts for the policy.
 */
export function setup(): void {
  assertLocalTestTarget(process.env)
}

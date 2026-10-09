/**
 * Creates ONE synthetic account with a small controlled portfolio on the LOCAL stack and prints
 * what the emulator journey needs as one JSON object: the login, the ids, and the account's
 * pre-deletion Auth tokens (so the journey can prove the OLD session is refused afterwards).
 *
 *   SUPABASE_URL=… SUPABASE_ANON_KEY=… SUPABASE_SERVICE_ROLE_KEY=… DB_URL=… \
 *     pnpm exec tsx scripts/p189/seed-synthetic-account.ts
 *
 * Local stack only (the keys are the local development defaults). Refuses to run against anything
 * that is not a loopback address. Prints credentials of an account that never existed outside this
 * stack; nothing here touches a hosted project.
 */
import { createServiceClient, createSyntheticUser, signInAs } from '../../tests/db/setup'
import { seedAccountLedger } from '../../tests/db/lib/account-ledger-fixture'
import { assertLocalTestTarget } from '../lib/local-target.mjs'

// P206: the shared fail-closed guard (SUPABASE_URL, DB_URL, registry, keys) replaces a per-script regex.
assertLocalTestTarget(process.env)

const service = createServiceClient()
const user = await createSyntheticUser(service, 'emu-delete')
const client = await signInAs(user)
await seedAccountLedger(service, user, client, 'emu-delete')
const session = (await client.auth.getSession()).data.session
if (session === null) throw new Error('the synthetic account has no session')
console.log(
  JSON.stringify({
    id: user.id,
    email: user.email,
    password: user.password,
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
  }),
)

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createAnonClient,
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  signInAs,
  type SyntheticUser,
  type TestClient,
} from '../db/setup'

/**
 * The exact set of database functions each browser-reachable role may execute.
 *
 * This suite exists because CI and the real project disagreed. A Supabase project can carry an
 * event trigger that grants the Data API roles EXECUTE on every new public-schema function; the
 * local stack has it off and this project had it on. `REVOKE EXECUTE ... FROM PUBLIC` does not
 * undo a grant made to a named role, so three functions came out locked on CI and reachable on the
 * remote — none of them harmful, but the deployed surface did not match the intended one and the
 * test suite said it did.
 *
 * Asserting the whole set behaviourally, from a real client, is what closes that: it gives the same
 * answer against CI's ephemeral stack and against a deployed project, so the two can no longer
 * drift silently. Adding a function without deciding who may call it fails here.
 */

const CALLABLE = 'callable'
const REFUSED = 'refused'
type Expectation = typeof CALLABLE | typeof REFUSED

interface FunctionCase {
  name: string
  args: Record<string, unknown>
  anon: Expectation
  authenticated: Expectation
  why: string
}

const FUNCTIONS: FunctionCase[] = [
  {
    name: 'invitation_status',
    args: { p_token: 'a-token-nobody-ever-issued' },
    anon: CALLABLE,
    authenticated: CALLABLE,
    why: 'the invited person has no account yet; the token is the credential',
  },
  {
    name: 'is_admin',
    args: {},
    anon: REFUSED,
    authenticated: CALLABLE,
    why: 'read by the invitations policies and the admin screen; meaningless before sign-in',
  },
  {
    name: 'create_invitation',
    args: { p_email: 'grant-probe@example.invalid' },
    anon: REFUSED,
    authenticated: CALLABLE,
    why: 'reachable by any session, but checks is_admin() itself',
  },
  {
    name: 'revoke_invitation',
    args: { p_invitation_id: '00000000-0000-0000-0000-000000000000' },
    anon: REFUSED,
    authenticated: CALLABLE,
    why: 'same shape as create_invitation',
  },
  {
    name: 'hash_invitation_token',
    args: { p_token: 'x' },
    anon: REFUSED,
    authenticated: REFUSED,
    why: 'server-only helper; the one that was reachable on the remote',
  },
  {
    name: 'claim_invitation',
    args: { p_token: 'x' },
    anon: REFUSED,
    authenticated: REFUSED,
    why: 'privileged redemption internals, service role only',
  },
  {
    name: 'finalize_invitation_redemption',
    args: {
      p_claim_id: '00000000-0000-0000-0000-000000000000',
      p_user_id: '00000000-0000-0000-0000-000000000000',
    },
    anon: REFUSED,
    authenticated: REFUSED,
    why: 'privileged redemption internals, service role only',
  },
  {
    name: 'release_invitation_claim',
    args: { p_claim_id: '00000000-0000-0000-0000-000000000000' },
    anon: REFUSED,
    authenticated: REFUSED,
    why: 'privileged redemption internals, service role only',
  },
  {
    name: 'before_user_created',
    args: { event: {} },
    anon: REFUSED,
    authenticated: REFUSED,
    why: 'the invite-only gate itself; only supabase_auth_admin invokes it',
  },
  {
    name: 'add_card_acquisition',
    args: { p_quantity: 0 }, // deliberately invalid — reaching the body's own validation is enough
    anon: REFUSED,
    authenticated: CALLABLE,
    why: 'the M6 atomic add-to-collection surface; reachable by any session, RLS/derived auth.uid() do the rest',
  },
  {
    name: 'set_manual_valuation',
    args: { p_holding_id: '00000000-0000-0000-0000-000000000000', p_value_minor: -1 },
    anon: REFUSED,
    authenticated: CALLABLE,
    why: 'reachable by any session; the body itself refuses a negative amount',
  },
  {
    name: 'void_acquisition_lot',
    args: { p_lot_id: '00000000-0000-0000-0000-000000000000' },
    anon: REFUSED,
    authenticated: CALLABLE,
    why: 'reachable by any session; the body itself refuses a lot the caller does not own',
  },
  {
    name: 'allocate_largest_remainder',
    args: { p_total: 0, p_weights: [] }, // deliberately invalid — reaching the body's own validation is enough
    anon: REFUSED,
    authenticated: CALLABLE,
    why: 'M8: pure allocation helper create_purchase/update_purchase call; no table access at all',
  },
  {
    name: 'create_purchase',
    args: { p_purchased_on: '2026-01-01', p_currency: 'NOK', p_lines: [] }, // deliberately invalid — zero lines
    anon: REFUSED,
    authenticated: CALLABLE,
    why: 'M8: the multi-line purchase write surface; reachable by any session, RLS/derived auth.uid() do the rest',
  },
  {
    name: 'update_purchase',
    args: {
      p_purchase_id: '00000000-0000-0000-0000-000000000000',
      p_purchased_on: '2026-01-01',
      p_currency: 'NOK',
      p_lines: [],
    },
    anon: REFUSED,
    authenticated: CALLABLE,
    why: 'M8: reachable by any session; the body itself refuses a purchase the caller does not own',
  },
  {
    name: 'void_purchase',
    args: { p_purchase_id: '00000000-0000-0000-0000-000000000000' },
    anon: REFUSED,
    authenticated: CALLABLE,
    why: 'M8: reachable by any session; the body itself refuses a purchase the caller does not own',
  },
  {
    name: 'purchase_spending_summary',
    args: {},
    anon: REFUSED,
    authenticated: CALLABLE,
    why: 'M8: the GPO/CS/HS aggregate; every predicate derives from auth.uid(), no argument to forge',
  },
  {
    name: 'remove_holdings_from_portfolio',
    args: { p_holding_ids: ['00000000-0000-0000-0000-000000000000'] },
    anon: REFUSED,
    authenticated: CALLABLE,
    why: 'M8.1: bulk-safe Remove from Portfolio; the body itself refuses a holding the caller does not own',
  },
]

let service: TestClient
let user: SyntheticUser
let authed: TestClient

beforeAll(async () => {
  service = createServiceClient()
  user = await createSyntheticUser(service, 'grants')
  authed = await signInAs(user)
})

afterAll(async () => {
  await deleteSyntheticUser(service, user.id)
})

/**
 * "Refused" means the privilege system said no, before the function body ran. A function that runs
 * and *then* raises its own error is callable, and that is a different fact: create_invitation is
 * reachable by any session and refuses non-admins from inside, which is the design.
 *
 * Matched on the message, not on SQLSTATE. `42501` looks like the obvious discriminator and is not
 * one — `create_invitation` and `revoke_invitation` deliberately raise `not_authorized` with that
 * same code, because insufficient_privilege is the honest classification for what they are
 * rejecting. Only Postgres itself produces "permission denied for function", and only when the
 * caller holds no EXECUTE grant.
 */
function isPrivilegeRefusal(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  return /permission denied for function/i.test(error.message ?? '')
}

describe('function EXECUTE grants: anonymous callers', () => {
  for (const fn of FUNCTIONS) {
    it(`${fn.name} is ${fn.anon} — ${fn.why}`, async () => {
      const { error } = await createAnonClient().rpc(fn.name, fn.args)
      expect(isPrivilegeRefusal(error)).toBe(fn.anon === REFUSED)
    })
  }
})

describe('function EXECUTE grants: authenticated non-admin callers', () => {
  for (const fn of FUNCTIONS) {
    it(`${fn.name} is ${fn.authenticated} — ${fn.why}`, async () => {
      const { error } = await authed.rpc(fn.name, fn.args)
      expect(isPrivilegeRefusal(error)).toBe(fn.authenticated === REFUSED)
    })
  }
})

describe('trigger functions are not an API surface', () => {
  // PostgREST refuses to expose functions returning `trigger` at all, so these answer PGRST202
  // rather than a privilege error. Asserted anyway: it is a property of the deployment, not of our
  // grants, and a change in it would be worth noticing.
  const triggerFunctions = [
    'handle_new_user',
    'set_updated_at',
    'purchase_lines_check_owner',
    'acquisition_lots_check_owner',
    'enforce_invited_signup',
    'holdings_check_manual_card_owner',
    'holding_tags_check_owner',
    'manual_valuations_check_owner',
    'profiles_check_default_storage_owner',
    'purchases_check_retailer_owner',
  ]

  for (const name of triggerFunctions) {
    it(`${name} cannot be invoked as an RPC`, async () => {
      for (const client of [createAnonClient(), authed]) {
        const { error } = await client.rpc(name, {})
        expect(error, `${name} should not be invokable`).not.toBeNull()
      }
    })
  }
})

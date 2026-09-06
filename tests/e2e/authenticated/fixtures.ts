import { readFile } from 'node:fs/promises'
import { createClient } from '@supabase/supabase-js'
import { seedCatalog } from '../../db/setup'

/**
 * Shared helpers for the authenticated-E2E spec files (P94 §20-22). Every helper here operates
 * through the REAL production RPC surface, signed in as the SAME synthetic user auth.setup.ts
 * created and the running page is already signed in as — never a direct table insert, so a
 * fixture built here is exactly as real as anything the signed-in UI itself could produce.
 */

const CREDENTIALS_FILE = 'playwright/.auth/e2e-user-credentials.json'

export interface E2eCredentials {
  id: string
  email: string
  password: string
}

export async function readE2eCredentials(): Promise<E2eCredentials> {
  const raw = await readFile(CREDENTIALS_FILE, 'utf-8')
  return JSON.parse(raw) as E2eCredentials
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `${name} is not set — export it from \`pnpm exec supabase status -o env\` first (docs/TESTING.md §6b).`,
    )
  }
  return value
}

/** A fresh anon client signed in as the synthetic E2E user — a SEPARATE session from the
 *  browser's own (this one lives only in this Node process), used only to build fixtures through
 *  real RPCs before a spec navigates the browser to a page that needs them to already exist. */
export async function signInAsE2eUser() {
  const url = requireEnv('SUPABASE_URL')
  const anonKey = requireEnv('SUPABASE_ANON_KEY')
  const credentials = await readE2eCredentials()
  const client = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { error } = await client.auth.signInWithPassword({
    email: credentials.email,
    password: credentials.password,
  })
  if (error)
    throw new Error(`failed to sign in as the E2E user for fixture setup: ${error.message}`)
  return client
}

/** Creates one real raw-card holding (via the real add_card_acquisition RPC) for the signed-in
 *  E2E user, seeded from the standard catalog fixture every fresh `pnpm db:reset` carries — a
 *  real holding id a spec can then navigate `/sales/new?holdingId=<id>` against, exactly the N-14
 *  scenario (SaleFormPage's async holding-prefill dirty-baseline fix) no other suite could
 *  exercise without a real signed-in session. */
export async function createFixtureHolding(
  overrides: { cardVariantId?: string } = {},
): Promise<{ holdingId: string; lotId: string }> {
  const client = await signInAsE2eUser()
  const { data, error } = await client
    .rpc('add_card_acquisition', {
      p_card_variant_id: overrides.cardVariantId ?? seedCatalog.pikachuVariantId,
      p_grading_state: 'raw',
      p_condition: 'NM',
      p_origin: 'pre_tracking',
      p_cost_basis_state: 'unknown',
      p_quantity: 1,
      p_acquired_on: new Date().toISOString().slice(0, 10),
      p_client_request_key: crypto.randomUUID(),
    })
    .single<{ holding_id: string; lot_id: string }>()
  if (error) throw new Error(`failed to create fixture holding: ${error.message}`)
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- Supabase does not narrow on error check
  return { holdingId: data!.holding_id, lotId: data!.lot_id }
}

/** Creates one real Purchase (via the real `create_purchase` RPC, one card line) for the
 *  signed-in E2E user — a real purchase id a spec can navigate `/purchases/$purchaseId/edit`
 *  against (P96 §16). Defaults to a Pikachu card at 5000 minor; `overrides.cardVariantId` /
 *  `overrides.unitPriceMinor` let a spec create two DISTINGUISHABLE fixture purchases (P111 §13 —
 *  an entity-switch regression needs A and B to actually look different on screen, not just have
 *  different ids). */
export async function createFixturePurchase(
  overrides: { cardVariantId?: string; unitPriceMinor?: number } = {},
): Promise<{ purchaseId: string }> {
  const client = await signInAsE2eUser()
  const { data, error } = await client
    .rpc('create_purchase', {
      p_purchased_on: new Date().toISOString().slice(0, 10),
      p_currency: 'NOK',
      p_lines: [
        {
          line_type: 'card',
          card_variant_id: overrides.cardVariantId ?? seedCatalog.pikachuVariantId,
          condition: 'NM',
          quantity: 1,
          unit_price_minor: overrides.unitPriceMinor ?? 5000,
        },
      ],
    })
    .select('id')
    .single<{ id: string }>()
  if (error) throw new Error(`failed to create fixture purchase: ${error.message}`)
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- Supabase does not narrow on error check
  return { purchaseId: data!.id }
}

/** Creates one real Sale (via the real `create_sale` RPC) against a fresh fixture holding/lot for
 *  the signed-in E2E user — a real sale id a spec can navigate `/sales/$saleId/edit` against
 *  (P96 §16). */
export async function createFixtureSale(): Promise<{ saleId: string }> {
  const client = await signInAsE2eUser()
  const { lotId } = await createFixtureHolding()
  const { data, error } = await client
    .rpc('create_sale', {
      p_sold_on: new Date().toISOString().slice(0, 10),
      p_currency: 'NOK',
      p_lines: [{ lot_id: lotId, quantity: 1, unit_gross_minor: 8000 }],
      p_idempotency_key: crypto.randomUUID(),
    })
    .select('id')
    .single<{ id: string }>()
  if (error) throw new Error(`failed to create fixture sale: ${error.message}`)
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- Supabase does not narrow on error check
  return { saleId: data!.id }
}

/** Creates one real provisional opening (via the real `create_opening_from_provisional` RPC —
 *  buys and opens a sealed product in one call, no separate holding fixture needed) for the
 *  signed-in E2E user — a real opening id a spec can navigate `/openings/$openingId` against. */
export async function createFixtureOpening(): Promise<{ openingId: string }> {
  const client = await signInAsE2eUser()
  const { data, error } = await client
    .rpc('create_opening_from_provisional', {
      p_sealed_product_id: seedCatalog.sealedProductId,
      p_quantity: 1,
      p_total_paid_minor: 29900,
      p_purchased_on: new Date().toISOString().slice(0, 10),
      p_opened_on: new Date().toISOString().slice(0, 10),
      p_pulls: [{ card_variant_id: seedCatalog.pikachuVariantId, quantity: 1, condition: 'NM' }],
    })
    .single<{ id: string }>()
  if (error) throw new Error(`failed to create fixture opening: ${error.message}`)
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- Supabase does not narrow on error check
  return { openingId: data!.id }
}

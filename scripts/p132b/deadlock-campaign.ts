/**
 * P132-B seeded deadlock campaign (P130-03, output_132_b_finance.txt DEADLOCK_CAMPAIGN).
 *
 * Fires create_sale, create_opening/void_opening and the four corrected correction RPCs
 * (void_purchase, void_acquisition_lot, remove_holdings_from_portfolio, void_opening) at a shared
 * pool of lots, two at a time, hundreds of times, from genuinely concurrent connections (real
 * network round-trips through supabase-js — not a single controlled held-lock pair like
 * tests/db/p132b_correction_locking.test.ts, which proves the DIRECTION of the fix; this proves
 * the ascending-id lock order never produces a cross-function deadlock cycle under real,
 * unscripted contention).
 *
 * Required outcome (see the migration header's LOCK_ORDER_RULE): zero Postgres deadlocks
 * (SQLSTATE 40P01) and, after every iteration, zero invariant violations — checked directly
 * against scripts/finance-integrity-diagnostics.sql's own counters (voided_lots_with_live_
 * disposals, d1_quantity_mismatch_lots, voided_openings_with_live_pull_lots, etc.) rather than a
 * re-implementation of them here.
 *
 * Not wired into CI: this is a one-time proof for this migration, run manually against the local
 * stack (`pnpm exec tsx scripts/p132b/deadlock-campaign.ts`), not a per-PR gate. The held-lock
 * regression suite (tests/db/p132b_correction_locking.test.ts) IS part of `pnpm test:db` / CI.
 *
 * Usage: pnpm exec tsx scripts/p132b/deadlock-campaign.ts [iterations]
 */
import { createClient } from '@supabase/supabase-js'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Client as PgClient } from 'pg'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set — export it from \`supabase status -o env\`.`)
  return value
}

const SUPABASE_URL = requireEnv('SUPABASE_URL')
const SUPABASE_ANON_KEY = requireEnv('SUPABASE_ANON_KEY')
const SUPABASE_SERVICE_ROLE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY')
const DB_URL = requireEnv('DB_URL')

const RAW_LOT_POOL_SIZE = 30
const SEALED_OPENING_POOL_SIZE = 15
const ITERATIONS = Number(process.argv[2] ?? 300)

const SEALED_PRODUCT_ID = 'c0000000-0000-0000-0000-00000000b001' // seedCatalog.sealedProductId
const PIKACHU_VARIANT_ID = 'c0000000-0000-0000-0000-0000000a5801' // seedCatalog.pikachuVariantId

function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}
function randomInvitationToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32)))
    .toString('base64url')
    .replace(/=+$/, '')
}

const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

async function createSyntheticUser(label: string) {
  const email = `p132b-deadlock-${label}-${Date.now()}-${randomUUID().slice(0, 8)}@example.invalid`
  const password = `Test-${randomUUID()}`
  const token = randomInvitationToken()
  const { data: invitation, error: invError } = await service
    .from('invitations')
    .insert({
      token_hash: hashInvitationToken(token),
      email,
      created_by: null,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      max_uses: 1,
    })
    .select('id')
    .single()
  if (invError) throw new Error(`invitation: ${invError.message}`)

  const claim = await service.rpc('claim_invitation', { p_token: token }).maybeSingle()
  const claimed = claim.data as { claim_id: string } | null
  if (claim.error || !claimed) throw new Error(`claim: ${claim.error?.message ?? 'no claim'}`)

  const { data, error } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (error) throw new Error(`createUser: ${error.message}`)

  const finalized = await service.rpc('finalize_invitation_redemption', {
    p_claim_id: claimed.claim_id,
    p_user_id: data.user.id,
  })
  if (finalized.error) throw new Error(`finalize: ${finalized.error.message}`)

  void invitation
  return { id: data.user.id, email, password }
}

async function main() {
  console.log(`P132-B deadlock campaign: ${ITERATIONS} iterations`)
  const user = await createSyntheticUser('campaign')
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const signIn = await client.auth.signInWithPassword({
    email: user.email,
    password: user.password,
  })
  if (signIn.error) throw new Error(`sign in: ${signIn.error.message}`)

  const today = new Date().toISOString().slice(0, 10)

  interface RawLot {
    purchaseId: string
    lotId: string
    holdingId: string
  }
  interface SealedOpening {
    openingId: string
    pullLotId: string
  }

  console.log(`Seeding ${RAW_LOT_POOL_SIZE} raw-card lots...`)
  const rawLots: RawLot[] = []
  for (let i = 0; i < RAW_LOT_POOL_SIZE; i++) {
    const { data: manual, error: manualError } = await client
      .from('manual_card_definitions')
      .insert({ name: `deadlock campaign card ${i}` })
      .select('id')
      .single<{ id: string }>()
    if (manualError) throw new Error(manualError.message)

    const { data: purchase, error } = await client
      .rpc('create_purchase', {
        p_purchased_on: today,
        p_currency: 'NOK',
        p_lines: [
          {
            line_type: 'card',
            manual_card_id: manual.id,
            condition: 'NM',
            quantity: 1,
            unit_price_minor: 5000,
          },
        ],
      })
      .single<{ id: string }>()
    if (error) throw new Error(error.message)

    const { data: line, error: lineError } = await service
      .from('purchase_lines')
      .select('id')
      .eq('purchase_id', purchase.id)
      .single<{ id: string }>()
    if (lineError) throw new Error(lineError.message)
    const { data: lot, error: lotError } = await service
      .from('acquisition_lots')
      .select('id, holding_id')
      .eq('purchase_line_id', line.id)
      .single<{ id: string; holding_id: string }>()
    if (lotError) throw new Error(lotError.message)
    rawLots.push({ purchaseId: purchase.id, lotId: lot.id, holdingId: lot.holding_id })
  }

  console.log(`Seeding ${SEALED_OPENING_POOL_SIZE} sealed openings with a pull lot each...`)
  const sealedOpenings: SealedOpening[] = []
  for (let i = 0; i < SEALED_OPENING_POOL_SIZE; i++) {
    const { data: purchase, error } = await client
      .rpc('create_purchase', {
        p_purchased_on: today,
        p_currency: 'NOK',
        p_lines: [
          {
            line_type: 'sealed',
            sealed_product_id: SEALED_PRODUCT_ID,
            quantity: 1,
            unit_price_minor: 30000,
          },
        ],
      })
      .single<{ id: string }>()
    if (error) throw new Error(error.message)

    const { data: line, error: lineError } = await service
      .from('purchase_lines')
      .select('id')
      .eq('purchase_id', purchase.id)
      .single<{ id: string }>()
    if (lineError) throw new Error(lineError.message)
    const { data: sourceLot, error: sourceLotError } = await service
      .from('acquisition_lots')
      .select('id')
      .eq('purchase_line_id', line.id)
      .single<{ id: string }>()
    if (sourceLotError) throw new Error(sourceLotError.message)

    const { data: opening, error: openError } = await client
      .rpc('create_opening', {
        p_source_lot_id: sourceLot.id,
        p_quantity: 1,
        p_pulls: [{ card_variant_id: PIKACHU_VARIANT_ID, quantity: 1, condition: 'NM' }],
      })
      .single<{ id: string }>()
    if (openError) throw new Error(openError.message)

    const { data: pullLot, error: pullLotError } = await service
      .from('acquisition_lots')
      .select('id')
      .eq('opening_id', opening.id)
      .single<{ id: string }>()
    if (pullLotError) throw new Error(pullLotError.message)
    sealedOpenings.push({ openingId: opening.id, pullLotId: pullLot.id })
  }

  const pick = <T>(arr: T[]): T => {
    const item = arr[Math.floor(Math.random() * arr.length)]
    if (item === undefined) throw new Error('pick() called on an empty pool')
    return item
  }

  async function sell(lotId: string) {
    return client.rpc('create_sale', {
      p_sold_on: today,
      p_currency: 'NOK',
      p_lines: [{ lot_id: lotId, quantity: 1, unit_gross_minor: 100 }],
      p_idempotency_key: randomUUID(),
    })
  }

  const RECOGNIZED = [
    /not found/i,
    /already voided/i,
    /already been partially disposed/i,
    /unavailable/i,
    /downstream disposal/i,
    /only .* of the selected lot remain available/i,
    /referenced more than once/i,
  ]

  let deadlocks = 0
  let unrecognized = 0
  let successes = 0
  let expectedRefusals = 0

  console.log(`Running ${ITERATIONS} concurrent iterations...`)
  for (let i = 0; i < ITERATIONS; i++) {
    const mode = Math.random()
    let calls: PromiseLike<{ error: { message: string; code?: string } | null }>[]

    if (mode < 0.35) {
      // create_sale vs void_purchase on the same lot.
      const lot = pick(rawLots)
      calls = [sell(lot.lotId), client.rpc('void_purchase', { p_purchase_id: lot.purchaseId })]
    } else if (mode < 0.6) {
      // create_sale vs void_acquisition_lot on the same lot.
      const lot = pick(rawLots)
      calls = [sell(lot.lotId), client.rpc('void_acquisition_lot', { p_lot_id: lot.lotId })]
    } else if (mode < 0.8) {
      // Two overlapping remove_holdings_from_portfolio calls, opposite id order (reverse-order /
      // cross-call deadlock stress), plus a concurrent sale on one of the shared lots.
      const a = pick(rawLots)
      const b = pick(rawLots)
      const lot = pick(rawLots)
      calls = [
        client.rpc('remove_holdings_from_portfolio', {
          p_holding_ids: [a.holdingId, b.holdingId],
        }),
        client.rpc('remove_holdings_from_portfolio', {
          p_holding_ids: [b.holdingId, a.holdingId],
        }),
        sell(lot.lotId),
      ]
    } else {
      // create_sale vs void_opening on a pulled card.
      const so = pick(sealedOpenings)
      calls = [sell(so.pullLotId), client.rpc('void_opening', { p_opening_id: so.openingId })]
    }

    const results = await Promise.allSettled(calls)
    for (const r of results) {
      if (r.status === 'rejected') {
        unrecognized++
        console.error(`  iter ${i}: unexpected transport rejection:`, r.reason)
        continue
      }
      const { error } = r.value
      if (!error) {
        successes++
        continue
      }
      if (error.code === '40P01' || /deadlock detected/i.test(error.message)) {
        deadlocks++
        console.error(`  iter ${i}: DEADLOCK: ${error.message}`)
        continue
      }
      if (RECOGNIZED.some((re) => re.test(error.message))) {
        expectedRefusals++
      } else {
        unrecognized++
        console.error(`  iter ${i}: unrecognized error shape: ${error.message}`)
      }
    }
    if ((i + 1) % 50 === 0) console.log(`  ...${i + 1}/${ITERATIONS}`)
  }

  console.log('')
  console.log('=== Campaign summary ===')
  console.log(`iterations:        ${ITERATIONS}`)
  console.log(`successes:         ${successes}`)
  console.log(`expected refusals: ${expectedRefusals}`)
  console.log(`deadlocks:         ${deadlocks}`)
  console.log(`unrecognized:      ${unrecognized}`)

  console.log('')
  console.log('Running finance-integrity-diagnostics.sql for a post-campaign invariant check...')
  const pg = new PgClient({ connectionString: DB_URL })
  await pg.connect()
  const sql = readFileSync(new URL('../finance-integrity-diagnostics.sql', import.meta.url), 'utf8')
  const diagResult = await pg.query<{ diagnostics: Record<string, unknown> }>(sql)
  await pg.end()
  const lastRow = diagResult.rows.at(-1)
  if (!lastRow) throw new Error('finance-integrity-diagnostics.sql returned no rows')
  const diagnostics = lastRow.diagnostics
  const mustBeZero = [
    'voided_lots_with_live_disposals',
    'd1_quantity_mismatch_lots',
    'd1_quantity_mismatch_voided_lots',
    'negative_remaining_lots',
    'overfull_remaining_lots',
    'live_disposal_exceeds_lot_quantity',
    'voided_purchases_with_live_lots',
    'voided_purchases_with_live_disposals',
    'voided_openings_with_live_pull_lots',
    'voided_openings_with_live_disposals',
    'voided_sales_with_live_disposals',
    'lot_quantity_mismatch_lines_excess',
  ]
  console.log('Integrity counters (must all be 0):')
  let integrityFailed = false
  for (const key of mustBeZero) {
    const value = diagnostics[key]
    const ok = value === 0
    if (!ok) integrityFailed = true
    console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${key} = ${String(value)}`)
  }

  await service.auth.admin.deleteUser(user.id)

  if (deadlocks > 0 || unrecognized > 0 || integrityFailed) {
    console.error('CAMPAIGN FAILED')
    process.exit(1)
  }
  console.log(
    'CAMPAIGN PASSED: zero deadlocks, zero unrecognized error shapes, zero invariant violations.',
  )
}

main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error(e)
    process.exit(1)
  })

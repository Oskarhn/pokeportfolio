import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createAnonClient,
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  seedCatalog,
  signInAs,
  type SyntheticUser,
  type TestClient,
} from '../db/setup'
import { rawSqlAvailable, runRawSqlAsync } from '../db/raw-sql'
import {
  seedAccountLedger,
  USER_OWNED_TABLES,
  type SeededLedger,
} from '../db/lib/account-ledger-fixture'

/**
 * P200 area A: a catalog-driven cross-tenant authorization matrix.
 *
 * Earlier suites prove each table / RPC when it was introduced. Two things were missing: (1) the
 * M3-era `coverage.test.ts` knows 11 tables while the schema now has 28, so a new user-private
 * table could ship with no authorization test; (2) no single place states, for EVERY
 * authenticated-callable function and EVERY user-owned table, what a second tenant can do to the
 * first one's data. This file is that place. The structural half reads pg_catalog (so a new table
 * or RPC fails here until somebody classifies it); the behavioural half uses two real synthetic
 * accounts that each own a row in every user-owned table (the P152 ledger fixture).
 *
 * Contract asserted for every cross-tenant probe: the attacker's call is refused or sees nothing,
 * the victim's rows are byte-identical afterwards, and the error text names nothing of the victim.
 */

// ---------------------------------------------------------------------------------------------
// Structural half: classification of the catalog
// ---------------------------------------------------------------------------------------------

/** Tables with no per-user owner column: shared catalog / market data and the admin-only ledger. */
const SHARED_OR_SYSTEM_TABLES = [
  'card_series',
  'card_sets',
  'cards',
  'card_variants',
  'fx_rates',
  'price_snapshots',
  'invitations',
  'invitation_claims',
  'account_erasure_receipts',
  'account_deletion_requests',
  'catalog_sync_runs',
  'environment_ingest_config',
  'portfolio_recompute_runs',
  'price_sync_runs',
  'restore_gate_runs',
] as const

/** Operational tables no browser role may read or write at all (service_role / postgres only). */
const SERVER_ONLY_TABLES = [
  'account_erasure_receipts',
  'account_deletion_requests',
  'catalog_sync_runs',
  'environment_ingest_config',
  'invitation_claims',
  'portfolio_recompute_runs',
  'price_sync_runs',
  'restore_gate_runs',
] as const

/**
 * Every function the `authenticated` role can execute, with the reason it is safe. Adding a
 * function to the browser-reachable surface without adding it here fails the catalog test.
 * `own` = acts only on auth.uid()'s rows (SECURITY INVOKER under RLS, or DEFINER that filters on
 * auth.uid()); `admin` = DEFINER with an is_admin() gate; `pure` = no table access.
 */
const AUTHENTICATED_CALLABLE: Record<string, 'own' | 'admin' | 'pure' | 'public-by-design'> = {
  add_card_acquisition: 'own',
  allocate_largest_remainder: 'pure',
  allocate_largest_remainder_signed: 'pure',
  allocate_purchase_discount: 'pure',
  card_condition_to_text: 'pure',
  clear_manual_valuation: 'own',
  create_invitation: 'admin',
  create_opening: 'own',
  create_opening_from_provisional: 'own',
  create_purchase: 'own',
  create_sale: 'own',
  currency_minor_unit_exponent: 'pure',
  get_card_variant_price_history: 'public-by-design',
  get_dashboard_summary: 'own',
  get_holding_value_provenance: 'own',
  get_market_movers: 'own',
  get_monthly_spend: 'own',
  get_opening: 'own',
  get_portfolio_history: 'own',
  get_recent_activity: 'own',
  grader_to_text: 'pure',
  invitation_status: 'public-by-design',
  is_admin: 'own',
  list_history_events: 'own',
  list_opening_sources: 'own',
  list_portfolio: 'own',
  m12_recompute_pending_for_self: 'own',
  money_minor_to_nok_minor: 'pure',
  natural_sort_key: 'pure',
  portfolio_counts: 'own',
  purchase_spending_summary: 'own',
  reconcile_opening_cost: 'own',
  reduce_holding_quantity: 'own',
  remove_holdings_from_portfolio: 'own',
  reset_my_portfolio_data: 'own',
  resolve_variant_market_values: 'public-by-design',
  revoke_invitation: 'admin',
  sales_summary: 'own',
  search_cards: 'public-by-design',
  set_manual_valuation: 'own',
  set_sealed_lot_intent: 'own',
  update_purchase: 'own',
  update_sale: 'own',
  void_acquisition_lot: 'own',
  void_opening: 'own',
  void_purchase: 'own',
  void_sale: 'own',
}

async function psql(sql: string): Promise<string[]> {
  const result = await runRawSqlAsync(sql)
  if (result.code !== 0) throw new Error(`psql failed: ${result.output}`)
  return result.output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
}

describe.skipIf(!rawSqlAvailable())('P200 catalog classification', () => {
  it('every table in public is RLS-enabled and classified as user-owned or shared', async () => {
    const rows = await psql(
      `select c.relname || '|' || c.relrowsecurity::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r','p') order by 1;`,
    )
    const tables = rows.map((r) => r.split('|') as [string, string])
    const noRls = tables.filter(([, rls]) => rls !== 'true').map(([t]) => t)
    expect(noRls).toEqual([])
    const owned = new Set(USER_OWNED_TABLES.map((t) => t.table))
    const shared = new Set<string>(SHARED_OR_SYSTEM_TABLES)
    const unclassified = tables.map(([t]) => t).filter((t) => !owned.has(t) && !shared.has(t))
    // A new table must be added to USER_OWNED_TABLES (and thereby to the cross-tenant matrix
    // below and the account-deletion purge) or to SHARED_OR_SYSTEM_TABLES with a reason.
    expect(unclassified).toEqual([])
    const stale = [...owned, ...shared].filter((t) => !tables.some(([name]) => name === t))
    expect(stale).toEqual([])
  })

  it('the anon role has no privilege on any table or sequence in public', async () => {
    const rows = await psql(
      `select count(*) from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon','PUBLIC');`,
    )
    expect(rows).toEqual(['0'])
  })

  it('the authenticated-callable function set equals the classified set', async () => {
    const rows = await psql(
      `select p.proname from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
        and has_function_privilege('authenticated', p.oid, 'execute') group by 1 order by 1;`,
    )
    expect(rows).toEqual(Object.keys(AUTHENTICATED_CALLABLE).sort())
  })

  it('every SECURITY DEFINER function pins an empty search_path', async () => {
    const rows = await psql(
      `select p.proname from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef
        and not coalesce(p.proconfig @> array['search_path='], false)
        and not coalesce(p.proconfig @> array['search_path=""'], false) order by 1;`,
    )
    expect(rows).toEqual([])
  })

  it('SECURITY DEFINER functions reachable by clients either derive the actor from auth.uid() or take no actor argument', async () => {
    // A client-reachable DEFINER function with a p_user_id argument would let any caller name
    // their victim. The privileged p_user_id functions are service_role-only (see the grant audit).
    const rows = await psql(
      `select p.proname from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef
        and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))
        and (pg_get_function_arguments(p.oid) ~* '(^|, )p_(user|owner|actor)_id\\y') order by 1;`,
    )
    expect(rows).toEqual([])
  })

  it('all views in public run with the invoker rights', async () => {
    const rows = await psql(
      `select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('v','m')
        and not coalesce(c.reloptions @> array['security_invoker=true'], false)
        and not coalesce(c.reloptions @> array['security_invoker=on'], false) order by 1;`,
    )
    expect(rows).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------
// Behavioural half: two real tenants
// ---------------------------------------------------------------------------------------------

interface Victim {
  user: SyntheticUser
  client: TestClient
  seed: SeededLedger
  lotId: string
  sealedLotId: string
  holdingId: string
  purchaseLineId: string
  retailerId: string
  storageLocationId: string
  manualCardId: string
}

const service = createServiceClient()
let a: Victim
let b: { user: SyntheticUser; client: TestClient }
let empty: { user: SyntheticUser; client: TestClient }
let admin: { user: SyntheticUser; client: TestClient }

const rowsOf = (data: unknown): unknown[] => (Array.isArray(data) ? data : [])
const sortKey = (row: Record<string, unknown>): string =>
  JSON.stringify([row.id, row.holding_id, row.user_id, row.lot_id, row.tag_id, row.collection_id])

/** Everything the victim owns, as one stable string. Any foreign write changes it. */
async function digest(userId: string): Promise<string> {
  const parts: Record<string, unknown> = {}
  for (const { table, column } of USER_OWNED_TABLES) {
    const { data, error } = await service.from(table).select('*').eq(column, userId)
    if (error) throw new Error(`digest ${table}: ${error.message}`)
    parts[table] = (data as Record<string, unknown>[]).sort((x, y) =>
      sortKey(x).localeCompare(sortKey(y)),
    )
  }
  return JSON.stringify(parts)
}

/** Text an error is allowed to reveal must never contain anything that identifies the victim. */
function expectNoVictimLeak(text: string): void {
  for (const secret of [a.user.email, a.user.id, a.seed.displayName, 'Retailer Alpha']) {
    expect(text).not.toContain(secret)
  }
}

beforeAll(async () => {
  const userA = await createSyntheticUser(service, 'p200a')
  const clientA = await signInAs(userA)
  const seed = await seedAccountLedger(service, userA, clientA, 'Alpha')
  const one = async <T>(q: PromiseLike<{ data: T | null; error: { message: string } | null }>) => {
    const { data, error } = await q
    if (error || !data) throw new Error(error?.message ?? 'missing fixture row')
    return data
  }
  const lines = await one(
    service
      .from('purchase_lines')
      .select('id, line_type')
      .eq('purchase_id', seed.purchaseId)
      .overrideTypes<{ id: string; line_type: string }[], { merge: false }>(),
  )
  const sealedLine = lines.find((l) => l.line_type === 'sealed')!
  const cardLine = lines.find((l) => l.line_type === 'card')!
  const sealedLot = await one(
    service
      .from('acquisition_lots')
      .select('id, holding_id')
      .eq('purchase_line_id', sealedLine.id)
      .single<{ id: string; holding_id: string }>(),
  )
  const cardLot = await one(
    service
      .from('acquisition_lots')
      .select('id, holding_id')
      .eq('purchase_line_id', cardLine.id)
      .single<{ id: string; holding_id: string }>(),
  )
  const retailer = await one(
    service.from('retailers').select('id').eq('user_id', userA.id).single<{ id: string }>(),
  )
  const location = await one(
    service.from('storage_locations').select('id').eq('user_id', userA.id).single<{ id: string }>(),
  )
  const manual = await one(
    service
      .from('manual_card_definitions')
      .select('id')
      .eq('user_id', userA.id)
      .single<{ id: string }>(),
  )
  a = {
    user: userA,
    client: clientA,
    seed,
    lotId: cardLot.id,
    sealedLotId: sealedLot.id,
    holdingId: cardLot.holding_id,
    purchaseLineId: cardLine.id,
    retailerId: retailer.id,
    storageLocationId: location.id,
    manualCardId: manual.id,
  }
  const userB = await createSyntheticUser(service, 'p200b')
  b = { user: userB, client: await signInAs(userB) }
  const userE = await createSyntheticUser(service, 'p200e')
  empty = { user: userE, client: await signInAs(userE) }
  const userAdmin = await createSyntheticUser(service, 'p200admin')
  await service.from('profiles').update({ is_admin: true }).eq('id', userAdmin.id)
  admin = { user: userAdmin, client: await signInAs(userAdmin) }
}, 120_000)

afterAll(async () => {
  for (const u of [a, b, empty, admin] as (Partial<{ user: SyntheticUser }> | undefined)[]) {
    if (u?.user) await deleteSyntheticUser(service, u.user.id)
  }
}, 120_000)

describe('P200 tenant B versus tenant A: tables', () => {
  for (const { table, column } of USER_OWNED_TABLES) {
    it(`${table}: B cannot read, change, delete or forge A's rows`, async () => {
      const before = await digest(a.user.id)

      // Read: neither filtered on A's id nor unfiltered ever returns an A row.
      const targeted = await b.client.from(table).select('*').eq(column, a.user.id)
      expect(rowsOf(targeted.data)).toEqual([])
      const all = await b.client.from(table).select(column)
      const foreign = (rowsOf(all.data) as unknown as Record<string, string>[]).filter(
        (r) => r[column] === a.user.id,
      )
      expect(foreign).toEqual([])

      // Write: update / delete aimed at A's rows touch nothing (RLS hides them or the grant is absent).
      const upd = await b.client
        .from(table)
        .update({ [column]: b.user.id })
        .eq(column, a.user.id)
        .select()
      expect(rowsOf(upd.data)).toEqual([])
      const del = await b.client.from(table).delete().eq(column, a.user.id).select()
      expect(rowsOf(del.data)).toEqual([])

      // Forge: inserting a row owned by A must be refused outright.
      const ins = await b.client.from(table).insert({ [column]: a.user.id } as never)
      expect(ins.error).not.toBeNull()

      expect(await digest(a.user.id)).toBe(before)
    })
  }

  it('B cannot move one of B’s own rows to A by rewriting the owner column', async () => {
    const mine = await b.client
      .from('retailers')
      .insert({ user_id: b.user.id, name: 'Beta retailer' })
      .select('id')
      .single<{ id: string }>()
    if (mine.error) {
      // Direct inserts may be locked down in future; the reassignment probe is then moot.
      expect(mine.error).not.toBeNull()
      return
    }
    const move = await b.client
      .from('retailers')
      .update({ user_id: a.user.id })
      .eq('id', mine.data.id)
      .select()
    expect(move.error !== null || rowsOf(move.data).length === 0).toBe(true)
    const check = await service
      .from('retailers')
      .select('user_id')
      .eq('id', mine.data.id)
      .single<{ user_id: string }>()
    expect(check.data?.user_id).toBe(b.user.id)
    await service.from('retailers').delete().eq('id', mine.data.id)
  })

  it('B cannot read or reference A’s private sealed product', async () => {
    const read = await b.client
      .from('sealed_products')
      .select('id')
      .eq('id', a.seed.privateSealedProductId)
    expect(rowsOf(read.data)).toEqual([])
    const buy = await b.client.rpc('create_purchase', {
      p_purchased_on: new Date().toISOString().slice(0, 10),
      p_currency: 'NOK',
      p_lines: [
        {
          line_type: 'sealed',
          sealed_product_id: a.seed.privateSealedProductId,
          quantity: 1,
          unit_price_minor: 100,
        },
      ],
    })
    expect(buy.error).not.toBeNull()
    expectNoVictimLeak(JSON.stringify(buy.error))
  })

  it('B cannot attach A’s retailer, storage location or manual card to B’s own rows', async () => {
    const day = new Date().toISOString().slice(0, 10)
    const viaRetailer = await b.client.rpc('create_purchase', {
      p_purchased_on: day,
      p_currency: 'NOK',
      p_retailer_id: a.retailerId,
      p_lines: [
        {
          line_type: 'card',
          card_variant_id: seedCatalog.pikachuVariantId,
          condition: 'NM',
          quantity: 1,
          unit_price_minor: 100,
        },
      ],
    })
    expect(viaRetailer.error).not.toBeNull()
    const viaLocation = await b.client.rpc('add_card_acquisition', {
      p_card_variant_id: seedCatalog.pikachuVariantId,
      p_condition: 'NM',
      p_origin: 'gift',
      p_cost_basis_state: 'not_paid',
      p_quantity: 1,
      p_acquired_on: day,
      p_storage_location_id: a.storageLocationId,
    })
    expect(viaLocation.error).not.toBeNull()
    const viaManual = await b.client.rpc('add_card_acquisition', {
      p_manual_card_id: a.manualCardId,
      p_condition: 'NM',
      p_origin: 'gift',
      p_cost_basis_state: 'not_paid',
      p_quantity: 1,
      p_acquired_on: day,
    })
    expect(viaManual.error).not.toBeNull()
    for (const r of [viaRetailer, viaLocation, viaManual]) {
      expectNoVictimLeak(JSON.stringify(r.error))
    }
    const mine = await service.from('holdings').select('id').eq('user_id', b.user.id)
    expect(rowsOf(mine.data)).toEqual([])
  })
})

describe('P200 tenant B versus tenant A: RPCs addressed at A’s ids', () => {
  const day = new Date().toISOString().slice(0, 10)

  interface Probe {
    name: string
    /** Idempotent, owner-scoped void RPCs may succeed as a no-op; they must still change nothing. */
    mayNoOp?: boolean
    run: () => PromiseLike<{ data: unknown; error: unknown }>
  }

  const probes = (): Probe[] => [
    {
      name: 'void_sale',
      run: () => b.client.rpc('void_sale', { p_sale_id: a.seed.saleId, p_reason: 'x' }),
    },
    {
      name: 'update_sale',
      run: () =>
        b.client.rpc('update_sale', {
          p_sale_id: a.seed.saleId,
          p_sold_on: day,
          p_currency: 'NOK',
          p_lines: [{ lot_id: a.lotId, quantity: 1, unit_gross_minor: 1 }],
        }),
    },
    {
      name: 'create_sale (A lot)',
      run: () =>
        b.client.rpc('create_sale', {
          p_sold_on: day,
          p_currency: 'NOK',
          p_idempotency_key: crypto.randomUUID(),
          p_lines: [{ lot_id: a.lotId, quantity: 1, unit_gross_minor: 1 }],
        }),
    },
    {
      name: 'void_opening',
      run: () => b.client.rpc('void_opening', { p_opening_id: a.seed.openingId, p_reason: 'x' }),
    },
    {
      name: 'reconcile_opening_cost',
      run: () =>
        b.client.rpc('reconcile_opening_cost', {
          p_opening_id: a.seed.openingId,
          p_real_source_lot_id: a.sealedLotId,
        }),
    },
    {
      name: 'create_opening (A source lot)',
      run: () =>
        b.client.rpc('create_opening', {
          p_source_lot_id: a.sealedLotId,
          p_quantity: 1,
          p_opened_on: day,
          p_pulls: [],
        }),
    },
    {
      name: 'update_purchase',
      run: () =>
        b.client.rpc('update_purchase', {
          p_purchase_id: a.seed.purchaseId,
          p_purchased_on: day,
          p_currency: 'NOK',
          p_lines: [
            {
              line_type: 'card',
              card_variant_id: seedCatalog.pikachuVariantId,
              condition: 'NM',
              quantity: 1,
              unit_price_minor: 1,
            },
          ],
        }),
    },
    {
      name: 'void_purchase',
      run: () => b.client.rpc('void_purchase', { p_purchase_id: a.seed.purchaseId, p_reason: 'x' }),
    },
    {
      name: 'void_acquisition_lot',
      run: () => b.client.rpc('void_acquisition_lot', { p_lot_id: a.lotId, p_reason: 'x' }),
    },
    {
      name: 'reduce_holding_quantity',
      run: () =>
        b.client.rpc('reduce_holding_quantity', {
          p_holding_id: a.holdingId,
          p_lot_reductions: [{ lot_id: a.lotId, quantity: 1 }],
        }),
    },
    {
      name: 'remove_holdings_from_portfolio',
      run: () => b.client.rpc('remove_holdings_from_portfolio', { p_holding_ids: [a.holdingId] }),
    },
    {
      name: 'set_sealed_lot_intent',
      run: () =>
        b.client.rpc('set_sealed_lot_intent', { p_lot_id: a.sealedLotId, p_intent: 'to_open' }),
    },
    {
      name: 'set_manual_valuation',
      run: () =>
        b.client.rpc('set_manual_valuation', {
          p_holding_id: a.holdingId,
          p_value_minor: 1,
          p_effective_from: day,
        }),
    },
    {
      name: 'clear_manual_valuation',
      mayNoOp: true,
      run: () => b.client.rpc('clear_manual_valuation', { p_holding_id: a.holdingId }),
    },
  ]

  it('every write RPC aimed at A’s ids is refused and A is unchanged', async () => {
    const before = await digest(a.user.id)
    for (const probe of probes()) {
      const { data, error } = await probe.run()
      if (!probe.mayNoOp) {
        expect(error, `${probe.name} must be refused for a foreign id`).not.toBeNull()
      }
      expect(data ?? null, `${probe.name} must return no row`).toBeNull()
      expectNoVictimLeak(JSON.stringify(error))
    }
    expect(await digest(a.user.id)).toBe(before)
    // And B gained nothing as a side effect.
    for (const { table, column } of USER_OWNED_TABLES) {
      if (table === 'profiles' || table === 'invitation_redemptions') continue
      const own = await service
        .from(table)
        .select('*', { count: 'exact', head: true })
        .eq(column, b.user.id)
      expect(own.count ?? 0, `${table} rows owned by B`).toBe(0)
    }
  })

  it('read RPCs aimed at A’s ids return nothing', async () => {
    const opening = await b.client.rpc('get_opening', { p_opening_id: a.seed.openingId })
    expect(opening.error !== null || ((opening.data as unknown[] | null) ?? []).length === 0).toBe(
      true,
    )
    const provenance = await b.client.rpc('get_holding_value_provenance', {
      p_holding_id: a.holdingId,
    })
    expect(
      provenance.error !== null || ((provenance.data as unknown[] | null) ?? []).length === 0,
    ).toBe(true)
    const sources = await b.client.rpc('list_opening_sources', { p_holding_id: a.holdingId })
    expect(sources.error !== null || ((sources.data as unknown[] | null) ?? []).length === 0).toBe(
      true,
    )
    for (const r of [opening, provenance, sources]) expectNoVictimLeak(JSON.stringify(r))
  })

  it('aggregate RPCs for a tenant with no data reveal none of A’s data', async () => {
    const calls: [string, Record<string, unknown>][] = [
      ['get_dashboard_summary', {}],
      ['sales_summary', {}],
      ['purchase_spending_summary', {}],
      ['get_recent_activity', { p_limit: 50 }],
      ['get_monthly_spend', { p_months: 12 }],
      ['list_history_events', { p_limit: 100 }],
      ['portfolio_counts', {}],
      ['get_portfolio_history', { p_display_currency: 'NOK' }],
    ]
    for (const [name, args] of calls) {
      const r = await empty.client.rpc(name, args)
      expect(r.error, `${name}: ${JSON.stringify(r.error)}`).toBeNull()
      const text = JSON.stringify(r.data)
      expectNoVictimLeak(text)
      expect(text).not.toContain(a.seed.purchaseId)
      expect(text).not.toContain(a.seed.saleId)
      expect(text).not.toContain(a.seed.openingId)
    }
    const list = await empty.client.rpc('list_portfolio', {})
    expect(list.error).toBeNull()
    expect(JSON.stringify(list.data)).not.toContain(a.holdingId)
    const view = await empty.client.from('holding_summaries').select('*')
    expect(rowsOf(view.data)).toEqual([])
  })
})

describe('P200 server-only tables', () => {
  it('neither anon nor an authenticated tenant can read or write them', async () => {
    const anon = createAnonClient()
    for (const table of SERVER_ONLY_TABLES) {
      for (const [who, client] of [
        ['anon', anon],
        ['authenticated', b.client],
        ['admin', admin.client],
      ] as const) {
        const read = await client.from(table).select('*').limit(1)
        expect(read.error !== null || rowsOf(read.data).length === 0, `${who} read ${table}`).toBe(
          true,
        )
        const write = await client.from(table).insert({} as never)
        expect(write.error, `${who} insert ${table}`).not.toBeNull()
        const del = await client
          .from(table)
          .delete()
          .not('id' as never, 'is', null)
          .select()
        expect(del.error !== null || rowsOf(del.data).length === 0, `${who} delete ${table}`).toBe(
          true,
        )
      }
    }
  })
})

describe('P200 anonymous and privilege forgery', () => {
  it('anon cannot read any table or execute any RPC except invitation_status', async () => {
    const anon = createAnonClient()
    for (const { table } of USER_OWNED_TABLES) {
      const r = await anon.from(table).select('*').limit(1)
      expect(r.error !== null || rowsOf(r.data).length === 0, `anon read ${table}`).toBe(true)
    }
    for (const name of Object.keys(AUTHENTICATED_CALLABLE)) {
      if (name === 'invitation_status') continue
      const r = await anon.rpc(name, {})
      expect(r.error, `anon ${name} must be refused`).not.toBeNull()
    }
  })

  it('client-supplied fields cannot grant admin: profile update, signup metadata, token claims', async () => {
    const profile = await b.client
      .from('profiles')
      .update({ is_admin: true })
      .eq('id', b.user.id)
      .select()
    expect(profile.error !== null || rowsOf(profile.data).length === 0).toBe(true)

    const meta = await b.client.auth.updateUser({
      data: { is_admin: true, role: 'service_role', admin: true },
    })
    expect(meta.error).toBeNull() // user_metadata is user-writable by design ...
    await b.client.auth.refreshSession()
    const isAdmin = await b.client.rpc('is_admin')
    expect(isAdmin.data).toBe(false) // ... which is exactly why nothing may read it.

    const invite = await b.client.rpc('create_invitation', { p_email: 'forged@example.invalid' })
    expect(invite.error).not.toBeNull()
    const list = await b.client.from('invitations').select('id')
    expect(rowsOf(list.data)).toEqual([])
    const revoke = await b.client.rpc('revoke_invitation', { p_invitation_id: a.seed.invitationId })
    expect(revoke.error).not.toBeNull()
    const own = await service.from('profiles').select('is_admin').eq('id', b.user.id).single()
    expect(own.data?.is_admin).toBe(false)
  })

  it('an admin sees invitations but still none of another tenant’s ledger', async () => {
    const invitations = await admin.client.from('invitations').select('id')
    expect(invitations.error).toBeNull()
    for (const { table, column } of USER_OWNED_TABLES) {
      // profiles: an admin reads only their own row under RLS. invitation_redemptions: the admin
      // screen's documented "who redeemed which invitation" link (SECURITY.md §4); it carries no
      // ledger data.
      if (table === 'profiles' || table === 'invitation_redemptions') continue
      const r = await admin.client.from(table).select('*').eq(column, a.user.id)
      expect(r.data ?? [], `admin read of ${table}`).toEqual([])
    }
    const void_ = await admin.client.rpc('void_sale', { p_sale_id: a.seed.saleId, p_reason: 'x' })
    expect(void_.error).not.toBeNull()
  })

  it('a forged or malformed JWT is not accepted by the Data API', async () => {
    const url = process.env.SUPABASE_URL as string
    const key = process.env.SUPABASE_ANON_KEY as string
    const forged = (role: string) => {
      const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
      return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role, sub: a.user.id, exp: 4_102_444_800 })}.AAAA`
    }
    for (const token of [forged('authenticated'), forged('service_role'), 'not-a-jwt', '']) {
      const res = await fetch(`${url}/rest/v1/purchases?select=id`, {
        headers: { apikey: key, Authorization: `Bearer ${token}` },
      })
      expect(res.status, `token ${token.slice(0, 12)}…`).toBeGreaterThanOrEqual(400)
    }
    // alg=none must never be honoured either.
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(
      JSON.stringify({ role: 'service_role', exp: 4_102_444_800 }),
    ).toString('base64url')}.`
    const res = await fetch(`${url}/rest/v1/purchases?select=id`, {
      headers: { apikey: key, Authorization: `Bearer ${none}` },
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
  })
})

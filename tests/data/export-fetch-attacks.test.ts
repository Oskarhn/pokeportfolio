import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import { fetchExportSnapshot } from '../../src/data/export/fetch-snapshot'
import {
  AuthIdentityChangedError,
  IdentityAuthority,
  type IdentityLease,
} from '../../src/auth/identity-lease'
import type { Database } from '../../src/data/database.types'

/**
 * Adversarial pagination/integrity attacks (P39's scenarios, rerun against the FINAL fetcher):
 * a PostgREST-shaped fake transport drives the REAL fetchExportSnapshot orchestration — the
 * same code production uses — while the transport misbehaves the way real PostgREST can under
 * a server row cap or concurrent owner mutation. Every silent-loss class must end LOUDLY.
 */

const USER_A = 'aaaaaaaa-0000-4000-8000-00000000000a'

type Row = Record<string, unknown>

function holdingRows(n: number, startOrd = 0): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `h${String(startOrd + i).padStart(4, '0')}`,
    user_id: USER_A,
    holding_kind: 'raw_card',
    card_variant_id: null,
    sealed_product_id: null,
    manual_card_id: null,
    grading_state: 'not_graded',
    condition: 'NM',
    grader: null,
    grade: null,
    cert_number: null,
    is_favorite: false,
    notes: null,
    deleted_at: null,
    created_at: '2026-01-01T00:00:00+00:00',
    updated_at: '2026-01-01T00:00:00+00:00',
  }))
}

/** Sorts rows ascending by the requested columns (string compare mirrors uuid order here). */
function sortBy(rows: Row[], columns: readonly string[]): Row[] {
  const sorted = [...rows]
  sorted.sort((a, b) => {
    for (const col of columns) {
      const av = String(a[col])
      const bv = String(b[col])
      if (av !== bv) return av < bv ? -1 : 1
    }
    return 0
  })
  return sorted
}

interface FakeState {
  /** Current live rows per table — closures see mutations made between page requests. */
  tables: Map<string, () => Row[]>
  /** Invoked with a per-table request counter AFTER each page/body request resolves. */
  onRequest?: (table: string, requestIndex: number) => void
  /** Simulates a server-side row cap below the requested window size (db-max-rows class). */
  capResponsesAt?: number
  /** Shared per-table request counters (builders are fresh per page). */
  requestCounts: Map<string, number>
  /** The signed-in user at THIS instant (undefined = USER_A, null = signed out). Tests flip it to
   *  simulate an account switch — in this tab or, through shared storage, in another one. */
  sessionUserId?: string | null
}

class FakeBuilder {
  private filters: ((rows: Row[]) => Row[])[] = []
  private orderColumns: string[] = []
  private window: { from: number; to: number } | null = null
  private wantsExactCount = false
  private readonly tableName: string
  private readonly state: FakeState

  constructor(tableName: string, state: FakeState) {
    this.tableName = tableName
    this.state = state
  }

  select(_columns: string, opts?: { count?: 'exact' }): this {
    if (opts?.count === 'exact') this.wantsExactCount = true
    return this
  }

  eq(column: string, value: unknown): this {
    this.filters.push((rows) => rows.filter((r) => r[column] === value))
    return this
  }

  in(column: string, values: readonly unknown[]): this {
    const set = new Set(values)
    this.filters.push((rows) => rows.filter((r) => set.has(r[column])))
    return this
  }

  order(column: string): this {
    this.orderColumns.push(column)
    return this
  }

  range(from: number, to: number): this {
    this.window = { from, to }
    return this
  }

  abortSignal(_signal: AbortSignal): this {
    void _signal
    // Cancellation is observed by the walker between pages; the transport itself succeeds.
    return this
  }

  overrideTypes(): this {
    return this
  }

  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    // Every page builds a fresh builder, so request counts live in shared state.
    const requestCounts = this.state.requestCounts
    const requestIndex = (requestCounts.get(this.tableName) ?? 0) + 1
    requestCounts.set(this.tableName, requestIndex)
    const source = this.state.tables.get(this.tableName)
    let rows = source ? source() : []
    for (const filter of this.filters) rows = filter(rows)
    rows = sortBy(rows, this.orderColumns)

    let payload: { data: Row[] | null; error: null; count: number | null }
    if (this.wantsExactCount) {
      payload = { data: null, error: null, count: rows.length }
    } else if (this.window !== null) {
      const capped = this.state.capResponsesAt ?? Number.POSITIVE_INFINITY
      const sliced = rows.slice(this.window.from, this.window.to + 1)
      payload = { data: sliced.slice(0, capped), error: null, count: null }
    } else {
      payload = { data: rows, error: null, count: null }
    }

    this.state.onRequest?.(this.tableName, requestIndex)
    return Promise.resolve(payload).then(onfulfilled, onrejected)
  }
}

function fakeClient(state: FakeState): SupabaseClient<Database> {
  const who = () => (state.sessionUserId === undefined ? USER_A : state.sessionUserId)
  return {
    auth: {
      getUser: () =>
        who() === null
          ? Promise.resolve({ data: { user: null }, error: { message: 'no session' } })
          : Promise.resolve({ data: { user: { id: who() } }, error: null }),
      getSession: () =>
        Promise.resolve({
          data: { session: who() === null ? null : { user: { id: who() } } },
          error: null,
        }),
    },
    from: (table: string) => new FakeBuilder(table, state),
  } as unknown as SupabaseClient<Database>
}

function registerStandardSections(state: FakeState, overrides: Record<string, Row[]> = {}): void {
  const canonical = [
    'profiles',
    'custom_collections',
    'custom_collection_members',
    'tags',
    'holding_tags',
    'storage_locations',
    'retailers',
    'holdings',
    'acquisition_lots',
    'manual_card_definitions',
    'sealed_products',
    'manual_valuations',
    'lot_cost_adjustments',
    'purchases',
    'purchase_lines',
    'sales',
    'sale_lines',
    'lot_disposals',
  ]
  for (const table of canonical) {
    const rows = overrides[table]
    state.tables.set(table, rows ? () => rows : () => [])
  }
}

describe('P39 pagination attacks against the real fetcher', () => {
  it('healthy source: every row arrives exactly once across multiple offset pages', async () => {
    const state: FakeState = { tables: new Map(), requestCounts: new Map() }
    const rows = holdingRows(7)
    registerStandardSections(state, { holdings: rows })
    const snapshot = await fetchExportSnapshot(fakeClient(state), { pageSize: 3 })
    expect(snapshot.holdings.map((h) => h.id)).toEqual(rows.map((r) => r['id']))
  })

  it('server row cap below pageSize cannot silently succeed — loud reconciliation failure', async () => {
    const state: FakeState = { tables: new Map(), capResponsesAt: 1, requestCounts: new Map() }
    registerStandardSections(state, { holdings: holdingRows(7) })
    await expect(fetchExportSnapshot(fakeClient(state), { pageSize: 3 })).rejects.toThrow(
      /Export integrity: holdings received 1 of 7/,
    )
  })

  it('delete between pages skips a row but the count mismatch fails the export loudly', async () => {
    const rows = holdingRows(7) // ids h0000..h0006
    const state: FakeState = {
      requestCounts: new Map(),
      tables: new Map(),
      onRequest: (table, requestIndex) => {
        if (table === 'holdings' && requestIndex === 2) rows.splice(0, 1) // oldest row vanishes
      },
    }
    registerStandardSections(state, { holdings: rows })
    // h0000 was read on page 1; deleting it shifts every later row left, so exactly one
    // canonical row is skipped — received 6 vs expected 7 must NOT look like success.
    await expect(fetchExportSnapshot(fakeClient(state), { pageSize: 3 })).rejects.toThrow(
      /holdings received 6 of 7/,
    )
  })

  it('insert between pages duplicates a boundary row — cross-page duplicate detection fires', async () => {
    const rows = holdingRows(7)
    const state: FakeState = {
      requestCounts: new Map(),
      tables: new Map(),
      onRequest: (table, requestIndex) => {
        if (table === 'holdings' && requestIndex === 2) {
          // A brand-new row whose id sorts BEFORE everything already read shifts every
          // remaining boundary row right, re-delivering one the walk already saw.
          const newcomer = { ...holdingRows(1)[0]!, id: 'f9999999-0000-4000-8000-000000000009' }
          rows.unshift(newcomer)
        }
      },
    }
    registerStandardSections(state, { holdings: rows })
    await expect(fetchExportSnapshot(fakeClient(state), { pageSize: 3 })).rejects.toThrow(
      /duplicate row/,
    )
  })

  it('endless full pages hit the hard max-page ceiling instead of hanging', async () => {
    const state: FakeState = { tables: new Map(), requestCounts: new Map() }
    registerStandardSections(state, { holdings: holdingRows(1000) })
    await expect(
      fetchExportSnapshot(fakeClient(state), { pageSize: 3, maxPages: 5 }),
    ).rejects.toThrow(/exceeded 5 pages/)
  })

  it('a pre-aborted signal cancels before any section is read', async () => {
    const state: FakeState = { tables: new Map(), requestCounts: new Map() }
    registerStandardSections(state, { holdings: holdingRows(7) })
    const controller = new AbortController()
    controller.abort()
    await expect(
      fetchExportSnapshot(fakeClient(state), { pageSize: 3, signal: controller.signal }),
    ).rejects.toThrow(/Export cancelled/)
  })
})

describe('runtime guards driven through the real orchestrator', () => {
  it('a lost ::text cast (numeric wire money) fails the whole export loudly', async () => {
    const corrupted = Number('9007199254740993') // what JSON.parse does WITHOUT the cast
    expect(corrupted).toBe(9007199254740992) // precision already destroyed
    const purchaseRow: Row = {
      id: 'p0000000-0000-4000-8000-000000000001',
      user_id: USER_A,
      purchased_on: '2026-01-08',
      retailer_id: null,
      currency: 'EUR',
      subtotal_minor: corrupted,
      shipping_minor: 0,
      customs_minor: 0,
      discount_minor: 0,
      total_minor: corrupted,
      total_nok_minor: corrupted,
      fx_rate_to_nok: '11.52345678',
      fx_rate_date: '2026-01-08',
      fx_source: 'norges_bank',
      origin: 'manual',
      notes: null,
      voided_at: null,
      created_at: '2026-01-08T00:00:00+00:00',
      updated_at: '2026-01-08T00:00:00+00:00',
    }
    const state: FakeState = { tables: new Map(), requestCounts: new Map() }
    registerStandardSections(state, { purchases: [purchaseRow] })
    await expect(fetchExportSnapshot(fakeClient(state))).rejects.toThrow(
      /purchases\.subtotal_minor[\s\S]*::text cast was lost/,
    )
  })

  it('a widened profile wire row cannot leak privilege-looking keys into the snapshot', async () => {
    const profileRow: Row = {
      id: USER_A,
      display_name: null,
      theme: 'dark',
      display_currency: 'NOK',
      locale: 'nb-NO',
      hide_values: false,
      hide_low_value_by_default: false,
      low_value_threshold_minor: '1000',
      use_eu_pricing: false,
      collection_grid_density: 2,
      collection_default_view: 'grid',
      collection_default_sort: 'name_asc',
      default_condition: null,
      default_language: null,
      default_storage_location_id: null,
      created_at: '2026-01-01T00:00:00+00:00',
      updated_at: '2026-01-01T00:00:00+00:00',
      // What SELECT '*' would hand back — the allowlist projection must strip these:
      is_admin: true,
      disabled_at: null,
      email: 'attacker@example.com',
    }
    const state: FakeState = { tables: new Map(), requestCounts: new Map() }
    registerStandardSections(state, { profiles: [profileRow] })
    const snapshot = await fetchExportSnapshot(fakeClient(state))
    const serialized = JSON.stringify(snapshot.profiles)
    expect(serialized).not.toContain('is_admin')
    expect(serialized).not.toContain('disabled_at')
    expect(serialized).not.toContain('attacker@example.com')
  })

  it('manifest card_sets covers ONLY sets referenced by exported user-created products', async () => {
    const sealedProduct: Row = {
      id: 'sp000000-0000-4000-8000-000000000001',
      created_by_user_id: USER_A,
      name: 'My box',
      product_type: 'booster_box',
      language: 'no',
      pack_count: 36,
      set_id: 'set-0000-0000-4000-8000-000000000001',
      image_url: null,
      cardmarket_product_id: null,
      tcgplayer_product_id: null,
      created_at: '2026-01-01T00:00:00+00:00',
      updated_at: '2026-01-01T00:00:00+00:00',
    }
    const cardSets: Row[] = [
      {
        id: 'set-0000-0000-4000-8000-000000000001',
        slug: 'neo1',
        name: 'Neo Genesis (JA)',
        language: 'ja',
        tcgdex_set_id: 'neo1',
      },
      {
        id: 'set-9999-9999-4000-8000-000000000002',
        slug: 'base1',
        name: 'Base Set',
        language: 'en',
        tcgdex_set_id: 'base1',
      },
    ]
    const state: FakeState = { tables: new Map(), requestCounts: new Map() }
    registerStandardSections(state, { sealed_products: [sealedProduct] })
    state.tables.set('card_sets', () => cardSets)
    const snapshot = await fetchExportSnapshot(fakeClient(state))
    // Exactly the referenced set, with its stable identity — never the unreferenced one,
    // never a catalog dump.
    expect(snapshot.identity_manifest.card_sets).toEqual([
      {
        id: 'set-0000-0000-4000-8000-000000000001',
        slug: 'neo1',
        name: 'Neo Genesis (JA)',
        language: 'ja',
        tcgdex_set_id: 'neo1',
      },
    ])
  })
})

const USER_B = 'bbbbbbbb-0000-4000-8000-00000000000b'

describe('P157 account switch during a multi-request export', () => {
  function holdingRowsFor(user: string, n: number, startOrd: number): Row[] {
    return holdingRows(n, startOrd).map((row) => ({ ...row, user_id: user }))
  }

  it('A→B mid-pagination discards the export — B rows never enter A’s file', async () => {
    const aRows = holdingRowsFor(USER_A, 7, 0)
    const bRows = holdingRowsFor(USER_B, 7, 100)
    const state: FakeState = {
      requestCounts: new Map(),
      tables: new Map(),
      onRequest: (table, requestIndex) => {
        // Request 1 is the COUNT, request 2 is page 1, request 3 is page 2 (pageSize 3).
        if (table === 'holdings' && requestIndex === 3) {
          state.sessionUserId = USER_B
          state.tables.set('holdings', () => bRows)
        }
      },
    }
    registerStandardSections(state, { holdings: aRows })
    const outcome = await fetchExportSnapshot(fakeClient(state), { pageSize: 3 }).then(
      (snapshot) => ({ snapshot }),
      (error: unknown) => ({ error }),
    )
    expect('snapshot' in outcome).toBe(false)
    expect((outcome as { error: unknown }).error).toBeInstanceOf(AuthIdentityChangedError)
  })

  it('a switch in another tab between two sections is caught at the next request', async () => {
    const state: FakeState = {
      requestCounts: new Map(),
      tables: new Map(),
      onRequest: (table, requestIndex) => {
        if (table === 'tags' && requestIndex === 2) state.sessionUserId = USER_B
      },
    }
    registerStandardSections(state, { holdings: holdingRowsFor(USER_A, 2, 0) })
    await expect(fetchExportSnapshot(fakeClient(state), { pageSize: 3 })).rejects.toBeInstanceOf(
      AuthIdentityChangedError,
    )
    // Nothing after the switch was requested: the export stopped at the first bracket.
    expect(state.requestCounts.get('holdings') ?? 0).toBe(0)
  })

  it('sign-out mid-export fails the export instead of finishing on an anonymous client', async () => {
    const state: FakeState = {
      requestCounts: new Map(),
      tables: new Map(),
      onRequest: (table, requestIndex) => {
        if (table === 'holdings' && requestIndex === 2) state.sessionUserId = null
      },
    }
    registerStandardSections(state, { holdings: holdingRowsFor(USER_A, 7, 0) })
    await expect(fetchExportSnapshot(fakeClient(state), { pageSize: 3 })).rejects.toBeInstanceOf(
      AuthIdentityChangedError,
    )
  })

  it('a switch during the very last request is still caught by the final gate', async () => {
    const state: FakeState = {
      requestCounts: new Map(),
      tables: new Map(),
      onRequest: (table, requestIndex) => {
        // openings is the last section: request 2 is its only page.
        if (table === 'openings' && requestIndex === 2) state.sessionUserId = USER_B
      },
    }
    registerStandardSections(state, { holdings: holdingRowsFor(USER_A, 2, 0) })
    await expect(fetchExportSnapshot(fakeClient(state), { pageSize: 3 })).rejects.toBeInstanceOf(
      AuthIdentityChangedError,
    )
  })

  it('the same user across the whole run (token refresh) is not an identity change', async () => {
    const state: FakeState = { tables: new Map(), requestCounts: new Map() }
    registerStandardSections(state, { holdings: holdingRowsFor(USER_A, 7, 0) })
    const snapshot = await fetchExportSnapshot(fakeClient(state), { pageSize: 3 })
    expect(snapshot.holdings).toHaveLength(7)
  })

  it('an export that never had an authenticated session refuses to start', async () => {
    const state: FakeState = { tables: new Map(), requestCounts: new Map(), sessionUserId: null }
    registerStandardSections(state, { holdings: holdingRowsFor(USER_A, 2, 0) })
    await expect(fetchExportSnapshot(fakeClient(state))).rejects.toThrow(
      /requires an authenticated session/,
    )
  })
})

/**
 * P162 — the export's identity guard is the identity LEASE of the leased client (P145/P149). These
 * drive the real fetcher with a client that, like the real one, has NO auth subsystem (reading
 * `.auth` throws) and carries only the lease it was created for. The session-based tests above
 * cover the plain-client fallback; everything the app actually runs is exercised here.
 */
describe('P162 account switch during a multi-request export, leased client', () => {
  function holdingRowsFor(user: string, n: number, startOrd: number): Row[] {
    return holdingRows(n, startOrd).map((row) => ({ ...row, user_id: user }))
  }

  function leasedFakeClient(state: FakeState, lease: IdentityLease): SupabaseClient<Database> {
    const client: Record<string, unknown> = {
      from: (table: string) => new FakeBuilder(table, state),
    }
    Object.defineProperty(client, 'auth', {
      get() {
        throw new Error('a leased client has no auth subsystem')
      },
    })
    Object.defineProperty(client, 'identityLease', { value: lease, enumerable: false })
    return client as unknown as SupabaseClient<Database>
  }

  function signedInAs(user: string): { authority: IdentityAuthority; lease: IdentityLease } {
    const authority = new IdentityAuthority()
    authority.observe(user)
    return { authority, lease: authority.begin(user) }
  }

  it('a healthy leased export completes without ever consulting an auth subsystem', async () => {
    const { lease } = signedInAs(USER_A)
    const state: FakeState = { tables: new Map(), requestCounts: new Map() }
    registerStandardSections(state, { holdings: holdingRowsFor(USER_A, 7, 0) })
    const snapshot = await fetchExportSnapshot(leasedFakeClient(state, lease), { pageSize: 3 })
    expect(snapshot.holdings).toHaveLength(7)
  })

  it('A→B mid-pagination discards the export and stops issuing requests', async () => {
    const { authority, lease } = signedInAs(USER_A)
    const state: FakeState = {
      requestCounts: new Map(),
      tables: new Map(),
      onRequest: (table, requestIndex) => {
        if (table === 'holdings' && requestIndex === 3) {
          authority.observe(USER_B)
          state.tables.set('holdings', () => holdingRowsFor(USER_B, 7, 100))
        }
      },
    }
    registerStandardSections(state, { holdings: holdingRowsFor(USER_A, 7, 0) })
    await expect(
      fetchExportSnapshot(leasedFakeClient(state, lease), { pageSize: 3 }),
    ).rejects.toBeInstanceOf(AuthIdentityChangedError)
    // The request that was already in flight finished; nothing after it was issued.
    expect(state.requestCounts.get('holdings')).toBe(3)
    expect(state.requestCounts.get('acquisition_lots') ?? 0).toBe(0)
  })

  it('A→B→A is an identity change even though the old user id is back', async () => {
    const { authority, lease } = signedInAs(USER_A)
    const state: FakeState = {
      requestCounts: new Map(),
      tables: new Map(),
      onRequest: (table, requestIndex) => {
        if (table === 'holdings' && requestIndex === 2) {
          authority.observe(USER_B)
          authority.observe(USER_A)
        }
      },
    }
    registerStandardSections(state, { holdings: holdingRowsFor(USER_A, 7, 0) })
    // The lease belongs to the first A generation: a user-id comparison would call this unchanged.
    expect(authority.userId).toBe(USER_A)
    await expect(
      fetchExportSnapshot(leasedFakeClient(state, lease), { pageSize: 3 }),
    ).rejects.toBeInstanceOf(AuthIdentityChangedError)
    expect(authority.begin(USER_A).isCurrent()).toBe(true)
  })

  it('sign-out mid-export fails it instead of finishing', async () => {
    const { authority, lease } = signedInAs(USER_A)
    const state: FakeState = {
      requestCounts: new Map(),
      tables: new Map(),
      onRequest: (table, requestIndex) => {
        if (table === 'holdings' && requestIndex === 2) authority.observe(null)
      },
    }
    registerStandardSections(state, { holdings: holdingRowsFor(USER_A, 7, 0) })
    await expect(
      fetchExportSnapshot(leasedFakeClient(state, lease), { pageSize: 3 }),
    ).rejects.toBeInstanceOf(AuthIdentityChangedError)
  })

  it('a switch during the very last request is still caught by the final gate', async () => {
    const { authority, lease } = signedInAs(USER_A)
    const state: FakeState = {
      requestCounts: new Map(),
      tables: new Map(),
      onRequest: (table, requestIndex) => {
        // openings is the last section: request 2 is its only page.
        if (table === 'openings' && requestIndex === 2) authority.observe(USER_B)
      },
    }
    registerStandardSections(state, { holdings: holdingRowsFor(USER_A, 2, 0) })
    await expect(
      fetchExportSnapshot(leasedFakeClient(state, lease), { pageSize: 3 }),
    ).rejects.toBeInstanceOf(AuthIdentityChangedError)
  })

  it('a lease that ended before the export started issues no request at all', async () => {
    const { authority, lease } = signedInAs(USER_A)
    authority.observe(USER_B)
    const state: FakeState = { tables: new Map(), requestCounts: new Map() }
    registerStandardSections(state, { holdings: holdingRowsFor(USER_A, 2, 0) })
    await expect(fetchExportSnapshot(leasedFakeClient(state, lease))).rejects.toBeInstanceOf(
      AuthIdentityChangedError,
    )
    expect([...state.requestCounts.values()].reduce((a, b) => a + b, 0)).toBe(0)
  })

  it('same-user auth events across the whole run (token refresh) do not end the export', async () => {
    const { authority, lease } = signedInAs(USER_A)
    let events = 0
    const state: FakeState = {
      requestCounts: new Map(),
      tables: new Map(),
      onRequest: () => {
        // TOKEN_REFRESHED / USER_UPDATED / a repeated SIGNED_IN all report the same user.
        if (!authority.observe(USER_A)) events += 1
      },
    }
    registerStandardSections(state, { holdings: holdingRowsFor(USER_A, 7, 0) })
    const snapshot = await fetchExportSnapshot(leasedFakeClient(state, lease), { pageSize: 3 })
    expect(snapshot.holdings).toHaveLength(7)
    expect(events).toBeGreaterThan(5)
  })

  it('a cancelled export stops requesting', async () => {
    const { lease } = signedInAs(USER_A)
    const controller = new AbortController()
    const state: FakeState = {
      requestCounts: new Map(),
      tables: new Map(),
      onRequest: (table, requestIndex) => {
        if (table === 'holdings' && requestIndex === 2) controller.abort()
      },
    }
    registerStandardSections(state, { holdings: holdingRowsFor(USER_A, 7, 0) })
    await expect(
      fetchExportSnapshot(leasedFakeClient(state, lease), {
        pageSize: 3,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(state.requestCounts.get('holdings')).toBe(2)
    expect(state.requestCounts.get('acquisition_lots') ?? 0).toBe(0)
  })
})

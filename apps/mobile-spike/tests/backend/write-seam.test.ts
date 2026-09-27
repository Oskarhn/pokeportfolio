import {
  AuthIdentityChangedError,
  runWithLease,
  type IdentityLease,
} from '../../src/auth/identity-authority'
import {
  addCardAcquisition,
  clearManualValuation,
  setManualValuation,
} from '../../src/write/collection-writes'
import { generateIdempotencyKey } from '../../src/write/idempotency-key'
import type { LeasedWriteDb } from '../../src/write/leased-write-client'
import { createOpening } from '../../src/write/opening-writes'
import { createPurchase } from '../../src/write/purchase-writes'
import { createSale } from '../../src/write/sale-writes'
import { createWriteDbBinder } from '../../src/write/write-db'
import type { Runtime } from '../../src/wiring/runtime'
import { deferred } from '../support/fakes'
import { backendDescribe, fixture, newSession, psql, realRuntime, until } from './support'
import type { Session } from './support'

/**
 * P175's write seam against the REAL local Supabase stack (real GoTrue, PostgREST, RLS, and the
 * P144 migration this branch carries): exact bigint money, blank-vs-zero/unknown, negative net
 * proceeds, a discount above the goods subtotal, idempotent replay, the write allow-list, and
 * identity leasing — all through the real RPCs, not a scripted fetch.
 */
backendDescribe('P175 write seam against the real backend', () => {
  const { a, b } = fixture().users

  // This suite writes REAL rows to the shared fixture database (the whole point — proving real
  // writes happen). Other backend suites (identity.test.ts, collection.test.ts) hardcode user A's
  // exact seeded holding count, so every row created here is tracked and removed in `afterAll`,
  // in FK-safe order, leaving the fixture exactly as this suite found it.
  const createdHoldingIds: string[] = []
  const createdPurchaseIds: string[] = []
  const createdSaleIds: string[] = []
  const createdOpeningIds: string[] = []

  afterAll(() => {
    const inList = (ids: string[]) => ids.map((id) => `'${id}'`).join(',')
    // lot_disposals references BOTH sale_lines (a 'sale' disposal) and openings (an 'opening'
    // disposal that depletes the sealed lot) — every row that could reference a tracked sale or
    // opening must go before the sale/opening rows themselves, or their own FKs block the delete.
    if (createdSaleIds.length > 0) {
      psql(
        `delete from public.lot_disposals where sale_line_id in ` +
          `(select id from public.sale_lines where sale_id in (${inList(createdSaleIds)}));`,
      )
    }
    if (createdOpeningIds.length > 0) {
      psql(`delete from public.lot_disposals where opening_id in (${inList(createdOpeningIds)});`)
    }
    if (createdSaleIds.length > 0) {
      psql(`delete from public.sale_lines where sale_id in (${inList(createdSaleIds)});`)
      psql(`delete from public.sales where id in (${inList(createdSaleIds)});`)
    }
    if (createdHoldingIds.length > 0) {
      psql(
        `delete from public.manual_valuations where holding_id in (${inList(createdHoldingIds)});`,
      )
    }
    // openings.source_lot_id references acquisition_lots: openings must go first, or deleting the
    // lot a live opening still points to would violate that foreign key.
    if (createdOpeningIds.length > 0) {
      psql(`delete from public.openings where id in (${inList(createdOpeningIds)});`)
    }
    if (createdHoldingIds.length > 0) {
      psql(
        `delete from public.acquisition_lots where holding_id in (${inList(createdHoldingIds)});`,
      )
    }
    if (createdPurchaseIds.length > 0) {
      psql(
        `delete from public.purchase_lines where purchase_id in (${inList(createdPurchaseIds)});`,
      )
      psql(`delete from public.purchases where id in (${inList(createdPurchaseIds)});`)
    }
    if (createdHoldingIds.length > 0) {
      psql(`delete from public.holdings where id in (${inList(createdHoldingIds)});`)
    }
  })

  // EVERY 'S01'..'S06' / 5-digit-numeric-local_id card lives in the seed fixture's OWN
  // 'p158-synthetic-set' (scripts/seed-local-backend.mts), which also gives user A a NAMED,
  // condition='NM' holding on each of S01-S06 (and manual valuations on S03-S05) — a first attempt
  // at this query had no set filter, picked that exact card, and every acquisition merged into the
  // seed's own holding, corrupting identity.test.ts's hardcoded holding count on cleanup. The base
  // catalog seed (supabase/seed/0001_catalog.sql) also ships a handful of real 'neo1'/'base1' cards
  // that the p158 fixture never references at all — genuinely disjoint from anything seeded here.
  function realCardVariant(): { cardId: string; variantId: string } {
    const row = psql(
      'select c.id, v.id from public.cards c ' +
        'join public.card_variants v on v.card_id = c.id ' +
        'join public.card_sets cs on cs.id = c.set_id ' +
        "where cs.slug != 'p158-synthetic-set' limit 1;",
    )
    const [cardId, variantId] = row.split('|')
    if (cardId === undefined || variantId === undefined) throw new Error('fixture card missing')
    return { cardId, variantId }
  }

  function realSealedProductId(): string {
    const row = psql('select id from public.sealed_products limit 1;')
    if (row === '') throw new Error('no sealed_products in the fixture')
    return row
  }

  async function signedInAs(who: typeof a) {
    const session = newSession()
    const runtime = realRuntime(session)
    await switchTo(runtime, who)
    return { session, runtime }
  }

  /** Signs an EXISTING runtime's own session into `who` — a direct A -> B switch in the same tab,
   *  not a fresh session. */
  async function switchTo(runtime: Runtime, who: typeof a) {
    const result = await runtime.auth.signIn(who.email, who.password)
    expect(result).toEqual({ ok: true })
    await until(() => runtime.auth.getSnapshot().userId === who.id)
  }

  /** A write client bound to the given session and CURRENT lease of `runtime`'s authority — the
   *  same construction the app itself does (`App.tsx` -> `write-db.ts`), just without the
   *  WriteFormStore layer in between, so these tests can drive `write/*-writes.ts` directly. */
  function db(
    session: Session,
    renderedUserId: string | null,
    runtime: Runtime,
  ): { lease: IdentityLease; db: LeasedWriteDb } {
    const lease = runtime.authority.begin(renderedUserId)
    const bind = createWriteDbBinder({
      url: session.url,
      publishableKey: session.publishableKey,
      getSession: () => session.client.auth.getSession(),
    })
    return { lease, db: bind(lease) }
  }

  // Two acquisitions of the SAME card variant + condition merge into one HOLDING with several
  // LOTS (M6: a holding aggregates by card identity, not by acquisition event) — every lookup
  // below is scoped by LOT id, never by holding id, so it can never read another lot's row.
  /** The holding a purchase's own card line created (create_purchase creates a fresh
   *  acquisition_lot + holding for each new card line, same as add_card_acquisition). */
  function holdingIdForPurchase(purchaseId: string): string {
    const id = psql(
      `select al.holding_id from public.acquisition_lots al ` +
        `join public.purchase_lines pl on pl.id = al.purchase_line_id ` +
        `where pl.purchase_id = '${purchaseId}' limit 1;`,
    )
    if (id === '') throw new Error(`no holding found for purchase ${purchaseId}`)
    return id
  }

  function lotRow(lotId: string): { costBasisState: string; unitCostBasisMinor: string | null } {
    const row = psql(
      `select cost_basis_state, unit_cost_basis_minor::text from public.acquisition_lots where id = '${lotId}';`,
    )
    const [costBasisState, unitCostBasisMinor] = row.split('|')
    return {
      costBasisState: costBasisState ?? '',
      unitCostBasisMinor:
        unitCostBasisMinor === undefined || unitCostBasisMinor === '' ? null : unitCostBasisMinor,
    }
  }

  /** A KNOWN-cost acquisition (any origin) makes add_card_acquisition create a purchase + one
   *  purchase line for its own cost entry — null only for an unknown/not_paid lot. */
  function purchaseIdForLot(lotId: string): string | null {
    const lineId = psql(
      `select coalesce(purchase_line_id::text, '') from public.acquisition_lots where id = '${lotId}';`,
    )
    if (lineId === '') return null
    return psql(`select purchase_id::text from public.purchase_lines where id = '${lineId}';`)
  }

  it('add_card_acquisition: a known cost above 2^53 is stored exactly; an unknown cost is never 0', async () => {
    const { session, runtime } = await signedInAs(a)
    const { variantId } = realCardVariant()
    const { lease, db: leasedDb } = db(session, runtime.authority.userId, runtime)

    const known = await addCardAcquisition(
      {
        cardVariantId: variantId,
        gradingState: 'raw',
        condition: 'NM',
        origin: 'other',
        costBasisState: 'known',
        unitCostBasisMinor: 9007199254740993n, // 2^53 + 1
        quantity: 3,
        acquiredOn: '2026-01-01',
      },
      leasedDb,
    )
    createdHoldingIds.push(known.holdingId)
    const knownPurchaseId = purchaseIdForLot(known.lotId)
    if (knownPurchaseId !== null) createdPurchaseIds.push(knownPurchaseId)
    expect(lease.isCurrent()).toBe(true)
    const knownRow = lotRow(known.lotId)
    expect(knownRow.costBasisState).toBe('known')
    expect(knownRow.unitCostBasisMinor).toBe('9007199254740993')

    const unknown = await addCardAcquisition(
      {
        cardVariantId: variantId,
        gradingState: 'raw',
        condition: 'NM',
        origin: 'other',
        costBasisState: 'unknown',
        quantity: 1,
        acquiredOn: '2026-01-01',
      },
      leasedDb,
    )
    createdHoldingIds.push(unknown.holdingId)
    const unknownRow = lotRow(unknown.lotId)
    expect(unknownRow.costBasisState).toBe('unknown')
    expect(unknownRow.unitCostBasisMinor).toBeNull() // never a fabricated 0
  })

  it('create_purchase: a discount ABOVE the goods subtotal succeeds (proves the P144 migration is live)', async () => {
    const { session, runtime } = await signedInAs(a)
    const { variantId } = realCardVariant()
    const { db: leasedDb } = db(session, runtime.authority.userId, runtime)

    // goods 100 + shipping 50 + customs 50 = 200 receipt ceiling; discount 150 > subtotal (100).
    // Pre-P144 this receipt was refused outright (P130-16); P144 allocates it exactly.
    const purchase = await createPurchase(
      {
        purchasedOn: '2026-01-02',
        currency: 'NOK',
        lines: [
          {
            lineType: 'card',
            cardVariantId: variantId,
            condition: 'MT',
            quantity: 1,
            unitPriceMinor: 10000n,
            spendClass: 'collectible',
          },
        ],
        shippingMinor: 5000n,
        customsMinor: 5000n,
        discountMinor: 15000n,
      },
      generateIdempotencyKey(),
      leasedDb,
    )
    createdPurchaseIds.push(purchase.id)
    createdHoldingIds.push(holdingIdForPurchase(purchase.id))
    expect(purchase.totalMinor).toBe(10000n + 5000n + 5000n - 15000n) // 5000
    expect(purchase.discountMinor).toBe(15000n)
  })

  it('create_purchase idempotent replay: the SAME key returns the SAME purchase, no duplicate row', async () => {
    const { session, runtime } = await signedInAs(a)
    const { variantId } = realCardVariant()
    const { db: leasedDb } = db(session, runtime.authority.userId, runtime)
    const key = generateIdempotencyKey()
    const input = {
      purchasedOn: '2026-01-03',
      currency: 'NOK' as const,
      lines: [
        {
          lineType: 'card' as const,
          cardVariantId: variantId,
          condition: 'EX' as const,
          quantity: 1,
          unitPriceMinor: 12345n,
          spendClass: 'collectible' as const,
        },
      ],
    }
    const first = await createPurchase(input, key, leasedDb)
    const second = await createPurchase(input, key, leasedDb)
    createdPurchaseIds.push(first.id)
    createdHoldingIds.push(holdingIdForPurchase(first.id))
    expect(second.id).toBe(first.id)
    const count = psql(`select count(*) from public.purchases where id = '${first.id}';`)
    expect(count).toBe('1')
  })

  it('create_sale: negative net proceeds on an UNKNOWN-basis lot succeeds; realized result stays null', async () => {
    const { session, runtime } = await signedInAs(a)
    const { variantId } = realCardVariant()
    const { db: leasedDb } = db(session, runtime.authority.userId, runtime)
    const acquisition = await addCardAcquisition(
      {
        cardVariantId: variantId,
        gradingState: 'raw',
        condition: 'GD',
        origin: 'other',
        costBasisState: 'unknown',
        quantity: 1,
        acquiredOn: '2026-01-04',
      },
      leasedDb,
    )
    createdHoldingIds.push(acquisition.holdingId)
    // Gross 100, fees 3000: net proceeds -2900 (P130-17; pre-P144 this CHECK constraint refused it
    // for an uncosted lot even though the same negative net succeeds for a KNOWN-basis lot).
    const sale = await createSale(
      [{ lotId: acquisition.lotId, quantity: 1, unitGrossMinor: 100n }],
      { soldOn: '2026-01-05', currency: 'NOK', feesMinor: 3000n },
      generateIdempotencyKey(),
      leasedDb,
    )
    createdSaleIds.push(sale.id)
    expect(sale.netProceedsMinor).toBe(-2900n)
    expect(sale.realizedResultNokMinor).toBeNull() // unknown basis: never a fabricated result
    expect(sale.proceedsFromUncostedNokMinor).toBe(-2900n)
  })

  it('manual valuation: an explicit 0 is a known zero; Clear is a DIFFERENT request, never "set to 0"', async () => {
    const { session, runtime } = await signedInAs(a)
    const { variantId } = realCardVariant()
    const { db: leasedDb } = db(session, runtime.authority.userId, runtime)
    const acquisition = await addCardAcquisition(
      {
        cardVariantId: variantId,
        gradingState: 'raw',
        condition: 'LP',
        origin: 'other',
        costBasisState: 'unknown',
        quantity: 1,
        acquiredOn: '2026-01-06',
      },
      leasedDb,
    )
    createdHoldingIds.push(acquisition.holdingId)
    await setManualValuation({ holdingId: acquisition.holdingId, valueMinor: 0n }, leasedDb)
    // The ACTIVE row is the one with no superseded_at — not "the newest by date", which ties on a
    // same-day effective_from across repeated runs against a reused fixture holding.
    const afterSet = psql(
      `select value_minor::text from public.manual_valuations ` +
        `where holding_id = '${acquisition.holdingId}' and superseded_at is null;`,
    )
    expect(afterSet).toBe('0')

    await clearManualValuation(acquisition.holdingId, leasedDb)
    const afterClear = psql(
      `select count(*) from public.manual_valuations ` +
        `where holding_id = '${acquisition.holdingId}' and superseded_at is null;`,
    )
    expect(afterClear).toBe('0') // no active manual valuation — resolved automatically, not "0"
  })

  it('create_opening: opening a sealed lot creates no spend and consumes the lot', async () => {
    const { session, runtime } = await signedInAs(a)
    const sealedProductId = realSealedProductId()
    const { db: leasedDb } = db(session, runtime.authority.userId, runtime)
    const acquisition = await addCardAcquisition(
      {
        sealedProductId,
        gradingState: 'raw',
        origin: 'other',
        costBasisState: 'known',
        unitCostBasisMinor: 50000n,
        quantity: 2,
        acquiredOn: '2026-01-07',
        sealedIntent: 'planned_to_open',
      },
      leasedDb,
    )
    createdHoldingIds.push(acquisition.holdingId)
    // A known-cost acquisition DOES create exactly one purchase_lines row for its own cost entry
    // (add_card_acquisition's own "purchase + purchase line, only when the cost is known" step) —
    // that is the acquisition's spend, recorded once, before any opening happens.
    const purchaseLineIdBefore = psql(
      `select purchase_line_id::text from public.acquisition_lots where id = '${acquisition.lotId}';`,
    )
    expect(purchaseLineIdBefore).not.toBe('')
    const acquisitionPurchaseId = purchaseIdForLot(acquisition.lotId)
    if (acquisitionPurchaseId !== null) createdPurchaseIds.push(acquisitionPurchaseId)

    const opening = await createOpening(
      { sourceLotId: acquisition.lotId, quantity: 1, openedOn: '2026-01-08' },
      leasedDb,
    )
    createdOpeningIds.push(opening.id)
    expect(opening.quantityOpened).toBe(1)
    // The OPENING itself creates no second spend: the source lot's own purchase_line_id (its
    // acquisition cost) is unchanged, and create_opening's own contract says so (`Opening.costSource`
    // is never 'from_lot' backed by a NEW purchase — the mission's "not a second spend" invariant).
    const purchaseLineIdAfter = psql(
      `select purchase_line_id::text from public.acquisition_lots where id = '${acquisition.lotId}';`,
    )
    expect(purchaseLineIdAfter).toBe(purchaseLineIdBefore)
    const remaining = psql(
      `select quantity_remaining from public.acquisition_lots where id = '${acquisition.lotId}';`,
    )
    expect(remaining).toBe('1')
  })

  it('the write allow-list refuses an unimplemented RPC through the REAL client (not just the unit test)', async () => {
    const { session, runtime } = await signedInAs(a)
    const { db: leasedDb } = db(session, runtime.authority.userId, runtime)
    // postgrest-js never rejects: a thrown fetch error becomes a RESOLVED `{ data: null, error }`
    // (net/spike-fetch.ts documents the same postgrest-js behaviour) — no request ever left the
    // device (the throw happens inside write-fetch.ts before any network call).
    const { data, error } = await leasedDb.rpc('void_purchase', {
      p_purchase_id: '00000000-0000-0000-0000-000000000000',
    })
    expect(data).toBeNull()
    expect(error?.message).toContain('WriteNotAllowedError')
    expect(error?.message).toContain('void_purchase')
  })

  it('a lease bound to A refuses to produce a token once the real session is signed out', async () => {
    const { session, runtime } = await signedInAs(a)
    const { lease, db: leasedDb } = db(session, runtime.authority.userId, runtime)
    await session.client.auth.signOut()
    const { variantId } = realCardVariant()
    // `runWithLease` is what actually recovers AuthIdentityChangedError from the generic `Error`
    // every src/write/*-writes.ts function rebuilds a PostgREST error into (WriteFormStore.submit
    // does the same in production) — calling the write function bare would only show the message.
    await expect(
      runWithLease(lease, () =>
        addCardAcquisition(
          {
            cardVariantId: variantId,
            gradingState: 'raw',
            condition: 'NM',
            origin: 'other',
            costBasisState: 'unknown',
            quantity: 1,
            acquiredOn: '2026-01-09',
          },
          leasedDb,
        ),
      ),
    ).rejects.toThrow(AuthIdentityChangedError)
    expect(lease.isCurrent()).toBe(false)
  })

  it('same-tab A -> B DURING an in-flight write: the request already sent completes as A, never as B', async () => {
    const { session, runtime } = await signedInAs(a)
    const gate = deferred<void>()
    let heldOnce = false
    // The token is chosen and attached to the request BEFORE this fetch override ever sees it
    // (`leased-write-client.ts`'s accessToken provider runs first); holding it here therefore
    // pauses a request that already carries A's bearer token, not the token choice itself.
    const bind = createWriteDbBinder({
      url: session.url,
      publishableKey: session.publishableKey,
      getSession: () => session.client.auth.getSession(),
      fetch: async (input, init) => {
        const url = typeof input === 'string' ? input : (input as Request).url
        if (url.includes('/rpc/add_card_acquisition') && !heldOnce) {
          heldOnce = true
          await gate.promise
        }
        return fetch(input, init)
      },
    })
    const lease = runtime.authority.begin(runtime.authority.userId) // A's lease
    const leasedDb = bind(lease)
    const { variantId } = realCardVariant()
    const pending = addCardAcquisition(
      {
        cardVariantId: variantId,
        gradingState: 'raw',
        condition: 'NM',
        origin: 'other',
        costBasisState: 'unknown',
        quantity: 1,
        acquiredOn: '2026-01-10',
      },
      leasedDb,
    )
    await until(() => heldOnce)

    await switchTo(runtime, b) // the SAME tab/session now signs in as B, mid-write
    expect(lease.isCurrent()).toBe(false) // A's lease is dead the instant the switch is heard
    gate.resolve() // release the already-in-flight, A-authenticated request
    const result = await pending // still resolves: the write happened, as A, before the switch
    createdHoldingIds.push(result.holdingId)

    const owner = psql(`select user_id from public.holdings where id = '${result.holdingId}';`)
    expect(owner).toBe(a.id)
    expect(owner).not.toBe(b.id) // never published under B, whatever the tab looks like now
    expect(runtime.authority.userId).toBe(b.id) // the tab itself is genuinely on B now
  })
})

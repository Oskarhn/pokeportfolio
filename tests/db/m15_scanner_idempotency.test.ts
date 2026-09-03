/**
 * M15 idempotency DB tests (D-096, P74 §14–§16).
 *
 * Every test calls the actual RPC through PostgREST — no mocking.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  signInAs,
  seedCatalog,
  type TestClient,
  type SyntheticUser,
} from './setup'

let service: TestClient
let userA: SyntheticUser
let clientA: TestClient
let userB: SyntheticUser
let clientB: TestClient

const today = new Date().toISOString().slice(0, 10)

beforeAll(async () => {
  service = createServiceClient()
  userA = await createSyntheticUser(service, 'idempotency_a')
  userB = await createSyntheticUser(service, 'idempotency_b')
  clientA = await signInAs(userA)
  clientB = await signInAs(userB)
}, 30_000)

afterAll(async () => {
  await deleteSyntheticUser(service, userA.id)
  await deleteSyntheticUser(service, userB.id)
})

type AcqResult = { holding_id: string; lot_id: string }

async function addCard(
  client: TestClient,
  opts: {
    cardVariantId?: string
    manualCardId?: string
    sealedProductId?: string
    condition?: string
    gradingState?: string
    grader?: string
    grade?: number
    origin?: string
    costBasisState?: string
    unitCostBasisMinor?: number | null
    quantity?: number
    acquiredOn?: string
    storageLocationId?: string | null
    clientRequestKey?: string | null
  } = {},
): Promise<AcqResult> {
  const usesAlternateIdentity =
    opts.manualCardId !== undefined || opts.sealedProductId !== undefined
  const costBasisState = opts.costBasisState ?? 'unknown'
  const { data, error } = await client
    .rpc('add_card_acquisition', {
      p_card_variant_id: usesAlternateIdentity
        ? undefined
        : (opts.cardVariantId ?? seedCatalog.pikachuVariantId),
      p_grading_state: opts.gradingState ?? 'raw',
      // A graded holding's condition column must stay NULL (holdings_condition_only_for_raw) —
      // only default to 'NM' for the raw-card path.
      p_condition: opts.condition ?? ((opts.gradingState ?? 'raw') === 'graded' ? undefined : 'NM'),
      p_origin: opts.origin ?? 'pre_tracking',
      p_cost_basis_state: costBasisState,
      p_unit_cost_basis_minor: costBasisState === 'known' ? opts.unitCostBasisMinor : undefined,
      p_quantity: opts.quantity ?? 1,
      p_acquired_on: opts.acquiredOn ?? today,
      p_storage_location_id: opts.storageLocationId ?? undefined,
      p_client_request_key: opts.clientRequestKey ?? undefined,
      ...(opts.grader !== undefined ? { p_grader: opts.grader } : {}),
      ...(opts.grade !== undefined ? { p_grade: opts.grade } : {}),
      ...(opts.manualCardId ? { p_manual_card_id: opts.manualCardId } : {}),
      ...(opts.sealedProductId
        ? { p_sealed_product_id: opts.sealedProductId, p_sealed_intent: 'planned_to_open' }
        : {}),
    })
    .single<AcqResult>()
  if (error) throw error
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- data is AcqResult | null; Supabase does not narrow on error check
  return data!
}

describe('I1 sequential same-key replay', () => {
  it('returns identical result on second call with same key', async () => {
    const key = crypto.randomUUID()
    const first = await addCard(clientA, { clientRequestKey: key })
    expect(first.holding_id).toBeTruthy()
    expect(first.lot_id).toBeTruthy()

    const second = await addCard(clientA, { clientRequestKey: key })
    expect(second.holding_id).toBe(first.holding_id)
    expect(second.lot_id).toBe(first.lot_id)

    const { data: lots } = await service
      .from('acquisition_lots')
      .select('id')
      .eq('user_id', userA.id)
      .eq('client_request_key', key)
    expect(lots).toHaveLength(1)
  })
})

describe('I2 concurrent known-cost replay', () => {
  it('two overlapping requests produce exactly one lot, one purchase, one purchase_line', async () => {
    const key = crypto.randomUUID()
    const promises = Array.from({ length: 2 }, () =>
      addCard(clientA, {
        clientRequestKey: key,
        costBasisState: 'known',
        unitCostBasisMinor: 1500,
        quantity: 1,
        origin: 'purchase',
      }),
    )

    const results = await Promise.all(promises)
    expect(results[0]!.holding_id).toBeTruthy()
    expect(results[1]!.holding_id).toBeTruthy()
    expect(results[0]!.holding_id).toBe(results[1]!.holding_id)
    expect(results[0]!.lot_id).toBe(results[1]!.lot_id)

    const { data: lots } = await service
      .from('acquisition_lots')
      .select('id, quantity')
      .eq('user_id', userA.id)
      .eq('client_request_key', key)
    expect(lots).toHaveLength(1)

    const { data: purchases } = await service
      .from('purchases')
      .select('id')
      .eq('user_id', userA.id)
      .eq('purchased_on', today)
    expect(purchases).toHaveLength(1)

    const { data: lines } = await service
      .from('purchase_lines')
      .select('id')
      .eq('user_id', userA.id)
    expect(lines).toHaveLength(1)
  })
})

describe('I3 concurrent unknown-cost replay', () => {
  it('two overlapping requests produce exactly one lot, zero purchases', async () => {
    const key = crypto.randomUUID()
    const promises = Array.from({ length: 2 }, () =>
      addCard(clientA, { clientRequestKey: key, costBasisState: 'unknown', quantity: 1 }),
    )

    const results = await Promise.all(promises)
    expect(results[0]!.holding_id).toBe(results[1]!.holding_id)
    expect(results[0]!.lot_id).toBe(results[1]!.lot_id)

    const { data: lots } = await service
      .from('acquisition_lots')
      .select('id')
      .eq('user_id', userA.id)
      .eq('client_request_key', key)
    expect(lots).toHaveLength(1)
  })
})

describe('I4 response-loss late replay', () => {
  it('returns original result without new rows', async () => {
    const key = crypto.randomUUID()
    const first = await addCard(clientA, {
      clientRequestKey: key,
      origin: 'purchase',
      costBasisState: 'known',
      unitCostBasisMinor: 2000,
      quantity: 1,
    })

    const { count: lotsBefore } = await service
      .from('acquisition_lots')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userA.id)
    const { count: purchasesBefore } = await service
      .from('purchases')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userA.id)

    const replay = await addCard(clientA, {
      clientRequestKey: key,
      origin: 'purchase',
      costBasisState: 'known',
      unitCostBasisMinor: 2000,
      quantity: 1,
    })

    expect(replay.holding_id).toBe(first.holding_id)
    expect(replay.lot_id).toBe(first.lot_id)

    const { count: lotsAfter } = await service
      .from('acquisition_lots')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userA.id)
    const { count: purchasesAfter } = await service
      .from('purchases')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userA.id)

    expect(lotsAfter).toBe(lotsBefore)
    expect(purchasesAfter).toBe(purchasesBefore)
  })
})

describe('I5 cross-user key independence', () => {
  it('same UUID used by user A and user B produces separate lots', async () => {
    const key = crypto.randomUUID()
    const resultA = await addCard(clientA, { clientRequestKey: key })
    const resultB = await addCard(clientB, { clientRequestKey: key })

    expect(resultA.holding_id).not.toBe(resultB.holding_id)
    expect(resultA.lot_id).not.toBe(resultB.lot_id)

    const { data: lotsA } = await service
      .from('acquisition_lots')
      .select('id')
      .eq('user_id', userA.id)
      .eq('client_request_key', key)
    const { data: lotsB } = await service
      .from('acquisition_lots')
      .select('id')
      .eq('user_id', userB.id)
      .eq('client_request_key', key)
    expect(lotsA).toHaveLength(1)
    expect(lotsB).toHaveLength(1)
  })
})

describe('I6 different key same holding creates separate lots', () => {
  it('K1 and K2 for the same card produce two lots on the same holding', async () => {
    const k1 = crypto.randomUUID()
    const k2 = crypto.randomUUID()
    const r1 = await addCard(clientA, { clientRequestKey: k1 })
    const r2 = await addCard(clientA, { clientRequestKey: k2 })

    expect(r1.holding_id).toBe(r2.holding_id)
    expect(r1.lot_id).not.toBe(r2.lot_id)
  })
})

describe('I7 same key different card rejected', () => {
  it('raises when the same key is used with a different card_variant_id', async () => {
    const key = crypto.randomUUID()
    await addCard(clientA, {
      clientRequestKey: key,
      cardVariantId: seedCatalog.pikachuVariantId,
    })

    try {
      await addCard(clientA, {
        clientRequestKey: key,
        cardVariantId: seedCatalog.charizardVariantId,
      })
      expect.fail('should have thrown')
    } catch (e: unknown) {
      expect((e as Error).message).toContain('idempotency-key-reuse')
    }
  })
})

describe('I8 same key different quantity rejected', () => {
  it('raises when the same key is used with a different quantity', async () => {
    const key = crypto.randomUUID()
    await addCard(clientA, { clientRequestKey: key, quantity: 1 })

    try {
      await addCard(clientA, { clientRequestKey: key, quantity: 3 })
      expect.fail('should have thrown')
    } catch (e: unknown) {
      expect((e as Error).message).toContain('idempotency-key-reuse')
    }
  })
})

describe('I9 same key different condition rejected', () => {
  it('raises when the same key is used with a different condition', async () => {
    const key = crypto.randomUUID()
    await addCard(clientA, { clientRequestKey: key, condition: 'NM' })

    try {
      await addCard(clientA, { clientRequestKey: key, condition: 'GD' })
      expect.fail('should have thrown')
    } catch (e: unknown) {
      expect((e as Error).message).toContain('idempotency-key-reuse')
    }
  })
})

describe('I10 same key different origin rejected', () => {
  it('raises when the same key is used with a different origin', async () => {
    const key = crypto.randomUUID()
    await addCard(clientA, { clientRequestKey: key, origin: 'pre_tracking' })

    try {
      await addCard(clientA, { clientRequestKey: key, origin: 'gift' })
      expect.fail('should have thrown')
    } catch (e: unknown) {
      expect((e as Error).message).toContain('idempotency-key-reuse')
    }
  })
})

describe('I11 same key different cost rejected', () => {
  it('raises when the same key is used with different cost', async () => {
    const key = crypto.randomUUID()
    await addCard(clientA, {
      clientRequestKey: key,
      origin: 'purchase',
      costBasisState: 'known',
      unitCostBasisMinor: 1000,
    })

    try {
      await addCard(clientA, {
        clientRequestKey: key,
        origin: 'purchase',
        costBasisState: 'known',
        unitCostBasisMinor: 2000,
      })
      expect.fail('should have thrown')
    } catch (e: unknown) {
      expect((e as Error).message).toContain('idempotency-key-reuse')
    }
  })
})

describe('I12 same key different date rejected', () => {
  it('raises when the same key is used with a different acquired_on', async () => {
    const key = crypto.randomUUID()
    await addCard(clientA, { clientRequestKey: key, acquiredOn: '2026-01-15' })

    try {
      await addCard(clientA, { clientRequestKey: key, acquiredOn: '2026-06-20' })
      expect.fail('should have thrown')
    } catch (e: unknown) {
      expect((e as Error).message).toContain('idempotency-key-reuse')
    }
  })
})

describe('I13 same key different storage rejected', () => {
  it('raises when the same key is used with a different storage_location_id', async () => {
    const { data: loc } = await service
      .from('storage_locations')
      .insert({ user_id: userA.id, name: 'Test Box', kind: 'box', sort_order: 0 })
      .select('id')
      .single()

    const key = crypto.randomUUID()
    await addCard(clientA, { clientRequestKey: key, storageLocationId: loc!.id })

    try {
      await addCard(clientA, { clientRequestKey: key, storageLocationId: null })
      expect.fail('should have thrown')
    } catch (e: unknown) {
      expect((e as Error).message).toContain('idempotency-key-reuse')
    }

    await service.from('storage_locations').delete().eq('id', loc!.id)
  })
})

describe('I14 voided lot stale retry rejected', () => {
  it('raises when the keyed lot was later voided', async () => {
    const key = crypto.randomUUID()
    const { lot_id } = await addCard(clientA, { clientRequestKey: key })

    const { error: voidErr } = await clientA.rpc('void_acquisition_lot', {
      p_lot_id: lot_id,
      p_reason: 'test void',
    })
    expect(voidErr).toBeNull()

    try {
      await addCard(clientA, { clientRequestKey: key })
      expect.fail('should have thrown')
    } catch (e: unknown) {
      expect((e as Error).message).toContain('idempotency-key-reuse')
    }
  })
})

describe('I15 NULL-key legacy behavior unchanged', () => {
  it('calling without a key creates a new lot every time', async () => {
    const first = await addCard(clientA, { clientRequestKey: null })
    const second = await addCard(clientA, { clientRequestKey: null })

    expect(first.holding_id).toBe(second.holding_id)
    expect(first.lot_id).not.toBe(second.lot_id)
  })
})

describe('I16 reset removes old key and allows clean reuse', () => {
  it('after reset, the same UUID key can be reused for a new acquisition', async () => {
    const key = crypto.randomUUID()
    const first = await addCard(clientA, { clientRequestKey: key })

    const { error: resetErr } = await clientA.rpc('reset_my_portfolio_data')
    expect(resetErr).toBeNull()

    const second = await addCard(clientA, { clientRequestKey: key })
    expect(second.holding_id).toBeTruthy()
    expect(second.lot_id).toBeTruthy()
    expect(second.lot_id).not.toBe(first.lot_id)
  })
})

describe('I17 manual-card path idempotency', () => {
  it('same key with same manual card returns original', async () => {
    const { data: manualCard } = await service
      .from('manual_card_definitions')
      .insert({
        user_id: userA.id,
        name: 'Test Manual Card',
        set_name: 'Custom',
        collector_number: 'M001',
        language: 'en',
        finish: 'normal',
      })
      .select('id')
      .single()

    const key = crypto.randomUUID()
    const first = await addCard(clientA, {
      clientRequestKey: key,
      manualCardId: manualCard!.id,
      gradingState: 'raw',
      condition: 'NM',
    })

    const second = await addCard(clientA, {
      clientRequestKey: key,
      manualCardId: manualCard!.id,
      gradingState: 'raw',
      condition: 'NM',
    })

    expect(second.holding_id).toBe(first.holding_id)
    expect(second.lot_id).toBe(first.lot_id)

    await service.from('manual_card_definitions').delete().eq('id', manualCard!.id)
  })
})

describe('I18 card-variant path idempotency', () => {
  it('same key with same card variant returns original', async () => {
    const key = crypto.randomUUID()
    const first = await addCard(clientA, {
      clientRequestKey: key,
      cardVariantId: seedCatalog.pikachuVariantId,
    })

    const second = await addCard(clientA, {
      clientRequestKey: key,
      cardVariantId: seedCatalog.pikachuVariantId,
    })

    expect(second.holding_id).toBe(first.holding_id)
    expect(second.lot_id).toBe(first.lot_id)
  })
})

describe('I19 sealed path idempotency', () => {
  it('same key with same sealed product returns original', async () => {
    const key = crypto.randomUUID()
    const first = await addCard(clientA, {
      clientRequestKey: key,
      sealedProductId: seedCatalog.sealedProductId,
    })

    const second = await addCard(clientA, {
      clientRequestKey: key,
      sealedProductId: seedCatalog.sealedProductId,
    })

    expect(second.holding_id).toBe(first.holding_id)
    expect(second.lot_id).toBe(first.lot_id)
  })
})

describe('I20 unknown cost stays NULL never zero', () => {
  it('replay with unknown cost does not fabricate a zero cost', async () => {
    const key = crypto.randomUUID()
    await addCard(clientA, { clientRequestKey: key, costBasisState: 'unknown' })

    const { data: lots } = await service
      .from('acquisition_lots')
      .select('unit_cost_basis_minor, cost_basis_state')
      .eq('user_id', userA.id)
      .eq('client_request_key', key)
    expect(lots).toHaveLength(1)
    expect(lots![0]!.unit_cost_basis_minor).toBeNull()
    expect(lots![0]!.cost_basis_state).toBe('unknown')
  })
})

describe('I21 manual valuation not duplicated on replay', () => {
  it('replay does not insert a second valuation', async () => {
    const key = crypto.randomUUID()
    const first = await addCard(clientA, {
      clientRequestKey: key,
      gradingState: 'graded',
      grader: 'psa',
      grade: 9,
    })

    const { data: holding } = await service
      .from('holdings')
      .select('id')
      .eq('id', first.holding_id)
      .single()

    await clientA.rpc('set_manual_valuation', {
      p_holding_id: holding!.id,
      p_value_minor: 5000,
      p_currency: 'NOK',
      p_effective_from: today,
    })

    const { count: valBefore } = await service
      .from('manual_valuations')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userA.id)
      .eq('holding_id', holding!.id)

    const replay = await addCard(clientA, {
      clientRequestKey: key,
      gradingState: 'graded',
      grader: 'psa',
      grade: 9,
    })

    expect(replay.lot_id).toBe(first.lot_id)

    const { count: valAfter } = await service
      .from('manual_valuations')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userA.id)
      .eq('holding_id', holding!.id)

    expect(valAfter).toBe(valBefore)
  })
})

// P94 F-21: same shape as I7-I13, but for the two material fields those cases never covered —
// grader and grade. The sequential replay path's material-equivalence check already covers both
// (checkpoint-identity.ts §7 / the migration's own `coalesce(grader_to_text(...))`/`coalesce(grade, -1)`
// predicate), but no test previously exercised either — a genuine coverage gap this closes.
describe('I22 same key different grader rejected', () => {
  it('raises when the same key is used with a different grader (grade unchanged)', async () => {
    const key = crypto.randomUUID()
    await addCard(clientA, {
      clientRequestKey: key,
      gradingState: 'graded',
      grader: 'psa',
      grade: 9,
    })

    try {
      await addCard(clientA, {
        clientRequestKey: key,
        gradingState: 'graded',
        grader: 'bgs',
        grade: 9,
      })
      expect.fail('should have thrown')
    } catch (e: unknown) {
      expect((e as Error).message).toContain('idempotency-key-reuse')
    }

    const { data: lots } = await service
      .from('acquisition_lots')
      .select('id')
      .eq('user_id', userA.id)
      .eq('client_request_key', key)
    expect(lots).toHaveLength(1)
  })
})

describe('I23 same key different grade rejected', () => {
  it('raises when the same key is used with a different grade (grader unchanged)', async () => {
    const key = crypto.randomUUID()
    await addCard(clientA, {
      clientRequestKey: key,
      gradingState: 'graded',
      grader: 'psa',
      grade: 9,
    })

    try {
      await addCard(clientA, {
        clientRequestKey: key,
        gradingState: 'graded',
        grader: 'psa',
        grade: 10,
      })
      expect.fail('should have thrown')
    } catch (e: unknown) {
      expect((e as Error).message).toContain('idempotency-key-reuse')
    }

    const { data: lots } = await service
      .from('acquisition_lots')
      .select('id')
      .eq('user_id', userA.id)
      .eq('client_request_key', key)
    expect(lots).toHaveLength(1)
  })

  it('an EXACT grader+grade replay still returns the same lot (positive control for I22/I23)', async () => {
    const key = crypto.randomUUID()
    const first = await addCard(clientA, {
      clientRequestKey: key,
      gradingState: 'graded',
      grader: 'psa',
      grade: 9,
    })

    const replay = await addCard(clientA, {
      clientRequestKey: key,
      gradingState: 'graded',
      grader: 'psa',
      grade: 9,
    })

    expect(replay.holding_id).toBe(first.holding_id)
    expect(replay.lot_id).toBe(first.lot_id)
  })
})

// P94 F-20: the race-path (unique_violation exception handler) must apply the SAME voided_at and
// material-equivalence checks the sequential early-check path already does.
//
// ON DETERMINISM: this migration's own header explains WHY a client-orchestrated test cannot
// reliably force the exact vulnerable interleaving (winner commits -> gets voided -> loser's
// exception-handler SELECT runs) — that window sits between two adjacent statements inside a
// single PL/pgSQL execution with no client-observable pause point in between; a client-issued
// void() call is a real network round trip competing against a pure in-process continuation with
// no round trip at all, so it cannot be relied on to land inside that window. Rather than assert
// a specific interleaving under a timing lottery (explicitly disallowed by this prompt), two
// behavioral DB tests here plus one source-level test (in
// tests/data/scanner-idempotency-migration-source.test.ts, which needs no live database at all)
// together cover the fix:
//   1. `concurrent replay against an ALREADY-voided key` — a real regression test proving the
//      end-to-end user-visible behavior (concurrent replay attempts against a voided key must ALL
//      be rejected) holds under real concurrency, even though in THIS specific shape (the row
//      already exists before either call starts) both calls are expected to take the early path.
//   2. `two brand-new concurrent inserts still converge to exactly one lot` — re-confirms (I2's own
//      proven shape) that this migration's edit did not regress the exception handler's NORMAL
//      (non-voided) convergence behavior, which the fix's replacement body depends on unchanged.
//   3. (separate file) asserts the MIGRATION SOURCE's exception-handler block specifically (not
//      just the early-check block) contains the voided_at guard — a source-level, not behavioral,
//      proof, but the one deterministic way available here to pin that the exception handler
//      branch carries the fix and catch a future edit that drops it back out of just that branch.
describe('F-20 concurrent race-path void consistency', () => {
  it('concurrent replay attempts against an ALREADY-voided key are all rejected (real regression test)', async () => {
    const key = crypto.randomUUID()
    const { lot_id } = await addCard(clientA, { clientRequestKey: key })

    const { error: voidErr } = await clientA.rpc('void_acquisition_lot', {
      p_lot_id: lot_id,
      p_reason: 'F-20 regression: void before concurrent replay wave',
    })
    expect(voidErr).toBeNull()

    const results = await Promise.allSettled([
      addCard(clientA, { clientRequestKey: key }),
      addCard(clientA, { clientRequestKey: key }),
    ])

    for (const result of results) {
      expect(result.status).toBe('rejected')
      if (result.status === 'rejected') {
        expect((result.reason as Error).message).toContain('idempotency-key-reuse')
      }
    }

    const { data: lots } = await service
      .from('acquisition_lots')
      .select('id, voided_at')
      .eq('user_id', userA.id)
      .eq('client_request_key', key)
    expect(lots).toHaveLength(1)
    expect(lots![0]!.voided_at).not.toBeNull()
  })

  it('two brand-new concurrent inserts for the same key still converge to exactly one lot (I2 shape, post-fix non-regression)', async () => {
    const key = crypto.randomUUID()
    const results = await Promise.all([
      addCard(clientA, { clientRequestKey: key }),
      addCard(clientA, { clientRequestKey: key }),
    ])
    expect(results[0].lot_id).toBe(results[1].lot_id)

    const { data: lots } = await service
      .from('acquisition_lots')
      .select('id')
      .eq('user_id', userA.id)
      .eq('client_request_key', key)
    expect(lots).toHaveLength(1)
  })
})

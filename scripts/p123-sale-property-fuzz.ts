/**
 * P123 §7-11 — real-database sale property fuzz + invalid-case fuzz. P120 explicitly left this
 * unbuilt (its own output disclosed sales property fuzz as NOT done). This is the first
 * randomized, independent-oracle property campaign to exercise `create_sale` end to end against
 * the live database.
 *
 * Scope of this run (see ai_outputs output_123.txt for the honest accounting): NOK-only sales
 * (fx_rate=1 exactly, so no numeric-rounding ambiguity is mixed into the fee/shipping/basis
 * assertions below — FX rounding gets its own dedicated campaign, not run this session), no
 * `lot_cost_adjustments` seeded (adjustment allocation is already covered by existing DB tests;
 * this fuzzer isolates create_sale's OWN arithmetic). Both dimensions are real gaps still open
 * after this run, stated plainly rather than silently assumed covered.
 *
 * Independent oracle: for each accepted sale, recomputes gross/net/allocated fees/shipping and
 * realized result in plain TypeScript BigInt arithmetic, reusing `src/domain/allocation.ts`'s
 * `allocate`/`allocateSigned` (the same from-scratch largest-remainder port D-125/D-127 already
 * validated independently) — never the plpgsql source. Known-basis lots use the lot's OWN
 * `unit_cost_basis_nok_minor`/`residual_nok_minor` as recorded by an earlier real `create_purchase`
 * call (purchase correctness is P120's own property fuzz's job, not re-proven here); unknown-basis
 * lots are created via `add_card_acquisition(p_origin => 'pre_tracking', p_cost_basis_state =>
 * 'unknown')` and must never receive a realized result.
 *
 * Usage: pnpm exec tsx scripts/p123-sale-property-fuzz.ts [validCaseCount] [invalidCaseCount]
 */
import fc from 'fast-check'
import { allocate, allocateSigned } from '../src/domain/allocation'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  seedCatalog,
  signInAs,
  type TestClient,
} from '../tests/db/setup'

const VALID_CASE_COUNT = Number(process.argv[2] ?? 500)
const INVALID_CASE_COUNT = Number(process.argv[3] ?? 500)
const today = new Date().toISOString().slice(0, 10)

const cardVariants = [
  seedCatalog.charizardVariantId,
  seedCatalog.charizardShadowlessFirstEditionVariantId,
  seedCatalog.pikachuVariantId,
  seedCatalog.grassEnergyVariantId,
  seedCatalog.japaneseVariantId,
]

interface ErrorLike {
  message: string
}

/** Unwraps a Supabase `.single<T>()` result, throwing on error (never on a legitimately-typed T). */
function mustSingle<T>(context: string, result: { data: T | null; error: ErrorLike | null }): T {
  if (result.error) throw new Error(`${context}: ${result.error.message}`)
  if (result.data === null) throw new Error(`${context}: no row returned`)
  return result.data
}

/** Indexes an array with a runtime bounds check instead of a `noUncheckedIndexedAccess` cast. */
function nth<T>(arr: readonly T[], i: number, context: string): T {
  const v = arr[i]
  if (v === undefined)
    throw new Error(`${context}: index ${i} out of bounds (length ${arr.length})`)
  return v
}

interface ResultLike<T> {
  data: T | null
  error: ErrorLike | null
}
/**
 * Re-types a Supabase query result as `{data: T | null; error: ErrorLike | null}` explicitly.
 * Some builder call shapes here (`.single<T>()` combined with `.overrideTypes()`) resolve to an
 * overload where TS infers `error` as always `null`, which is not true at runtime (a genuine
 * PostgREST/RPC error still lands in `error`) — this sidesteps that inference gap the same way
 * P120's `mustSingle` does, without throwing (callers here need to inspect the error, not just
 * fail on it).
 */
function asResult<T>(r: ResultLike<T>): ResultLike<T> {
  return r
}

interface SourceLotSpec {
  variantId: string
  quantity: number
  unitPriceMinor: number
  basis: 'known' | 'unknown'
  sellQuantity: number
}

const sourceLotArb: fc.Arbitrary<SourceLotSpec> = fc
  .record({
    variantId: fc.constantFrom(...cardVariants),
    quantity: fc.integer({ min: 1, max: 15 }),
    unitPriceMinor: fc.integer({ min: 0, max: 2_000_000 }),
    basis: fc.constantFrom<'known' | 'unknown'>('known', 'known', 'known', 'unknown'),
  })
  .chain((base) =>
    fc.integer({ min: 1, max: base.quantity }).map((sellQuantity) => ({ ...base, sellQuantity })),
  )

interface SaleSample {
  lots: SourceLotSpec[]
  feesMinor: number
  shippingCostMinor: number
  shippingChargedMinor: number
  marketplace: string | undefined
  notes: string | undefined
}

const saleArb: fc.Arbitrary<SaleSample> = fc.record({
  lots: fc.array(sourceLotArb, { minLength: 1, maxLength: 4 }),
  feesMinor: fc.integer({ min: 0, max: 200_000 }),
  shippingCostMinor: fc.integer({ min: 0, max: 100_000 }),
  shippingChargedMinor: fc.integer({ min: 0, max: 100_000 }),
  marketplace: fc.option(fc.constantFrom('eBay', 'TCGplayer', 'Cardmarket', 'Local'), {
    nil: undefined,
  }),
  notes: fc.option(fc.string({ maxLength: 80 }), { nil: undefined }),
})

interface Failure {
  seed: number
  case: unknown
  reason: string
}
const failures: Failure[] = []
let validated = 0

interface SourceLot {
  lotId: string
  unitCostBasisNokMinor: bigint | null
  residualNokMinor: bigint
}

async function createSourceLot(
  clientA: TestClient,
  service: TestClient,
  spec: SourceLotSpec,
): Promise<SourceLot> {
  if (spec.basis === 'known') {
    const purchase = mustSingle(
      'source purchase',
      await clientA
        .rpc('create_purchase', {
          p_purchased_on: today,
          p_currency: 'NOK',
          p_lines: [
            {
              line_type: 'card',
              card_variant_id: spec.variantId,
              condition: 'NM',
              quantity: spec.quantity,
              unit_price_minor: spec.unitPriceMinor,
            },
          ],
        })
        .single<{ id: string }>(),
    )
    const line = mustSingle(
      'source line fetch',
      await service.from('purchase_lines').select('id').eq('purchase_id', purchase.id).single<{
        id: string
      }>(),
    )
    const lot = mustSingle(
      'source lot fetch',
      await service
        .from('acquisition_lots')
        .select('id, unit_cost_basis_nok_minor, residual_nok_minor')
        .eq('purchase_line_id', line.id)
        .single<{
          id: string
          unit_cost_basis_nok_minor: string
          residual_nok_minor: string | null
        }>(),
    )
    return {
      lotId: lot.id,
      unitCostBasisNokMinor: BigInt(lot.unit_cost_basis_nok_minor),
      residualNokMinor: BigInt(lot.residual_nok_minor ?? '0'),
    }
  }

  const result = mustSingle(
    'gift/pre_tracking acquisition',
    await clientA
      .rpc('add_card_acquisition', {
        p_card_variant_id: spec.variantId,
        p_condition: 'NM',
        p_origin: 'pre_tracking',
        p_cost_basis_state: 'unknown',
        p_quantity: spec.quantity,
        p_acquired_on: today,
      })
      .single<{ holding_id: string; lot_id: string }>(),
  )
  return { lotId: result.lot_id, unitCostBasisNokMinor: null, residualNokMinor: 0n }
}

async function runOneCase(
  clientA: TestClient,
  service: TestClient,
  sample: SaleSample,
  seed: number,
) {
  // Independent oracle inputs, computed BEFORE touching the database as a pure function of each
  // line's own spec (never by indexing a second array by position) so an out-of-domain case (net
  // proceeds would go negative — `create_sale` correctly rejects that via
  // `sales_amounts_non_negative`, a real business rule, not a defect) can be discarded with
  // fc.pre() before any real lots are created for it.
  const saleUnitGrossFor = (s: SourceLotSpec) => BigInt(Math.min(s.unitPriceMinor + 500, 3_000_000)) // sale price independent of cost basis, deliberately can be above/below/equal to it
  const lineGrossFor = (s: SourceLotSpec) => saleUnitGrossFor(s) * BigInt(s.sellQuantity)
  const gross = sample.lots.reduce((a, s) => a + lineGrossFor(s), 0n)
  const fees = BigInt(sample.feesMinor)
  const shipCost = BigInt(sample.shippingCostMinor)
  const shipCharged = BigInt(sample.shippingChargedMinor)
  const net = gross - fees - shipCost + shipCharged
  const netNok = net // NOK sale, fx_rate = 1 exactly

  fc.pre(net >= 0n)

  // Sequential, not Promise.all: concurrent create_purchase/add_card_acquisition calls under the
  // SAME user can lock-order-deadlock against each other (a harness artifact of setting up several
  // source lots at once, not something this campaign is testing — real users create lots one at a
  // time across separate sessions). Zipped into one array as it's built, never indexed against
  // `sample.lots` afterward.
  interface PerLine {
    spec: SourceLotSpec
    source: SourceLot
    unitGross: bigint
    lineGross: bigint
  }
  const perLine: PerLine[] = []
  for (const spec of sample.lots) {
    const source = await createSourceLot(clientA, service, spec)
    perLine.push({ spec, source, unitGross: saleUnitGrossFor(spec), lineGross: lineGrossFor(spec) })
  }

  const p_lines = perLine.map(({ spec, source, unitGross }) => ({
    lot_id: source.lotId,
    quantity: spec.sellQuantity,
    unit_gross_minor: unitGross.toString(),
  }))

  const { data: sale, error } = asResult(
    await clientA
      .rpc('create_sale', {
        p_sold_on: today,
        p_currency: 'NOK',
        p_lines,
        p_idempotency_key: crypto.randomUUID(),
        p_marketplace: sample.marketplace ?? null,
        p_fees_minor: sample.feesMinor,
        p_shipping_cost_minor: sample.shippingCostMinor,
        p_shipping_charged_minor: sample.shippingChargedMinor,
        p_notes: sample.notes ?? null,
      })
      .single<{
        id: string
        gross_minor: string
        net_proceeds_minor: string
        net_proceeds_nok_minor: string
        realized_result_nok_minor: string | null
        proceeds_from_uncosted_nok_minor: string
      }>(),
  )

  if (error !== null || sale === null) {
    failures.push({ seed, case: sample, reason: `create_sale errored: ${error?.message}` })
    return
  }

  if (BigInt(sale.gross_minor) !== gross) {
    failures.push({
      seed,
      case: sample,
      reason: `gross_minor: got ${sale.gross_minor}, want ${gross}`,
    })
  }
  if (BigInt(sale.net_proceeds_minor) !== net) {
    failures.push({
      seed,
      case: sample,
      reason: `net_proceeds_minor: got ${sale.net_proceeds_minor}, want ${net}`,
    })
  }
  if (BigInt(sale.net_proceeds_nok_minor) !== netNok) {
    failures.push({
      seed,
      case: sample,
      reason: `net_proceeds_nok_minor: got ${sale.net_proceeds_nok_minor}, want ${netNok}`,
    })
  }

  const lineGrossArr = perLine.map((l) => l.lineGross)
  const allocFeesArr = allocate(fees, lineGrossArr)
  const allocShipArr = allocate(shipCost, lineGrossArr)
  const allocShipChargedArr = allocate(shipCharged, lineGrossArr)
  const lineNetNokArr = allocateSigned(netNok, lineGrossArr)

  interface ExpectedLine {
    lotId: string
    lineGross: bigint
    allocFees: bigint
    allocShip: bigint
    allocShipCharged: bigint
    lineNetNok: bigint
    realized: bigint | null
  }
  const expectedLines: ExpectedLine[] = perLine.map((l, i) => {
    const allocFees = nth(allocFeesArr, i, 'allocFeesArr')
    const allocShip = nth(allocShipArr, i, 'allocShipArr')
    const allocShipCharged = nth(allocShipChargedArr, i, 'allocShipChargedArr')
    const lineNetNok = nth(lineNetNokArr, i, 'lineNetNokArr')
    let realized: bigint | null = null
    if (l.source.unitCostBasisNokMinor !== null) {
      const exhausts = l.spec.sellQuantity === l.spec.quantity
      let basis = l.source.unitCostBasisNokMinor * BigInt(l.spec.sellQuantity)
      if (exhausts) basis += l.source.residualNokMinor
      realized = lineNetNok - basis
    }
    return {
      lotId: l.source.lotId,
      lineGross: l.lineGross,
      allocFees,
      allocShip,
      allocShipCharged,
      lineNetNok,
      realized,
    }
  })

  let realizedSum = 0n
  let hasKnown = false
  let uncostedSum = 0n
  for (const line of expectedLines) {
    if (line.realized !== null) {
      realizedSum += line.realized
      hasKnown = true
    } else {
      uncostedSum += line.lineNetNok
    }
  }
  const expectedSaleRealized = hasKnown ? realizedSum : null

  if (expectedSaleRealized === null) {
    if (sale.realized_result_nok_minor !== null) {
      failures.push({
        seed,
        case: sample,
        reason: `realized_result_nok_minor should be NULL (all-unknown sale) but got ${sale.realized_result_nok_minor}`,
      })
    }
  } else if (
    sale.realized_result_nok_minor === null ||
    BigInt(sale.realized_result_nok_minor) !== expectedSaleRealized
  ) {
    failures.push({
      seed,
      case: sample,
      reason: `realized_result_nok_minor: got ${sale.realized_result_nok_minor}, want ${expectedSaleRealized}`,
    })
  }
  if (BigInt(sale.proceeds_from_uncosted_nok_minor) !== uncostedSum) {
    failures.push({
      seed,
      case: sample,
      reason: `proceeds_from_uncosted_nok_minor: got ${sale.proceeds_from_uncosted_nok_minor}, want ${uncostedSum}`,
    })
  }

  interface DbSaleLine {
    lot_id: string
    line_gross_minor: string
    allocated_fees_minor: string
    allocated_shipping_minor: string
    allocated_shipping_charged_minor: string
    net_proceeds_nok_minor: string
    cost_basis_at_sale_nok_minor: string | null
    realized_result_nok_minor: string | null
  }
  const { data: dbLines, error: linesError } = asResult(
    await service
      .from('sale_lines')
      .select(
        'lot_id, line_gross_minor, allocated_fees_minor, allocated_shipping_minor, allocated_shipping_charged_minor, net_proceeds_nok_minor, cost_basis_at_sale_nok_minor, realized_result_nok_minor',
      )
      .eq('sale_id', sale.id)
      .overrideTypes<DbSaleLine[], { merge: false }>(),
  )
  if (linesError !== null || dbLines === null) {
    failures.push({
      seed,
      case: sample,
      reason: `sale_lines fetch failed: ${linesError?.message}`,
    })
    return
  }
  const dbByLot = new Map(dbLines.map((l) => [l.lot_id, l]))

  for (const [i, expected] of expectedLines.entries()) {
    const dbLine = dbByLot.get(expected.lotId)
    if (dbLine === undefined) {
      failures.push({ seed, case: sample, reason: `no sale_line row for lot ${expected.lotId}` })
      continue
    }
    if (BigInt(dbLine.line_gross_minor) !== expected.lineGross) {
      failures.push({ seed, case: sample, reason: `line ${i} line_gross_minor mismatch` })
    }
    if (BigInt(dbLine.allocated_fees_minor) !== expected.allocFees) {
      failures.push({ seed, case: sample, reason: `line ${i} allocated_fees_minor mismatch` })
    }
    if (BigInt(dbLine.allocated_shipping_minor) !== expected.allocShip) {
      failures.push({ seed, case: sample, reason: `line ${i} allocated_shipping_minor mismatch` })
    }
    if (BigInt(dbLine.allocated_shipping_charged_minor) !== expected.allocShipCharged) {
      failures.push({
        seed,
        case: sample,
        reason: `line ${i} allocated_shipping_charged_minor mismatch`,
      })
    }
    if (expected.realized === null) {
      if (
        dbLine.realized_result_nok_minor !== null ||
        dbLine.cost_basis_at_sale_nok_minor !== null
      ) {
        failures.push({
          seed,
          case: sample,
          reason: `line ${i} should have NULL basis/realized (unknown basis) but got basis=${dbLine.cost_basis_at_sale_nok_minor} realized=${dbLine.realized_result_nok_minor}`,
        })
      }
    } else if (
      dbLine.realized_result_nok_minor === null ||
      BigInt(dbLine.realized_result_nok_minor) !== expected.realized
    ) {
      failures.push({
        seed,
        case: sample,
        reason: `line ${i} realized_result_nok_minor: got ${dbLine.realized_result_nok_minor}, want ${expected.realized}`,
      })
    }
  }

  // Conservation: every sold lot's quantity_remaining decreased by exactly the sold quantity, never
  // negative.
  interface DbLot {
    id: string
    quantity: number
    quantity_remaining: number
  }
  const { data: dbLots, error: lotsError } = asResult(
    await service
      .from('acquisition_lots')
      .select('id, quantity, quantity_remaining')
      .in(
        'id',
        perLine.map((l) => l.source.lotId),
      )
      .overrideTypes<DbLot[], { merge: false }>(),
  )
  if (lotsError !== null || dbLots === null) {
    failures.push({ seed, case: sample, reason: `lots re-fetch failed: ${lotsError?.message}` })
    return
  }
  for (const line of perLine) {
    const lot = dbLots.find((l) => l.id === line.source.lotId)
    if (lot === undefined) {
      failures.push({ seed, case: sample, reason: `lot ${line.source.lotId} vanished after sale` })
      continue
    }
    const expectedRemaining = line.spec.quantity - line.spec.sellQuantity
    if (lot.quantity_remaining !== expectedRemaining) {
      failures.push({
        seed,
        case: sample,
        reason: `lot ${lot.id} quantity_remaining: got ${lot.quantity_remaining}, want ${expectedRemaining}`,
      })
    }
    if (lot.quantity_remaining < 0) {
      failures.push({ seed, case: sample, reason: `lot ${lot.id} went negative` })
    }
  }

  validated++
}

async function runValidCampaign(clientA: TestClient, service: TestClient) {
  let seed = 0
  await fc.assert(
    fc.asyncProperty(saleArb, async (sample) => {
      seed++
      await runOneCase(clientA, service, sample, seed)
    }),
    { numRuns: VALID_CASE_COUNT, seed: 123123 },
  )
  console.log(
    `Valid campaign: validated ${validated}/${VALID_CASE_COUNT} cases. Failures: ${failures.length}`,
  )
  if (failures.length > 0) {
    console.log(JSON.stringify(failures.slice(0, 15), null, 2))
  }
}

interface InvalidResult {
  label: string
  attempted: number
  correctlyRejected: number
  unexpected: { label: string; detail: string }[]
}

async function attemptSale(
  clientA: TestClient,
  results: InvalidResult[],
  label: string,
  args: Record<string, unknown>,
  expectSubstring: string,
  n = 1,
) {
  let correctlyRejected = 0
  const unexpected: { label: string; detail: string }[] = []
  for (let i = 0; i < n; i++) {
    const { data, error } = await clientA
      .rpc('create_sale', {
        p_sold_on: today,
        p_currency: 'NOK',
        p_idempotency_key: crypto.randomUUID(),
        ...args,
      })
      .single()
    if (error !== null && error.message.toLowerCase().includes(expectSubstring.toLowerCase())) {
      correctlyRejected++
    } else if (error !== null) {
      unexpected.push({ label, detail: `rejected but wrong reason: ${error.message}` })
    } else {
      unexpected.push({ label, detail: `ACCEPTED (no error) — data=${JSON.stringify(data)}` })
    }
  }
  results.push({ label, attempted: n, correctlyRejected, unexpected })
}

async function createPlainLot(
  clientA: TestClient,
  service: TestClient,
  variantId: string,
  quantity: number,
  unitPriceMinor: number,
): Promise<string> {
  const purchase = mustSingle(
    'plain-lot purchase',
    await clientA
      .rpc('create_purchase', {
        p_purchased_on: today,
        p_currency: 'NOK',
        p_lines: [
          {
            line_type: 'card',
            card_variant_id: variantId,
            condition: 'NM',
            quantity,
            unit_price_minor: unitPriceMinor,
          },
        ],
      })
      .single<{ id: string }>(),
  )
  const line = mustSingle(
    'plain-lot line fetch',
    await service.from('purchase_lines').select('id').eq('purchase_id', purchase.id).single<{
      id: string
    }>(),
  )
  const lot = mustSingle(
    'plain-lot fetch',
    await service.from('acquisition_lots').select('id').eq('purchase_line_id', line.id).single<{
      id: string
    }>(),
  )
  return lot.id
}

async function runInvalidCampaign(
  clientA: TestClient,
  clientB: TestClient,
  service: TestClient,
): Promise<InvalidResult[]> {
  const results: InvalidResult[] = []

  const lotAId = await createPlainLot(clientA, service, seedCatalog.charizardVariantId, 5, 100_000)
  const lotBId = await createPlainLot(clientB, service, seedCatalog.pikachuVariantId, 2, 50_000)

  await attemptSale(
    clientA,
    results,
    'oversell (6 of 5 remaining)',
    { p_lines: [{ lot_id: lotAId, quantity: 6, unit_gross_minor: '1000' }] },
    'remain available',
  )
  await attemptSale(
    clientA,
    results,
    'zero quantity',
    { p_lines: [{ lot_id: lotAId, quantity: 0, unit_gross_minor: '1000' }] },
    'positive integer',
  )
  await attemptSale(
    clientA,
    results,
    'negative quantity',
    { p_lines: [{ lot_id: lotAId, quantity: -1, unit_gross_minor: '1000' }] },
    'positive integer',
  )
  await attemptSale(
    clientA,
    results,
    'foreign user lot',
    { p_lines: [{ lot_id: lotBId, quantity: 1, unit_gross_minor: '1000' }] },
    'unavailable',
  )
  await attemptSale(
    clientA,
    results,
    'missing lot',
    {
      p_lines: [
        { lot_id: '00000000-0000-0000-0000-000000000000', quantity: 1, unit_gross_minor: '1000' },
      ],
    },
    'unavailable',
  )
  await attemptSale(
    clientA,
    results,
    'duplicate lot lines summing over available',
    {
      p_lines: [
        { lot_id: lotAId, quantity: 3, unit_gross_minor: '1000' },
        { lot_id: lotAId, quantity: 3, unit_gross_minor: '1000' },
      ],
    },
    'referenced more than once',
  )
  await attemptSale(
    clientA,
    results,
    'invalid currency',
    {
      p_currency: 'nok',
      p_lines: [{ lot_id: lotAId, quantity: 1, unit_gross_minor: '1000' }],
    },
    'ISO 4217',
  )
  await attemptSale(
    clientA,
    results,
    'negative unit_gross_minor',
    { p_lines: [{ lot_id: lotAId, quantity: 1, unit_gross_minor: '-1' }] },
    'non-negative',
  )
  await attemptSale(
    clientA,
    results,
    'negative fees',
    {
      p_fees_minor: -1,
      p_lines: [{ lot_id: lotAId, quantity: 1, unit_gross_minor: '1000' }],
    },
    'non-negative',
  )
  await attemptSale(clientA, results, 'zero lines', { p_lines: [] }, 'at least one line')

  // Repeat the oversell/zero/negative/duplicate matrix N times each with fresh lots so the total
  // reaches a real, reported scale rather than one shot per class.
  const REPEATS = Math.max(0, Math.floor((INVALID_CASE_COUNT - results.length) / 4))
  for (let i = 0; i < REPEATS; i++) {
    const lotId = await createPlainLot(
      clientA,
      service,
      nth(cardVariants, i % cardVariants.length, 'cardVariants'),
      3,
      10_000 + i,
    )

    await attemptSale(
      clientA,
      results,
      `repeat[${i}] oversell`,
      { p_lines: [{ lot_id: lotId, quantity: 4, unit_gross_minor: '1000' }] },
      'remain available',
    )
    await attemptSale(
      clientA,
      results,
      `repeat[${i}] zero quantity`,
      { p_lines: [{ lot_id: lotId, quantity: 0, unit_gross_minor: '1000' }] },
      'positive integer',
    )
    await attemptSale(
      clientA,
      results,
      `repeat[${i}] negative quantity`,
      { p_lines: [{ lot_id: lotId, quantity: -1, unit_gross_minor: '1000' }] },
      'positive integer',
    )
    await attemptSale(
      clientA,
      results,
      `repeat[${i}] duplicate lines`,
      {
        p_lines: [
          { lot_id: lotId, quantity: 1, unit_gross_minor: '1000' },
          { lot_id: lotId, quantity: 1, unit_gross_minor: '1000' },
        ],
      },
      'referenced more than once',
    )
  }

  return results
}

async function main() {
  const service = createServiceClient()
  const userA = await createSyntheticUser(service, 'p123-sale-fuzz-a')
  const userB = await createSyntheticUser(service, 'p123-sale-fuzz-b')
  const clientA = await signInAs(userA)
  const clientB = await signInAs(userB)

  try {
    await runValidCampaign(clientA, service)

    const invalidResults = await runInvalidCampaign(clientA, clientB, service)
    const totalAttempted = invalidResults.reduce((a, r) => a + r.attempted, 0)
    const totalCorrect = invalidResults.reduce((a, r) => a + r.correctlyRejected, 0)
    const allUnexpected = invalidResults.flatMap((r) => r.unexpected)
    console.log(
      `\nInvalid campaign: ${totalCorrect}/${totalAttempted} correctly rejected across ${invalidResults.length} classes.`,
    )
    if (allUnexpected.length > 0) {
      console.log('UNEXPECTED:', JSON.stringify(allUnexpected.slice(0, 20), null, 2))
    }

    console.log(
      `\nSUMMARY: valid_validated=${validated}/${VALID_CASE_COUNT} valid_failures=${failures.length} invalid_attempted=${totalAttempted} invalid_correct=${totalCorrect} invalid_unexpected=${allUnexpected.length}`,
    )

    if (failures.length > 0 || allUnexpected.length > 0) process.exitCode = 1
  } finally {
    await deleteSyntheticUser(service, userA.id)
    await deleteSyntheticUser(service, userB.id)
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})

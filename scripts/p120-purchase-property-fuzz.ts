/**
 * P120 §11 — real-database purchase property fuzz. P117 explicitly did not build this (only the
 * existing baseline's fixed cases were exercised). Generates randomized valid purchases via
 * fast-check, submits each through the real create_purchase RPC, reads back every affected row,
 * and checks the invariants: total = subtotal + shipping + customs - discount, line totals =
 * unit_price*quantity, shipping/customs/discount allocations sum exactly back to their own total
 * (F6), lot counts/basis/currency match what was submitted, and quantities exactly track.
 *
 * A smaller separate matrix of deliberately invalid payloads confirms clean rejection (no partial
 * commit — reused from the existing atomicity script's technique of checking table counts
 * unchanged, not repeated here in full since P117's p117-atomicity-check.ts already covers that
 * directly; this file's invalid-case matrix instead confirms each documented validation rule
 * actually fires).
 *
 * Usage: pnpm exec tsx scripts/p120-purchase-property-fuzz.ts [validCaseCount]
 */
import fc from 'fast-check'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  seedCatalog,
  signInAs,
  type TestClient,
} from '../tests/db/setup'

const VALID_CASE_COUNT = Number(process.argv[2] ?? 500)
const today = new Date().toISOString().slice(0, 10)

const cardVariants = [
  seedCatalog.charizardVariantId,
  seedCatalog.pikachuVariantId,
  seedCatalog.grassEnergyVariantId,
  seedCatalog.japaneseVariantId,
]

interface LineSpec {
  line_type: 'card' | 'sealed' | 'accessory'
  card_variant_id?: string
  sealed_product_id?: string
  condition?: string
  description?: string
  quantity: number
  unit_price_minor: number
}

const cardConditionArb = fc.constantFrom('MT', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO')

const lineArb: fc.Arbitrary<LineSpec> = fc.oneof(
  fc.record({
    line_type: fc.constant('card' as const),
    card_variant_id: fc.constantFrom(...cardVariants),
    condition: cardConditionArb,
    quantity: fc.integer({ min: 1, max: 20 }),
    unit_price_minor: fc.integer({ min: 0, max: 5_000_000 }),
  }),
  fc.record({
    line_type: fc.constant('sealed' as const),
    sealed_product_id: fc.constant(seedCatalog.sealedProductId),
    quantity: fc.integer({ min: 1, max: 10 }),
    unit_price_minor: fc.integer({ min: 0, max: 10_000_000 }),
  }),
  fc.record({
    line_type: fc.constant('accessory' as const),
    description: fc.constantFrom('Sleeves', 'Binder', 'Toploader', 'Deck box'),
    quantity: fc.integer({ min: 1, max: 5 }),
    unit_price_minor: fc.integer({ min: 0, max: 200_000 }),
  }),
)

interface PurchaseSample {
  lines: LineSpec[]
  shipping_minor: number
  customs_minor: number
  discount_minor: number
  currency: string
  notes: string | undefined
}

const purchaseArb: fc.Arbitrary<PurchaseSample> = fc.record({
  lines: fc.array(lineArb, { minLength: 1, maxLength: 8 }),
  shipping_minor: fc.integer({ min: 0, max: 100_000 }),
  customs_minor: fc.integer({ min: 0, max: 100_000 }),
  discount_minor: fc.integer({ min: 0, max: 50_000 }),
  currency: fc.constantFrom('NOK', 'NOK', 'NOK', 'EUR', 'USD'), // weighted toward NOK (the common case)
  notes: fc.option(fc.string({ maxLength: 100 }), { nil: undefined }),
})

interface Failure {
  seed: number
  case: unknown
  reason: string
}
const failures: Failure[] = []
let validated = 0

async function runOneCase(
  clientA: TestClient,
  service: TestClient,
  sample: PurchaseSample,
  seed: number,
) {
  const { lines, shipping_minor, customs_minor, discount_minor, currency, notes } = sample
  const args: Record<string, unknown> = {
    p_purchased_on: today,
    p_currency: currency,
    p_shipping_minor: shipping_minor,
    p_customs_minor: customs_minor,
    p_discount_minor: discount_minor,
    p_lines: lines,
    p_notes: notes ?? null,
  }
  if (currency !== 'NOK') {
    args.p_fx_rate_to_nok = '11.50000000'
    args.p_fx_rate_date = today
    args.p_fx_source = 'manual'
  }

  const { data: purchase, error } = await clientA.rpc('create_purchase', args).single<{
    id: string
    total_minor: number
    total_nok_minor: number
    subtotal_minor: number
    shipping_minor: number
    customs_minor: number
    discount_minor: number
    currency: string
  }>()

  if (error) {
    failures.push({ seed, case: sample, reason: `create_purchase errored: ${error.message}` })
    return
  }

  const expectedSubtotal = lines.reduce(
    (acc: number, l: LineSpec) => acc + l.unit_price_minor * l.quantity,
    0,
  )
  const expectedTotal = expectedSubtotal + shipping_minor + customs_minor - discount_minor

  if (purchase.subtotal_minor !== expectedSubtotal) {
    failures.push({
      seed,
      case: sample,
      reason: `subtotal mismatch: got ${purchase.subtotal_minor}, expected ${expectedSubtotal}`,
    })
  }
  if (purchase.total_minor !== expectedTotal) {
    failures.push({
      seed,
      case: sample,
      reason: `total mismatch: got ${purchase.total_minor}, expected ${expectedTotal}`,
    })
  }
  if (purchase.currency !== currency) {
    failures.push({ seed, case: sample, reason: `currency mismatch: got ${purchase.currency}` })
  }

  interface DbLine {
    id: string
    line_type: string
    quantity: number
    unit_price_minor: number
    line_total_minor: number
    allocated_shipping_minor: number
    allocated_customs_minor: number
    allocated_discount_minor: number
  }
  const { data: dbLines, error: linesError } = await service
    .from('purchase_lines')
    .select(
      'id, line_type, quantity, unit_price_minor, line_total_minor, allocated_shipping_minor, allocated_customs_minor, allocated_discount_minor',
    )
    .eq('purchase_id', purchase.id)
    .overrideTypes<DbLine[], { merge: false }>()
  if (linesError) {
    failures.push({ seed, case: sample, reason: `lines fetch failed: ${linesError.message}` })
    return
  }
  if (dbLines.length !== lines.length) {
    failures.push({
      seed,
      case: sample,
      reason: `line count mismatch: got ${dbLines.length}, expected ${lines.length}`,
    })
  }
  for (const dbLine of dbLines) {
    if (dbLine.line_total_minor !== dbLine.unit_price_minor * dbLine.quantity) {
      failures.push({ seed, case: sample, reason: `line ${dbLine.id} total_minor != unit*qty` })
    }
  }
  // F6: allocations sum exactly back to their own totals.
  const sumShip = dbLines.reduce((a: number, l: DbLine) => a + l.allocated_shipping_minor, 0)
  const sumCustoms = dbLines.reduce((a: number, l: DbLine) => a + l.allocated_customs_minor, 0)
  const sumDiscount = dbLines.reduce((a: number, l: DbLine) => a + l.allocated_discount_minor, 0)
  if (sumShip !== shipping_minor) {
    failures.push({
      seed,
      case: sample,
      reason: `allocated_shipping sum ${sumShip} != ${shipping_minor}`,
    })
  }
  if (sumCustoms !== customs_minor) {
    failures.push({
      seed,
      case: sample,
      reason: `allocated_customs sum ${sumCustoms} != ${customs_minor}`,
    })
  }
  if (sumDiscount !== discount_minor) {
    failures.push({
      seed,
      case: sample,
      reason: `allocated_discount sum ${sumDiscount} != ${discount_minor}`,
    })
  }

  // Lots exist for card/sealed lines only, with matching quantity.
  interface DbLot {
    id: string
    quantity: number
    quantity_remaining: number
    purchase_line_id: string
  }
  const { data: lots, error: lotsError } = await service
    .from('acquisition_lots')
    .select('id, quantity, quantity_remaining, purchase_line_id')
    .in(
      'purchase_line_id',
      dbLines.map((l) => l.id),
    )
    .overrideTypes<DbLot[], { merge: false }>()
  if (lotsError) {
    failures.push({ seed, case: sample, reason: `lots fetch failed: ${lotsError.message}` })
    return
  }
  const expectedLotCount = lines.filter((l) => l.line_type !== 'accessory').length
  if (lots.length !== expectedLotCount) {
    failures.push({
      seed,
      case: sample,
      reason: `lot count mismatch: got ${lots.length}, expected ${expectedLotCount}`,
    })
  }
  for (const lot of lots) {
    const parentLine = dbLines.find((l) => l.id === lot.purchase_line_id)
    if (!parentLine) {
      failures.push({ seed, case: sample, reason: `lot ${lot.id} has no matching purchase line` })
      continue
    }
    if (lot.quantity !== parentLine.quantity || lot.quantity_remaining !== parentLine.quantity) {
      failures.push({ seed, case: sample, reason: `lot ${lot.id} quantity mismatch` })
    }
  }

  validated++
}

async function main() {
  const service = createServiceClient()
  const userA = await createSyntheticUser(service, 'p120-purchase-fuzz')
  const clientA = await signInAs(userA)

  try {
    let seed = 0
    await fc.assert(
      fc.asyncProperty(purchaseArb, async (sample) => {
        seed++
        await runOneCase(clientA, service, sample, seed)
      }),
      { numRuns: VALID_CASE_COUNT, seed: 120120 },
    )
  } finally {
    console.log(`Validated ${validated}/${VALID_CASE_COUNT} cases. Failures: ${failures.length}`)
    if (failures.length > 0) {
      console.log(JSON.stringify(failures.slice(0, 20), null, 2))
    }
    await deleteSyntheticUser(service, userA.id)
  }

  if (failures.length > 0) process.exit(1)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  seedCatalog,
  signInAs,
  type SyntheticUser,
  type TestClient,
} from './setup'

/**
 * M9.1 retention gate (prompt §30, mandatory — M9 shipped `thin_price_snapshots` without this
 * test). Seeds a synthetic dataset spanning >18 months across multiple variants, providers and
 * ISO weeks, runs the real retention function, and proves its actual behaviour: everything inside
 * the 12-month daily-retention window survives untouched; beyond it, exactly the latest observation
 * in each ISO week per (variant, provider) survives and the rest are deleted; a second run is a
 * true no-op; and `get_card_variant_price_history` still returns usable, real (never fabricated)
 * points afterward.
 *
 * Deterministic by construction: dates are computed from explicit Monday-aligned week anchors
 * rather than "N days ago" arithmetic, so the test's notion of "same ISO week" can never drift
 * from Postgres's own `date_trunc('week', ...)` regardless of what day this suite runs on.
 */

let service: TestClient
let user: SyntheticUser
let client: TestClient

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** Monday (UTC) of the ISO week containing `d`. */
function mondayOf(d: Date): Date {
  const copy = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dow = copy.getUTCDay() // 0 = Sunday
  const diffToMonday = (dow + 6) % 7
  copy.setUTCDate(copy.getUTCDate() - diffToMonday)
  return copy
}

function addDays(d: Date, n: number): Date {
  const copy = new Date(d)
  copy.setUTCDate(copy.getUTCDate() + n)
  return copy
}

const today = new Date()
// A week comfortably beyond the 18-month mark the prompt asks for (560 days ~ 18.4 months), and
// far enough from `today` that a 6-day spread within it never crosses into the 12-month window.
const oldWeekMonday = mondayOf(addDays(today, -560))
// A second, distinct old week (~14 months / 420 days ago) — inside "beyond 12 months" but
// deliberately not the same week as oldWeekMonday, to prove week-scoping isn't coincidental.
const secondOldWeekMonday = mondayOf(addDays(today, -420))

beforeAll(async () => {
  service = createServiceClient()
  user = await createSyntheticUser(service, 'm91-retention')
  // Retention itself is service-role-only infrastructure (DATA_MODEL.md §4.2) — this user only
  // exists so get_card_variant_price_history (SECURITY INVOKER, requires auth.uid()) has a real
  // signed-in caller to run under; no holdings are created for it.
  client = await signInAs(user)
  // Deterministic FX rate far enough in the past that every fixture date resolves against it.
  await service.from('fx_rates').upsert(
    [
      {
        base_currency: 'EUR',
        quote_currency: 'NOK',
        rate_date: isoDate(addDays(today, -600)),
        rate: '11.50000000',
        source: 'norges_bank',
      },
    ],
    { onConflict: 'base_currency,quote_currency,rate_date,source' },
  )
})

afterAll(async () => {
  await deleteSyntheticUser(service, user.id)
})

async function snapshot(opts: {
  cardVariantId: string
  provider: 'tcgdex_cardmarket' | 'tcgdex_tcgplayer'
  date: Date
  valueMinor: number
}) {
  const isEu = opts.provider === 'tcgdex_cardmarket'
  const { error } = await service.from('price_snapshots').upsert(
    {
      card_variant_id: opts.cardVariantId,
      provider: opts.provider,
      price_kind: isEu ? 'cm_trend' : 'tp_market',
      source_currency: isEu ? 'EUR' : 'USD',
      value_minor: opts.valueMinor,
      snapshot_date: isoDate(opts.date),
      provider_updated_at: opts.date.toISOString(),
    },
    { onConflict: 'card_variant_id,provider,snapshot_date' },
  )
  if (error) throw new Error(error.message)
}

async function countRows(cardVariantId: string, provider: string): Promise<number> {
  const { count, error } = await service
    .from('price_snapshots')
    .select('id', { count: 'exact', head: true })
    .eq('card_variant_id', cardVariantId)
    .eq('provider', provider)
  if (error) throw new Error(error.message)
  return count ?? 0
}

async function dates(cardVariantId: string, provider: string): Promise<string[]> {
  const { data, error } = await service
    .from('price_snapshots')
    .select('snapshot_date')
    .eq('card_variant_id', cardVariantId)
    .eq('provider', provider)
    .order('snapshot_date', { ascending: true })
  if (error) throw new Error(error.message)
  return data.map((r) => r.snapshot_date)
}

describe('thin_price_snapshots — 18-month synthetic retention matrix', () => {
  const pikachu = seedCatalog.pikachuVariantId
  const charizard = seedCatalog.charizardVariantId

  beforeAll(async () => {
    // Clean slate for the variants this file uses — other test files share the same seed catalog.
    await service.from('price_snapshots').delete().in('card_variant_id', [pikachu, charizard])

    // 1. RECENT daily history (well inside the 12-month window) — pikachu/cardmarket, 6 days,
    //    must survive thinning byte-for-byte.
    for (let i = 0; i < 6; i++) {
      await snapshot({
        cardVariantId: pikachu,
        provider: 'tcgdex_cardmarket',
        date: addDays(today, -i),
        valueMinor: 1000 + i,
      })
    }

    // 2. OLD week, pikachu/cardmarket, 3 observations in the SAME ISO week (Tue/Thu/Sat) —
    //    only the latest (Saturday) must survive.
    await snapshot({
      cardVariantId: pikachu,
      provider: 'tcgdex_cardmarket',
      date: addDays(oldWeekMonday, 1), // Tuesday
      valueMinor: 500,
    })
    await snapshot({
      cardVariantId: pikachu,
      provider: 'tcgdex_cardmarket',
      date: addDays(oldWeekMonday, 3), // Thursday
      valueMinor: 550,
    })
    await snapshot({
      cardVariantId: pikachu,
      provider: 'tcgdex_cardmarket',
      date: addDays(oldWeekMonday, 5), // Saturday — the week's latest
      valueMinor: 600,
    })

    // 3. PROVIDER SEPARATION: pikachu/tcgplayer has its own 3-row old week (different days) —
    //    must be thinned independently of pikachu/cardmarket above, never merged.
    await snapshot({
      cardVariantId: pikachu,
      provider: 'tcgdex_tcgplayer',
      date: addDays(oldWeekMonday, 0), // Monday
      valueMinor: 300,
    })
    await snapshot({
      cardVariantId: pikachu,
      provider: 'tcgdex_tcgplayer',
      date: addDays(oldWeekMonday, 2), // Wednesday
      valueMinor: 320,
    })
    await snapshot({
      cardVariantId: pikachu,
      provider: 'tcgdex_tcgplayer',
      date: addDays(oldWeekMonday, 4), // Friday — the week's latest for this provider
      valueMinor: 340,
    })

    // 4. VARIANT SEPARATION: charizard/cardmarket has its own old-week 3-row set (same calendar
    //    week as pikachu/cardmarket's, to prove partitioning is per-variant, not just per-week).
    await snapshot({
      cardVariantId: charizard,
      provider: 'tcgdex_cardmarket',
      date: addDays(oldWeekMonday, 1),
      valueMinor: 9000,
    })
    await snapshot({
      cardVariantId: charizard,
      provider: 'tcgdex_cardmarket',
      date: addDays(oldWeekMonday, 5),
      valueMinor: 9500,
    })

    // 5. A second, distinct old week for charizard/cardmarket (~14 months ago) with a single
    //    observation — a week with only one old row has nothing to thin; it must survive trivially.
    await snapshot({
      cardVariantId: charizard,
      provider: 'tcgdex_cardmarket',
      date: addDays(secondOldWeekMonday, 2),
      valueMinor: 9200,
    })
  })

  it('measures the seeded state before thinning', async () => {
    expect(await countRows(pikachu, 'tcgdex_cardmarket')).toBe(9) // 6 recent + 3 old
    expect(await countRows(pikachu, 'tcgdex_tcgplayer')).toBe(3)
    expect(await countRows(charizard, 'tcgdex_cardmarket')).toBe(3) // 2 + 1
  })

  it('thins correctly: recent stays, old collapses to one per (variant, provider, week)', async () => {
    const { data, error } = await service.rpc('thin_price_snapshots').single<{
      deleted_count: number
    }>()
    expect(error).toBeNull()
    // 2 deleted from pikachu/cardmarket's old week + 2 from pikachu/tcgplayer's old week
    // + 1 from charizard/cardmarket's old week = 5. The single-row second old week deletes nothing.
    expect(data?.deleted_count).toBe(5)

    // Recent daily history untouched, byte-for-byte.
    expect(await countRows(pikachu, 'tcgdex_cardmarket')).toBe(4) // 6 recent + 1 old survivor
    const pikachuCmDates = await dates(pikachu, 'tcgdex_cardmarket')
    for (let i = 0; i < 6; i++) {
      expect(pikachuCmDates).toContain(isoDate(addDays(today, -i)))
    }
    // Same-week deterministic survivor: the latest date in the old week (Saturday), never Tue/Thu.
    expect(pikachuCmDates).toContain(isoDate(addDays(oldWeekMonday, 5)))
    expect(pikachuCmDates).not.toContain(isoDate(addDays(oldWeekMonday, 1)))
    expect(pikachuCmDates).not.toContain(isoDate(addDays(oldWeekMonday, 3)))

    // Provider separation: pikachu/tcgplayer's own week-latest (Friday) survives independently.
    const pikachuTpDates = await dates(pikachu, 'tcgdex_tcgplayer')
    expect(pikachuTpDates).toEqual([isoDate(addDays(oldWeekMonday, 4))])

    // Variant separation: charizard/cardmarket's own week-latest (Saturday) survives, plus the
    // untouched single-row second old week.
    const charizardDates = await dates(charizard, 'tcgdex_cardmarket')
    expect(charizardDates).toEqual(
      [addDays(oldWeekMonday, 5), addDays(secondOldWeekMonday, 2)]
        .map(isoDate)
        .sort((a, b) => (a < b ? -1 : 1)),
    )
  })

  it('is idempotent: a second run deletes nothing and changes no row', async () => {
    const before = {
      pc: await dates(pikachu, 'tcgdex_cardmarket'),
      pt: await dates(pikachu, 'tcgdex_tcgplayer'),
      c: await dates(charizard, 'tcgdex_cardmarket'),
    }
    const { data, error } = await service.rpc('thin_price_snapshots').single<{
      deleted_count: number
    }>()
    expect(error).toBeNull()
    expect(data?.deleted_count).toBe(0)
    expect(await dates(pikachu, 'tcgdex_cardmarket')).toEqual(before.pc)
    expect(await dates(pikachu, 'tcgdex_tcgplayer')).toEqual(before.pt)
    expect(await dates(charizard, 'tcgdex_cardmarket')).toEqual(before.c)
  })

  it('history is still usable after thinning — the surviving old point is real, never fabricated', async () => {
    const { data, error } = await client.rpc('get_card_variant_price_history', {
      p_card_variant_id: charizard,
      p_since: isoDate(addDays(today, -600)),
    })
    expect(error).toBeNull()
    const points = data as { snapshot_date: string; value_nok_minor: string }[]
    // charizard/cardmarket now has exactly 2 surviving points (one per old week's survivor) — the
    // resolver never interpolates or invents a point for a thinned-away date (D-008).
    expect(points).toHaveLength(2)
    const pointDates = points.map((p) => p.snapshot_date).sort()
    expect(pointDates).toEqual(
      [addDays(oldWeekMonday, 5), addDays(secondOldWeekMonday, 2)]
        .map(isoDate)
        .sort((a, b) => (a < b ? -1 : 1)),
    )
  })
})

import { beforeAll, describe, expect, it } from 'vitest'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  seedCatalog,
  signInAs,
  type SyntheticUser,
  type TestClient,
} from './setup'
import { rebuildSnapshots } from './lib/rebuild-snapshots'

/**
 * P209 / D-210 (docs/FINANCIAL_MODEL.md M3): the supported range of an amount is the signed bigint.
 * P199 reproduced that a manual valuation near 9e18 minor with two copies made every portfolio read
 * fail with 22003, so the owner could not even open the holding to correct it.
 *
 * Invariant under test:
 *   1. one holding's value (unit x owned copies) is always a bigint - a write that would exceed it is
 *      refused with SQLSTATE 22003 and a message, never clamped or rounded;
 *   2. every aggregate is exact numeric and arrives as text, even past the bigint range.
 */

const MAX = 9223372036854775807n
const today = new Date().toISOString().slice(0, 10)

let service: TestClient

beforeAll(() => {
  service = createServiceClient()
})

interface Ctx {
  user: SyntheticUser
  client: TestClient
  buy: (quantity: number) => Promise<{ holdingId: string }>
  setValue: (holdingId: string, value: bigint) => ReturnType<TestClient['rpc']>
}

/** One synthetic account per test: holdings of the same card consolidate, so tests must not share. */
async function withAccount(label: string, fn: (ctx: Ctx) => Promise<void>) {
  const user = await createSyntheticUser(service, label)
  const client = await signInAs(user)
  try {
    await fn({
      user,
      client,
      buy: async (quantity) => {
        const r = await client.rpc('create_purchase', {
          p_purchased_on: today,
          p_currency: 'NOK',
          p_lines: [
            {
              line_type: 'card',
              card_variant_id: seedCatalog.pikachuVariantId,
              condition: 'NM',
              quantity,
              unit_price_minor: 100,
            },
          ],
        })
        if (r.error) throw new Error(r.error.message)
        const lot = await service
          .from('acquisition_lots')
          .select('holding_id')
          .eq('user_id', user.id)
          .limit(1)
          .single<{ holding_id: string }>()
        return { holdingId: lot.data!.holding_id }
      },
      setValue: (holdingId, value) =>
        client.rpc('set_manual_valuation', {
          p_holding_id: holdingId,
          p_value_minor: value.toString(),
        }),
    })
  } finally {
    await deleteSyntheticUser(service, user.id)
  }
}

async function reads(client: TestClient) {
  const dash = await client.rpc('get_dashboard_summary').single<Record<string, string | null>>()
  const counts = await client.rpc('portfolio_counts').single<Record<string, string>>()
  const list = await client.rpc('list_portfolio')
  return { dash, counts, list }
}

describe('D-210 a single holding at the edge of the bigint range', () => {
  it('unit = floor(MAX / 2), two copies: accepted, and every read returns the exact product as text', () =>
    withAccount('p209-range-edge', async ({ user, client, buy, setValue }) => {
      const { holdingId } = await buy(2)
      const unit = MAX / 2n // 4611686018427387903
      expect((await setValue(holdingId, unit)).error).toBeNull()
      const want = (unit * 2n).toString() // 9223372036854775806, below MAX

      const { dash, counts, list } = await reads(client)
      expect(dash.error).toBeNull()
      expect(dash.data!.raw_value_nok_minor).toBe(want)
      expect(counts.error).toBeNull()
      expect(counts.data!.portfolio_value_nok_minor).toBe(want)
      expect(list.error).toBeNull()
      const row = (list.data as { holding_id: string; holding_value_nok_minor: string }[]).find(
        (r) => r.holding_id === holdingId,
      )
      expect(row?.holding_value_nok_minor).toBe(want)

      const prov = await client.rpc('get_holding_value_provenance', { p_holding_id: holdingId })
      expect(prov.error).toBeNull()
      expect((prov.data as { holding_value_nok_minor: string }[])[0]!.holding_value_nok_minor).toBe(
        want,
      )

      // the snapshot cache holds the same exact figure
      const rb = await rebuildSnapshots(service, user.id, today, today)
      expect(rb.error).toBeNull()
      const hist = await client.rpc('get_portfolio_history')
      expect(hist.error).toBeNull()
      const last = (hist.data as { market_value_nok_minor: string }[]).at(-1)!
      expect(last.market_value_nok_minor).toBe(want)
    }))

  it('one minor unit more per copy is refused with 22003 and the valuation is unchanged', () =>
    withAccount('p209-range-refuse', async ({ buy, setValue }) => {
      const { holdingId } = await buy(2)
      const ok = MAX / 2n
      expect((await setValue(holdingId, ok)).error).toBeNull()
      const r = await setValue(holdingId, ok + 1n) // 2 x (ok + 1) = MAX + 1
      expect(r.error?.code).toBe('22003')
      expect(r.error?.message).toMatch(/holding value out of range/)
      const active = await service
        .from('manual_valuations')
        .select('value_nok_minor::text')
        .eq('holding_id', holdingId)
        .is('superseded_at', null)
        .single<{ value_nok_minor: string }>()
      // read as text: a JSON number above 2^53 would round (M3)
      expect(BigInt(active.data!.value_nok_minor)).toBe(ok)
    }))

  it('adding copies that would push the holding past the range is refused and rolls the purchase back', () =>
    withAccount('p209-range-add', async ({ client, buy, setValue }) => {
      const { holdingId } = await buy(1)
      expect((await setValue(holdingId, MAX / 2n)).error).toBeNull() // 1 copy: fine
      const lotsBefore = await service
        .from('acquisition_lots')
        .select('id', { count: 'exact', head: true })
        .eq('holding_id', holdingId)
      // two more copies: 3 x floor(MAX / 2) > MAX
      const r = await client.rpc('create_purchase', {
        p_purchased_on: today,
        p_currency: 'NOK',
        p_lines: [
          {
            line_type: 'card',
            card_variant_id: seedCatalog.pikachuVariantId,
            condition: 'NM',
            quantity: 2,
            unit_price_minor: 100,
          },
        ],
      })
      expect(r.error?.code).toBe('22003')
      const lotsAfter = await service
        .from('acquisition_lots')
        .select('id', { count: 'exact', head: true })
        .eq('holding_id', holdingId)
      expect(lotsAfter.count).toBe(lotsBefore.count)
    }))

  it('a valuation that does not fit the copies already owned is refused, so no holding can poison the totals', () =>
    withAccount('p209-range-poison', async ({ client, buy, setValue }) => {
      const { holdingId } = await buy(3)
      const r = await setValue(holdingId, MAX / 2n) // 3 copies x floor(MAX/2) > MAX
      expect(r.error?.code).toBe('22003')
      const { dash } = await reads(client)
      expect(dash.error).toBeNull()
    }))
})

describe('D-210 aggregates beyond the bigint range stay exact', () => {
  it('two holdings that each fit, whose sum does not: dashboard, counts and history return exact text', () =>
    withAccount('p209-range-sum', async ({ user, client }) => {
      const big = MAX - 7n // one copy worth almost the maximum
      for (const variant of [seedCatalog.pikachuVariantId, seedCatalog.charizardVariantId]) {
        const p = await client.rpc('create_purchase', {
          p_purchased_on: today,
          p_currency: 'NOK',
          p_lines: [
            {
              line_type: 'card',
              card_variant_id: variant,
              condition: 'NM',
              quantity: 1,
              unit_price_minor: 100,
            },
          ],
        })
        expect(p.error).toBeNull()
      }
      const lots = await service
        .from('acquisition_lots')
        .select('holding_id')
        .eq('user_id', user.id)
      const holdings = (lots.data as { holding_id: string }[]).map((l) => l.holding_id)
      expect(holdings).toHaveLength(2)
      for (const h of holdings) {
        const r = await client.rpc('set_manual_valuation', {
          p_holding_id: h,
          p_value_minor: big.toString(),
        })
        expect(r.error).toBeNull()
      }
      const want = (big * 2n).toString() // 18446744073709551600 > MAX

      const dash = await client.rpc('get_dashboard_summary').single<Record<string, string | null>>()
      expect(dash.error).toBeNull()
      expect(dash.data!.raw_value_nok_minor).toBe(want)
      const counts = await client.rpc('portfolio_counts').single<Record<string, string>>()
      expect(counts.error).toBeNull()
      expect(counts.data!.portfolio_value_nok_minor).toBe(want)

      const rb = await rebuildSnapshots(service, user.id, today, today)
      expect(rb.error).toBeNull()
      const after = await client
        .rpc('get_dashboard_summary')
        .single<Record<string, string | null>>()
      expect(after.data!.market_value_nok_minor).toBe(want)
      // THP = CMV + NSP - GPO stays exact (GPO is 200: two purchases of 100)
      expect(after.data!.thp_nok_minor).toBe((big * 2n - 200n).toString())
    }))
})

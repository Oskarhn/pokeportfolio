/**
 * Seeded concurrency permutations that expose inconsistent lock ordering (deadlock, SQLSTATE 40P01)
 * and any corruption the interleavings produce.
 *
 * Why a gate: a single RPC is one statement, so two RPCs can only deadlock if one takes lock X then
 * waits for Y while the other holds Y and waits for X — inside their statements. Every ledger write
 * for a user also upserts that user's `portfolio_recompute_queue` row (M12 triggers), part-way
 * through each RPC. Holding that row from a third session parks each RPC at its first write with
 * whatever row locks it has already taken; releasing it lets them continue in FIFO order. An RPC
 * that writes (and so locks) a purchase or lot row BEFORE locking the lots a sale needs deadlocks
 * against create_sale deterministically; an RPC that locks the lots it depends on up front does not.
 * Iterations without the gate ("free") add genuinely unsynchronised starts.
 *
 *   P132C_DL_ITERATIONS (default 80), P132C_DL_BASE (default 4242), P132C_DL_SEED=n to replay one
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newUser, openFileContext, type FileContext, type UserContext } from './harness/context'
import { awaitAllCompleted, waitSettled } from './harness/concurrency'
import type { PgSession } from './harness/docker-pg'
import * as fx from './harness/fixtures'
import { checkInvariants, recordRemovals } from './harness/invariants'
import {
  actAs,
  classify,
  createOpeningSql,
  createSaleSql,
  describeOutcome,
  lit,
  openUserSession,
  removeHoldingsSql,
  setSealedIntentSql,
  updatePurchaseSql,
  voidLotSql,
  voidPurchaseSql,
  voidSaleSql,
  type Outcome,
  type Snapshot,
} from './harness/ledger'
import { Prng } from './harness/prng'

let ctx: FileContext
let c: PgSession

beforeAll(async () => {
  ctx = await openFileContext('deadlock')
  c = await openUserSession(ctx.container, 'deadlock_c')
})
afterAll(async () => {
  await c.exec('rollback')
  await c.close()
  await ctx.close()
})

interface Fixture {
  purchaseId: string
  sealedLineId: string
  cardLineId: string
  original: string
  carved: string
  cardLot: string
  sealedHolding: string
  cardHolding: string
  unknownCardLot: string
  earlierSale: string
}

async function buildFixture(user: UserContext): Promise<Fixture> {
  const lines = [fx.sealedLine(ctx, 5, 10_000), fx.cardLine(ctx, 3, 2_000)]
  const bought = await fx.buy(ctx.a, user, lines, { shipping: 499 })
  const original = bought.lotIds[0]!
  const carved = await fx.split(ctx.a, original, 'keep_sealed', 2)
  const unknown = await fx.acquire(ctx.a, {
    cardVariantId: ctx.catalog.cardVariantId2,
    condition: 'LP',
    quantity: 3,
  })
  const earlierSale = await fx.sell(ctx.a, unknown.lot_id, 1, 900)
  return {
    purchaseId: bought.purchaseId,
    sealedLineId: bought.lineIds[0]!,
    cardLineId: bought.lineIds[1]!,
    original,
    carved,
    cardLot: bought.lotIds[1]!,
    sealedHolding: bought.holdingIds[0]!,
    cardHolding: bought.holdingIds[1]!,
    unknownCardLot: unknown.lot_id,
    earlierSale,
  }
}

type OpFactory = (f: Fixture, snap: Snapshot, rng: Prng) => { name: string; sql: string }

const OPS: OpFactory[] = [
  (f) => ({
    name: 'sale O',
    sql: createSaleSql([{ lot_id: f.original, quantity: 1, unit_gross_minor: 12_000 }]),
  }),
  (f) => ({
    name: 'sale K',
    sql: createSaleSql([{ lot_id: f.carved, quantity: 1, unit_gross_minor: 12_000 }]),
  }),
  (f, _s, rng) => {
    const lines = rng
      .shuffle([
        { lot_id: f.original, quantity: 1, unit_gross_minor: 12_000 },
        { lot_id: f.carved, quantity: 1, unit_gross_minor: 11_000 },
        { lot_id: f.cardLot, quantity: 1, unit_gross_minor: 3_000 },
      ])
      .slice(0, rng.int(2, 3))
    return {
      name: `sale multi(${lines.map((l) => (l.lot_id === f.original ? 'O' : l.lot_id === f.carved ? 'K' : 'C')).join('')})`,
      sql: createSaleSql(lines),
    }
  },
  (f) => ({
    name: 'sale C',
    sql: createSaleSql([{ lot_id: f.cardLot, quantity: 1, unit_gross_minor: 3_000 }]),
  }),
  (f) => ({
    name: 'sale U',
    sql: createSaleSql([{ lot_id: f.unknownCardLot, quantity: 1, unit_gross_minor: 800 }]),
  }),
  (f, s) => ({
    name: 'update_purchase card price',
    sql: updatePurchaseSql(s, f.purchaseId, {
      lines: { [f.cardLineId]: { unit_price_minor: 2_400 } },
    }),
  }),
  (f, s) => ({
    name: 'update_purchase shipping',
    sql: updatePurchaseSql(s, f.purchaseId, { header: { shipping: 1_299 } }),
  }),
  (f) => ({ name: 'void_acquisition_lot C', sql: voidLotSql(f.cardLot) }),
  (f) => ({ name: 'void_acquisition_lot K', sql: voidLotSql(f.carved) }),
  (f) => ({ name: 'remove_holdings sealed', sql: removeHoldingsSql([f.sealedHolding]) }),
  (f) => ({ name: 'remove_holdings card', sql: removeHoldingsSql([f.cardHolding]) }),
  (f) => ({ name: 'void_purchase', sql: voidPurchaseSql(f.purchaseId) }),
  (f) => ({ name: 'intent split O', sql: setSealedIntentSql(f.original, 'planned_to_open', 1) }),
  (f) => ({ name: 'void_sale earlier', sql: voidSaleSql(f.earlierSale) }),
  (f) => ({
    name: 'open O',
    sql: createOpeningSql(f.original, 1, [
      { card_variant_id: ctx.catalog.cardVariantId2, quantity: 1, condition: 'EX' },
    ]),
  }),
]

interface IterationResult {
  seed: number
  mode: 'gated' | 'free'
  ops: string[]
  outcomes: Outcome[]
  violations: string[]
}

async function iterate(seed: number): Promise<IterationResult> {
  const rng = new Prng(seed)
  const user = await newUser(ctx, `dl${String(seed)}`)
  await actAs(c, user.userId)
  const fixture = await buildFixture(user)
  const before = await user.snap()
  const count = rng.chance(0.3) ? 3 : 2
  const sessions = [ctx.a, ctx.b, c].slice(0, count)
  const ops = sessions.map(() => rng.pick(OPS)(fixture, before, rng))
  const mode = rng.chance(0.7) ? 'gated' : 'free'

  let pending: Promise<Outcome>[]
  if (mode === 'gated') {
    await ctx.admin.value('begin')
    await ctx.admin.value(
      `insert into public.portfolio_recompute_queue (user_id, dirty_from) values (${lit(user.userId)}, current_date) on conflict (user_id) do nothing`,
    )
    await ctx.admin.value(
      `select 1 from public.portfolio_recompute_queue where user_id = ${lit(user.userId)} for update`,
    )
    pending = []
    for (let i = 0; i < count; i += 1) {
      pending.push(sessions[i]!.exec(ops[i]!.sql).then(classify))
      await waitSettled(ctx.observer, sessions[i]!)
    }
    await ctx.admin.value('commit')
  } else {
    pending = sessions.map((s, i) => s.exec(ops[i]!.sql).then(classify))
  }
  const outcomes = await Promise.all(pending)
  await awaitAllCompleted(sessions)
  const after = await user.snap()
  recordRemovals(before, after, user.model)
  return {
    seed,
    mode,
    ops: ops.map((o) => o.name),
    outcomes,
    violations: checkInvariants(after, user.model).map((v) => v.code),
  }
}

const ITERATIONS = Number(process.env.P132C_DL_ITERATIONS ?? 80)
const BASE = Number(process.env.P132C_DL_BASE ?? 4242)
const seeds = process.env.P132C_DL_SEED
  ? process.env.P132C_DL_SEED.split(',').map(Number)
  : Array.from({ length: ITERATIONS }, (_, i) => BASE + i)

/** Same extended (outside P130-01/03) codes as the state machine; P132C_DL_STRICT=1 makes them fatal. */
const EXTENDED_CODES = new Set(
  process.env.P132C_DL_STRICT === '1'
    ? []
    : ['VOIDED_PURCHASE_LIVE_LOT', 'LINE_QUANTITY_WITHOUT_LIVE_LOTS'],
)

describe('seeded deadlock / lock-order search', () => {
  it(`${String(seeds.length)} permutations: no deadlock, no raw error, no corruption`, async () => {
    const deadlocks: string[] = []
    const errors: string[] = []
    const corruptions: string[] = []
    const extended: string[] = []
    for (const seed of seeds) {
      const r = await iterate(seed)
      const line = `seed ${String(r.seed)} ${r.mode} [${r.ops.join(' || ')}] -> [${r.outcomes.map(describeOutcome).join(' || ')}]`
      if (r.outcomes.some((o) => o.kind === 'deadlock')) deadlocks.push(line)
      if (
        r.outcomes.some((o) => o.kind === 'constraint_violation' || o.kind === 'unexpected_error')
      )
        errors.push(line)
      const codes = [...new Set(r.violations)]
      if (codes.some((code) => !EXTENDED_CODES.has(code)))
        corruptions.push(`${line} violations=${codes.join(',')}`)
      else if (codes.length > 0) extended.push(`${line} violations=${codes.join(',')}`)
    }
    console.log(
      `\nP132C_DEADLOCK_SUMMARY iterations=${String(seeds.length)} deadlocks=${String(deadlocks.length)} raw_errors=${String(errors.length)} corruptions=${String(corruptions.length)} extended_only=${String(extended.length)}\n` +
        [
          ...deadlocks.map((l) => `DEADLOCK ${l}`),
          ...errors.map((l) => `ERROR ${l}`),
          ...corruptions.map((l) => `CORRUPT ${l}`),
          ...extended.map((l) => `EXTENDED ${l}`),
        ].join('\n'),
    )
    expect({ deadlocks, errors, corruptions }).toEqual({
      deadlocks: [],
      errors: [],
      corruptions: [],
    })
  })
})

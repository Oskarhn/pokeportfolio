#!/usr/bin/env node
/**
 * P185: undo what a journey wrote, through the PRODUCT's own reversal functions (void_sale,
 * void_purchase, void_acquisition_lot, remove_holdings_from_portfolio) — never a raw DELETE, which
 * P180 showed leaves lot quantities inconsistent. Every call runs as the synthetic user under RLS
 * (role authenticated + that user's JWT claims). LOCAL, isolated stack only.
 *
 *   node scripts/p185/journey-cleanup.mjs [since-iso]     (default: the last 6 hours)
 *
 * Order matters: sales first (they dispose lots), then purchases / acquisition lots, then holdings.
 * A holding that has disposal history is kept by the product (its ledger must stay explainable);
 * that is reported, not forced.
 */
import './env.mjs'
import { psql } from './lib.mjs'
import { B } from './journeys.mjs'

const q = (s) => `'${String(s).replaceAll("'", "''")}'`

function asUser(sql) {
  return psql(
    `begin;\nset local role authenticated;\nselect set_config('request.jwt.claims', json_build_object('sub', ${q(B.id)}, 'role', 'authenticated')::text, true);\n${sql}\ncommit;`,
  )
}

export function cleanupSince(sinceIso) {
  const log = []
  const ids = (sql) => psql(sql).split(/\r?\n/).filter(Boolean)
  const since = q(sinceIso)
  const sales = ids(
    `select id from sales where user_id = ${q(B.id)} and voided_at is null and created_at > ${since} order by created_at desc`,
  )
  for (const id of sales) {
    asUser(`select public.void_sale(${q(id)}::uuid, 'p185 journey cleanup');`)
    log.push(`void_sale ${id.slice(0, 8)}`)
  }
  const lots = ids(
    `select id from acquisition_lots where user_id = ${q(B.id)} and voided_at is null and created_at > ${since} order by created_at desc`,
  )
  for (const id of lots) {
    // A lot from a purchase is reversed by voiding that purchase; any other lot by itself.
    const purchase = psql(
      `select pl.purchase_id from acquisition_lots al join purchase_lines pl on pl.id = al.purchase_line_id where al.id = ${q(id)}`,
    )
    try {
      asUser(`select public.void_acquisition_lot(${q(id)}::uuid, 'p185 journey cleanup');`)
      log.push(`void_acquisition_lot ${id.slice(0, 8)}`)
    } catch (error) {
      if (purchase === '') throw error
      asUser(`select public.void_purchase(${q(purchase)}::uuid, 'p185 journey cleanup');`)
      log.push(`void_purchase ${purchase.slice(0, 8)}`)
    }
  }
  const purchases = ids(
    `select id from purchases where user_id = ${q(B.id)} and voided_at is null and created_at > ${since} order by created_at desc`,
  )
  for (const id of purchases) {
    asUser(`select public.void_purchase(${q(id)}::uuid, 'p185 journey cleanup');`)
    log.push(`void_purchase ${id.slice(0, 8)}`)
  }
  const holdings = ids(
    `select h.id from holdings h where h.user_id = ${q(B.id)} and h.deleted_at is null and h.created_at > ${since}`,
  )
  const kept = []
  for (const id of holdings) {
    try {
      const r = asUser(
        `select blocked from public.remove_holdings_from_portfolio(array[${q(id)}::uuid]);`,
      )
      if (/t\b/.test(r)) kept.push(id.slice(0, 8))
      else log.push(`remove_holdings_from_portfolio ${id.slice(0, 8)}`)
    } catch {
      kept.push(id.slice(0, 8))
    }
  }
  return { log, keptHoldings: kept }
}

if (
  import.meta.url === `file://${process.argv[1].replaceAll('\\', '/')}` ||
  process.argv[1]?.endsWith('journey-cleanup.mjs')
) {
  const since = process.argv[2]
  if (!since) {
    // No default window: seeded fixture rows are only minutes older than a journey, and a wide default
    // would reverse them too (P185 learned this the hard way on its isolated stack).
    console.error('usage: journey-cleanup.mjs <since-iso-timestamp of the journey start>')
    process.exit(2)
  }
  console.log(JSON.stringify(cleanupSince(since), null, 1))
}

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServiceClient, deleteSyntheticUser, type TestClient } from '../../tests/db/setup'
import { discoverRpc, hasSupabaseEnv, skipUnlessM12 } from './helpers/contract'
import {
  acquireRaw,
  day,
  drainQueue,
  makeEnv,
  makeVariant,
  readSnapshots,
  setFxRate,
  setManual,
  setProviderPrice,
} from './helpers/fixtures'

/**
 * Scenario R / priority 10: custom-collection historical honesty.
 *
 * The schema stores only CURRENT membership (`custom_collection_members`, one row per holding,
 * with a wall-clock added_at). There is no membership event history. The contract therefore
 * demands that current membership is never silently projected backward as historical scope -
 * UX_FLOWS F8.2 and the M12 brief require an explicit current-only presentation instead.
 *
 * Two gates:
 *  1. Organisational neutrality (C1): adding or removing membership must not move a single
 *     semantic snapshot cell.
 *  2. If any dashboard RPC accepts a collection scope, its payload must either disclose that
 *     membership is not tracked historically or contain no dated positive-valued series points
 *     predating the membership itself. A silent backward projection of today's membership fails.
 */

let service: TestClient
const cleanupUsers: string[] = []

beforeAll(async () => {
  if (!hasSupabaseEnv()) return
  service = createServiceClient()
})

afterAll(async () => {
  if (!hasSupabaseEnv() || !service) return
  for (const id of cleanupUsers) await deleteSyntheticUser(service, id)
})

/** Finds ISO dates in a payload that sit within reach of a numeric value. */
function backdatedPositivePoints(payload: string): string[] {
  const hits: string[] = []
  const dateRegex = /"(\d{4}-\d{2}-\d{2})"[^{}]{0,80}?(:\s*)(\d{2,})/g
  for (const match of payload.matchAll(dateRegex)) {
    hits.push(`${match[1]}=${match[3]}`)
  }
  return hits
}

describe('M12 custom-collection historical honesty', () => {
  it('membership changes never move a single semantic cell (C1)', async (ctx) => {
    const surface = await skipUnlessM12(ctx, service)
    const env = await makeEnv('m12-coll')
    cleanupUsers.push(env.user.id)
    await setFxRate(env, 'EUR', day(-1), '10.00000000')
    const v = await makeVariant(env, 'coll')
    await setProviderPrice(env, v.variantId, 'tcgdex_cardmarket', 900, day(0))
    const acq = await acquireRaw(env, v.variantId, day(5), 3_000)
    await setManual(env, acq.holdingId, 77_777, day(6)) // marker figure for the scoped read
    await drainQueue(surface)

    const before = await readSnapshots(env)

    const { data: collection, error: collErr } = await env.client
      .from('custom_collections')
      .insert({ user_id: env.user.id, name: 'Adversarial Scope' })
      .select('id')
      .single<{ id: string }>()
    expect(collErr).toBeNull()
    const { error: memberErr } = await env.client.from('custom_collection_members').insert({
      collection_id: collection!.id,
      holding_id: acq.holdingId,
      user_id: env.user.id,
    })
    expect(memberErr).toBeNull()

    const after = await readSnapshots(env)
    expect(after).toEqual(before)

    // Gate 2: what does a collection-scoped dashboard read actually promise?
    const summarySig = await discoverRpc(service, 'get_dashboard_summary')
    const historySig = await discoverRpc(service, 'get_portfolio_history')
    const scopeParams = [
      ...(summarySig?.paramNames ?? []),
      ...(historySig?.paramNames ?? []),
    ].filter((p) => /collection|scope/i.test(p))

    if (scopeParams.length === 0) {
      console.warn(
        '[m12-adversarial] no dashboard/history RPC accepts a collection scope parameter; ' +
          'scoped history is simply not offered, which satisfies honesty by omission. Discovered ' +
          `signatures: get_dashboard_summary(${(summarySig?.paramNames ?? []).join(', ')}), ` +
          `get_portfolio_history(${(historySig?.paramNames ?? []).join(', ')})`,
      )
      return
    }

    const scopeArg: Record<string, unknown> = {}
    for (const name of scopeParams) scopeArg[name] = collection!.id

    const { data: scopedSummary, error: scopedErr } = await env.client.rpc(
      'get_dashboard_summary',
      scopeParamOf(summarySig?.paramNames ?? [], scopeArg),
    )
    expect(scopedErr).toBeNull()
    const scopedText = JSON.stringify(scopedSummary ?? {})

    // The scope must genuinely filter: the member holding's marker value appears...
    expect(scopedText).toContain('77777')

    // ...and history scoped to the collection must not project membership into pre-membership
    // days without an explicit disclosure flag.
    const disclosure = /notrack|not_track|membership_not|current_only|currentonly|coverage/i.test(
      scopedText,
    )
    if (!disclosure) {
      const addedAt = new Date().toISOString().slice(0, 10)
      const offenders = backdatedPositivePoints(scopedText).filter(
        (h) => h.split('=')[0]! < addedAt,
      )
      // A current-only summary legitimately carries no dated series at all; dated positive
      // points older than the membership are exactly the silent-projection failure mode.
      if (offenders.length > 0) {
        throw new Error(
          '[M12 CONTRACT] collection-scoped dashboard data contains dated positive values ' +
            `predating the membership (${offenders.join(', ')}) with no current-only/not-tracked ` +
            'disclosure. Current membership was projected backward as historical membership.',
        )
      }
    }
  })
})

function scopeParamOf(names: string[], scopeArg: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(scopeArg)) {
    if (names.includes(key)) out[key] = value
  }
  return out
}

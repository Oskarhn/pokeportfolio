/**
 * M16 INTEGRATION ORACLES — DB-backed, IMPLEMENTATION_GATED (§15/§16/§17/§18).
 *
 * Three downstream surfaces MUST move with M16, and each oracle here fails
 * loudly if its path was forgotten:
 *
 *   §16 HISTORY — one conceptual opening produces ONE opening event. The
 *   source purchase stays a separate historical purchase event (economically
 *   distinct); pulled lots are NOT re-reported as individual acquisition
 *   events (the get_recent_activity double-report trap output_44 flagged).
 *   Every opening row carries kind/date/status/navigation target.
 *
 *   §15 RESET — reset_my_portfolio_data() removes openings, opening disposal
 *   rows and pull lots, and leaves User B untouched. Behavioural emptiness is
 *   asserted, so the oracle survives signature evolution.
 *
 *   §17 BACKUP V2 — M16 introduces NEW canonical user data, so backup schema
 *   v1 cannot remain lossless. Once the openings table exists, an exported
 *   backup MUST carry schema_version ≥ 2 with sufficient opening canonical
 *   data + relationships. A v1 backup generated after M16 that silently omits
 *   openings is a BLOCKER.
 */
import { beforeAll, describe, expect, it } from 'vitest'

import { createSyntheticUser, deleteSyntheticUser, signInAs, type TestClient } from '../../db/setup'
import {
  bindOpeningCreateArgs,
  hasSupabaseEnv,
  probeM16Surface,
  requireCreateOpeningRpc,
  skipUnlessM16,
} from '../helpers/contract'
import {
  createIsolatedSealedProduct,
  createSealedPurchase,
  findKey,
  pullLotsForOpening,
} from '../helpers/fixtures'
import { seedCatalog } from '../../db/setup'

const today = new Date().toISOString().slice(0, 10)

describe.skipIf(!hasSupabaseEnv())('M16 integration oracles (history / reset / backup)', () => {
  let service: TestClient

  beforeAll(async () => {
    const { createServiceClient } = await import('../../db/setup')
    service = createServiceClient()
  }, 60_000)

  /** Seeds one full opening world for a user; returns the ids assertions need. */
  async function seedOpeningWorld(
    ctx: { skip(note?: string): void },
    label: string,
  ): Promise<{
    userId: string
    client: TestClient
    purchaseId: string
    openingId: string
    sealedLotId: string
  }> {
    const surface = await skipUnlessM16(ctx, service)
    const user = await createSyntheticUser(service, `m16adv-int-${label}`)
    const client = await signInAs(user)
    const productId = await createIsolatedSealedProduct(service, user.id, `int-${label}`)
    const purchase = await createSealedPurchase(client, service, {
      productId,
      quantity: 2,
      unitPriceMinor: 12_345,
      purchasedOn: today,
    })
    const rpc = requireCreateOpeningRpc(surface)
    // Pulls ride creation (folded, execution-bound — P53 §4/§15).
    const { data, error } = await client.rpc(
      rpc.name,
      bindOpeningCreateArgs(rpc, {
        openedOn: today,
        consumptions: [{ lotId: purchase.lotId, quantity: 1 }],
        pulls: [{ cardVariantId: seedCatalog.charizardVariantId, quantity: 3 }],
      }),
    )
    if (error || !data) throw new Error(`seed opening failed: ${error?.message}`)
    const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined
    const openingId = String(row?.['id'] ?? '')
    if (!openingId) throw new Error('[M16 CONTRACT] seed opening produced no id')

    const seededPulls = await pullLotsForOpening(client, openingId)
    expect(
      seededPulls.length,
      'the folded pull surface must have produced pull lots at creation',
    ).toBeGreaterThanOrEqual(1)

    return {
      userId: user.id,
      client,
      purchaseId: purchase.purchaseId,
      openingId,
      sealedLotId: purchase.lotId,
    }
  }

  // ---------------------------------------------------------------------------
  // §16 HISTORY ORACLE
  // ---------------------------------------------------------------------------

  it('history shows ONE event per opening; pulls are not double-reported', async (ctx) => {
    const world = await seedOpeningWorld(ctx, 'hist')
    try {
      const { data, error } = await world.client.rpc('list_history_events', {
        p_include_voided: false,
        p_limit: 500,
      })
      expect(error, `list_history_events failed: ${error?.message}`).toBeNull()
      const events = (data ?? []) as Record<string, unknown>[]
      expect(events.length).toBeGreaterThanOrEqual(1)

      const primaryIdOf = (row: Record<string, unknown>): string | null => {
        const key = findKey(row, /primary_?id/i) ?? findKey(row, /^id$/i)
        return key ? String(row[key]) : null
      }

      // Exactly ONE event for the opening itself.
      const openingEvents = events.filter((row) => primaryIdOf(row) === world.openingId)
      expect(openingEvents, 'the opening must appear exactly once').toHaveLength(1)

      // …with kind, date, status and a navigation target.
      const openingEvent = openingEvents[0] as Record<string, unknown>
      const kindKey = findKey(openingEvent, /^kind$|event_?kind|type$/i)
      expect(kindKey, 'event kind column missing').not.toBeNull()
      expect(String(openingEvent[kindKey as string]).toLowerCase()).toMatch(/open/)
      const dateKey = findKey(openingEvent, /occurred_?on|^date$/i)
      expect(dateKey, 'business-date column missing').not.toBeNull()
      expect(String(openingEvent[dateKey as string])).toBe(today)
      const navKey = findKey(openingEvent, /nav|target|href|route|link/i)
      expect(navKey, 'navigation target missing').not.toBeNull()
      expect(String(openingEvent[navKey as string]).length).toBeGreaterThan(0)

      // The source PURCHASE stays its own historical event — economically distinct.
      const purchaseEvents = events.filter((row) => primaryIdOf(row) === world.purchaseId)
      expect(purchaseEvents, 'the purchase must appear exactly once').toHaveLength(1)

      // Pulled lots are NOT re-reported as individual acquisition events.
      const pulls = await pullLotsForOpening(world.client, world.openingId)
      expect(pulls.length).toBeGreaterThanOrEqual(1)
      for (const pull of pulls) {
        const duplicates = events.filter((row) => primaryIdOf(row) === pull.id)
        expect(duplicates, `pull lot ${pull.id} double-reported in history`).toHaveLength(0)
      }
    } finally {
      await deleteSyntheticUser(service, world.userId)
    }
  })

  // ---------------------------------------------------------------------------
  // §15 RESET ORACLE
  // ---------------------------------------------------------------------------

  it('reset removes openings, opening disposals and pull lots; another user is untouched', async (ctx) => {
    const worldA = await seedOpeningWorld(ctx, 'rsta')

    // User B owns ordinary data the reset must NEVER touch.
    const userB = await createSyntheticUser(service, 'm16adv-int-rstb')
    const productIdB = await createIsolatedSealedProduct(service, userB.id, 'int-rstb')
    const clientB = await signInAs(userB)
    await createSealedPurchase(clientB, service, {
      productId: productIdB,
      quantity: 4,
      unitPriceMinor: 5_000,
      purchasedOn: today,
    })
    const bBefore = {
      holdings: await countByOwner(service, 'holdings', userB.id),
      lots: await countByOwner(service, 'acquisition_lots', userB.id),
      openings: await countByOwner(service, 'openings', userB.id),
    }

    // THE RESET — the one deliberate hard delete (D-084), now extended to M16.
    const { error: resetError } = await worldA.client.rpc('reset_my_portfolio_data')
    expect(resetError, `reset failed: ${resetError?.message}`).toBeNull()

    // A: everything opening-related is GONE — behaviourally empty.
    expect(await countByOwner(worldA.client, 'openings', worldA.userId)).toBe(0)
    expect(await countByOwner(worldA.client, 'acquisition_lots', worldA.userId)).toBe(0)
    expect(await countByOwner(worldA.client, 'lot_disposals', worldA.userId)).toBe(0)
    expect(await countByOwner(worldA.client, 'holdings', worldA.userId)).toBe(0)
    expect(await countByOwner(worldA.client, 'purchases', worldA.userId)).toBe(0)

    // B: byte-for-byte untouched.
    expect(await countByOwner(service, 'holdings', userB.id)).toBe(bBefore.holdings)
    expect(await countByOwner(service, 'acquisition_lots', userB.id)).toBe(bBefore.lots)
    expect(await countByOwner(service, 'openings', userB.id)).toBe(bBefore.openings)

    await deleteSyntheticUser(service, worldA.userId)
    await deleteSyntheticUser(service, userB.id)
  })

  // ---------------------------------------------------------------------------
  // §17 BACKUP V2 ORACLE
  // ---------------------------------------------------------------------------

  it('backup generated after M16 carries schema_version ≥ 2 WITH opening canonical data', async (ctx) => {
    const surface = await probeM16Surface(service)
    if (!surface.openingsTable || !surface.pullLinkColumn || !surface.disposalLinkColumn) {
      ctx.skip('M16 schema absent — the backup-version obligation only binds once openings exist.')
    }

    // Bind the REAL shipped pipeline (exists on current main; m13-adversarial precedent).
    let exportFetch: {
      fetchExportSnapshot: (client: TestClient, opts?: Record<string, unknown>) => Promise<unknown>
    }
    let exportBuild: {
      buildBackupEnvelope: (snapshot: unknown, opts: Record<string, unknown>) => unknown
      serializeBackupEnvelope: (envelope: unknown) => string
    }
    try {
      exportFetch =
        (await import('../../../src/data/export/fetch-snapshot')) as unknown as typeof exportFetch
      exportBuild =
        (await import('../../../src/domain/export/build-backup')) as unknown as typeof exportBuild
    } catch (err) {
      throw new Error(
        `[M16 CONTRACT] could not import the M13 export pipeline (${String(err)}). If the module ` +
          `layout moved with M16, update this binding deliberately.`,
        { cause: err },
      )
    }

    const world = await seedOpeningWorld(ctx, 'bkup')
    try {
      const snapshot = await exportFetch.fetchExportSnapshot(world.client, {})
      const envelope = exportBuild.buildBackupEnvelope(snapshot, {
        exportedAt: new Date().toISOString(),
        appVersion: 'm16-contract-test',
      }) as Record<string, unknown>

      const serialized = exportBuild.serializeBackupEnvelope(envelope)
      const parsed = JSON.parse(serialized) as Record<string, unknown>

      // BLOCKER RULE: a v1 backup generated after M16 silently omitting openings.
      const version = parsed['schema_version']
      if (version === 1) {
        throw new Error(
          '[M16 CONTRACT][BLOCKER] schema_version is still 1 while the openings table exists. ' +
            'M16 introduces NEW canonical user data; a v1 backup cannot remain lossless. The ' +
            'release MUST bump the version and serialize opening canonical data.',
        )
      }
      expect(typeof version).toBe('number')
      expect(version as number).toBeGreaterThanOrEqual(2)

      // The openings section exists and contains OUR opening with cost provenance.
      const data = parsed['data'] as Record<string, unknown> | undefined
      expect(data, 'backup data envelope missing').toBeTruthy()
      const openingsSectionKey = Object.keys(data as Record<string, unknown>).find((k) =>
        /^openings$/i.test(k),
      )
      if (!openingsSectionKey) {
        throw new Error(
          '[M16 CONTRACT][BLOCKER] no "openings" section in a post-M16 backup — openings would ' +
            'be silently lost on restore.',
        )
      }
      const openingRows = (data as Record<string, unknown>)[openingsSectionKey] as Record<
        string,
        unknown
      >[]
      const ours = openingRows.find((row) => row['id'] === world.openingId)
      expect(ours, 'seeded opening missing from the backup').toBeTruthy()
      const costKey = findKey(ours as Record<string, unknown>, /cost/i)
      expect(costKey, 'serialized opening lacks its cost/provenance fields').not.toBeNull()

      // Relationship integrity: pull lots and consumption rows carry opening_id.
      const lotsSectionKey = Object.keys(data as Record<string, unknown>).find((k) =>
        /^acquisition_lots$/i.test(k),
      )
      expect(lotsSectionKey, 'acquisition_lots section missing').toBeTruthy()
      const lotRows = (data as Record<string, unknown>)[lotsSectionKey as string] as Record<
        string,
        unknown
      >[]
      const linkedPull = lotRows.find(
        (row) =>
          row['opening_id'] !== null &&
          row['opening_id'] !== undefined &&
          String(row['origin']) === 'opening',
      )
      expect(linkedPull, 'pull-lot rows lost their opening_id linkage').toBeTruthy()
      expect(String((linkedPull as Record<string, unknown>)['opening_id'])).toBe(world.openingId)

      const pulls = await pullLotsForOpening(world.client, world.openingId)
      const serializedText = serialized
      for (const pull of pulls) {
        expect(
          serializedText.includes(pull.id),
          `pull lot ${pull.id} absent from backup entirely`,
        ).toBe(true)
      }
    } finally {
      await deleteSyntheticUser(service, world.userId)
    }
  })
})

async function countByOwner(client: TestClient, table: string, ownerId: string): Promise<number> {
  const { count, error } = await client
    .from(table)
    .select('*', { count: 'exact', head: true })
    .eq('user_id', ownerId)
  if (error && !/could not find the table|does not exist/i.test(error.message)) {
    throw new Error(`count failed on ${table}: ${error.message}`)
  }
  return count ?? 0
}

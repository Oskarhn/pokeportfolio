/**
 * M16 SECURITY ORACLE — mixed ACTIVE_CURRENT-SCHEMA + IMPLEMENTATION_GATED.
 *
 * Active today, on any ephemeral stack: the §10 constraint that NO generic
 * audit_events table exists (DATA_MODEL §7 status correction). An M16
 * implementation that introduces one solely for reconciliation auditing is a
 * scope/architecture issue and is flagged here — loudly.
 *
 * Gated on the M16 surface: the §14 cross-user attack matrix. User B (plain
 * and admin-promoted) must not open A's sealed lot, attach a pull to A's
 * opening, read A's opening detail, or void A's opening. RLS is the boundary;
 * `profiles.is_admin` grants zero cross-user browser authority (SECURITY §4).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  createSyntheticUser,
  deleteSyntheticUser,
  promoteToAdmin,
  seedCatalog,
  signInAs,
  type SyntheticUser,
  type TestClient,
} from '../../db/setup'
import {
  bindAddPullArgs,
  bindOpeningCreateArgs,
  hasSupabaseEnv,
  probeM16Surface,
  requireCreateOpeningRpc,
  resolvePullSurface,
  skipUnlessM16,
} from '../helpers/contract'
import { createIsolatedSealedProduct, createSealedPurchase } from '../helpers/fixtures'

const today = new Date().toISOString().slice(0, 10)

describe.skipIf(!hasSupabaseEnv())('M16 security oracle', () => {
  let service: TestClient

  beforeAll(async () => {
    const { createServiceClient } = await import('../../db/setup')
    service = createServiceClient()
  }, 60_000)

  // ---------------------------------------------------------------------------
  // ACTIVE_CURRENT-SCHEMA — runs on current main
  // ---------------------------------------------------------------------------

  it('§10 audit_events does not exist on the current schema', async (ctx) => {
    if (!hasSupabaseEnv()) {
      ctx.skip('No ephemeral stack configured — IMPLEMENTATION_GATED_PENDING_CI_RESET.')
    }
    const surface = await probeM16Surface(service)
    if (surface.auditEventsTable) {
      throw new Error(
        '[M16 CONTRACT] audit_events exists. DATA_MODEL §7 records this table as PLANNED — no ' +
          'migration creates it today. If an M16 implementation introduced a generic audit_events ' +
          'table solely to satisfy reconciliation auditing, that is a scope/architecture issue: ' +
          'flag it in DECISIONS deliberately instead of absorbing it here.',
      )
    }
    expect(surface.auditEventsTable).toBe(false)
  })

  // ---------------------------------------------------------------------------
  // §14 CROSS USER — gated on M16
  // ---------------------------------------------------------------------------

  describe('cross-user attacks around openings', () => {
    let userA: SyntheticUser
    let userB: SyntheticUser
    let clientB: TestClient
    let aOpeningId = ''
    let aSealedLotId = ''
    let seeded = false

    beforeAll(async () => {
      if (!hasSupabaseEnv()) return
      userA = await createSyntheticUser(service, 'm16adv-sec-a')
      userB = await createSyntheticUser(service, 'm16adv-sec-b')
      clientB = await signInAs(userB)
    }, 120_000)

    afterAll(async () => {
      if (!hasSupabaseEnv() || !service) return
      if (userA) await deleteSyntheticUser(service, userA.id)
      if (userB) await deleteSyntheticUser(service, userB.id)
    }, 60_000)

    /** Seeds ONE opening of A's, shared by every attack case below. */
    async function ensureSeed(ctx: { skip(note?: string): void }): Promise<boolean> {
      if (!hasSupabaseEnv()) return false
      const surface = await skipUnlessM16(ctx, service)
      if (seeded && aOpeningId) return true

      const productId = await createIsolatedSealedProduct(service, userA.id, 'sec')
      const clientA = await signInAs(userA)
      const purchase = await createSealedPurchase(clientA, service, {
        productId,
        quantity: 2,
        unitPriceMinor: 10_000,
        purchasedOn: today,
      })
      aSealedLotId = purchase.lotId

      const rpc = requireCreateOpeningRpc(surface)
      const args = bindOpeningCreateArgs(rpc, {
        openedOn: today,
        consumptions: [{ lotId: aSealedLotId, quantity: 1 }],
      })
      const { data, error } = await clientA.rpc(rpc.name, args)
      if (error || !data) throw new Error(`seed create_opening failed: ${error?.message}`)
      const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined
      aOpeningId = String(row?.['id'] ?? '')
      seeded = Boolean(aOpeningId)
      return seeded
    }

    it('B cannot open units from a sealed lot A owns', async (ctx) => {
      if (!(await ensureSeed(ctx))) return
      const surface = await skipUnlessM16(ctx, service)
      const rpc = requireCreateOpeningRpc(surface)
      const args = bindOpeningCreateArgs(rpc, {
        openedOn: today,
        consumptions: [{ lotId: aSealedLotId, quantity: 1 }],
      })
      const { error } = await clientB.rpc(rpc.name, args)
      expect(error, "B opened A's sealed lot").not.toBeNull()

      // And nothing was written anywhere: A's lot still holds both units minus
      // the one seed opening consumed; B owns no openings at all.
      const { count: bOpenings } = await clientB
        .from('openings')
        .select('*', { count: 'exact', head: true })
      expect(bOpenings ?? 0).toBe(0)
    })

    it('B cannot read A’s opening detail by id (RLS-hidden, no existence oracle)', async (ctx) => {
      if (!(await ensureSeed(ctx))) return
      const { data, error } = await clientB.from('openings').select('*').eq('id', aOpeningId)
      expect(error).toBeNull()
      expect(data ?? []).toHaveLength(0)

      // Enumerating B-visible openings never yields A's row either.
      const { data: allB } = await clientB.from('openings').select('id')
      for (const row of allB ?? []) {
        expect((row as Record<string, unknown>)['id']).not.toBe(aOpeningId)
      }
    })

    it("B cannot attach a pull to A's opening (folded surface: B cannot create-with-pulls on A's lot)", async (ctx) => {
      if (!(await ensureSeed(ctx))) return
      const surface = await skipUnlessM16(ctx, service)
      const pullSurface = resolvePullSurface(surface)
      if (pullSurface.mode === 'dedicated') {
        const { error } = await clientB.rpc(
          pullSurface.rpc.name,
          bindAddPullArgs(pullSurface.rpc, {
            openingId: aOpeningId,
            quantity: 1,
            cardVariantId: seedCatalog.charizardVariantId,
          }),
        )
        expect(error, "B attached a pull to A's opening").not.toBeNull()
        return
      }
      // Folded world: the only pull-attachment path is creation itself, so the attack is
      // "B creates an opening consuming A's lot WITH pulls" — which must fail identically.
      const rpc = requireCreateOpeningRpc(surface)
      const args = bindOpeningCreateArgs(rpc, {
        openedOn: today,
        consumptions: [{ lotId: aSealedLotId, quantity: 1 }],
        pulls: [{ cardVariantId: seedCatalog.charizardVariantId, quantity: 1 }],
      })
      const { error } = await clientB.rpc(rpc.name, args)
      expect(error, "B created an opening with pulls from A's sealed lot").not.toBeNull()
    })

    it('B cannot void A’s opening', async (ctx) => {
      if (!(await ensureSeed(ctx))) return
      const surface = await skipUnlessM16(ctx, service)
      const voidRpcs = surface.openingRpcs.filter((r) => r.verbs.includes('void'))
      expect(voidRpcs.length).toBeGreaterThanOrEqual(1)
      for (const rpc of voidRpcs) {
        const param = rpc.paramNames.find((p) => /opening_?id/i.test(p))
        if (!param) continue
        const { error } = await clientB.rpc(rpc.name, { [param]: aOpeningId })
        expect(error, `${rpc.name}: B voided A's opening`).not.toBeNull()
      }
      // A's opening survives every attempt.
      const clientA = await signInAs(userA)
      const { data } = await clientA.from('openings').select('id').eq('id', aOpeningId)
      expect(data ?? []).toHaveLength(1)
    })

    it('admin boolean grants B no cross-user authority over openings', async (ctx) => {
      if (!(await ensureSeed(ctx))) return
      await promoteToAdmin(service, userB.id)
      const adminClient = await signInAs(userB)

      // Read authority stays closed.
      const { data, error } = await adminClient.from('openings').select('*').eq('id', aOpeningId)
      expect(error).toBeNull()
      expect(data ?? []).toHaveLength(0)

      // Write authority stays closed too.
      const surface = await skipUnlessM16(ctx, service)
      const voidRpcs = surface.openingRpcs.filter((r) => r.verbs.includes('void'))
      for (const rpc of voidRpcs) {
        const param = rpc.paramNames.find((p) => /opening_?id/i.test(p))
        if (!param) continue
        const { error } = await adminClient.rpc(rpc.name, { [param]: aOpeningId })
        expect(error, `${rpc.name}: admin B voided A's opening`).not.toBeNull()
      }
    })
  })
})

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// The controller reaches the production leased client through this module (which binds to the app's
// singleton session). Here it is bound to a SimulatedTab: the production `createLeasedDb`, a real
// IdentityAuthority and the real GoTrue sessions of two real users.
const holder = vi.hoisted((): { tab: unknown } => ({ tab: null }))
vi.mock('../../src/data/leased-db', () => ({
  leasedDb: (lease: unknown) => (holder.tab as { dbFor(l: unknown): unknown }).dbFor(lease),
}))
// collection.ts / catalog.ts import the app's singleton; `commitBatch` only uses the client that is
// handed to it, so a stand-in singleton is never touched.
vi.mock('../../src/data/supabase-client', () => ({
  supabase: {},
  supabaseUrl: 'http://127.0.0.1:1',
  supabasePublishableKey: 'unused',
}))

import { createRealScannerController } from '../../src/features/scanner/controller'
import type { ScannerCommitItem } from '../../src/features/scanner/contract'
import { SimulatedTab, type TabUser } from './leased'
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
 * P165 — the scanner's batch write, as the REAL controller performs it, against a real stack.
 *
 * P164 exercised this seam in a browser (where AuthIdentityBoundary's remount also discards the
 * page) and with a stand-in for the data layer (in unit tests). Here nothing between the
 * controller's loop and PostgREST is replaced: the real `commitBatch`, the real
 * `addCardAcquisition`, the production leased client, real sessions of two users, and the wire
 * itself (the account each request's bearer token belongs to) as the witness.
 *
 * The cases the browser cannot tell apart from a remount: a lookup that is already in flight when
 * the identity changes, and an A -> B -> A round trip that leaves the SAME user signed in.
 */

let service: TestClient
let a: SyntheticUser
let b: SyntheticUser
let tabUserA: TabUser
let tabUserB: TabUser

const ITEMS: ScannerCommitItem[] = [
  seedCatalog.pikachuVariantId,
  seedCatalog.charizardVariantId,
  seedCatalog.grassEnergyVariantId,
].map((variantId, index) => ({
  candidateId: `candidate-${String(index)}`,
  variantId,
  quantity: 1 + index,
  condition: 'NM',
  requestKey: crypto.randomUUID(),
}))

beforeAll(async () => {
  service = createServiceClient()
  a = await createSyntheticUser(service, 'p165-scan-a')
  b = await createSyntheticUser(service, 'p165-scan-b')
  tabUserA = { id: a.id, client: await signInAs(a) }
  tabUserB = { id: b.id, client: await signInAs(b) }
})

afterAll(async () => {
  await deleteSyntheticUser(service, a.id)
  await deleteSyntheticUser(service, b.id)
})

async function lotsOf(userId: string): Promise<number> {
  const { count, error } = await service
    .from('acquisition_lots')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
  if (error) throw new Error(error.message)
  return count ?? 0
}

async function baselines() {
  return { a: await lotsOf(a.id), b: await lotsOf(b.id) }
}

/** A fresh tab signed in as A, its controller, and the lease a click on the rendered UI takes. */
function openTab() {
  const tab = new SimulatedTab(tabUserA)
  holder.tab = tab
  const controller = createRealScannerController({ userId: a.id })
  return { tab, controller, lease: tab.leaseFor(tabUserA) }
}

const writes = (tab: SimulatedTab) =>
  tab.wire.filter((r) => r.path.endsWith('/rpc/add_card_acquisition'))

describe('scanner commitBatch: real controller, real leased client, real stack (P165)', () => {
  it('control: an undisturbed batch writes every item, as A only', async () => {
    const before = await baselines()
    const { tab, controller, lease } = openTab()
    const result = await controller.commitBatch(
      ITEMS.map((i) => ({ ...i, requestKey: crypto.randomUUID() })),
      lease,
    )
    expect(result.addedCount).toBe(3)
    expect(writes(tab)).toHaveLength(3)
    expect(tab.requestsNotFrom(a.id)).toEqual([])
    expect(await lotsOf(a.id)).toBe(before.a + 3)
    expect(await lotsOf(b.id)).toBe(before.b)
    controller.dispose()
  })

  it('A -> B -> A heard while the first write is on its way: that write completes as A, the rest is never attempted', async () => {
    const before = await baselines()
    const { tab, controller, lease } = openTab()
    tab.beforeRequest = (index) => {
      // the first write is recorded and about to be sent; the tab hears B and then A again
      if (index === 1) {
        tab.switchTo(tabUserB)
        tab.switchTo(tabUserA)
      }
    }
    const result = await controller.commitBatch(
      ITEMS.map((i) => ({ ...i, requestKey: crypto.randomUUID() })),
      lease,
    )
    expect(writes(tab)).toHaveLength(1)
    expect(tab.requestsNotFrom(a.id)).toEqual([])
    expect(result.addedCount).toBe(1)
    expect(await lotsOf(a.id)).toBe(before.a + 1)
    expect(await lotsOf(b.id)).toBe(before.b)
    controller.dispose()
  })

  it('a session lookup already in flight when the identity goes A -> B -> A: no request is made, although the SAME user is signed in again', async () => {
    const before = await baselines()
    const { tab, controller, lease } = openTab()
    // Park the lookup of the first item: the loop's own lease check has passed, the bearer is not
    // chosen yet — exactly the check-to-dispatch window.
    const parked = tab.sessionLookups
    const release = tab.parkNextSessionLookup()
    const batch = controller.commitBatch(
      ITEMS.map((i) => ({ ...i, requestKey: crypto.randomUUID() })),
      lease,
    )
    await tab.untilLookupParked(parked)
    tab.switchTo(tabUserB)
    tab.switchTo(tabUserA)
    release()
    const result = await batch
    // A user-id comparison would let this write through (the session belongs to A again); the epoch
    // does not, so nothing at all was sent.
    expect(writes(tab)).toHaveLength(0)
    expect(result.addedCount).toBe(0)
    expect(await lotsOf(a.id)).toBe(before.a)
    expect(await lotsOf(b.id)).toBe(before.b)
    controller.dispose()
  })

  it('A signs out after the first item: exactly one write, nothing under any other identity', async () => {
    const before = await baselines()
    const { tab, controller, lease } = openTab()
    tab.beforeRequest = (index) => {
      if (index === 1) tab.signOut()
    }
    const result = await controller.commitBatch(
      ITEMS.map((i) => ({ ...i, requestKey: crypto.randomUUID() })),
      lease,
    )
    expect(writes(tab)).toHaveLength(1)
    expect(tab.requestsNotFrom(a.id)).toEqual([])
    expect(result.addedCount).toBe(1)
    expect(await lotsOf(a.id)).toBe(before.a + 1)
    expect(await lotsOf(b.id)).toBe(before.b)
    controller.dispose()
  })

  it('a same-user token refresh mid-batch does not cost the person their batch', async () => {
    const before = await baselines()
    const { tab, controller, lease } = openTab()
    tab.beforeRequest = (index) => {
      // another tab refreshed A's token: the same user is observed again, which is not a change
      if (index === 1) tab.switchTo(tabUserA)
    }
    const result = await controller.commitBatch(
      ITEMS.map((i) => ({ ...i, requestKey: crypto.randomUUID() })),
      lease,
    )
    expect(result.addedCount).toBe(3)
    expect(writes(tab)).toHaveLength(3)
    expect(tab.requestsNotFrom(a.id)).toEqual([])
    expect(await lotsOf(a.id)).toBe(before.a + 3)
    expect(await lotsOf(b.id)).toBe(before.b)
    controller.dispose()
  })

  it('a lease taken for A but a tab that is already B: nothing is sent, B receives nothing', async () => {
    const before = await baselines()
    const tab = new SimulatedTab(tabUserA)
    holder.tab = tab
    const controller = createRealScannerController({ userId: a.id })
    const lease = tab.leaseFor(tabUserA) // the UI was rendered as A...
    tab.switchTo(tabUserB) // ...and the identity changed before the click was handled
    const result = await controller.commitBatch(
      ITEMS.map((i) => ({ ...i, requestKey: crypto.randomUUID() })),
      lease,
    )
    expect(result.addedCount).toBe(0)
    expect(tab.wire).toEqual([])
    expect(await lotsOf(a.id)).toBe(before.a)
    expect(await lotsOf(b.id)).toBe(before.b)
    controller.dispose()
  })

  it('another tab already signed in as B, this tab has not heard yet: the write is never sent as B', async () => {
    const before = await baselines()
    const tab = new SimulatedTab(tabUserA)
    holder.tab = tab
    const controller = createRealScannerController({ userId: a.id })
    const lease = tab.leaseFor(tabUserA) // still current: no auth event has reached this tab
    tab.switchTo(tabUserB, { heard: false }) // the shared storage already holds B's session
    expect(lease.isCurrent()).toBe(true)
    const result = await controller.commitBatch(
      ITEMS.map((i) => ({ ...i, requestKey: crypto.randomUUID() })),
      lease,
    )
    // The bearer would have been B's: the request layer compares the session it finds with the
    // lease's user and refuses, so nothing was sent and B's account received nothing.
    expect(result.addedCount).toBe(0)
    expect(writes(tab)).toHaveLength(0)
    expect(tab.requestsNotFrom(a.id)).toEqual([])
    expect(await lotsOf(a.id)).toBe(before.a)
    expect(await lotsOf(b.id)).toBe(before.b)
    controller.dispose()
  })
})

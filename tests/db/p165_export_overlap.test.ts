import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AuthIdentityChangedError } from '../../src/auth/identity-lease'
import { exportCsvArtifacts, exportJsonBackup } from '../../src/data/export/artifacts'
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
 * P165 — two exports of two accounts OVERLAP in one browser tab.
 *
 * P162 proves that A's export dies when the identity changes (A -> B, A -> B -> A, sign-out) with
 * one export at a time. The seam P164 composed also has this shape: A's export is under way, the tab
 * becomes B, B opens the export page and completes B's own export, and only then does the network
 * hand A's held request its answer. Nothing of A may end up in B's files, A's export must not
 * produce anything, and it must not send another request after it was released.
 *
 * Witnesses are independent of the export code: private markers in each account's data, and the
 * account each request's bearer token belongs to (`SimulatedTab.wire`).
 */

const A_MARKER = 'A-OVERLAP-MARKER-p165-3e7a'
const B_MARKER = 'B-OVERLAP-MARKER-p165-b41c'

let service: TestClient
let a: SyntheticUser
let b: SyntheticUser
let tabUserA: TabUser
let tabUserB: TabUser

beforeAll(async () => {
  service = createServiceClient()
  a = await createSyntheticUser(service, 'p165-exp-a')
  b = await createSyntheticUser(service, 'p165-exp-b')
  tabUserA = { id: a.id, client: await signInAs(a) }
  tabUserB = { id: b.id, client: await signInAs(b) }
  for (const [user, marker, client] of [
    [a, A_MARKER, tabUserA.client],
    [b, B_MARKER, tabUserB.client],
  ] as const) {
    const { error } = await client
      .rpc('add_card_acquisition', {
        p_card_variant_id: seedCatalog.pikachuVariantId,
        p_grading_state: 'raw',
        p_condition: 'NM',
        p_origin: 'pre_tracking',
        p_cost_basis_state: 'unknown',
        p_quantity: 2,
        p_acquired_on: new Date().toISOString().slice(0, 10),
        p_client_request_key: crypto.randomUUID(),
      })
      .single()
    if (error) throw new Error(`ledger for ${user.id}: ${error.message}`)
    const retailer = await service.from('retailers').insert({ user_id: user.id, name: marker })
    if (retailer.error) throw new Error(`marker for ${user.id}: ${retailer.error.message}`)
  }
})

afterAll(async () => {
  await deleteSyntheticUser(service, a.id)
  await deleteSyntheticUser(service, b.id)
})

async function textOf(blob: Blob): Promise<string> {
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(await blob.arrayBuffer())
}

/** Runs A's export until its `holdAt`-th request is about to be sent, and holds that request. */
function startHeldExportOfA(tab: SimulatedTab, holdAt: number) {
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let reached: () => void = () => undefined
  const held = new Promise<void>((resolve) => {
    reached = resolve
  })
  tab.beforeRequest = async (index) => {
    if (index === holdAt) {
      reached()
      await gate
    }
  }
  const leaseA = tab.leaseFor(tabUserA)
  const exportA = exportCsvArtifacts({ pageSize: 1 }, tab.dbFor(leaseA))
  // The rejection is asserted later; observe it now so it is never "unhandled" while B works.
  const outcome = exportA.then(
    (files) => ({ files }) as const,
    (error: unknown) => ({ error }) as const,
  )
  return { held, release, outcome }
}

describe('two exports overlapping in one tab across an account change (P165)', () => {
  it("A's held export ends dead; B's own export, run meanwhile, holds only B's data", async () => {
    const tab = new SimulatedTab(tabUserA)
    const { held, release, outcome } = startHeldExportOfA(tab, 4)
    await held // A's 4th request is recorded and parked before it leaves the browser
    expect(tab.wire).toHaveLength(4)

    // The tab hears B (another tab signed in). B opens the export page and exports everything.
    tab.switchTo(tabUserB)
    tab.beforeRequest = null // B's export is not held
    const leaseB = tab.leaseFor(tabUserB)
    const bJson = await textOf((await exportJsonBackup({ pageSize: 1 }, tab.dbFor(leaseB))).blob)
    const bFiles = await exportCsvArtifacts({ pageSize: 1 }, tab.dbFor(leaseB))
    const requestsAfterB = tab.wire.length
    expect(requestsAfterB).toBeGreaterThan(40)

    // Only now does the network hand A's parked request its turn.
    release()
    const result = await outcome
    expect('error' in result && result.error).toBeInstanceOf(AuthIdentityChangedError)
    expect('files' in result).toBe(false)

    // A's export sent nothing further once it was released (the parked request itself is already
    // in the log, sent while A's bearer was the only one it had chosen).
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(tab.wire).toHaveLength(requestsAfterB)

    // Every request up to the parked one is A's; every request after it is B's.
    expect(tab.wire.slice(0, 4).every((r) => r.bearerSub === a.id)).toBe(true)
    expect(tab.wire.slice(4).every((r) => r.bearerSub === b.id)).toBe(true)

    // B's files: B's data, none of A's.
    const everything = [bJson, ...(await Promise.all(bFiles.map((f) => textOf(f.blob))))].join('\n')
    expect(everything).toContain(B_MARKER)
    expect(everything).not.toContain(A_MARKER)
    expect(everything).not.toContain(a.id)
  }, 120_000)

  it('and when the tab goes A -> B -> A before the parked request is released, A still gets nothing', async () => {
    const tab = new SimulatedTab(tabUserA)
    const { held, release, outcome } = startHeldExportOfA(tab, 3)
    await held
    tab.switchTo(tabUserB)
    tab.switchTo(tabUserA) // the SAME user is back, in a new generation
    release()
    const result = await outcome
    expect('error' in result && result.error).toBeInstanceOf(AuthIdentityChangedError)
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(tab.wire).toHaveLength(3)
    expect(tab.requestsNotFrom(a.id)).toEqual([])
  }, 60_000)

  it("the identity ends while A's LAST request is in flight: no further request exists to refuse, yet the export still rejects", async () => {
    // How many requests the export takes when nothing interferes.
    const probe = new SimulatedTab(tabUserA)
    await exportCsvArtifacts({ pageSize: 1 }, probe.dbFor(probe.leaseFor(tabUserA)))
    const total = probe.wire.length
    expect(total).toBeGreaterThan(10)

    const tab = new SimulatedTab(tabUserA)
    const { held, release, outcome } = startHeldExportOfA(tab, total)
    await held // the very last request is parked before it is sent
    tab.switchTo(tabUserB)
    release()
    const result = await outcome
    // Only the check after the answer can catch this: the leased client has nothing left to gate.
    expect('error' in result && result.error).toBeInstanceOf(AuthIdentityChangedError)
    expect('files' in result).toBe(false)
    expect(tab.wire).toHaveLength(total)
    expect(tab.requestsNotFrom(a.id)).toEqual([])
  }, 120_000)

  it('control: the same export, undisturbed, is complete and contains only A', async () => {
    const tab = new SimulatedTab(tabUserA)
    const db = tab.dbFor(tab.leaseFor(tabUserA))
    const files = await exportCsvArtifacts({ pageSize: 1 }, db)
    const json = await exportJsonBackup({ pageSize: 1 }, db)
    const text = (await Promise.all([json, ...files].map((f) => textOf(f.blob)))).join('\n')
    expect(text).toContain(A_MARKER)
    expect(text).not.toContain(B_MARKER)
    expect(tab.requestsNotFrom(a.id)).toEqual([])
  }, 60_000)
})

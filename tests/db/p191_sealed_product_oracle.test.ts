import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  signInAs,
  type SyntheticUser,
  type TestClient,
} from './setup'

/**
 * P130-14: a private sealed-product UUID must not be an existence oracle, and one user must not be
 * able to pin another user's private row.
 *
 * `sealed_products` rows are curated (created_by_user_id null, visible to all) or private (visible
 * to the creator only). The alleged oracle: user B learns whether A's private UUID exists from
 * anything that distinguishes it from a random UUID — an error code, a message, a JSON shape — on
 * any write path that names a sealed product. Reproduction before the P191 migrations, all three
 * paths below leaked:
 *   - INSERT into sealed_products with an explicit `id`: 23505 for A's UUID, success for a random one;
 *   - holdings / purchase_lines INSERT naming A's UUID: accepted (the foreign key check bypasses RLS)
 *     where a random UUID gave 23503 — and the accepted row then pinned A's product undeletable;
 *   - A's deletion of their own product failed with 23503 because of B's row.
 *
 * Responses are compared by category (SQLSTATE, message class, JSON key set). Timing is not asserted.
 */

let service: TestClient
let userA: SyntheticUser
let userB: SyntheticUser
let clientA: TestClient
let clientB: TestClient
let privateOfA: string
let curated: string
let deletedOfA: string
const today = new Date().toISOString().slice(0, 10)
const RANDOM = () => crypto.randomUUID()

interface Observed {
  ok: boolean
  code: string | null
  messageClass: string
  keys: string
}

function classify(message: string): string {
  return message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    .replace(/\d+/g, '<n>')
}

function observe(result: {
  error: { code?: string; message: string; details?: string | null; hint?: string | null } | null
}): Observed {
  if (!result.error) return { ok: true, code: null, messageClass: '', keys: '' }
  const e = result.error
  return {
    ok: false,
    code: e.code ?? null,
    // details can carry the probed key itself ("Key (id)=(...)"); it must not differ in class either.
    messageClass: classify(`${e.message} | ${e.details ?? ''}`),
    keys: Object.keys(e).sort().join(','),
  }
}

beforeAll(async () => {
  service = createServiceClient()
  userA = await createSyntheticUser(service, 'p191-oracle-a')
  userB = await createSyntheticUser(service, 'p191-oracle-b')
  clientA = await signInAs(userA)
  clientB = await signInAs(userB)

  const mk = async (name: string) => {
    const { data, error } = await clientA
      .from('sealed_products')
      .insert({ name, language: 'en', product_type: 'other', created_by_user_id: userA.id })
      .select('id')
      .single()
    if (error) throw new Error(error.message)
    return data.id
  }
  privateOfA = await mk(`p191-private-${Date.now()}`)
  deletedOfA = await mk(`p191-deleted-${Date.now()}`)
  const del = await clientA.from('sealed_products').delete().eq('id', deletedOfA)
  if (del.error) throw new Error(del.error.message)
  const { data: cur } = await service
    .from('sealed_products')
    .select('id')
    .is('created_by_user_id', null)
    .limit(1)
    .single()
  curated = cur!.id
})

afterAll(async () => {
  await deleteSyntheticUser(service, userA.id)
  await deleteSyntheticUser(service, userB.id)
})

async function viaPurchase(client: TestClient, productId: string) {
  return observe(
    await client.rpc('create_purchase', {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: [
        { line_type: 'sealed', sealed_product_id: productId, quantity: 1, unit_price_minor: 1000 },
      ],
    }),
  )
}

async function viaAcquisition(client: TestClient, productId: string) {
  return observe(
    await client.rpc('add_card_acquisition', {
      p_sealed_product_id: productId,
      p_grading_state: 'raw',
      p_origin: 'pre_tracking',
      p_cost_basis_state: 'unknown',
      p_quantity: 1,
      p_acquired_on: today,
      p_sealed_intent: 'undecided',
    }),
  )
}

async function viaProvisionalOpening(client: TestClient, productId: string) {
  return observe(
    await client.rpc('create_opening_from_provisional', {
      p_sealed_product_id: productId,
      p_quantity: 1,
      p_total_paid_minor: 1000,
      p_purchased_on: today,
      p_opened_on: today,
      p_tracking_completeness: 'untracked',
      p_pulls: [],
    }),
  )
}

describe('P130-14 — B cannot tell A’s private UUID from a random one', () => {
  const PATHS: [string, (c: TestClient, id: string) => Promise<Observed>][] = [
    ['create_purchase', viaPurchase],
    ['add_card_acquisition', viaAcquisition],
    ['create_opening_from_provisional', viaProvisionalOpening],
    [
      'direct holdings insert',
      async (c, id) =>
        observe(
          await c.from('holdings').insert({
            user_id: userB.id,
            holding_kind: 'sealed',
            sealed_product_id: id,
          }),
        ),
    ],
    [
      'direct purchase_lines insert',
      async (c, id) =>
        observe(
          await c.from('purchase_lines').insert({
            user_id: userB.id,
            purchase_id: RANDOM(),
            line_type: 'sealed',
            spend_class: 'sealed_product',
            sealed_product_id: id,
            quantity: 1,
            unit_price_minor: 1,
            line_total_minor: 1,
          }),
        ),
    ],
  ]

  for (const [name, probe] of PATHS) {
    it(`${name}: random, other-user private and deleted UUIDs are indistinguishable`, async () => {
      const random = await probe(clientB, RANDOM())
      const foreign = await probe(clientB, privateOfA)
      const deleted = await probe(clientB, deletedOfA)
      expect(foreign).toEqual(random)
      expect(deleted).toEqual(random)
      // And none of them succeeded: referencing a product B cannot see is refused.
      expect(foreign.ok).toBe(false)
    })
  }

  it('malformed UUID is a validation error identical for every caller (no existence signal)', async () => {
    const asB = await viaAcquisition(clientB, 'not-a-uuid')
    const asA = await viaAcquisition(clientA, 'not-a-uuid')
    expect(asB.ok).toBe(false)
    expect(asB).toEqual(asA)
  })

  it('rapid repeated probes keep returning the same category (no stateful tell)', async () => {
    const seen = new Set<string>()
    for (let i = 0; i < 8; i++) {
      seen.add(JSON.stringify(await viaAcquisition(clientB, privateOfA)))
      seen.add(JSON.stringify(await viaAcquisition(clientB, RANDOM())))
    }
    expect(seen.size).toBe(1)
  })

  it('sealed_products INSERT with a caller-chosen id gives the same answer for A’s UUID as for a random one', async () => {
    const attempt = async (id: string) =>
      observe(
        await clientB
          .from('sealed_products')
          .insert({
            id,
            name: 'probe',
            language: 'en',
            product_type: 'other',
            created_by_user_id: userB.id,
          })
          .select('id'),
      )
    const random = await attempt(RANDOM())
    const foreign = await attempt(privateOfA)
    expect(foreign).toEqual(random)
  })

  it('sealed_products UPDATE / DELETE of A’s UUID looks like a UUID that does not exist', async () => {
    const upd = async (id: string) =>
      observe(await clientB.from('sealed_products').update({ name: 'x' }).eq('id', id))
    const del = async (id: string) =>
      observe(await clientB.from('sealed_products').delete().eq('id', id))
    expect(await upd(privateOfA)).toEqual(await upd(RANDOM()))
    expect(await del(privateOfA)).toEqual(await del(RANDOM()))
  })
})

describe('P130-14 — the legitimate paths still work', () => {
  it('A can reference their own private product', async () => {
    const own = await viaAcquisition(clientA, privateOfA)
    expect(own.ok).toBe(true)
  })

  it('anyone can reference a curated product', async () => {
    expect((await viaAcquisition(clientB, curated)).ok).toBe(true)
  })
})

describe('P130-14 — B cannot pin A’s private product', () => {
  it('A can delete their private product while B has tried to reference it', async () => {
    const { data, error } = await clientA
      .from('sealed_products')
      .insert({
        name: `p191-pin-${Date.now()}`,
        language: 'en',
        product_type: 'other',
        created_by_user_id: userA.id,
      })
      .select('id')
      .single()
    expect(error).toBeNull()
    await viaAcquisition(clientB, data!.id)
    await viaPurchase(clientB, data!.id)
    const del = await clientA.from('sealed_products').delete().eq('id', data!.id)
    expect(del.error).toBeNull()
    const gone = await service.from('sealed_products').select('id').eq('id', data!.id)
    expect(gone.data).toHaveLength(0)
  })

  it('the ownership trigger refuses a cross-user reference even for a superuser-written row', async () => {
    // Service role bypasses RLS and grants but not triggers: the invariant lives in the schema.
    const { error } = await service.from('holdings').insert({
      user_id: userB.id,
      holding_kind: 'sealed',
      sealed_product_id: privateOfA,
    })
    expect(error).not.toBeNull()
    const own = await clientA
      .from('sealed_products')
      .insert({
        name: `p191-own-${Date.now()}`,
        language: 'en',
        product_type: 'other',
        created_by_user_id: userA.id,
      })
      .select('id')
      .single()
    const ok = await service.from('holdings').insert({
      user_id: userA.id,
      holding_kind: 'sealed',
      sealed_product_id: own.data!.id,
    })
    expect(ok.error).toBeNull()
  })
})

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { rawSqlAvailable, runRawSqlAsync } from './raw-sql'
import {
  createAnonClient,
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  type SyntheticUser,
  type TestClient,
} from './setup'

/**
 * P146 / P130-19 — WHERE exactness is first lost, layer by layer, against the real local stack.
 *
 * One exact bigint is stored, then followed outward:
 *
 *   L1  Postgres            select total_minor::text            exact
 *   L2  PostgREST wire      the raw HTTP body, before parsing   exact  (the literal digits)
 *   L3  JSON.parse          the first JavaScript number         LOST   <- first layer that loses it
 *   L4  supabase-js         what an unguarded client returns    LOST   (it is JSON.parse's output)
 *   L5  application        Number(bigint) / arithmetic         LOST   (write side: see p146_exact_money_roundtrip)
 *
 * These are facts about the platform, not about this repository's code, so they are asserted
 * unconditionally: they are the reason `src/data/money.ts` and the wire guard exist. Nothing here
 * imports application code except where a layer of the application is the subject.
 */

let service: TestClient
let user: SyntheticUser

const today = new Date().toISOString().slice(0, 10)

/** Every value here is a non-negative purchase total, the one signed-range shape purchases allow. */
const SAFE_MAX = BigInt(Number.MAX_SAFE_INTEGER) // 2^53 - 1
const CASES: { label: string; value: bigint }[] = [
  { label: '2^53 - 1 (largest safe integer)', value: SAFE_MAX },
  { label: '2^53 (exactly representable, but ambiguous)', value: SAFE_MAX + 1n },
  { label: '2^53 + 1 (first integer a double cannot hold)', value: SAFE_MAX + 2n },
  { label: '2^58 + 3 (P144 observed a 2-unit drift here)', value: 2n ** 58n + 3n },
  { label: 'a 63-bit value near bigint max', value: 2n ** 62n + 12_345n },
]

beforeAll(async () => {
  service = createServiceClient()
  user = await createSyntheticUser(service, 'p146-layers')
})

afterAll(async () => {
  await deleteSyntheticUser(service, user.id)
})

async function insertPurchase(value: bigint): Promise<string> {
  const text = value.toString()
  const { data, error } = await service
    .from('purchases')
    .insert({
      user_id: user.id,
      purchased_on: today,
      currency: 'NOK',
      subtotal_minor: text,
      total_minor: text,
      fx_rate_date: today,
      total_nok_minor: text,
    } as never)
    .select('id')
    .single()
  expect(error).toBeNull()
  return (data as { id: string }).id
}

/** The raw HTTP body of a PostgREST read, exactly as it crosses the wire, before any parsing. */
async function rawWireBody(purchaseId: string, select: string): Promise<string> {
  const response = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/purchases?id=eq.${purchaseId}&select=${encodeURIComponent(select)}`,
    {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY as string,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY as string}`,
      },
    },
  )
  expect(response.status).toBe(200)
  return response.text()
}

describe('P130-19 — the layers a bigint crosses on the way to JavaScript', () => {
  for (const { label, value } of CASES) {
    describe(label, () => {
      let purchaseId: string
      beforeAll(async () => {
        purchaseId = await insertPurchase(value)
      })

      it.skipIf(!rawSqlAvailable())('L1 database: the stored value is exact', async () => {
        const result = await runRawSqlAsync(
          `select total_minor::text from public.purchases where id = '${purchaseId}';`,
        )
        expect(result.code).toBe(0)
        expect(result.output.trim()).toBe(value.toString())
      })

      it('L2 PostgREST wire: the response body carries the exact digits (the wire is NOT lossy)', async () => {
        const body = await rawWireBody(purchaseId, 'total_minor')
        // A bare JSON number literal — no quotes, no exponent, every digit present.
        expect(body).toBe(`[{"total_minor":${value.toString()}}]`)
      })

      it('L2b PostgREST wire: an explicit ::text cast is a JSON string with the same digits', async () => {
        const body = await rawWireBody(purchaseId, 'total_minor::text')
        expect(body).toBe(`[{"total_minor":"${value.toString()}"}]`)
      })

      it('L3 JSON.parse of the exact wire body: exact only while the value is a safe integer', () => {
        const parsed = JSON.parse(`[{"total_minor":${value.toString()}}]`) as [
          { total_minor: number },
        ]
        const seen = parsed[0].total_minor
        if (value <= SAFE_MAX) {
          expect(BigInt(seen)).toBe(value)
        } else {
          // The first layer that loses exactness: the digits were fine, the double is not.
          // (2^53 itself survives numerically but is indistinguishable from 2^53 + 1, so it is
          // outside the safe range too.)
          if (value !== SAFE_MAX + 1n) expect(BigInt(seen)).not.toBe(value)
          expect(Number.isSafeInteger(seen)).toBe(false)
        }
      })

      it('L4 supabase-js (an unguarded client) hands the application the same lost number', async () => {
        const client = createAnonClient()
        // Anonymous clients cannot read purchases (RLS), so read as the service role: the layer
        // under test is the client's JSON handling, which is identical for every role.
        void client
        const { data, error } = await service
          .from('purchases')
          .select('total_minor')
          .eq('id', purchaseId)
          .single()
        expect(error).toBeNull()
        const seen = (data as unknown as { total_minor: number }).total_minor
        expect(typeof seen).toBe('number')
        if (value <= SAFE_MAX) {
          expect(BigInt(seen)).toBe(value)
        } else if (value !== SAFE_MAX + 1n) {
          expect(BigInt(seen)).not.toBe(value)
        }
        // And re-serialising the wrong number to a bigint (BigInt(number)) keeps the wrong value:
        // there is no recovering the original digits once JSON.parse has run.
      })
    })
  }

  it('L5 application: Number(bigint) rounds before any request exists', () => {
    const requested = SAFE_MAX + 2n // 2^53 + 1
    const sent = JSON.stringify({ p_value_minor: Number(requested) })
    expect(sent).toBe('{"p_value_minor":9007199254740992}')
    expect(BigInt(JSON.parse(sent).p_value_minor as number)).not.toBe(requested)
  })

  it('L6 arithmetic: sums of individually safe values leave the safe range', () => {
    // Two values that are each exactly representable sum to one that is not: 2^53 - 1 + 2 is
    // 2^53 + 1, which a double rounds (ties-to-even) to 2^53.
    const a = SAFE_MAX
    const b = 2n
    const exact = a + b
    expect(Number.isSafeInteger(Number(a))).toBe(true)
    expect(Number.isSafeInteger(Number(b))).toBe(true)
    expect(BigInt(Number(a) + Number(b))).not.toBe(exact)
  })
})

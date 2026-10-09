import { afterAll, describe, expect, it } from 'vitest'
import {
  createInvitationDirect,
  createServiceClient,
  deleteSyntheticUser,
  randomInvitationToken,
  syntheticPassword,
} from '../db/setup'
import { boundedPost } from '../db/lib/bounded-post'

/**
 * P200: the public, unauthenticated redeem-invitation endpoint bounds what it reads.
 *
 * Before: `await request.json()` buffered whatever the caller streamed, and a JSON body of `null`
 * reached `body.token` and raised a TypeError (a 500 from the runtime instead of a 400). Anyone on
 * the internet can POST here, so the body is capped (4 KiB; a valid body is under 1 KiB) before
 * anything is parsed, mirroring delete-account (P152). Sizes stay at or below 8 KiB: above ~16 KiB
 * the LOCAL gateway intermittently loses an early refusal (docs/TESTING.md, P196C).
 */

const service = createServiceClient()
const URL_ = `${process.env.SUPABASE_URL}/functions/v1/redeem-invitation`
const ANON = process.env.SUPABASE_ANON_KEY as string
const LIMIT = 4096
const encoder = new TextEncoder()
const createdEmails: string[] = []

const headers = {
  'Content-Type': 'application/json',
  apikey: ANON,
  Authorization: `Bearer ${ANON}`,
  Connection: 'close',
}

const padded = (base: Record<string, unknown>, bytes: number): Uint8Array => {
  const empty = JSON.stringify({ ...base, pad: '' })
  const body = JSON.stringify({ ...base, pad: 'x'.repeat(bytes - empty.length) })
  expect(body.length).toBe(bytes)
  return encoder.encode(body)
}

afterAll(async () => {
  for (const email of createdEmails) {
    const { data } = await service.auth.admin.listUsers({ perPage: 200 })
    const user = data.users.find((u) => u.email === email)
    if (user) await deleteSyntheticUser(service, user.id)
  }
})

describe('redeem-invitation request body', () => {
  it('a body of exactly the limit is read and judged on its content (invalid token: 400, not 413)', async () => {
    const body = padded({ token: randomInvitationToken(), password: syntheticPassword() }, LIMIT)
    const res = await boundedPost(URL_, { headers, body, deadlineMs: 10_000 })
    expect(res.status).toBe(400)
    expect(JSON.parse(res.text).error).toBe('invitation_invalid')
  })

  it('one byte over the limit with a Content-Length is refused with 413 before it is parsed', async () => {
    const body = padded(
      { token: randomInvitationToken(), password: syntheticPassword() },
      LIMIT + 1,
    )
    const res = await boundedPost(URL_, { headers, body, deadlineMs: 10_000 })
    expect(res.status).toBe(413)
    expect(JSON.parse(res.text)).toEqual({ error: 'bad_request' })
  })

  it('a chunked body with no Content-Length is cut off at the limit with 413', async () => {
    const chunks = Array.from({ length: 8 }, () => encoder.encode('x'.repeat(1024)))
    const res = await boundedPost(URL_, { headers, chunks, deadlineMs: 10_000 })
    expect(res.status).toBe(413)
  })

  it('a refused oversize body does not spend or burn a valid invitation', async () => {
    const invitation = await createInvitationDirect(service)
    createdEmails.push(invitation.email)
    const big = padded({ token: invitation.token, password: syntheticPassword() }, 8192)
    const refused = await boundedPost(URL_, { headers, body: big, deadlineMs: 10_000 })
    expect(refused.status).toBe(413)
    // The same invitation still redeems normally afterwards.
    const ok = await fetch(URL_, {
      method: 'POST',
      headers: { ...headers, Connection: 'keep-alive' },
      body: JSON.stringify({ token: invitation.token, password: syntheticPassword() }),
    })
    expect(ok.status).toBe(200)
  })

  for (const [name, text] of [
    ['null', 'null'],
    ['a number', '7'],
    ['an array', '[]'],
    ['a string', '"x"'],
    ['not JSON', '{nope'],
    ['empty', ''],
  ] as const) {
    it(`a body that is ${name} is a 400, never a 500`, async () => {
      const res = await boundedPost(URL_, {
        headers,
        body: encoder.encode(text),
        deadlineMs: 10_000,
      })
      expect(res.status).toBe(400)
      expect(JSON.parse(res.text).error).toBe('bad_request')
    })
  }
})

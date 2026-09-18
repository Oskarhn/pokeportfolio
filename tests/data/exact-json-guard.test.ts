import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  UnsafeIntegerTransportError,
  createExactTransportFetch,
  findUnsafeIntegerLiteral,
  quoteUnsafeIntegerLiterals,
} from '../../src/data/exact-json-guard'

const SAFE = BigInt(Number.MAX_SAFE_INTEGER)

describe('findUnsafeIntegerLiteral', () => {
  it.each([
    ['{"a":9007199254740993}', '9007199254740993'],
    ['{"a":9007199254740992}', '9007199254740992'], // 2^53: representable, but ambiguous
    ['[1,2,-9007199254740993]', '-9007199254740993'],
    ['{"a":{"b":[{"c":288230376151711747}]}}', '288230376151711747'],
    ['9223372036854775807', '9223372036854775807'],
    ['{"a":1,"b":12345678901234567890123}', '12345678901234567890123'],
  ])('finds the unsafe integer in %s', (json, literal) => {
    expect(findUnsafeIntegerLiteral(json)).toBe(literal)
  })

  it.each([
    '{"a":9007199254740991}', // 2^53 - 1
    '{"a":-9007199254740991}',
    '{"a":0}',
    '{"a":[]}',
    '{"a":"9007199254740993"}', // text — the contract's own representation
    '{"a":"note 9007199254740993 and 12345678901234567890"}',
    '{"a":"escaped \\" quote 9007199254740993 \\\\"}',
    '{"a":1.5}',
    '{"a":90071992547409930.5}', // a fraction is a decimal, not an integer minor-unit literal
    '{"a":9007199254740993.0}',
    '{"a":9007199254740993e0}',
    '{"a":1e21}',
    '{"a":123456789012345678e-2}',
    '{"id":"c0000000-0000-0000-0000-0000000a5801"}',
    '{"ts":"2026-09-18T20:19:13.319191+00:00"}',
  ])('leaves %s alone', (json) => {
    expect(findUnsafeIntegerLiteral(json)).toBeNull()
  })

  it('does not treat digits inside a string as a number, including after an escaped quote', () => {
    expect(findUnsafeIntegerLiteral('{"a":"x\\"9007199254740993"}')).toBeNull()
    expect(findUnsafeIntegerLiteral('{"a":"\\\\","b":9007199254740993}')).toBe('9007199254740993')
  })

  it('handles a large body without long digit runs on the fast path', () => {
    const body = JSON.stringify(Array.from({ length: 20_000 }, (_, i) => ({ id: i, n: `${i}` })))
    expect(findUnsafeIntegerLiteral(body)).toBeNull()
  })
})

describe('quoteUnsafeIntegerLiterals', () => {
  it('quotes every unsafe literal and nothing else, keeping the digits', () => {
    const { text, literals } = quoteUnsafeIntegerLiterals(
      '{"a":9007199254740993,"b":5,"c":[-288230376151711747,"9007199254740993",1.5],"d":9007199254740991}',
    )
    expect(literals).toEqual(['9007199254740993', '-288230376151711747'])
    expect(text).toBe(
      '{"a":"9007199254740993","b":5,"c":["-288230376151711747","9007199254740993",1.5],"d":9007199254740991}',
    )
    const parsed = JSON.parse(text) as { a: string; b: number; c: unknown[]; d: number }
    expect(parsed.a).toBe('9007199254740993')
    expect(parsed.b).toBe(5)
    expect(parsed.c[0]).toBe('-288230376151711747')
    expect(parsed.d).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('returns the body unchanged when there is nothing to quote', () => {
    const body = '{"a":1,"b":"9007199254740993"}'
    expect(quoteUnsafeIntegerLiterals(body)).toEqual({ text: body, literals: [] })
  })

  it('property: parse(quote(wire)) carries every original integer exactly, for any mix of magnitudes', () => {
    const integer = fc.oneof(
      fc.bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n }),
      fc.integer({ min: -3, max: 3 }).map((d) => SAFE + BigInt(d)),
      fc.integer({ min: -3, max: 3 }).map((d) => -SAFE + BigInt(d)),
      fc.constantFrom(0n, 1n, -1n),
    )
    fc.assert(
      fc.property(fc.array(integer, { minLength: 1, maxLength: 12 }), (values) => {
        // Hand-built JSON with bare integer literals, exactly as PostgREST writes bigint columns.
        const wire = `[${values.map((v) => `{"v":${v.toString()},"s":"${v.toString()}"}`).join(',')}]`
        const parsed = JSON.parse(quoteUnsafeIntegerLiterals(wire).text) as {
          v: number | string
          s: string
        }[]
        parsed.forEach((row, index) => {
          const original = values[index] as bigint
          expect(row.s).toBe(original.toString())
          if (typeof row.v === 'string') {
            expect(BigInt(row.v)).toBe(original) // quoted: exact
            expect(original > SAFE || original < -SAFE).toBe(true)
          } else {
            expect(BigInt(row.v)).toBe(original) // left as a number only when it is exactly safe
            expect(Number.isSafeInteger(row.v)).toBe(true)
          }
        })
      }),
      { numRuns: 1500 },
    )
  })
})

function jsonResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    ...init,
  })
}

/** A fetch that answers with whatever `respond` returns and remembers the request it saw. */
function fakeFetch(respond: () => Response): { fetch: typeof fetch; calls: { body?: unknown }[] } {
  const calls: { body?: unknown }[] = []
  const impl: typeof fetch = (_input, init) => {
    calls.push({ body: init?.body })
    return Promise.resolve(respond())
  }
  return { fetch: impl, calls }
}

describe('createExactTransportFetch', () => {
  it('refuses a request body carrying an unsafe number and never calls the network', async () => {
    const fake = fakeFetch(() => jsonResponse('{}'))
    const guarded = createExactTransportFetch(fake.fetch)
    const body = JSON.stringify({ p_shipping_minor: Number(9_007_199_254_740_993n) })
    await expect(guarded('http://x/rpc', { method: 'POST', body })).rejects.toBeInstanceOf(
      UnsafeIntegerTransportError,
    )
    expect(fake.calls).toHaveLength(0)
  })

  it('lets a request through when every money value is text', async () => {
    const fake = fakeFetch(() => jsonResponse('{"ok":true}'))
    const guarded = createExactTransportFetch(fake.fetch)
    const body = JSON.stringify({ p_shipping_minor: '9007199254740993', p_quantity: 3 })
    const response = await guarded('http://x/rpc', { method: 'POST', body })
    expect(fake.calls[0]?.body).toBe(body)
    expect(await response.json()).toEqual({ ok: true })
  })

  it('quotes an unsafe number in a JSON response and reports it', async () => {
    const reported: string[][] = []
    const fake = fakeFetch(() => jsonResponse('[{"total_minor":9007199254740993,"n":2}]'))
    const guarded = createExactTransportFetch(fake.fetch, {
      onResponseRewrite: (literals) => reported.push(literals),
    })
    const response = await guarded('http://x/rest/v1/purchases')
    expect(await response.json()).toEqual([{ total_minor: '9007199254740993', n: 2 }])
    expect(reported).toEqual([['9007199254740993']])
  })

  it('keeps status, statusText and headers of the original response', async () => {
    const fake = fakeFetch(() =>
      jsonResponse('{"a":9007199254740993}', {
        status: 201,
        statusText: 'Created',
        headers: { 'content-type': 'application/json', 'content-range': '0-0/1' },
      }),
    )
    const guarded = createExactTransportFetch(fake.fetch)
    const response = await guarded('http://x/rest/v1/t', { method: 'POST', body: '{}' })
    expect(response.status).toBe(201)
    expect(response.statusText).toBe('Created')
    expect(response.headers.get('content-range')).toBe('0-0/1')
  })

  it('does not touch ordinary responses (no rewrite reported, body identical)', async () => {
    const reported: string[][] = []
    const original =
      '{"id":"c0000000-0000-0000-0000-0000000a5801","total_minor":"9007199254740993"}'
    const fake = fakeFetch(() => jsonResponse(original))
    const guarded = createExactTransportFetch(fake.fetch, {
      onResponseRewrite: (l) => reported.push(l),
    })
    const response = await guarded('http://x')
    expect(await response.text()).toBe(original)
    expect(reported).toEqual([])
  })

  it.each([
    [
      'a non-JSON body',
      () => new Response('9007199254740993', { headers: { 'content-type': 'text/plain' } }),
    ],
    [
      'an error response',
      () => jsonResponse('{"code":"P0001","details":9007199254740993}', { status: 400 }),
    ],
    ['a 204 with no body', () => new Response(null, { status: 204 })],
  ])('passes %s through untouched', async (_label, makeResponse) => {
    const original = makeResponse()
    const guarded = createExactTransportFetch(fakeFetch(() => original).fetch)
    expect(await guarded('http://x/y', { method: 'POST', body: '{}' })).toBe(original)
  })

  it('passes a HEAD response through without reading it', async () => {
    const original = jsonResponse('')
    const guarded = createExactTransportFetch(fakeFetch(() => original).fetch)
    expect(await guarded('http://x/y', { method: 'HEAD' })).toBe(original)
  })
})

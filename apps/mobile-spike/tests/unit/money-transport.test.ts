import { parseMinorUnitsWire, UnsafeMoneyTransportError } from '../../src/money/wire'
import {
  createExactTransportFetch,
  findUnsafeIntegerLiteral,
  UnsafeNumericRequestError,
  UnsafeNumericResponseError,
} from '../../src/net/exact-transport-guard'

describe('parseMinorUnitsWire', () => {
  it('reads a decimal string exactly, above 2^53, including negatives', () => {
    expect(parseMinorUnitsWire('9007199254740993', 'f')).toBe(9007199254740993n)
    expect(parseMinorUnitsWire('-9007199254740993', 'f')).toBe(-9007199254740993n)
    expect(parseMinorUnitsWire('288230376151711745', 'f')).toBe(288230376151711745n)
  })

  it('keeps NULL as null and zero as zero (NULL is never zero)', () => {
    expect(parseMinorUnitsWire(null, 'f')).toBeNull()
    expect(parseMinorUnitsWire(undefined, 'f')).toBeNull()
    expect(parseMinorUnitsWire('0', 'f')).toBe(0n)
    expect(parseMinorUnitsWire(0, 'f')).toBe(0n)
  })

  it('accepts a JSON number only when it is a safe integer', () => {
    expect(parseMinorUnitsWire(9007199254740991, 'f')).toBe(9007199254740991n)
    // eslint-disable-next-line no-loss-of-precision -- the point: this literal is already rounded
    expect(() => parseMinorUnitsWire(9007199254740993, 'f')).toThrow(UnsafeMoneyTransportError)
    expect(() => parseMinorUnitsWire(2 ** 60, 'f')).toThrow(UnsafeMoneyTransportError)
    expect(() => parseMinorUnitsWire(1.5, 'f')).toThrow(UnsafeMoneyTransportError)
    expect(() => parseMinorUnitsWire(Number.NaN, 'f')).toThrow(UnsafeMoneyTransportError)
  })

  it.each(['', ' 12', '12 ', '0x10', '1e3', '1.5', '--1', '+1', '12abc', '9'.repeat(20)])(
    'refuses the malformed string %j (the shared BigInt() parse would accept several of these)',
    (bad) => {
      expect(() => parseMinorUnitsWire(bad, 'f')).toThrow(UnsafeMoneyTransportError)
    },
  )

  it('refuses other types', () => {
    expect(() => parseMinorUnitsWire({}, 'f')).toThrow(UnsafeMoneyTransportError)
    expect(() => parseMinorUnitsWire(true, 'f')).toThrow(UnsafeMoneyTransportError)
    expect(() => parseMinorUnitsWire(10n, 'f')).toThrow(UnsafeMoneyTransportError)
  })
})

describe('findUnsafeIntegerLiteral (raw JSON, before JSON.parse rounds it)', () => {
  it('shows why: JSON.parse silently rounds the literal', () => {
    expect((JSON.parse('{"a":9007199254740993}') as { a: number }).a).toBe(9007199254740992)
  })

  it.each([
    ['{"a":9007199254740993}', '9007199254740993'],
    ['{"a":9007199254740992}', '9007199254740992'], // 2^53 itself is already above MAX_SAFE
    ['{"a":-9007199254740993}', '-9007199254740993'],
    ['[1,2,{"x":288230376151711745}]', '288230376151711745'],
    ['{"a":1,"b":[{"c":12345678901234567890}]}', '12345678901234567890'],
    ['[0,\n 9007199254740993 ]', '9007199254740993'],
  ])('flags %s', (json, literal) => {
    expect(findUnsafeIntegerLiteral(json)).toBe(literal)
  })

  it.each([
    '{"a":"9007199254740993"}', // a decimal STRING is the contract, not a violation
    '{"a":9007199254740991}',
    '{"a":-9007199254740991}',
    '{"a":12345678901234567.5}', // fraction: not integer minor units
    '{"a":1.2345678901234567e30}',
    '{"note":"call 9007199254740993 now","b":1}',
    '{"s":"quote \\" 9007199254740993 \\" inside"}',
    '{"id":"e2a4b7d0-1234-5678-9abc-def012345678"}',
    '{"a":[],"b":{},"c":null,"d":true}',
    '',
  ])('does not flag %s', (json) => {
    expect(findUnsafeIntegerLiteral(json)).toBeNull()
  })

  it('handles a large body with a violation at the end', () => {
    const body = `[${Array.from({ length: 5000 }, (_, i) => `{"n":${i},"s":"x"}`).join(',')},{"v":9007199254740993}]`
    expect(findUnsafeIntegerLiteral(body)).toBe('9007199254740993')
  })
})

function jsonResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

describe('createExactTransportFetch', () => {
  it('refuses an unsafe integer in a RESPONSE (fail closed) instead of returning a rounded amount', async () => {
    const fetcher = createExactTransportFetch(() =>
      Promise.resolve(jsonResponse('[{"v":9007199254740993}]')),
    )
    await expect(fetcher('http://x/rest/v1/rpc/a')).rejects.toBeInstanceOf(
      UnsafeNumericResponseError,
    )
  })

  it('passes a response whose money is a decimal string, byte for byte', async () => {
    const body = '[{"v":"9007199254740993","n":3}]'
    const fetcher = createExactTransportFetch(() => Promise.resolve(jsonResponse(body)))
    const res = await fetcher('http://x/rest/v1/rpc/a')
    expect(await res.text()).toBe(body)
    expect(res.status).toBe(200)
  })

  it('refuses an unsafe integer in a REQUEST body before any network call', async () => {
    let called = false
    const fetcher = createExactTransportFetch(() => {
      called = true
      return Promise.resolve(jsonResponse('[]'))
    })
    await expect(
      fetcher('http://x/rest/v1/rpc/a', {
        method: 'POST',
        body: `{"p_cursor_value_minor":${(2n ** 58n + 1n).toString()}}`,
      }),
    ).rejects.toBeInstanceOf(UnsafeNumericRequestError)
    expect(called).toBe(false)
  })

  it('lets non-JSON, error and empty responses through untouched', async () => {
    const text = createExactTransportFetch(() =>
      Promise.resolve(
        new Response('9007199254740993', { headers: { 'content-type': 'text/plain' } }),
      ),
    )
    expect(await (await text('http://x/')).text()).toBe('9007199254740993')
    const err = createExactTransportFetch(() =>
      Promise.resolve(jsonResponse('{"code":"x","n":9007199254740993}', { status: 500 })),
    )
    expect((await err('http://x/')).status).toBe(500)
    const none = createExactTransportFetch(() =>
      Promise.resolve(new Response(null, { status: 204 })),
    )
    expect((await none('http://x/')).status).toBe(204)
  })
})

/* eslint-disable @typescript-eslint/require-await -- fetch test doubles must return promises */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  UnsafeIntegerTransportError,
  createExactTransportFetch,
  findUnsafeIntegerLiteral,
  quoteUnsafeIntegerLiterals,
} from '../../src/data/exact-json-guard'

/**
 * P148 - independent adversarial audit of the exact-money transport guard (P146).
 *
 * The existing suites (tests/data/exact-json-guard.test.ts, the money wire structure rules) check
 * the guard against hand-picked examples and against its own tokenizer's idea of a number. This
 * file uses a DIFFERENT ORACLE: the platform's own JSON parser, asked for the exact SOURCE TEXT of
 * every number literal it saw (`JSON.parse` reviver `context.source`, V8 "source text access").
 * The guard is a second implementation of "what is a number token"; V8 is the referee.
 *
 * Contract under test (docs/DECISIONS.md D-137, src/data/exact-json-guard.ts):
 *   - an integer literal above 2^53-1 in magnitude is quoted (response) / refused (request);
 *   - nothing else changes meaning: strings, safe integers, decimals, exponents, keys, escapes;
 *   - a failed response is never turned into a successful-looking one.
 */

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)

/** A number as the referee saw it: its exact source text. */
class Num {
  readonly source: string
  constructor(source: string) {
    this.source = source
  }
}

function isUnsafeIntegerSource(source: string): boolean {
  if (!/^-?[0-9]+$/.test(source)) return false
  return BigInt(source.startsWith('-') ? source.slice(1) : source) > MAX_SAFE
}

type Revived = Num | string | boolean | null | Revived[] | { [key: string]: Revived }

/** Parses with the platform parser; every number becomes `Num(sourceText)`. */
function parseWithSources(text: string): Revived {
  // the third reviver argument (V8 "JSON.parse source text access") is not in the TS lib typings yet
  const reviver = (_key: string, value: unknown, context: { source?: string }) =>
    typeof value === 'number' ? new Num(context.source as string) : value
  return JSON.parse(text, reviver as never) as Revived
}

/** Every unsafe-integer source text in `tree`, in traversal order. */
function unsafeSources(tree: Revived, into: string[] = []): string[] {
  if (tree instanceof Num) {
    if (isUnsafeIntegerSource(tree.source)) into.push(tree.source)
  } else if (Array.isArray(tree)) {
    for (const item of tree) unsafeSources(item, into)
  } else if (tree !== null && typeof tree === 'object') {
    for (const key of Object.keys(tree)) unsafeSources(tree[key] as Revived, into)
  }
  return into
}

/** `after` must equal `before` everywhere, except that an unsafe integer of `before` is the string
 *  with the same digits in `after`. Returns a description of the first difference, or null. */
function firstDifference(before: Revived, after: Revived, path = '$'): string | null {
  if (before instanceof Num) {
    if (isUnsafeIntegerSource(before.source)) {
      return after === before.source
        ? null
        : `${path}: unsafe ${before.source} became ${JSON.stringify(after)}`
    }
    return after instanceof Num && after.source === before.source
      ? null
      : `${path}: number ${before.source} became ${JSON.stringify(after)}`
  }
  if (Array.isArray(before)) {
    if (!Array.isArray(after) || after.length !== before.length) return `${path}: array changed`
    for (let i = 0; i < before.length; i += 1) {
      const diff = firstDifference(before[i] as Revived, after[i] as Revived, `${path}[${i}]`)
      if (diff !== null) return diff
    }
    return null
  }
  if (before !== null && typeof before === 'object') {
    if (after === null || typeof after !== 'object' || Array.isArray(after) || after instanceof Num)
      return `${path}: object changed`
    const keys = Object.keys(before)
    if (Object.keys(after).length !== keys.length) return `${path}: keys changed`
    for (const key of keys) {
      if (!(key in after)) return `${path}.${key}: key lost`
      const diff = firstDifference(
        before[key] as Revived,
        (after as Record<string, Revived>)[key] as Revived,
        `${path}.${key}`,
      )
      if (diff !== null) return diff
    }
    return null
  }
  return before === after
    ? null
    : `${path}: ${JSON.stringify(before)} became ${JSON.stringify(after)}`
}

/* ------------------------------ a generator of JSON TEXT, not values ---------------------------- */

const digits = (n: number) => fc.stringMatching(new RegExp(`^[1-9][0-9]{${n - 1}}$`))

const numberToken: fc.Arbitrary<string> = fc.oneof(
  { weight: 4, arbitrary: fc.integer({ min: -1000, max: 1000 }).map(String) },
  { weight: 3, arbitrary: fc.bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n }).map(String) },
  {
    weight: 4,
    // the boundary neighbourhood: 2^53-1 is safe, 2^53 and 2^53+1 are not
    arbitrary: fc
      .tuple(fc.boolean(), fc.integer({ min: -3, max: 3 }))
      .map(([neg, d]) => `${neg ? '-' : ''}${(MAX_SAFE + BigInt(d)).toString()}`),
  },
  { weight: 2, arbitrary: fc.integer({ min: 16, max: 40 }).chain((n) => digits(n)) },
  {
    weight: 2,
    arbitrary: fc
      .integer({ min: 16, max: 40 })
      .chain((n) => digits(n))
      .map((s) => `-${s}`),
  },
  {
    weight: 3,
    // not integer literals: decimals and exponents must NEVER be touched, however long
    arbitrary: fc.constantFrom(
      '0',
      '-0',
      '0.5',
      '-0.0',
      '1.5',
      '90071992547409930.5',
      '9007199254740993.0',
      '9007199254740993e0',
      '9007199254740993E+0',
      '12345678901234567890e-3',
      '1e21',
      '1E+30',
      '-1.5e-7',
      '123456789012345678.123456789012345678',
    ),
  },
)

const ws = fc.constantFrom('', ' ', '\n', '\t', '  \r\n  ')

/** A JSON string TOKEN (quotes included), built so it stresses the guard's string scanner. */
const stringToken: fc.Arbitrary<string> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.string({ unit: 'grapheme', maxLength: 30 }).map((s) => JSON.stringify(s)),
  },
  {
    weight: 4,
    // 16+ digit runs inside strings: money-looking text that is CONTENT, never a number
    arbitrary: fc
      .tuple(
        fc.integer({ min: 16, max: 30 }).chain((n) => digits(n)),
        fc.string({ maxLength: 5 }),
      )
      .map(([run, tail]) => JSON.stringify(`${run}${tail}`)),
  },
  {
    weight: 3,
    // hand-escaped forms: escaped quote and backslash right before a digit run, \u escapes
    arbitrary: fc.constantFrom(
      '"a\\"9007199254740993"',
      '"\\\\9007199254740993"',
      '"\\\\\\"9007199254740993\\\\"',
      '"\\u0022 9007199254740993 \\u0022"',
      '"\\u005c\\u0022 12345678901234567890"',
      '"\\ud83d\\ude00 9007199254740993"',
      '"9007199254740993"',
      '"-9007199254740993"',
      '"9007199254740993.5"',
      '""',
      '"\\\\"',
    ),
  },
)

interface Ast {
  render(): string
}
const literal = (text: string): Ast => ({ render: () => text })

const grammar = fc.letrec<{ value: Ast; array: Ast; object: Ast }>((tie) => ({
  value: fc.oneof(
    { weight: 5, arbitrary: numberToken.map(literal) },
    { weight: 4, arbitrary: stringToken.map(literal) },
    { weight: 1, arbitrary: fc.constantFrom('true', 'false', 'null').map(literal) },
    { weight: 2, depthSize: 'small', arbitrary: tie('array') },
    { weight: 2, depthSize: 'small', arbitrary: tie('object') },
  ),
  array: fc.array(fc.tuple(ws, tie('value'), ws), { maxLength: 5 }).map((items) => ({
    render: () => `[${items.map(([a, v, b]) => `${a}${v.render()}${b}`).join(',')}]`,
  })),
  object: fc
    .array(fc.tuple(ws, stringToken, ws, ws, tie('value'), ws), { maxLength: 5 })
    .map((members) => {
      // unique, non-integer-like keys: duplicate keys and "1"-style keys would make the platform
      // parser collapse or reorder members, which is a referee artefact, not a guard property.
      return {
        render: () =>
          `{${members
            .map(([a, key, b, c, v, d], i) => `${a}${uniqueKey(key, i)}${b}:${c}${v.render()}${d}`)
            .join(',')}}`,
      }
    }),
}))

const jsonText: fc.Arbitrary<string> = grammar.value.map((ast) => ast.render())

function uniqueKey(stringTokenText: string, index: number): string {
  // a valid JSON string that is unique per position and never integer-like
  return `"k${String(index)}_${stringTokenText.replace(/^"|"$/g, '').replace(/[\\"]/g, '_')}"`
}

describe(
  'exact-json-guard against the platform JSON parser (independent oracle)',
  { timeout: 120_000 },
  () => {
    it('the oracle itself sees number source text (guards the guard-test)', () => {
      const tree = parseWithSources('{"a":9007199254740993,"b":[1.50,1E+2,-0]}') as Record<
        string,
        Revived
      >
      expect((tree.a as Num).source).toBe('9007199254740993')
      expect(((tree.b as Revived[])[0] as Num).source).toBe('1.50')
      expect(((tree.b as Revived[])[1] as Num).source).toBe('1E+2')
      expect(((tree.b as Revived[])[2] as Num).source).toBe('-0')
    })

    it('finds an unsafe integer exactly when the platform parser saw one (2000 documents)', () => {
      fc.assert(
        fc.property(jsonText, (text) => {
          const referee = unsafeSources(parseWithSources(text))
          const found = findUnsafeIntegerLiteral(text)
          if (referee.length === 0) return found === null
          return found !== null && referee.includes(found)
        }),
        { numRuns: 2000 },
      )
    })

    it('quotes every unsafe integer and changes NOTHING else (2000 documents)', () => {
      fc.assert(
        fc.property(jsonText, (text) => {
          const before = parseWithSources(text)
          const { text: quoted, literals } = quoteUnsafeIntegerLiterals(text)
          const after = parseWithSources(quoted) // must still be valid JSON
          const expected = unsafeSources(before)
          return (
            firstDifference(before, after) === null &&
            [...literals].sort().join('|') === [...expected].sort().join('|')
          )
        }),
        { numRuns: 2000 },
      )
    })

    it('is idempotent: a quoted body has nothing left to quote', () => {
      fc.assert(
        fc.property(jsonText, (text) => {
          const once = quoteUnsafeIntegerLiterals(text).text
          const twice = quoteUnsafeIntegerLiterals(once)
          return (
            twice.literals.length === 0 &&
            twice.text === once &&
            findUnsafeIntegerLiteral(once) === null
          )
        }),
        { numRuns: 1000 },
      )
    })

    it('a document with no integer above 2^53-1 comes back byte-identical', () => {
      fc.assert(
        fc.property(jsonText, (text) => {
          fc.pre(unsafeSources(parseWithSources(text)).length === 0)
          return quoteUnsafeIntegerLiterals(text).text === text
        }),
        { numRuns: 1000 },
      )
    })

    it.each([
      ['2^63-1 (bigint max)', '9223372036854775807'],
      ['-2^63 (bigint min)', '-9223372036854775808'],
      ['2^53', '9007199254740992'],
      ['2^53+1', '9007199254740993'],
      ['-(2^53+1)', '-9007199254740993'],
      ['a 1000-digit integer', '7'.repeat(1000)],
    ])('quotes the extreme value %s and nothing about it is rounded', (_name, digitsText) => {
      const { text } = quoteUnsafeIntegerLiterals(`{"v":${digitsText},"w":[${digitsText}]}`)
      const parsed = JSON.parse(text) as { v: string; w: string[] }
      expect(parsed.v).toBe(digitsText)
      expect(parsed.w[0]).toBe(digitsText)
    })

    it.each([
      ['2^53-1', '9007199254740991'],
      ['-(2^53-1)', '-9007199254740991'],
      ['-0', '-0'],
      ['10^15', '1000000000000000'],
      ['a decimal with 17 integer digits', '12345678901234567.5'],
      ['an exponent form of an unsafe value', '9007199254740993e0'],
    ])('leaves %s exactly as it is', (_name, token) => {
      const body = `{"v":${token}}`
      expect(quoteUnsafeIntegerLiterals(body).text).toBe(body)
      expect(findUnsafeIntegerLiteral(body)).toBeNull()
    })

    it('keys are not values: an unsafe-looking KEY is neither refused nor quoted', () => {
      const body = '{"9007199254740993":1,"12345678901234567890":"x"}'
      expect(findUnsafeIntegerLiteral(body)).toBeNull()
      expect(quoteUnsafeIntegerLiterals(body).text).toBe(body)
    })

    it('what it does NOT cover, pinned so a change is noticed: an unsafe integer written with an exponent or fraction', () => {
      // Documented scope (module header): fractional / exponent literals are not integer minor
      // units. If PostgREST ever emitted `9007199254740993e0` for a bigint this net would not see it.
      expect(quoteUnsafeIntegerLiterals('{"a":9007199254740993e0}').literals).toEqual([])
      expect(quoteUnsafeIntegerLiterals('{"a":9007199254740993.0}').literals).toEqual([])
    })

    it('handles an 8 MB body whose every row forces the string scanner, in well under a second', () => {
      // worst case for the fast path: a 16-digit run in every row (inside a string), so the whole
      // body is tokenized character by character.
      const rows = Array.from({ length: 60_000 }, (_, i) => ({
        id: i,
        ref: `ref-${String(1234567890123456 + i)}-note`,
        pad: 'x'.repeat(80),
      }))
      const body = JSON.stringify(rows)
      expect(body.length).toBeGreaterThan(8_000_000)
      const started = performance.now()
      const { literals } = quoteUnsafeIntegerLiterals(body)
      const elapsed = performance.now() - started
      expect(literals).toEqual([])
      expect(elapsed).toBeLessThan(1500)
    })
  },
)

/* ------------------------------ the fetch wrapper: responses and failures ----------------------- */

function jsonResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    ...init,
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(init.headers as object) },
  })
}

describe('createExactTransportFetch: response handling', () => {
  const unsafeBody = '{"total_minor":9007199254740993,"n":1}'

  it('quotes an unsafe literal in a successful JSON response and keeps status and headers', async () => {
    const seen: string[][] = []
    const wrapped = createExactTransportFetch(
      async () =>
        jsonResponse(unsafeBody, {
          status: 201,
          headers: {
            'content-type': 'application/vnd.pgrst.object+json',
            'content-range': '0-0/*',
          },
        }),
      { onResponseRewrite: (l) => seen.push(l) },
    )
    const response = await wrapped('http://x/rest/v1/rpc/f', { method: 'POST', body: '{}' })
    expect(response.status).toBe(201)
    expect(response.headers.get('content-range')).toBe('0-0/*')
    expect(await response.json()).toEqual({ total_minor: '9007199254740993', n: 1 })
    expect(seen).toEqual([['9007199254740993']])
  })

  it.each([400, 401, 403, 404, 409, 422, 500, 503])(
    'a %i response is returned as the SAME failure, body untouched, never made to look successful',
    async (status) => {
      const original = jsonResponse(`{"message":"boom","hint":9007199254740993}`, { status })
      const wrapped = createExactTransportFetch(async () => original)
      const response = await wrapped('http://x/rest/v1/rpc/create_purchase', {
        method: 'POST',
        body: '{}',
      })
      expect(response.ok).toBe(false)
      expect(response.status).toBe(status)
      expect(response).toBe(original)
      expect(await response.text()).toBe('{"message":"boom","hint":9007199254740993}')
    },
  )

  it.each([
    ['text/plain', '9007199254740993 total'],
    ['text/csv', 'a,b\n9007199254740993,2'],
    ['application/octet-stream', '9007199254740993'],
    ['text/html', '<p>9007199254740993</p>'],
  ])('leaves a %s response alone', async (contentType, body) => {
    const original = new Response(body, { status: 200, headers: { 'content-type': contentType } })
    const wrapped = createExactTransportFetch(async () => original)
    const response = await wrapped('http://x/f', { method: 'GET' })
    expect(response).toBe(original)
    expect(await response.text()).toBe(body)
  })

  it('a JSON response whose body is not valid JSON is passed on for the caller to reject, not thrown here', async () => {
    const wrapped = createExactTransportFetch(async () =>
      jsonResponse('{"a": 9007199254740993, "b": '),
    )
    const response = await wrapped('http://x/f', { method: 'GET' })
    expect(response.status).toBe(200)
    await expect(response.json()).rejects.toThrow(SyntaxError)
  })

  it('an empty 201 JSON body and a 204 pass through without a Response constructor error', async () => {
    const emptyCreated = createExactTransportFetch(async () => jsonResponse('', { status: 201 }))
    expect((await emptyCreated('http://x/f', { method: 'POST', body: '{}' })).status).toBe(201)
    const noContent = createExactTransportFetch(
      async () =>
        new Response(null, {
          status: 204,
          headers: { 'content-type': 'application/json' },
        }),
    )
    expect((await noContent('http://x/f', { method: 'POST', body: '{}' })).status).toBe(204)
  })

  it('a HEAD request with a JSON content-type is not read', async () => {
    const original = new Response(null, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
    const wrapped = createExactTransportFetch(async () => original)
    expect(await wrapped('http://x/f', { method: 'HEAD' })).toBe(original)
  })

  it('a streamed JSON response is read to the end and quoted across chunk boundaries', async () => {
    // the literal is split across two chunks: a scanner that worked chunk by chunk would miss it
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"total_minor":90071992'))
        controller.enqueue(encoder.encode('54740993,"n":1}'))
        controller.close()
      },
    })
    const wrapped = createExactTransportFetch(
      async () =>
        new Response(stream, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const response = await wrapped('http://x/f', { method: 'GET' })
    expect(await response.json()).toEqual({ total_minor: '9007199254740993', n: 1 })
  })

  it('a stale content-encoding / content-length on the wrapped response does not corrupt the body', async () => {
    // PostgREST exposes Content-Encoding to the browser; the wrapper rebuilds the Response from the
    // already-decoded text, so the copied headers must not make anything decode it a second time.
    const wrapped = createExactTransportFetch(async () =>
      jsonResponse(unsafeBody, {
        headers: { 'content-encoding': 'gzip', 'content-length': '3' },
      }),
    )
    const response = await wrapped('http://x/f', { method: 'GET' })
    expect(await response.json()).toEqual({ total_minor: '9007199254740993', n: 1 })
  })

  it('an abort while the body is being read rejects (it does not resolve with a partial result)', async () => {
    const controller = new AbortController()
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"a":'))
        controller.signal.addEventListener('abort', () => {
          c.error(new DOMException('aborted', 'AbortError'))
        })
      },
    })
    const wrapped = createExactTransportFetch(
      async () =>
        new Response(stream, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const pending = wrapped('http://x/f', { method: 'GET', signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('a network failure surfaces as the base fetch failure, unchanged', async () => {
    const failure = new TypeError('Failed to fetch')
    const wrapped = createExactTransportFetch(async () => Promise.reject(failure))
    await expect(wrapped('http://x/f', { method: 'POST', body: '{"a":1}' })).rejects.toBe(failure)
  })
})

describe('createExactTransportFetch: request handling', () => {
  it('refuses an unsafe integer in a request body BEFORE the network is touched', async () => {
    let calls = 0
    const wrapped = createExactTransportFetch(async () => {
      calls += 1
      return jsonResponse('{}')
    })
    await expect(
      wrapped('http://x/rest/v1/rpc/create_purchase', {
        method: 'POST',
        body: JSON.stringify({ p_shipping_minor: Number(2n ** 53n + 1n) }),
      }),
    ).rejects.toBeInstanceOf(UnsafeIntegerTransportError)
    expect(calls).toBe(0)
  })

  it('sends the same amount as decimal text without complaint, whatever its size', async () => {
    let sent = ''
    const wrapped = createExactTransportFetch(async (_input: unknown, init?: RequestInit) => {
      sent = typeof init?.body === 'string' ? init.body : ''
      return jsonResponse('{}')
    })
    await wrapped('http://x/f', {
      method: 'POST',
      body: JSON.stringify({
        p: { u: (2n ** 62n + 12345n).toString(), n: 'note 12345678901234567890' },
      }),
    })
    expect(sent).toContain('"4611686018427400249"') // 2^62 + 12345, computed by hand
  })

  it('DOCUMENTED GAP: a body that is not a string is not inspected (no application path builds one)', async () => {
    // supabase-js hands `fetch` a URL string and an init whose body is JSON.stringify()'d text. A
    // caller that passed a Blob / Request body would bypass the request check. Pinned so that if the
    // app ever starts sending such bodies this test is the place that gets revisited.
    let calls = 0
    const wrapped = createExactTransportFetch(async () => {
      calls += 1
      return jsonResponse('{}')
    })
    await wrapped('http://x/f', {
      method: 'POST',
      body: new Blob([JSON.stringify({ a: Number(2n ** 53n + 1n) })]),
    })
    expect(calls).toBe(1)
  })
})

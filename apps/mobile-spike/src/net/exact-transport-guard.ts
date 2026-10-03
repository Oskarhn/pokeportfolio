/**
 * Refuses JSON integers a JavaScript number cannot hold exactly, in both directions.
 *
 * `JSON.parse('{"a":9007199254740993}')` yields 9007199254740992 with no error, so a response that
 * carries an unquoted money integer above 2^53-1 is silently a different amount by the time any
 * application code sees it. This guard reads the RAW body text before it is parsed and refuses the
 * whole response (fail closed: the UI shows "unavailable", never a rounded amount). It only looks at
 * JSON number tokens outside strings: a 20-digit decimal *string*, a uuid or a note is not a
 * violation, and fractional/exponent literals (numeric FX rates) are out of scope.
 *
 * SPIKE_ONLY on DB 104. P149's `createExactTransportFetch` (src/data/exact-json-guard.ts, unreleased)
 * does the same scan but QUOTES the literal instead of refusing, which keeps the exact digits; adopt
 * it when it releases and delete this file. The contract test (tests/unit/exact-transport-guard.test.ts)
 * is written so the same vectors can be pointed at that implementation.
 */

export class UnsafeNumericResponseError extends Error {
  readonly code = 'unsafe_numeric_response'
  readonly literal: string
  constructor(literal: string) {
    super(
      `response contains the JSON number ${literal}, which a JavaScript number cannot hold exactly`,
    )
    this.name = 'UnsafeNumericResponseError'
    this.literal = literal
  }
}

export class UnsafeNumericRequestError extends Error {
  readonly code = 'unsafe_numeric_request'
  readonly literal: string
  constructor(literal: string) {
    super(`refusing to send the JSON number ${literal}: it is outside the exact integer range`)
    this.name = 'UnsafeNumericRequestError'
    this.literal = literal
  }
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)
/** An unsafe integer needs at least 16 digits; without a 16-digit run there is nothing to scan. */
const LONG_DIGIT_RUN = /[0-9]{16}/
const NUMBER_TOKEN = /-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/y

/** The first JSON integer literal (no fraction, no exponent) with |value| > 2^53-1, else null. */
export function findUnsafeIntegerLiteral(json: string): string | null {
  if (!LONG_DIGIT_RUN.test(json)) return null
  let i = 0
  while (i < json.length) {
    const c = json.charCodeAt(i)
    if (c === 34) {
      // string: skip to the closing quote, honouring backslash escapes
      i += 1
      while (i < json.length) {
        const d = json.charCodeAt(i)
        if (d === 92) i += 2
        else if (d === 34) break
        else i += 1
      }
      i += 1
      continue
    }
    if (c === 45 || (c >= 48 && c <= 57)) {
      NUMBER_TOKEN.lastIndex = i
      const match = NUMBER_TOKEN.exec(json)
      if (match === null) {
        i += 1
        continue
      }
      const token = match[0]
      const isInteger = match[1] === undefined && match[2] === undefined
      if (isInteger) {
        const digits = token.startsWith('-') ? token.slice(1) : token
        if (digits.length >= 16 && BigInt(digits) > MAX_SAFE) return token
      }
      i += token.length
      continue
    }
    i += 1
  }
  return null
}

function isJson(response: Response): boolean {
  return /json/i.test(response.headers.get('content-type') ?? '')
}

export function createExactTransportFetch(base: typeof fetch): typeof fetch {
  return async (input, init) => {
    if (typeof init?.body === 'string') {
      const literal = findUnsafeIntegerLiteral(init.body)
      if (literal !== null) throw new UnsafeNumericRequestError(literal)
    }
    const response = await base(input, init)
    if (!response.ok || response.status === 204 || response.status === 205 || !isJson(response)) {
      return response
    }
    const text = await response.text()
    const literal = findUnsafeIntegerLiteral(text)
    if (literal !== null) throw new UnsafeNumericResponseError(literal)
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
}

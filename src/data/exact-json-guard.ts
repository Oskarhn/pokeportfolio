/**
 * Backstop for the one failure this project cannot see in a type: a JSON integer literal that a
 * JavaScript number cannot hold. `JSON.parse('{"a":9007199254740993}')` returns 9007199254740992
 * without an error, and `JSON.stringify({ a: Number(9007199254740993n) })` sends it. Money that
 * takes either path is silently a different amount (docs/DECISIONS.md D-137; P130-19).
 *
 * The transport contract (src/data/money.ts) keeps money out of JSON numbers altogether. This
 * module is what happens when something slips through anyway — a column nobody cast `::text`, a
 * `Number(money)` that crept back:
 *
 *   REQUEST   an integer literal outside ±(2^53 - 1) is REFUSED before the request leaves. Nothing
 *             has been committed yet, and the literal is by definition already a rounded double.
 *   RESPONSE  the same literal is QUOTED — `9007199254740993` becomes `"9007199254740993"` — before
 *             `JSON.parse` sees it, and reported to `onResponseRewrite`. The exact digits reach the
 *             application as a string (which `parseMinorUnits` reads exactly), instead of a rounded
 *             number, and a response is never thrown away after its write already committed.
 *             The test suites install a reporter and require it to stay silent: a rewrite means a
 *             path is leaning on this net instead of following the contract.
 *
 * It looks at JSON NUMBER TOKENS only. Digits inside a string (a money amount sent as text, a
 * note, a uuid) are never a violation, and fractional / exponent literals (numeric FX rates) are
 * out of scope: they are not integer minor units.
 */

export class UnsafeIntegerTransportError extends Error {
  readonly literal: string

  constructor(literal: string) {
    super(
      `refusing request body: JSON number ${literal} is outside the exactly-representable ` +
        `integer range (±${String(Number.MAX_SAFE_INTEGER)}). Money must be sent as a decimal ` +
        'string (src/data/money.ts).',
    )
    this.name = 'UnsafeIntegerTransportError'
    this.literal = literal
  }
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)

/** An unsafe integer needs at least 16 digits. A body without a 16-digit run cannot contain one,
 *  so the common case (no long digit runs anywhere) is one native regex scan and no tokenizing. */
const LONG_DIGIT_RUN = /[0-9]{16}/

const CHAR_QUOTE = 34
const CHAR_BACKSLASH = 92
const CHAR_MINUS = 45
const CHAR_PLUS = 43
const CHAR_DOT = 46
const CHAR_LOWER_E = 101

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57
}

/**
 * Walks `json` token by token (string-aware: a digit run inside a JSON string is content, not a
 * number) and calls `onUnsafe(start, end)` for every JSON number token that is an integer literal
 * (no fraction, no exponent) with magnitude above Number.MAX_SAFE_INTEGER. A callback returning
 * `false` stops the walk.
 */
function scanUnsafeIntegers(json: string, onUnsafe: (start: number, end: number) => boolean): void {
  if (!LONG_DIGIT_RUN.test(json)) return
  const length = json.length
  let index = 0
  while (index < length) {
    const code = json.charCodeAt(index)
    if (code === CHAR_QUOTE) {
      index += 1
      while (index < length) {
        const inner = json.charCodeAt(index)
        if (inner === CHAR_BACKSLASH) index += 2
        else if (inner === CHAR_QUOTE) break
        else index += 1
      }
      index += 1
      continue
    }
    if (code === CHAR_MINUS || isDigit(code)) {
      const start = index
      index += 1
      while (index < length && isDigit(json.charCodeAt(index))) index += 1
      const integerEnd = index
      let integral = true
      if (index < length && json.charCodeAt(index) === CHAR_DOT) {
        integral = false
        index += 1
        while (index < length && isDigit(json.charCodeAt(index))) index += 1
      }
      if (index < length && (json.charCodeAt(index) | 32) === CHAR_LOWER_E) {
        integral = false
        index += 1
        if (
          index < length &&
          (json.charCodeAt(index) === CHAR_PLUS || json.charCodeAt(index) === CHAR_MINUS)
        ) {
          index += 1
        }
        while (index < length && isDigit(json.charCodeAt(index))) index += 1
      }
      if (integral && integerEnd - start >= 16) {
        const digits = json.slice(
          json.charCodeAt(start) === CHAR_MINUS ? start + 1 : start,
          integerEnd,
        )
        if (BigInt(digits) > MAX_SAFE && !onUnsafe(start, integerEnd)) return
      }
      continue
    }
    index += 1
  }
}

/** The first unsafe integer literal in `json`, or `null`. */
export function findUnsafeIntegerLiteral(json: string): string | null {
  let found: string | null = null
  scanUnsafeIntegers(json, (start, end) => {
    found = json.slice(start, end)
    return false
  })
  return found
}

/** `json` with every unsafe integer literal turned into a JSON string of the same digits, plus the
 *  literals that were rewritten. Lossless: `JSON.parse` of the result carries the exact digits. */
export function quoteUnsafeIntegerLiterals(json: string): { text: string; literals: string[] } {
  const literals: string[] = []
  let text = ''
  let copiedTo = 0
  scanUnsafeIntegers(json, (start, end) => {
    text += `${json.slice(copiedTo, start)}"${json.slice(start, end)}"`
    literals.push(json.slice(start, end))
    copiedTo = end
    return true
  })
  if (literals.length === 0) return { text: json, literals }
  return { text: text + json.slice(copiedTo), literals }
}

function isJsonResponse(response: Response): boolean {
  return /json/i.test(response.headers.get('content-type') ?? '')
}

/** Statuses (and HEAD) whose response has no body: `new Response(text, ...)` would throw. */
function hasNoBody(response: Response, method: string): boolean {
  return (
    method === 'HEAD' ||
    response.status === 101 ||
    response.status === 204 ||
    response.status === 205 ||
    response.status === 304
  )
}

export interface ExactTransportOptions {
  /** Called with the literals quoted in a response body. The app leaves this unset; the test
   *  suites use it to prove no data path depends on the rewrite. */
  onResponseRewrite?: (literals: string[]) => void
}

/**
 * Wraps a fetch implementation so no unsafe JSON integer crosses it in either direction (see the
 * module header). Non-JSON, non-2xx and body-less responses pass through untouched; a JSON body is
 * read once as text and handed on as a fresh Response with the same status and headers.
 */
export function createExactTransportFetch(
  base: typeof fetch = fetch,
  options: ExactTransportOptions = {},
): typeof fetch {
  return async (input, init) => {
    if (typeof init?.body === 'string') {
      const literal = findUnsafeIntegerLiteral(init.body)
      if (literal !== null) throw new UnsafeIntegerTransportError(literal)
    }
    const response = await base(input, init)
    const method = (
      init?.method ??
      (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')
    ).toUpperCase()
    if (!response.ok || hasNoBody(response, method) || !isJsonResponse(response)) return response

    const { text, literals } = quoteUnsafeIntegerLiterals(await response.text())
    if (literals.length > 0) options.onResponseRewrite?.(literals)
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
}

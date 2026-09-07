import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  csvFreeText,
  sanitizeCsvFreeText,
  buildCsvText,
  csvMoney,
} from '../../src/domain/export/csv'
import { parseCsvBody } from '../data/export-fixtures'

/**
 * P117 §17 — CSV formula-injection fuzz. export-csv.test.ts pins the hand-written cases; this file
 * property-tests the same defence (src/domain/export/csv.ts's `sanitizeCsvFreeText`, OWASP CSV
 * Injection / WSTG 4.7.21 / CWE-1236) against >=100k generated free-text/malicious payloads.
 *
 * The module's own documented contract (its header comment) is a literal-first-character check
 * against a fixed trigger set (=, +, -, @, tab, CR, LF, and their full-width equivalents) --
 * NOT a "trim first" or "skip invisible characters" check. That is a deliberate, already-reasoned
 * narrowing (a cell that starts with real whitespace is read as literal text by spreadsheets, not
 * a formula, so prefixing it would only corrupt legitimate data for no defensive gain) for a
 * self-export threat model with no attacker-controlled import path. This file tests that EXACT
 * contract precisely and at scale -- not a stronger contract nobody asked for -- and explicitly
 * documents the boundary cases (leading space/NBSP/zero-width before a trigger) as intentionally
 * NOT prefixed, matching the header comment, rather than silently asserting around them.
 * Run via `pnpm test:soak`.
 */

const TRIGGER_CHARS = ['=', '+', '-', '@', '\t', '\r', '\n', '＝', '＋', '－', '＠']
const NON_TRIGGER_LEADING_CHARS = [
  'a',
  '0',
  ' ', // plain leading space -- documented as NOT a trigger
  ' ', // NBSP -- documented as NOT a trigger
  '​', // zero-width space -- documented as NOT a trigger
  '.',
  '#',
  "'", // already-escaped-looking content must not be treated specially either
]

const FORMULA_PAYLOAD_BODIES = [
  'SUM(A1:A9)',
  'HYPERLINK("http://evil.example","x")',
  "cmd|'/C calc'!A1",
  '1+1',
  'WEBSERVICE("http://evil.example")',
  '',
]

describe('sanitizeCsvFreeText / csvFreeText soak — >=100k cases', () => {
  it("40k cases: any string whose FIRST character is a trigger gets a bare `'` prefix, content otherwise byte-for-byte unchanged", () => {
    let runs = 0
    fc.assert(
      fc.property(
        fc.constantFrom(...TRIGGER_CHARS),
        fc.oneof(fc.constantFrom(...FORMULA_PAYLOAD_BODIES), fc.string({ maxLength: 40 })),
        (trigger, body) => {
          runs++
          const input = `${trigger}${body}`
          const output = sanitizeCsvFreeText(input)
          expect(output).toBe(`'${input}`)
          expect(output.charAt(0)).toBe("'")
          // The value AFTER the injected quote is exactly the original, untouched string -- the
          // defence never rewrites or drops any of the attacker's/user's actual content.
          expect(output.slice(1)).toBe(input)
        },
      ),
      { numRuns: 40_000 },
    )
    expect(runs).toBe(40_000)
  })

  it('40k cases: any string whose first character is NOT a trigger is returned byte-for-byte unchanged (no accidental mutation)', () => {
    let runs = 0
    fc.assert(
      fc.property(
        fc.string({ maxLength: 60 }).filter((s) => !TRIGGER_CHARS.includes(s.charAt(0))),
        (input) => {
          runs++
          expect(sanitizeCsvFreeText(input)).toBe(input)
        },
      ),
      { numRuns: 40_000 },
    )
    expect(runs).toBe(40_000)
  })

  it('20k cases: DISCLOSED boundary -- leading space/NBSP/zero-width before a trigger is (by documented design) NOT prefixed, and the trigger char is preserved verbatim at its original position', () => {
    let runs = 0
    fc.assert(
      fc.property(
        fc.constantFrom(...NON_TRIGGER_LEADING_CHARS),
        fc.constantFrom(...TRIGGER_CHARS),
        fc.constantFrom(...FORMULA_PAYLOAD_BODIES),
        (leading, trigger, body) => {
          runs++
          const input = `${leading}${trigger}${body}`
          const output = sanitizeCsvFreeText(input)
          // This is the documented, accepted contract, not a discovered bug: the sanitizer keys
          // ONLY off charAt(0), and a real leading-whitespace/invisible character makes charAt(0)
          // not a trigger, so no prefix is added.
          expect(output).toBe(input)
        },
      ),
      { numRuns: 20_000 },
    )
    expect(runs).toBe(20_000)
  })

  it('10k cases: idempotent -- re-sanitizing an already-sanitized value never changes it or double-prefixes', () => {
    let runs = 0
    fc.assert(
      fc.property(
        fc.oneof(fc.constantFrom(...TRIGGER_CHARS), fc.constantFrom(...NON_TRIGGER_LEADING_CHARS)),
        fc.string({ maxLength: 30 }),
        (first, rest) => {
          runs++
          const input = `${first}${rest}`
          const once = sanitizeCsvFreeText(input)
          const twice = sanitizeCsvFreeText(once)
          expect(twice).toBe(once)
        },
      ),
      { numRuns: 10_000 },
    )
    expect(runs).toBe(10_000)
  })

  it('null/undefined always map to the empty field, never a fabricated value', () => {
    expect(csvFreeText(null)).toBe('')
    expect(csvFreeText(undefined)).toBe('')
  })
})

describe('full CSV row soak — malicious free-text mixed with real money/date columns, round-tripped', () => {
  it('10k cases: a malicious free-text field never produces an executable-looking cell after a full write+parse round-trip, and money/date columns are untouched by sanitization', () => {
    let runs = 0
    fc.assert(
      fc.property(
        fc.constantFrom(...TRIGGER_CHARS, ...NON_TRIGGER_LEADING_CHARS),
        fc.constantFrom(...FORMULA_PAYLOAD_BODIES),
        fc.bigInt({ min: -10_000_00n, max: 10_000_00n }),
        (firstChar, payload, moneyMinor) => {
          runs++
          const maliciousNote = `${firstChar}${payload}`
          const sanitizedNote = csvFreeText(maliciousNote)
          const moneyCell = csvMoney(moneyMinor.toString(), 'NOK')
          const body = buildCsvText(['note', 'amount'], [[sanitizedNote, moneyCell]])
          const parsed = parseCsvBody(body) // strips the BOM internally
          const dataRow = parsed[1]
          expect(dataRow).toBeDefined()
          const [parsedNote, parsedAmount] = dataRow as [string, string]

          // The parsed note is exactly what sanitizeCsvFreeText produced -- structural CSV quoting
          // never altered the logical content.
          expect(parsedNote).toBe(sanitizedNote)

          // If the ORIGINAL first character was a real trigger, the round-tripped cell must NOT
          // begin with that trigger character (the leading `'` defeats it); if it was a
          // non-trigger leading character (the disclosed boundary above), the cell keeps it
          // verbatim, exactly matching the documented, non-hidden behaviour.
          if (TRIGGER_CHARS.includes(firstChar)) {
            expect(TRIGGER_CHARS.includes(parsedNote.charAt(0))).toBe(false)
            expect(parsedNote.charAt(0)).toBe("'")
          } else {
            expect(parsedNote.charAt(0)).toBe(firstChar)
          }

          // The money column is a canonical numeric cell -- it must never be prefixed or
          // otherwise mutated by the free-text defence, even when the amount is a legitimate
          // negative number that happens to start with '-' (a real trigger character).
          expect(parsedAmount).toBe(moneyCell)
          expect(() => BigInt(parsedAmount.replace('.', ''))).not.toThrow()
        },
      ),
      { numRuns: 10_000 },
    )
    expect(runs).toBe(10_000)
  })
})

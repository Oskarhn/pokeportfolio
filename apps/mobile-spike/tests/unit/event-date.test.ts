import {
  assertValidEventDate,
  EARLIEST_EVENT_DATE,
  InvalidEventDateError,
  localDateIso,
  localTodayIso,
} from '../../src/write/event-date'

/**
 * Client-side mirror of P144's server-enforced completed-event date contract. Mutation #16 in
 * output_175.txt: a timezone slip must fail a test, not ship silently.
 */
describe('localDateIso', () => {
  it('uses the LOCAL calendar date, never a UTC-shifted one', () => {
    // A time that is 2026-01-01 local but 2025-12-31 in UTC when the local offset is negative
    // (west of Greenwich) would expose a `toISOString()` bug; construct via local components so
    // the assertion is independent of the host machine's own timezone.
    const local = new Date(2026, 0, 1, 0, 30, 0) // 00:30 local time, Jan 1st
    expect(localDateIso(local)).toBe('2026-01-01')
  })

  it('pads single-digit month and day', () => {
    expect(localDateIso(new Date(2026, 0, 5))).toBe('2026-01-05')
  })

  it('the Oslo/UTC midnight boundary: a local date must not depend on the UTC date', () => {
    // Simulate "01:30 in a UTC+2 zone" by using local Date components directly (Date#getFullYear
    // etc. are LOCAL accessors regardless of host timezone) — the point under test is that
    // localDateIso never routes through toISOString()/getUTC*, which would report the previous day.
    const earlyLocalMorning = new Date(2026, 8, 27, 1, 30, 0) // 2026-09-27 01:30 local
    expect(localDateIso(earlyLocalMorning)).toBe('2026-09-27')
    expect(localDateIso(earlyLocalMorning)).not.toBe(
      new Date(Date.UTC(2026, 8, 26, 23, 30, 0)).toISOString().slice(0, 10),
    )
  })
})

describe('assertValidEventDate', () => {
  const today = '2026-09-27'

  it('accepts today', () => {
    expect(() => assertValidEventDate(today, today)).not.toThrow()
  })

  it('accepts the earliest supported date', () => {
    expect(() => assertValidEventDate(EARLIEST_EVENT_DATE, today)).not.toThrow()
  })

  it('refuses one day before the earliest supported date', () => {
    expect(() => assertValidEventDate('1996-10-19', today)).toThrow(InvalidEventDateError)
  })

  it('refuses a future date', () => {
    expect(() => assertValidEventDate('2026-09-28', today)).toThrow(InvalidEventDateError)
  })

  it('refuses a malformed string', () => {
    expect(() => assertValidEventDate('not-a-date', today)).toThrow(InvalidEventDateError)
    expect(() => assertValidEventDate('2026/09/27', today)).toThrow(InvalidEventDateError)
  })

  it('defaults to the device local today when none is given', () => {
    expect(() => assertValidEventDate(localTodayIso())).not.toThrow()
  })
})

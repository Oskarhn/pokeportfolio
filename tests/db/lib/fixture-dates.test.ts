import { describe, expect, it } from 'vitest'
import { monthlyFixtureDate } from './fixture-dates'

// The date the database trigger accepts at the latest: today + 1 day.
function latestAccepted(now: Date): string {
  const d = new Date(now)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

const at = (iso: string) => new Date(`${iso}T12:00:00Z`)

describe('monthlyFixtureDate', () => {
  const runDays = [
    '2026-10-01', // day 1 - the failing run of P185
    '2026-10-02',
    '2026-10-10',
    '2026-10-31', // month end
    '2026-03-31', // minus one month would overflow into March
    '2026-05-31',
    '2024-02-29', // leap day
    '2024-03-31',
    '2026-01-01', // year boundary, day 1
    '2026-01-05',
    '2026-12-31',
  ]

  it.each(runDays)('never lies after the trigger limit when run on %s', (run) => {
    const now = at(run)
    for (const monthsAgo of [0, 1, 2, 11]) {
      expect(monthlyFixtureDate(now, monthsAgo) <= latestAccepted(now)).toBe(true)
    }
  })

  it.each(runDays)('lands in the intended calendar month when run on %s', (run) => {
    const now = at(run)
    for (const monthsAgo of [0, 1, 2, 11]) {
      const expected = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 1))
        .toISOString()
        .slice(0, 7)
      expect(monthlyFixtureDate(now, monthsAgo).slice(0, 7)).toBe(expected)
    }
  })

  it('early-month regression: day 1 and day 2 resolve the current month to a past-or-today date', () => {
    expect(monthlyFixtureDate(at('2026-10-01'), 0)).toBe('2026-10-01')
    expect(monthlyFixtureDate(at('2026-10-02'), 0)).toBe('2026-10-01')
  })

  it('does not overflow when the previous month is shorter than today’s day number', () => {
    expect(monthlyFixtureDate(at('2026-03-31'), 1)).toBe('2026-02-10')
    expect(monthlyFixtureDate(at('2024-03-31'), 1)).toBe('2024-02-10')
    expect(monthlyFixtureDate(at('2024-02-29'), 12)).toBe('2023-02-10')
  })

  it('crosses the year boundary', () => {
    expect(monthlyFixtureDate(at('2026-01-05'), 1)).toBe('2025-12-10')
    expect(monthlyFixtureDate(at('2026-01-05'), 2)).toBe('2025-11-10')
  })

  it('rejects a negative or fractional offset', () => {
    expect(() => monthlyFixtureDate(at('2026-10-01'), -1)).toThrow()
    expect(() => monthlyFixtureDate(at('2026-10-01'), 0.5)).toThrow()
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { localTodayIso } from '../../src/platform/local-date'

/**
 * P114 §6 — timezone torture for the "what is today" default. The bug this pins: using
 * `new Date().toISOString().slice(0, 10)` reports the UTC calendar day, which is a day BEHIND
 * the local calendar day for any positive UTC offset during the hours after local midnight but
 * before UTC midnight — exactly the Norway (CET/CEST) case, and more dramatically for timezones
 * further east.
 *
 * These tests genuinely change the process timezone (Node reads `process.env.TZ` for every new
 * `Date`, confirmed empirically — it is not cached at process start on this runtime), so they
 * exercise the real local-time code path rather than a mock of it.
 */
describe('localTodayIso — reports the LOCAL calendar day, never the UTC one', () => {
  const originalTz = process.env.TZ

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    if (originalTz === undefined) delete process.env.TZ
    else process.env.TZ = originalTz
  })

  it('a UTC+14 timezone already on the next calendar day is not reported as yesterday (UTC)', () => {
    process.env.TZ = 'Pacific/Kiritimati' // UTC+14, no DST
    // 23:00 UTC on 2026-01-01 is already 2026-01-02 13:00 local in Kiritimati.
    vi.setSystemTime(new Date('2026-01-01T23:00:00Z'))
    expect(localTodayIso()).toBe('2026-01-02')
  })

  it('a UTC-11 timezone still on the previous calendar day is not reported as tomorrow (UTC)', () => {
    process.env.TZ = 'Pacific/Niue' // UTC-11, no DST
    // 01:00 UTC on 2026-01-02 is still 2026-01-01 14:00 local in Niue.
    vi.setSystemTime(new Date('2026-01-02T01:00:00Z'))
    expect(localTodayIso()).toBe('2026-01-01')
  })

  it('Europe/Oslo in winter (CET, UTC+1): the hour after local midnight is not "yesterday"', () => {
    process.env.TZ = 'Europe/Oslo'
    // 2026-01-15T00:30 local (CET) = 2025-01-14T23:30 UTC... using a date with no DST ambiguity:
    // 2026-01-15T23:30:00Z is 2026-01-16T00:30 local — just past local midnight.
    vi.setSystemTime(new Date('2026-01-15T23:30:00Z'))
    expect(localTodayIso()).toBe('2026-01-16')
  })

  it('Europe/Oslo in summer (CEST, UTC+2): two hours after local midnight is not "yesterday"', () => {
    process.env.TZ = 'Europe/Oslo'
    // 2026-07-15T22:30:00Z is 2026-07-16T00:30 CEST — just past local midnight, DST in effect.
    vi.setSystemTime(new Date('2026-07-15T22:30:00Z'))
    expect(localTodayIso()).toBe('2026-07-16')
  })

  it('Norway DST spring-forward boundary (2026-03-29 02:00 CET -> 03:00 CEST): still the correct local day', () => {
    process.env.TZ = 'Europe/Oslo'
    // 2026-03-29T00:30:00Z = 2026-03-29T01:30 CET, just before the spring-forward jump.
    vi.setSystemTime(new Date('2026-03-29T00:30:00Z'))
    expect(localTodayIso()).toBe('2026-03-29')
    // 2026-03-29T01:30:00Z = 2026-03-29T03:30 CEST, just after the jump — same local day.
    vi.setSystemTime(new Date('2026-03-29T01:30:00Z'))
    expect(localTodayIso()).toBe('2026-03-29')
  })

  it('Norway DST fall-back boundary (2026-10-25 03:00 CEST -> 02:00 CET): still the correct local day', () => {
    process.env.TZ = 'Europe/Oslo'
    // 2026-10-25T00:30:00Z = 2026-10-25T02:30 CEST, before fall-back.
    vi.setSystemTime(new Date('2026-10-25T00:30:00Z'))
    expect(localTodayIso()).toBe('2026-10-25')
    // 2026-10-25T01:30:00Z = 2026-10-25T02:30 CET (the repeated hour), same local day.
    vi.setSystemTime(new Date('2026-10-25T01:30:00Z'))
    expect(localTodayIso()).toBe('2026-10-25')
  })

  it('leap day (2028-02-29) round-trips correctly in a positive-offset timezone', () => {
    process.env.TZ = 'Asia/Tokyo' // UTC+9, no DST
    vi.setSystemTime(new Date('2028-02-28T16:30:00Z')) // 2028-02-29T01:30 JST
    expect(localTodayIso()).toBe('2028-02-29')
  })

  it('year boundary: New Year in a positive-offset timezone is not reported as the old year', () => {
    process.env.TZ = 'Asia/Tokyo'
    vi.setSystemTime(new Date('2025-12-31T15:30:00Z')) // 2026-01-01T00:30 JST
    expect(localTodayIso()).toBe('2026-01-01')
  })

  it('America/Los_Angeles (negative offset): late evening does not roll to the next UTC day', () => {
    process.env.TZ = 'America/Los_Angeles' // UTC-8/-7
    vi.setSystemTime(new Date('2026-06-15T23:30:00Z')) // 2026-06-15T16:30 PDT — same local day
    expect(localTodayIso()).toBe('2026-06-15')
  })

  it('always returns a zero-padded YYYY-MM-DD string', () => {
    process.env.TZ = 'UTC'
    vi.setSystemTime(new Date('2026-03-05T12:00:00Z'))
    expect(localTodayIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(localTodayIso()).toBe('2026-03-05')
  })
})

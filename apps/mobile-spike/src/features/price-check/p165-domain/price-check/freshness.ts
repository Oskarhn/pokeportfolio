/**
 * Observation age and freshness. The thresholds deliberately match `resolveMarketValue`
 * (src/domain/market-value.ts): ≤ 3 whole days is fresh, ≤ 30 is stale. Beyond 30 days the
 * portfolio valuation treats a price as missing; Price Check has no valuation to protect, so it
 * still shows the number but labels it `outdated` — never as if it were current.
 *
 * Age is counted in whole UTC calendar days between the observation's date and `now`'s date, the
 * same "whole days as of the resolution date" convention the snapshot resolver uses. The clock is
 * always passed in: this module never reads the wall clock, which keeps it deterministic to test.
 */
import type { Freshness } from './types'

export const FRESH_MAX_AGE_DAYS = 3
export const STALE_MAX_AGE_DAYS = 30
/** A provider timestamp further ahead than this is a malformed value, not "just observed". */
const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000
const MS_PER_DAY = 24 * 60 * 60 * 1000

function utcDayStart(ms: number): number {
  return Math.floor(ms / MS_PER_DAY) * MS_PER_DAY
}

/** Parses an ISO 8601 timestamp; null for anything that is not a valid instant. */
export function parseInstant(value: unknown): number | null {
  if (typeof value !== 'string') return null
  if (!/^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(value.trim())) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

/** Whole days since `observedAtIso` as of `nowMs`; null when the timestamp is absent, unparseable
 *  or unreasonably far in the future (treated as unknown rather than "0 days old"). */
export function ageInDays(observedAtIso: string | null, nowMs: number): number | null {
  if (observedAtIso === null) return null
  const observedMs = parseInstant(observedAtIso)
  if (observedMs === null) return null
  if (observedMs - nowMs > MAX_FUTURE_SKEW_MS) return null
  const days = Math.round((utcDayStart(nowMs) - utcDayStart(observedMs)) / MS_PER_DAY)
  return days < 0 ? 0 : days
}

export function classifyFreshness(observedAtIso: string | null, nowMs: number): Freshness {
  const age = ageInDays(observedAtIso, nowMs)
  if (age === null) return 'unknown'
  if (age <= FRESH_MAX_AGE_DAYS) return 'fresh'
  if (age <= STALE_MAX_AGE_DAYS) return 'stale'
  return 'outdated'
}

/** A Norges Bank rate is published on business days only; a long holiday weekend legitimately
 *  leaves the latest rate 4–5 days old. Beyond a week something is wrong with the ingest and the
 *  conversion is flagged rather than presented as today's rate. */
export const FX_STALE_AFTER_DAYS = 7

export function fxRateAgeDays(rateDate: string, nowMs: number): number | null {
  return ageInDays(rateDate, nowMs)
}

export function isFxRateStale(rateDate: string, nowMs: number): boolean {
  const age = fxRateAgeDays(rateDate, nowMs)
  return age === null || age > FX_STALE_AFTER_DAYS
}

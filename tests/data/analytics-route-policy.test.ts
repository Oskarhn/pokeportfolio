/**
 * Analytics route allowlist (P110, prompt §13-16). Pure logic — no DOM, no fetch — the safety
 * property the rest of the analytics wiring (cloudflareWebAnalytics.ts) depends on entirely.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ANALYTICS_ELIGIBLE_PATHS,
  isAnalyticsEligibleLocation,
} from '../../src/analytics/analyticsRoutePolicy'

describe('isAnalyticsEligibleLocation', () => {
  it('allows the exact three public, non-identifying pages with no query string', () => {
    expect(isAnalyticsEligibleLocation('/privacy', '')).toBe(true)
    expect(isAnalyticsEligibleLocation('/terms', '')).toBe(true)
    expect(isAnalyticsEligibleLocation('/faq', '')).toBe(true)
  })

  it('denies every private/authenticated route named in the prompt, by construction (not listed)', () => {
    const privateRoutes = [
      '/',
      '/portfolio',
      '/portfolio/8f14e45f-ceea-467e-9c1e-1234567890ab',
      '/purchases/8f14e45f-ceea-467e-9c1e-1234567890ab',
      '/sales/8f14e45f-ceea-467e-9c1e-1234567890ab',
      '/history',
      '/scan',
      '/openings/8f14e45f-ceea-467e-9c1e-1234567890ab',
      '/profile',
      '/admin/invitations',
      '/catalog/8f14e45f-ceea-467e-9c1e-1234567890ab',
    ]
    for (const pathname of privateRoutes) {
      expect(isAnalyticsEligibleLocation(pathname, '')).toBe(false)
    }
  })

  it('denies invite and reset-password token routes even though they are public', () => {
    expect(isAnalyticsEligibleLocation('/invite/a-live-secret-token', '')).toBe(false)
    expect(isAnalyticsEligibleLocation('/reset-password', '')).toBe(false)
    expect(isAnalyticsEligibleLocation('/login', '')).toBe(false)
    expect(isAnalyticsEligibleLocation('/forgot-password', '')).toBe(false)
  })

  it('denies an otherwise-eligible path carrying ANY query string — never transmits query params', () => {
    expect(isAnalyticsEligibleLocation('/faq', '?ref=email')).toBe(false)
    expect(isAnalyticsEligibleLocation('/privacy', '?')).toBe(false)
    expect(isAnalyticsEligibleLocation('/terms', '?utm_source=x&utm_medium=y')).toBe(false)
  })

  it('denies an unknown path outright (deny-by-default, matching D-116)', () => {
    expect(isAnalyticsEligibleLocation('/some-future-route', '')).toBe(false)
    expect(isAnalyticsEligibleLocation('', '')).toBe(false)
  })
})

describe('ANALYTICS_ELIGIBLE_PATHS matches the existing crawlable-public allowlist', () => {
  it("mirrors scripts/check-links.mjs's own PUBLIC_ROUTES constant exactly (kept in sync by this test, not by import — see analyticsRoutePolicy.ts's header)", () => {
    const checkLinksSource = readFileSync(
      new URL('../../scripts/check-links.mjs', import.meta.url),
      'utf-8',
    )
    const match = /const PUBLIC_ROUTES = (\[[^\]]*\])/.exec(checkLinksSource)
    if (match === null) throw new Error('PUBLIC_ROUTES not found in scripts/check-links.mjs')
    const arrayLiteral = match[1]
    if (arrayLiteral === undefined) throw new Error('PUBLIC_ROUTES capture group was empty')
    const publicRoutes = JSON.parse(arrayLiteral.replace(/'/g, '"')) as string[]
    expect([...ANALYTICS_ELIGIBLE_PATHS].sort()).toEqual([...publicRoutes].sort())
  })
})

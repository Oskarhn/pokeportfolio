import { test, expect } from '@playwright/test'

/**
 * P108 §22 — the private authenticated performance harness P105 left unbuilt. Measures
 * navigation-to-meaningful-content for the three routes named in the prompt, against a REAL
 * signed-in session on the real local Supabase stack (the same harness private-routes-smoke.spec.ts
 * uses) — never Lighthouse, and never an arbitrary `page.waitForTimeout`. "Meaningful content" here
 * is `networkidle`: every fetch/XHR the route's own data layer issued has settled, which for a
 * React Query-driven page correlates with real data having rendered, not a skeleton.
 *
 * THRESHOLDS ARE EVIDENCE-BASED, not asserted from a spec (docs/CLAUDE.md: never invent project
 * state) — this file's own FIRST real measurement session (P108, this local machine, 5 samples per
 * route against a freshly-seeded synthetic account):
 *
 *   Home:       min= 653ms  median= 993ms  max=1319ms
 *   Portfolio:  min= 903ms  median= 976ms  max=2124ms
 *   Purchases:  min= 621ms  median= 751ms  max=2086ms
 *
 * The thresholds below are a generous, catastrophic-only ceiling over that real max — the same
 * "single generous threshold" discipline scripts/portfolio-snapshots-benchmark.mjs already
 * established for HOME_SLOW_MS/REBUILD_SLOW_MS (D-059) — so this gate catches a real regression (a
 * query that got dramatically slower) without flagging ordinary local dev-server/network variance
 * (both Portfolio and Purchases already showed a >2x spread between min and max on a single quiet
 * run). A future session that revises these numbers should do so from a fresh real measurement,
 * never by copying this comment's numbers forward blind.
 */

const ROUTES: { name: string; path: string; thresholdMs: number }[] = [
  { name: 'Home', path: '/', thresholdMs: 5000 },
  { name: 'Portfolio', path: '/portfolio', thresholdMs: 5000 },
  { name: 'Purchases', path: '/purchases', thresholdMs: 5000 },
]

const SAMPLES_PER_ROUTE = 5

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

for (const route of ROUTES) {
  test(`private perf: ${route.name} (${route.path}) navigation-to-meaningful-content`, async ({
    page,
  }) => {
    const samples: number[] = []
    for (let i = 0; i < SAMPLES_PER_ROUTE; i += 1) {
      const start = Date.now()
      await page.goto(route.path)
      await page.waitForLoadState('networkidle')
      samples.push(Date.now() - start)
    }

    const med = median(samples)
    const max = Math.max(...samples)
    const min = Math.min(...samples)
    console.log(
      `[private-perf] ${route.name}: min=${min}ms median=${med}ms max=${max}ms samples=${JSON.stringify(samples)}`,
    )

    expect(
      med,
      `${route.name} median navigation-to-networkidle (${med}ms) exceeded the evidence-based ${route.thresholdMs}ms ceiling — samples: ${samples.join(', ')}`,
    ).toBeLessThan(route.thresholdMs)
  })
}

#!/usr/bin/env node
/**
 * Manual, optional live contract check against the real Norges Bank API (M8 prompt §93).
 * Never run in CI — tests/data/norges-bank.test.ts is the deterministic, no-network regression
 * that runs on every push. This script is for a human to run by hand, occasionally, to notice if
 * the real API's shape or orientation has ever changed.
 *
 * Usage: node scripts/verify-norges-bank-contract.mjs
 */

const BASE = 'EUR'
const today = new Date()
const end = today.toISOString().slice(0, 10)
const start = new Date(today.getTime() - 10 * 86_400_000).toISOString().slice(0, 10)

const url = new URL(`https://data.norges-bank.no/api/data/EXR/B.${BASE}.NOK.SP`)
url.searchParams.set('format', 'sdmx-json')
url.searchParams.set('startPeriod', start)
url.searchParams.set('endPeriod', end)
url.searchParams.set('locale', 'en')

console.log(`Requesting ${url}`)
const response = await fetch(url)
if (!response.ok) {
  console.error(`FAIL: HTTP ${response.status}`)
  process.exit(1)
}
const body = await response.json()

const series = Object.values(body?.data?.dataSets?.[0]?.series ?? {})[0]
const observations = series?.observations
const timeValues = body?.data?.structure?.dimensions?.observation?.[0]?.values

if (!observations || !timeValues) {
  console.error('FAIL: response did not have the expected SDMX-JSON shape')
  console.error(JSON.stringify(body, null, 2).slice(0, 2000))
  process.exit(1)
}

const entries = Object.entries(observations).map(([index, value]) => ({
  date: timeValues[Number(index)]?.id,
  rate: value[0],
}))
entries.sort((a, b) => (a.date < b.date ? -1 : 1))

console.log(`OK: ${entries.length} observation(s), ${BASE}/NOK, ${start}..${end}`)
for (const { date, rate } of entries) {
  console.log(`  ${date}: ${rate} NOK per 1 ${BASE}`)
}

const latest = entries.at(-1)
if (!latest || Number(latest.rate) < 5 || Number(latest.rate) > 20) {
  console.error(
    `FAIL: latest rate ${latest?.rate} is outside a plausible EUR/NOK range — check orientation`,
  )
  process.exit(1)
}
console.log('Orientation looks right: EUR/NOK in the expected 5-20 range.')

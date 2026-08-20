#!/usr/bin/env node
/**
 * Orchestrates a full-catalog sync by calling the sync-catalog Edge Function once per
 * (language, TCGdex set) pair. The function itself is deliberately dumb — it does exactly the set
 * it is told and nothing else (docs/DEVELOPMENT.md, sync-catalog's own header) — so the ordering,
 * Pocket pre-filtering, pacing and retry policy all live here instead.
 *
 * Usage:
 *   CATALOG_SYNC_URL=https://<ref>.supabase.co/functions/v1/sync-catalog \
 *   CATALOG_SYNC_SECRET=<secret> \
 *   node scripts/run-catalog-sync.mjs --language=en [--language=ja] [--only=<setId>]
 *
 * Every set is (re)synced unconditionally — there is no local "already done" tracking here, only
 * catalog_sync_runs on the server side. Re-running a set is cheap and idempotent, so a partial or
 * interrupted run is simply resumed by running the same command again.
 *
 * Neither env var is a Supabase platform secret (not service_role, not the DB password) — see the
 * sync-catalog function header for what CATALOG_SYNC_SECRET actually gates. Still not committed
 * anywhere, same as every other operational credential in this project.
 *
 * Respectful of the upstream (docs/API_SOURCES.md: "no published hard rate limit, but please be
 * considerate"): one set in flight at a time from this script (the Edge Function itself fetches a
 * set's cards with bounded internal concurrency), a short pause with jitter between sets, and
 * capped retries with backoff on transient failure. This is a one-time/manual-refresh tool
 * (M5 prompt §32) — nothing schedules it.
 */

const TCGDEX_BASE = 'https://api.tcgdex.net/v2'
const SET_PAUSE_MS = 400
const MAX_ATTEMPTS = 3

function parseArgs(argv) {
  const languages = []
  let only = null
  for (const arg of argv) {
    if (arg.startsWith('--language=')) languages.push(arg.slice('--language='.length))
    else if (arg.startsWith('--only=')) only = arg.slice('--only='.length)
  }
  return { languages: languages.length > 0 ? languages : ['en', 'ja'], only }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchJson(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${response.status} fetching ${url}`)
  return response.json()
}

/** The set ids belonging to the Pokémon TCG Pocket series, pre-filtered so we never even call the
 *  function for them — the function also refuses them itself (defense in depth), but there is no
 *  reason to spend a request finding that out from here. */
async function pocketSetIds(language) {
  try {
    const serie = await fetchJson(`${TCGDEX_BASE}/${language}/series/tcgp`)
    return new Set((serie.sets ?? []).map((s) => s.id))
  } catch {
    return new Set() // No Pocket series for this language (observed: Japanese has none today).
  }
}

async function syncOneSet(functionUrl, secret, language, setId) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(functionUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ language, setId }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`)
      return body
    } catch (error) {
      if (attempt === MAX_ATTEMPTS) throw error
      const backoff = 1000 * 2 ** attempt + Math.random() * 500
      console.warn(
        `  retry ${attempt}/${MAX_ATTEMPTS} for ${language}/${setId} after error: ${error.message}`,
      )
      await sleep(backoff)
    }
  }
}

async function main() {
  const { languages, only } = parseArgs(process.argv.slice(2))
  const functionUrl = process.env.CATALOG_SYNC_URL
  const secret = process.env.CATALOG_SYNC_SECRET
  if (!functionUrl || !secret) {
    console.error('CATALOG_SYNC_URL and CATALOG_SYNC_SECRET must be set in the environment.')
    process.exit(1)
  }

  const summary = []

  for (const language of languages) {
    const sets = only ? [{ id: only }] : await fetchJson(`${TCGDEX_BASE}/${language}/sets`)
    const pocket = only ? new Set() : await pocketSetIds(language)
    const toSync = sets.filter((s) => !pocket.has(s.id))

    console.log(
      `\n=== ${language}: ${toSync.length} sets to sync (${pocket.size} Pocket sets excluded) ===`,
    )

    let done = 0
    for (const set of toSync) {
      done++
      process.stdout.write(`[${done}/${toSync.length}] ${language}/${set.id} ... `)
      try {
        const result = await syncOneSet(functionUrl, secret, language, set.id)
        console.log(
          result.skipped
            ? `skipped (${result.skipped})`
            : `${result.cardsUpserted}/${result.cardsSeen} cards, ${result.variantsUpserted} variants` +
                (result.failureCount ? `, ${result.failureCount} card failures` : ''),
        )
        summary.push({ language, setId: set.id, ...result })
      } catch (error) {
        console.log(`FAILED: ${error.message}`)
        summary.push({ language, setId: set.id, ok: false, error: error.message })
      }
      await sleep(SET_PAUSE_MS + Math.random() * 200)
    }
  }

  const totals = summary.reduce(
    (acc, r) => ({
      cards: acc.cards + (r.cardsUpserted ?? 0),
      variants: acc.variants + (r.variantsUpserted ?? 0),
      failedSets: acc.failedSets + (r.ok === false ? 1 : 0),
    }),
    { cards: 0, variants: 0, failedSets: 0 },
  )
  console.log(
    `\n=== Done: ${totals.cards} cards, ${totals.variants} variants upserted, ${totals.failedSets} sets failed outright ===`,
  )
  if (totals.failedSets > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

/**
 * P85 §6 — local unique-name lexicon generator, for `src/domain/scanner/name-lexicon.ts`'s
 * fuzzy resolution: `~20,946 cards` share far fewer UNIQUE printed names (most Pokémon/Trainer/
 * Energy names repeat across many printings), so a lexicon of NAMES ONLY is plausibly small
 * enough to ship or generate cheaply, unlike a per-printing index.
 *
 * Two sources, selected automatically:
 *
 *   1. REAL catalog (`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` set) — pages through `cards`
 *      selecting only `name` (never anything else — no cost/collection data, no user data of any
 *      kind touches this script), matching scripts/scanner-visual-index/build-index.ts's own
 *      paging discipline (PostgREST's default 1000-row cap means a single `.select()` silently
 *      truncates a table this size — this script pages explicitly rather than trusting one call).
 *   2. DEMO fallback (no credentials) — the P85 OCR benchmark's cached real TCGdex corpus
 *      (scripts/scanner-ocr-benchmark, ~1,000 real cards across 7 sets) as a smaller, honestly
 *      labeled substitute so the generator/verifier is still runnable and testable without a
 *      database connection. NOT run against the real ~20,946-card catalog this session — no
 *      Supabase credentials were available (the same standing constraint every M15 session since
 *      P75 has disclosed).
 *
 * Output: a single JSON array of normalized unique names (`normalizeCardText`'s output — the SAME
 * normalization `name-lexicon.ts` itself applies before comparison), written to
 * `scripts/scanner-name-lexicon/generated/lexicon.json` (gitignored — generated content, same
 * discipline as `public/scanner-assets/`).
 *
 * Run: `pnpm scanner:name-lexicon:build`
 */
import { createClient } from '@supabase/supabase-js'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildNameLexicon } from '../../src/domain/scanner/name-lexicon'
import { loadOcrCorpus } from '../scanner-ocr-benchmark/lib/corpus-lexicon.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const OUTPUT_DIR = join(here, 'generated')
const OUTPUT_PATH = join(OUTPUT_DIR, 'lexicon.json')

const PAGE_SIZE = 1000

async function fetchRealCatalogNames(url: string, serviceRoleKey: string): Promise<string[]> {
  const supabase = createClient(url, serviceRoleKey)
  const names: string[] = []
  let from = 0
  for (;;) {
    const { data, error } = await supabase
      .from('cards')
      .select('name')
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`cards select failed: ${error.message}`)
    if (data.length === 0) break
    for (const row of data as { name: string }[]) names.push(row.name)
    if (data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return names
}

interface CorpusRow {
  name: string
}

async function main() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  let source: 'real-catalog' | 'ocr-benchmark-corpus-demo'
  let rawNames: string[]

  if (url && key) {
    source = 'real-catalog'
    console.log(`[name-lexicon] fetching real catalog names from ${url}...`)
    rawNames = await fetchRealCatalogNames(url, key)
  } else {
    source = 'ocr-benchmark-corpus-demo'
    console.log(
      '[name-lexicon] SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set — falling back to the ' +
        'P85 OCR benchmark corpus (~1,000 real TCGdex cards) as a DEMO dataset. This is NOT the ' +
        'real ~20,946-card catalog lexicon; re-run with real credentials for the production one.',
    )
    const corpus = (await loadOcrCorpus()) as CorpusRow[]
    rawNames = corpus.map((row) => row.name)
  }

  const lexicon = buildNameLexicon(rawNames)
  const output = {
    generatedAt: new Date().toISOString(),
    source,
    rawNameCount: rawNames.length,
    uniqueNameCount: lexicon.length,
    names: lexicon,
  }

  await mkdir(OUTPUT_DIR, { recursive: true })
  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2))
  const bytes = Buffer.byteLength(JSON.stringify(output.names))
  console.log(
    `[name-lexicon] source=${source} rawNames=${String(rawNames.length)} ` +
      `uniqueNames=${String(lexicon.length)} namesArrayBytes=${String(bytes)}`,
  )
  console.log(`[name-lexicon] wrote ${OUTPUT_PATH}`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})

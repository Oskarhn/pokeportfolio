#!/usr/bin/env node
/**
 * LOCAL-ONLY, DEV-DATABASE-ONLY seeding helper (P76). Inserts the same real, diverse TCGdex
 * corpus used by scripts/scanner-visual-benchmark into the LOCAL Supabase Postgres catalog
 * tables, so scripts/scanner-visual-index/build-index.ts has more than the 40-row synthetic
 * seed to build a meaningfully-sized DEMONSTRATION index against.
 *
 * WHY THIS EXISTS (read docs/SCANNER_RESEARCH.md §7b before assuming this is the real pipeline):
 * this session has no hosted-project credential (it must never sign in or create an account to
 * get one — see CLAUDE.md's prohibited-actions list) and the hosted catalog rejects the anon key
 * for both `cards` and `search_cards` (verified live). Real hosted-scale index generation is a
 * ONE-TIME step the owner runs themselves with a hosted SUPABASE_SERVICE_ROLE_KEY exported in
 * their OWN shell (never pasted to an assistant) — see the `scanner:index:build` doc comment.
 *
 * Every id here is a LOCAL gen_random_uuid() — it will NEVER match a hosted `cards.id`. Anything
 * built from this seed is a demonstration of the pipeline's mechanics, not a hosted-valid index.
 *
 * Requires `pnpm scanner:visual:benchmark` (or its corpus-fetch step) to have already populated
 * scripts/scanner-visual-benchmark/.benchmark-cache/corpus.json.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const corpusPath = join(here, '..', 'scanner-visual-benchmark', '.benchmark-cache', 'corpus.json')

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

async function main() {
  const corpus = JSON.parse(await readFile(corpusPath, 'utf-8'))
  const bySet = new Map()
  for (const row of corpus) {
    if (!bySet.has(row.setId))
      bySet.set(row.setId, { name: row.setName, language: row.language, cards: [] })
    bySet.get(row.setId).cards.push(row)
  }

  const languages = [...new Set(corpus.map((r) => r.language))]
  const statements = languages.map(
    (lang) => `insert into public.card_series (slug, name, language)
       values ('m15-visual-benchmark-demo', 'M15 Visual Benchmark Demo Series', ${sqlString(lang)})
       on conflict (language, slug) do nothing;`,
  )

  for (const [setId, set] of bySet.entries()) {
    statements.push(`
      insert into public.card_sets (series_id, slug, name, language, tcgdex_set_id)
      select id, ${sqlString(`demo-${setId}`)}, ${sqlString(set.name)}, ${sqlString(set.language)}, ${sqlString(setId)}
      from public.card_series where slug = 'm15-visual-benchmark-demo' and language = ${sqlString(set.language)}
      on conflict (language, tcgdex_set_id) do nothing;
    `)
  }

  for (const [setId, set] of bySet.entries()) {
    for (const card of set.cards) {
      statements.push(`
        with target_set as (
          select id from public.card_sets where tcgdex_set_id = ${sqlString(setId)} and language = ${sqlString(set.language)}
        ), inserted_card as (
          insert into public.cards (set_id, local_id, name, language, image_base_url, tcgdex_card_id, category)
          select id, ${sqlString(card.localId)}, ${sqlString(card.name)}, ${sqlString(set.language)},
                 ${sqlString(card.imageUrl.replace(/\/high\.webp$/, ''))}, ${sqlString(card.cardId)}, 'demo'
          from target_set
          on conflict (language, tcgdex_card_id) do update set name = excluded.name
          returning id
        )
        insert into public.card_variants (card_id, finish, size, is_active, tcgdex_variant_id)
        select id, 'normal', 'standard', true, ${sqlString(`${card.cardId}-normal`)}
        from inserted_card
        on conflict (card_id, finish, stamp, subtype, size) do nothing;
      `)
    }
  }

  const sqlFile = join(here, '.visual-index-cache', 'seed-local-demo-catalog.sql')
  await writeFile(sqlFile, statements.join('\n'))
  console.log(`seed-local-demo-catalog: wrote ${statements.length} statements to ${sqlFile}`)

  execFileSync(
    'docker',
    [
      'exec',
      '-i',
      'supabase_db_pokeportfolio',
      'psql',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
    ],
    { stdio: ['pipe', 'inherit', 'inherit'], input: await readFile(sqlFile) },
  )
  console.log('seed-local-demo-catalog: done')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

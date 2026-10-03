#!/usr/bin/env node
/**
 * Seeds the P184 adversarial-scenario catalog rows into the ISOLATED local stack (never hosted),
 * derived from the DEVICE calibration runs so each scenario is real, not assumed:
 *
 *   calibration.json        synthetic fixtures: which index cards the visual channel ranks first
 *   calibration-real.json   LOCAL-ONLY real-artwork photos (see make-real-art-photos.mjs)
 *
 * The visual index maps rows to catalog ids of the HOSTED catalog, none of which exist in the
 * isolated stack; a row is inserted under such an id so "visual says A" is true on the device. Text
 * comes from what the fixture prints. Every row lives in a `P184 ...` set so it can be removed.
 *
 *   node scripts/p184/scenario-catalog.mjs seed | clean | show
 */
import './env.mjs'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { outDir, psql } from './lib.mjs'

const q = (s) => `'${String(s).replaceAll("'", "''")}'`
const load = (name) => {
  const file = join(outDir, name)
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}

const SETS = [
  { slug: 'p184-alpha', name: 'P184 Set Alpha' },
  { slug: 'p184-beta', name: 'P184 Set Beta' },
  { slug: 'p184-real', name: 'P184 Real-art Base' },
]

function clean() {
  psql(`
    delete from card_variants where card_id in (select c.id from cards c join card_sets s on s.id = c.set_id where s.slug like 'p184-%');
    delete from cards where set_id in (select id from card_sets where slug like 'p184-%');
    delete from card_sets where slug like 'p184-%';
  `)
}

function seed() {
  clean()
  const cal = load('calibration.json')
  const real = load('calibration-real.json')
  if (cal === null) throw new Error('run calibrate.mjs first')
  const series = psql('select series_id from card_sets order by created_at limit 1;')
  for (const s of SETS) {
    psql(
      `insert into card_sets (series_id, slug, name, language) values (${q(series)}::uuid, ${q(s.slug)}, ${q(s.name)}, 'en');`,
    )
  }
  const setId = (slug) => psql(`select id from card_sets where slug = ${q(slug)};`)
  const used = new Set()
  const rows = []

  /** The n-th visual neighbour of a fixture that no earlier scenario row has claimed. */
  const visualId = (fixtureId, which = 0) => {
    const f = cal.find((x) => x.id === fixtureId)
    if (f === undefined) throw new Error(`no calibration for ${fixtureId}`)
    const free = f.trace.visualTop.map((v) => v.cardId).filter((id) => !used.has(id))
    const id = free[which]
    if (id === undefined) throw new Error(`no free visual neighbour for ${fixtureId}`)
    used.add(id)
    return id
  }
  const add = (scenario, { id, name, localId, set }) => {
    psql(
      `insert into cards (id, set_id, local_id, name, language, category) values (${
        id === null ? 'gen_random_uuid()' : `${q(id)}::uuid`
      }, ${q(setId(set))}::uuid, ${q(localId)}, ${q(name)}, 'en', 'Pokemon');`,
    )
    const cardId = psql(
      `select id from cards where set_id = ${q(setId(set))}::uuid and local_id = ${q(localId)};`,
    )
    rows.push({ scenario, cardId, name, localId, set, viaVisualNeighbour: id !== null })
    return cardId
  }

  // f01: OCR text and the visual neighbour agree on ONE card (controlled positive).
  add('f01 positive', {
    id: visualId('f01-clean'),
    name: 'Sparkfin',
    localId: '007',
    set: 'p184-alpha',
  })
  // f13: OCR says Voltmoth (a row visual does not point at); visual points at Ashgrove.
  add('f13 ocr card', { id: null, name: 'Voltmoth', localId: '012', set: 'p184-beta' })
  add('f13 visual card', {
    id: visualId('f13-ocr-vs-visual'),
    name: 'Ashgrove',
    localId: '088',
    set: 'p184-alpha',
  })
  // f14: visual points at Emberlyn 021; the printed number belongs to Emberlyn 044.
  add('f14 visual card', {
    id: visualId('f14-visual-vs-number'),
    name: 'Emberlyn',
    localId: '021',
    set: 'p184-alpha',
  })
  add('f14 number card', { id: null, name: 'Emberlyn', localId: '044', set: 'p184-beta' })
  // f15: two printings of Glimmerfox (same number, two sets) that BOTH look like the artwork.
  add('f15 printing 1', {
    id: visualId('f15-same-art-reprint', 0),
    name: 'Glimmerfox',
    localId: '015',
    set: 'p184-alpha',
  })
  add('f15 printing 2', {
    id: visualId('f15-same-art-reprint', 0),
    name: 'Glimmerfox',
    localId: '015',
    set: 'p184-beta',
  })
  // f16: the printed number 023 exists in two sets under two names; only one matches the name.
  add('f16 name card', { id: null, name: 'Duskwing', localId: '023', set: 'p184-alpha' })
  add('f16 other card', {
    id: visualId('f16-duplicate-number'),
    name: 'Nightglide',
    localId: '023',
    set: 'p184-beta',
  })

  if (real !== null) {
    const claim = (entry, which) => {
      const id = entry.trace.visualTop[which]?.cardId
      if (id === undefined || used.has(id))
        throw new Error(`cannot claim visual ${which} of ${entry.file}`)
      used.add(id)
      return id
    }
    const byFile = (part) => real.find((e) => e.file.includes(part))
    // R1 Alakazam: text and strong visual agree.
    add('real base1-1', {
      id: claim(byFile('base1-1.'), 0),
      name: 'Alakazam',
      localId: '1',
      set: 'p184-real',
    })
    // R2 Blastoise: the two closest artworks are BOTH catalog cards named Blastoise (siblings).
    add('real base1-2 a', {
      id: claim(byFile('base1-2.'), 0),
      name: 'Blastoise',
      localId: '2',
      set: 'p184-real',
    })
    add('real base1-2 b', {
      id: claim(byFile('base1-2.'), 1),
      name: 'Blastoise',
      localId: '2',
      set: 'p184-alpha',
    })
    // R3 Charizard: printed number OCR misreads; the card is otherwise fully supported.
    add('real base1-4', {
      id: claim(byFile('base1-4.'), 0),
      name: 'Charizard',
      localId: '4',
      set: 'p184-real',
    })
    // R4 Pikachu.
    add('real base1-58', {
      id: claim(byFile('base1-58.'), 0),
      name: 'Pikachu',
      localId: '58',
      set: 'p184-real',
    })
    // R5 Zapdos: only a same-NAME decoy exists; the artwork's own card is not in the catalog.
    add('real base1-16 decoy', { id: null, name: 'Zapdos', localId: '16', set: 'p184-alpha' })
    // R6 Venusaur: nothing seeded — a strong visual match to a card this catalog does not hold.
  }

  writeFileSync(join(outDir, 'scenario-rows.json'), `${JSON.stringify(rows, null, 2)}\n`)
  console.log(`seeded ${String(rows.length)} scenario rows`)
  for (const r of rows) console.log(`  ${r.scenario.padEnd(22)} ${r.name} #${r.localId} (${r.set})`)
}

const command = process.argv[2]
if (command === 'seed') seed()
else if (command === 'clean') {
  clean()
  console.log('removed every P184 scenario row')
} else if (command === 'show') {
  console.log(
    psql(
      "select s.name, c.local_id, c.name, c.id from cards c join card_sets s on s.id = c.set_id where s.slug like 'p184-%' order by s.slug, c.local_id;",
    ),
  )
} else {
  console.error('usage: scenario-catalog.mjs seed|clean|show')
  process.exit(2)
}

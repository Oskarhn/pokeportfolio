/**
 * Journey helpers shared by the P184 flow and write-reliability drivers: financial-table counts for
 * the synthetic user, and the scanner -> card -> printing path. LOCAL ONLY.
 */
import './env.mjs'
import { join } from 'node:path'
import { openPhotoScreen } from '../android-p167-lib.mjs'
import {
  byId,
  byIdPrefix,
  dump,
  fixtureDir,
  psql,
  scanFixture,
  tap,
  users,
  waitFor,
} from './lib.mjs'
import { findScrolling } from './flows.mjs'

export const B = users.b

/** Counts of every financial table for user B; a change in any of them is a write. */
export const finCounts = () =>
  psql(
    ['holdings', 'acquisition_lots', 'purchases', 'purchase_lines', 'sales', 'manual_valuations']
      .map((t) => `(select count(*) from ${t} where user_id='${B.id}')`)
      .join(" || '|' || "),
  ).replace(/\s/g, '')
export const counts = () => finCounts().split('|').map(Number)
export const NAMES = ['holdings', 'lots', 'purchases', 'purchaseLines', 'sales', 'manualValuations']
export const diff = (before, after) =>
  Object.fromEntries(NAMES.map((n, i) => [n, after[i] - before[i]]).filter(([, d]) => d !== 0))

export async function scanToCard(fixtureFile, label, wantName) {
  await openPhotoScreen()
  const { trace, ui } = await scanFixture(join(fixtureDir, fixtureFile), { label })
  const candidate = ui.candidates.find((c) => c.label.startsWith(wantName)) ?? ui.candidates[0]
  if (!candidate) throw new Error(`no candidate for ${wantName}: ${ui.kind}`)
  const node = byId(ui.nodes, `p169-recognition-candidate-${candidate.id}`)
  tap(node)
  await waitFor((ns) => byId(ns, 'p169-card') || byId(ns, 'p169-card-identity'), {
    timeoutMs: 30000,
    label: 'card screen',
  })
  return { trace, ui, cardId: candidate.id }
}

export async function choosePrinting(cardId, finish) {
  const variants = psql(
    `select id||'|'||finish||'|'||stamp||'|'||is_active from card_variants where card_id='${cardId}' order by finish, stamp`,
  )
    .split('\n')
    .map((l) => l.split('|'))
  const wanted =
    variants.find((v) => v[1] === finish && v[3] === 't') ?? variants.find((v) => v[3] === 't')
  const choice = byId(dump(), 'p169-printing-choice')
  if (choice) {
    const { node } = await findScrolling(`p169-variant-${wanted[0]}`)
    tap(node)
  }
  await waitFor(
    (ns) =>
      byIdPrefix(ns, 'p169-raw-')[0] ||
      byIdPrefix(ns, 'p169-lookup-error-')[0] ||
      byIdPrefix(ns, 'p169-obs-')[0],
    { timeoutMs: 40000, label: 'price result' },
  )
  return {
    variantId: wanted[0],
    finish: wanted[1],
    stamp: wanted[2],
    hadChoice: choice !== undefined,
  }
}

export const priceTexts = () =>
  dump()
    .filter((n) => /^p169-(raw|obs)-/.test(n.id.replace(/^.*:id\//, '')) && n.text)
    .map((n) => `${n.id.replace(/^.*:id\//, '')}=${n.text}`)
    .slice(0, 8)

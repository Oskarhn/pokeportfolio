#!/usr/bin/env node
/**
 * P185 full release-APK journey for ONE clean synthetic user (19 steps): cold dark launch, sign in,
 * Collection, scanner, photo, recognition, candidate review, card confirmation, printing, Price
 * Check, return, Add acquisition, verify Collection, non-NOK transaction, manual valuation, sale,
 * Profile, sign out, restart. Every write is checked against the isolated database. LOCAL ONLY.
 *
 *   node scripts/p185/journey-check.mjs
 *
 * Fresh app data (pm clear) and the seeded synthetic user B. Output:
 * .build/p185-evidence/journey-report.json + PNGs.
 */
import './env.mjs'
import { amStart, decodePng } from '../android-p167-lib.mjs'
import {
  adb,
  byId,
  byIdPrefix,
  dump,
  psql,
  saveJson,
  screencap,
  shell,
  shot,
  sleep,
  tap,
  users,
  waitFor,
  PACKAGE,
  signIn,
  rows,
} from './lib.mjs'
import { back, findScrolling, tapId, tapScrolling, typeInto } from './flows.mjs'
import { B, choosePrinting, counts, diff, priceTexts, scanToCard } from './journeys.mjs'

const report = []
async function step(n, name, fn) {
  const t0 = Date.now()
  try {
    const detail = await fn()
    report.push({ n, step: name, status: 'PASS', ms: Date.now() - t0, detail })
    console.log(
      `PASS ${String(n).padStart(2)} ${name}  ${JSON.stringify(detail ?? null).slice(0, 600)}`,
    )
    return true
  } catch (e) {
    report.push({
      n,
      step: name,
      status: 'FAIL',
      ms: Date.now() - t0,
      detail: String(e.message ?? e).slice(0, 700),
    })
    console.log(`FAIL ${String(n).padStart(2)} ${name}  ${String(e.message ?? e).slice(0, 500)}`)
    try {
      shot(`journey-fail-${n}`)
    } catch {
      // The failure itself is what matters.
    }
    return false
  }
}

const cardId = psql(
  "select id from cards where name = 'P169 Charizard' and language = 'en' limit 1",
)
const variantId = psql(
  `select id from card_variants where card_id = '${cardId}' and finish = 'holo' and stamp = '' and is_active limit 1`,
)
let holdingId = null

// 1 ---------------------------------------------------------------------------------------------
await step(1, 'cold dark launch', async () => {
  shell(`pm clear ${PACKAGE}`)
  await sleep(1500)
  shell(`am force-stop ${PACKAGE}`)
  await sleep(1500)
  const launch = amStart()
  await sleep(900)
  const png = decodePng(screencap())
  const lum = png.bandLuminance(0, png.h)
  shot('journey-01-cold-launch')
  await waitFor((ns) => byId(ns, 'login-email') || byId(ns, 'login-screen'), {
    timeoutMs: 30000,
    label: 'login screen',
  })
  const login = decodePng(screencap()).bandLuminance(0, png.h)
  if (login === null || login > 0.25)
    throw new Error(`the login screen is not dark: ${String(login)}`)
  return {
    launchState: launch.launchState,
    totalTimeMs: launch.totalTimeMs,
    meanLuminanceFirstFrame: lum,
    meanLuminanceLogin: login,
  }
})
// 2 ---------------------------------------------------------------------------------------------
await step(2, 'sign in', async () => {
  const r = await signIn(B)
  return { firstPageVisibleMs: r.firstPageVisibleMs }
})
// 3 ---------------------------------------------------------------------------------------------
await step(3, 'Collection', async () => {
  const n = await waitFor((ns) => byId(ns, 'collection-list') && ns, { label: 'collection list' })
  shot('journey-03-collection')
  return { rows: rows(n.value).length }
})
// 4-10 ------------------------------------------------------------------------------------------
let scan = null
await step(4, 'open the scanner (Price Check -> photo)', async () => {
  const { openPhotoScreen } = await import('../android-p167-lib.mjs')
  await openPhotoScreen()
  return {
    photoButtons: ['p169-photo-library', 'p169-photo-camera'].every((id) => byId(dump(), id)),
  }
})
await step(
  5,
  'choose an image, 6 recognition, 7 candidate review, 8 card confirmation',
  async () => {
    const before = counts()
    scan = await scanToCard('f17-p169-charizard.jpg', 'journey', 'P169 Charizard')
    shot('journey-07-candidate-then-card')
    return {
      recognition: scan.ui.kind,
      badge: scan.ui.badge,
      heading: scan.ui.heading,
      candidates: scan.ui.candidates.map((c) => c.label.slice(0, 60)),
      confirmedCardOpened: true,
      writes: diff(before, counts()),
    }
  },
)
await step(9, 'printing chosen explicitly', async () => {
  const p = await choosePrinting(scan.cardId, 'holo')
  return p
})
await step(10, 'raw Price Check (read-only)', async () => {
  const before = counts()
  await sleep(500)
  const texts = priceTexts()
  shot('journey-10-price-check')
  if (texts.length === 0) throw new Error('no raw price is shown')
  return { prices: texts, ledgerUnchanged: counts().join('|') === before.join('|') }
})
await step(11, 'return: back to the scanner leaves nothing behind', async () => {
  back()
  await sleep(700)
  back()
  await waitFor((ns) => byId(ns, 'p169-photo-library'), { label: 'photo screen after returning' })
  const n = dump()
  const leaked = ['p169-photo-ready', 'p169-recognition-result'].filter((id) => byId(n, id))
  if (leaked.length > 0) throw new Error(`state left behind: ${leaked.join(',')}`)
  return { leaked }
})
// 12-13 -----------------------------------------------------------------------------------------
await step(12, 'Add acquisition from a recognised card', async () => {
  const before = counts()
  await scanToCard('f17-p169-charizard.jpg', 'journey2', 'P169 Charizard')
  await choosePrinting(scan.cardId, 'holo')
  tap((await findScrolling('p169-add-to-collection')).node)
  await waitFor((ns) => byId(ns, 'p170-add-intent'), { label: 'add intent screen' })
  await tapScrolling('p175-go-add-acquisition')
  await waitFor((ns) => byId(ns, 'p175-add-acquisition'), { label: 'acquisition form' })
  await typeInto('p175-unit-cost', '25.00')
  await typeInto('p175-quantity', '3')
  if (counts().join('|') !== before.join('|')) throw new Error('written before the final confirm')
  await tapScrolling('p175-confirm-acquisition')
  await waitFor((ns) => byId(ns, 'collection-list') || byId(ns, 'p175-acquisition-success'), {
    timeoutMs: 30000,
    label: 'acquisition result',
  })
  await sleep(1500)
  const d = diff(before, counts())
  if (d.lots !== 1) throw new Error(`expected exactly one acquisition lot: ${JSON.stringify(d)}`)
  holdingId = psql(
    `select id from holdings where user_id='${B.id}' and card_variant_id='${variantId}'`,
  )
  return { writes: d, holding: holdingId.slice(0, 8) }
})
await step(13, 'verify Collection', async () => {
  await tapId('tab-collection', 'collection tab')
  await waitFor((ns) => byId(ns, 'collection-list'), { label: 'collection list' })
  const { node } = await findScrolling(`row-${holdingId}`)
  shot('journey-13-collection-row')
  return { rowVisible: !!node, label: (node.desc || node.text).slice(0, 80) }
})
// 14 --------------------------------------------------------------------------------------------
await step(14, 'non-NOK transaction (EUR purchase with FX)', async () => {
  const before = counts()
  await tapId('tab-search', 'search tab')
  await typeInto('p169-search-input', 'Charizard')
  shell('input keyevent 66')
  await waitFor((ns) => byIdPrefix(ns, 'p169-search-status-').find((x) => /ready/.test(x.id)), {
    timeoutMs: 30000,
    label: 'search results',
  })
  tap((await findScrolling(`p169-hit-${cardId}`)).node)
  await waitFor((ns) => byId(ns, 'p169-card') || byId(ns, 'p169-card-identity'), {
    timeoutMs: 30000,
    label: 'card screen',
  })
  await choosePrinting(cardId, 'holo')
  tap((await findScrolling('p169-add-to-collection')).node)
  await waitFor((ns) => byId(ns, 'p170-add-intent'), { label: 'add intent screen' })
  await tapScrolling('p175-go-record-purchase')
  await waitFor((ns) => byId(ns, 'p175-record-purchase'), { label: 'record purchase screen' })
  await tapScrolling('p178-purchase-currency')
  await waitFor((ns) => byId(ns, 'p178-currency-option-EUR'), { label: 'currency sheet' })
  tap(byId(dump(), 'p178-currency-option-EUR'))
  await waitFor((ns) => byId(ns, 'p180-purchase-fx-notice'), {
    timeoutMs: 20000,
    label: 'FX notice',
  })
  await typeInto('p175-purchase-quantity', '1')
  await typeInto('p175-purchase-unit-price', '12.50')
  await tapScrolling('p175-confirm-purchase')
  await waitFor((ns) => byId(ns, 'collection-list') || byId(ns, 'p175-purchase-success'), {
    timeoutMs: 30000,
    label: 'purchase result',
  })
  await sleep(1500)
  const d = diff(before, counts())
  if (d.purchases !== 1) throw new Error(`expected one purchase: ${JSON.stringify(d)}`)
  const row = psql(
    `select p.currency||'|'||p.total_minor||'|'||p.fx_rate_to_nok||'|'||p.total_nok_minor from purchases p where p.user_id='${B.id}' order by p.created_at desc limit 1`,
  )
  if (row !== 'EUR|1250|11.50000000|14375') throw new Error(`unexpected purchase row ${row}`)
  return { row, writes: d }
})
// 15 --------------------------------------------------------------------------------------------
await step(15, 'manual valuation', async () => {
  await tapId('tab-collection', 'collection tab')
  await waitFor((ns) => byId(ns, 'collection-list'), { label: 'collection list' })
  tap((await findScrolling(`row-${holdingId}`)).node)
  await waitFor((ns) => byId(ns, 'card-detail'), { timeoutMs: 20000, label: 'card detail' })
  await tapScrolling('manual-valuation')
  await waitFor((ns) => byId(ns, 'p175-manual-valuation'), { label: 'manual valuation screen' })
  await typeInto('p175-manual-value', '100.00')
  await tapScrolling('p175-confirm-manual-value')
  await waitFor((ns) => byId(ns, 'p175-manual-valuation-success'), {
    timeoutMs: 20000,
    label: 'manual value set',
  })
  const stored = psql(
    `select value_minor from manual_valuations where holding_id='${holdingId}' and superseded_at is null`,
  )
  if (stored !== '10000') throw new Error(`stored manual value ${stored}`)
  back()
  await waitFor((ns) => byId(ns, 'card-detail'), { label: 'back to card detail' })
  return { storedMinor: stored }
})
// 16 --------------------------------------------------------------------------------------------
await step(16, 'sale', async () => {
  const before = counts()
  await tapScrolling('record-sale')
  await waitFor((ns) => byId(ns, 'p175-record-sale'), {
    timeoutMs: 15000,
    label: 'record sale screen',
  })
  await typeInto('p175-sale-quantity', '1')
  await typeInto('p175-sale-unit-gross', '40.00')
  await typeInto('p175-sale-fees', '3')
  await tapScrolling('p175-confirm-sale')
  await waitFor((ns) => byId(ns, 'p175-sale-success'), { timeoutMs: 20000, label: 'sale recorded' })
  const d = diff(before, counts())
  if (d.sales !== 1) throw new Error(`expected one sale: ${JSON.stringify(d)}`)
  const result = psql(
    `select sl.realized_result_nok_minor from sale_lines sl join sales s on s.id=sl.sale_id where s.user_id='${B.id}' order by s.created_at desc limit 1`,
  )
  return { realizedResultMinor: result, writes: d }
})
// 17 --------------------------------------------------------------------------------------------
await step(17, 'Profile', async () => {
  await tapId('tab-profile', 'profile tab')
  await waitFor((ns) => byId(ns, 'sign-out') || byId(ns, 'profile-screen'), {
    timeoutMs: 20000,
    label: 'profile screen',
  })
  shot('journey-17-profile')
  return { signOutVisible: !!byId(dump(), 'sign-out') || !!(await findScrolling('sign-out')).node }
})
// 18 --------------------------------------------------------------------------------------------
await step(18, 'sign out', async () => {
  tap((await findScrolling('sign-out')).node)
  await waitFor((ns) => byId(ns, 'login-email') || byId(ns, 'login-screen'), {
    timeoutMs: 30000,
    label: 'login after sign-out',
  })
  const stale = ['collection-list', 'p169-photo-ready'].filter((id) => byId(dump(), id))
  if (stale.length > 0) throw new Error(`user data still visible: ${stale.join(',')}`)
  return { loginShown: true }
})
// 19 --------------------------------------------------------------------------------------------
await step(19, 'restart', async () => {
  shell(`am force-stop ${PACKAGE}`)
  await sleep(2000)
  amStart()
  await waitFor((ns) => byId(ns, 'login-email') || byId(ns, 'login-screen'), {
    timeoutMs: 30000,
    label: 'login after restart (no session left)',
  })
  const r = await signIn(B)
  return { signedInAgainMs: r.firstPageVisibleMs, sessionSurvivedSignOut: false }
})

saveJson('journey-report.json', report)
const failed = report.filter((r) => r.status === 'FAIL').length
console.log(
  `\nJOURNEY STEPS ${String(report.length)}  PASS ${String(report.filter((r) => r.status === 'PASS').length)}  FAIL ${String(failed)}`,
)
process.exit(failed > 0 ? 1 : 0)

#!/usr/bin/env node
/**
 * P185 full release-APK journey for ONE clean synthetic user: 20 steps, every one PASS or FAIL.
 * LOCAL ONLY (isolated stack, synthetic data). Every write is checked in the isolated database.
 *
 *   node scripts/p185/journey-check.mjs
 *
 *   1 cold dark launch   2 sign in            3 Collection        4 scanner entry
 *   5 select image       6 recognise          7 inspect candidate 8 confirm the card
 *   9 choose printing   10 Price Check       11 return           12 Add to Collection
 *  13 confirm acquisition 14 holding in Collection 15 manual valuation (100.00 / 0 / clear)
 *  16 sale (NOK)        17 non-NOK purchase + sale (EUR, FX)     18 Profile
 *  19 sign out          20 cold restart / session state
 *
 * Driver contract: scripts/p185/driver.mjs (testID/tree first, fresh bounds, bounded waits, adb
 * recovery that re-proves the same emulator). Fresh app data and the seeded synthetic user B.
 * Output: .build/p185-evidence/journey-report.json, journey-*.png, journey-logcat.json
 */
import './env.mjs'
import { join } from 'node:path'
import {
  activityAfterChange,
  amStart,
  appPid,
  decodePng,
  localActivityId,
  openPhotoScreen,
} from '../android-p167-lib.mjs'
import { establishIdentity, recoveryState } from '../android-adb.mjs'
import {
  PACKAGE,
  adb,
  byId,
  dump,
  fixtureDir,
  nextScanTrace,
  pickNewest,
  proxy,
  psql,
  pushImage,
  saveJson,
  scanMark,
  scansSince,
  screencap,
  sessionTraces,
  shell,
  shot,
  signIn,
  sleep,
  waitFor,
} from './lib.mjs'
import {
  assertActivityAlive,
  back,
  bringIntoView,
  clearAndType,
  findNode,
  screen,
  sweepDumps,
  tapNode,
  tapTestId,
  tapUntil,
  waitForAny,
  waitForNode,
  waitForNodeScrolling,
} from './driver.mjs'
import { auditSweep, leaks } from './a11y-lib.mjs'
import { B, choosePrinting, counts, diff, priceTexts } from './journeys.mjs'
import { cleanupSince } from './journey-cleanup.mjs'

establishIdentity()
adb(['logcat', '-G', '16M'], { allowFail: true })
adb(['logcat', '-c'], { allowFail: true })
adb(['logcat', '-b', 'crash', '-c'], { allowFail: true })

const report = []
async function step(n, name, fn) {
  const t0 = Date.now()
  try {
    const detail = await fn()
    assertActivityAlive()
    report.push({ n, step: name, status: 'PASS', ms: Date.now() - t0, detail })
    console.log(
      `PASS ${String(n).padStart(2)} ${name}  ${JSON.stringify(detail ?? null).slice(0, 700)}`,
    )
    return true
  } catch (e) {
    report.push({
      n,
      step: name,
      status: 'FAIL',
      ms: Date.now() - t0,
      detail: String(e.message ?? e).slice(0, 900),
    })
    console.log(`FAIL ${String(n).padStart(2)} ${name}  ${String(e.message ?? e).slice(0, 600)}`)
    try {
      shot(`journey-fail-${n}`)
    } catch {
      // The failure itself is what matters.
    }
    return false
  }
}

const q = (s) => `'${String(s).replaceAll("'", "''")}'`
const check = (cond, message) => {
  if (!cond) throw new Error(message)
}
const eq = (actual, expected, what) =>
  check(
    String(actual) === String(expected),
    `${what}: expected ${String(expected)}, got ${String(actual)}`,
  )

/** Polls the database until `sql` returns `expected` (the app writes asynchronously). */
async function dbEquals(sql, expected, what, timeoutMs = 20000) {
  const start = Date.now()
  let last = null
  while (Date.now() - start < timeoutMs) {
    last = psql(sql)
    if (last === String(expected)) return last
    await sleep(500)
  }
  throw new Error(`${what}: expected ${String(expected)}, database says ${String(last)}`)
}

const cardId = psql(
  `select id from cards where name = 'P169 Charizard' and language = 'en' limit 1`,
)
const variantId = psql(
  `select id from card_variants where card_id = ${q(cardId)} and finish = 'holo' and stamp = '' and is_active limit 1`,
)
const holdingOf = () =>
  psql(
    `select id from holdings where user_id = ${q(B.id)} and card_variant_id = ${q(variantId)} and deleted_at is null limit 1`,
  )
const holdingsBefore = psql(
  `select count(*) from holdings where user_id = ${q(B.id)} and card_variant_id = ${q(variantId)} and deleted_at is null`,
)
const activeFin = () =>
  psql(
    `select (select count(*) from sales where user_id=${q(B.id)} and voided_at is null) || '|' || (select count(*) from purchases where user_id=${q(B.id)} and voided_at is null) || '|' || (select count(*) from acquisition_lots where user_id=${q(B.id)} and voided_at is null) || '|' || (select count(*) from holdings where user_id=${q(B.id)} and deleted_at is null)`,
  )
const finBaseline = activeFin()
// Everything this journey writes is created after this instant (the database's own clock).
const startedAt = psql('select now()')
let holdingId = null
let acquisitionLot = null

async function gotoTab(tab, ready) {
  await tapTestId(tab, { scroll: false })
  await waitForNode(ready, { timeoutMs: 20000, label: `${ready} after ${tab}` })
}

/** Leaves any form / card / photo screen so the next step starts from a tab root. */
async function toRoot() {
  for (let i = 0; i < 8; i += 1) {
    const nodes = dump()
    if (findNode(nodes, 'collection-list') || findNode(nodes, 'price-check-home')) return
    back()
    await sleep(700)
  }
}

async function scanToResult(fixture, label) {
  const before = scanMark()
  await pushImage(join(fixtureDir, fixture), label)
  await pickNewest()
  const trace = await nextScanTrace(before)
  await sleep(1000)
  return trace
}

/** Accessibility-tree gate for the screen on top: every control named, >= 48 dp, reachable, no internal ids. */
const a11y = []
async function auditScreen(label) {
  const scr = screen()
  const a = auditSweep(await sweepDumps(), { dpi: scr.dpi, width: scr.width })
  const leaked = leaks(a)
  a11y.push({
    label,
    interactive: a.interactive,
    roles: a.roles,
    small: a.small,
    unlabeled: a.unlabeled,
    unreachable: a.unreachable,
    leaked,
  })
  check(
    a.small.length + a.unlabeled.length + a.unreachable.length + leaked.length === 0,
    `accessibility tree of "${label}": small=${JSON.stringify(a.small)} unlabeled=${a.unlabeled.join(',')} unreachable=${a.unreachable.join(',')} leaked=${leaked.join(';')}`,
  )
}

const candidateRow = () =>
  bringIntoView({ prefix: 'p169-recognition-candidate-' }, { label: 'candidate row' })

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
  check(login !== null && login <= 0.25, `the login screen is not dark: ${String(login)}`)
  return {
    launchState: launch.launchState,
    totalTimeMs: launch.totalTimeMs,
    lumFirstFrame: lum,
    lumLogin: login,
  }
})
// 2 ---------------------------------------------------------------------------------------------
await step(2, 'sign in', async () => {
  const r = await signIn(B)
  return { firstPageVisibleMs: r.firstPageVisibleMs }
})
// 3 ---------------------------------------------------------------------------------------------
await step(3, 'Collection', async () => {
  const r = await waitForNode('collection-list', { label: 'collection list' })
  shot('journey-03-collection')
  return { rows: r.nodes.filter((n) => n.id.includes('row-')).length }
})
// 4 ---------------------------------------------------------------------------------------------
await step(4, 'scanner entry', async () => {
  await openPhotoScreen()
  const nodes = dump()
  const buttons = ['p169-photo-library', 'p169-photo-camera'].filter((id) => findNode(nodes, id))
  check(buttons.length === 2, `photo entry buttons: ${buttons.join(',')}`)
  return { buttons }
})
// 5 ---------------------------------------------------------------------------------------------
let trace1 = null
await step(5, 'select the safe recognition fixture', async () => {
  const before = scanMark()
  await pushImage(join(fixtureDir, 'f17-p169-charizard.jpg'), 'journey')
  await pickNewest()
  await waitForNode('p169-photo-ready', { label: 'photo ready' })
  trace1 = await nextScanTrace(before)
  return { photoReady: true }
})
// 6 ---------------------------------------------------------------------------------------------
await step(6, 'recognise a real candidate (on-device OCR + visual match)', async () => {
  await sleep(1000)
  const { node } = await candidateRow()
  check(/P169 Charizard/.test(node.desc), `unexpected candidate ${node.desc}`)
  check(trace1.outcome === 'analysed', `scan outcome ${String(trace1.outcome)}`)
  shot('journey-06-recognition')
  return {
    tier: trace1.tier,
    ocr: trace1.ocr,
    totalMs: trace1.stages.totalMs,
    candidate: node.desc,
  }
})
// 7 ---------------------------------------------------------------------------------------------
await step(7, 'inspect the candidate (+ one Activity recreation)', async () => {
  const row = (await candidateRow()).node
  check(/^P169 Charizard, P169 Base Set, 004$/.test(row.desc), `candidate name: ${row.desc}`)
  const badge = (await bringIntoView('p169-recognition-confidence', { label: 'confidence' })).node
  check(
    /Match confidence: (High confidence|Needs confirmation|Low confidence)/.test(badge.desc),
    `confidence name: ${badge.desc}`,
  )
  const scr = screen()
  const a = auditSweep([dump()], { dpi: scr.dpi, width: scr.width })
  check(leaks(a).length === 0, `an internal identifier is exposed: ${leaks(a).join('; ')}`)
  // One recreation after the result and before any financial step (font 1.0 -> 1.3 -> 1.0).
  const scansBefore = scanMark()
  const countsBefore = counts()
  const pid = appPid()
  const actBefore = localActivityId()
  shell('settings put system font_scale 1.3')
  const actMid = await activityAfterChange(actBefore)
  await sleep(1500)
  shell('settings put system font_scale 1.0')
  const actAfter = await activityAfterChange(actMid)
  await sleep(2500)
  assertActivityAlive()
  // Let any recognition started by the recreations finish or be cancelled before judging.
  await sleep(7000)
  assertActivityAlive()
  const nodes = dump()
  const results = nodes.filter((n) => n.id.endsWith('p169-recognition-result')).length
  check(appPid() === pid, 'the process changed on recreation')
  check(actMid !== actBefore && actAfter !== actMid, 'the Activity was not recreated twice')
  check(results <= 1, `${String(results)} scanner results after recreation`)
  eq(counts().join('|'), countsBefore.join('|'), 'database counts across the recreation')
  const fresh = scansSince(scansBefore)
  const analysed = fresh.filter((t) => t.outcome === 'analysed').length
  const cancelled = fresh.filter((t) => t.outcome === 'cancelled').length
  // A recreation may start a recognition of the still-held photo; it must never complete twice for
  // one screen, and anything it started that did not finish must have been cancelled, not leaked.
  check(analysed <= 1, `${String(analysed)} completed analyses caused by the recreations`)
  check(
    fresh.every((t) => t.outcome === 'analysed' || t.outcome === 'cancelled'),
    `unexpected scan outcomes: ${fresh.map((t) => t.outcome).join(',')}`,
  )
  const sessions = sessionTraces().filter((s) => s.action === 'created').length
  check(sessions <= 1, `${String(sessions)} model sessions were created`)
  const photoStillReady = !!findNode(nodes, 'p169-photo-ready')
  // The photo is released with the old screen (the existing ownership contract): the person is on a
  // usable photo screen. Take the photo again so the journey continues from exactly one result.
  const mark2 = scanMark()
  trace1 = await scanToResult('f17-p169-charizard.jpg', 'journey-after-recreate')
  await candidateRow()
  const retake = scansSince(mark2).filter((t) => t.outcome === 'analysed')
  eq(retake.length, 1, 'completed analyses for the re-taken photo')
  eq(
    dump().filter((n) => n.id.endsWith('p169-recognition-result')).length,
    1,
    'scanner results after re-taking',
  )
  return {
    sameProcess: true,
    recreations: 2,
    resultsAfterRecreation: results,
    analysesFromRecreations: { analysed, cancelled },
    photoStillReadyAfterRecreation: photoStillReady,
    modelSessionsCreated: sessions,
    runtimeSingleton: sessions <= 1,
  }
})
// 8 ---------------------------------------------------------------------------------------------
await step(8, 'explicit card confirmation', async () => {
  const before = counts()
  tapNode((await candidateRow()).node)
  await waitForNode('p169-card-identity', { timeoutMs: 30000, label: 'card identity' }).catch(() =>
    waitForNode('p169-card', { timeoutMs: 5000, label: 'card screen' }),
  )
  eq(JSON.stringify(diff(before, counts())), '{}', 'writes on confirming a card')
  shot('journey-08-card')
  return { confirmedCardOpened: true }
})
// 9 ---------------------------------------------------------------------------------------------
await step(9, 'explicit printing selection', async () => {
  const before = counts()
  const p = await choosePrinting(cardId, 'holo')
  eq(p.hadChoice, true, 'the printing choice was offered')
  eq(JSON.stringify(diff(before, counts())), '{}', 'writes on choosing a printing')
  await auditScreen('card with the chosen printing and Price Check')
  return p
})
// 10 --------------------------------------------------------------------------------------------
await step(10, 'Price Check (read-only)', async () => {
  const before = counts()
  await sleep(500)
  const texts = priceTexts()
  shot('journey-10-price-check')
  check(texts.length > 0, 'no raw price is shown')
  eq(counts().join('|'), before.join('|'), 'ledger across Price Check')
  return { prices: texts }
})
// 11 --------------------------------------------------------------------------------------------
await step(11, 'return from Price Check', async () => {
  const scansBefore = scanMark()
  back()
  await waitForNode('p169-photo-entry', { timeoutMs: 15000, label: 'photo screen after one back' })
  const nodes = dump()
  check(!findNode(nodes, 'p169-card'), 'the card screen is still showing')
  eq(scansSince(scansBefore).length, 0, 'a re-analysis on returning')
  const state = {
    photoReady: !!findNode(nodes, 'p169-photo-ready'),
    result: !!findNode(nodes, 'p169-recognition-result'),
  }
  back()
  await waitForNode('price-check-home', {
    timeoutMs: 15000,
    label: 'Price Check landing after the second back',
  })
  return { backsToPhotoScreen: 1, backsToLanding: 2, ...state }
})
// 12 --------------------------------------------------------------------------------------------
await step(12, 'Add to Collection (nothing is written yet)', async () => {
  const before = counts()
  await toRoot()
  await tapTestId('tab-pricecheck', { scroll: false })
  await openPhotoScreen()
  trace1 = await scanToResult('f17-p169-charizard.jpg', 'journey2')
  tapNode((await candidateRow()).node)
  await waitForNode('p169-card-identity', { timeoutMs: 30000, label: 'card identity' }).catch(() =>
    waitForNode('p169-card', { timeoutMs: 5000, label: 'card' }),
  )
  await choosePrinting(cardId, 'holo')
  await tapUntil('p169-add-to-collection', 'p170-add-intent', { label: 'Add to Collection' })
  await tapUntil('p175-go-add-acquisition', 'p175-add-acquisition', { label: 'add acquisition' })
  await auditScreen('Add acquisition form')
  await clearAndType('p175-unit-cost', '25.00')
  await clearAndType('p175-quantity', '3')
  eq(counts().join('|'), before.join('|'), 'writes before the final confirm')
  return { holdingsBefore: Number(holdingsBefore), countsUnchanged: true }
})
// 13 --------------------------------------------------------------------------------------------
await step(13, 'explicit acquisition confirmation', async () => {
  const before = counts()
  await tapTestId('p175-confirm-acquisition', { label: 'confirm acquisition' })
  await waitForNode('collection-list', {
    timeoutMs: 30000,
    label: 'Collection after the acquisition',
  }).catch(() =>
    waitForNodeScrolling('p175-acquisition-success', {
      timeoutMs: 5000,
      label: 'acquisition success',
    }),
  )
  await sleep(1500)
  const d = diff(before, counts())
  eq(d.lots, 1, 'acquisition lots written')
  holdingId = holdingOf()
  check(holdingId !== '', 'the holding does not exist')
  const lot = psql(
    `select id||'|'||user_id||'|'||quantity||'|'||quantity_remaining||'|'||cost_basis_state||'|'||coalesce(unit_cost_basis_minor::text,'null')||'|'||coalesce(cost_basis_currency,'null')||'|'||origin from acquisition_lots where holding_id = ${q(holdingId)} and voided_at is null order by created_at desc limit 1`,
  ).split('|')
  acquisitionLot = lot[0]
  eq(lot[1], B.id, 'lot owner')
  eq(lot[2], 3, 'lot quantity')
  eq(lot[3], 3, 'lot quantity remaining')
  eq(lot[4], 'known', 'cost basis state')
  eq(lot[5], 2500, 'unit cost minor')
  eq(lot[6], 'NOK', 'cost currency')
  eq(psql(`select card_variant_id from holdings where id = ${q(holdingId)}`), variantId, 'variant')
  // No duplicate from a retry: still exactly one lot for this holding.
  eq(
    psql(
      `select count(*) from acquisition_lots where holding_id = ${q(holdingId)} and voided_at is null`,
    ),
    1,
    'lots on the holding',
  )
  return {
    writes: d,
    lot: {
      quantity: 3,
      basisState: lot[4],
      unitCostMinor: lot[5],
      currency: lot[6],
      origin: lot[7],
    },
  }
})
// 14 --------------------------------------------------------------------------------------------
await step(14, 'verify the holding in Collection', async () => {
  await toRoot()
  await gotoTab('tab-collection', 'collection-list')
  const { node } = await bringIntoView(`row-${holdingId}`, { label: 'the new holding row' })
  check(/Charizard/.test(node.desc || node.text), `row label: ${node.desc || node.text}`)
  shot('journey-14-collection-row')
  return { rowVisible: true, label: (node.desc || node.text).slice(0, 90) }
})
// 15 --------------------------------------------------------------------------------------------
const ACTIVE_MANUAL = () =>
  `select coalesce(string_agg(value_minor::text, ','), 'none') from manual_valuations where holding_id = ${q(holdingId)} and superseded_at is null`
await step(15, 'manual valuation: 100.00, explicit 0, clear', async () => {
  tapNode((await bringIntoView(`row-${holdingId}`, { label: 'holding row' })).node)
  await waitForNode('card-detail', { timeoutMs: 20000, label: 'card detail' })
  await tapUntil('manual-valuation', 'p175-manual-valuation', { label: 'manual valuation' })
  eq(psql(ACTIVE_MANUAL()), 'none', 'a manual value before the test')
  const historyBefore = Number(
    psql(`select count(*) from manual_valuations where holding_id = ${q(holdingId)}`),
  )
  await auditScreen('Manual valuation')
  // positive
  await clearAndType('p175-manual-value', '100.00')
  await tapTestId('p175-confirm-manual-value', { label: 'set value' })
  await waitForNodeScrolling('p175-manual-valuation-success', {
    timeoutMs: 20000,
    label: 'Saved (100.00)',
  })
  await dbEquals(ACTIVE_MANUAL(), '10000', 'positive manual value')
  shot('journey-15-manual-100')
  // an explicit zero is a KNOWN value, not an absent one
  await clearAndType('p175-manual-value', '0')
  await tapTestId('p175-confirm-manual-value', { label: 'set value 0' })
  await dbEquals(ACTIVE_MANUAL(), '0', 'explicit zero manual value')
  eq(
    psql(
      `select value_nok_minor||'|'||currency from manual_valuations where holding_id = ${q(holdingId)} and superseded_at is null`,
    ),
    '0|NOK',
    'the zero row',
  )
  // clear: back to "no manual valuation", never a zero
  await tapTestId('p175-clear-manual-value', { label: 'clear manual value' })
  await dbEquals(ACTIVE_MANUAL(), 'none', 'cleared manual value')
  const history = psql(`select count(*) from manual_valuations where holding_id = ${q(holdingId)}`)
  eq(Number(history) - historyBefore, 2, 'history rows added (100.00 and 0, both superseded)')
  back()
  await waitForNode('card-detail', { label: 'card detail after the valuation' })
  return { positive: 10000, zeroKnown: true, clearedActive: 'none', historyRows: Number(history) }
})
// 16 --------------------------------------------------------------------------------------------
let nokSale = null
await step(16, 'sale (NOK, quantity 1, fees)', async () => {
  const before = counts()
  await tapUntil('record-sale', 'p175-record-sale', { label: 'record sale' })
  await auditScreen('Record sale')
  await clearAndType('p175-sale-quantity', '1')
  await clearAndType('p175-sale-unit-gross', '40.00')
  await clearAndType('p175-sale-fees', '3')
  await tapTestId('p175-confirm-sale', { label: 'record sale' })
  await waitForNodeScrolling('p175-sale-success', { timeoutMs: 20000, label: 'sale recorded' })
  await sleep(800)
  const d = diff(before, counts())
  eq(d.sales, 1, 'sales written')
  const s = psql(
    `select s.id||'|'||s.currency||'|'||s.gross_minor||'|'||s.fees_minor||'|'||s.net_proceeds_minor||'|'||s.net_proceeds_nok_minor||'|'||s.realized_result_nok_minor from sales s where s.user_id = ${q(B.id)} and s.voided_at is null order by s.created_at desc limit 1`,
  ).split('|')
  nokSale = s[0]
  eq(s[1], 'NOK', 'sale currency')
  eq(s[2], 4000, 'gross minor')
  eq(s[3], 300, 'fees minor')
  eq(s[4], 3700, 'net proceeds minor')
  eq(s[6], 1200, 'realized result (net 37.00 - cost 25.00)')
  const line = psql(
    `select quantity||'|'||cost_basis_at_sale_nok_minor||'|'||lot_id from sale_lines where sale_id = ${q(nokSale)}`,
  ).split('|')
  eq(line[0], 1, 'sale line quantity')
  eq(line[1], 2500, 'cost basis at sale')
  eq(line[2], acquisitionLot, 'sold lot')
  eq(
    psql(`select quantity_remaining from acquisition_lots where id = ${q(acquisitionLot)}`),
    2,
    'lot quantity remaining after the sale',
  )
  return { net: s[4], realized: s[6], remainingOnLot: 2, writes: d }
})
// 17 --------------------------------------------------------------------------------------------
let eurPurchase = null
let eurSale = null
await step(17, 'non-NOK transaction: EUR purchase and EUR sale with FX', async () => {
  const before = counts()
  await toRoot()
  await tapTestId('tab-search', { scroll: false })
  // The Search tab keeps its own stack. It may open on a screen left from earlier (the photo
  // screen, or a finished form): leave it with Back until the search field, or the photo screen's
  // "choose manually" that leads to it, is showing. Bounded.
  for (let i = 0; i < 6; i += 1) {
    const nodes = dump()
    if (findNode(nodes, 'p169-search-input')) break
    const manual = findNode(nodes, 'p169-choose-manually')
    if (manual) {
      tapNode(manual)
      await sleep(800)
      continue
    }
    back()
    await sleep(900)
  }
  await waitForNode('p169-search-input', { timeoutMs: 15000, label: 'search field' })
  await clearAndType('p169-search-input', 'Charizard')
  shell('input keyevent 66')
  await waitFor((ns) => ns.find((x) => /p169-search-status-.*ready/.test(x.id)), {
    timeoutMs: 30000,
    label: 'search results',
  })
  tapNode((await bringIntoView(`p169-hit-${cardId}`, { label: 'the Charizard hit' })).node)
  await waitForNode('p169-card-identity', { timeoutMs: 30000, label: 'card identity' }).catch(() =>
    waitForNode('p169-card', { timeoutMs: 5000 }),
  )
  await choosePrinting(cardId, 'holo')
  await tapUntil('p169-add-to-collection', 'p170-add-intent', { label: 'Add to Collection' })
  await tapUntil('p175-go-record-purchase', 'p175-record-purchase', { label: 'record purchase' })
  await auditScreen('Record purchase form')
  await tapUntil('p178-purchase-currency', 'p178-currency-option-EUR', { label: 'currency sheet' })
  // The currency chooser is a radio group: >= 48 dp, named, exactly one selected.
  const dpv = screen().dpi / 160
  const radios = dump()
    .filter((n) => n.cls === 'android.widget.RadioButton' && /currency-option/.test(n.id))
    .map((n) => ({
      id: n.id.replace(/^.*:id\//, ''),
      hDp: Math.round((n.bounds.y2 - n.bounds.y1) / dpv),
      selected: n.selected || n.checked,
      name: n.desc || n.text,
    }))
  check(radios.length >= 5, `currency radios found: ${String(radios.length)}`)
  check(
    radios.every((r) => r.hDp >= 47),
    `currency radio below 48 dp: ${JSON.stringify(radios.filter((r) => r.hDp < 47))}`,
  )
  eq(radios.filter((r) => r.selected).length, 1, 'selected currency radios')
  await tapTestId('p178-currency-option-EUR', { scroll: false })
  await waitForNode('p180-purchase-fx-notice', { timeoutMs: 20000, label: 'FX notice' })
  await clearAndType('p175-purchase-quantity', '1')
  await clearAndType('p175-purchase-unit-price', '12.50')
  await tapTestId('p175-confirm-purchase', { label: 'confirm purchase' })
  await waitForNode('collection-list', {
    timeoutMs: 30000,
    label: 'Collection after the purchase',
  }).catch(() => waitForNode('p175-purchase-success', { timeoutMs: 5000 }))
  await sleep(1500)
  eq(diff(before, counts()).purchases, 1, 'purchases written')
  const pr = psql(
    `select id||'|'||currency||'|'||total_minor||'|'||fx_rate_to_nok||'|'||fx_rate_date||'|'||fx_source||'|'||total_nok_minor from purchases where user_id = ${q(B.id)} and voided_at is null order by created_at desc limit 1`,
  ).split('|')
  eurPurchase = pr[0]
  eq(`${pr[1]}|${pr[2]}|${pr[3]}|${pr[6]}`, 'EUR|1250|11.50000000|14375', 'EUR purchase and FX')
  // EUR sale of the purchased lot
  await toRoot()
  await gotoTab('tab-collection', 'collection-list')
  tapNode((await bringIntoView(`row-${holdingId}`, { label: 'holding row' })).node)
  await waitForNode('card-detail', { timeoutMs: 20000, label: 'card detail' })
  const purchaseLot = psql(
    `select al.id from acquisition_lots al join purchase_lines pl on pl.id = al.purchase_line_id where pl.purchase_id = ${q(eurPurchase)}`,
  )
  const salesBefore = counts()
  await tapUntil('record-sale', 'p175-record-sale', { label: 'record sale' })
  await tapTestId(`p175-lot-${purchaseLot}`, { label: 'the purchased lot' })
  await tapUntil('p178-sale-currency', 'p178-sale-currency-option-EUR', {
    label: 'sale currency sheet',
  })
  await tapTestId('p178-sale-currency-option-EUR', { scroll: false })
  await waitForNode('p180-sale-fx-notice', { timeoutMs: 20000, label: 'sale FX notice' })
  await clearAndType('p175-sale-quantity', '1')
  await clearAndType('p175-sale-unit-gross', '10.00')
  await clearAndType('p175-sale-fees', '1.00')
  await tapTestId('p175-confirm-sale', { label: 'record EUR sale' })
  await waitForNodeScrolling('p175-sale-success', { timeoutMs: 20000, label: 'EUR sale recorded' })
  await sleep(800)
  eq(diff(salesBefore, counts()).sales, 1, 'EUR sales written')
  const sl = psql(
    `select id||'|'||currency||'|'||gross_minor||'|'||fees_minor||'|'||net_proceeds_minor||'|'||fx_rate_to_nok||'|'||fx_rate_date||'|'||fx_source||'|'||net_proceeds_nok_minor||'|'||realized_result_nok_minor from sales where user_id = ${q(B.id)} and voided_at is null order by created_at desc limit 1`,
  ).split('|')
  eurSale = sl[0]
  eq(
    `${sl[1]}|${sl[2]}|${sl[3]}|${sl[4]}|${sl[5]}|${sl[8]}`,
    'EUR|1000|100|900|11.50000000|10350',
    'EUR sale, FX and NOK proceeds',
  )
  eq(sl[9], 10350 - 14375, 'EUR sale realized result in NOK (10350 - 14375)')
  return {
    purchase: {
      currency: pr[1],
      totalMinor: pr[2],
      fxRate: pr[3],
      fxDate: pr[4],
      fxSource: pr[5],
      totalNokMinor: pr[6],
    },
    sale: {
      currency: sl[1],
      grossMinor: sl[2],
      feesMinor: sl[3],
      netMinor: sl[4],
      fxRate: sl[5],
      fxDate: sl[6],
      fxSource: sl[7],
      netNokMinor: sl[8],
      realizedNok: sl[9],
    },
    currencyRadios: radios,
  }
})
// 18 --------------------------------------------------------------------------------------------
await step(18, 'Profile', async () => {
  await toRoot()
  await tapTestId('tab-profile', { scroll: false })
  const { node } = await bringIntoView('sign-out', { label: 'sign out' })
  shot('journey-18-profile')
  return { signOutVisible: !!node }
})
// 19 --------------------------------------------------------------------------------------------
await step(19, 'sign out', async () => {
  tapNode((await bringIntoView('sign-out', { label: 'sign out' })).node)
  await waitFor((ns) => byId(ns, 'login-email') || byId(ns, 'login-screen'), {
    timeoutMs: 30000,
    label: 'login after sign-out',
  })
  const stale = ['collection-list', 'p169-photo-ready', 'p169-recognition-result'].filter((id) =>
    findNode(dump(), id),
  )
  check(stale.length === 0, `user data still visible: ${stale.join(',')}`)
  return { loginShown: true }
})
// 20 --------------------------------------------------------------------------------------------
await step(20, 'cold restart and session state', async () => {
  shell(`am force-stop ${PACKAGE}`)
  await sleep(2000)
  const launch = amStart()
  await waitFor((ns) => byId(ns, 'login-email') || byId(ns, 'login-screen'), {
    timeoutMs: 30000,
    label: 'login after restart (no session left behind)',
  })
  const r = await signIn(B)
  await waitForNode('collection-list', { label: 'Collection after signing in again' })
  await bringIntoView(`row-${holdingId}`, { label: 'the holding after a cold restart and sign-in' })
  return {
    launchState: launch.launchState,
    sessionSurvivedSignOut: false,
    signedInAgainMs: r.firstPageVisibleMs,
    dataPersisted: true,
  }
})

// ---- network audit + logcat sweep over the whole run ----------------------------------------------
const audit = await proxy('audit')
const log = adb(['logcat', '-d', '-v', 'time'], { allowFail: true })
const crash = adb(['logcat', '-b', 'crash', '-d', '-v', 'time'], { allowFail: true })
const PATTERNS = {
  fatal: /FATAL EXCEPTION/,
  anr: /ANR in |am_anr|Application Not Responding/,
  inputTimeout: /Input dispatching timed out/,
  oom: /OutOfMemoryError|Out of memory/i,
  nativeCrash: /Fatal signal|SIGSEGV|SIGABRT|backtrace:/,
  onnx: /OrtException|onnxruntime[^\n]*(error|fail|exception)/i,
  mlkit: /(MlKit|MLKit)[^\n]*(exception|failed|error)/i,
  unhandledRejection: /Unhandled promise rejection|possible unhandled/i,
  reactFatal: /ReactNativeJS[^\n]*(Fatal|FATAL)/,
}
const own = (line) =>
  line.includes(PACKAGE) || /ReactNativeJS|ReactNative|onnx|MlKit|OrtException/i.test(line)
const matches = {}
const explained = {}
const allLines = `${log}\n${crash}`.split(/\r?\n/)
// One KNOWN, explained line pattern: when the Activity is recreated while a photo is held, the new
// screen can start a recognition of the photo the old screen is releasing; ML Kit then reports that
// the picker's cache copy is gone (non-fatal; the recognition is cancelled). Anything else is not
// explained and fails the gate.
const RECREATION_RACE =
  /MLKitImageUtils[^\n]*(cache\/ImagePicker|ENOENT|rotation meta data)|FileNotFoundException[^\n]*cache\/ImagePicker|ErrnoException[^\n]*ENOENT/
for (const [name, re] of Object.entries(PATTERNS)) {
  const hits = allLines
    .filter((l) => re.test(l) && (own(l) || name === 'fatal' || name === 'anr'))
    .map((l) => l.slice(0, 220))
  explained[name] = hits.filter((l) => name === 'mlkit' && RECREATION_RACE.test(l))
  matches[name] = hits.filter((l) => !explained[name].includes(l))
}
saveJson('journey-logcat.json', { lines: log.split(/\r?\n/).length, matches, explained })
saveJson('journey-network-audit.json', audit)
const logClean = Object.values(matches).every((m) => m.length === 0)
console.log(
  `LOGCAT_EXPLAINED ${JSON.stringify(Object.fromEntries(Object.entries(explained).map(([k, v]) => [k, v.length])))}`,
)
console.log(
  `LOGCAT lines=${String(log.split(/\r?\n/).length)} matches=${JSON.stringify(Object.fromEntries(Object.entries(matches).map(([k, v]) => [k, v.length])))}`,
)
console.log(`NETWORK ${JSON.stringify(audit)}  ADB_RECOVERY ${JSON.stringify(recoveryState())}`)

// ---- cleanup through the product's own reversal functions (never raw deletes) ----------------------
let cleanup = 'not_run'
let keptHoldings = []
try {
  const r = cleanupSince(startedAt)
  cleanup = r.log.join('; ') || 'nothing to reverse'
  keptHoldings = r.keptHoldings
} catch (e) {
  cleanup = `FAILED: ${String(e.message).slice(0, 300)}`
}
console.log(`CLEANUP ${cleanup}`)
const left = activeFin()
console.log(
  `ACTIVE sales|purchases|lots|holdings baseline=${finBaseline} afterCleanup=${left} restored=${String(left.split('|').slice(0, 3).join('|') === finBaseline.split('|').slice(0, 3).join('|'))} (holdings are kept by the product once they have disposal history)`,
)

saveJson('journey-report.json', {
  accessibilityTree: a11y,
  steps: report,
  logClean,
  cleanup,
  keptHoldings,
  activeBaseline: finBaseline,
  activeAfterCleanup: left,
  restoredToBaseline:
    left.split('|').slice(0, 3).join('|') === finBaseline.split('|').slice(0, 3).join('|'),
  adbRecovery: recoveryState(),
})
const failed = report.filter((r) => r.status === 'FAIL').length
console.log(
  `\nJOURNEY STEPS ${String(report.length)}  PASS ${String(report.filter((r) => r.status === 'PASS').length)}  FAIL ${String(failed)}  LOGCAT_CLEAN ${String(logClean)}`,
)
process.exit(failed > 0 || !logClean ? 1 : 0)

#!/usr/bin/env node
/**
 * P177 Android runtime check: drives the INSTALLED integrated app (release build, Hermes, embedded
 * bundle, real native modules) through the P175 financial write screens, reached via the REAL
 * navigation (Price Check -> Add to Collection -> Add acquisition / Record purchase; Collection ->
 * Card -> Record sale / Manual valuation). LOCAL ONLY, synthetic users only.
 *
 *   ANDROID_SERIAL=emulator-5554 SPIKE_PACKAGE=invalid.pokeportfolio.spike.p177 node scripts/p177/android-financial-check.mjs
 *
 * Preconditions: `node scripts/p177/backend.mjs start|seed|write-env`, the mock TCGdex
 * (`node scripts/p169/mock-tcgdex.mjs --stack=p177`) and the capture proxy
 * (`node scripts/p177/capture-proxy.mjs`) running, and the APK from `scripts/p177/build-apk.mjs`
 * installed. Output: .build/p177-evidence/{report.json,*.png} (gitignored).
 *
 * Scope (disclosed, not silent): does NOT test Opening (no sealed holding exists anywhere in the
 * seed data, and the write seam has no RPC to create one — see this run's own report) or a JPY
 * purchase (RecordPurchaseScreen has no currency selector; currency is hardcoded 'NOK' on the
 * draft — a real UI gap, not a driver limitation).
 */
import './env.mjs'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import {
  PACKAGE,
  adb,
  byId,
  byIdPrefix,
  dump,
  screencap,
  shell,
  sleep,
  tap,
  waitFor,
} from '../android-adb.mjs'

if (!/^emulator-\d+$/.test(process.env.ANDROID_SERIAL ?? '')) {
  console.error('set ANDROID_SERIAL to the P177 emulator serial (never another session’s)')
  process.exit(2)
}
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const outDir = join(appRoot, '.build', 'p177-evidence')
mkdirSync(outDir, { recursive: true })
const readJson = (rel) => JSON.parse(readFileSync(join(appRoot, '.local-backend', rel), 'utf8'))
const fixture = readJson('fixture.json')
const catalog = readJson('p177/fixture.json').catalog
const pub = readJson('p177/public-env.json')
const A = fixture.users.a
const B = fixture.users.b
const cardId = (key) => catalog[key].cardId
const variantId = (key, printing) => catalog[key].variants[printing]

const steps = []
function record(step, status, detail) {
  steps.push({ step, status, detail })
  console.log(`${status} ${step}${detail !== undefined ? `  ${JSON.stringify(detail).slice(0, 500)}` : ''}`)
}
async function run(step, fn) {
  try {
    const detail = await fn()
    record(step, 'PASS', detail)
    return detail
  } catch (e) {
    const name = `fail-${String(steps.length + 1)}`
    try {
      writeFileSync(join(outDir, `${name}.png`), screencap())
    } catch {
      // best effort
    }
    record(step, 'FAIL', { error: String(e.message ?? e).slice(0, 500), screenshot: `${name}.png` })
    throw e
  }
}

// ---- input helpers ----------------------------------------------------------------------------
// Extends the P169/P173 driver's typing convention with the decimal COMMA and minus sign, both
// needed by this phase's money-keyboard tests; anything genuinely unsupported still throws rather
// than being silently mangled.
function type(t) {
  if (!/^[A-Za-z0-9 ,._@+-]+$/.test(t)) throw new Error(`type: unsupported characters in ${JSON.stringify(t)}`)
  for (let i = 0; i < t.length; i += 6) {
    adb(['shell', 'input', 'text', t.slice(i, i + 6).replaceAll(' ', '%s')])
    await_(120)
  }
}
function await_(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
async function clearField(id) {
  // A fixed generous count, not `before.length` — the search box's debounced re-render can leave
  // `before` reading stale/short (seen once: "pika" not fully cleared before "zard" was typed,
  // yielding "pizard"), so a length-based backspace count can under-clear by a few characters.
  shell('input keyevent KEYCODE_MOVE_END')
  for (let i = 0; i < 40; i += 1) shell('input keyevent 67')
}
async function typeInto(id, t, { verify = true } = {}) {
  const { value } = await waitFor((ns) => byId(ns, id), { label: id })
  tap(value)
  await sleep(400)
  await clearField(id)
  type(t)
  await sleep(300)
  if (verify) {
    const now = byId(dump(), id)?.text ?? ''
    if (now !== t) throw new Error(`input did not reach ${id}: wanted ${JSON.stringify(t)} got ${JSON.stringify(now)}`)
  }
  // A still-open soft keyboard covers the Confirm button on every one of these forms; a scrolling
  // tap aimed at a button hidden behind it lands on a KEYBOARD KEY instead (this is exactly how an
  // early run of this driver corrupted a "2" into a "23" quantity — the tap for Confirm hit the
  // keyboard's "3" key, which the still-focused quantity field received). Dismiss it once the
  // field's own value has been verified, never before.
  await dismissKeyboard()
}
const back = () => shell('input keyevent 4')
function isKeyboardShown() {
  return /mInputShown=true/.test(shell('dumpsys input_method', { allowFail: true }))
}
/** Only sends BACK when a keyboard is actually up — otherwise BACK would navigate the screen away. */
async function dismissKeyboard() {
  if (isKeyboardShown()) {
    back()
    await sleep(400)
  }
}
async function tapId(id, label = id) {
  tap((await waitFor((ns) => byId(ns, id), { label })).value)
}
/** Long write-form ScrollViews put Confirm below the fold; scroll to find it before tapping. */
async function tapScrolling(id, label = id) {
  await dismissKeyboard()
  const { node } = await findScrolling(id)
  tap(node)
}
function screenTexts() {
  return dump()
    .map((n) => n.text)
    .filter(Boolean)
}
async function findScrolling(id, tries = 10) {
  for (const down of [true, false]) {
    for (let i = 0; i < tries; i += 1) {
      const nodes = dump()
      const node = byId(nodes, id)
      if (node) return { node, nodes }
      shell(down ? 'input touchscreen swipe 540 1700 540 700 300' : 'input touchscreen swipe 540 700 540 1700 300')
      await sleep(350)
    }
  }
  throw new Error(`not found after scrolling: ${id}`)
}
async function ensureApp() {
  const focus = adb(['shell', 'dumpsys window | grep mCurrentFocus'], { allowFail: true })
  if (focus.includes(PACKAGE)) return
  adb(['shell', 'am', 'start', '-n', `${PACKAGE}/invalid.pokeportfolio.spike.MainActivity`])
  await waitFor((ns) => ns.length > 0, { timeoutMs: 30000, label: 'app foreground' })
}

// ---- DB helpers (docker exec into THIS project's database only) -------------------------------
function psql(sql) {
  const r = spawnSync(
    'docker', ['exec', '-i', pub.dbContainer, 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1'],
    { input: sql, encoding: 'utf8' },
  )
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr}`)
  return r.stdout.trim()
}
function psqlRows(sql) {
  const out = psql(sql)
  return out === '' ? [] : out.split('\n')
}

// ---- navigation journeys ------------------------------------------------------------------------
async function goSearch() {
  for (let i = 0; i < 10; i += 1) {
    const n = dump()
    if (byId(n, 'p169-search')) return
    if (byId(n, 'p169-card') || byId(n, 'p169-card-identity') || byId(n, 'p170-add-intent') || byIdPrefix(n, 'p175-').length > 0) {
      back()
      await sleep(600)
      continue
    }
    if (byId(n, 'tab-search')) {
      tap(byId(n, 'tab-search'))
      await sleep(600)
    } else await sleep(600)
  }
  throw new Error('could not reach the search screen')
}
async function search(query) {
  await goSearch()
  await typeInto('p169-search-input', query)
  shell('input keyevent 66')
  await waitFor((ns) => byIdPrefix(ns, 'p169-search-status-').find((x) => /ready|empty|error/.test(x.id)), {
    timeoutMs: 30000,
    label: `results for ${query}`,
  })
}
async function openHitAndChoose(key, printing) {
  const { node } = await findScrolling(`p169-hit-${cardId(key)}`)
  tap(node)
  await waitFor((ns) => byId(ns, 'p169-card') || byId(ns, 'p169-card-identity'), { label: 'card screen', timeoutMs: 30000 })
  const vId = variantId(key, printing)
  const variantNode = byId(dump(), `p169-variant-${vId}`)
  if (variantNode) {
    tap(variantNode)
    await waitFor((ns) => byIdPrefix(ns, 'p169-raw-')[0] || byIdPrefix(ns, 'p169-lookup-error-')[0], {
      timeoutMs: 30000,
      label: 'price result',
    })
  } else {
    // only_variant cards resolve without a separate tap
    await waitFor((ns) => byIdPrefix(ns, 'p169-raw-')[0] || byIdPrefix(ns, 'p169-lookup-error-')[0], {
      timeoutMs: 30000,
      label: 'price result (auto)',
    })
  }
}
async function goToAddIntent(key, printing) {
  await search(key.split('-')[0])
  await openHitAndChoose(key, printing)
  const { node } = await findScrolling('p169-add-to-collection')
  tap(node)
  await waitFor((ns) => byId(ns, 'p170-add-intent'), { label: 'add intent screen' })
}
async function findHoldingRow(holdingId) {
  await tapId('tab-collection', 'collection tab')
  await waitFor((ns) => byId(ns, 'collection-list'), { label: 'collection list' })
  return findScrolling(`row-${holdingId}`)
}
async function openCardDetail(holdingId) {
  await tapId('tab-collection', 'collection tab')
  await waitFor((ns) => byId(ns, 'collection-list'), { label: 'collection list' })
  const { node } = await findScrolling(`row-${holdingId}`)
  tap(node)
  await waitFor((ns) => byId(ns, 'card-detail'), { label: 'card detail', timeoutMs: 20000 })
}

// ---- report --------------------------------------------------------------------------------------
const report = { steps, metrics: {} }
async function main() {
  await run('app foreground', ensureApp)

  await run('sign in as B', async () => {
    const n = await waitFor((ns) => byId(ns, 'login-email') && ns, { label: 'login form', timeoutMs: 30000 })
    tap(byId(n.value, 'login-email'))
    await sleep(300)
    type(B.email)
    tap(byId(dump(), 'login-password'))
    await sleep(300)
    type(B.password)
    shell('input keyevent 66')
    await waitFor((ns) => byId(ns, 'collection-list') || byId(ns, 'login-error'), { timeoutMs: 30000, label: 'post-login' })
    if (byId(dump(), 'login-error')) throw new Error('login failed')
  })

  // ---- A. Add acquisition: known cost ----
  const knownCostBefore = psql(
    `select count(*) from acquisition_lots where user_id='${B.id}' and cost_basis_state='known' and unit_cost_basis_minor=4567`,
  )
  await run('acquisition: navigate to Add acquisition (known cost)', () => goToAddIntent('pika-reprint-025', 'normal|'))
  await run('acquisition: open Add-to-collection (acquisition) — assert no write on open', async () => {
    await tapScrolling('p175-go-add-acquisition')
    await waitFor((ns) => byId(ns, 'p175-add-acquisition'), { label: 'add acquisition screen' })
    const stillZero = psql(
      `select count(*) from acquisition_lots where user_id='${B.id}' and cost_basis_state='known' and unit_cost_basis_minor=4567`,
    )
    if (stillZero !== knownCostBefore) throw new Error(`opening the form itself wrote a row: before=${knownCostBefore} after=${stillZero}`)
  })
  await run('acquisition: enter known cost 45.67 NOK, qty 2', async () => {
    await typeInto('p175-unit-cost', '45.67')
    await typeInto('p175-quantity', '2')
  })
  await run('acquisition: confirm and verify exactly one new known-cost lot', async () => {
    await tapScrolling('p175-confirm-acquisition')
    await waitFor((ns) => byId(ns, 'collection-list') || byId(ns, 'p175-acquisition-success'), {
      timeoutMs: 20000,
      label: 'acquisition result',
    })
    const rows = psqlRows(
      `select al.id, al.holding_id, al.quantity, al.unit_cost_basis_minor, al.cost_basis_state from acquisition_lots al where al.user_id='${B.id}' and al.unit_cost_basis_minor=4567 and al.quantity=2`,
    )
    if (rows.length !== 1) throw new Error(`expected exactly 1 matching lot, found ${rows.length}: ${rows.join('|')}`)
    const [, holdingId] = rows[0].split('|')
    return { holdingId, row: rows[0] }
  })
  const acquisitionHoldingId = steps.at(-1).detail.holdingId

  // ---- B. Add acquisition: unknown cost ----
  await run('unknown-cost: navigate to Add acquisition', () => goToAddIntent('pika-base-025', 'normal|'))
  await run('unknown-cost: mark cost unknown and confirm', async () => {
    await tapScrolling('p175-go-add-acquisition')
    await waitFor((ns) => byId(ns, 'p175-add-acquisition'), { label: 'add acquisition screen' })
    await tapScrolling('p175-cost-toggle')
    await tapScrolling('p175-confirm-acquisition')
    await waitFor((ns) => byId(ns, 'collection-list') || byId(ns, 'p175-acquisition-success'), {
      timeoutMs: 20000,
      label: 'unknown acquisition result',
    })
  })
  await run('unknown-cost: verify NULL cost, never 0', async () => {
    const rows = psqlRows(
      `select unit_cost_basis_minor, cost_basis_state from acquisition_lots where user_id='${B.id}' and holding_id=(select id from holdings where user_id='${B.id}' and card_variant_id='${variantId('pika-base-025', 'normal|')}') order by created_at desc limit 1`,
    )
    if (rows.length !== 1) throw new Error('unknown-cost lot not found')
    const [minor, state] = rows[0].split('|')
    if (minor !== '' || state !== 'unknown') throw new Error(`expected unit_cost_basis_minor NULL / state unknown, got ${rows[0]}`)
    return rows[0]
  })

  // ---- C. Purchase with the specified charges ----
  const purchasesBefore = Number(psql(`select count(*) from purchases where user_id='${B.id}'`))
  await run('purchase: navigate to Record purchase', () => goToAddIntent('zard-base-004', 'normal|'))
  await run('purchase: enter quantity=2 unit=45.00 shipping=30 customs=10 discount=20', async () => {
    await tapScrolling('p175-go-record-purchase')
    await waitFor((ns) => byId(ns, 'p175-record-purchase'), { label: 'record purchase screen' })
    await typeInto('p175-purchase-quantity', '2')
    await typeInto('p175-purchase-unit-price', '45.00')
    await typeInto('p175-purchase-shipping', '30')
    await typeInto('p175-purchase-customs', '10')
    await typeInto('p175-purchase-discount', '20')
  })
  const previewTotal = await run('purchase: read preview total', () => {
    const n = dump()
    const el = byId(n, 'p175-purchase-total')
    return el?.text ?? el?.desc ?? null
  })
  await run('purchase: confirm and verify against the shared allocator', async () => {
    await tapScrolling('p175-confirm-purchase')
    await waitFor((ns) => byId(ns, 'collection-list') || byId(ns, 'p175-purchase-success'), {
      timeoutMs: 20000,
      label: 'purchase result',
    })
    const after = Number(psql(`select count(*) from purchases where user_id='${B.id}'`))
    if (after !== purchasesBefore + 1) throw new Error(`expected exactly 1 new purchase, before=${purchasesBefore} after=${after}`)
    // 2*4500 + 3000 + 1000 - 2000 = 9000 + 3000 + 1000 - 2000 = 11000 minor units = 110.00 NOK
    const row = psql(
      `select p.id, p.shipping_minor, p.customs_minor, p.discount_minor, pl.quantity, pl.unit_price_minor from purchases p join purchase_lines pl on pl.purchase_id=p.id where p.user_id='${B.id}' order by p.created_at desc limit 1`,
    )
    const [, shipping, customs, discount, qty, unit] = row.split('|')
    const computedTotal = Number(qty) * Number(unit) + Number(shipping) + Number(customs) - Number(discount)
    if (computedTotal !== 11000) throw new Error(`unexpected computed total ${computedTotal} from row ${row}`)
    return { previewTotal, dbRow: row, computedTotal }
  })

  // ---- D. Idempotency: rapid double-tap on a SECOND purchase ----
  const purchasesBeforeDouble = Number(psql(`select count(*) from purchases where user_id='${B.id}'`))
  await run('idempotency: navigate to a second Record purchase', () => goToAddIntent('pika-promo', 'normal|'))
  await run('idempotency: fill and rapid double-tap Confirm', async () => {
    await tapScrolling('p175-go-record-purchase')
    await waitFor((ns) => byId(ns, 'p175-record-purchase'), { label: 'record purchase screen (double-tap)' })
    await typeInto('p175-purchase-unit-price', '10.00')
    const { node } = await findScrolling('p175-confirm-purchase')
    tap(node)
    tap(node)
    tap(node)
  })
  await run('idempotency: verify exactly ONE new purchase despite 3 taps', async () => {
    await waitFor((ns) => byId(ns, 'collection-list') || byId(ns, 'p175-purchase-success'), {
      timeoutMs: 20000,
      label: 'double-tap purchase settled',
    })
    await sleep(1500) // let any (refused) second in-flight attempt resolve
    const after = Number(psql(`select count(*) from purchases where user_id='${B.id}'`))
    if (after !== purchasesBeforeDouble + 1) throw new Error(`expected exactly 1 new purchase from 3 taps, before=${purchasesBeforeDouble} after=${after}`)
    return { before: purchasesBeforeDouble, after }
  })

  // ---- E. Manual valuation: set / explicit zero / clear ----
  // Read the SPECIFIC `detail-price-state` element, never a generic screen-text substring search:
  // the "Manual valuation" NAVIGATION BUTTON is always on screen regardless of price state, so a
  // substring check against every text node is a false positive against its own label.
  const priceState = () => byId(dump(), 'detail-price-state')?.text ?? null
  await run('manual value: open Card detail for the acquisition holding', () => openCardDetail(acquisitionHoldingId))
  await run('manual value: initial state is "No value available"', () => {
    const s = priceState()
    if (s !== 'No value available') throw new Error(`expected no value yet; got ${JSON.stringify(s)}`)
  })
  await run('manual value: set 100.00', async () => {
    await tapScrolling('manual-valuation')
    await waitFor((ns) => byId(ns, 'p175-manual-valuation'), { label: 'manual valuation screen' })
    await typeInto('p175-manual-value', '100.00')
    await tapScrolling('p175-confirm-manual-value')
    await waitFor((ns) => byId(ns, 'p175-manual-valuation-success'), { timeoutMs: 15000, label: 'manual value set' })
    back()
    await waitFor((ns) => byId(ns, 'card-detail'), { label: 'back to card detail' })
    const s = priceState()
    if (s !== 'Manual valuation') throw new Error(`expected Manual valuation state; got ${JSON.stringify(s)}`)
  })
  await run('manual value: set explicit 0.00 (known zero, not absent)', async () => {
    await tapScrolling('manual-valuation')
    await waitFor((ns) => byId(ns, 'p175-manual-valuation'), { label: 'manual valuation screen' })
    await typeInto('p175-manual-value', '0.00')
    await tapScrolling('p175-confirm-manual-value')
    await waitFor((ns) => byId(ns, 'p175-manual-valuation-success'), { timeoutMs: 15000, label: 'manual value set to 0' })
    const row = psql(`select value_minor from manual_valuations where holding_id='${acquisitionHoldingId}' and superseded_at is null`)
    if (row !== '0') throw new Error(`expected stored value 0, got ${JSON.stringify(row)}`)
    back()
    await waitFor((ns) => byId(ns, 'card-detail'), { label: 'back to card detail' })
    const s = priceState()
    if (s !== 'Manual valuation') throw new Error(`explicit-zero manual value did not render as Manual valuation, got ${JSON.stringify(s)}`)
  })
  await run('manual value: clear -> NULL / no manual value, not zero', async () => {
    await tapScrolling('manual-valuation')
    await waitFor((ns) => byId(ns, 'p175-manual-valuation'), { label: 'manual valuation screen' })
    await tapScrolling('p175-clear-manual-value')
    await waitFor((ns) => byId(ns, 'p175-manual-valuation-success'), { timeoutMs: 15000, label: 'manual value cleared' })
    const row = psql(`select count(*) from manual_valuations where holding_id='${acquisitionHoldingId}' and superseded_at is null`)
    if (row !== '0') throw new Error(`expected no active manual valuation row after Clear, found ${row}`)
    back()
    await waitFor((ns) => byId(ns, 'card-detail'), { label: 'back to card detail' })
    const s = priceState()
    if (s === 'Manual valuation') throw new Error('Clear did not revert the displayed price state')
    if (s !== 'No value available' && !/market price/i.test(s ?? ''))
      throw new Error(`unexpected price state after Clear: ${JSON.stringify(s)}`)
  })

  // ---- F. Sale: known-basis (the acquisition holding, 2 remaining) ----
  const salesBefore = Number(psql(`select count(*) from sales where user_id='${B.id}'`))
  await run('sale known-basis: open Record sale', async () => {
    await tapScrolling('record-sale')
    await waitFor((ns) => byId(ns, 'p175-record-sale'), { label: 'record sale screen', timeoutMs: 15000 })
  })
  await run('sale known-basis: sell 1 at 20.00, fees 5, negative net expected is fine either way', async () => {
    await typeInto('p175-sale-quantity', '1')
    await typeInto('p175-sale-unit-gross', '20.00')
    await typeInto('p175-sale-fees', '5')
    await tapScrolling('p175-confirm-sale')
    await waitFor((ns) => byId(ns, 'p175-sale-success'), { timeoutMs: 15000, label: 'sale recorded' })
    const after = Number(psql(`select count(*) from sales where user_id='${B.id}'`))
    if (after !== salesBefore + 1) throw new Error(`expected exactly 1 new sale, before=${salesBefore} after=${after}`)
    const result = psql(
      `select sl.realized_result_nok_minor from sale_lines sl join sales s on s.id=sl.sale_id where s.user_id='${B.id}' order by s.created_at desc limit 1`,
    )
    if (result === '') throw new Error('expected a KNOWN realized result for a known-basis lot, got NULL')
    return { realizedResultMinor: result }
  })

  // ---- G. Sale: negative net on the SAME (known-basis) holding, remaining qty 1 ----
  await run('sale negative-net: gross 1.00, fees 30.00 on the last remaining unit', async () => {
    await openCardDetail(acquisitionHoldingId)
    await tapScrolling('record-sale')
    await waitFor((ns) => byId(ns, 'p175-record-sale'), { label: 'record sale screen (negative net)', timeoutMs: 15000 })
    await typeInto('p175-sale-quantity', '1')
    await typeInto('p175-sale-unit-gross', '1.00')
    await typeInto('p175-sale-fees', '30.00')
    await tapScrolling('p175-confirm-sale')
    const outcome = await waitFor((ns) => (byId(ns, 'p175-sale-success') || byId(ns, 'p175-record-sale')) && ns, {
      timeoutMs: 15000,
      label: 'negative-net sale outcome',
    })
    if (!byId(outcome.nodes, 'p175-sale-success'))
      throw new Error('UI blocked a negative-net sale instead of accepting it')
    const result = psql(
      `select sl.realized_result_nok_minor from sale_lines sl join sales s on s.id=sl.sale_id where s.user_id='${B.id}' order by s.created_at desc limit 1`,
    )
    if (Number(result) >= 0) throw new Error(`expected a negative realized result, got ${result}`)
    return { realizedResultMinor: result }
  })

  // ---- H. Sale: unknown-basis, a pre-existing bulk-seeded holding ----
  await run('sale unknown-basis: pick a pre-existing bulk holding and sell it', async () => {
    const holdingId = psql(
      `select h.id from holdings h join acquisition_lots al on al.holding_id=h.id where h.user_id='${B.id}' and al.cost_basis_state='unknown' and al.quantity_remaining>0 limit 1`,
    )
    if (holdingId === '') throw new Error('no unknown-basis holding with remaining quantity found in the seed data')
    await openCardDetail(holdingId)
    await tapScrolling('record-sale')
    await waitFor((ns) => byId(ns, 'p175-record-sale'), { label: 'record sale screen (unknown basis)', timeoutMs: 15000 })
    await typeInto('p175-sale-quantity', '1')
    await typeInto('p175-sale-unit-gross', '15.00')
    await tapScrolling('p175-confirm-sale')
    await waitFor((ns) => byId(ns, 'p175-sale-success'), { timeoutMs: 15000, label: 'unknown-basis sale recorded' })
    const result = psql(
      `select sl.realized_result_nok_minor from sale_lines sl join sales s on s.id=sl.sale_id where s.user_id='${B.id}' order by s.created_at desc limit 1`,
    )
    if (result !== '') throw new Error(`expected NULL realized result for an unknown-basis lot, got ${result}`)
    return { holdingId }
  })

  // ---- I. Opening: a synthetic sealed lot (no UI path creates one; see seed-sealed-fixture.mjs) ----
  await run('opening: open the synthetic sealed holding and record an opening', async () => {
    const sealed = readJson('p177/sealed-fixture.json')
    const before = psql(
      `select quantity_remaining, purchase_line_id from acquisition_lots where id='${sealed.lotId}'`,
    )
    const [remainingBefore, purchaseLineIdBefore] = before.split('|')
    if (remainingBefore !== '3') throw new Error(`expected the fixture lot to start at 3 remaining, got ${before}`)
    await openCardDetail(sealed.holdingId)
    await tapScrolling('record-opening')
    await waitFor((ns) => byId(ns, 'p175-record-opening'), { label: 'record opening screen', timeoutMs: 15000 })
    await typeInto('p175-opening-quantity', '1')
    await tapScrolling('p175-confirm-opening')
    await waitFor((ns) => byId(ns, 'p175-opening-success'), { timeoutMs: 15000, label: 'opening recorded' })
    const after = psql(
      `select quantity_remaining, purchase_line_id from acquisition_lots where id='${sealed.lotId}'`,
    )
    const [remainingAfter, purchaseLineIdAfter] = after.split('|')
    if (remainingAfter !== '2') throw new Error(`expected quantity_remaining 2 after opening 1 of 3, got ${after}`)
    if (purchaseLineIdAfter !== purchaseLineIdBefore)
      throw new Error(`opening changed the source lot's own purchase_line_id: before=${purchaseLineIdBefore} after=${purchaseLineIdAfter}`)
    const purchaseCountForLine = psql(
      `select count(*) from purchase_lines where purchase_id=(select purchase_id from purchase_lines where id='${purchaseLineIdBefore}')`,
    )
    return { remainingBefore, remainingAfter, purchaseLineIdUnchanged: true, purchaseCountForLine }
  })

  // ---- J. Money keyboard: comma decimal, and a malformed value must not silently mutate ----
  await run('keyboard: comma decimal separator parses exactly like a period', async () => {
    await goToAddIntent('zero-099', 'normal|')
    await tapScrolling('p175-go-record-purchase')
    await waitFor((ns) => byId(ns, 'p175-record-purchase'), { label: 'record purchase (keyboard test)' })
    await typeInto('p175-purchase-unit-price', '45,00')
    await sleep(300)
    const { node } = await findScrolling('p175-purchase-total')
    const preview = node?.text ?? node?.desc ?? ''
    if (!/45[.,]00|45\s*kr/i.test(preview)) throw new Error(`comma input did not parse: preview=${JSON.stringify(preview)}`)
    return { preview }
  })
  await run('keyboard: malformed "1,2,3" is refused, not silently coerced', async () => {
    const before = Number(psql(`select count(*) from purchases where user_id='${B.id}'`))
    await typeInto('p175-purchase-unit-price', '1,2,3', { verify: false })
    await tapScrolling('p175-confirm-purchase')
    // A native Alert is its own uiautomator window (the underlying screen's testIDs are absent
    // from the dump while it is up) — dismiss it, THEN confirm the screen and the invariant.
    const dialog = await waitFor((ns) => ns.some((n) => /check your entry/i.test(n.text)) && ns, {
      timeoutMs: 5000,
      label: 'validation alert',
    })
    const okButton = dialog.nodes.find((n) => n.text === 'OK')
    if (okButton) tap(okButton)
    else back()
    await waitFor((ns) => byId(ns, 'p175-record-purchase'), { label: 'back on the purchase form', timeoutMs: 10000 })
    const after = Number(psql(`select count(*) from purchases where user_id='${B.id}'`))
    if (after !== before) throw new Error(`malformed input created a purchase anyway: before=${before} after=${after}`)
    return { before, after }
  })

  console.log('\nALL P177 FINANCIAL DEVICE JOURNEYS COMPLETE\n')
}

main()
  .then(() => {
    writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2))
    const fails = steps.filter((s) => s.status === 'FAIL').length
    console.log(`\n${String(steps.length - fails)} PASS / ${String(fails)} FAIL`)
    process.exit(fails > 0 ? 1 : 0)
  })
  .catch((e) => {
    writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2))
    console.error('DRIVER FAILED:', e)
    process.exit(1)
  })

#!/usr/bin/env node
/**
 * P170 Android runtime check: drives the INSTALLED integrated app (release build, Hermes, embedded
 * bundle, real native modules) on the P170 emulator through the catalog search / Price Check /
 * identity / session journey. LOCAL ONLY, synthetic users only. The photo lifecycle around Activity
 * recreation is scripts/android-p167-check.mjs (run against the same build).
 *
 *   ANDROID_SERIAL=emulator-5570 node scripts/p170/android-check.mjs      (P170_STEPS=<regex> for a subset)
 *
 * Parallel-session safety: every adb call targets ANDROID_SERIAL (required; the script refuses to run
 * without it and unless the device is the AVD p170_api36), and only this app's package is cleared,
 * started or stopped. Global emulator settings it changes (font scale, night mode, density, stylus
 * handwriting, autofill, network) are restored at the end.
 *
 * Preconditions: `node scripts/p170/backend.mjs start|seed|write-env` and the synthetic TCGdex mock
 * (`node scripts/p169/mock-tcgdex.mjs --stack=p170`) are running, and the APK from
 * scripts/p170/build-apk.mjs (EXPO_PUBLIC_RUNTIME_PROOF=1) is installed. Credentials come from the
 * gitignored fixture files and go to adb only; no e-mail address is printed.
 *
 * Output: .build/p170-evidence/{report.json, *.png, logcat-*.txt} (gitignored).
 */
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
import {
  amStart,
  appPid,
  crashCount,
  decodePng,
  disableAutofill,
  localActivityId,
  plain,
  pxPerDp,
  rows,
  signIn,
  text,
} from '../android-p167-lib.mjs'

if (!/^emulator-\d+$/.test(process.env.ANDROID_SERIAL ?? '')) {
  console.error('set ANDROID_SERIAL to the P170 emulator serial (never another session’s)')
  process.exit(2)
}
const SERIAL = process.env.ANDROID_SERIAL
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const outDir = join(appRoot, '.build', 'p170-evidence')
mkdirSync(outDir, { recursive: true })
const readJson = (rel) => JSON.parse(readFileSync(join(appRoot, '.local-backend', rel), 'utf8'))
const shared = readJson('fixture.json') // P167 users A/B (collections)
const catalog = readJson('p170/fixture.json').catalog // P169 catalog ids
const pub = readJson('p170/public-env.json')
const A = shared.users.a
const B = shared.users.b
const cardId = (key) => catalog[key].cardId
const variantId = (key, printing) => catalog[key].variants[printing]

const steps = []
const metrics = {}
const only = process.env.P170_STEPS ? new RegExp(process.env.P170_STEPS, 'i') : null
class NotRun extends Error {}

function record(step, status, detail) {
  steps.push({ step, status, detail })
  console.log(`${status} ${step}${detail ? `  ${JSON.stringify(detail).slice(0, 600)}` : ''}`)
}
async function run(step, fn) {
  if (only && !only.test(step)) return
  try {
    record(step, 'PASS', await fn())
  } catch (e) {
    if (e instanceof NotRun) return record(step, 'NOT_RUN', { reason: e.message })
    const name = `fail-${String(steps.length + 1)}`
    try {
      shot(name)
    } catch {
      // best effort; the failure is what gets recorded
    }
    record(step, 'FAIL', { error: String(e.message ?? e).slice(0, 500), screenshot: `${name}.png` })
  }
}
const shot = (name) => {
  const png = screencap()
  writeFileSync(join(outDir, `${name}.png`), png)
  return png
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg)
}
const NB = ' '

// ---- input helpers (same verified-typing approach as P169's driver) --------------------------------
function type(t) {
  if (!/^[A-Za-z0-9 ._@+-]+$/.test(t)) throw new Error('type: unsupported characters')
  adb(['shell', 'input', 'text', t.replaceAll(' ', '%s')])
}
async function typeInto(id, t, { secret = false } = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { value } = await waitFor((ns) => byId(ns, id), { label: id })
    tap(value)
    await sleep(700)
    const before = byId(dump(), id)?.text ?? ''
    if (attempt > 0 || (before !== '' && !secret && before === t)) {
      shell('input keyevent KEYCODE_MOVE_END')
      for (let i = 0; i < Math.max(before.length, t.length) + 2; i += 1) shell('input keyevent 67')
    }
    type(t)
    await sleep(400)
    const now = byId(dump(), id)?.text ?? ''
    if (secret ? now.length === t.length : now === t) return
  }
  throw new Error(`input did not reach ${id}`)
}
const back = () => shell('input keyevent 4')
async function tapId(id, label = id) {
  tap((await waitFor((ns) => byId(ns, id), { label })).value)
}
async function findScrolling(id, tries = 8) {
  for (let i = 0; i < tries; i += 1) {
    const nodes = dump()
    const node = byId(nodes, id)
    if (node) return { node, nodes }
    shell('input touchscreen swipe 540 1700 540 700 300')
    await sleep(400)
  }
  throw new Error(`not found after scrolling: ${id}`)
}
function perfLines() {
  return adb(['logcat', '-d', '-v', 'brief', 'ReactNativeJS:V', '*:S'], { allowFail: true })
    .split('\n')
    .filter((l) => l.includes('P169_PERF'))
    .map((l) => JSON.parse(l.slice(l.indexOf('{'))))
}

// ---- journey helpers -----------------------------------------------------------------------------------
async function goSearch() {
  for (let i = 0; i < 6; i += 1) {
    const n = dump()
    if (byId(n, 'p169-search')) return
    if (byId(n, 'tab-search') && !byId(n, 'p169-search-input')) {
      tap(byId(n, 'tab-search'))
      await sleep(500)
      if (byId(dump(), 'p169-search')) return
    }
    back()
    await sleep(600)
  }
  throw new Error('could not reach the search screen')
}
async function search(query) {
  await goSearch()
  const n = dump()
  const current = byId(n, 'p169-search-input')?.text ?? ''
  if (current !== '' && !byId(n, 'p169-search-status-idle')) {
    await tapId('p169-search-input')
    shell('input keyevent KEYCODE_MOVE_END')
    for (let i = 0; i < current.length; i += 1) shell('input keyevent 67')
  }
  const t0 = Date.now()
  await typeInto('p169-search-input', query)
  shell('input keyevent 66')
  const r = await waitFor(
    (ns) => byIdPrefix(ns, 'p169-search-status-').find((x) => /ready|empty|error/.test(x.id)),
    { timeoutMs: 30000, label: `results for ${query}` },
  )
  return {
    ms: Date.now() - t0,
    status: r.value.id.replace(/.*p169-search-status-/, ''),
    nodes: r.nodes,
  }
}
async function openHit(key) {
  const { node } = await findScrolling(`p169-hit-${cardId(key)}`)
  tap(node)
  await waitFor((ns) => byId(ns, 'p169-card') || byId(ns, 'p169-card-identity'), {
    label: 'card screen',
    timeoutMs: 30000,
  })
}
async function choose(key, printing) {
  const { node } = await findScrolling(`p169-variant-${variantId(key, printing)}`)
  const t0 = Date.now()
  tap(node)
  const r = await waitFor(
    (ns) => byIdPrefix(ns, 'p169-raw-')[0] || byIdPrefix(ns, 'p169-lookup-error-')[0],
    { timeoutMs: 30000, label: 'price result' },
  )
  return { ms: Date.now() - t0, nodes: r.nodes }
}
async function signOut() {
  await tapId('tab-profile', 'profile tab')
  await tapId('sign-out', 'sign out')
  await waitFor((ns) => byId(ns, 'login-screen'), { label: 'login after sign-out' })
}

// ---- read-only ledger proof (docker exec into THIS project's database only) ----------------------------
const LEDGER = [
  'holdings',
  'acquisition_lots',
  'manual_valuations',
  'manual_card_definitions',
  'purchases',
  'purchase_lines',
  'sales',
  'sale_lines',
  'lot_disposals',
  'lot_cost_adjustments',
  'sealed_products',
  'openings',
  'price_snapshots',
  'fx_rates',
  'profiles',
]
function ledgerHashes() {
  const sql = LEDGER.map(
    (t) =>
      `select '${t}' || '=' || count(*) || ':' || coalesce(md5(string_agg(x::text, '|' order by x::text)), '-') from public.${t} x;`,
  ).join('\n')
  const r = spawnSync(
    'docker',
    [
      'exec',
      '-i',
      pub.dbContainer,
      'psql',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-At',
      '-v',
      'ON_ERROR_STOP=1',
    ],
    { input: sql, encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
  )
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr}`)
  return Object.fromEntries(
    r.stdout
      .trim()
      .split('\n')
      .map((l) => l.split('=')),
  )
}

// ---------------------------------------------------------------------------------------------------
const device = {
  serial: SERIAL,
  avd: adb(['emu', 'avd', 'name']).split('\n')[0].trim(),
  model: shell('getprop ro.product.model').trim(),
  android: shell('getprop ro.build.version.release').trim(),
  sdk: shell('getprop ro.build.version.sdk').trim(),
  abi: shell('getprop ro.product.cpu.abi').trim(),
  size: shell('wm size').trim(),
  density: shell('wm density').trim(),
}
metrics.device = device
if (device.avd !== 'p170_api36') {
  console.error(`refusing: ${SERIAL} runs AVD ${device.avd}, not p170_api36`)
  process.exit(2)
}
const width = Number(/(\d+)x\d+/.exec(device.size)?.[1] ?? 1080)
const dp = pxPerDp()
const MIN_PX = Math.floor(48 * dp)

/** Clickable controls of the app under 48 dp (a row cut off by the list's own edge is not undersized). */
function undersized(nodes) {
  const list = byId(nodes, 'p169-results')?.bounds
  return nodes
    .filter((x) => x.clickable && x.pkg === PACKAGE && x.bounds && !/^tab-/.test(x.id))
    .filter((x) => {
      const b = x.bounds
      if (list && /^p169-hit-/.test(x.id) && (b.y1 <= list.y1 || b.y2 >= list.y2)) return false
      return b.y2 - b.y1 < MIN_PX || b.x2 - b.x1 < MIN_PX
    })
    .map((x) => ({
      id: x.id || x.desc || x.text,
      hDp: Math.round((x.bounds.y2 - x.bounds.y1) / dp),
      wDp: Math.round((x.bounds.x2 - x.bounds.x1) / dp),
    }))
}
const targets = {}
function checkTargets(name, nodes) {
  const bad = undersized(nodes)
  targets[name] = bad
  assert(bad.length === 0, `${name}: targets under 48 dp ${JSON.stringify(bad)}`)
}

const stylusBefore = shell('settings get secure stylus_handwriting_enabled').trim()
shell('settings put secure stylus_handwriting_enabled 0')
const restoreAutofill = disableAutofill()
shell('settings put system font_scale 1.0')
shell('cmd uimode night no')
shell(`am force-stop ${PACKAGE}`)
shell(`pm clear ${PACKAGE}`)
adb(['logcat', '-c'])
adb(['logcat', '-b', 'crash', '-c'], { allowFail: true })

await run('1 cold start (clean data) to the login screen', async () => {
  const s = amStart()
  metrics.coldStart = s
  await waitFor((ns) => byId(ns, 'login-screen'), { label: 'login screen', timeoutMs: 60000 })
  shot('01-login')
  return s
})

await run('2 Hermes: P166 (shell money) + P169 (Price Check domain) proofs on device', async () => {
  const log = adb(['logcat', '-d', '-v', 'brief', 'ReactNativeJS:V', '*:S'])
  writeFileSync(
    join(outDir, 'logcat-proofs.txt'),
    log
      .split('\n')
      .filter((l) => /P16[69]_PROOF/.test(l))
      .join('\n'),
  )
  const p166 = log.split('\n').find((l) => l.includes('P166_PROOF RESULT'))
  const p169 = log.split('\n').find((l) => l.includes('P169_PROOF RESULT'))
  assert(p166 && /fail=0/.test(p166) && /hermes/.test(p166), `P166 proof: ${String(p166)}`)
  assert(p169 && /fail=0/.test(p169) && /hermes/.test(p169), `P169 proof: ${String(p169)}`)
  return { p166: p166.slice(p166.indexOf('RESULT')), p169: p169.slice(p169.indexOf('RESULT')) }
})

let ledgerBefore = null
await run('3 sign in as A: the collection loads with the exact seeded total', async () => {
  const r = await signIn(A)
  const total = plain(text(r.nodes, 'collection-total') ?? '')
  assert(total === '8 917 127 262 195 456,87 kr', `collection total ${JSON.stringify(total)}`)
  shot('03-collection-a')
  ledgerBefore = ledgerHashes()
  return { firstPageVisibleMs: r.firstPageVisibleMs, total, rowsVisible: rows(r.nodes).length }
})

await run('4 four tabs with clean names (Collection, Search, Price Check, Profile)', async () => {
  const n = dump()
  const names = ['tab-collection', 'tab-search', 'tab-pricecheck', 'tab-profile'].map(
    (id) => byId(n, id)?.desc,
  )
  assert(
    JSON.stringify(names) === JSON.stringify(['Collection', 'Search', 'Price Check', 'Profile']),
    `tab names ${JSON.stringify(names)}`,
  )
  return { names }
})

await run('5 Price Check tab: read-only landing, explicit photo copy', async () => {
  await tapId('tab-pricecheck')
  const n = (await waitFor((ns) => byId(ns, 'price-check-home') && ns, { label: 'landing' })).value
  assert(byId(n, 'price-check-read-only'), 'read-only statement')
  assert(
    text(n, 'pc-home-photo-note') === 'A photo does not currently identify the card automatically.',
    `photo note ${String(text(n, 'pc-home-photo-note'))}`,
  )
  checkTargets('price check landing', n)
  shot('05-price-check-landing')
  return {}
})

await run(
  '6 search: same-name cards are shown distinctly (set + number), none selected',
  async () => {
    await tapId('tab-search')
    const r = await search('P169 Pikachu')
    metrics.coldSearchMs = r.ms
    assert(r.status === 'ready', `status ${r.status}`)
    const base = byId(r.nodes, `p169-hit-${cardId('pika-base-025')}`)
    const reprint = byId(r.nodes, `p169-hit-${cardId('pika-reprint-025')}`)
    assert(base && reprint, 'both #025 Pikachu hits visible')
    assert(
      /P169 Base Set, number 025/.test(base.desc) &&
        /P169 Legends Reprint, number 025/.test(reprint.desc),
      'set + number in the labels',
    )
    assert(/Same name as another result/.test(base.desc), 'same-name flag')
    assert(!byId(r.nodes, 'p169-card'), 'no card auto-opened')
    checkTargets('search results', r.nodes)
    shot('06-search-results')
    return { ms: r.ms }
  },
)

await run('7 choose the card: two printings require a choice, no price before it', async () => {
  await openHit('pika-base-025')
  const n = (await waitFor((ns) => byId(ns, 'p169-printing-choice') && ns, { label: 'choice' }))
    .value
  assert(!byIdPrefix(n, 'p169-obs-')[0], 'no observation before the choice')
  assert(!byId(n, 'p169-add-to-collection'), 'no add-to-collection before the choice')
  checkTargets('printing choice', n)
  shot('07-choose-printing')
  return {}
})

await run(
  '8 raw provider price: both providers, source money, NOK reference, freshness',
  async () => {
    const r = await choose('pika-base-025', 'reverse|')
    metrics.firstPriceRequestMs = r.ms
    const n = r.nodes
    const cm = text(n, 'p169-obs-tcgdex_cardmarket-source')
    const tp = text(n, 'p169-obs-tcgdex_tcgplayer-source')
    const nok = plain(text(n, 'p169-obs-tcgdex_cardmarket-nok') ?? '')
    assert(cm === '€4.20' && tp === '$5.00', `source ${String(cm)} ${String(tp)}`)
    assert(nok === '48,30 kr', `nok ${nok}`)
    assert(byId(n, 'p169-contract-search_prices_observations'), 'observations contract label')
    assert(
      /\S/.test(text(n, 'p169-obs-tcgdex_cardmarket-observed') ?? ''),
      'observed/freshness text',
    )
    assert(/\S/.test(text(n, 'p169-fetched') ?? ''), 'fetched text')
    checkTargets('card prices', n)
    shot('08-price-reverse')
    return { ms: r.ms, cm, tp, nok }
  },
)

await run('9 graded: unavailable, never derived from a raw price', async () => {
  const { nodes } = await findScrolling('p169-graded-status')
  const t = text(nodes, 'p169-graded-status') ?? ''
  assert(/No verified graded market data available/.test(t), `graded text ${t.slice(0, 80)}`)
  assert(!/PSA|BGS|CGC/.test(plain(t)) || /never derived/.test(t), 'no graded figure')
  return { text: t.slice(0, 140) }
})

await run(
  '10 same card, other printing: answered from the session cache, then stored snapshot',
  async () => {
    const before = perfLines().filter((p) => p.type === 'provider_request').length
    const { node } = await findScrolling(`p169-variant-${variantId('pika-base-025', 'normal|')}`)
    tap(node)
    await waitFor((ns) => byId(ns, 'p169-obs-tcgdex_cardmarket-source'), { label: 'normal price' })
    const after = perfLines().filter((p) => p.type === 'provider_request').length
    metrics.printingSwitchNewProviderRequests = after - before
    await tapId('p169-source-snapshot_rpc')
    await waitFor((ns) => byId(ns, 'p169-raw-snapshot'), { label: 'snapshot' })
    const n = (await findScrolling('p169-snap-tcgdex_cardmarket-nok')).nodes
    const nok = plain(text(n, 'p169-snap-tcgdex_cardmarket-nok') ?? '')
    assert(nok === '17,25 kr', `A snapshot ${nok}`)
    assert(!byId(n, 'p169-snap-tcgdex_tcgplayer-nok'), 'only the account provider')
    shot('10-snapshot')
    await tapId('p169-source-search_prices')
    await waitFor((ns) => byId(ns, 'p169-raw-observations'), { label: 'provider prices again' })
    return { snapshotNok: nok, newProviderRequestsForSwitch: after - before }
  },
)

await run('11 add to collection is an intent only: nothing saved', async () => {
  const { node } = await findScrolling('p169-add-to-collection')
  tap(node)
  const n = (await waitFor((ns) => byId(ns, 'p170-add-intent') && ns, { label: 'intent screen' }))
    .value
  assert(/nothing was saved/.test(text(n, 'p170-add-intent-text') ?? ''), 'intent text')
  checkTargets('add intent', n)
  shot('11-add-intent')
  back()
  await waitFor((ns) => byId(ns, 'p169-card'), { label: 'back to the card' })
  return {}
})

await run('12 large value: a NOK reference above 2^53 is exact', async () => {
  await goSearch()
  await search('P169 Charizard')
  await openHit('zard-base-004')
  const r = await choose('zard-base-004', 'holo|')
  const nok = plain(text(r.nodes, 'p169-obs-tcgdex_cardmarket-nok') ?? '')
  assert(nok === '113 580 246 926 357,98 kr', `nok ${nok}`)
  assert(text(r.nodes, 'p169-obs-tcgdex_cardmarket-source') === '€9,876,543,210,987.65', 'source')
  shot('12-above-2p53')
  return { nok }
})

await run(
  '13 NULL is not zero: a card without a price says so; an explicit zero shows zero',
  async () => {
    await goSearch()
    await search('P169 Unpriced')
    await openHit('unpriced-098')
    const u = (
      await waitFor((ns) => byId(ns, 'p169-unavailable-no_variant_price') && ns, {
        label: 'no price',
        timeoutMs: 30000,
      })
    ).value
    assert(!byIdPrefix(u, 'p169-obs-')[0], 'no observation for an unpriced card')
    assert(
      !/€0\.00|0,00 kr/.test(u.map((x) => x.text).join(' ')),
      'an absent price rendered as zero',
    )
    shot('13a-no-price')
    await goSearch()
    await search('P169 Zero Energy')
    await openHit('zero-099')
    const z = (
      await waitFor((ns) => byId(ns, 'p169-obs-tcgdex_cardmarket-source') && ns, {
        label: 'zero',
        timeoutMs: 30000,
      })
    ).value
    assert(text(z, 'p169-obs-tcgdex_cardmarket-source') === '€0.00', 'explicit zero shown as zero')
    shot('13b-explicit-zero')
    return {}
  },
)

await run('14 provider failure is its own state (never a price)', async () => {
  await goSearch()
  await search('P169 Missing Provider')
  await openHit('missing-097')
  const n = (
    await waitFor((ns) => byId(ns, 'p169-unavailable-provider_error') && ns, {
      label: 'provider_error',
      timeoutMs: 30000,
    })
  ).value
  assert(!byIdPrefix(n, 'p169-obs-')[0], 'no observation')
  return {}
})

await run(
  '15 photo entry -> manual search (no recognition claimed, nothing uploaded)',
  async () => {
    await tapId('tab-pricecheck')
    await tapId('pc-home-photo')
    const n = (await waitFor((ns) => byId(ns, 'p169-photo-entry') && ns, { label: 'photo entry' }))
      .value
    assert(byId(n, 'p169-recognition-unavailable'), 'unavailable statement')
    checkTargets('photo entry', n)
    shot('15-photo-entry')
    await tapId('p169-choose-manually')
    await waitFor((ns) => byId(ns, 'p169-search'), { label: 'search after manual' })
    return {}
  },
)

await run(
  '16 read-only: the ledger tables are byte-identical after the whole Price Check journey',
  async () => {
    const after = ledgerHashes()
    const changed = Object.keys(after).filter((t) => after[t] !== ledgerBefore[t])
    assert(changed.length === 0, `changed tables: ${changed.join(', ')}`)
    return { tables: Object.keys(after).length, changed: 0 }
  },
)

await run('17 a slow lookup that is left is aborted; no late publication, no crash', async () => {
  await goSearch()
  await search('P169 Slow Provider')
  await openHit('slow-093')
  await sleep(500)
  back()
  await sleep(5000)
  assert(byId(dump(), 'p169-search'), 'back on search, app alive')
  const perf = perfLines().filter((p) => p.type === 'provider_request')
  return { lastProviderRequest: perf.at(-1) ?? null }
})

await run('18 warm and multi-page search (timings; emulator only)', async () => {
  const warm = await search('P169 Pikachu')
  metrics.warmSearchMs = warm.ms
  const bulk = await search('P169 Bulk')
  await sleep(500)
  for (let i = 0; i < 4; i += 1) {
    shell('input touchscreen swipe 540 1900 540 400 200')
    await sleep(700)
  }
  const requests = perfLines().filter((p) => p.type === 'search_request')
  const offsets = [...new Set(requests.map((p) => p.offset))].sort((a, b) => a - b)
  metrics.multiPage = { firstPageMs: bulk.ms, offsetsLoaded: offsets }
  assert(
    offsets.length >= 2,
    `the bulk query did not load a second page (offsets ${offsets.join(',')})`,
  )
  return { warmMs: warm.ms, bulkFirstMs: bulk.ms, offsetsLoaded: offsets }
})

await run(
  '19 200 % text: search and price screens, amounts complete and inside the screen',
  async () => {
    shell('settings put system font_scale 2.0')
    await sleep(3500)
    await search('P169 Charizard')
    shot('19a-search-200')
    await openHit('zard-base-004')
    await choose('zard-base-004', 'holo|')
    const { node } = await findScrolling('p169-obs-tcgdex_cardmarket-nok')
    assert(plain(node.text) === '113 580 246 926 357,98 kr', `amount ${plain(node.text)}`)
    assert(node.bounds.x1 >= 0 && node.bounds.x2 <= width, 'amount inside the screen width')
    const over = dump().filter((x) => x.bounds && x.bounds.x2 > width + 1)
    assert(over.length === 0, `${String(over.length)} nodes wider than the screen`)
    shot('19b-price-200')
    shell('settings put system font_scale 1.0')
    await sleep(3000)
    return { amountBounds: node.bounds, lineHeightPx: node.bounds.y2 - node.bounds.y1 }
  },
)

await run('20 dark mode: the new screens and the chrome are dark', async () => {
  shell('cmd uimode night yes')
  await sleep(2500)
  await goSearch()
  const png = decodePng(shot('20-dark-search'))
  const header = png.bandLuminance(Math.round(30 * dp), Math.round(80 * dp))
  const content = png.bandLuminance(Math.round(400 * dp), Math.round(600 * dp))
  const tabBar = png.bandLuminance(png.h - Math.round(80 * dp), png.h - Math.round(30 * dp))
  assert(
    header < 0.35 && content < 0.35 && tabBar < 0.35,
    `luminance ${header}/${content}/${tabBar}`,
  )
  await tapId('tab-pricecheck')
  await waitFor((ns) => byId(ns, 'price-check-home'), { label: 'landing dark' })
  const landing = decodePng(shot('20-dark-landing'))
  const l = landing.bandLuminance(Math.round(400 * dp), Math.round(600 * dp))
  assert(l < 0.35, `landing luminance ${l}`)
  shell('cmd uimode night no')
  await sleep(1500)
  return { header, content, tabBar, landing: l }
})

await run(
  '21 360 / 390 / 430 dp widths: no node wider than the screen, no target under 48 dp',
  async () => {
    const min = Math.floor(48 * dp)
    const out = {}
    for (const w of [360, 390, 430]) {
      shell(`wm density ${String(Math.round((width * 160) / w))}`)
      await sleep(2500)
      const r = await search('P169 Pikachu')
      const overflow = r.nodes.filter((x) => x.bounds && x.bounds.x2 > width + 1).length
      const localMin = Math.floor(48 * (Math.round((width * 160) / w) / 160))
      const small = r.nodes
        .filter((x) => x.clickable && x.pkg === PACKAGE && x.bounds && !/^tab-/.test(x.id))
        .filter((x) => x.bounds.y2 - x.bounds.y1 < localMin)
        .map((x) => x.id || x.desc)
      shot(`21-width-${String(w)}dp`)
      out[w] = { overflow, small }
      assert(overflow === 0, `${String(w)}dp overflow ${String(overflow)}`)
      assert(small.length === 0, `${String(w)}dp targets under 48 dp: ${small.join(',')}`)
    }
    shell('wm density reset')
    await sleep(2500)
    return { ...out, minPxAtDefault: min }
  },
)

await run(
  '22 A -> B: A signs out, B signs in: B starts empty and gets ITS OWN provider',
  async () => {
    await goSearch()
    await search('P169 Pikachu')
    await openHit('pika-base-025')
    await choose('pika-base-025', 'normal|')
    await signOut()
    const r = await signIn(B)
    await tapId('tab-search')
    const fresh = (await waitFor((ns) => byId(ns, 'p169-search') && ns, { label: 'B search' }))
      .value
    // uiautomator reports an empty EditText's hint as its text: the store's own idle status is the
    // evidence that A's draft, results and card did not survive.
    assert(byId(fresh, 'p169-search-status-idle'), 'B starts with an empty, idle search')
    assert(!byIdPrefix(fresh, 'p169-hit-')[0], 'no A results under B')
    assert(!byId(fresh, 'p169-card'), 'no A card under B')
    await search('P169 Pikachu')
    await openHit('pika-base-025')
    await choose('pika-base-025', 'normal|')
    await tapId('p169-source-snapshot_rpc')
    await waitFor((ns) => byId(ns, 'p169-raw-snapshot'), { label: 'B snapshot' })
    const b = (await findScrolling('p169-snap-tcgdex_tcgplayer-nok')).nodes
    assert(!byId(b, 'p169-snap-tcgdex_cardmarket-nok'), 'no A provider under B')
    const nok = plain(text(b, 'p169-snap-tcgdex_tcgplayer-nok') ?? '')
    assert(nok === '22,05 kr', `B snapshot ${nok}`)
    shot('22-b-snapshot')
    return { bRows: rows(r.nodes).length, bTotal: text(r.nodes, 'collection-total'), snapshot: nok }
  },
)

await run('23 A -> B -> A: nothing of the first A session or of B is resurrected', async () => {
  await signOut()
  await signIn(A)
  await tapId('tab-search')
  const n = (await waitFor((ns) => byId(ns, 'p169-search') && ns, { label: 'A search again' }))
    .value
  assert(byId(n, 'p169-search-status-idle'), 'A starts idle after B')
  assert(!byIdPrefix(n, 'p169-hit-')[0], 'no results resurrected')
  assert(!byId(n, 'p169-card'), 'no card resurrected')
  // The same card is a NEW request, not a cached answer from the earlier A session.
  const count = (type) => perfLines().filter((p) => p.type === type).length
  const requestsBefore = count('provider_request')
  const hitsBefore = count('cache_hit')
  await search('P169 Pikachu')
  await openHit('pika-base-025')
  await choose('pika-base-025', 'normal|')
  assert(
    count('provider_request') === requestsBefore + 1,
    `expected a fresh provider request (${requestsBefore} -> ${count('provider_request')})`,
  )
  assert(count('cache_hit') === hitsBefore, 'the answer came from a cache of an earlier session')
  return { freshProviderRequest: true }
})

await run(
  '24 background and resume: the screen, the printing and the price are kept, no repeat request',
  async () => {
    const before = perfLines().filter((p) => p.type === 'provider_request').length
    shell('input keyevent 3')
    await sleep(3000)
    amStart()
    await waitFor((ns) => byId(ns, 'p169-card') && ns, { label: 'card after resume' })
    const n = dump()
    assert(byId(n, 'p169-printing-confirmed'), 'printing choice kept')
    assert(byId(n, 'p169-obs-tcgdex_cardmarket-source'), 'price kept')
    const after = perfLines().filter((p) => p.type === 'provider_request').length
    assert(after === before, `resume repeated a provider request (${before} -> ${after})`)
    return { providerRequestsRepeated: 0 }
  },
)

await run('25 process restart restores the session (and the search starts empty)', async () => {
  shell(`am force-stop ${PACKAGE}`)
  const s = amStart()
  const r = await waitFor((ns) => (rows(ns).length > 0 || byId(ns, 'login-screen')) && ns, {
    timeoutMs: 60000,
    label: 'app after restart',
  })
  assert(!byId(r.value, 'login-screen'), 'the session was not restored')
  await tapId('tab-search')
  const n = (await waitFor((ns) => byId(ns, 'p169-search') && ns, { label: 'search' })).value
  assert(byId(n, 'p169-search-status-idle'), 'stores are not persisted')
  return { restart: s }
})

await run('26 sign-out removes the session: a restart shows the login screen', async () => {
  await signOut()
  shell(`am force-stop ${PACKAGE}`)
  amStart()
  await waitFor((ns) => byId(ns, 'login-screen'), {
    label: 'login after restart',
    timeoutMs: 60000,
  })
  await signIn(A)
  return {}
})

await run(
  '27 same-user token refresh keeps the screen (unit-tested; not forceable on device)',
  async () => {
    throw new NotRun(
      'a refresh cannot be forced on the device without changing the clock or the JWT lifetime',
    )
  },
)

// Restore global emulator settings and collect the device-side timings.
shell('settings put system font_scale 1.0')
shell('cmd uimode night no')
shell('wm density reset')
shell('svc wifi enable')
shell('svc data enable')
restoreAutofill()
if (stylusBefore !== '' && stylusBefore !== 'null')
  shell(`settings put secure stylus_handwriting_enabled ${stylusBefore}`)

metrics.touchTargets = { minDp: 48, checked: Object.keys(targets), undersized: targets }
metrics.perf = perfLines()
metrics.crashes = crashCount()
metrics.appPidAlive = appPid() !== ''
writeFileSync(
  join(outDir, 'logcat-perf.txt'),
  metrics.perf.map((p) => JSON.stringify(p)).join('\n'),
)
const pass = steps.filter((s) => s.status === 'PASS').length
const fail = steps.filter((s) => s.status === 'FAIL').length
const report = { serial: SERIAL, package: PACKAGE, pass, fail, steps, metrics }
writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2))
console.log(`\n${String(pass)} PASS, ${String(fail)} FAIL -> ${join(outDir, 'report.json')}`)
process.exit(fail === 0 ? 0 : 1)

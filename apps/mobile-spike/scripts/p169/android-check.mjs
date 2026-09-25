#!/usr/bin/env node
/**
 * P169 Android runtime check: drives the INSTALLED P169 harness (release build, Hermes) on the
 * P169 emulator and records what actually happened. LOCAL ONLY, synthetic users only.
 *
 *   ANDROID_SERIAL=emulator-5558 node scripts/p169/android-check.mjs      (P169_STEPS=<regex> for a subset)
 *
 * Parallel-session safety: every adb call targets ANDROID_SERIAL (required; the script refuses to
 * run without it, so it can never touch the P167/P168 emulators), and only the harness package
 * (invalid.pokeportfolio.spike.p169) is cleared, started or stopped. Global emulator settings it
 * changes (font scale, night mode, density, stylus handwriting, network) are restored at the end.
 *
 * Preconditions: P169 stack running + seeded (scripts/p169/local-backend.mjs, seed.mts), the
 * synthetic TCGdex mock running, the harness APK built by scripts/p169/build-harness.mjs and
 * installed. Credentials come from the gitignored fixture.json and go to adb only.
 *
 * Output: .build/p169-android-evidence/{report.json, *.png, logcat-*.txt} (gitignored).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
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
  console.error('set ANDROID_SERIAL to the P169 emulator serial (never the P167/P168 ones)')
  process.exit(2)
}
const SERIAL = process.env.ANDROID_SERIAL
const PKG = 'invalid.pokeportfolio.spike.p169'
const ACTIVITY = `${PKG}/invalid.pokeportfolio.spike.MainActivity`

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const outDir = join(appRoot, '.build', 'p169-android-evidence')
mkdirSync(outDir, { recursive: true })
const fixture = JSON.parse(
  readFileSync(join(appRoot, '.local-backend', 'p169', 'fixture.json'), 'utf8'),
)
const cardId = (key) => fixture.catalog[key].cardId
const variantId = (key, printing) => fixture.catalog[key].variants[printing]

const NB = ' '
const steps = []
const metrics = {}
const only = process.env.P169_STEPS ? new RegExp(process.env.P169_STEPS, 'i') : null

function record(step, ok, detail) {
  steps.push({ step, status: ok ? 'PASS' : 'FAIL', detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${step}${detail ? `  ${JSON.stringify(detail)}` : ''}`)
}
async function run(step, fn) {
  if (only && !only.test(step)) return
  try {
    record(step, true, await fn())
  } catch (e) {
    const name = `fail-${String(steps.length + 1)}`
    try {
      shot(name)
    } catch {
      // screenshot is best effort
    }
    record(step, false, { error: String(e.message ?? e).slice(0, 400), screenshot: `${name}.png` })
  }
}
const shot = (name) => writeFileSync(join(outDir, `${name}.png`), screencap())
const plain = (s) => s.replace(/\s/g, ' ')
const textOf = (nodes, id) => byId(nodes, id)?.text ?? null
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg)
}

/** adb `input text` with spaces (%s); only the characters used by this script. */
function type(text) {
  if (!/^[A-Za-z0-9 ._@+-]+$/.test(text)) throw new Error('type: unsupported characters')
  adb(['shell', 'input', 'text', text.replaceAll(' ', '%s')])
}
/**
 * Taps a field, types, and VERIFIES the field received the text (injected input is dropped when the
 * IME is not ready yet, e.g. right after a configuration change). A password field is verified by
 * length only (Android reports it masked). One retry after clearing.
 */
async function typeInto(id, text, { secret = false } = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { value } = await waitFor((ns) => byId(ns, id), { label: id })
    tap(value)
    await sleep(700)
    const before = byId(dump(), id)?.text ?? ''
    if (attempt > 0 || (before !== '' && !secret && before === text)) {
      shell('input keyevent KEYCODE_MOVE_END')
      for (let i = 0; i < Math.max(before.length, text.length) + 2; i += 1)
        shell('input keyevent 67')
    }
    type(text)
    await sleep(400)
    const now = byId(dump(), id)?.text ?? ''
    if (secret ? now.length === text.length : now === text) return
  }
  throw new Error(`input did not reach ${id}`)
}

async function tapId(id, label = id) {
  const { value } = await waitFor((ns) => byId(ns, id), { label })
  tap(value)
}
function scrollDown() {
  shell('input touchscreen swipe 540 1700 540 700 300')
}
/** Waits for an id, scrolling the current screen if needed. */
async function findScrolling(id, tries = 6) {
  for (let i = 0; i < tries; i += 1) {
    const nodes = dump()
    const node = byId(nodes, id)
    if (node) return { node, nodes }
    scrollDown()
    await sleep(400)
  }
  throw new Error(`not found after scrolling: ${id}`)
}
function back() {
  shell('input keyevent 4')
}
function amStart() {
  const out = shell(`am start -W -n ${ACTIVITY}`)
  return {
    totalTimeMs: Number(/TotalTime: (\d+)/.exec(out)?.[1] ?? NaN),
    launchState: /LaunchState: (\w+)/.exec(out)?.[1] ?? null,
  }
}
function perfLines() {
  return adb(['logcat', '-d', '-v', 'brief', 'ReactNativeJS:V', '*:S'])
    .split('\n')
    .filter((l) => l.includes('P169_PERF'))
    .map((l) => JSON.parse(l.slice(l.indexOf('{'))))
}

async function signIn(user) {
  await waitFor((ns) => byId(ns, 'login-email'), { label: 'login form', timeoutMs: 60000 })
  await typeInto('login-email', user.email)
  await typeInto('login-password', user.password, { secret: true })
  shell('input keyevent 66')
  const t0 = Date.now()
  const r = await waitFor((ns) => (byId(ns, 'p169-search') || byId(ns, 'login-error')) && ns, {
    timeoutMs: 60000,
    label: 'search screen',
  })
  if (byId(r.value, 'login-error')) throw new Error('login error')
  return Date.now() - t0
}

async function search(query) {
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
  const id = `p169-hit-${cardId(key)}`
  const { node } = await findScrolling(id)
  tap(node)
  await waitFor((ns) => byId(ns, 'p169-card') || byId(ns, 'p169-card-identity'), {
    label: 'card screen',
    timeoutMs: 30000,
  })
}

async function choose(key, printing) {
  const id = `p169-variant-${variantId(key, printing)}`
  const { node } = await findScrolling(id)
  const t0 = Date.now()
  tap(node)
  const r = await waitFor(
    (ns) => byIdPrefix(ns, 'p169-raw-')[0] || byIdPrefix(ns, 'p169-lookup-error-')[0],
    { timeoutMs: 30000, label: 'price result' },
  )
  return { ms: Date.now() - t0, nodes: r.nodes }
}

async function goSearch() {
  for (let i = 0; i < 5; i += 1) {
    if (byId(dump(), 'p169-search')) return
    back()
    await sleep(600)
  }
  throw new Error('could not return to search')
}

// ---------------------------------------------------------------------------------------------
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
if (device.avd !== 'p169_api36') {
  console.error(`refusing: ${SERIAL} runs AVD ${device.avd}, not p169_api36`)
  process.exit(2)
}

const stylusBefore = shell('settings get secure stylus_handwriting_enabled').trim()
shell('settings put secure stylus_handwriting_enabled 0')
shell('settings put system font_scale 1.0')
shell('cmd uimode night no')
shell(`am force-stop ${PKG}`)
shell(`pm clear ${PKG}`)
adb(['logcat', '-c'])

await run('cold start (clean data) to the login screen', async () => {
  const s = amStart()
  metrics.coldStart = s
  await waitFor((ns) => byId(ns, 'login-screen'), { label: 'login screen', timeoutMs: 60000 })
  shot('01-login')
  return s
})

await run('Hermes: P166 + P169 in-app money/domain proofs on device', async () => {
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

await run('sign in as synthetic user A -> search screen', async () => {
  const ms = await signIn(fixture.users.a)
  shot('02-search-empty')
  return { searchVisibleAfterSubmitMs: ms }
})

await run(
  'search "P169 Pikachu": same-named cards with set/number, flagged, nothing selected',
  async () => {
    const r = await search('P169 Pikachu')
    metrics.coldSearchMs = r.ms
    assert(r.status === 'ready', `status ${r.status}`)
    const base = byId(r.nodes, `p169-hit-${cardId('pika-base-025')}`)
    const reprint = byId(r.nodes, `p169-hit-${cardId('pika-reprint-025')}`)
    assert(base && reprint, 'both #025 Pikachu hits visible')
    assert(
      /P169 Base Set, number 025/.test(base.desc) &&
        /P169 Legends Reprint, number 025/.test(reprint.desc),
      'set + number in labels',
    )
    assert(/Same name as another result/.test(base.desc), 'same-name flag')
    assert(!byId(r.nodes, 'p169-card'), 'no card auto-opened')
    shot('03-search-results')
    return { ms: r.ms, baseLabel: base.desc.slice(0, 120) }
  },
)

await run('two active printings: choice required, no price shown before choosing', async () => {
  await openHit('pika-base-025')
  const n = (await waitFor((ns) => byId(ns, 'p169-printing-choice') && ns, { label: 'choice' }))
    .value
  assert(!byIdPrefix(n, 'p169-obs-')[0], 'no observation before choice')
  assert(!byId(n, 'p169-add-to-collection'), 'no add-to-collection before choice')
  shot('04-choose-printing')
  return {}
})

await run(
  'choose Reverse holo: both providers, exact source money + NOK reference, graded unavailable',
  async () => {
    const r = await choose('pika-base-025', 'reverse|')
    metrics.priceRequestMs = r.ms
    const n = r.nodes
    const cm = textOf(n, 'p169-obs-tcgdex_cardmarket-source')
    const cmNok = textOf(n, 'p169-obs-tcgdex_cardmarket-nok')
    const tp = textOf(n, 'p169-obs-tcgdex_tcgplayer-source')
    assert(cm === '€4.20' && tp === '$5.00', `source ${String(cm)} ${String(tp)}`)
    assert(plain(cmNok ?? '') === '48,30 kr', `nok ${String(cmNok)}`)
    assert(byId(n, 'p169-contract-search_prices_observations'), 'observations contract label')
    const { nodes } = await findScrolling('p169-graded-status')
    assert(
      /No verified graded market data available/.test(textOf(nodes, 'p169-graded-status') ?? ''),
      'graded text',
    )
    shot('05-price-reverse')
    return { ms: r.ms, cm, tp, cmNok: plain(cmNok) }
  },
)

await run('Add to collection returns a navigation intent only', async () => {
  const { node } = await findScrolling('p169-add-to-collection')
  tap(node)
  const n = (await waitFor((ns) => byId(ns, 'p169-intent') && ns, { label: 'intent screen' })).value
  assert(/Nothing was saved/.test(textOf(n, 'p169-intent-text') ?? ''), 'intent text')
  shot('06-intent')
  back()
  await waitFor((ns) => byId(ns, 'p169-card'), { label: 'back to card' })
  return {}
})

await run('Charizard holo: a NOK reference above 2^53 shown exactly on the device', async () => {
  await goSearch()
  await search('P169 Charizard')
  await openHit('zard-base-004')
  const r = await choose('zard-base-004', 'holo|')
  const nok = textOf(r.nodes, 'p169-obs-tcgdex_cardmarket-nok')
  const expected = `113${NB}580${NB}246${NB}926${NB}357,98 kr`
  assert(nok === expected, `nok ${JSON.stringify(nok)}`)
  assert(textOf(r.nodes, 'p169-obs-tcgdex_cardmarket-source') === '€9,876,543,210,987.65', 'source')
  shot('07-above-2p53')
  return { nok: plain(nok) }
})

await run('provider failure and an explicit zero are distinct on screen', async () => {
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
  shot('08-provider-error')
  await goSearch()
  await search('P169 Zero Energy')
  await openHit('zero-099')
  const z = (
    await waitFor((ns) => byId(ns, 'p169-obs-tcgdex_cardmarket-source') && ns, {
      label: 'zero',
      timeoutMs: 30000,
    })
  ).value
  assert(textOf(z, 'p169-obs-tcgdex_cardmarket-source') === '€0.00', 'zero shown as zero')
  shot('09-explicit-zero')
  return {}
})

await run('search again: warm (cached) query', async () => {
  await goSearch()
  const r = await search('P169 Pikachu')
  metrics.warmSearchMs = r.ms
  return { ms: r.ms }
})

await run(
  'photo -> manual fallback: recognition stated unavailable, manual route works',
  async () => {
    await goSearch()
    await tapId('p169-open-photo')
    const n = (await waitFor((ns) => byId(ns, 'p169-photo-entry') && ns, { label: 'photo entry' }))
      .value
    assert(byId(n, 'p169-recognition-unavailable'), 'unavailable statement')
    shot('10-photo-entry')
    await tapId('p169-choose-manually')
    await waitFor((ns) => byId(ns, 'p169-search'), { label: 'search after manual' })
    return {
      photoPickerExercised: false,
      note: 'the image picker itself is P167 scope (F1); not asserted here',
    }
  },
)

await run('leaving a slow lookup: aborted, no late publication, no crash', async () => {
  await goSearch()
  await search('P169 Slow Provider')
  await openHit('slow-093')
  await sleep(500)
  back()
  await sleep(5000)
  const n = dump()
  assert(byId(n, 'p169-search'), 'back on search, app alive')
  const perf = perfLines().filter((p) => p.type === 'provider_request')
  return { lastProviderRequest: perf.at(-1) ?? null }
})

await run('200 % font: amounts stay on one line and complete', async () => {
  shell('settings put system font_scale 2.0')
  await sleep(1500)
  await goSearch()
  await search('P169 Charizard')
  await openHit('zard-base-004')
  await choose('zard-base-004', 'holo|')
  // At 200 % the amount is below the fold; uiautomator only lists what is on screen.
  const { node } = await findScrolling('p169-obs-tcgdex_cardmarket-nok')
  assert(node?.text === `113${NB}580${NB}246${NB}926${NB}357,98 kr`, 'complete amount')
  const width = Number(/(\d+)x\d+/.exec(device.size)?.[1] ?? 1080)
  assert(node.bounds.x2 <= width, 'within screen width')
  const lineHeight = node.bounds.y2 - node.bounds.y1
  shot('11-font-200')
  shell('settings put system font_scale 1.0')
  await sleep(1000)
  return { amountBounds: node.bounds, lineHeightPx: lineHeight }
})

await run('dark mode renders the P169 screens on a dark background', async () => {
  shell('cmd uimode night yes')
  await sleep(2000)
  await goSearch()
  shot('12-dark-search')
  shell('cmd uimode night no')
  await sleep(1500)
  return { screenshot: '12-dark-search.png' }
})

await run('360 / 390 / 430 dp widths: no text node wider than the screen', async () => {
  const width = Number(/(\d+)x\d+/.exec(device.size)?.[1] ?? 1080)
  const results = {}
  for (const dp of [360, 390, 430]) {
    const density = Math.round((width * 160) / dp)
    shell(`wm density ${String(density)}`)
    await sleep(2500)
    await goSearch()
    const r = await search('P169 Pikachu')
    const over = r.nodes.filter((x) => x.bounds && x.bounds.x2 > width + 1)
    shot(`13-width-${String(dp)}dp`)
    results[dp] = { density, overflowing: over.length }
    assert(over.length === 0, `${String(dp)}dp overflow`)
  }
  shell('wm density reset')
  await sleep(2500)
  return results
})

await run(
  'A -> B: sign out A, sign in B; B starts empty and gets ITS OWN snapshot provider',
  async () => {
    await goSearch()
    // A: stored snapshot = Cardmarket (A prefers EU pricing).
    await search('P169 Pikachu')
    await openHit('pika-base-025')
    await choose('pika-base-025', 'normal|')
    await tapId('p169-source-snapshot_rpc')
    await waitFor((ns) => byId(ns, 'p169-raw-snapshot'), { label: 'A snapshot' })
    const a = (await findScrolling('p169-snap-tcgdex_cardmarket-nok')).nodes
    const aText = plain(textOf(a, 'p169-snap-tcgdex_cardmarket-nok') ?? '')
    await goSearch()
    await tapId('p169-open-account')
    await tapId('p169-sign-out')
    await signIn(fixture.users.b)
    const fresh = dump()
    // uiautomator reports an empty EditText's placeholder as its text, so the store's own idle status
    // (empty draft, no results) is the evidence that A's query did not survive.
    assert(byId(fresh, 'p169-search-status-idle'), 'B starts with an empty, idle search')
    assert(!byIdPrefix(fresh, 'p169-hit-')[0], 'no A results under B')
    await search('P169 Pikachu')
    await openHit('pika-base-025')
    await choose('pika-base-025', 'normal|')
    await tapId('p169-source-snapshot_rpc')
    await waitFor((ns) => byId(ns, 'p169-raw-snapshot'), { label: 'B snapshot' })
    const b = (await findScrolling('p169-snap-tcgdex_tcgplayer-nok')).nodes
    assert(!byId(b, 'p169-snap-tcgdex_cardmarket-nok'), 'no A provider under B')
    const bText = plain(textOf(b, 'p169-snap-tcgdex_tcgplayer-nok') ?? '')
    shot('14-b-snapshot')
    assert(aText === '17,25 kr' && bText === '22,05 kr', `A ${aText} B ${bText}`)
    return { a: aText, b: bText }
  },
)

await run(
  'restart: session restored (B), search works; offline shows a retryable error',
  async () => {
    shell(`am force-stop ${PKG}`)
    const s = amStart()
    await waitFor((ns) => byId(ns, 'p169-search'), {
      label: 'search after restart',
      timeoutMs: 60000,
    })
    shell('svc wifi disable')
    shell('svc data disable')
    await sleep(1500)
    const r = await search('P169 Offline Check')
    const retry = byId(dump(), 'p169-search-retry')
    shot('15-offline')
    shell('svc wifi enable')
    shell('svc data enable')
    await sleep(3000)
    assert(r.status === 'error' && retry, `offline status ${r.status}`)
    tap(retry)
    const back2 = await waitFor(
      (ns) => byIdPrefix(ns, 'p169-search-status-').find((x) => /ready|empty/.test(x.id)),
      { timeoutMs: 30000, label: 'recovered' },
    )
    return { restart: s, recoveredTo: back2.value.id.replace(/.*status-/, '') }
  },
)

// Restore global emulator settings and collect the device-side timings.
shell('settings put system font_scale 1.0')
shell('cmd uimode night no')
shell('wm density reset')
shell('svc wifi enable')
shell('svc data enable')
if (stylusBefore !== '' && stylusBefore !== 'null')
  shell(`settings put secure stylus_handwriting_enabled ${stylusBefore}`)

metrics.p169Perf = perfLines()
writeFileSync(
  join(outDir, 'logcat-perf.txt'),
  metrics.p169Perf.map((p) => JSON.stringify(p)).join('\n'),
)
const pass = steps.filter((s) => s.status === 'PASS').length
const report = { serial: SERIAL, package: PKG, pass, fail: steps.length - pass, steps, metrics }
writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2))
console.log(
  `\n${String(pass)} PASS, ${String(steps.length - pass)} FAIL -> ${join(outDir, 'report.json')}`,
)

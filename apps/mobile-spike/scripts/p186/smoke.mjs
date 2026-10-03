#!/usr/bin/env node
/**
 * P186 bounded smoke test on the RELEASE build (R8 + resource shrinking, no proof panel, no trace)
 * on the emulator. LOCAL ONLY, isolated stack, synthetic user. It needs nothing the proof build adds:
 * every check is the UI tree, the database or the screen.
 *
 *   node scripts/p186/smoke.mjs [--install <release.apk>]
 *
 *   1 dark cold launch   2 sign in     3 scanner entry    4 real synthetic image -> recognition
 *   5 candidate          6 Price Check 7 Add to Collection (form, nothing written)
 *   8 cancel before the write: the ledger is unchanged       9 Collection
 *
 * Output: .build/p186-evidence/smoke-report.json, smoke-*.png, smoke-logcat.json
 */
import './env.mjs'
import { join } from 'node:path'
import { amStart, decodePng, openPhotoScreen } from '../android-p167-lib.mjs'
import { establishIdentity } from '../android-adb.mjs'
import {
  PACKAGE,
  adb,
  byId,
  dump,
  fixtureDir,
  pickNewest,
  psql,
  pushImage,
  saveJson,
  screencap,
  shell,
  shot,
  signIn,
  sleep,
  waitFor,
  waitRecognition,
} from '../p185/lib.mjs'
import {
  assertActivityAlive,
  back,
  bringIntoView,
  clearAndType,
  findNode,
  tapNode,
  tapTestId,
  tapUntil,
  waitForNode,
} from '../p185/driver.mjs'
import { B, choosePrinting, counts, diff, priceTexts } from '../p185/journeys.mjs'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback)
}
const apk = arg('install', null)
if (apk !== null) {
  adb(['uninstall', PACKAGE], { allowFail: true })
  adb(['install', '-r', '-g', apk])
}

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
      `PASS ${String(n).padStart(2)} ${name}  ${JSON.stringify(detail ?? null).slice(0, 500)}`,
    )
    return true
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    report.push({
      n,
      step: name,
      status: 'FAIL',
      ms: Date.now() - t0,
      detail: message.slice(0, 900),
    })
    console.log(`FAIL ${String(n).padStart(2)} ${name}  ${message.slice(0, 600)}`)
    try {
      shot(`smoke-fail-${String(n)}`)
    } catch {
      // The failure itself is what matters.
    }
    return false
  }
}
const check = (cond, message) => {
  if (!cond) throw new Error(message)
}

const q = (s) => `'${String(s).replaceAll("'", "''")}'`
const cardId = psql(
  `select id from cards where name = 'P169 Charizard' and language = 'en' limit 1`,
)

// 1 --------------------------------------------------------------------------------------------
await step(1, 'cold dark launch', async () => {
  shell(`pm clear ${PACKAGE}`)
  await sleep(1500)
  shell(`am force-stop ${PACKAGE}`)
  await sleep(1500)
  const launch = amStart()
  await sleep(900)
  const first = decodePng(screencap())
  shot('smoke-01-cold-launch')
  await waitFor((ns) => byId(ns, 'login-email') || byId(ns, 'login-screen'), {
    timeoutMs: 30000,
    label: 'login screen',
  })
  const login = decodePng(screencap())
  const lum = login.bandLuminance(0, login.h)
  check(lum !== null && lum <= 0.25, `the login screen is not dark: ${String(lum)}`)
  return {
    totalTimeMs: launch.totalTimeMs,
    lumFirstFrame: first.bandLuminance(0, first.h),
    lumLogin: lum,
  }
})
// 2 --------------------------------------------------------------------------------------------
await step(2, 'sign in', async () => {
  const r = await signIn(B)
  await waitForNode('collection-list', { label: 'collection list' })
  return { firstPageVisibleMs: r.firstPageVisibleMs }
})
// 3 --------------------------------------------------------------------------------------------
await step(3, 'scanner entry', async () => {
  await openPhotoScreen()
  const nodes = dump()
  const buttons = ['p169-photo-library', 'p169-photo-camera'].filter((id) => findNode(nodes, id))
  check(buttons.length === 2, `photo entry buttons: ${buttons.join(',')}`)
  return { buttons }
})
// 4 --------------------------------------------------------------------------------------------
let ui = null
let scanMs = null
await step(4, 'real synthetic image -> on-device recognition', async () => {
  await pushImage(join(fixtureDir, 'f17-p169-charizard.jpg'), 'smoke')
  const started = Date.now()
  await pickNewest()
  ui = await waitRecognition(90000)
  scanMs = Date.now() - started
  shot('smoke-04-recognition')
  check(ui.kind === 'result', `recognition outcome: ${ui.kind}`)
  return { kind: ui.kind, badge: ui.badge, pickToResultMs: scanMs }
})
// 5 --------------------------------------------------------------------------------------------
await step(5, 'candidate', async () => {
  const candidate = ui.candidates.find((c) => /^P169 Charizard, P169 Base Set, 004$/.test(c.label))
  check(candidate !== undefined, `candidates: ${ui.candidates.map((c) => c.label).join(' | ')}`)
  const before = counts()
  tapNode(ui.nodes.find((n) => n.id.endsWith(`p169-recognition-candidate-${candidate.id}`)))
  await waitForNode('p169-card-identity', { timeoutMs: 30000, label: 'card identity' }).catch(() =>
    waitForNode('p169-card', { timeoutMs: 5000, label: 'card screen' }),
  )
  check(JSON.stringify(diff(before, counts())) === '{}', 'writes on confirming a card')
  return { candidate: candidate.label }
})
// 6 --------------------------------------------------------------------------------------------
await step(6, 'Price Check (read-only)', async () => {
  const before = counts()
  const printing = await choosePrinting(cardId, 'holo')
  await sleep(500)
  const texts = priceTexts()
  shot('smoke-06-price-check')
  check(texts.length > 0, 'no raw price is shown')
  check(counts().join('|') === before.join('|'), 'the ledger changed during Price Check')
  return { printing: printing.finish, prices: texts }
})
// 7 --------------------------------------------------------------------------------------------
let beforeForm = null
await step(7, 'Add to Collection (form opens, nothing written)', async () => {
  beforeForm = counts()
  await tapUntil('p169-add-to-collection', 'p170-add-intent', { label: 'Add to Collection' })
  await tapUntil('p175-go-add-acquisition', 'p175-add-acquisition', { label: 'add acquisition' })
  await clearAndType('p175-unit-cost', '25.00')
  await clearAndType('p175-quantity', '3')
  check(counts().join('|') === beforeForm.join('|'), 'rows were written before the confirm')
  return { countsUnchanged: true }
})
// 8 --------------------------------------------------------------------------------------------
await step(8, 'cancel before the write', async () => {
  for (
    let i = 0;
    i < 4 && !findNode(dump(), 'price-check-home') && !findNode(dump(), 'collection-list');
    i += 1
  ) {
    back()
    await sleep(800)
  }
  check(counts().join('|') === beforeForm.join('|'), 'rows exist after cancelling')
  return { cancelled: true, countsUnchanged: true }
})
// 9 --------------------------------------------------------------------------------------------
await step(9, 'Collection', async () => {
  await tapTestId('tab-collection', { scroll: false })
  const r = await waitForNode('collection-list', { timeoutMs: 20000, label: 'collection list' })
  shot('smoke-09-collection')
  return { listShown: !!r }
})

// ---- logcat ------------------------------------------------------------------------------------
const log = adb(['logcat', '-d', '-v', 'time'], { allowFail: true })
const crash = adb(['logcat', '-b', 'crash', '-d'], { allowFail: true })
const counters = {
  fatal: (log.match(/FATAL EXCEPTION/g) ?? []).length,
  anr: (log.match(/ANR in /g) ?? []).length,
  oom: (log.match(/OutOfMemoryError/g) ?? []).length,
  nativeCrash: (log.match(/\*\*\* \*\*\* \*\*\*|signal 11|SIGSEGV|Fatal signal/g) ?? []).length,
  noClassDef: (log.match(/NoClassDefFoundError|ClassNotFoundException|NoSuchMethodError/g) ?? [])
    .length,
  ortOrMlKit: (log.match(/onnxruntime.*(Exception|Error)|mlkit.*(Exception|Error)/gi) ?? []).length,
  crashBuffer: crash.trim().length,
}
saveJson('smoke-logcat.json', counters)
const failed = report.filter((r) => r.status !== 'PASS').length
const clean = Object.values(counters).every((v) => v === 0)
saveJson('smoke-report.json', { report, counters })
console.log(
  `\nSMOKE STEPS ${String(report.length)}  PASS ${String(report.length - failed)}  FAIL ${String(failed)}  LOGCAT_CLEAN ${String(clean)}`,
)
console.log(JSON.stringify(counters))
process.exit(failed === 0 && clean ? 0 : 1)

#!/usr/bin/env node
/**
 * P184 lifecycle / safety driver: the scanner on the INSTALLED release build (proof build) under
 * pathological files, overlapping captures, navigation, backgrounding, identity change and Activity
 * recreation. LOCAL ONLY, synthetic users only.
 *
 *   node scripts/p184/lifecycle-check.mjs           (P184_STEPS=<regex> runs a subset)
 *
 * Preconditions: stack started + seeded, capture proxy running on 55781, the APK from
 * scripts/p184/build-apk.mjs installed on the P184 emulator, .p184-scratch/pathological generated.
 * Each step is PASS, FAIL or NOT_RUN with the observed facts; a failing step never hides the others.
 * Output: .build/p184-evidence/lifecycle-report.json + PNGs.
 */
import './env.mjs'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  amStart,
  appPid,
  crashCount,
  localActivityId,
  activityAfterChange,
  rootAvailable,
  focusedWindow,
} from '../android-p167-lib.mjs'
import {
  appRoot,
  byId,
  clearLog,
  dump,
  ensureSignedIn,
  fixtureDir,
  nextScanTrace,
  pickNewest,
  proxy,
  pushImage,
  scrollPhotoScreenToTop,
  saveJson,
  scanFixture,
  scanTraces,
  sessionTraces,
  shell,
  shot,
  sleep,
  stripNodes,
  tap,
  traces,
  users,
  waitFor,
  waitRecognition,
} from './lib.mjs'
import { tapScrolling, findScrolling } from './flows.mjs'

const only = process.env.P184_STEPS ? new RegExp(process.env.P184_STEPS, 'i') : null
const report = []

async function step(name, fn) {
  if (only && !only.test(name)) return
  const t0 = Date.now()
  try {
    const detail = await fn()
    report.push({ step: name, status: 'PASS', ms: Date.now() - t0, detail })
    console.log(`PASS ${name}  ${JSON.stringify(detail ?? null).slice(0, 700)}`)
  } catch (e) {
    report.push({
      step: name,
      status: 'FAIL',
      ms: Date.now() - t0,
      detail: String(e.message ?? e).slice(0, 700),
    })
    console.log(`FAIL ${name}  ${String(e.message ?? e).slice(0, 500)}`)
    try {
      shot(`fail-${name.replace(/[^a-z0-9]+/gi, '-').slice(0, 50)}`)
    } catch {
      // A missing screenshot never hides the failure itself.
    }
  }
}
const note = (name, status, detail) => {
  report.push({ step: name, status, detail })
  console.log(`${status} ${name}  ${JSON.stringify(detail ?? null).slice(0, 500)}`)
}
const fx = (id) => join(fixtureDir, `${id}.jpg`)
const has = (ids) => (nodes) => ids.some((id) => byId(nodes, id))
const candidateNames = (ui) => ui.candidates.map((c) => c.label.split(',')[0])

async function goPhotoScreen() {
  const { openPhotoScreen } = await import('../android-p167-lib.mjs')
  await scrollPhotoScreenToTop()
  await openPhotoScreen()
}

async function holdNextScan() {
  await goPhotoScreen()
  await tapScrolling('p184-proof-delay')
  const status = byId(dump(), 'p184-proof-status')?.text ?? ''
  if (!/delay=20000/.test(status)) throw new Error(`the delay was not armed: ${status}`)
}

async function statusText() {
  return byId(dump(), 'p184-proof-status')?.text ?? null
}

async function waitStatus(re, timeoutMs = 240000) {
  const r = await waitFor(
    (ns) => {
      const t = byId(ns, 'p184-proof-status')?.text ?? ''
      return re.test(t) ? t : null
    },
    { timeoutMs, label: `status ${String(re)}` },
  )
  return r.value
}

async function waitForTrace(count, timeoutMs = 45000) {
  const t0 = Date.now()
  while (scanTraces().length <= count && Date.now() - t0 < timeoutMs) await sleep(1000)
  return scanTraces().slice(count)
}

const crashesAtStart = () => crashCount()

amStart()
await ensureSignedIn(users.b)
const crashes0 = crashesAtStart()
const pid0 = appPid()
clearLog()

// ------------------------------------------------------------------------------------------------
// 1. Pathological images (through the real picker, real pipeline)
// ------------------------------------------------------------------------------------------------
const pathDir = join(appRoot, '..', '..', '.p184-scratch', 'pathological')
if (existsSync(pathDir)) {
  for (const file of readdirSync(pathDir)
    .filter((f) => /^p\d\d-/.test(f))
    .sort()) {
    await step(`pathological ${file}`, async () => {
      const before = scanTraces().length
      const pidBefore = appPid()
      const t0 = Date.now()
      await pushImage(join(pathDir, file), file.slice(0, 3))
      let state
      try {
        await pickNewest()
        state = 'picked'
      } catch {
        const n = dump()
        state = byId(n, 'p169-photo-unavailable')
          ? 'picker-refused'
          : byId(n, 'p169-photo-cancelled')
            ? 'picker-cancelled'
            : 'unknown'
      }
      let ui = null
      let trace = null
      if (state === 'picked') {
        ui = stripNodes(await waitRecognition(60000))
        trace = await nextScanTrace(before, { timeoutMs: 20000 })
      }
      const ms = Date.now() - t0
      if (appPid() !== pidBefore) throw new Error('the app process changed (crash or kill)')
      return {
        state,
        ui: ui && { kind: ui.kind, heading: ui.heading },
        outcome: trace?.outcome ?? null,
        stoppedAt: trace?.stoppedAt ?? null,
        stages: trace
          ? {
              decodeMs: trace.stages.decodeMs,
              ocrMs: trace.stages.ocrMs,
              onnxMs: trace.stages.onnxMs,
              totalMs: trace.stages.totalMs,
            }
          : null,
        pickToOutcomeMs: ms,
      }
    })
  }
} else note('pathological', 'NOT_RUN', 'run scripts/p184/generate-pathological.mjs first')

// ------------------------------------------------------------------------------------------------
// 2. Latest capture wins (device)
// ------------------------------------------------------------------------------------------------
await step('latest-capture-wins: photo A held 20 s, photo B chosen meanwhile', async () => {
  clearLog()
  await goPhotoScreen()
  const retake = byId(dump(), 'p169-recognition-retake')
  if (retake) tap(retake)
  await holdNextScan()
  const tA = Date.now()
  await pushImage(fx('f13-ocr-vs-visual'), 'lcwA')
  await pickNewest() // A starts, its OCR is held
  const aStarted = Date.now() - tA
  await pushImage(fx('f01-clean'), 'lcwB')
  await pickNewest() // B replaces A
  const ui = await waitRecognition(60000)
  const seenAtB = candidateNames(ui)
  const bDoneAfterMs = Date.now() - tA
  // A's held OCR ends ~20 s after A started; give it time and keep looking at the screen.
  const flashes = []
  while (Date.now() - tA < 30000) {
    const names = byIdPrefixNames()
    if (names.some((n) => n === 'Voltmoth')) flashes.push(Date.now() - tA)
    await sleep(500)
  }
  await sleep(3000)
  const final = await waitRecognition(20000)
  const all = scanTraces()
  const aTrace = all.find(
    (t) =>
      t.ocr?.name === 'Voltmoth' || t.stoppedAt?.startsWith('after_') || t.outcome === 'cancelled',
  )
  const cancelled = all.filter((t) => t.outcome === 'cancelled')
  const analysed = all.filter((t) => t.outcome === 'analysed')
  if (!seenAtB.includes('Sparkfin'))
    throw new Error(`B's card was not shown first: ${seenAtB.join('|')}`)
  if (flashes.length > 0)
    throw new Error(`A's card (Voltmoth) appeared on screen at ${flashes.join(',')} ms`)
  if (candidateNames(final).includes('Voltmoth'))
    throw new Error("A's card is on screen at the end")
  if (cancelled.length < 1) throw new Error('A was not reported as cancelled')
  return {
    aStartedAfterMs: aStarted,
    bFirstResultAfterMs: bDoneAfterMs,
    shownAtB: seenAtB,
    shownAtEnd: candidateNames(final),
    flashesOfA: flashes.length,
    traces: all.map((t) => ({ outcome: t.outcome, stoppedAt: t.stoppedAt, ocr: t.ocr?.name })),
    cancelled: cancelled.length,
    analysed: analysed.length,
    aTraceStoppedAt: aTrace?.stoppedAt ?? null,
  }
})

function byIdPrefixNames() {
  return dump()
    .filter((n) => n.id.includes('p169-recognition-candidate-'))
    .map((n) => (n.desc || n.text).split(',')[0])
}

await step('latest-capture-wins: burst of 8 overlapping analyses of one photo', async () => {
  await goPhotoScreen()
  await tapScrolling('p184-proof-burst-8')
  const status = await waitStatus(/burst8 DONE/)
  const m = /analysed=(\d+) cancelled=(\d+) abstain=(\d+) failed=(\d+)/.exec(status)
  const [analysed, cancelled, abstain, failed] = m.slice(1).map(Number)
  if (analysed !== 1 || cancelled !== 7 || abstain !== 0 || failed !== 0)
    throw new Error(`unexpected burst tally: ${status}`)
  return { status }
})

// ------------------------------------------------------------------------------------------------
// 3. Navigation cancellation
// ------------------------------------------------------------------------------------------------
await step(
  'navigation: leave the scanner while a scan is held, no result, no leak into the next entry',
  async () => {
    clearLog()
    await goPhotoScreen()
    const retake = byId(dump(), 'p169-recognition-retake')
    if (retake) tap(retake)
    await holdNextScan()
    const t0 = Date.now()
    await pushImage(fx('f01-clean'), 'nav')
    await pickNewest()
    tap((await waitFor((ns) => byId(ns, 'tab-collection'), { label: 'collection tab' })).value)
    await waitFor((ns) => byId(ns, 'collection-list'), { label: 'collection list' })
    await sleep(Math.max(0, 50000 - (Date.now() - t0)))
    const all = scanTraces()
    const trace = all[all.length - 1]
    await goPhotoScreen()
    const n = dump()
    const leaked = [
      'p169-photo-ready',
      'p169-recognition-result',
      'p169-recognition-no-match',
      'p169-recognition-abstain',
    ].filter((id) => byId(n, id))
    if (leaked.length > 0) throw new Error(`state leaked into the next entry: ${leaked.join(',')}`)
    if (trace?.outcome !== 'cancelled')
      throw new Error(`the scan was not cancelled: ${trace?.outcome}`)
    if (trace.stages.onnxMs !== undefined || trace.stages.retrievalMs !== undefined)
      throw new Error('expensive stages ran after leaving the screen')
    return { outcome: trace.outcome, stoppedAt: trace.stoppedAt, stages: trace.stages, leaked }
  },
)

// ------------------------------------------------------------------------------------------------
// 4. Background cancellation
// ------------------------------------------------------------------------------------------------
await step(
  'background: HOME while a scan is held: cancelled, no inference, resume analyses once',
  async () => {
    clearLog()
    await goPhotoScreen()
    await holdNextScan()
    const t0 = Date.now()
    await pushImage(fx('f01-clean'), 'bg')
    await pickNewest()
    const pid = appPid()
    shell('input keyevent 3') // HOME
    await sleep(2000)
    const cpu0 = procCpuTicks(pid)
    await sleep(Math.max(0, 50000 - (Date.now() - t0)))
    const cpu1 = procCpuTicks(pid)
    const during = scanTraces()
    amStart()
    await waitFor((ns) => byId(ns, 'p169-photo-library'), {
      label: 'photo screen after resume',
      timeoutMs: 30000,
    })
    const ui = await waitRecognition(60000)
    const after = scanTraces()
    const resumed = after.filter((t) => t.outcome === 'analysed')
    const backgroundTrace = after.find((t) => t.outcome === 'cancelled')
    if (backgroundTrace?.outcome !== 'cancelled')
      throw new Error(`the background scan was not cancelled: ${backgroundTrace?.outcome}`)
    if (backgroundTrace.stages.onnxMs !== undefined)
      throw new Error('ONNX inference ran for a cancelled background scan')
    if (resumed.length !== 1)
      throw new Error(`expected exactly one analysis after resume, found ${resumed.length}`)
    return {
      cancelledAt: backgroundTrace.stoppedAt,
      backgroundCpuTicks: cpu1 !== null && cpu0 !== null ? cpu1 - cpu0 : null,
      resumedAnalyses: resumed.length,
      shown: candidateNames(ui),
      traces: after.map((t) => `${t.outcome}@${t.stoppedAt}`),
    }
  },
)

function procCpuTicks(pid) {
  const line = shell(`cat /proc/${pid}/stat`, { allowFail: true }).trim()
  const f = line.split(' ')
  if (f.length < 15) return null
  return Number(f[13]) + Number(f[14]) // utime + stime, in clock ticks (100 Hz)
}

// ------------------------------------------------------------------------------------------------
// 4b. Same-user token refresh in the middle of a scan (explicit contract: the scan is preserved)
// ------------------------------------------------------------------------------------------------
function setDeviceClockUtc(epochMs) {
  const d = new Date(epochMs)
  const p = (n) => String(n).padStart(2, '0')
  shell(`settings put global auto_time 0`)
  shell(
    `date -u ${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${d.getUTCFullYear()}.${p(d.getUTCSeconds())}`,
  )
}
function restoreDeviceClock() {
  setDeviceClockUtc(Date.now())
  shell(`settings put global auto_time 1`)
}

await step(
  'same-user refresh: the access token is refreshed while a scan is held; the same scan still publishes',
  async () => {
    if (!rootAvailable()) throw new Error('adb root is not available')
    clearLog()
    await proxy('reset', 'POST')
    await goPhotoScreen()
    const retake = byId(dump(), 'p169-recognition-retake')
    if (retake) tap(retake)
    await holdNextScan()
    await pushImage(fx('f01-clean'), 'refresh')
    await pickNewest()
    const t0 = Date.now()
    try {
      // The client refreshes when its clock says the token is (nearly) expired: jump it forward.
      setDeviceClockUtc(Date.now() + 65 * 60 * 1000)
      let refreshed = 0
      while (Date.now() - t0 < 24000) {
        refreshed = (await proxy('log')).requests.filter((r) =>
          r.path.includes('grant_type=refresh_token'),
        ).length
        if (refreshed > 0) break
        await sleep(700)
      }
      const ui = await waitRecognition(60000)
      const all = scanTraces()
      const cancelled = all.filter((t) => t.outcome === 'cancelled')
      if (refreshed === 0) throw new Error('no token refresh happened during the scan')
      if (cancelled.length > 0) throw new Error('the token refresh cancelled the scan')
      if (!candidateNames(ui).includes('Sparkfin'))
        throw new Error(`the scan did not publish: ${candidateNames(ui).join('|')}`)
      return {
        refreshRequests: refreshed,
        published: candidateNames(ui),
        traces: all.map((t) => t.outcome),
      }
    } finally {
      restoreDeviceClock()
    }
  },
)

// ------------------------------------------------------------------------------------------------
// 5. Identity adversarial
// ------------------------------------------------------------------------------------------------
async function signOut() {
  tap((await waitFor((ns) => byId(ns, 'tab-profile'), { label: 'profile tab' })).value)
  const { node } = await findScrolling('sign-out')
  tap(node)
  await waitFor((ns) => byId(ns, 'login-email') || byId(ns, 'login-screen'), {
    timeoutMs: 30000,
    label: 'login after sign-out',
  })
}

await step(
  'identity: scan started as B, signed out and A signs in: B result never appears',
  async () => {
    clearLog()
    await goPhotoScreen()
    await holdNextScan()
    const t0 = Date.now()
    await pushImage(fx('f01-clean'), 'idAB')
    await pickNewest()
    await signOut()
    await ensureSignedIn(users.a)
    await goPhotoScreen()
    await sleep(Math.max(0, 50000 - (Date.now() - t0)))
    const n = dump()
    const leaked = [
      'p169-photo-ready',
      'p169-recognition-result',
      'p169-recognition-no-match',
    ].filter((id) => byId(n, id))
    const all = scanTraces()
    const last = all[all.length - 1]
    if (leaked.length > 0) throw new Error(`B's scan state is visible to A: ${leaked.join(',')}`)
    if (last?.outcome !== 'cancelled')
      throw new Error(`the scan was not cancelled by the identity change: ${last?.outcome}`)
    return { leaked, outcome: last.outcome, stoppedAt: last.stoppedAt }
  },
)

await step('identity: A -> B -> A with the old scan still pending stays invalid', async () => {
  clearLog()
  await goPhotoScreen()
  await holdNextScan()
  const t0 = Date.now()
  await pushImage(fx('f01-clean'), 'idABA')
  await pickNewest() // as A
  await signOut()
  await ensureSignedIn(users.b)
  await signOut()
  await ensureSignedIn(users.a)
  await goPhotoScreen()
  await sleep(Math.max(0, 65000 - (Date.now() - t0)))
  const n = dump()
  const leaked = [
    'p169-photo-ready',
    'p169-recognition-result',
    'p169-recognition-no-match',
  ].filter((id) => byId(n, id))
  const last = scanTraces().pop()
  if (leaked.length > 0)
    throw new Error(`the old scan reappeared after A -> B -> A: ${leaked.join(',')}`)
  if (last?.outcome !== 'cancelled') throw new Error(`old scan not cancelled: ${last?.outcome}`)
  return { leaked, outcome: last.outcome }
})

// ------------------------------------------------------------------------------------------------
// 6. Activity recreation (font scale, density, locale) around the scanner
// ------------------------------------------------------------------------------------------------
const CHANGES = [
  {
    name: 'font scale 1.3',
    apply: () => shell('settings put system font_scale 1.3'),
    revert: () => shell('settings put system font_scale 1.0'),
  },
  {
    name: 'display density 480',
    apply: () => shell('wm density 480'),
    revert: () => shell('wm density reset'),
  },
  {
    name: 'app locale nb-NO',
    apply: () =>
      shell(`cmd locale set-app-locales invalid.pokeportfolio.spike.p184 --locales nb-NO`),
    revert: () =>
      shell(`cmd locale set-app-locales invalid.pokeportfolio.spike.p184 --locales ""`, {
        allowFail: true,
      }),
  },
]
if (rootAvailable()) {
  await ensureSignedIn(users.b)
  for (const change of CHANGES) {
    await step(
      `recreation ${change.name} A: before the picker, Photo Picker still launches`,
      async () => {
        await goPhotoScreen()
        const before = localActivityId()
        change.apply()
        const after = await activityAfterChange(before)
        await sleep(1500)
        await ensureSignedIn(users.b)
        await goPhotoScreen()
        const sessions = sessionTraces().filter((s) => s.action === 'created').length
        await pushImage(fx('f01-clean'), 'recA')
        await pickNewest()
        const ui = await waitRecognition(60000)
        change.revert()
        await sleep(2500)
        return {
          activityBefore: before,
          activityAfter: after,
          recreated: before !== after,
          pid: appPid() === pid0,
          modelSessionsCreated: sessionTraces().filter((s) => s.action === 'created').length,
          sessionsBefore: sessions,
          shown: candidateNames(ui),
        }
      },
    )
    await step(
      `recreation ${change.name} B: after the image is selected and analysed`,
      async () => {
        await goPhotoScreen()
        const before = localActivityId()
        const scansBefore = scanTraces().length
        change.apply()
        const after = await activityAfterChange(before)
        await sleep(2500)
        await goPhotoScreen()
        const state = {
          photoReady: !!byId(dump(), 'p169-photo-ready'),
          result: !!byId(dump(), 'p169-recognition-result'),
        }
        const scansAfter = scanTraces().length
        change.revert()
        await sleep(2500)
        return {
          recreated: before !== after,
          ...state,
          duplicateAnalyses: scansAfter - scansBefore,
        }
      },
    )
    await step(`recreation ${change.name} C: during a held recognition`, async () => {
      await goPhotoScreen()
      const retake = byId(dump(), 'p169-recognition-retake')
      if (retake) tap(retake)
      await holdNextScan()
      const scansBefore = scanTraces().length
      await pushImage(fx('f01-clean'), 'recC')
      await pickNewest()
      const before = localActivityId()
      change.apply()
      const after = await activityAfterChange(before)
      await ensureSignedIn(users.b)
      await goPhotoScreen()
      const ui = await waitRecognition(90000).catch((e) => ({
        kind: `no-outcome: ${String(e.message).slice(0, 80)}`,
        candidates: [],
      }))
      const scansAfter = scanTraces().slice(scansBefore)
      change.revert()
      await sleep(2500)
      return {
        recreated: before !== after,
        finalUi: ui.kind,
        analyses: scansAfter.filter((t) => t.outcome === 'analysed').length,
        cancelled: scansAfter.filter((t) => t.outcome === 'cancelled').length,
        modelSessions: sessionTraces().filter((s) => s.action === 'created').length,
        sameProcess: appPid() === pid0,
      }
    })
  }
} else note('recreation', 'NOT_RUN', 'adb root is not available on this image')

// ------------------------------------------------------------------------------------------------
const crashesEnd = crashCount()
const sessions = sessionTraces()
const audit = await proxy('audit')
note('crash sweep', crashesEnd === crashes0 ? 'PASS' : 'FAIL', {
  fatalBefore: crashes0,
  fatalAfter: crashesEnd,
  samePid: appPid() === pid0,
})
note(
  'model sessions',
  sessions.filter((s) => s.action === 'created').length <= 1 ? 'PASS' : 'FAIL',
  {
    created: sessions.filter((s) => s.action === 'created').length,
    all: sessions.map((s) => s.action),
  },
)
note('image egress', audit.imageMarkers === 0 ? 'PASS' : 'FAIL', audit)
saveJson('lifecycle-report.json', { report, audit })
const failed = report.filter((r) => r.status === 'FAIL').length
console.log(
  `\nSTEPS ${String(report.length)}  PASS ${String(report.filter((r) => r.status === 'PASS').length)}  FAIL ${String(failed)}  NOT_RUN ${String(report.filter((r) => r.status === 'NOT_RUN').length)}`,
)
process.exit(failed > 0 ? 1 : 0)

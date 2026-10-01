#!/usr/bin/env node
/**
 * P186 scanner latency and memory benchmark on the emulator (LOCAL ONLY, proof build, synthetic
 * fixtures). Same stages and definitions as P184/P185 so figures stay comparable:
 *
 *   cold    N times: force-stop -> cold launch (`am start -W`) -> signed in -> scanner screen ->
 *           choose a photo through the REAL system picker -> result. Reported per entry:
 *           launch ms, entry->photo-ready ms (the time a prewarm has), the scan's own total
 *           (recognize() -> outcome: the "photo -> result" wait), and the part of it spent waiting
 *           for the model session (`sessionMs`; ~0 once the session is warm).
 *   warm    the proof panel's "analyse 100 times" on the photo on screen, polled quietly.
 *   memory  PSS at: app baseline, scanner entered, model loaded (result shown), left immediately,
 *           left + idle window. One extra cycle, only when --memory is given.
 *
 *   node scripts/p186/latency-memory.mjs --label baseline [--cold 10] [--warm 100] [--memory]
 *        [--idle-seconds 200] [--install <apk>]
 *
 * Output: .build/p186-evidence/latency-<label>.json. Run on a quiet machine: a Gradle build, the
 * database suite or an IDE on the same host competes with the emulator for the CPU and inflates
 * every figure (P185 measured exactly that).
 */
import './env.mjs'
import { join } from 'node:path'
import { amStart, appPid, openPhotoScreen, pssKb } from '../android-p167-lib.mjs'
import {
  PACKAGE,
  adb,
  byId,
  clearLog,
  dump,
  ensureSignedIn,
  fixtureDir,
  nextScanTrace,
  pickNewest,
  pushImage,
  saveJson,
  scanMark,
  scansSince,
  sessionTraces,
  shell,
  sleep,
  users,
  waitRecognition,
} from '../p185/lib.mjs'
import { back, tapTestId } from '../p185/driver.mjs'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback)
}
const label = arg('label', 'run')
const coldRuns = Number(arg('cold', 10))
const warmRuns = Number(arg('warm', 100))
const idleSeconds = Number(arg('idle-seconds', 200))
const memory = process.argv.includes('--memory')
const apk = arg('install', null)

const pct = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]
const summary = (values) => {
  const s = [...values].sort((a, b) => a - b)
  if (s.length === 0) return { n: 0 }
  return {
    n: s.length,
    min: s[0],
    median: pct(s, 50),
    p90: pct(s, 90),
    p95: pct(s, 95),
    max: s[s.length - 1],
  }
}
const pssMb = () => Math.round(pssKb() / 1024)

/** The "App Summary" rows of `dumpsys meminfo` in MB: where the resident memory actually is. */
function memBreakdownMb() {
  const text = shell(`dumpsys meminfo ${PACKAGE}`)
  const out = {}
  for (const label of [
    'Java Heap',
    'Native Heap',
    'Code',
    'Stack',
    'Graphics',
    'Private Other',
    'System',
    'TOTAL PSS',
  ]) {
    const m = new RegExp(String.raw`${label}:\s+(\d+)`).exec(text)
    if (m !== null) out[label] = Math.round(Number(m[1]) / 1024)
  }
  return out
}

function launchCold() {
  shell(`am force-stop ${PACKAGE}`)
  const out = shell(`am start -W -n ${PACKAGE}/invalid.pokeportfolio.spike.MainActivity`)
  return {
    totalMs: Number(/TotalTime:\s*(\d+)/.exec(out)?.[1] ?? NaN),
    waitMs: Number(/WaitTime:\s*(\d+)/.exec(out)?.[1] ?? NaN),
  }
}

async function enterScanner() {
  const started = Date.now()
  await openPhotoScreen()
  return Date.now() - started
}

async function oneColdEntry(index) {
  clearLog()
  adb(['logcat', '-G', '16M'], { allowFail: true })
  const tLaunch = Date.now()
  const launch = launchCold()
  await ensureSignedIn(users.b)
  const launchToInteractiveMs = Date.now() - tLaunch
  const enterMs = await enterScanner()
  const tEntered = Date.now()
  const mark = scanMark()
  await pushImage(join(fixtureDir, 'f01-clean.jpg'), `lm${String(index)}`)
  await pickNewest()
  const photoReadyAfterEntryMs = Date.now() - tEntered
  await waitRecognition(90000)
  const trace = await nextScanTrace(mark)
  const created = sessionTraces().filter((s) => s.action === 'created')
  return {
    index,
    launchTotalMs: launch.totalMs,
    launchToInteractiveMs,
    enterScannerMs: enterMs,
    entryToPhotoReadyMs: photoReadyAfterEntryMs,
    scanTotalMs: trace.stages.totalMs,
    sessionWaitMs: trace.stages.sessionMs ?? null,
    ocrMs: trace.stages.ocrMs ?? null,
    onnxMs: trace.stages.onnxMs ?? null,
    stages: trace.stages,
    outcome: trace.outcome,
    tier: trace.tier,
    modelCreateMs: created.length > 0 ? created[created.length - 1].ms : null,
    assetsMs: created.length > 0 ? (created[created.length - 1].assetsMs ?? null) : null,
    prewarmMs: sessionTraces().find((x) => x.action === 'prewarm_ready')?.ms ?? null,
    sessionsCreatedThisProcess: created.length,
    sessionsActive: created.length - sessionTraces().filter((s) => s.action === 'released').length,
  }
}

async function warmBenchmark() {
  const mark = scanMark()
  await tapTestId('p184-proof-stress-100', { label: 'analyse 100 times' })
  const start = Date.now()
  for (;;) {
    await sleep(2000)
    const text = byId(dump(), 'p184-proof-status')?.text ?? ''
    if (/stress100 DONE 100[/]100/.test(text)) break
    if (Date.now() - start > 600000) throw new Error('the 100-analysis block did not finish')
  }
  const warm = scansSince(mark).filter((t) => t.outcome === 'analysed')
  return {
    analysed: warm.length,
    failures: scansSince(mark).filter((t) => t.outcome === 'error').length,
    totalMs: summary(warm.map((t) => t.stages.totalMs)),
    first10TotalMs: summary(warm.slice(0, 10).map((t) => t.stages.totalMs)),
  }
}

async function memoryCycle() {
  const phases = {}
  shell(`am force-stop ${PACKAGE}`)
  await sleep(2500)
  clearLog()
  amStart()
  await ensureSignedIn(users.b)
  await sleep(4000)
  phases.appBaselineMb = pssMb()
  phases.appBaselineBreakdown = memBreakdownMb()
  await openPhotoScreen()
  await sleep(6000) // time a prewarm has (the person choosing a photo)
  phases.scannerEnteredMb = pssMb()
  phases.scannerEnteredBreakdown = memBreakdownMb()
  const mark = scanMark()
  await pushImage(join(fixtureDir, 'f01-clean.jpg'), 'mem')
  await pickNewest()
  await waitRecognition(90000)
  await nextScanTrace(mark)
  await sleep(1500)
  phases.modelLoadedResultShownMb = pssMb()
  phases.modelLoadedBreakdown = memBreakdownMb()
  back()
  await sleep(1500)
  back()
  await sleep(1500)
  phases.leftImmediatelyMb = pssMb()
  phases.leftImmediatelyBreakdown = memBreakdownMb()
  phases.sessionTraceTail = sessionTraces()
    .slice(-4)
    .map((s) => `${s.action}:${String(s.sessionCount)}`)
  console.log(`waiting ${String(idleSeconds)} s for the idle window...`)
  await sleep(idleSeconds * 1000)
  phases.leftPlusIdleMb = pssMb()
  phases.leftPlusIdleBreakdown = memBreakdownMb()
  phases.idleSessionTraceTail = sessionTraces()
    .slice(-4)
    .map((s) => `${s.action}:${String(s.sessionCount)}`)
  phases.idleSeconds = idleSeconds
  return phases
}

if (apk !== null) {
  adb(['uninstall', PACKAGE], { allowFail: true })
  adb(['install', '-r', '-g', apk])
}

const report = {
  label,
  package: PACKAGE,
  date: new Date().toISOString(),
  cold: [],
  coldSummary: {},
}
for (let i = 0; i < coldRuns; i += 1) {
  const entry = await oneColdEntry(i)
  console.log(JSON.stringify(entry))
  report.cold.push(entry)
}
report.coldSummary = {
  scanTotalMs: summary(report.cold.map((c) => c.scanTotalMs)),
  firstEntryScanTotalMs: report.cold[0]?.scanTotalMs ?? null,
  sessionWaitMs: summary(report.cold.map((c) => c.sessionWaitMs ?? 0)),
  launchTotalMs: summary(report.cold.map((c) => c.launchTotalMs)),
  entryToPhotoReadyMs: summary(report.cold.map((c) => c.entryToPhotoReadyMs)),
}
if (warmRuns > 0) {
  // The proof panel acts on the photo that is on screen: keep the last cold entry's photo.
  report.warm = await warmBenchmark()
  report.pssAfterWarmMb = pssMb()
  report.pid = appPid()
}
if (memory) report.memory = await memoryCycle()
saveJson(`latency-${label}.json`, report)
console.log(
  JSON.stringify(
    { coldSummary: report.coldSummary, warm: report.warm, memory: report.memory },
    null,
    1,
  ),
)

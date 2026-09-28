#!/usr/bin/env node
/**
 * P184 performance and memory gate on the installed release build (proof build; the trace and the
 * repeat-analysis panel only exist in that build). LOCAL ONLY.
 *
 *   node scripts/p184/perf-check.mjs
 *
 *   COLD      3 fresh processes (force-stop, launch, open the scanner, first photo): OCR init, model
 *             + index load, first-scan total, per stage.
 *   WARM      100 analyses of one photo through the same port the screen uses (4 x "analyse 25
 *             times"): median / p90 / p95 / p99 of the total and of each stage, failures, cancels.
 *   MEMORY    PSS (and native / Java heap, RSS, thread count) at: baseline, scanner open, after the
 *             first scan (model loaded), after 1 / 25 / 50 / 75 / 100 analyses, right after leaving
 *             the scanner, and after a settle period. A monotonic climb would be a leak; a plateau
 *             after the model is cached is the documented retained cost.
 *
 * Output: .build/p184-evidence/perf-report.json
 */
import './env.mjs'
import { join } from 'node:path'
import { amStart, appPid } from '../android-p167-lib.mjs'
import {
  byId,
  clearLog,
  dump,
  ensureSignedIn,
  fixtureDir,
  nextScanTrace,
  pickNewest,
  pushImage,
  saveJson,
  scanTraces,
  sessionTraces,
  shell,
  sleep,
  tap,
  users,
  waitFor,
  waitRecognition,
  PACKAGE,
} from './lib.mjs'
import { tapScrolling } from './flows.mjs'
import { openPhotoScreen } from '../android-p167-lib.mjs'

const pct = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]
const summarize = (values) => {
  const s = [...values].sort((a, b) => a - b)
  return s.length === 0
    ? null
    : {
        n: s.length,
        min: s[0],
        median: pct(s, 50),
        p90: pct(s, 90),
        p95: pct(s, 95),
        p99: pct(s, 99),
        max: s[s.length - 1],
        mean: Math.round((s.reduce((a, b) => a + b, 0) / s.length) * 10) / 10,
      }
}

function mem() {
  const pid = appPid()
  const out = shell(`dumpsys meminfo ${PACKAGE}`)
  const num = (re) => {
    const m = re.exec(out)
    return m ? Number(m[1]) : null
  }
  const status = shell(`cat /proc/${pid}/status`, { allowFail: true })
  return {
    pssKb: num(/TOTAL PSS:\s+(\d+)/) ?? num(/TOTAL\s+(\d+)/),
    nativeHeapPssKb: num(/Native Heap:\s+(\d+)/),
    javaHeapPssKb: num(/Java Heap:\s+(\d+)/),
    graphicsKb: num(/Graphics:\s+(\d+)/),
    rssKb: Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? NaN),
    threads: Number(/Threads:\s+(\d+)/.exec(status)?.[1] ?? NaN),
    pid,
  }
}

const cold = []
for (let run = 1; run <= 3; run += 1) {
  shell(`am force-stop ${PACKAGE}`)
  await sleep(2500)
  clearLog()
  const launch = amStart()
  await ensureSignedIn(users.b)
  await openPhotoScreen()
  const before = scanTraces().length
  await pushImage(join(fixtureDir, 'f01-clean.jpg'), `cold${run}`)
  await pickNewest()
  await waitRecognition(90000)
  const trace = await nextScanTrace(before)
  const session = sessionTraces().find((s) => s.action === 'created')
  cold.push({
    run,
    launchTotalTimeMs: launch.totalTimeMs,
    ocrMs: trace.stages.ocrMs,
    sessionWaitMs: trace.stages.sessionMs,
    modelSessionCreateMs: session?.ms ?? null,
    decodeMs: trace.stages.decodeMs,
    preprocessMs: trace.stages.preprocessMs,
    onnxMs: trace.stages.onnxMs,
    searchMs: trace.stages.searchMs,
    retrievalMs: trace.stages.retrievalMs,
    totalMs: trace.stages.totalMs,
  })
  console.log(
    `cold ${run}: total ${trace.stages.totalMs} ms (ocr ${trace.stages.ocrMs}, model wait ${trace.stages.sessionMs}, session create ${session?.ms})`,
  )
}

// ---- memory + warm ------------------------------------------------------------------------
shell(`am force-stop ${PACKAGE}`)
await sleep(2500)
clearLog()
amStart()
await ensureSignedIn(users.b)
await sleep(6000)
const samples = { baseline: mem() }
await openPhotoScreen()
await sleep(2000)
samples.scannerOpen = mem()
const beforeFirst = scanTraces().length
await pushImage(join(fixtureDir, 'f01-clean.jpg'), 'mem1')
await pickNewest()
await waitRecognition(90000)
await nextScanTrace(beforeFirst)
await sleep(2500)
samples.afterFirstScan = mem()

const warmStart = scanTraces().length
for (let block = 1; block <= 4; block += 1) {
  await tapScrolling('p184-proof-stress-25')
  await waitFor(
    (ns) => {
      const t = byId(ns, 'p184-proof-status')?.text ?? ''
      return new RegExp(`stress25 DONE 25/25`).test(t) && t
    },
    { timeoutMs: 300000, label: `stress block ${block}` },
  )
  await sleep(1500)
  samples[`after${block * 25}`] = mem()
  console.log(`after ${block * 25}: PSS ${samples[`after${block * 25}`].pssKb} kB`)
}
const warm = scanTraces().slice(warmStart)
const analysed = warm.filter((t) => t.outcome === 'analysed')
const stages = {}
for (const key of [
  'readMs',
  'headerMs',
  'decodeMs',
  'blurMs',
  'ocrMs',
  'sessionMs',
  'preprocessMs',
  'onnxMs',
  'searchMs',
  'retrievalMs',
  'fusionMs',
  'totalMs',
]) {
  stages[key] = summarize(analysed.map((t) => t.stages[key]).filter((v) => typeof v === 'number'))
}

tap((await waitFor((ns) => byId(ns, 'tab-collection'), { label: 'collection tab' })).value)
await waitFor((ns) => byId(ns, 'collection-list'), { label: 'collection list' })
await sleep(1500)
samples.afterLeavingScanner = mem()
await sleep(60000)
samples.afterSettle60s = mem()
shell(`am send-trim-memory ${PACKAGE} RUNNING_MODERATE`, { allowFail: true })
await sleep(8000)
samples.afterTrimMemory = mem()

const series = ['after25', 'after50', 'after75', 'after100'].map((k) => samples[k].pssKb)
const growth = series[3] - series[0]
const report = {
  cold,
  warm: {
    scans: warm.length,
    analysed: analysed.length,
    cancelled: warm.filter((t) => t.outcome === 'cancelled').length,
    failures: warm.filter((t) => t.outcome === 'error').length,
    abstain: warm.filter((t) => t.outcome === 'abstain_quality').length,
    total: stages.totalMs,
    stages,
  },
  memory: samples,
  pssGrowthBetween25And100Kb: growth,
  pssSeries25to100: series,
  sessionsCreated: sessionTraces().filter((s) => s.action === 'created').length,
}
saveJson('perf-report.json', report)
console.log(
  JSON.stringify(
    {
      cold: cold.map((c) => c.totalMs),
      warmTotal: stages.totalMs,
      growth,
      series,
      sessions: report.sessionsCreated,
    },
    null,
    1,
  ),
)

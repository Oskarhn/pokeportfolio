#!/usr/bin/env node
/**
 * P185 bounded scanner performance regression (the full 100-scan benchmark is P184's and only
 * repeats when scanner runtime code changes; P185 changed UI, accessibility and test drivers).
 * LOCAL ONLY, proof build.
 *
 *   node scripts/p185/perf-regression.mjs
 *
 * Same method as P184's warm benchmark so the figures are comparable: after one cold first scan
 * through the real picker, the proof panel's "analyse 25 times" runs back-to-back analyses of one
 * photo inside the app, polled only every 2 s (a driver that dumps the accessibility tree and
 * swipes during an analysis competes with it for the CPU: the picker-driven figures below show how
 * much). Reported: the first 10 and all 25 warm analyses, vs P184's recorded warm median 1044 ms and
 * p95 1257 ms. Output: .build/p185-evidence/perf-regression.json
 */
import './env.mjs'
import { join } from 'node:path'
import { amStart, appPid, openPhotoScreen } from '../android-p167-lib.mjs'
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
} from './lib.mjs'
import { tapTestId } from './driver.mjs'

const P184 = { warmMedianMs: 1044, warmP95Ms: 1257, coldFirstScanMs: [2900, 3300] }
const pct = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]
const summary = (values) => {
  const s = [...values].sort((a, b) => a - b)
  return { n: s.length, median: pct(s, 50), p90: pct(s, 90), p95: pct(s, 95), max: s[s.length - 1] }
}

shell(`am force-stop ${PACKAGE}`)
await sleep(2500)
clearLog()
adb(['logcat', '-G', '16M'], { allowFail: true })
amStart()
await ensureSignedIn(users.b)
await openPhotoScreen()

// 1. cold first scan through the picker (model + index load included)
let before = scanMark()
await pushImage(join(fixtureDir, 'f01-clean.jpg'), 'perf-cold')
await pickNewest()
await waitRecognition(90000)
const coldTrace = await nextScanTrace(before)
console.log(`cold first scan: ${String(coldTrace.stages.totalMs)} ms`)

// 2. warm: 25 back-to-back analyses inside the app (P184's method), quiet polling
before = scanMark()
await tapTestId('p184-proof-stress-25', { label: 'analyse 25 times' })
const start = Date.now()
for (;;) {
  await sleep(2000)
  const text = byId(dump(), 'p184-proof-status')?.text ?? ''
  if (/stress25 DONE 25[/]25/.test(text)) break
  if (Date.now() - start > 300000) throw new Error('the 25-analysis block did not finish')
}
const warm = scansSince(before).filter((t) => t.outcome === 'analysed')
const totals = warm.map((t) => t.stages.totalMs)
const first10 = summary(totals.slice(0, 10))
const all = summary(totals)

// 3. the user path under driver load: 10 picker-driven scans (informational)
const driven = []
for (let i = 0; i < 10; i += 1) {
  const mark = scanMark()
  await pushImage(join(fixtureDir, 'f01-clean.jpg'), `perf${String(i)}`)
  await pickNewest()
  await waitRecognition(90000)
  driven.push((await nextScanTrace(mark)).stages.totalMs)
}
const pss = /TOTAL PSS:\s+(\d+)/.exec(shell(`dumpsys meminfo ${PACKAGE}`))?.[1]
const report = {
  coldFirstScanMs: coldTrace.stages.totalMs,
  warmAnalysed: warm.length,
  warmFailures: scansSince(before).filter((t) => t.outcome === 'error').length,
  warmFirst10: first10,
  warmAll25: all,
  vsP184: {
    medianRatio: Math.round((first10.median / P184.warmMedianMs) * 100) / 100,
    p95Ratio: Math.round((first10.p95 / P184.warmP95Ms) * 100) / 100,
    median25Ratio: Math.round((all.median / P184.warmMedianMs) * 100) / 100,
  },
  pickerDrivenUnderDriverLoad: summary(driven),
  pssKb: Number(pss),
  modelSessionsCreated: sessionTraces().filter((s) => s.action === 'created').length,
  pid: appPid(),
  p184: P184,
}
saveJson('perf-regression.json', report)
console.log(JSON.stringify(report, null, 1))
process.exit(report.warmFailures === 0 && report.vsP184.medianRatio < 1.5 ? 0 : 1)

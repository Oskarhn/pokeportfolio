#!/usr/bin/env node
/**
 * P185 bounded scanner performance regression (the full 100-scan benchmark is P184's and only
 * repeats when scanner runtime code changes; P185 changed UI, accessibility and test drivers).
 * LOCAL ONLY, proof build.
 *
 *   node scripts/p185/perf-regression.mjs
 *
 * One cold first scan, then 10 warm analyses driven through the real photo picker (the user's
 * path), comparing the median / p95 with P184's recorded figures (warm median 1044 ms, p95 1257 ms).
 * Output: .build/p185-evidence/perf-regression.json
 */
import './env.mjs'
import { join } from 'node:path'
import { amStart, appPid, openPhotoScreen } from '../android-p167-lib.mjs'
import {
  PACKAGE,
  adb,
  clearLog,
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

const P184 = { warmMedianMs: 1044, warmP95Ms: 1257, coldFirstScanMs: [2900, 3300] }
const pct = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]

shell(`am force-stop ${PACKAGE}`)
await sleep(2500)
clearLog()
adb(['logcat', '-G', '16M'], { allowFail: true })
amStart()
await ensureSignedIn(users.b)
await openPhotoScreen()
const totals = []
const stagesAll = []
for (let i = 0; i < 11; i += 1) {
  const before = scanMark()
  await pushImage(join(fixtureDir, 'f01-clean.jpg'), `perf${String(i)}`)
  await pickNewest()
  await waitRecognition(90000)
  const t = await nextScanTrace(before)
  totals.push(t.stages.totalMs)
  stagesAll.push(t.stages)
  console.log(`scan ${String(i)}: ${String(t.stages.totalMs)} ms (${t.outcome})`)
}
const cold = totals[0]
const warm = [...totals.slice(1)].sort((a, b) => a - b)
const warmMedian = pct(warm, 50)
const warmP95 = pct(warm, 95)
const pss = /TOTAL PSS:\s+(\d+)/.exec(shell(`dumpsys meminfo ${PACKAGE}`))?.[1]
const report = {
  scans: totals.length,
  failures: scansSince(0).filter((t) => t.outcome === 'error').length,
  coldFirstScanMs: cold,
  warmN: warm.length,
  warmMedianMs: warmMedian,
  warmP95Ms: warmP95,
  warmMaxMs: warm[warm.length - 1],
  vsP184: {
    medianRatio: Math.round((warmMedian / P184.warmMedianMs) * 100) / 100,
    p95Ratio: Math.round((warmP95 / P184.warmP95Ms) * 100) / 100,
  },
  pssKb: Number(pss),
  modelSessionsCreated: sessionTraces().filter((s) => s.action === 'created').length,
  pid: appPid(),
  p184: P184,
}
saveJson('perf-regression.json', report)
console.log(JSON.stringify(report, null, 1))
process.exit(report.failures === 0 && report.vsP184.medianRatio < 1.5 ? 0 : 1)

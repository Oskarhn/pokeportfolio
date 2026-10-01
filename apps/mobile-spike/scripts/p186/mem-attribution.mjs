#!/usr/bin/env node
/**
 * P186 memory attribution probe (LOCAL ONLY, proof build): launches the app, signs in, enters the
 * scanner screen WITHOUT choosing a photo, waits for the prewarm to settle and prints the
 * `dumpsys meminfo` App Summary. Run it once per experiment build to attribute the resident memory
 * of each prewarm component (assets, model session, OCR engine, decoder).
 *
 *   node scripts/p186/mem-attribution.mjs --label session [--install <apk>] [--settle 12]
 *
 * Output: .build/p186-evidence/mem-<label>.json
 */
import './env.mjs'
import { amStart, openPhotoScreen } from '../android-p167-lib.mjs'
import { PACKAGE, adb, ensureSignedIn, saveJson, shell, sleep, users } from '../p185/lib.mjs'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback)
}
const label = arg('label', 'run')
const settle = Number(arg('settle', 12))
const apk = arg('install', null)

function breakdownMb() {
  const text = shell(`dumpsys meminfo ${PACKAGE}`)
  const out = {}
  for (const row of ['Java Heap', 'Native Heap', 'Code', 'Private Other', 'System', 'TOTAL PSS']) {
    const m = new RegExp(String.raw`${row}:\s+(\d+)`).exec(text)
    if (m !== null) out[row] = Math.round(Number(m[1]) / 1024)
  }
  return out
}

if (apk !== null) {
  adb(['uninstall', PACKAGE], { allowFail: true })
  adb(['install', '-r', '-g', apk])
}
shell(`am force-stop ${PACKAGE}`)
await sleep(2500)
amStart()
await ensureSignedIn(users.b)
await sleep(4000)
const appBaseline = breakdownMb()
await openPhotoScreen()
await sleep(settle * 1000)
const scannerEntered = breakdownMb()
saveJson(`mem-${label}.json`, { label, appBaseline, scannerEntered })
console.log(JSON.stringify({ label, appBaseline, scannerEntered }))

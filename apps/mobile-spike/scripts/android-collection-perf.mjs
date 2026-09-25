#!/usr/bin/env node
/**
 * P167 collection performance harness: the SAME scroll pattern on the SAME emulator and dataset for
 * any installed build, so a before/after comparison differs only in the APK. LOCAL ONLY.
 *
 *   ANDROID_SERIAL=emulator-5554 node scripts/android-collection-perf.mjs <label> [runs=3]
 *
 * Per run: clean data, sign in synthetic user A (10 006 holdings), then
 *   cold  - force-stop, start with the stored session, first rows (am start -W + dump polling),
 *           then 30 flings down in the fresh process (pages are fetched while scrolling);
 *   warm  - 30 flings back up and the same 30 down again in the same process (rows already loaded).
 * No uiautomator dump runs DURING a fling sequence (a dump costs ~2 s of device CPU). Recorded:
 * `dumpsys gfxinfo` frame percentiles and janky frames, PSS, the PostgREST requests the stack's Kong
 * logged during the sequence, and the rows visible at the end.
 *
 * Emulator numbers (x86_64, host GPU) are not phone numbers. Output:
 * .build/p167-perf/<label>.json (gitignored).
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PACKAGE, byId, dump, shell, sleep, waitFor } from './android-adb.mjs'
import { amStart, gfx, pssKb, rows, signIn } from './android-p167-lib.mjs'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const label = process.argv[2]
const runs = Number(process.argv[3] ?? 3)
if (!label || !/^[\w-]+$/.test(label)) {
  console.error('usage: android-collection-perf.mjs <label> [runs]')
  process.exit(2)
}
const fixture = JSON.parse(readFileSync(join(appRoot, '.local-backend', 'fixture.json'), 'utf8'))
const stack = JSON.parse(readFileSync(join(appRoot, '.local-backend', 'stack.json'), 'utf8'))
const kong = `supabase_kong_${stack.projectId}`
const outDir = join(appRoot, '.build', 'p167-perf')
mkdirSync(outDir, { recursive: true })

const FLINGS = 30
function kongRequests(sinceIso) {
  const r = spawnSync('docker', ['logs', '--since', sinceIso, kong], { encoding: 'utf8' })
  const lines = `${r.stdout}\n${r.stderr}`
    .split('\n')
    .filter((l) => /"(GET|POST) \/rest\/v1\//.test(l))
  const byPath = {}
  for (const l of lines) {
    const p = /"(?:GET|POST) (\/rest\/v1\/[^? ]+)/.exec(l)?.[1] ?? '?'
    byPath[p] = (byPath[p] ?? 0) + 1
  }
  return { total: lines.length, byPath }
}
async function flings(direction) {
  const [from, to] = direction === 'down' ? [1900, 500] : [500, 1900]
  for (let i = 0; i < FLINGS; i++) {
    shell(`input touchscreen swipe 540 ${from} 540 ${to} 120`)
    await sleep(450)
  }
}
async function measured(direction) {
  shell(`dumpsys gfxinfo ${PACKAGE} reset`)
  const since = new Date(Date.now() - 500).toISOString()
  const t0 = Date.now()
  await flings(direction)
  await sleep(1500)
  const frames = gfx()
  const requests = kongRequests(since)
  const n = dump()
  return {
    elapsedMs: Date.now() - t0,
    frames,
    jankPct: frames.framesRendered
      ? Math.round((1000 * frames.jankyFrames) / frames.framesRendered) / 10
      : null,
    pssKb: pssKb(),
    requests,
    visibleRowsAtEnd: rows(n).length,
    loadingVisibleAtEnd: Boolean(byId(n, 'loading')),
  }
}

const results = []
shell('settings put system font_scale 1.0')
shell('cmd uimode night no')
shell('settings put secure stylus_handwriting_enabled 0')
for (let run = 1; run <= runs; run++) {
  shell(`am force-stop ${PACKAGE}`)
  shell(`pm clear ${PACKAGE}`)
  amStart()
  await signIn(fixture.users.a)
  shell(`am force-stop ${PACKAGE}`)
  await sleep(1000)
  const since = new Date(Date.now() - 500).toISOString()
  const start = amStart()
  const t0 = Date.now()
  await waitFor((ns) => rows(ns).length > 0, { timeoutMs: 60000, label: 'rows after cold start' })
  const coldStart = {
    ...start,
    rowsVisibleAfterStartMs: Date.now() - t0,
    requests: kongRequests(since),
    pssKb: pssKb(),
  }
  await sleep(1000)
  const cold = await measured('down')
  await flings('up')
  await sleep(1000)
  const warm = await measured('down')
  results.push({ run, coldStart, cold, warm })
  console.log(
    `run ${run}: cold p50/p90/p99 ${cold.frames.p50ms}/${cold.frames.p90ms}/${cold.frames.p99ms} ms jank ${cold.jankPct}% req ${cold.requests.total} | warm ${warm.frames.p50ms}/${warm.frames.p90ms}/${warm.frames.p99ms} ms jank ${warm.jankPct}% req ${warm.requests.total} | pss ${warm.pssKb} kB | first rows ${coldStart.rowsVisibleAfterStartMs} ms`,
  )
}
const apk = shell(`pm path ${PACKAGE}`).trim()
const device = shell('getprop ro.product.model').trim()
writeFileSync(
  join(outDir, `${label}.json`),
  JSON.stringify(
    { label, when: new Date().toISOString(), device, apk, flingsPerSequence: FLINGS, results },
    null,
    2,
  ),
)
console.log(`wrote ${join(outDir, `${label}.json`)}`)

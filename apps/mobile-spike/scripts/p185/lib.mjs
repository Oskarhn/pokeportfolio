/**
 * Shared helpers for the P185 device drivers (scanner-check.mjs). LOCAL ONLY, synthetic users only.
 * Credentials come from the gitignored .local-backend/fixture.json and go to adb only.
 */
import './env.mjs'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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
  chooseNewestInPicker,
  ensureApp,
  focusedWindow,
  openPhotoScreen,
  rows,
  signIn,
  waitForPickerOrState,
} from '../android-p167-lib.mjs'

export {
  PACKAGE,
  adb,
  byId,
  byIdPrefix,
  dump,
  shell,
  sleep,
  tap,
  waitFor,
  ensureApp,
  rows,
  signIn,
  focusedWindow,
}

const here = dirname(fileURLToPath(import.meta.url))
export const appRoot = resolve(here, '..', '..')
// P186 reuses these drivers under its own evidence directory, database container and proxy port.
export const outDir = join(appRoot, '.build', process.env.P185_EVIDENCE_DIR ?? 'p185-evidence')
mkdirSync(outDir, { recursive: true })

export const fixtureJson = JSON.parse(
  readFileSync(join(appRoot, '.local-backend', 'fixture.json'), 'utf8'),
)
export const users = fixtureJson.users
export const fixtureManifest = JSON.parse(
  readFileSync(join(appRoot, 'tests', 'fixtures', 'scanner-p184', 'manifest.json'), 'utf8'),
)
export const fixtureDir = join(appRoot, 'tests', 'fixtures', 'scanner-p184')
export const PROXY = `http://127.0.0.1:${process.env.P185_PROXY_PORT ?? '55831'}`
export const DB_CONTAINER = process.env.P185_DB_CONTAINER ?? 'supabase_db_pokeportfolio-p185-app'

export function shot(name) {
  writeFileSync(join(outDir, `${name}.png`), screencap())
}

// ---- logcat trace ---------------------------------------------------------------------------
export function clearLog() {
  adb(['logcat', '-c'], { allowFail: true })
}

export function rawLog() {
  return adb(['logcat', '-d', '-v', 'time', 'ReactNativeJS:V', '*:S'], { allowFail: true })
}

/** Every P184_TRACE event currently in the log buffer, in order. */
export function traces() {
  const out = []
  for (const line of rawLog().split(/\r?\n/)) {
    const at = line.indexOf('P184_TRACE ')
    if (at === -1) continue
    try {
      const event = JSON.parse(line.slice(at + 'P184_TRACE '.length))
      event.logTime = line.slice(0, 18) // 'MM-DD HH:MM:SS.mmm' as logcat prints it
      out.push(event)
    } catch {
      // A truncated log line is dropped, never guessed at.
    }
  }
  return out
}

export const scanTraces = () => traces().filter((t) => t.kind === 'scan')
/**
 * A position in time that survives BOTH the logcat ring buffer wrapping and the app process being
 * restarted (P185: counting traces broke after a few dozen uiautomator dumps pushed old lines out,
 * and scan ids restart at 1 in a new process). It is the device clock; a scan is "after the mark"
 * when its trace was logged later.
 */
export const scanMark = () => shell("date '+%m-%d %H:%M:%S'").trim()
export const scansSince = (mark) => scanTraces().filter((t) => (t.logTime ?? '') > mark)
export const sessionTraces = () => traces().filter((t) => t.kind === 'session')

// ---- proxy control ----------------------------------------------------------------------------
export async function proxy(path, method = 'GET') {
  const res = await fetch(`${PROXY}/__proxy/${path}`, { method })
  return res.json()
}

// ---- database (local, isolated stack only) -----------------------------------------------------
import { spawnSync } from 'node:child_process'
export function psql(sql) {
  const r = spawnSync(
    'docker',
    [
      'exec',
      '-i',
      DB_CONTAINER,
      'psql',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-At',
    ],
    { input: sql, encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
  )
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr}`)
  return r.stdout.trim()
}

// ---- image push and pick ------------------------------------------------------------------------
let pushCounter = 0
/** Pushes a local file to the shared pictures folder under a unique name and makes it the newest. */
export async function pushImage(localPath, label) {
  pushCounter += 1
  const name = `p185-${label}-${String(Date.now())}-${String(pushCounter)}.${localPath.split('.').pop()}`
  shell('mkdir -p /sdcard/Pictures')
  adb(['push', localPath, `/sdcard/Pictures/${name}`])
  // adb push keeps the local file's modification time; the picker lists newest-first by that time,
  // so an older local file would not be the newest item. Make it "now".
  shell(`touch /sdcard/Pictures/${name}`)
  shell(
    `am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Pictures/${name}`,
  )
  await sleep(1500)
  // The picker lists newest-first by MediaStore date_added. A leftover file dated in the future (a
  // clock-shifting test earlier on the same AVD) would silently win and the scan would analyse the
  // WRONG image; P185 hit exactly that. Prove the pushed file really is the newest.
  const newest = () =>
    shell(
      "content query --uri content://media/external/images/media --projection _display_name --sort 'date_added DESC'",
      { allowFail: true },
    )
      .split(/\r?\n/)[0]
      ?.match(/_display_name=(\S+)/)?.[1]
  if (newest() !== name) {
    shell(
      `am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Pictures/${name}`,
    )
    await sleep(1500)
  }
  const top = newest()
  if (top !== name)
    throw new Error(`picker would show ${String(top)} instead of the pushed ${name}`)
  return name
}

/** On the photo screen: choose from the library, take the newest image in the system picker. */
export async function scrollPhotoScreenToTop() {
  // A previous scan leaves the screen scrolled down to its outcome; the picker buttons are at the top.
  for (let i = 0; i < 4; i += 1) {
    const n = dump()
    if (!byId(n, 'p169-photo-entry') || byId(n, 'p169-photo-library')) return
    swipeDown()
    await sleep(500)
  }
}

/** Taps the first (newest) thumbnail of the open system picker, at any density / font scale. */
export async function chooseFirstThumbnail() {
  // The system picker exposes each thumbnail as "Photo taken on <date>". The first one in reading
  // order (top row, left column) is the newest. Found in the live tree, never at a remembered
  // coordinate: the sheet is half open at large font scales and the grid moves with density.
  const start = Date.now()
  for (;;) {
    const thumbs = dump()
      .filter((n) => n.bounds && /^Photo taken on/.test(n.desc))
      .sort((a, b) => a.bounds.y1 - b.bounds.y1 || a.bounds.x1 - b.bounds.x1)
    if (thumbs.length > 0) {
      tap(thumbs[0])
      return
    }
    if (Date.now() - start > 12000) break
    await sleep(400)
  }
  await chooseNewestInPicker() // a picker UI without those descriptions: the P167 fallback
}

export async function pickNewest() {
  await scrollPhotoScreenToTop()
  const nodes = await openPhotoScreen()
  if (byId(nodes, 'p169-recognition-retake') || byId(nodes, 'p169-photo-ready')) {
    const retake = byId(dump(), 'p169-recognition-retake')
    if (retake) {
      tap(retake)
      await sleep(600)
    }
  }
  tap(
    (await waitFor((ns) => byId(ns, 'p169-photo-library'), { label: 'choose photo button' })).value,
  )
  const state = await waitForPickerOrState(10000)
  if (state.picker) {
    await chooseFirstThumbnail()
  }
  await waitFor((ns) => byId(ns, 'p169-photo-ready'), { timeoutMs: 30000, label: 'photo ready' })
}

const RECOGNITION_IDS = [
  'p169-recognition-result',
  'p169-recognition-no-match',
  'p169-recognition-abstain',
  'p169-recognition-error',
]

export function swipeUp() {
  shell('input touchscreen swipe 540 1900 540 700 300')
}
export function swipeDown() {
  shell('input touchscreen swipe 540 700 540 1900 300')
}

/** Like waitFor, but scrolls the screen down a step whenever `pick` finds nothing. */
export async function waitForScrolling(
  pick,
  { timeoutMs = 30000, label = 'condition', steps = 4 } = {},
) {
  const start = Date.now()
  let scrolled = 0
  for (;;) {
    const nodes = dump()
    const value = pick(nodes)
    if (value) return { value, ms: Date.now() - start, nodes }
    if (Date.now() - start > timeoutMs) {
      const ids = [...new Set(nodes.map((n) => n.id).filter(Boolean))].slice(0, 40)
      throw new Error(
        `timed out after ${timeoutMs} ms waiting for ${label}; visible ids: ${ids.join(', ')}`,
      )
    }
    // Give a running analysis time first; only scroll once a full second has passed without a hit.
    if (Date.now() - start > 1500 && scrolled < steps) {
      swipeUp()
      scrolled += 1
      await sleep(500)
    } else if (scrolled >= steps) {
      for (let i = 0; i < steps; i += 1) swipeDown()
      scrolled = 0
      await sleep(400)
    } else await sleep(300)
  }
}

/** Waits for the recognition section to show a final state; returns what the person sees. */
export async function waitRecognition(timeoutMs = 90000) {
  const r = await waitForScrolling((ns) => RECOGNITION_IDS.find((id) => byId(ns, id)) && ns, {
    timeoutMs,
    label: 'a recognition outcome',
  })
  let nodes = r.value
  const firstBadge = byId(nodes, 'p169-recognition-confidence')
  const firstHeading = byId(nodes, 'p169-recognition-heading')
  if (RECOGNITION_IDS.find((id) => byId(nodes, id)) === 'p169-recognition-result') {
    // At large font scales the candidate rows sit below the heading: scroll until one is visible.
    for (
      let i = 0;
      i < 4 && byIdPrefix(nodes, 'p169-recognition-candidate-').length === 0;
      i += 1
    ) {
      swipeUp()
      await sleep(500)
      nodes = dump()
    }
  }
  const kind = RECOGNITION_IDS.find((id) => byId(nodes, id)).replace('p169-recognition-', '')
  const candidates = byIdPrefix(nodes, 'p169-recognition-candidate-').map((n) => ({
    id: n.id.split('p169-recognition-candidate-')[1],
    label: n.desc || n.text,
  }))
  return {
    kind,
    heading: firstHeading?.text || firstHeading?.desc || null,
    badge: firstBadge?.text || firstBadge?.desc || null,
    preselectable: byId(nodes, 'p169-recognition-confirm') !== undefined,
    candidates,
    ms: r.ms,
    nodes,
  }
}

/** Newest FINISHED (non-cancelled) scan trace recorded after `sinceCount` scan traces. */
export async function nextScanTrace(mark, { timeoutMs = 60000, includeCancelled = false } = {}) {
  const start = Date.now()
  for (;;) {
    const fresh = scansSince(mark).filter((t) => includeCancelled || t.outcome !== 'cancelled')
    if (fresh.length > 0) return fresh[fresh.length - 1]
    if (Date.now() - start > timeoutMs) throw new Error('no scan trace appeared')
    await sleep(400)
  }
}

/** Runs one fixture end to end and returns { trace, ui }. */
export async function scanFixture(fileName, { label } = {}) {
  const before = scanMark()
  await pushImage(fileName, label ?? 'fx')
  await pickNewest()
  const ui = await waitRecognition()
  const trace = await nextScanTrace(before)
  return { trace, ui }
}

export const stripNodes = ({ nodes: _nodes, ...rest }) => rest

export function saveJson(name, data) {
  writeFileSync(join(outDir, name), `${JSON.stringify(data, null, 2)}\n`)
}

/** Signs in only when the login form is showing (the app may already hold a session). */
export async function ensureSignedIn(user) {
  const nodes = dump()
  if (byId(nodes, 'login-email') || byId(nodes, 'login-screen')) await signIn(user)
}

export { screencap } from '../android-adb.mjs'

/**
 * Shared helpers for the P167 Android drivers (android-p167-check.mjs, android-collection-perf.mjs).
 * LOCAL ONLY, synthetic users only. Credentials are passed to adb and never printed.
 */
import { inflateSync, deflateSync } from 'node:zlib'
import {
  ACTIVITY,
  PACKAGE,
  adb,
  byId,
  byIdPrefix,
  dump,
  shell,
  sleep,
  tap,
  typeText,
  waitFor,
} from './android-adb.mjs'

export const rows = (nodes) => byIdPrefix(nodes, 'row-')
export const text = (nodes, id) => byId(nodes, id)?.text ?? null
/** Money text as it appears on screen, with every kind of space (NBSP, NNBSP) made plain. */
export const plain = (s) => s.replace(/\s/g, ' ')

export function amStart() {
  const out = shell(`am start -W -n ${ACTIVITY}`)
  const total = /TotalTime: (\d+)/.exec(out)
  const kind = /LaunchState: (\w+)/.exec(out)
  return { totalTimeMs: total ? Number(total[1]) : null, launchState: kind ? kind[1] : null }
}

export function pssKb() {
  const out = shell(`dumpsys meminfo ${PACKAGE}`)
  const m = /TOTAL PSS:\s+(\d+)/.exec(out) ?? /TOTAL\s+(\d+)/.exec(out)
  return m ? Number(m[1]) : null
}

export function gfx() {
  const out = shell(`dumpsys gfxinfo ${PACKAGE}`)
  const num = (re) => {
    const m = re.exec(out)
    return m ? Number(m[1]) : null
  }
  return {
    framesRendered: num(/Total frames rendered: (\d+)/),
    jankyFrames: num(/Janky frames: (\d+)/),
    p50ms: num(/50th percentile: (\d+)ms/),
    p90ms: num(/90th percentile: (\d+)ms/),
    p95ms: num(/95th percentile: (\d+)ms/),
    p99ms: num(/99th percentile: (\d+)ms/),
    slowUiThread: num(/Number Slow UI thread: (\d+)/),
    slowBitmapUploads: num(/Number Slow bitmap uploads: (\d+)/),
    slowDraw: num(/Number Slow issue draw commands: (\d+)/),
    frameDeadlineMissed: num(/Number Frame deadline missed: (\d+)/),
  }
}

/** Pixels per dp on the device (wm density / 160). */
export function pxPerDp() {
  const out = shell('wm density')
  const m = /Override density: (\d+)/.exec(out) ?? /Physical density: (\d+)/.exec(out)
  return m ? Number(m[1]) / 160 : 2.625
}

/**
 * Identity of the live MainActivity object: `dumpsys activity top` prints "Local Activity <hash>"
 * (System.identityHashCode of the Activity instance), which changes when Android recreates it.
 */
export function localActivityId() {
  const out = shell(`dumpsys activity top`)
  const i = out.indexOf(`ACTIVITY ${PACKAGE}/`)
  if (i === -1) return null
  const m = /Local Activity ([0-9a-f]+)/.exec(out.slice(i))
  return m ? m[1] : null
}

/** MainActivity lifecycle events from the system event log since the last `clearEvents()`. */
export function clearEvents() {
  adb(['logcat', '-b', 'events', '-c'], { allowFail: true })
}
export function lifecycleEvents() {
  return adb(['logcat', '-b', 'events', '-d', '-v', 'time'], { allowFail: true })
    .split('\n')
    .filter((l) =>
      /wm_(on_(create|destroy|resume)_called|relaunch_resume_activity|relaunch_activity)/.test(l),
    )
    .filter((l) => l.includes('pokeportfolio.spike'))
    .map((l) => l.trim())
}

export function focusedWindow() {
  const m = /mCurrentFocus=Window\{[^}]*\s(\S+)\}/.exec(shell('dumpsys window'))
  return m ? m[1] : ''
}

/** The IME window's frame in px, or null when no keyboard is shown. */
export function imeFrame() {
  // The IME insets source as the window manager reports it to the app: its frame is the area the
  // keyboard actually covers (`visible=true` only while it is shown).
  const out = shell('dumpsys window')
  const m =
    /InsetsSource id=\S+ type=ime frame=\[(\d+),(\d+)\]\[(\d+),(\d+)\][^\n]*visible=true/.exec(out)
  return m ? { x1: +m[1], y1: +m[2], x2: +m[3], y2: +m[4] } : null
}

export function rootAvailable() {
  const r = adb(['root'], { allowFail: true })
  return /restarting|already running/.test(r)
}

export function pickerCacheFiles() {
  return adb(['shell', `find /data/data/${PACKAGE}/cache -type f 2>/dev/null`], { allowFail: true })
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /\.(jpe?g|png|webp|heic|gif)$/i.test(l))
}

export function appPid() {
  return shell(`pidof ${PACKAGE}`, { allowFail: true }).trim()
}

export function crashCount() {
  return adb(['logcat', '-b', 'crash', '-d'], { allowFail: true })
    .split('\n')
    .filter((l) => l.includes('FATAL EXCEPTION') || (l.includes(PACKAGE) && /Process:/.test(l)))
    .length
}

/** Empties the focused text field (Ctrl+A, Delete): a field can hold text from autofill or a retry. */
export function clearFocusedField() {
  shell('input keycombination 113 29')
  shell('input keyevent 67')
}

/**
 * The emulator's Google autofill service offered the previous synthetic account in the email field
 * (seen in P167: user A's address where user B's was typed). Runs switch autofill off and restore it.
 */
export function disableAutofill() {
  const before = shell('settings get secure autofill_service').trim()
  shell('settings put secure autofill_service null')
  return () =>
    shell(
      before === 'null' || before === ''
        ? 'settings delete secure autofill_service'
        : `settings put secure autofill_service ${before}`,
    )
}

// Gboard shows a "Try out your stylus" sheet when injected events look like a stylus, so input is
// sent as `input touchscreen ...` and stylus handwriting is switched off for a run.
export async function signIn(user, { submit = 'ime' } = {}) {
  const n = (await waitFor((ns) => byId(ns, 'login-email') && ns, { label: 'login form' })).value
  tap(byId(n, 'login-email'))
  clearFocusedField()
  typeText(user.email)
  // The form moves up when the keyboard opens (P167 F7), so positions read before it are stale.
  await sleep(500)
  const typed = (await waitFor((ns) => byId(ns, 'login-email'), { label: 'email field' })).value
  // Compared in-process only; the synthetic address is never printed.
  if (typed.text !== user.email) throw new Error('the email field does not hold the typed address')
  tap((await waitFor((ns) => byId(ns, 'login-password'), { label: 'password field' })).value)
  clearFocusedField()
  typeText(user.password)
  if (submit === 'ime') shell('input keyevent 66')
  else tap(byId(dump(), 'login-submit'))
  const t0 = Date.now()
  const r = await waitFor((ns) => (rows(ns).length > 0 || byId(ns, 'login-error')) && ns, {
    timeoutMs: 60000,
    label: 'first collection page',
  })
  if (byId(r.value, 'login-error')) throw new Error(`login error: ${text(r.value, 'login-error')}`)
  return { firstPageVisibleMs: Date.now() - t0, nodes: r.value }
}

/**
 * Brings the app back to the foreground if it is not (revoking a runtime permission that was granted
 * makes Android kill the app process; the next step would otherwise start on the launcher).
 */
export async function ensureApp() {
  if (focusedWindow().includes(PACKAGE)) return
  amStart()
  await waitFor(
    (ns) =>
      rows(ns).length > 0 ||
      byId(ns, 'login-screen') ||
      byId(ns, 'photo-library') ||
      byId(ns, 'card-detail') ||
      byId(ns, 'price-check-home'),
    { timeoutMs: 60000, label: 'app in the foreground' },
  )
}

export async function openPhotoScreen() {
  await ensureApp()
  if (byId(dump(), 'photo-library')) return dump()
  if (!byId(dump(), 'pc-photo'))
    tap((await waitFor((ns) => byId(ns, 'tab-pricecheck'), { label: 'price check tab' })).value)
  tap((await waitFor((ns) => byId(ns, 'pc-photo'), { label: 'photo entry' })).value)
  return (await waitFor((ns) => byId(ns, 'photo-library') && ns, { label: 'photo screen' })).value
}

/** Waits until the system photo picker has focus, or the app reports a state instead. */
export async function waitForPickerOrState(timeoutMs = 8000) {
  const t0 = Date.now()
  for (;;) {
    const focus = focusedWindow()
    if (/photopicker|PhotoPicker|documentsui/i.test(focus)) return { picker: true, focus }
    const n = dump()
    for (const id of ['photo-unavailable', 'photo-cancelled', 'photo-ready']) {
      if (byId(n, id)) return { picker: false, state: id, focus }
    }
    if (Date.now() - t0 > timeoutMs) return { picker: false, state: null, focus }
    await sleep(300)
  }
}

/**
 * Chooses the newest image in the open system photo picker. The picker's grid is not always in the
 * uiautomator dump; then the first grid cell (top-left, below the header) is tapped by position.
 */
export async function chooseNewestInPicker() {
  const n = dump()
  const thumb = n.find(
    (x) => x.clickable && x.pkg !== PACKAGE && /Photo taken|p16\d|Image|photo/i.test(x.desc),
  )
  if (thumb) {
    tap(thumb)
    return 'node'
  }
  shell('input touchscreen tap 179 1404')
  return 'position'
}

export async function pushSyntheticImage(outFile, name) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(outFile, syntheticPng(500, 700))
  shell('mkdir -p /sdcard/Pictures')
  adb(['push', outFile, `/sdcard/Pictures/${name}`])
  shell(
    `am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Pictures/${name}`,
  )
  await sleep(1500)
}

/** A synthetic 5:7 gradient PNG (no card art), built with zlib only. */
export function syntheticPng(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3
      raw[o] = 40 + Math.round((180 * x) / w)
      raw[o + 1] = 60 + Math.round((120 * y) / h)
      raw[o + 2] = 140
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const c = Buffer.alloc(4)
  c.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, c])
}

/** Decodes an 8-bit RGB/RGBA non-interlaced PNG (what `screencap -p` writes) to raw pixels. */
export function decodePng(buf) {
  let o = 8
  let w = 0
  let h = 0
  let colorType = 0
  const idat = []
  while (o < buf.length) {
    const len = buf.readUInt32BE(o)
    const type = buf.toString('latin1', o + 4, o + 8)
    const data = buf.subarray(o + 8, o + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0)
      h = data.readUInt32BE(4)
      colorType = data[9]
      if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported PNG')
    } else if (type === 'IDAT') idat.push(data)
    o += 12 + len
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0
  if (bpp === 0) throw new Error(`unsupported PNG color type ${colorType}`)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = w * bpp
  const px = Buffer.alloc(stride * h)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0
      const b = y > 0 ? px[(y - 1) * stride + x] : 0
      const c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp] : 0
      let v = src[x]
      if (f === 1) v += a
      else if (f === 2) v += b
      else if (f === 3) v += (a + b) >> 1
      else if (f === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      px[y * stride + x] = v & 0xff
    }
  }
  return {
    w,
    h,
    /** Mean relative luminance (0 dark .. 1 light) of a band of rows. */
    bandLuminance(y1, y2) {
      let sum = 0
      let n = 0
      for (let y = Math.max(0, y1); y < Math.min(h, y2); y += 2) {
        for (let x = 0; x < w; x += 4) {
          const i = y * stride + x * bpp
          sum += (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255
          n += 1
        }
      }
      return n === 0 ? null : Math.round((sum / n) * 1000) / 1000
    },
  }
}

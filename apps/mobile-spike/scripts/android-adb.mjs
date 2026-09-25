/**
 * Minimal adb + uiautomator driver for the Android runtime checks (P166). LOCAL ONLY.
 *
 * No test framework and no extra dependency: the SDK's own `adb` drives a real emulator or device,
 * `uiautomator dump` reads the live view tree (React Native `testID` appears as `resource-id`), and
 * `screencap` writes PNGs. Nothing here prints a credential: typed text is passed to adb only.
 */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const sdk = process.env.ANDROID_HOME ?? join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk')
export const ADB = join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb')
export const PACKAGE = 'invalid.pokeportfolio.spike'
export const ACTIVITY = `${PACKAGE}/.MainActivity`

/**
 * With more than one device attached (a parallel session may run its own emulator), an unscoped
 * command would either fail or, worse, drive someone else's device. Require ANDROID_SERIAL then;
 * adb itself honours it for every call below.
 */
function assertSingleTarget() {
  if (process.env.ANDROID_SERIAL) return
  const r = spawnSync(ADB, ['devices'], { encoding: 'utf8' })
  const attached = String(r.stdout)
    .split('\n')
    .slice(1)
    .filter((l) => /\t(device|offline|unauthorized)/.test(l))
  if (attached.length > 1) {
    throw new Error(
      `${attached.length} adb devices attached; set ANDROID_SERIAL to the one this run owns`,
    )
  }
}
assertSingleTarget()

export function adb(args, { encoding = 'utf8', allowFail = false } = {}) {
  const r = spawnSync(ADB, args, { encoding, maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0 && !allowFail) {
    throw new Error(`adb ${args[0]} ${args[1] ?? ''} failed: ${String(r.stderr).slice(0, 300)}`)
  }
  return r.stdout
}

export const shell = (cmd, opts) => adb(['shell', cmd], opts)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function decode(s) {
  return s
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&#10;', '\n')
    .replaceAll('&amp;', '&')
}

/** Parses a uiautomator XML dump into flat nodes. */
export function parseNodes(xml) {
  const nodes = []
  for (const m of xml.matchAll(/<node ([^>]*?)\/?>/g)) {
    const attrs = {}
    for (const a of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]] = decode(a[2])
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attrs.bounds ?? '')
    nodes.push({
      id: attrs['resource-id'] ?? '',
      text: attrs.text ?? '',
      desc: attrs['content-desc'] ?? '',
      cls: attrs.class ?? '',
      pkg: attrs.package ?? '',
      clickable: attrs.clickable === 'true',
      focusable: attrs.focusable === 'true',
      bounds: b ? { x1: +b[1], y1: +b[2], x2: +b[3], y2: +b[4] } : null,
    })
  }
  return nodes
}

export function dump() {
  const xml = adb(['exec-out', 'uiautomator', 'dump', '/dev/tty'], { allowFail: true })
  const end = xml.lastIndexOf('</hierarchy>')
  return parseNodes(end === -1 ? xml : xml.slice(0, end + 12))
}

export const byId = (nodes, id) => nodes.find((n) => n.id === id || n.id.endsWith(`:id/${id}`))
export const byIdPrefix = (nodes, prefix) =>
  nodes.filter((n) => n.id.startsWith(prefix) || n.id.includes(`:id/${prefix}`))
export const byText = (nodes, re) => nodes.find((n) => re.test(n.text) || re.test(n.desc))

/** Waits until `pick(nodes)` returns something truthy; returns { value, ms, nodes }. */
export async function waitFor(pick, { timeoutMs = 30000, label = 'condition' } = {}) {
  const start = Date.now()
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
    await sleep(250)
  }
}

export function center(node) {
  const b = node.bounds
  return [Math.round((b.x1 + b.x2) / 2), Math.round((b.y1 + b.y2) / 2)]
}

export function tap(node) {
  const [x, y] = center(node)
  shell(`input touchscreen tap ${x} ${y}`)
}

/** Types URL-safe text (letters, digits, @ . _ - +). Anything else is refused, not mangled. */
export function typeText(text) {
  if (!/^[A-Za-z0-9@._+-]+$/.test(text)) throw new Error('typeText: unsupported characters')
  adb(['shell', 'input', 'text', text])
}

export function screencap() {
  return adb(['exec-out', 'screencap', '-p'], { encoding: 'buffer' })
}

export function logcat(filter = 'ReactNativeJS:V *:S') {
  return adb(['logcat', '-d', '-v', 'time', ...filter.split(' ')], { allowFail: true })
}

export { sleep }

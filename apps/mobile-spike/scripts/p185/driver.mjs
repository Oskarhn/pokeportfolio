/**
 * P185 device-driver primitives. LOCAL ONLY.
 *
 * P184's integrated journey failed at step 11 for reasons that were not product faults: a stale
 * expectation about how many "back" presses reach the scanner, hard-coded swipe coordinates, taps
 * issued from a dump taken before a layout change, and an adb server that died mid-run. This module
 * is the replacement contract, in the preferred order of automation:
 *
 *   1. testID (resource-id) / content description / text from the live accessibility tree;
 *   2. the tree's CURRENT bounds, read in the same instant as the tap (never kept across a
 *      keyboard, a navigation, a sheet, an orientation or font/density change);
 *   3. coordinates are only ever derived from a fresh tree or from the CURRENT screen size.
 *
 * Every wait is bounded and fails with the visible ids; nothing is silently skipped. A lost adb
 * server is recovered inside adb() (scripts/adb-recovery.cjs) and the SAME emulator is re-proved.
 */
import './env.mjs'
import { ACTIVITY, PACKAGE, adb, byId, byIdPrefix, dump, shell, sleep } from '../android-adb.mjs'

export { PACKAGE, ACTIVITY, adb, dump, shell, sleep }

/** adb is already recovery-aware (one bounded retry after proving the same emulator); named for intent. */
export const retryAdbOnce = (args, opts) => adb(args, opts)

// ---- screen ------------------------------------------------------------------------------------
export function screen() {
  // Re-read every time: a density or font change alters the usable area.
  const out = shell('wm size')
  const m = /Override size:\s*(\d+)x(\d+)/.exec(out) ?? /Physical size:\s*(\d+)x(\d+)/.exec(out)
  const density = /Override density:\s*(\d+)/.exec(shell('wm density'))?.[1]
  const physical = /Physical density:\s*(\d+)/.exec(shell('wm density'))?.[1]
  return {
    width: m ? Number(m[1]) : 1080,
    height: m ? Number(m[2]) : 2400,
    dpi: Number(density ?? physical ?? 420),
  }
}
export const dp = (px, dpi) => px / (dpi / 160)

// ---- selectors ---------------------------------------------------------------------------------
const idOf = (n) => n.id.replace(/^.*:id\//, '')

/** A selector is a testID string, or { id, prefix, text: RegExp, desc: RegExp, label: RegExp }. */
export function matches(node, sel) {
  if (typeof sel === 'string') return idOf(node) === sel
  if (sel.id !== undefined && idOf(node) !== sel.id) return false
  if (sel.prefix !== undefined && !idOf(node).startsWith(sel.prefix)) return false
  if (sel.text !== undefined && !sel.text.test(node.text)) return false
  if (sel.desc !== undefined && !sel.desc.test(node.desc)) return false
  if (sel.label !== undefined && !(sel.label.test(node.text) || sel.label.test(node.desc)))
    return false
  return true
}
export const findNode = (nodes, sel) => nodes.find((n) => n.bounds && matches(n, sel))
export const findAll = (nodes, sel) => nodes.filter((n) => n.bounds && matches(n, sel))
const describe = (sel) =>
  typeof sel === 'string'
    ? sel
    : JSON.stringify(sel, (k, v) => (v instanceof RegExp ? String(v) : v))
const visibleIds = (nodes) =>
  [...new Set(nodes.map(idOf).filter((i) => i && !/^(content|action_bar)/.test(i)))].slice(0, 40)

/** One fresh dump, one lookup. The caller owns freshness: never reuse the result across a change. */
export function dumpAndFind(sel) {
  const nodes = dump()
  return { nodes, node: findNode(nodes, sel) }
}

export async function waitForNode(sel, { timeoutMs = 30000, label = describe(sel) } = {}) {
  const start = Date.now()
  for (;;) {
    const { nodes, node } = dumpAndFind(sel)
    if (node) return { node, nodes, ms: Date.now() - start }
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `timed out after ${timeoutMs} ms waiting for ${label}; visible ids: ${visibleIds(nodes).join(', ')}`,
      )
    }
    await sleep(250)
  }
}

export async function waitForText(re, opts = {}) {
  return waitForNode({ label: re }, { ...opts, label: opts.label ?? String(re) })
}

export async function waitForAny(sels, { timeoutMs = 30000, label = 'any of the states' } = {}) {
  const start = Date.now()
  for (;;) {
    const nodes = dump()
    for (const sel of sels) {
      const node = findNode(nodes, sel)
      if (node) return { sel, node, nodes, ms: Date.now() - start }
    }
    if (Date.now() - start > timeoutMs)
      throw new Error(
        `timed out after ${timeoutMs} ms waiting for ${label}; visible ids: ${visibleIds(nodes).join(', ')}`,
      )
    await sleep(250)
  }
}

export async function waitGone(sel, { timeoutMs = 15000 } = {}) {
  const start = Date.now()
  while (findNode(dump(), sel)) {
    if (Date.now() - start > timeoutMs)
      throw new Error(`still visible after ${timeoutMs} ms: ${describe(sel)}`)
    await sleep(250)
  }
}

// ---- input method ------------------------------------------------------------------------------
export const imeShown = () =>
  /mInputShown=true/.test(shell('dumpsys input_method', { allowFail: true }))

export async function dismissKeyboard() {
  if (!imeShown()) return
  shell('input keyevent 4')
  for (let i = 0; i < 20 && imeShown(); i += 1) await sleep(150)
  await sleep(500) // the layout re-flows after the keyboard has gone: bounds read before are stale
}

// ---- scrolling ---------------------------------------------------------------------------------
async function swipe(direction) {
  const { width, height } = screen()
  const x = Math.round(width / 2)
  const top = Math.round(height * 0.3)
  const bottom = Math.round(height * 0.72)
  const [y1, y2] = direction === 'down' ? [bottom, top] : [top, bottom]
  shell(`input touchscreen swipe ${x} ${y1} ${x} ${y2} 320`)
  await sleep(450)
}
export const scrollDown = () => swipe('down') // content moves up: reveals what is below
export const scrollUp = () => swipe('up')

const signature = (nodes) =>
  nodes
    .filter((n) => n.bounds)
    .map((n) => `${idOf(n)}|${n.text}|${n.bounds.y1}`)
    .join(';')

/** Scrolls to the top, then collects every node seen on the way down to the bottom (union by id+text). */
export async function scrollSweep({ maxSteps = 14 } = {}) {
  for (let i = 0; i < maxSteps; i += 1) {
    const before = signature(dump())
    await scrollUp()
    if (signature(dump()) === before) break
  }
  const seen = new Map()
  const record = (nodes) => {
    for (const n of nodes) {
      const key = `${idOf(n)}|${n.text}|${n.desc}`
      if (!seen.has(key)) seen.set(key, n)
    }
  }
  let nodes = dump()
  record(nodes)
  const steps = [signature(nodes)]
  for (let i = 0; i < maxSteps; i += 1) {
    await scrollDown()
    nodes = dump()
    const sig = signature(nodes)
    if (steps.includes(sig)) break
    steps.push(sig)
    record(nodes)
  }
  return { all: [...seen.values()], screens: steps.length }
}

/**
 * Scrolls to the top, then returns one fresh dump per scroll position down to the bottom. Unlike a
 * single viewport snapshot (P184's lookup, which saw only the part left on screen after its own
 * scrolling), this sees the whole screen: every node is judged where it was best visible.
 */
export async function sweepDumps({ maxSteps = 14, onScreen = () => {} } = {}) {
  for (let i = 0; i < maxSteps; i += 1) {
    const before = signature(dump())
    await scrollUp()
    if (signature(dump()) === before) break
  }
  const dumps = [dump()]
  onScreen(0)
  const sigs = [signature(dumps[0])]
  for (let i = 0; i < maxSteps; i += 1) {
    await scrollDown()
    const nodes = dump()
    const sig = signature(nodes)
    if (sigs.includes(sig)) break
    sigs.push(sig)
    dumps.push(nodes)
    onScreen(dumps.length - 1)
  }
  return dumps
}

/** True when the node is fully inside the area the person can touch right now. */
export function reachable(node, { width, height }, ime) {
  const b = node.bounds
  const bottomLimit = ime ? height * 0.5 : height - 1
  return (
    b.x1 >= 0 && b.x2 <= width && b.y1 >= 0 && b.y2 <= bottomLimit && b.y2 > b.y1 && b.x2 > b.x1
  )
}

/**
 * Finds `sel`, scrolling toward it (down first, then up) until it is wholly on screen, and returns
 * the FRESH node. Bounded; fails with the visible ids.
 */
export async function bringIntoView(sel, { tries = 14, label = describe(sel) } = {}) {
  let direction = 'down'
  let flipped = false
  let lastSig = ''
  for (let i = 0; i < tries; i += 1) {
    const nodes = dump()
    const node = findNode(nodes, sel)
    const scr = screen()
    if (node && reachable(node, scr, imeShown())) return { node, nodes }
    if (node) {
      // Present but cut by an edge (or under the keyboard): nudge in the right direction.
      const b = node.bounds
      await (b.y1 < scr.height * 0.2 ? scrollUp() : scrollDown())
      continue
    }
    const sig = signature(nodes)
    if (sig === lastSig) {
      // The content did not move: this end of the list is reached.
      if (flipped) break
      flipped = true
      direction = direction === 'down' ? 'up' : 'down'
    }
    lastSig = sig
    await (direction === 'down' ? scrollDown() : scrollUp())
  }
  throw new Error(
    `not found after scrolling: ${label}; visible ids: ${visibleIds(dump()).join(', ')}`,
  )
}

// ---- taps --------------------------------------------------------------------------------------
const centerOf = (n) => [
  Math.round((n.bounds.x1 + n.bounds.x2) / 2),
  Math.round((n.bounds.y1 + n.bounds.y2) / 2),
]

/** Taps a node taken from the CURRENT dump. Callers: use tapTestId, which re-dumps first. */
export function tapNode(node) {
  const [x, y] = centerOf(node)
  shell(`input touchscreen tap ${x} ${y}`)
}

export async function tapTestId(
  sel,
  { scroll = true, timeoutMs = 20000, label = describe(sel) } = {},
) {
  let node
  if (scroll) {
    // The target may be below the fold (a dump holds only what is on screen): scroll toward it,
    // and keep trying until the screen has had time to render it.
    const start = Date.now()
    for (;;) {
      try {
        node = (await bringIntoView(sel, { label })).node
        break
      } catch (error) {
        if (Date.now() - start > timeoutMs) throw error
        await sleep(500)
      }
    }
  } else {
    node = (await waitForNode(sel, { timeoutMs, label })).node
    node = dumpAndFind(sel).node ?? node
  }
  tapNode(node) // bounds are from the dump taken a moment ago, after the last scroll
  return node
}

/** Taps, then waits for `after` (a selector) — and if the tap was swallowed, taps once more. */
export async function tapUntil(sel, after, { timeoutMs = 15000, label = describe(sel) } = {}) {
  await tapTestId(sel, { label })
  try {
    return await waitForNode(after, { timeoutMs, label: `${describe(after)} after ${label}` })
  } catch (error) {
    // A tap that landed while the layout was still moving is the one known driver hazard; one retry.
    if (!findNode(dump(), sel)) throw error
    await tapTestId(sel, { label: `${label} (retry)` })
    return waitForNode(after, { timeoutMs, label: `${describe(after)} after ${label} (retry)` })
  }
}

export const back = () => shell('input keyevent 4')

// ---- typing ------------------------------------------------------------------------------------
const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
function typeRaw(t) {
  if (!/^[A-Za-z0-9 ,._@+-]+$/.test(t))
    throw new Error(`type: unsupported characters in ${JSON.stringify(t)}`)
  for (let i = 0; i < t.length; i += 6) {
    adb(['shell', 'input', 'text', t.slice(i, i + 6).replaceAll(' ', '%s')])
    wait(120)
  }
}

export async function clearAndType(id, text, { verify = true } = {}) {
  await tapTestId(id, { label: `field ${id}` })
  await sleep(450)
  shell('input keyevent KEYCODE_MOVE_END')
  for (let i = 0; i < 40; i += 1) shell('input keyevent 67')
  typeRaw(text)
  await sleep(300)
  if (verify) {
    const now = findNode(dump(), id)?.text ?? ''
    if (now !== text)
      throw new Error(
        `input did not reach ${id}: wanted ${JSON.stringify(text)} got ${JSON.stringify(now)}`,
      )
  }
  await dismissKeyboard()
}

// ---- liveness ----------------------------------------------------------------------------------
/** The app process is alive, in the foreground, and no system "isn't responding" dialog is up. */
export function assertActivityAlive() {
  const pid = shell(`pidof ${PACKAGE}`, { allowFail: true }).trim()
  if (pid === '') throw new Error(`${PACKAGE} is not running (no process)`)
  const top = shell('dumpsys activity activities', { allowFail: true })
  if (
    !new RegExp(
      `(?:topResumedActivity|mResumedActivity)[^\\n]*${PACKAGE.replaceAll('.', '\\.')}`,
    ).test(top)
  )
    throw new Error(`${PACKAGE} is not the resumed activity`)
  const nodes = dump()
  const anr = nodes.find((n) =>
    /isn't responding|keeps stopping|has stopped/i.test(`${n.text} ${n.desc}`),
  )
  if (anr) throw new Error(`system dialog on screen: ${anr.text || anr.desc}`)
  return { pid }
}

export { byId, byIdPrefix }

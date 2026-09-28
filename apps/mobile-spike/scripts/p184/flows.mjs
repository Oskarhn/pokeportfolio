/**
 * Form-driving helpers for the P184 device journeys (scanner -> Price Check -> Add / purchase).
 * Derived from scripts/p179/android-financial-check.mjs (same screens, same testIDs): typed text is
 * passed to adb only and verified from the field afterwards; a still-open soft keyboard is
 * dismissed before any tap aimed below it.
 */
import './env.mjs'
import { adb, byId, byIdPrefix, dump, shell, sleep, tap, waitFor } from '../android-adb.mjs'

const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

export function typeRaw(t) {
  if (!/^[A-Za-z0-9 ,._@+-]+$/.test(t))
    throw new Error(`type: unsupported characters in ${JSON.stringify(t)}`)
  for (let i = 0; i < t.length; i += 6) {
    adb(['shell', 'input', 'text', t.slice(i, i + 6).replaceAll(' ', '%s')])
    wait(120)
  }
}

export const back = () => shell('input keyevent 4')

export function isKeyboardShown() {
  return /mInputShown=true/.test(shell('dumpsys input_method', { allowFail: true }))
}

export async function dismissKeyboard() {
  if (isKeyboardShown()) {
    back()
    await sleep(400)
  }
}

export async function clearField() {
  shell('input keyevent KEYCODE_MOVE_END')
  for (let i = 0; i < 40; i += 1) shell('input keyevent 67')
}

export async function typeInto(id, text, { verify = true } = {}) {
  const { value } = await waitForOrScroll((ns) => byId(ns, id), { label: id })
  tap(value)
  await sleep(400)
  await clearField()
  typeRaw(text)
  await sleep(300)
  if (verify) {
    const now = byId(dump(), id)?.text ?? ''
    if (now !== text)
      throw new Error(
        `input did not reach ${id}: wanted ${JSON.stringify(text)} got ${JSON.stringify(now)}`,
      )
  }
  await dismissKeyboard()
}

export async function tapId(id, label = id) {
  tap((await waitFor((ns) => byId(ns, id), { label })).value)
}

/** Finds a node by id, scrolling down (then up) until it appears. */
export async function findScrolling(id, tries = 10) {
  for (const down of [true, false]) {
    for (let i = 0; i < tries; i += 1) {
      const nodes = dump()
      const node = byId(nodes, id)
      if (node) return { node, nodes }
      shell(
        down
          ? 'input touchscreen swipe 540 1700 540 700 300'
          : 'input touchscreen swipe 540 700 540 1700 300',
      )
      await sleep(350)
    }
  }
  throw new Error(`not found after scrolling: ${id}`)
}

export async function waitForOrScroll(pick, { label = 'condition', timeoutMs = 20000 } = {}) {
  const start = Date.now()
  for (;;) {
    const nodes = dump()
    const value = pick(nodes)
    if (value) return { value, nodes }
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await sleep(300)
  }
}

export async function tapScrolling(id) {
  await dismissKeyboard()
  const { node } = await findScrolling(id)
  tap(node)
}

export const visibleTexts = () =>
  dump()
    .map((n) => n.text)
    .filter(Boolean)
export { byId, byIdPrefix, dump, shell, sleep, tap, waitFor }

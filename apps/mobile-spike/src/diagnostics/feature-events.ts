/**
 * Device-side instrumentation for Search / Price Check: when the bundle is built with
 * EXPO_PUBLIC_RUNTIME_PROOF=1, feature events (request timings, cache hits, dropped late answers)
 * are written to logcat as `P169_PERF {json}` lines for the device drivers. Nothing identifying is
 * logged: ids are truncated and no query text, credential or amount is included. A normal build
 * logs nothing.
 */
const ENABLED = process.env.EXPO_PUBLIC_RUNTIME_PROOF === '1'

/**
 * One line per app runtime created in this JS runtime. The device suite asserts there is exactly one
 * after several Activity recreations (P167: a runtime per mount duplicated the stores and the auth
 * subscription). No identity is logged.
 */
let runtimesCreated = 0
export function logRuntimeCreated(): void {
  runtimesCreated += 1
  if (ENABLED) console.log(`P173_RUNTIME created count=${String(runtimesCreated)}`)
}

export function logP169Event(event: { type: string } & Record<string, unknown>): void {
  if (!ENABLED) return
  const safe: Record<string, unknown> = { type: event.type }
  for (const [k, v] of Object.entries(event)) {
    if (k === 'query' || k === 'key') continue
    if (typeof v === 'number') safe[k] = v
    else if (typeof v === 'string') safe[k] = /id$/i.test(k) ? v.slice(0, 8) : v
  }
  console.log(`P169_PERF ${JSON.stringify(safe)}`)
}

/**
 * Device-side instrumentation for the P169 harness: when the bundle is built with
 * EXPO_PUBLIC_RUNTIME_PROOF=1, feature events (request timings, cache hits, dropped late answers)
 * are written to logcat as `P169_PERF {json}` lines for scripts/p169/android-check.mjs. Nothing
 * identifying is logged: ids are truncated and no query text, credential or amount is included.
 */
const ENABLED = process.env.EXPO_PUBLIC_RUNTIME_PROOF === '1'

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

/**
 * One idempotency key per fresh write-form instance (P175, mirrors the web forms' contract —
 * `src/data/purchases.ts`'s `createPurchase` doc comment: "the caller generates one UUID per fresh
 * form instance and resends the SAME value on any retry of that same attempt"). The RPC itself is
 * the idempotency authority (P107/P138/P140): a replay with a key that already produced a row
 * returns that row unchanged, and a same-key replay whose material fields differ is refused. This
 * module only generates the key; nothing here talks to the network.
 *
 * `expo-crypto` is not a dependency of this spike, and Hermes on this React Native version does not
 * reliably expose `crypto.randomUUID` (checked defensively below rather than assumed) — adding a
 * package for one random string is not worth a new native module. A version-4 UUID from
 * `Math.random()` is not cryptographically unguessable, which does not matter here: the key only
 * needs to not collide with another key from the SAME device by accident, never to resist a
 * determined adversary (RLS and the RPC's own validation are the actual security boundary).
 */
export function generateIdempotencyKey(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } }
  if (typeof g.crypto?.randomUUID === 'function') return g.crypto.randomUUID()
  let uuid = ''
  for (const template of 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx') {
    if (template === '-') {
      uuid += '-'
      continue
    }
    if (template === '4') {
      uuid += '4'
      continue
    }
    const random = Math.floor(Math.random() * 16)
    const value = template === 'y' ? (random & 0x3) | 0x8 : random
    uuid += value.toString(16)
  }
  return uuid
}

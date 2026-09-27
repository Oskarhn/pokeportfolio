import type { IdentityLease } from '../auth/identity-authority'
import {
  createLeasedWriteDb,
  type LeasedWriteClientDeps,
  type LeasedWriteDb,
} from './leased-write-client'

/**
 * Binds {@link createLeasedWriteDb} to ONE Supabase session (mirrors P149's `src/data/leased-db.ts`).
 * Deliberately free of `seam/supabase-client.ts`: `createRuntime` (wiring/runtime.ts) and everything
 * under it must stay usable with ANY Supabase client (the app's real one, the backend test harness's
 * real one, or a fake), the same reason `RuntimeDeps.auth`/`.collection` are injected rather than
 * imported ambiently. The app wires this in `App.tsx`; `tests/backend/support.ts` wires its own
 * instance from the isolated test stack's session.
 */
export type WriteDbBinder = (lease: IdentityLease) => LeasedWriteDb

export function createWriteDbBinder(
  deps: Omit<LeasedWriteClientDeps, 'getSession'> & {
    getSession: LeasedWriteClientDeps['getSession']
  },
): WriteDbBinder {
  const clients = new WeakMap<IdentityLease, LeasedWriteDb>()
  // The write client for one lease — the same instance every time for the same lease, so a
  // form's several RPC calls (e.g. a purchase preview, then its submit) share one token provider.
  return (lease: IdentityLease): LeasedWriteDb => {
    let client = clients.get(lease)
    if (client === undefined) {
      client = createLeasedWriteDb(lease, deps)
      clients.set(lease, client)
    }
    return client
  }
}

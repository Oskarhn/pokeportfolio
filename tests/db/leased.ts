import { IdentityAuthority, type IdentityLease } from '../../src/auth/identity-lease'
import type { ExactTransportOptions } from '../../src/data/exact-json-guard'
import { createLeasedDb, type LeasedDb } from '../../src/data/leased-client'
import type { createAppSupabaseClient } from '../../src/data/supabase-factory'

/**
 * The PRODUCTION leased client (src/data/leased-client.ts -> src/data/supabase-factory.ts), bound
 * to a signed-in test client's live session, for the database suites (P147).
 *
 * Nothing here re-implements a rule: `createLeasedDb` is the same function the app calls, the
 * lease is a real `IdentityAuthority` lease, and the session lookup is the real `getSession()` of
 * a signed-in client — so a test that goes through it exercises the composed request path
 * (identity check -> bearer -> exact-transport guard -> PostgREST -> PostgreSQL).
 */
type SignedInClient = ReturnType<typeof createAppSupabaseClient>

export interface LeasedHarness {
  db: LeasedDb
  lease: IdentityLease
  /** Drive the tab's observed identity: `authority.observe(otherUserId)` ends `lease`. */
  authority: IdentityAuthority
}

export function leasedHarness(
  signedIn: SignedInClient,
  userId: string,
  transport: ExactTransportOptions = {},
): LeasedHarness {
  const authority = new IdentityAuthority()
  authority.observe(userId)
  const lease = authority.begin(userId)
  const db = createLeasedDb(lease, {
    url: process.env.SUPABASE_URL as string,
    publishableKey: process.env.SUPABASE_ANON_KEY as string,
    getSession: () => signedIn.auth.getSession(),
    transport,
  })
  return { db, lease, authority }
}

/** What one request looked like on the wire. The token itself is never kept: only whose it was. */
export interface WireRecord {
  method: string
  path: string
  /** The `sub` claim of the bearer JWT (the account the request authenticates as). */
  bearerSub: string | null
  body: string
}

function subOf(authorization: string | null): string | null {
  const token = /^Bearer (.+)$/.exec(authorization ?? '')?.[1]
  const payload = token?.split('.')[1]
  if (payload === undefined) return null
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      sub?: string
    }
    return claims.sub ?? null
  } catch {
    return null
  }
}

export interface TabUser {
  id: string
  /** A signed-in client of this user: the source of the tab's real, refreshable session. */
  client: SignedInClient
}

/**
 * One browser tab for the database suites: an identity authority, the browser's shared session
 * (whichever user is "signed in" right now — real GoTrue sessions, real refreshes), a recording
 * transport, and switches for the events the real app sees. Every client it hands out is the
 * production leased client.
 */
export class SimulatedTab {
  readonly authority = new IdentityAuthority()
  readonly wire: WireRecord[] = []
  /** How many times a request asked the browser session for its bearer. */
  sessionLookups = 0
  private current: TabUser | null
  private readonly transport: ExactTransportOptions
  private gate: Promise<void> | null = null
  private dropNextResponseOf: string | null = null

  constructor(initial: TabUser | null, transport: ExactTransportOptions = {}) {
    this.transport = transport
    this.current = initial
    this.authority.observe(initial?.id ?? null)
  }

  /** The identity a click on the currently rendered UI would lease. */
  leaseFor(user: TabUser): IdentityLease {
    return this.authority.begin(user.id)
  }

  dbFor(lease: IdentityLease): LeasedDb {
    return createLeasedDb(lease, {
      url: process.env.SUPABASE_URL as string,
      publishableKey: process.env.SUPABASE_ANON_KEY as string,
      getSession: () => this.getSession(),
      fetch: (input, init) => this.transportFetch(input, init),
      transport: this.transport,
    })
  }

  private async getSession() {
    this.sessionLookups += 1
    if (this.gate) await this.gate
    if (this.current === null) return { data: { session: null } }
    return this.current.client.auth.getSession()
  }

  private async transportFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    )
    const headers = new Headers(init?.headers)
    this.wire.push({
      method: init?.method ?? 'GET',
      path: url.pathname,
      bearerSub: subOf(headers.get('authorization')),
      body: typeof init?.body === 'string' ? init.body : '',
    })
    const response = await fetch(input, init)
    if (this.dropNextResponseOf !== null && url.pathname.endsWith(this.dropNextResponseOf)) {
      this.dropNextResponseOf = null
      // The request reached the server and COMMITTED; the answer is lost on the way back.
      throw new TypeError('Failed to fetch')
    }
    return response
  }

  /** Park the next session lookup; the returned function lets it continue. */
  parkNextSessionLookup(): () => void {
    let release: () => void = () => undefined
    this.gate = new Promise<void>((resolve) => {
      release = () => {
        this.gate = null
        resolve()
      }
    })
    return release
  }

  /** Wait until an operation has reached its (parked) session lookup. */
  async untilLookupParked(before: number): Promise<void> {
    for (let turn = 0; turn < 20_000 && this.sessionLookups <= before; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    if (this.sessionLookups <= before) throw new Error('the operation never reached its lookup')
  }

  /** Another tab signed in as `user`; `heard` = this tab has already been told. */
  switchTo(user: TabUser, options: { heard: boolean } = { heard: true }): void {
    this.current = user
    if (options.heard) this.authority.observe(user.id)
  }

  signOut(): void {
    this.current = null
    this.authority.observe(null)
  }

  /** The operation's request reaches the server, commits, and the answer never comes back. */
  loseNextResponseOf(pathSuffix: string): void {
    this.dropNextResponseOf = pathSuffix
  }

  /** Every request of the tab that authenticated as somebody other than `userId`. */
  requestsNotFrom(userId: string): WireRecord[] {
    return this.wire.filter((r) => r.bearerSub !== userId)
  }
}

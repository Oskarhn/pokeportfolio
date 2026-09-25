import { Client } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  acquireScannerFixtureCard,
  SCANNER_FIXTURE_CARD,
  SCANNER_FIXTURE_LEASE_LOCK_KEY,
  type ScannerFixtureLease,
} from '../e2e/authenticated/support/scanner-fixture-card'
import { seedCatalog } from './setup'

/**
 * P165 — ownership of the printed scanner fixture card ("Fauxosaur EX 049").
 *
 * P164 found that two authenticated E2E specs seeded the same printed card, so under parallel
 * workers one `beforeAll` failed on `cards_set_id_local_id_key` and six dependent tests never ran.
 * The card cannot be per spec (the scanner photo prints it, `search_cards` looks across every set),
 * so it is shared reference data with a lease per spec. These tests exercise that lease against
 * real Postgres advisory locks and forced interleavings — they do not test the browser specs.
 *
 * Barriers are observations of the database (`pg_locks`), never sleeps standing in for ordering.
 */

const DB_URL = process.env['DB_URL'] ?? ''
const SET_ID = seedCatalog.cardSetId
const CARD = SCANNER_FIXTURE_CARD

let admin: Client
const leases: ScannerFixtureLease[] = []

async function takeLease(): Promise<ScannerFixtureLease> {
  const lease = await acquireScannerFixtureCard(DB_URL, SET_ID)
  leases.push(lease)
  return lease
}

// The randomized test observes from several tasks at once; one client runs one query at a time.
let observing: Promise<unknown> = Promise.resolve()
function serially<T>(task: () => Promise<T>): Promise<T> {
  const next = observing.then(task, task)
  observing = next.catch(() => undefined)
  return next
}

function fixtureState(): Promise<{ card: number; variants: string[] }> {
  return serially(async () => {
    const card = await admin.query('select 1 from public.cards where id = $1', [CARD.cardId])
    const variants = await admin.query<{ id: string }>(
      'select id from public.card_variants where card_id = $1 order by id',
      [CARD.cardId],
    )
    return { card: card.rowCount ?? 0, variants: variants.rows.map((row) => row.id) }
  })
}

const bothVariants = [...CARD.variantIds].sort()

/** Sessions currently holding (granted) or waiting for (not granted) the fixture's advisory lock. */
async function lockRows(): Promise<{ pid: number; mode: string; granted: boolean }[]> {
  const result = await admin.query<{ pid: number; mode: string; granted: boolean }>(
    `select pid, mode, granted from pg_locks
      where locktype = 'advisory'
        and ((classid::bigint << 32) | objid::bigint) = $1::bigint`,
    [SCANNER_FIXTURE_LEASE_LOCK_KEY],
  )
  return result.rows
}

async function waitFor(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for: ${what}`)
}

async function removeFixtureRows(): Promise<void> {
  await admin.query('delete from public.card_variants where card_id = $1', [CARD.cardId])
  await admin.query('delete from public.cards where id = $1', [CARD.cardId])
}

beforeEach(async () => {
  admin = new Client({ connectionString: DB_URL })
  await admin.connect()
  await removeFixtureRows()
})

afterEach(async () => {
  while (leases.length > 0) await leases.pop()?.release()
  await removeFixtureRows()
  await admin.end()
})

describe('scanner fixture card lease (P165)', () => {
  it('a lone lease creates the card with exactly its two printings; the last release removes them', async () => {
    const lease = await takeLease()
    expect(lease.variantIds).toEqual(CARD.variantIds)
    expect(await fixtureState()).toEqual({ card: 1, variants: bothVariants })
    await lease.release()
    expect(await fixtureState()).toEqual({ card: 0, variants: [] })
    expect(await lockRows()).toEqual([])
  })

  it('overlapping leases: the first release leaves the fixture in place, the last one removes it', async () => {
    const first = await takeLease()
    const second = await takeLease()
    // Both hold it; the second did not duplicate or replace anything.
    expect(await fixtureState()).toEqual({ card: 1, variants: bothVariants })
    await first.release()
    // The regression: a spec that finishes first must not delete the card a slower spec still uses.
    expect(await fixtureState()).toEqual({ card: 1, variants: bothVariants })
    await first.release() // idempotent: a second call neither throws nor removes anything
    expect(await fixtureState()).toEqual({ card: 1, variants: bothVariants })
    await second.release()
    expect(await fixtureState()).toEqual({ card: 0, variants: [] })
  })

  it('a lease requested while the last holder is deleting waits for it, then finds the fixture present', async () => {
    // A "last holder" mid-deletion is a session holding the EXCLUSIVE lock.
    const deleter = new Client({ connectionString: DB_URL })
    await deleter.connect()
    try {
      await deleter.query('select pg_advisory_lock($1::bigint)', [SCANNER_FIXTURE_LEASE_LOCK_KEY])
      const late = takeLease()
      let settled = false
      void late.then(
        () => (settled = true),
        () => (settled = true),
      )
      // Barrier: the late lease is observably WAITING on the lock (not merely slow).
      await waitFor(
        async () => (await lockRows()).some((row) => !row.granted),
        'the late lease to wait for the exclusive lock',
      )
      expect(settled).toBe(false)
      expect(await fixtureState()).toEqual({ card: 0, variants: [] })
      await deleter.query('select pg_advisory_unlock($1::bigint)', [SCANNER_FIXTURE_LEASE_LOCK_KEY])
      const lease = await late
      expect(lease.cardId).toBe(CARD.cardId)
      expect(await fixtureState()).toEqual({ card: 1, variants: bothVariants })
    } finally {
      await deleter.end()
    }
  })

  it('a holder that dies does not keep the fixture alive forever', async () => {
    await takeLease()
    const victim = (await lockRows()).find((row) => row.granted && row.mode === 'ShareLock')
    if (!victim) throw new Error('the first lease holds no lock')
    const survivor = await takeLease()
    expect(
      (await lockRows()).filter((row) => row.granted && row.mode === 'ShareLock'),
    ).toHaveLength(2)
    // The FIRST holder's session is killed (a crashed worker): its lease must vanish with it.
    await admin.query('select pg_terminate_backend($1)', [victim.pid])
    await waitFor(
      async () => (await lockRows()).filter((row) => row.granted).length === 1,
      'the killed holder to drop its lease',
    )
    await survivor.release()
    expect(await fixtureState()).toEqual({ card: 0, variants: [] })
  })

  it('randomized interleavings: while a lease is held the fixture exists exactly as specified; after the last release it is gone', async () => {
    // mulberry32: fixed seed, so the SCHEDULE of each round is reproducible; the interleaving that
    // results is whatever the database and the event loop do with it.
    let seed = 0x165c0de
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const pause = (max: number) => new Promise((resolve) => setTimeout(resolve, random() * max))

    for (let round = 0; round < 25; round += 1) {
      const holders = 2 + Math.floor(random() * 4)
      const observed: string[] = []
      await Promise.all(
        Array.from({ length: holders }, async (_, holder) => {
          await pause(15)
          const lease = await acquireScannerFixtureCard(DB_URL, SET_ID)
          try {
            const at = await fixtureState()
            observed.push(`r${round}h${holder}:${at.card}:${at.variants.length}`)
            expect(at, `round ${round} holder ${holder}: right after acquiring`).toEqual({
              card: 1,
              variants: bothVariants,
            })
            await pause(25)
            expect(
              await fixtureState(),
              `round ${round} holder ${holder}: before releasing`,
            ).toEqual({ card: 1, variants: bothVariants })
          } finally {
            await lease.release()
          }
        }),
      )
      expect(await fixtureState(), `round ${round}: after every release`).toEqual({
        card: 0,
        variants: [],
      })
      expect(await lockRows(), `round ${round}: no lease leaked`).toEqual([])
    }
  })

  it('a different catalog row already holding the printed identity is reported, and leaks no lease', async () => {
    const stray = 'c0000000-0000-0000-0000-000000000f00'
    await admin.query(
      `insert into public.cards (id, set_id, local_id, name, category, language)
       values ($1, $2, $3, 'Stray', 'Pokemon', 'en')`,
      [stray, SET_ID, CARD.localId],
    )
    try {
      await expect(acquireScannerFixtureCard(DB_URL, SET_ID)).rejects.toThrow(
        /another catalog row already holds it/,
      )
      expect(await lockRows()).toEqual([])
    } finally {
      await admin.query('delete from public.cards where id = $1', [stray])
    }
    const lease = await takeLease() // and once the stray is gone the fixture works again
    expect(await fixtureState()).toEqual({ card: 1, variants: bothVariants })
    await lease.release()
  })

  it('refuses a fixture card that has gained another printing, so the explicit-variant tests cannot be diluted', async () => {
    const lease = await takeLease()
    await admin.query(
      `insert into public.card_variants (card_id, finish, stamp, subtype, size)
       values ($1, 'normal', 'p165-extra', '', 'standard')`,
      [CARD.cardId],
    )
    await expect(acquireScannerFixtureCard(DB_URL, SET_ID)).rejects.toThrow(
      /exactly its two printings/,
    )
    // The refused attempt took no lease: only the first holder is left.
    expect((await lockRows()).filter((row) => row.granted)).toHaveLength(1)
    await admin.query('delete from public.card_variants where stamp = $1', ['p165-extra'])
    await lease.release()
    expect(await fixtureState()).toEqual({ card: 0, variants: [] })
  })
})

import type { Client as PgClient } from 'pg'

/**
 * The catalog card that the synthetic scanner photo PRINTS ("FAUXOSAUR EX 049/197").
 *
 * Why this is one shared row and not one row per spec (P165). The scanner finds a scan's candidates
 * with `search_cards` over the WHOLE catalog, by the printed name and number. The printed text is a
 * picture, so it cannot differ between specs, and `cards` is unique on `(set_id, local_id)`. Two
 * specs that each insert their own "Fauxosaur EX 049" therefore either collide on that constraint
 * (same set — the P164 defect: one `beforeAll` failed, six dependent tests never ran) or, in
 * different sets, both cards become candidates of every scan and a test confirms the other spec's
 * card. Neither gives isolation. What CAN be isolated is who owns the row:
 *
 *   - the card and its two printings are immutable REFERENCE data with fixed, deterministic ids;
 *   - every spec that needs them takes a lease (a shared Postgres advisory lock held on a dedicated
 *     session for the spec's lifetime) and creates the rows idempotently (`ON CONFLICT DO NOTHING`);
 *   - the rows are removed only by whoever releases the LAST lease, so a spec can never delete a
 *     fixture another spec is still using; a spec that dies drops its session and with it its lease;
 *   - everything mutable stays per spec: synthetic users, their ledgers, per-account provider prices.
 *
 * The card keeps exactly two printings (normal, reverse) so the deliberate "several printings need
 * an explicit choice" behaviour stays under test; `acquireScannerFixtureCard` refuses to hand the
 * card out if it ever holds any other set of printings.
 */
export const SCANNER_FIXTURE_CARD = {
  cardId: 'c0000000-0000-0000-0000-000000000f49',
  variantIds: [
    'c0000000-0000-0000-0000-0000000af491',
    'c0000000-0000-0000-0000-0000000af492',
  ] as readonly [string, string],
  localId: '049',
  name: 'Fauxosaur EX',
  tcgdexCardId: 'faux-049-scanner-fixture',
} as const

/** Arbitrary constant naming this fixture's advisory lock (one lock for the card and its printings). */
export const SCANNER_FIXTURE_LEASE_LOCK_KEY = '4917049049'
const LEASE_LOCK_KEY = SCANNER_FIXTURE_LEASE_LOCK_KEY

export interface ScannerFixtureLease {
  readonly cardId: string
  readonly variantIds: readonly [string, string]
  /** Gives the lease back; deletes the fixture rows only if no other lease holder remains. Idempotent. */
  release(): Promise<void>
}

async function ensureFixtureRows(session: PgClient, setId: string): Promise<void> {
  const fixture = SCANNER_FIXTURE_CARD
  // Deliberately UNTARGETED `on conflict do nothing`: two holders inserting the same row at the
  // same moment conflict on the primary key AND on (set_id, local_id); an `on conflict (id)` clause
  // arbitrates only the first and lets the second index raise 23505 (found by the interleaving test).
  await session.query(
    `insert into public.cards (id, set_id, local_id, name, rarity, category, language, tcgdex_card_id)
     values ($1, $2, $3, $4, 'Double Rare', 'Pokemon', 'en', $5)
     on conflict do nothing`,
    [fixture.cardId, setId, fixture.localId, fixture.name, fixture.tcgdexCardId],
  )
  // Whatever was skipped, OUR row must now exist. If it does not, a different row holds the printed
  // identity (a leftover of an older, differently-keyed fixture): say so instead of continuing.
  const ours = await session.query('select 1 from public.cards where id = $1', [fixture.cardId])
  if (ours.rowCount !== 1) {
    throw new Error(
      `the printed scanner fixture card (${fixture.name} ${fixture.localId}) cannot be created: another catalog row already holds it ` +
        `(a leftover of an aborted run before the fixture was shared?). Reset the local database.`,
    )
  }
  await session.query(
    `insert into public.card_variants (id, card_id, finish, stamp, subtype, size)
     values ($1, $3, 'normal', '', '', 'standard'), ($2, $3, 'reverse', '', '', 'standard')
     on conflict do nothing`,
    [fixture.variantIds[0], fixture.variantIds[1], fixture.cardId],
  )
  const owned = await session.query<{ id: string }>(
    'select id from public.card_variants where card_id = $1 order by id',
    [fixture.cardId],
  )
  const expected = [...fixture.variantIds].sort()
  if (JSON.stringify(owned.rows.map((row) => row.id)) !== JSON.stringify(expected)) {
    throw new Error(
      `the printed scanner fixture card must have exactly its two printings, found ${owned.rows.length}: the explicit-variant tests would not test what they claim`,
    )
  }
}

/**
 * Takes a lease on the printed scanner fixture card, creating it if this is the first lease.
 * `connectionString` is the local database URL; the lease lives on its own session, separate from
 * whatever connection the spec uses for its queries.
 */
export async function acquireScannerFixtureCard(
  connectionString: string,
  setId: string,
): Promise<ScannerFixtureLease> {
  const { Client } = await import('pg')
  const session: PgClient = new Client({ connectionString })
  // A dropped connection (database restart, `pg_terminate_backend`) must not crash the worker: the
  // lease dies with the session, which is exactly what it should do.
  session.on('error', () => undefined)
  await session.connect()
  let leased = false
  let released = false
  const closeSession = async () => {
    await session.end().catch(() => undefined)
  }
  try {
    // Waits only while a last-holder deletion is running (it takes the exclusive lock).
    await session.query(`set lock_timeout = '30s'`)
    await session.query('select pg_advisory_lock_shared($1::bigint)', [LEASE_LOCK_KEY])
    leased = true
    await ensureFixtureRows(session, setId)
  } catch (error) {
    if (leased) {
      await session
        .query('select pg_advisory_unlock_shared($1::bigint)', [LEASE_LOCK_KEY])
        .catch(() => undefined)
    }
    await closeSession()
    throw error
  }

  return {
    cardId: SCANNER_FIXTURE_CARD.cardId,
    variantIds: SCANNER_FIXTURE_CARD.variantIds,
    async release() {
      if (released) return
      released = true
      try {
        await session.query('select pg_advisory_unlock_shared($1::bigint)', [LEASE_LOCK_KEY])
        // Exclusive only if nobody else holds a lease. A lease taken while this deletion runs
        // waits for it and then re-creates the rows (acquire is idempotent).
        const last = await session.query<{ got: boolean }>(
          'select pg_try_advisory_lock($1::bigint) as got',
          [LEASE_LOCK_KEY],
        )
        if (last.rows[0]?.got === true) {
          try {
            await session.query('delete from public.card_variants where card_id = $1', [
              SCANNER_FIXTURE_CARD.cardId,
            ])
            await session.query('delete from public.cards where id = $1', [
              SCANNER_FIXTURE_CARD.cardId,
            ])
          } catch (error) {
            // Rows of a crashed spec's users may still reference the printings. The fixture is
            // harmless catalog data and the next acquire reuses it.
            console.warn('scanner fixture rows kept:', (error as Error).message)
          } finally {
            await session.query('select pg_advisory_unlock($1::bigint)', [LEASE_LOCK_KEY])
          }
        }
      } catch (error) {
        // A lost session already dropped its lease with it; cleanup never hides a test's own result.
        console.warn('scanner fixture lease release failed:', (error as Error).message)
      } finally {
        await closeSession()
      }
    },
  }
}

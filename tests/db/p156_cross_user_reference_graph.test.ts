import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  signInAs,
  type SyntheticUser,
  type TestClient,
} from './setup'
import { seedAccountLedger } from './lib/account-ledger-fixture'
import { connectDb, ownedDigests, realDeps } from './lib/account-deletion-deps'
import { handleAccountDeletion } from '../../supabase/functions/_shared/account-deletion'

/**
 * P156: the ownership graph a deletion walks, derived from pg_constraint rather than described.
 *
 * The purge deletes A's rows child-first and the final Auth deletion cascades, so the question that
 * decides whether deleting A can ever touch B is: can a row owned by B point at a row owned by A
 * across a foreign key that CASCADEs or SETs NULL? If it could, A's deletion would delete or edit
 * B's row through the foreign key. Every such edge in the schema is guarded by an ownership trigger
 * that refuses the reference in the first place; this suite tries to construct each one — with a
 * superuser connection, which bypasses RLS but not triggers — and fails if a new cascading edge
 * appears that this list does not cover.
 */

let service: TestClient
let db: pg.Client
const created: SyntheticUser[] = []

beforeAll(async () => {
  service = createServiceClient()
  db = await connectDb()
})
afterAll(async () => {
  for (const u of created) {
    await service.from('account_deletion_requests').delete().eq('user_id', u.id)
    await deleteSyntheticUser(service, u.id)
  }
  await db.end()
}, 180_000)

const scalar = async (sql: string, params: unknown[]): Promise<string> =>
  (await db.query<{ id: string }>(sql, params)).rows[0]!.id

// Owned by an auth user, but administrative records that the purge never deletes (it only redacts
// them): a cascade among them is not a path from a departing account into another account's rows.
const ADMIN_RECORDS = new Set(['invitations', 'invitation_claims', 'invitation_redemptions'])

const COVERED_EDGES = [
  'custom_collection_members.collection_id -> custom_collections',
  'custom_collection_members.holding_id -> holdings',
  'holding_tags.holding_id -> holdings',
  'holding_tags.tag_id -> tags',
  'purchase_lines.purchase_id -> purchases',
  'purchases.retailer_id -> retailers',
  'acquisition_lots.storage_location_id -> storage_locations',
  'profiles.default_storage_location_id -> storage_locations',
].sort()

type Ids = Record<string, string>
interface Ctx {
  A: Ids
  B: Ids
  b: string
}

const CASES: [string, (c: Ctx) => [string, unknown[]]][] = [
  [
    'holding_tags.holding_id -> holdings',
    ({ A, B, b }) => [
      'insert into holding_tags (holding_id, tag_id, user_id) values ($1, $2, $3)',
      [A.holding!, B.tag!, b],
    ],
  ],
  [
    'holding_tags.tag_id -> tags',
    ({ A, B, b }) => [
      'insert into holding_tags (holding_id, tag_id, user_id) values ($1, $2, $3)',
      [B.holding!, A.tag!, b],
    ],
  ],
  [
    'custom_collection_members.collection_id -> custom_collections',
    ({ A, B, b }) => [
      'insert into custom_collection_members (collection_id, holding_id, user_id) values ($1, $2, $3)',
      [A.collection!, B.holding!, b],
    ],
  ],
  [
    'custom_collection_members.holding_id -> holdings',
    ({ A, B, b }) => [
      'insert into custom_collection_members (collection_id, holding_id, user_id) values ($1, $2, $3)',
      [B.collection!, A.holding!, b],
    ],
  ],
  [
    'purchases.retailer_id -> retailers',
    ({ A, B }) => [
      'update purchases set retailer_id = $1 where id = $2',
      [A.retailer!, B.purchase!],
    ],
  ],
  [
    'acquisition_lots.storage_location_id -> storage_locations',
    ({ A, B }) => [
      'update acquisition_lots set storage_location_id = $1 where id = $2',
      [A.location!, B.lot!],
    ],
  ],
  [
    'profiles.default_storage_location_id -> storage_locations',
    ({ A, b }) => [
      'update profiles set default_storage_location_id = $1 where id = $2',
      [A.location!, b],
    ],
  ],
  [
    'purchase_lines.purchase_id -> purchases',
    ({ A, B }) => [
      'update purchase_lines set purchase_id = $1 where id = $2',
      [A.purchase!, B.line!],
    ],
  ],
]

describe('no cascading or nulling foreign key crosses from one account into another', () => {
  it('the set of cascading/nulling edges between owned tables is exactly the set this suite constructs', async () => {
    const res = await db.query<{ edge: string }>(`
      with owned as (
        select rel.relname
          from pg_constraint con
          join pg_class rel on rel.oid = con.conrelid
         where con.contype = 'f' and con.confrelid = 'auth.users'::regclass
           and rel.relnamespace = 'public'::regnamespace
      )
      select c.relname || '.' || a.attname || ' -> ' || p.relname as edge
        from pg_constraint con
        join pg_class c on c.oid = con.conrelid
        join pg_class p on p.oid = con.confrelid
        join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
       where con.contype = 'f'
         and c.relnamespace = 'public'::regnamespace and p.relnamespace = 'public'::regnamespace
         and con.confdeltype in ('c', 'n')
         and c.relname in (select relname from owned)
         and p.relname in (select relname from owned)
       order by 1`)
    const edges = res.rows
      .map((r) => r.edge)
      .filter((e) => {
        const [child, parent] = e.split(' -> ') as [string, string]
        return !ADMIN_RECORDS.has(child.split('.')[0]!) && !ADMIN_RECORDS.has(parent)
      })
      .sort()
    expect(edges).toEqual(COVERED_EDGES)
  })

  describe('and each one is refused when the two rows have different owners', () => {
    let a: SyntheticUser
    let b: SyntheticUser
    let A: Ids
    let B: Ids

    beforeAll(async () => {
      a = await createSyntheticUser(service, 'xref-a')
      b = await createSyntheticUser(service, 'xref-b')
      created.push(a, b)
      await seedAccountLedger(service, a, await signInAs(a), 'xref-a')
      await seedAccountLedger(service, b, await signInAs(b), 'xref-b')
      const pick = async (uid: string): Promise<Ids> => ({
        tag: await scalar('select id from tags where user_id = $1', [uid]),
        retailer: await scalar('select id from retailers where user_id = $1', [uid]),
        location: await scalar('select id from storage_locations where user_id = $1', [uid]),
        collection: await scalar('select id from custom_collections where user_id = $1', [uid]),
        holding: await scalar(
          'select h.id from holdings h join holding_tags t on t.holding_id = h.id where h.user_id = $1',
          [uid],
        ),
        purchase: await scalar('select id from purchases where user_id = $1 limit 1', [uid]),
        line: await scalar('select id from purchase_lines where user_id = $1 limit 1', [uid]),
        lot: await scalar('select id from acquisition_lots where user_id = $1 limit 1', [uid]),
      })
      A = await pick(a.id)
      B = await pick(b.id)
    }, 120_000)

    it.each(CASES.map(([edge]) => edge))('%s', async (edge) => {
      const build = CASES.find(([e]) => e === edge)![1]
      const [sql, params] = build({ A, B, b: b.id })
      await expect(db.query(sql, params)).rejects.toThrow(/must (match|belong)/)
    })

    it("so deleting A leaves every one of B's rows byte-identical, through the real deletion path", async () => {
      const before = await ownedDigests(db, b.id)
      const token = (await (await signInAs(a)).auth.getSession()).data.session!.access_token
      const res = await handleAccountDeletion(realDeps(service), {
        bearerToken: token,
        body: { expectedUserId: a.id, password: a.password, confirm: true },
      })
      expect(res.status).toBe(200)
      expect(await ownedDigests(db, b.id)).toEqual(before)
    }, 120_000)
  })
})

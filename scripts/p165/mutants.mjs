/**
 * P165 mutants — independent perturbations of the P164 integrated tree, each written for the seam's
 * OWN failure (not the P164 list re-run), applied one at a time by the P151 runner. A mutant is KILLED
 * only by a real assertion failure or a hang timeout, never by a compile/load error; every file is
 * restored byte-for-byte (SHA-256 verified). Run on a disposable copy of the tree, with a stack in the
 * environment for the `config`-tagged database suites:
 *
 *   node scripts/scanner-p151/run-mutations.mjs --mutants scripts/p165/mutants.mjs [--only P1a,P2a]
 *
 * Layers that are redundant on purpose (the lease is checked in the token provider AND after the
 * session lookup; the export checks the lease before and after every request) cannot be told apart
 * by removing ONE of them: a survivor there would be the design working. The mutants below therefore
 * remove the layer a specific test claims to witness, and say which.
 */
const DB = 'vitest.db.config.ts'

const FIXTURE_LEASE = 'tests/db/p165_scanner_fixture_lease.test.ts'
const COMMIT_LEASE = 'tests/db/p165_scanner_commit_lease.test.ts'
const EXPORT_OVERLAP = 'tests/db/p165_export_overlap.test.ts'
const SETTLE = 'tests/db/p165_settle_derived_tables.test.ts'
const REAL_FUNCTION = 'tests/data/p165-search-prices-real-function.test.ts'

export const MUTANTS = [
  {
    id: 'P1a',
    what: 'fixture cross-test identity: a spec inserts its OWN copy of the printed card again (the P164 collision)',
    file: 'tests/e2e/authenticated/price-check-ledger.spec.ts',
    find: '  scannerCard = await acquireScannerFixtureCard(DB_URL, seedCatalog.cardSetId)\n',
    replace:
      "  await pgClient.query(\n    `insert into public.cards (id, set_id, local_id, name) values ('c0000000-0000-0000-0000-000000000f01', $1, '049', 'Fauxosaur EX')`,\n    [seedCatalog.cardSetId],\n  )\n",
    tests: ['tests/config/e2e-fixture-isolation.test.ts'],
  },
  {
    id: 'P1b',
    what: 'fixture ownership: the first spec to finish deletes the printed card although another still holds a lease',
    file: 'tests/e2e/authenticated/support/scanner-fixture-card.ts',
    find: '        if (last.rows[0]?.got === true) {',
    replace: '        if (last.rows[0] !== undefined) {',
    tests: [FIXTURE_LEASE],
    config: DB,
  },
  {
    id: 'P1c',
    what: 'fixture creation names only the primary key again: concurrent holders collide on (set_id, local_id)',
    file: 'tests/e2e/authenticated/support/scanner-fixture-card.ts',
    find: "     values ($1, $2, $3, $4, 'Double Rare', 'Pokemon', 'en', $5)\n     on conflict do nothing`,",
    replace:
      "     values ($1, $2, $3, $4, 'Double Rare', 'Pokemon', 'en', $5)\n     on conflict (id) do nothing`,",
    tests: [FIXTURE_LEASE],
    config: DB,
  },
  {
    id: 'P2a',
    what: 'the leased client hands out whatever token the session holds now: the lease is gone from the scanner write path',
    file: 'src/data/leased-client.ts',
    find: '    const session = await sessionForLease(lease, () => deps.getSession())\n    lease.assertCurrent()\n    return session.access_token\n',
    replace:
      '    const answer = await deps.getSession()\n    return answer.data.session?.access_token ?? null\n',
    tests: [COMMIT_LEASE],
    config: DB,
  },
  {
    id: 'P2b',
    what: 'a session that belongs to somebody else is accepted for the lease (storage rewritten before this tab heard)',
    file: 'src/auth/identity-lease.ts',
    find: '  if (session.user.id !== lease.userId) {',
    replace: '  if (false as boolean) {',
    tests: [COMMIT_LEASE],
    config: DB,
  },
  {
    id: 'P3',
    what: 'read-only Price Check port leaks the whole controller (commitBatch reachable)',
    file: 'src/features/scanner/scanner-identification.ts',
    find: 'export function toReadOnlyScannerPort(controller: ScannerUiController): ReadOnlyScannerPort {\n  return {\n',
    replace:
      'export function toReadOnlyScannerPort(controller: ScannerUiController): ReadOnlyScannerPort {\n  return {\n    ...controller,\n',
    tests: ['tests/ui/p165-read-only-scanner-runtime.test.ts'],
  },
  {
    id: 'P4a',
    what: 'Price Check ignores the transport rewrite marker: a rounded number quoted by the guard is shown as a price',
    file: 'src/data/price-check.ts',
    find: '  if (invoked.response?.headers.get(EXACT_TRANSPORT_REWRITE_HEADER) != null) {',
    replace: '  if (false as boolean) {',
    tests: [REAL_FUNCTION],
  },
  {
    id: 'P4b',
    what: 'the legacy pricing consumer ignores the transport rewrite marker',
    file: 'src/data/pricing.ts',
    find: '    if (invoked.response?.headers.get(EXACT_TRANSPORT_REWRITE_HEADER) != null) return new Map()\n',
    replace: '',
    tests: [REAL_FUNCTION],
  },
  {
    id: 'P4c',
    what: 'the transport guard no longer marks the response it rewrote (the marker is lost at the source)',
    file: 'src/data/exact-json-guard.ts',
    find: '    headers.set(EXACT_TRANSPORT_REWRITE_HEADER, String(literals.length))\n',
    replace: '',
    tests: [REAL_FUNCTION],
  },
  {
    id: 'P5',
    what: 'a card with several active printings is auto-resolved to the first one',
    file: 'src/domain/price-check/identity.ts',
    find: '  if (active.length === 1 && onlyActive !== undefined) {',
    replace: '  if (active.length >= 1 && onlyActive !== undefined) {',
    tests: ['tests/domain/price-check/p165-variant-resolution.test.ts'],
  },
  {
    id: 'P8',
    what: 'the scan session no longer checks its abort signal: a scan abandoned by a newer one still delivers',
    file: 'src/features/price-check/scan-session.ts',
    find: "      if (isAborted(controller.signal)) return { status: 'abandoned' }\n",
    replace: '',
    tests: ['tests/ui/p165-scan-session-latest-wins.test.ts'],
  },
  {
    id: 'P6a',
    what: 'the delivery gate only checks that a lease EXISTS: an ended lease (A -> B) still hands files to the browser',
    file: 'src/features/export/fileDelivery.ts',
    find: "  if (lease === null || !lease.isCurrent()) return { status: 'stale' }",
    replace: "  if (lease === null) return { status: 'stale' }",
    tests: ['tests/ui/export-file-delivery.test.ts'],
  },
  {
    id: 'P6b',
    what: "A's export is not re-checked after its answer: an identity change during the LAST request goes unnoticed",
    file: 'src/data/export/identity-guard.ts',
    find: '    assertUnchanged() {\n      lease.assertCurrent()\n      return Promise.resolve()\n    },',
    replace: '    assertUnchanged() {\n      return Promise.resolve()\n    },',
    tests: [EXPORT_OVERLAP],
    config: DB,
  },
  {
    id: 'P7',
    what: 'settling the recompute queue is "drain once" again: it returns while another worker still holds the rows',
    file: 'tests/e2e/authenticated/support/settle-derived-tables.ts',
    find: '    if ((due.rows[0]?.n ?? 0) === 0) return',
    replace: '    return',
    tests: [SETTLE],
    config: DB,
  },
]

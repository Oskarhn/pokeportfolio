/**
 * P180 §14: `seed-local-backend.mts` used to unconditionally create brand-new synthetic users and
 * overwrite `.local-backend/fixture.json` on every run, with no check for an existing fixture. Every
 * re-run (a restarted stack, a second session, a retry after an unrelated failure) silently orphaned
 * the PREVIOUS run's users and their holdings — including the rich 40-holding "user B" P179 found
 * missing — and any credentials a person had copied out of that earlier fixture.json into a doc or a
 * terminal history went stale with no warning. This module is the pure decision behind the guard
 * that now sits in front of every fixture-writing seed script; kept separate from any script so it
 * is testable without Docker or a database. Plain CommonJS (not `.mjs`) specifically so Jest can
 * `require()` it directly, the same way tests/unit's other `scripts/*` unit tests already do.
 *
 * Four states, never a silent fifth:
 *   'create'    no existing fixture — always safe, always proceeds.
 *   'reuse'     an existing fixture, `--reuse` passed — leaves it untouched, prints its path.
 *   'overwrite' an existing fixture, `--force` passed — proceeds, but the caller is expected to
 *               print an explicit "the previous users are now orphaned" warning (not silent).
 *   'blocked'   an existing fixture, neither flag passed — the caller must refuse and explain.
 */

function decideFixtureAction({ exists, force, reuse }) {
  if (!exists) return 'create'
  if (reuse) return 'reuse'
  if (force) return 'overwrite'
  return 'blocked'
}

/** The refusal message for the 'blocked' case — one place, so every seed script that adopts this
 *  guard explains itself identically. */
function blockedMessage(fixturePath, previousSummary) {
  return (
    `refusing to overwrite an existing fixture at ${fixturePath}` +
    (previousSummary === undefined ? '' : ` (${previousSummary})`) +
    `.\nRe-running this script creates BRAND NEW synthetic users and orphans the old ones and their ` +
    `holdings — the exact "documented credentials went stale" hazard this guard exists to catch.\n` +
    `Pass --reuse to keep the existing fixture unchanged, or --force to intentionally replace it ` +
    `(the old users' rows are not deleted, only no longer referenced by fixture.json).`
  )
}

module.exports = { decideFixtureAction, blockedMessage }

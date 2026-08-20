/**
 * The bigint <-> PostgREST boundary.
 *
 * Postgres `bigint` money columns (FINANCIAL_MODEL.md §1) are serialized by PostgREST as plain
 * JSON numbers by default, and JSON/JS numbers only carry exact integer precision up to
 * Number.MAX_SAFE_INTEGER (2^53 - 1) — verified against the actual local Supabase stack in
 * tests/db/money-boundary.test.ts, not assumed. Every query that selects a money column MUST
 * cast it to text in the select list (e.g. `.select('total_minor::text')`) so PostgREST returns
 * a JSON string instead, which parses to an exact bigint via BigInt(). The same applies in
 * reverse: a bigint must be serialized to a decimal string, never passed as a raw JS number,
 * when it is written back.
 *
 * No repository/query code exists yet to apply this at (src/data/ arrives with M5+ feature
 * work) — this module is the boundary contract those queries must use.
 */

export function parseMinorUnits(value: string): bigint {
  return BigInt(value)
}

export function serializeMinorUnits(value: bigint): string {
  return value.toString()
}

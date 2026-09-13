/**
 * P120 §12/§48: large-scale property proof for allocate_largest_remainder.
 *
 * Independent oracle: src/domain/allocation.ts's `allocate()` — genuinely independent of the
 * plpgsql implementation (native unbounded BigInt arithmetic, no intermediate-overflow path to
 * share a bug with; a from-scratch TS port of the documented largest-remainder-method contract in
 * FINANCIAL_MODEL.md §4.2, not a copy of the SQL source). Comparison runs as ONE batched SQL
 * statement (a VALUES list built from the generated cases) rather than one RPC per case, so
 * 100,000+ cases execute in seconds instead of the ~30-80 minutes per-case HTTP round trips would
 * take — this is what makes the requested scale actually achievable in one session.
 *
 * Usage: pnpm exec tsx scripts/p120-largest-remainder-oracle.ts [caseCount] [seed]
 */
import { writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { allocate } from '../src/domain/allocation'

const CASE_COUNT = Number(process.argv[2] ?? 100_000)
const SEED = Number(process.argv[3] ?? 120117)
const LARGE_N_CASES = 1000 // dedicated subset exercising 10-100 weights (§11's line-count dimension)

// mulberry32 — deterministic, reproducible across runs given the same seed.
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rand = mulberry32(SEED)
const randInt = (max: number) => Math.floor(rand() * max)

const BIGINT_MAX = 9223372036854775807n
const BOUNDARY_POOL: bigint[] = [
  0n,
  1n,
  2n,
  100n,
  2147483647n, // 2^31-1
  2147483648n, // 2^31
  2147483649n,
  9007199254740991n, // 2^53-1
  9007199254740992n, // 2^53
  9007199254740993n, // 2^53+1
  3037000499n, // floor(sqrt(bigint max)) — P117's discovered per-operand overflow threshold
  922337203685477580n, // ~bigint max / 10
  BIGINT_MAX,
]

function at<T>(arr: readonly T[], idx: number): T {
  const v = arr[idx]
  if (v === undefined) throw new Error(`index ${idx} out of bounds (length ${arr.length})`)
  return v
}

function randomBigint(): bigint {
  // 40% boundary-pool value, 60% genuinely random magnitude (log-uniform-ish via random bit width).
  if (rand() < 0.4) return at(BOUNDARY_POOL, randInt(BOUNDARY_POOL.length))
  const bits = 1 + randInt(63) // 1..63 bits
  let v = 0n
  for (let i = 0; i < bits; i += 30) {
    v = (v << 30n) | BigInt(randInt(1 << 30))
  }
  return v & 0x7fffffffffffffffn // stay non-negative, within bigint range
}

function randomWeights(n: number): bigint[] {
  const weights: bigint[] = []
  for (let i = 0; i < n; i++) weights.push(randomBigint())
  // Deliberately force ties in a slice of cases: duplicate one weight.
  if (n >= 2 && rand() < 0.2) weights[randInt(n)] = at(weights, 0)
  return weights
}

interface Case {
  id: number
  total: bigint
  weights: bigint[]
  expected: bigint[]
}

const cases: Case[] = []
let oracleThrows = 0

function makeCase(id: number, n: number): Case | null {
  const weights = randomWeights(n)
  let total = randomBigint()
  if (total > BIGINT_MAX) total = BIGINT_MAX
  try {
    const expected = allocate(total, weights)
    return { id, total, weights, expected }
  } catch {
    oracleThrows++
    return null
  }
}

let nextId = 1
for (let i = 0; i < CASE_COUNT - LARGE_N_CASES; i++) {
  const n = 1 + randInt(8) // typical purchase/sale/opening line counts
  const c = makeCase(nextId, n)
  if (c) {
    cases.push(c)
    nextId++
  }
}
for (let i = 0; i < LARGE_N_CASES; i++) {
  const n = 10 + randInt(91) // 10..100 — §11's "1-100 lines" upper range
  const c = makeCase(nextId, n)
  if (c) {
    cases.push(c)
    nextId++
  }
}

console.log(`Generated ${cases.length} cases (oracle threw on ${oracleThrows} — expected 0)`)

function bigintArrayLiteral(arr: bigint[]): string {
  return `ARRAY[${arr.join(',')}]::bigint[]`
}

const sqlLines: string[] = []
sqlLines.push('create temporary table p120_lr_cases (')
sqlLines.push('  case_id integer primary key,')
sqlLines.push('  total bigint not null,')
sqlLines.push('  weights bigint[] not null,')
sqlLines.push('  expected bigint[] not null')
sqlLines.push(');')
sqlLines.push('')

const BATCH = 2000
for (let i = 0; i < cases.length; i += BATCH) {
  const chunk = cases.slice(i, i + BATCH)
  const values = chunk
    .map(
      (c) =>
        `(${c.id}, ${c.total}, ${bigintArrayLiteral(c.weights)}, ${bigintArrayLiteral(c.expected)})`,
    )
    .join(',\n')
  sqlLines.push(`insert into p120_lr_cases (case_id, total, weights, expected) values\n${values};`)
}

sqlLines.push('')
sqlLines.push(`create or replace function pg_temp.safe_lr(p_total bigint, p_weights bigint[])
returns table(ok boolean, actual bigint[], err text)
language plpgsql
as $fn$
begin
  ok := true;
  err := null;
  begin
    actual := public.allocate_largest_remainder(p_total, p_weights);
  exception when others then
    ok := false;
    err := SQLERRM;
    actual := null;
  end;
  return next;
end;
$fn$;`)
sqlLines.push('')
sqlLines.push('select count(*) as total_cases from p120_lr_cases;')
sqlLines.push(
  'select c.case_id, c.total, c.weights, c.expected, r.actual, r.err ' +
    'from p120_lr_cases c, lateral pg_temp.safe_lr(c.total, c.weights) r ' +
    'where r.err is not null or r.actual is distinct from c.expected ' +
    'limit 50;',
)
sqlLines.push(
  'select ' +
    'count(*) filter (where r.err is not null) as function_errors, ' +
    'count(*) filter (where r.err is null and r.actual is distinct from c.expected) as mismatch_count, ' +
    'count(*) filter (where r.err is null and array_length(r.actual, 1) <> array_length(c.weights, 1)) as wrong_length, ' +
    'count(*) filter (where r.err is null and (select sum(x) from unnest(r.actual) x) <> c.total) as wrong_sum, ' +
    'count(*) filter (where r.err is null and exists (select 1 from unnest(r.actual) x where x < 0)) as negative_share ' +
    'from p120_lr_cases c, lateral pg_temp.safe_lr(c.total, c.weights) r;',
)

const sqlPath = 'scripts/.p120-lr-oracle.generated.sql'
writeFileSync(sqlPath, sqlLines.join('\n'))
console.log(`Wrote ${sqlPath} (${(sqlLines.join('\n').length / 1e6).toFixed(2)} MB)`)

const output = execFileSync(
  'docker',
  ['exec', '-i', 'supabase_db_pokeportfolio', 'psql', '-U', 'postgres', '-d', 'postgres'],
  { input: sqlLines.join('\n'), maxBuffer: 1024 * 1024 * 256 },
).toString()
console.log(output)

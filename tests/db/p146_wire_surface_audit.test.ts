import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { rawSqlAvailable, runRawSqlAsync } from './raw-sql'

/**
 * P146 / P130-19 — the wire surface, audited from the catalog rather than from memory.
 *
 * `pg_proc` is asked for every function a browser client can call (`authenticated` or `anon` has
 * EXECUTE). Money must reach the client as text (src/data/money.ts), so:
 *
 *   A. no client-called function returns a bigint / bigint[] / numeric money value as a JSON
 *      number — every `*_minor` result column is `text`;
 *   B. a client-called function that returns a whole ROW of a money table (purchases, sales, ...)
 *      is always followed by an explicit `.select('<columns>::text ...')` in src, so the bigint
 *      columns of that row never travel as JSON numbers;
 *   C. the only exposed functions that still return raw bigint money are server-internal helpers,
 *      named here, that no client code calls.
 */

const RAW = rawSqlAvailable()

interface ExposedFunction {
  name: string
  result: string
}

async function exposedFunctions(): Promise<ExposedFunction[]> {
  const sql = `
    select p.proname || '|' || pg_get_function_result(p.oid)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and (has_function_privilege('authenticated', p.oid, 'execute')
        or has_function_privilege('anon', p.oid, 'execute'))
    order by 1;`
  const { code, output } = await runRawSqlAsync(sql)
  if (code !== 0) throw new Error(output)
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const bar = line.indexOf('|')
      return { name: line.slice(0, bar), result: line.slice(bar + 1) }
    })
}

/** `TABLE(a text, b bigint, ...)` -> [['a','text'], ['b','bigint']]; other result shapes -> []. */
function tableColumns(result: string): [string, string][] {
  const match = /^TABLE\((.*)\)$/.exec(result)
  if (!match) return []
  return (match[1] as string).split(', ').map((part) => {
    const space = part.indexOf(' ')
    return [part.slice(0, space), part.slice(space + 1)] as [string, string]
  })
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.(ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}

const SRC = join(__dirname, '..', '..', 'src')
const SRC_TEXT = walk(SRC)
  .filter((f) => !f.endsWith('database.types.ts'))
  .map((f) => readFileSync(f, 'utf8'))
  // Comments mention `.rpc('create_sale')` in prose; only code counts as a call site.
  .map((text) =>
    text
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:'"`])\/\/.*$/gm, (_match, lead: string) => lead),
  )
  .join('\n')

/** Functions the client invokes through PostgREST, read from the source. */
const CLIENT_CALLED = new Set([...SRC_TEXT.matchAll(/\.rpc\(\s*'([a-z_0-9]+)'/g)].map((m) => m[1]))

/** Money-bearing row types a function can return as a whole. */
const MONEY_ROW_TYPES = new Set([
  'purchases',
  'sales',
  'openings',
  'manual_valuations',
  'acquisition_lots',
])

/** Non-money bigint result columns (counts and quantities). */
const NON_MONEY_BIGINT = /^(?:quantity|lot_count|qty_[a-z_]+|variant_count|total_count)$/

/** Server-internal helpers: exposed because create_/update_ RPCs run as the caller, never called
 *  from the browser. They return raw bigint money and must stay out of src. */
const INTERNAL_HELPERS = new Set([
  'allocate_largest_remainder',
  'allocate_largest_remainder_signed',
  'allocate_purchase_discount',
  'money_minor_to_nok_minor',
])

describe.skipIf(!RAW)('P130-19 — money wire surface (catalog audit)', () => {
  it('finds the functions it is meant to audit (the audit is not vacuous)', async () => {
    const fns = await exposedFunctions()
    expect(fns.length).toBeGreaterThan(30)
    expect(fns.map((f) => f.name)).toContain('get_dashboard_summary')
    expect(CLIENT_CALLED.size).toBeGreaterThan(20)
  })

  it('every client-called function is a function that exists and is exposed', async () => {
    const exposed = new Set((await exposedFunctions()).map((f) => f.name))
    const missing = [...CLIENT_CALLED].filter((name) => !exposed.has(name as string))
    expect(missing).toEqual([])
  })

  it('A. every *_minor column a function returns is text — never bigint or numeric', async () => {
    const offenders: string[] = []
    for (const fn of await exposedFunctions()) {
      if (INTERNAL_HELPERS.has(fn.name)) continue
      for (const [column, type] of tableColumns(fn.result)) {
        if (/_minor$/.test(column) && type !== 'text') {
          offenders.push(`${fn.name}.${column} is ${type}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('A2. no client-called function returns an unnamed bigint/numeric/bigint[] scalar', async () => {
    const offenders = (await exposedFunctions())
      .filter((fn) => CLIENT_CALLED.has(fn.name))
      .filter((fn) => /^(?:bigint|numeric|bigint\[\]|numeric\[\])$/.test(fn.result))
      .map((fn) => `${fn.name} returns ${fn.result}`)
    expect(offenders).toEqual([])
  })

  it('A3. every bigint column a client-called function returns is a count or a quantity', async () => {
    const offenders: string[] = []
    for (const fn of await exposedFunctions()) {
      if (!CLIENT_CALLED.has(fn.name)) continue
      for (const [column, type] of tableColumns(fn.result)) {
        if (/^bigint(?:\[\])?$/.test(type) && !NON_MONEY_BIGINT.test(column)) {
          offenders.push(`${fn.name}.${column} is ${type}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('B. a client-called function returning a whole money row is always followed by .select(...)', async () => {
    const rowReturning = (await exposedFunctions()).filter(
      (fn) => CLIENT_CALLED.has(fn.name) && MONEY_ROW_TYPES.has(fn.result),
    )
    // The set is real: these are the functions whose response would otherwise carry every bigint
    // column of the row as a JSON number.
    expect(rowReturning.map((fn) => fn.name).sort()).toEqual(
      [
        'create_opening',
        'create_opening_from_provisional',
        'create_purchase',
        'create_sale',
        'reconcile_opening_cost',
        'set_manual_valuation',
        'set_sealed_lot_intent',
        'update_purchase',
        'update_sale',
      ].sort(),
    )
    const offenders: string[] = []
    for (const fn of rowReturning) {
      for (const match of SRC_TEXT.matchAll(new RegExp(`\\.rpc\\(\\s*'${fn.name}'`, 'g'))) {
        const after = SRC_TEXT.slice(match.index + match[0].length)
        // The statement ends at the first `;` or blank-line-separated declaration; the select must
        // come before the call's result is awaited/destructured further.
        const statement = after.split(/\n\n|;\n/)[0] as string
        if (!/\.select\(/.test(statement)) offenders.push(`${fn.name}: no .select(...) after .rpc`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('C. the raw-bigint helpers are server-internal: the client never calls them', async () => {
    const exposed = await exposedFunctions()
    const called = [...INTERNAL_HELPERS].filter((name) => CLIENT_CALLED.has(name))
    expect(called).toEqual([])
    // ... and the list is complete: any other exposed function returning raw bigint money is a
    // new unsafe wire path and must be classified here on purpose.
    const undeclared = exposed
      .filter((fn) => /^(?:bigint|bigint\[\])$/.test(fn.result) && !INTERNAL_HELPERS.has(fn.name))
      .map((fn) => fn.name)
    expect(undeclared).toEqual([])
  })
})

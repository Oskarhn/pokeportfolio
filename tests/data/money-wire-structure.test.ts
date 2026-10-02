import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * P146 / P130-19 — structural guards for the money wire contract (src/data/money.ts, D-137).
 *
 * The behavioural proof lives in tests/db/p146_*.test.ts (real PostgREST, real Postgres). These
 * static checks exist because the failure they prevent is silent: a value above 2^53 that turns
 * into a slightly different number raises no error anywhere, so the only reliable defence is to
 * make the wrong SHAPE of code impossible to merge. Each rule fails with the offending file, line
 * and the rule it broke.
 */

const ROOT = join(__dirname, '..', '..')
const SRC = join(ROOT, 'src')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.(ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}

interface SourceFile {
  path: string // posix-style, relative to the repo root
  text: string
  lines: string[]
}

function load(files: string[]): SourceFile[] {
  return files.map((full) => {
    const text = readFileSync(full, 'utf8')
    return { path: relative(ROOT, full).split(sep).join('/'), text, lines: text.split('\n') }
  })
}

const ALL_SRC = load(walk(SRC)).filter((f) => f.path !== 'src/data/database.types.ts')
const DATA = ALL_SRC.filter((f) => f.path.startsWith('src/data/') && !f.path.includes('/scanner/'))

/** The source with line comments and block comments blanked (line structure preserved), so rules
 *  match code and not the prose that explains why the code looks the way it does. */
function code(file: SourceFile): string[] {
  const blanked = file.text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/.*$/gm, (m, lead: string) => lead + ' '.repeat(m.length - lead.length))
  return blanked.split('\n')
}

function findAll(files: SourceFile[], pattern: RegExp): string[] {
  const hits: string[] = []
  for (const file of files) {
    code(file).forEach((line, index) => {
      if (pattern.test(line)) hits.push(`${file.path}:${index + 1}: ${line.trim()}`)
    })
  }
  return hits
}

describe('S1 — no Number() of a money value anywhere in the data layer', () => {
  it('src/data never converts a *Minor / minorUnits value with Number()', () => {
    expect(findAll(DATA, /\bNumber\([^)]*(?:Minor|_minor|minorUnits)[^)]*\)/)).toEqual([])
  })

  it('src/data never uses parseInt/parseFloat/unary-plus/Math.round on money', () => {
    expect(
      findAll(DATA, /(?:parseInt|parseFloat|Math\.(?:round|floor|trunc))\([^)]*(?:Minor|_minor)/),
    ).toEqual([])
  })
})

describe('S2 — the only Number(<money>) left in src is display-only, and is named here', () => {
  /** file -> exactly how many `Number(...Minor...)` calls it may contain, and why. */
  const ALLOWED: Record<string, { count: number; why: string }> = {
    'src/domain/dashboard.ts': {
      count: 4,
      why: 'chartMajorUnits (a chart coordinate), the period-change percentage and the 0-100 bar ratios',
    },
    'src/ui/PriceHistoryChart.tsx': {
      count: 4,
      why: 'SVG polyline geometry and the percentage label on the price history sparkline',
    },
  }

  it('matches the allowlist exactly — a new conversion must be argued here, not slipped in', () => {
    const pattern =
      /\bNumber\((?:[^)(]|\([^)]*\))*(?:Minor|minorUnits|\bminor\b|Value\b)(?:[^)(]|\([^)]*\))*\)/g
    const actual: Record<string, number> = {}
    for (const file of ALL_SRC) {
      const matches = code(file).join('\n').match(pattern)
      if (matches) actual[file.path] = matches.length
    }
    const expected = Object.fromEntries(Object.entries(ALLOWED).map(([f, v]) => [f, v.count]))
    expect(actual).toEqual(expected)
  })
})

describe('S3 — every money column in a select list is cast ::text', () => {
  /** A string literal that lists columns (a comma) and mentions a `_minor` column. Single-token
   *  literals are filter/order arguments, not select lists. */
  function selectLists(file: SourceFile): { line: number; literal: string }[] {
    const found: { line: number; literal: string }[] = []
    const pattern = /(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g
    code(file).forEach((line, index) => {
      for (const match of line.matchAll(pattern)) {
        const literal = match[2] as string
        if (/_minor\b/.test(literal) && literal.includes(','))
          found.push({ line: index + 1, literal })
      }
    })
    return found
  }

  it('no plain bigint money column in any select list under src/data', () => {
    const offenders: string[] = []
    for (const file of DATA) {
      for (const { line, literal } of selectLists(file)) {
        for (const token of literal.matchAll(/\b([a-z][a-z_]*_minor)\b(?!::text)/g)) {
          offenders.push(`${file.path}:${line}: ${token[1]} is selected without ::text`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('finds the select lists it is meant to police (the rule is not vacuous)', () => {
    const total = DATA.reduce((sum, file) => sum + selectLists(file).length, 0)
    expect(total).toBeGreaterThanOrEqual(10)
  })
})

describe('S4 — money leaves the client as text', () => {
  it('every p_*_minor RPC argument goes through moneyArg / optionalMoneyArg', () => {
    const offenders: string[] = []
    for (const file of DATA) {
      const body = code(file).join('\n')
      for (const match of body.matchAll(
        /\bp_[a-z_]*_minor\s*:\s*([\s\S]*?)(?:,\s*\n|\n\s*\}\)|\n\s*\})/g,
      )) {
        const rhs = match[1] as string
        if (!/\b(?:moneyArg|optionalMoneyArg)\(/.test(rhs)) {
          offenders.push(`${file.path}: ${match[0].trim().slice(0, 90)}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('every *_minor field of a jsonb / row payload is serialised with serializeMinorUnits', () => {
    const offenders: string[] = []
    for (const file of DATA) {
      code(file).forEach((line, index) => {
        // An object-literal key at the start of a line, or a property assignment — not a read
        // (`=== null`), a `::text` cast or a string literal.
        const assignment =
          /^\s*(?!p_)[a-z][a-z_]*_minor\s*:(?!:)\s*(.*)$/.exec(line) ??
          /\.[a-z][a-z_]*_minor\s*=(?!=)\s*(.*)$/.exec(line)
        if (!assignment) return
        const rhs = assignment[1] as string
        const isTypeDeclaration = /^(?:string|number|bigint|null|\|)/.test(rhs) || rhs === ''
        if (isTypeDeclaration) return
        // `minorUnits(` is the backup export's own exact, branded parser (src/data/export).
        if (!/(?:serialize(?:Optional)?MinorUnits|\bminorUnits)\(/.test(rhs)) {
          offenders.push(`${file.path}:${index + 1}: ${line.trim()}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })

  it('the data layer has no BigInt(): every parse goes through parseMinorUnits', () => {
    const allowed = new Set(['src/data/money.ts', 'src/data/exact-json-guard.ts'])
    expect(
      findAll(
        DATA.filter((f) => !allowed.has(f.path)),
        /\bBigInt\(/,
      ),
    ).toEqual([])
  })
})

describe('S5 — every Supabase client the app builds is the guarded one', () => {
  it('createClient( is called only by src/data/supabase-factory.ts', () => {
    const users = findAll(ALL_SRC, /\bcreateClient\s*[<(]/).map((hit) => hit.split(':')[0])
    expect([...new Set(users)]).toEqual(['src/data/supabase-factory.ts'])
  })

  it('the factory installs the exact-transport fetch on EVERY client it builds', () => {
    // P147 (D-138): the factory builds two kinds of client — the shared app client and the
    // accessToken client of an identity lease. Each createClient call must be paired with the
    // guarded fetch, so a third construction path cannot be added without the guard.
    const factory = ALL_SRC.find((f) => f.path === 'src/data/supabase-factory.ts')
    const clients = factory?.text.match(/\bcreateClient\s*</g) ?? []
    const guarded =
      factory?.text.match(/global:\s*\{\s*fetch:\s*createExactTransportFetch\(/g) ?? []
    expect(clients.length).toBe(2)
    expect(guarded.length).toBe(clients.length)
  })

  it('the app client is built by the factory', () => {
    const client = ALL_SRC.find((f) => f.path === 'src/data/supabase-client.ts')
    expect(client?.text).toMatch(/createAppSupabaseClient\(/)
  })

  it('the identity-lease client is built by the factory, not by its own createClient', () => {
    const leased = ALL_SRC.find((f) => f.path === 'src/data/leased-client.ts')
    expect(leased?.text).toMatch(/createAccessTokenSupabaseClient\(/)
    expect(leased?.text).not.toMatch(/\bcreateClient\b/)
  })
})

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * P145 — the coverage ledger of the in-flight identity guard, kept as a test so it cannot rot.
 *
 * The guard is only as good as its reach. The compiler already refuses to hand the shared Supabase
 * client to a write function that takes a `LeasedDb`; what a compiler cannot see is a NEW write
 * function that simply never asks for one, or a NEW `useMutation` that bypasses the lease hook.
 * These checks read the source (the same pattern as identity-switch-mount-lifecycle.test.ts) and
 * fail with the name of the offender:
 *
 *   1. Every mutation in the UI is a leased mutation; the ONE raw `useMutation` is a public
 *      exchange-rate lookup that writes nothing.
 *   2. Every function under src/data that WRITES (insert/update/delete/upsert, or an RPC whose name
 *      says it writes) takes `db: LeasedDb` and never touches the shared client in its body.
 *   3. The UI reaches Supabase directly only in the documented read/auth places.
 *   4. The wiring that gives a lease meaning is present: the authority is fed by the auth callback,
 *      retired at sign-out, leased at `mutate()`, and the token provider checks user AND lease.
 */

const ROOT = join(__dirname, '..', '..')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path))
    else if (/\.(ts|tsx)$/.test(name)) out.push(path)
  }
  return out
}

const rel = (path: string) => relative(ROOT, path).replaceAll('\\', '/')
const read = (path: string) => readFileSync(path, 'utf8')

function matchClose(text: string, openIndex: number, open: string, close: string): number {
  let depth = 0
  for (let i = openIndex; i < text.length; i += 1) {
    if (text[i] === open) depth += 1
    else if (text[i] === close) {
      depth -= 1
      if (depth === 0) return i
    }
  }
  throw new Error('unbalanced source')
}

interface FunctionSource {
  file: string
  name: string
  params: string
  body: string
}

/** Every `export async function` / `export function` of a module, with its parameter list and body. */
function functionsOf(path: string): FunctionSource[] {
  const text = read(path)
  const found: FunctionSource[] = []
  const pattern = /export (?:async )?function (\w+)\(/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const open = match.index + match[0].length - 1
    const close = matchClose(text, open, '(', ')')
    let i = close + 1
    let angle = 0
    while (i < text.length) {
      const ch = text[i]
      if (ch === '<') angle += 1
      else if (ch === '>' && text[i - 1] !== '=') angle -= 1
      else if (ch === '{' && angle === 0) break
      i += 1
    }
    const end = matchClose(text, i, '{', '}')
    found.push({
      file: rel(path),
      name: match[1] ?? '',
      params: text.slice(open + 1, close),
      body: text.slice(i, end + 1),
    })
  }
  return found
}

const WRITE_RPC =
  /\.rpc\(\s*'(?:create|update|void|add|reduce|remove|set|clear|reset|reconcile|revoke)_/
const WRITE_TABLE_CALL = /\.(?:insert|update|delete|upsert)\(/

const FEATURES = sourceFiles(join(ROOT, 'src', 'features'))
const DATA = sourceFiles(join(ROOT, 'src', 'data')).filter(
  (path) =>
    !/leased-(client|db)\.ts$|supabase-client\.ts$|database\.types\.ts$/.test(path) &&
    !path.includes(join('src', 'data', 'export')),
)

describe('every mutation in the UI runs under an identity lease', () => {
  it('has no raw useMutation outside the lease hook, except the read-only exchange-rate preview', () => {
    const offenders: string[] = []
    for (const path of sourceFiles(join(ROOT, 'src'))) {
      if (rel(path) === 'src/auth/useLeasedMutation.ts') continue
      const text = read(path)
      const count = (text.match(/\buseMutation\(/g) ?? []).length
      if (count === 0) continue
      if (rel(path) === 'src/features/purchases/PurchaseFormPage.tsx' && count === 1) {
        // The Norges Bank preview button: reads a public rate into the form, writes nothing.
        expect(text).toMatch(
          /const fxQuery = useMutation\(\{\s*mutationFn: \(\) =>\s*fetchFxRate\(/,
        )
        continue
      }
      offenders.push(`${rel(path)} (${String(count)})`)
    }
    expect(
      offenders,
      'use useLeasedMutation / useLeasedAction, see src/auth/useLeasedMutation.ts',
    ).toEqual([])
  })

  it('every leased mutation function routes its requests through leasedDb(lease) or a lease-taking seam', () => {
    for (const path of FEATURES) {
      const text = read(path)
      const uses = /useLeased(?:Mutation|Action)\(\{/.test(text)
      if (!uses) continue
      const usesLease =
        /leasedDb\(lease\)/.test(text) || /,\s*lease\)/.test(text) || /\(\s*lease\s*\)/.test(text)
      expect(usesLease, `${rel(path)} declares a leased mutation but never uses its lease`).toBe(
        true,
      )
    }
  })
})

describe('every data function that writes takes a leased client', () => {
  it('finds the write functions this check is about (guards against a parser that sees nothing)', () => {
    const writers = DATA.flatMap(functionsOf).filter(
      (fn) => WRITE_RPC.test(fn.body) || WRITE_TABLE_CALL.test(fn.body),
    )
    const names = writers.map((fn) => fn.name)
    for (const expected of [
      'createPurchase',
      'updatePurchase',
      'voidPurchase',
      'createSale',
      'updateSale',
      'createOpening',
      'createProvisionalOpening',
      'createManualCard',
      'addCardAcquisition',
      'reduceHoldingQuantity',
      'updateMyProfile',
      'resetMyPortfolioData',
      'createCustomSealedProduct',
    ]) {
      expect(names).toContain(expected)
    }
  })

  it('declares `db: LeasedDb` and never references the shared client', () => {
    const problems: string[] = []
    for (const fn of DATA.flatMap(functionsOf)) {
      const writes = WRITE_RPC.test(fn.body) || WRITE_TABLE_CALL.test(fn.body)
      if (!writes) continue
      if (!/\bdb: LeasedDb\b/.test(fn.params))
        problems.push(`${fn.file}: ${fn.name} takes no LeasedDb`)
      if (/\bsupabase\b/.test(fn.body))
        problems.push(`${fn.file}: ${fn.name} touches the shared client`)
    }
    expect(problems).toEqual([])
  })

  it('the exchange-rate lookup used inside a mutation is handed the leased client', () => {
    for (const file of [
      'src/features/purchases/PurchaseFormPage.tsx',
      'src/features/sales/SaleFormPage.tsx',
      'src/features/sales/SaleEditPage.tsx',
    ]) {
      const text = read(join(ROOT, file))
      const calls = [...text.matchAll(/fetchFxRate\(([^)]*)\)/g)].map((m) => m[1] ?? '')
      const insideMutation = calls.filter((args) => !/fxMode|currency as/.test(args))
      expect(insideMutation.length, `${file} has no fx step to check`).toBeGreaterThan(0)
      for (const args of insideMutation) expect(args, file).toMatch(/,\s*db\s*$/)
    }
  })
})

describe('the UI reaches Supabase directly only where no lease is meaningful', () => {
  it('documents every direct use outside src/data and src/auth', () => {
    const direct = new Set<string>()
    for (const path of FEATURES) {
      for (const m of read(path).matchAll(/\bsupabase\s*\.(from|rpc|functions|auth)\b/g)) {
        direct.add(`${rel(path)}:${m[1] ?? ''}`)
      }
    }
    expect([...direct].sort()).toEqual([
      // A read (the admin's invitation list): nothing is written.
      'src/features/admin/InvitationsPage.tsx:from',
      // Signed-out flows: they have no identity to lease (recovery mail, redemption, new password).
      'src/features/auth/ForgotPasswordPage.tsx:auth',
      'src/features/auth/InvitePage.tsx:functions',
      // (and its public invitation-status read, an RPC that answers for a token, not for a user)
      'src/features/auth/InvitePage.tsx:rpc',
      'src/features/auth/ResetPasswordPage.tsx:auth',
    ])
  })
})

describe('the wiring that gives a lease its meaning', () => {
  const authProvider = read(join(ROOT, 'src', 'auth', 'AuthProvider.tsx'))
  const leasedMutation = read(join(ROOT, 'src', 'auth', 'useLeasedMutation.ts'))
  const leasedClient = read(join(ROOT, 'src', 'data', 'leased-client.ts'))
  const lease = read(join(ROOT, 'src', 'auth', 'identity-lease.ts'))

  it('AuthProvider feeds the authority from the same callback as the cache boundary', () => {
    const observe = authProvider.slice(authProvider.indexOf('const observeIdentity'))
    expect(observe.indexOf('identity.observe(')).toBeGreaterThan(-1)
    expect(observe.indexOf('identity.observe(')).toBeLessThan(
      observe.indexOf('applyAuthIdentityBoundary('),
    )
  })

  it('AuthProvider retires the identity when this tab starts signing out, before the network call', () => {
    const signOut = authProvider.slice(authProvider.indexOf('const signOut = useCallback'))
    expect(signOut.indexOf('identity.retire()')).toBeGreaterThan(-1)
    expect(signOut.indexOf('identity.retire()')).toBeLessThan(
      signOut.indexOf('endAuthenticatedSession('),
    )
  })

  it('a lease is taken at mutate() for the user the UI was rendered under', () => {
    expect(leasedMutation).toContain('identity.begin(renderedUserId)')
    expect(leasedMutation).toMatch(/lease\.isCurrent\(\)/)
  })

  it('the token provider hands out a token only for the lease owner and revokes otherwise', () => {
    expect(leasedClient).toContain('lease.assertCurrent()')
    expect(leasedClient).toContain('session.user.id !== lease.userId')
    expect(leasedClient).toContain('lease.revoke()')
  })

  it('same-user events never change the identity epoch, and the epoch is not derived from a token', () => {
    expect(lease).toContain('if (userId === this.currentUserId) return false')
    expect(lease).not.toMatch(/access_token|refresh_token/)
  })
})

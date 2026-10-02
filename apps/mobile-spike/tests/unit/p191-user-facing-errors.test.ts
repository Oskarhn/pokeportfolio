import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { classifyFailure, type FailureKind } from '../../src/net/failure'

/**
 * P130-26 (native half). A screen renders a {@link classifyFailure} result, whose text is fixed; it
 * never renders an error's own message. These are representative injected backend/transport
 * failures — the strings PostgREST, Postgres and fetch produce — plus a static audit that fails when
 * a UI file starts reading `<error>.message` outside the reviewed allowlist.
 */

const TECHNICAL =
  /sqlstate|pgrst|postgrest|postgres|supabase|duplicate key|violates|row-level security|constraint|public\.|functions\/v1|rest\/v1|stack trace|jwt|typeerror|relation "|column "|\bat \S+ \(/i

function postgrest(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code, details: null, hint: null })
}

const INJECTED: { name: string; error: unknown; kind: FailureKind }[] = [
  {
    name: 'unique violation',
    error: postgrest(
      'duplicate key value violates unique constraint "holdings_identity_idx"',
      '23505',
    ),
    kind: 'unknown',
  },
  {
    name: 'RLS refusal',
    error: postgrest('new row violates row-level security policy for table "purchases"', '42501'),
    kind: 'unknown',
  },
  {
    name: 'JWT rejection',
    error: postgrest('JWT expired', 'PGRST301'),
    kind: 'unauthorized',
  },
  {
    name: 'schema cache miss',
    error: postgrest(
      'Could not find the function public.create_purchase(p_lines) in the schema cache',
      'PGRST202',
    ),
    kind: 'unknown',
  },
  {
    name: 'fetch failure with a URL',
    error: new TypeError('Network request failed: https://x.supabase.co/rest/v1/rpc/create_sale'),
    kind: 'offline',
  },
  {
    name: 'HTTP 502 with a body',
    error: Object.assign(new Error('HttpStatusError: HTTP 502 {"message":"upstream"}'), {
      name: 'HttpStatusError',
      status: 502,
    }),
    kind: 'server',
  },
  {
    name: 'stack-bearing error',
    error: new Error('boom\n    at run (index.bundle:1:2)'),
    kind: 'unknown',
  },
]

describe('P130-26 native — injected backend failures reach the screen as fixed text', () => {
  for (const { name, error, kind } of INJECTED) {
    it(`${name} → ${kind}`, () => {
      const failure = classifyFailure(error)
      expect(failure.kind).toBe(kind)
      expect(failure.message).not.toMatch(TECHNICAL)
      // The text is the fixed sentence for the kind: nothing of the input is echoed.
      const raw = (error as Error).message
      expect(failure.message).not.toContain(raw)
    })
  }
})

describe('P130-26 native — UI sources do not render raw error messages', () => {
  const ROOTS = ['src/ui', 'src/features', 'src/account', 'App.tsx']
  const READ = /\.message\b/

  /** Reads that are not an Error's own text; each says why. */
  const ALLOWED: Record<string, string> = {
    'src/ui/AppRoot.tsx': 'session.notice is a classifyFailure Failure (fixed text)',
    'src/ui/components.tsx': 'failure is a classifyFailure Failure (fixed text)',
    'src/ui/screens/AddAcquisitionScreen.tsx':
      'guarded by instanceof InvalidMoneyInputError/InvalidEventDateError',
    'src/ui/screens/LoginScreen.tsx': 'invalid_credentials copy and a Failure (fixed text)',
    'src/ui/screens/ManualValuationScreen.tsx': 'guarded by instanceof InvalidMoneyInputError',
    'src/ui/screens/ProfileScreen.tsx': 'session.notice is a Failure (fixed text)',
    'src/ui/screens/RecordOpeningScreen.tsx': 'guarded by instanceof validation errors',
    'src/ui/screens/RecordPurchaseScreen.tsx': 'guarded by instanceof validation errors',
    'src/ui/screens/RecordSaleScreen.tsx': 'guarded by instanceof validation errors',
    'src/features/catalog-search/CatalogSearchScreen.tsx':
      'state.failure is a Failure (fixed text)',
    'src/features/price-check/CardPriceScreen.tsx': 'state.card.failure is a Failure (fixed text)',
    'src/features/scanner-native/recognition-pipeline.ts':
      'abstain messages are authored here; the error status reason is never rendered (PhotoEntryScreen shows fixed copy)',
    'src/account/account-deletion-controller.ts':
      'only AuthIdentityChanged/AuthCredentialsUnavailable (fixed text); everything else is UNKNOWN',
    'App.tsx': 'developer build refusal (backend-config), not a runtime backend error',
  }

  function walk(path: string): string[] {
    if (!statSync(path).isDirectory()) return [path]
    return readdirSync(path).flatMap((name) => walk(join(path, name)))
  }
  const files = ROOTS.flatMap((root) => walk(join(__dirname, '../..', root)))
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .map((f) => f.replace(/\\/g, '/'))
  const rel = (f: string) => f.slice(f.indexOf('/mobile-spike/') + '/mobile-spike/'.length)

  it('scans the UI sources (not vacuous)', () => {
    expect(files.length).toBeGreaterThan(20)
  })

  it('every .message read is on the reviewed allowlist', () => {
    const unreviewed = files.filter(
      (f) =>
        readFileSync(f, 'utf8')
          .split('\n')
          .some((line) => !/^\s*(\*|\/\/)/.test(line) && READ.test(line)) && !(rel(f) in ALLOWED),
    )
    expect(unreviewed.map(rel)).toEqual([])
  })

  it('allowlist entries are not stale', () => {
    for (const key of Object.keys(ALLOWED)) {
      const file = files.find((f) => rel(f) === key)
      expect(file).toBeDefined()
      expect(READ.test(readFileSync(file!, 'utf8'))).toBe(true)
    }
  })

  it('mutation: a new setError(error.message) in a screen would be flagged', () => {
    expect(READ.test('setError(error.message)')).toBe(true)
  })
})

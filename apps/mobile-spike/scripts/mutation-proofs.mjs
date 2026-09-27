#!/usr/bin/env node
/**
 * Mutation proofs (P158 §15). Each mutant breaks ONE safety mechanism in the source, runs the
 * relevant tests, and must be KILLED by at least one assertion failure (a test that FAILS, not a
 * compile error: Babel does not type-check, so a kill here is always a behavioural failure). The file
 * is restored in a `finally`, and the run ends by asserting the working tree is byte-identical to
 * what it was when the run started.
 *
 *   node scripts/mutation-proofs.mjs            run all mutants (unit + shared tests; no Docker)
 *   node scripts/mutation-proofs.mjs --only M1  run one mutant
 *
 * Requires a clean apps/mobile-spike working tree at start (commit or stash first).
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(appRoot, '.build')
mkdirSync(outDir, { recursive: true })

/** @type {{id:string, title:string, file:string, edits:[string,string][], tests:string[]}[]} */
const MUTANTS = [
  {
    id: 'M1',
    title: 'remove the identity-bound reset (A state survives into B)',
    file: 'src/wiring/runtime.ts',
    edits: [['registry.resetAll()', 'void 0']],
    tests: ['tests/unit/identity-isolation.test.ts', 'tests/unit/native-app.test.tsx'],
  },
  {
    id: 'M2',
    title: 'format money through Number() (loses digits above 2^53)',
    file: 'src/money/format-money.ts',
    edits: [
      [
        'const whole = dot === -1 ? decimal : decimal.slice(0, dot)',
        'const whole = String(Number(dot === -1 ? decimal : decimal.slice(0, dot)))',
      ],
    ],
    tests: ['tests/unit/format-money.test.ts'],
  },
  {
    id: 'M3a',
    title: 'NULL formatted as zero',
    file: 'src/money/format-money.ts',
    edits: [
      [
        'if (value === null || value === undefined) return ABSENT',
        "if (value === null || value === undefined) return formatMoney({ minorUnits: 0n, currency: 'NOK' })",
      ],
    ],
    tests: ['tests/unit/format-money.test.ts', 'tests/unit/native-app.test.tsx'],
  },
  {
    id: 'M3b',
    title: 'NULL holding value read as zero in the collection adapter',
    file: 'src/collection/shared-data-adapter.ts',
    edits: [
      [
        'holdingValueMinor: tile.holdingValueMinor,',
        'holdingValueMinor: tile.holdingValueMinor ?? 0n,',
      ],
    ],
    tests: ['tests/unit/shared-data-reuse.test.ts'],
  },
  {
    id: 'M4a',
    title: 'accept an unsafe JSON integer in a response (rounded amount reaches the UI)',
    file: 'src/net/exact-transport-guard.ts',
    edits: [
      ['if (literal !== null) throw new UnsafeNumericResponseError(literal)', 'void literal'],
    ],
    tests: ['tests/unit/money-transport.test.ts', 'tests/unit/shared-data-reuse.test.ts'],
  },
  {
    id: 'M4b',
    title: 'accept an unsafe JSON number as money in the wire parser',
    file: 'src/money/wire.ts',
    edits: [['if (!Number.isSafeInteger(value)) {', 'if (false as boolean) {']],
    tests: ['tests/unit/money-transport.test.ts', 'tests/unit/price-check.test.ts'],
  },
  {
    id: 'M5',
    title: 'price the WRONG catalog variant (first variant instead of the chosen one)',
    file: 'src/state/price-check-store.ts',
    edits: [
      [
        'await this.lookup(data.card.cardId, resolution.variant.variantId)',
        'await this.lookup(data.card.cardId, data.variants[0]?.variantId ?? resolution.variant.variantId)',
      ],
    ],
    tests: ['tests/unit/price-check.test.ts', 'tests/unit/native-app.test.tsx'],
  },
  {
    id: 'M6a',
    title: 'Price Check imports an acquisition module',
    file: 'src/price-check/released-adapter.ts',
    edits: [
      [
        "import { getCardVariantPriceHistory } from '@shared/data/pricing'",
        "import { getCardVariantPriceHistory } from '@shared/data/pricing'\nimport { createPurchase } from '@shared/data/purchases'\nvoid createPurchase",
      ],
    ],
    tests: ['tests/unit/price-check.test.ts'],
  },
  {
    id: 'M6b',
    title: 'read-only request policy disabled (a financial write RPC would reach the wire)',
    file: 'src/net/spike-fetch.ts',
    edits: [['assertReadOnlyRequest(method, url)', 'void method']],
    tests: ['tests/unit/shared-data-reuse.test.ts'],
  },
  {
    id: 'M7a',
    title: 'stale response for A is committed after B signed in',
    file: 'src/state/lease-run.ts',
    edits: [
      [
        "const value = await work()\n    if (!lease.isCurrent()) return { kind: 'stale' }",
        'const value = await work()',
      ],
    ],
    tests: ['tests/unit/identity-isolation.test.ts'],
  },
  {
    id: 'M7b',
    title: 'stale FAILURE for A is committed after B signed in',
    file: 'src/state/lease-run.ts',
    edits: [
      [
        "    if (!lease.isCurrent()) return { kind: 'stale' }\n    if (error instanceof AuthIdentityChangedError)",
        '    if (error instanceof AuthIdentityChangedError)',
      ],
    ],
    tests: ['tests/unit/identity-isolation.test.ts'],
  },
  {
    id: 'M8',
    title: 'a Production / non-local backend URL is accepted',
    file: 'src/config/backend-config.ts',
    edits: [
      ['if (PRODUCTION_HOSTS.some((pattern) => pattern.test(host))) {', 'if (false as boolean) {'],
      ['if (!isLocalHost(host)) {', 'if (false as boolean) {'],
    ],
    tests: ['tests/unit/backend-config.test.ts'],
  },
  // ---- P167 Android hardening -----------------------------------------------------------------
  {
    id: 'M9',
    title: 'F1: the expo-modules-core launcher re-registration patch is no longer applied',
    file: 'pnpm-workspace.yaml',
    edits: [['  expo-modules-core@57.0.18: patches/expo-modules-core@57.0.18.patch\n', '']],
    tests: ['tests/unit/p167-platform.test.tsx'],
  },
  {
    id: 'M10',
    title: 'F1 fallback: an unregistered launcher is reported as a retryable error',
    file: 'src/photo/expo-photo-port.ts',
    edits: [["return 'restart_required'", "return 'error'"]],
    tests: ['tests/unit/expo-photo-port.test.ts'],
  },
  {
    id: 'M11',
    title: 'F7: the keyboard covers Sign in again (no avoiding behaviour on Android)',
    file: 'src/ui/screens/LoginScreen.tsx',
    edits: [
      [
        "export const KEYBOARD_BEHAVIOR = 'padding' as const",
        'export const KEYBOARD_BEHAVIOR = undefined',
      ],
    ],
    tests: ['tests/unit/p167-platform.test.tsx'],
  },
  {
    id: 'M11b',
    title: 'F7: the keyboard action key submits an empty field (sign-in with an empty password)',
    file: 'src/ui/screens/LoginScreen.tsx',
    edits: [["if (busy || email.trim() === '' || password === '') return", 'if (busy) return']],
    tests: ['tests/unit/p167-platform.test.tsx'],
  },
  {
    id: 'M12',
    title: 'F5: navigation chrome not bound to the system scheme (light bars in dark mode)',
    file: 'src/ui/AppRoot.tsx',
    edits: [['        theme={navTheme}\n', '']],
    tests: ['tests/unit/p167-dark-theme.test.tsx'],
  },
  {
    id: 'M13',
    title: 'F3: tabs fall back to the missing-glyph icon (no icon, icon slot shown)',
    file: 'src/ui/MainNavigator.tsx',
    edits: [
      ['    tabBarIcon: () => null,\n', ''],
      ["        tabBarIconStyle: { display: 'none' },\n", ''],
    ],
    tests: ['tests/unit/p167-platform.test.tsx'],
  },
  {
    id: 'M14',
    title: 'photo: an identity change no longer purges orphaned picker copies (A file under B)',
    file: 'src/photo/photo-store.ts',
    edits: [['      await this.purgeOrphans()\n    })()', '    })()']],
    tests: ['tests/unit/photo-store.test.ts'],
  },
  {
    id: 'M15',
    title: 'navigation memory not identity-scoped (B could be restored into A screens)',
    file: 'src/wiring/runtime.ts',
    edits: [["  registry.register('navigation', navigation)\n", '']],
    tests: ['tests/unit/activity-recreation.test.tsx'],
  },
  {
    id: 'M16',
    title: 'collection rows not memoised (every page re-renders every mounted row)',
    file: 'src/ui/screens/CollectionScreen.tsx',
    edits: [['const Row = memo(function Row(', 'const Row = (function Row(']],
    tests: ['tests/unit/collection-render.test.tsx'],
  },
  {
    id: 'M17',
    title: 'F4: a wrapping amount is one unbreakable word again (splits inside a digit group)',
    file: 'src/ui/components.tsx',
    edits: [["return formatted.replace(/[\\u00A0\\u202F]/g, ' ')", 'return formatted']],
    tests: ['tests/unit/p167-platform.test.tsx', 'tests/unit/native-app.test.tsx'],
  },
  {
    id: 'M18',
    title: 'F5: navigation-bar style no longer follows a live dark switch (plugin dropped)',
    file: 'app.json',
    edits: [['      "./plugins/with-navigation-bar-follows-theme",\n', '']],
    tests: ['tests/unit/navigation-bar-plugin.test.ts'],
  },

  // ---------------------------------------------------------------------------------------------
  // P175 finance write-seam mutants (output_175.txt MUTATION CAMPAIGN, items 1-18). Backend-only
  // invariants that a source mutation cannot exercise without Docker (opening's "no second spend",
  // #9) are proven instead by tests/backend/write-seam.test.ts against the real RPC surface — noted
  // per mutant below rather than forced into this no-Docker runner.
  {
    id: 'P1',
    title: '#1 blank money input becomes 0n instead of null',
    file: 'src/write/money-input.ts',
    edits: [["if (normalized === '') return null", "if (normalized === '') return 0n"]],
    tests: ['tests/unit/money-input.test.ts'],
  },
  {
    id: 'P2',
    title: '#2 money serialised through Number() instead of an exact decimal string',
    file: 'src/write/money-wire.ts',
    edits: [['  return value.toString()\n}', '  return String(Number(value))\n}']],
    tests: ['tests/unit/money-wire.test.ts'],
  },
  {
    id: 'P3',
    title: '#3 JPY exponent treated as 2 instead of 0',
    file: '../../src/domain/currency.ts',
    edits: [
      ["JPY: { code: 'JPY', minorUnitExponent: 0 }", "JPY: { code: 'JPY', minorUnitExponent: 2 }"],
    ],
    tests: ['tests/unit/money-input.test.ts'],
  },
  {
    id: 'P4',
    title: '#4 identity-lease bypass in the write client (accessToken skips sessionForLease)',
    file: 'src/write/leased-write-client.ts',
    edits: [
      [
        '    const session = await sessionForLease(lease, () => deps.getSession())\n    lease.assertCurrent()\n    return session.access_token',
        '    const { data } = await deps.getSession()\n    return data.session?.access_token ?? null',
      ],
    ],
    tests: ['tests/unit/leased-write-client.test.ts'],
  },
  {
    id: 'P5',
    title: '#5 idempotency key regenerated on a FAILED submit (a retry would no longer be a retry)',
    file: 'src/state/write-form-store.ts',
    edits: [
      [
        "      this.set({ status: 'error', failure })\n      return { ok: false, failure }",
        "      this.set({ status: 'error', failure, idempotencyKey: generateIdempotencyKey() })\n      return { ok: false, failure }",
      ],
    ],
    tests: ['tests/unit/write-form-store.test.ts'],
  },
  {
    id: 'P6',
    title:
      '#6 double submit is no longer refused (a fast double-tap could reach the network twice)',
    file: 'src/state/write-form-store.ts',
    edits: [
      [
        "    if (this.state.status === 'submitting') {\n      return { ok: false, failure: classifyFailure(new Error('already submitting')) }\n    }\n",
        '',
      ],
    ],
    tests: ['tests/unit/write-form-store.test.ts'],
  },
  {
    id: 'P7',
    title: '#7 an unknown acquisition cost basis sends 0 instead of omitting the amount',
    file: 'src/write/collection-writes.ts',
    edits: [
      [
        'p_unit_cost_basis_minor: optionalMoneyArg(input.unitCostBasisMinor),',
        'p_unit_cost_basis_minor: optionalMoneyArg(input.unitCostBasisMinor ?? 0n),',
      ],
    ],
    tests: ['tests/unit/write-rpc-wire.test.ts'],
  },
  {
    id: 'P8',
    title: '#8 the client rejects a valid negative sale net instead of leaving it to the server',
    file: 'src/write/sale-writes.ts',
    edits: [
      [
        'db: LeasedWriteDb,\n): Promise<Sale> {\n  const { data, error } = await db',
        "db: LeasedWriteDb,\n): Promise<Sale> {\n  const grossTotal = lines.reduce((sum, l) => sum + l.unitGrossMinor * BigInt(l.quantity), 0n)\n  if (grossTotal - (input.feesMinor ?? 0n) < 0n) {\n    throw new Error('net proceeds cannot be negative')\n  }\n  const { data, error } = await db",
      ],
    ],
    tests: ['tests/unit/write-rpc-wire.test.ts'],
  },
  {
    id: 'P9',
    title:
      '#9 opening a sealed lot creates a second spend (NOT source-mutable without Docker — proven instead by ' +
      'tests/backend/write-seam.test.ts\'s "create_opening" test, which asserts the source lot\'s ' +
      'purchase_line_id is byte-identical before and after opening, against the real RPC)',
    file: 'src/write/opening-writes.ts',
    edits: [['p_pulls: undefined,', 'p_pulls: undefined, // see output_175.txt P9 note']],
    tests: ['tests/unit/write-rpc-wire.test.ts'],
  },
  {
    id: 'P10',
    title: '#10 clearing a manual valuation is silently rewritten as "set it to 0"',
    file: 'src/write/collection-writes.ts',
    edits: [
      [
        "const { error } = await db.rpc('clear_manual_valuation', { p_holding_id: holdingId })",
        "const { error } = await db.rpc('set_manual_valuation', { p_holding_id: holdingId, p_value_minor: 0 })",
      ],
    ],
    tests: ['tests/unit/write-rpc-wire.test.ts'],
  },
  {
    id: 'P11',
    title: "#11 A's draft survives under B (reset() no longer clears the draft)",
    file: 'src/state/write-form-store.ts',
    edits: [
      [
        "  reset(): void {\n    this.seq += 1\n    this.state = {\n      status: 'editing',\n      draft: this.initialDraft(),\n      idempotencyKey: generateIdempotencyKey(),\n      failure: null,\n    }\n    this.emitter.emit()\n  }",
        '  reset(): void {\n    this.seq += 1\n  }',
      ],
    ],
    tests: ['tests/unit/write-form-store.test.ts'],
  },
  {
    id: 'P12',
    title: 'A -> B -> A resurrects the first A draft (ensureContext no longer compares contextKey)',
    file: 'src/state/write-form-store.ts',
    edits: [
      [
        '    const nextKey = freshDraft().contextKey\n    if (this.state.draft.contextKey === nextKey) return',
        '    freshDraft()\n    return',
      ],
    ],
    tests: ['tests/unit/write-form-store.test.ts'],
  },
  {
    id: 'P13',
    title: '#13 a same-user token refresh wrongly clears every write-form draft',
    file: 'src/auth/auth-controller.ts',
    edits: [
      [
        'if (this.deps.authority.observe(userId)) this.deps.onIdentityChange(userId)',
        'if (this.deps.authority.observe(userId)) {\n      /* no-op */\n    }\n    this.deps.onIdentityChange(userId)',
      ],
    ],
    tests: ['tests/unit/auth-identity.test.ts', 'tests/unit/identity-isolation.test.ts'],
  },
  {
    id: 'P14',
    title: "#14 a sale line is written against the WRONG lot (always the first line's lot)",
    file: 'src/write/sale-writes.ts',
    edits: [['lot_id: line.lotId,', 'lot_id: lines[0].lotId,']],
    tests: ['tests/unit/write-rpc-wire.test.ts'],
  },
  {
    id: 'P15',
    title: '#15 the purchase preview stops calling the shared discount allocator',
    file: 'src/ui/screens/RecordPurchaseScreen.tsx',
    edits: [
      [
        "import { allocatePurchaseCharges } from '@shared/domain/allocation'",
        '// allocatePurchaseCharges import removed',
      ],
      [
        'const allocation = allocatePurchaseCharges',
        'const allocation = ((): never => { throw new Error("unused") })',
      ],
    ],
    tests: ['tests/unit/record-purchase-uses-shared-allocator.test.ts'],
  },
  {
    id: 'P16',
    title:
      '#16 a completed-event date shifts by one day because it is read via UTC, not local time',
    file: 'src/write/event-date.ts',
    edits: [
      [
        'return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`',
        'return date.toISOString().slice(0, 10)',
      ],
    ],
    tests: ['tests/unit/event-date.test.ts'],
  },
  {
    id: 'P17',
    title: '#17 the Add-acquisition screen writes merely on open (no explicit confirm)',
    file: 'src/ui/screens/AddAcquisitionScreen.tsx',
    edits: [
      [
        'writeForms.acquisition.ensureContext(() => initialAcquisitionDraft(variantId))',
        "writeForms.acquisition.ensureContext(() => initialAcquisitionDraft(variantId)); void writeForms.acquisition.submit(session.userId, (db) => db.rpc('add_card_acquisition', {}))",
      ],
    ],
    tests: ['tests/unit/native-app.test.tsx'],
  },
  {
    id: 'P18',
    title: "#18 Price Check's read-only RPC allow-list is widened to include a finance write RPC",
    file: 'src/net/spike-fetch.ts',
    edits: [
      [
        "  'get_card_variant_price_history',\n])",
        "  'get_card_variant_price_history',\n  'create_purchase',\n])",
      ],
    ],
    tests: ['tests/unit/read-only-vs-write-policy.test.ts'],
  },
  {
    id: 'P19',
    title:
      '#19 (P177, device-found) money-input parses through Number() instead of the exact decimal parser',
    file: 'src/write/money-input.ts',
    edits: [
      [
        'return fromDecimalString(normalized, currency).minorUnits',
        'return BigInt(Math.round(Number(normalized) * 100))',
      ],
    ],
    tests: ['tests/unit/money-input.test.ts'],
  },
  {
    id: 'P20',
    title:
      '#20 (P177, device-found) RecordPurchaseScreen omits condition on its card line again (the real bug this phase found and fixed)',
    file: 'src/ui/screens/RecordPurchaseScreen.tsx',
    edits: [[`gradingState: 'raw',\n              condition: 'NM',\n`, '']],
    tests: ['tests/unit/record-purchase-uses-shared-allocator.test.ts'],
  },
  {
    id: 'P21',
    title:
      '#21 (P177, device-found) CardDetailScreen reverts to a plain useEffect (stops reloading on focus)',
    file: 'src/ui/screens/CardDetailScreen.tsx',
    edits: [
      ["import { useCallback } from 'react'", "import { useCallback, useEffect } from 'react'"],
      ["import { useFocusEffect } from '@react-navigation/native'\n", ''],
      [
        'useFocusEffect(\n    useCallback(() => {\n      void holdingDetail.load(holdingId)\n    }, [holdingDetail, holdingId]),\n  )',
        'useEffect(() => {\n    void holdingDetail.load(holdingId)\n  }, [holdingDetail, holdingId])',
      ],
    ],
    tests: ['tests/unit/card-detail-reloads-on-focus.test.ts'],
  },
]

const only = process.argv.includes('--only')
  ? process.argv[process.argv.indexOf('--only') + 1]
  : null

function git(args) {
  return spawnSync('git', args, { cwd: appRoot, encoding: 'utf8' })
}

function isClean() {
  return git(['status', '--porcelain', '--', '.']).stdout.trim() === ''
}

if (!isClean()) {
  console.error('working tree of apps/mobile-spike is not clean; commit or stash first')
  process.exit(2)
}

function runJest(tests) {
  // No --json: the JSON reporter itself throws on a failing BigInt assertion in the parent process.
  return spawnSync(
    'pnpm',
    [
      'exec',
      'jest',
      '--selectProjects',
      'unit',
      '--verbose',
      // In-band + tests/support/bigint-json.ts keep failing BigInt assertions readable (jest#11617).
      '--runInBand',
      ...tests,
    ],
    { cwd: appRoot, encoding: 'utf8', shell: process.platform === 'win32' },
  )
}

/** Names of tests that FAILED, from the verbose reporter ("  × name (12 ms)"). */
function failedNames(output) {
  return [...output.matchAll(/^\s+×\s+(.*?)(?:\s+\(\d+ ms\))?\r?$/gm)].map((m) => m[1])
}

// Baseline: every mutant's test files must pass unmutated, or a "kill" would mean nothing.
const baselineFiles = [...new Set(MUTANTS.flatMap((m) => m.tests))]
const baseline = runJest(baselineFiles)
if (baseline.status !== 0) {
  console.error('baseline run FAILED; refusing to run mutants')
  process.exit(2)
}

const results = []
for (const m of MUTANTS) {
  if (only !== null && m.id !== only) continue
  const path = join(appRoot, m.file)
  const original = readFileSync(path, 'utf8')
  let mutated = original
  for (const [find, replace] of m.edits) {
    if (mutated.split(find).length !== 2) {
      console.error(`${m.id}: pattern not found exactly once in ${m.file}: ${find.slice(0, 60)}`)
      process.exit(2)
    }
    mutated = mutated.replace(find, () => replace)
  }
  try {
    writeFileSync(path, mutated)
    const r = runJest(m.tests)
    const failed = failedNames(`${r.stdout}
${r.stderr}`)
    const suiteCrash = r.status !== 0 && failed.length === 0
    results.push({
      id: m.id,
      title: m.title,
      file: m.file,
      killed: r.status !== 0 && failed.length > 0,
      // A suite that failed to even load is NOT accepted as a kill.
      suiteCrash,
      failingTests: failed.slice(0, 6),
      failingCount: failed.length,
    })
  } finally {
    writeFileSync(path, original)
  }
  const last = results[results.length - 1]
  console.log(
    `${m.id} ${last.killed ? 'KILLED  ' : 'SURVIVED'} ${m.title} (${last.failingCount} failing)`,
  )
}

const clean = isClean()
writeFileSync(
  join(outDir, 'mutation-results.json'),
  JSON.stringify({ results, treeCleanAfter: clean }, null, 2),
)
console.log(
  `\nmutants killed: ${results.filter((r) => r.killed).length}/${results.length}; tree clean afterwards: ${clean}`,
)
process.exit(results.every((r) => r.killed) && clean ? 0 : 1)

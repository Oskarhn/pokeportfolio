#!/usr/bin/env node
/**
 * P173 cross-track mutation proofs. Each mutant plants ONE defect at the seam between the P167
 * runtime hardening and the P169 Search / Price Check feature, runs the whole `unit` project, and
 * must make it FAIL by an ASSERTION (a failing test), never by a build error: a mutant whose run
 * reports "Test suite failed to run" (syntax/import error) or fails no test is INVALID, not killed.
 * Every file is restored in a finally block, and the run ends by checking `git diff` of every
 * mutated file is empty.
 *
 *   node scripts/p173/mutations.mjs [regex-of-mutant-ids]
 *
 * Result: .build/p173-mutations.json (gitignored) and stdout.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const P = (p) => join(appRoot, p)
const only = process.argv[2] ? new RegExp(process.argv[2], 'i') : null

const MUTANTS = [
  {
    id: 'A',
    name: 'P169 stores removed from the identity registry',
    file: 'src/features/feature.ts',
    from: "  deps.registry.register('p169-catalog-search', search)\n  deps.registry.register('p169-price-lookup', prices)\n  deps.registry.register('p169-price-check', priceCheck)\n",
    to: '',
  },
  {
    id: 'B',
    name: 'the first printing is accepted automatically',
    file: 'src/features/price-check/price-check-flow-store.ts',
    from: 'const resolution = resolveVariant(outcome.value.variants, variantId)',
    to: 'const resolution = resolveVariant(outcome.value.variants, variantId ?? outcome.value.variants[0]?.variantId)',
  },
  {
    id: 'C',
    name: 'NULL money rendered as zero (shell MoneyText)',
    file: 'src/ui/components.tsx',
    from: '  const text = formatMoney(value)\n  return (\n    <Text\n      testID={testID}\n      accessibilityLabel={value === null',
    to: "  const text = formatMoney(value ?? { minorUnits: 0n, currency: 'NOK' })\n  return (\n    <Text\n      testID={testID}\n      accessibilityLabel={value === null",
  },
  {
    id: 'D',
    name: 'unsafe JSON number guard bypassed',
    file: 'src/net/exact-transport-guard.ts',
    from: 'if (digits.length >= 16 && BigInt(digits) > MAX_SAFE) return token',
    to: 'if (digits.length >= 16 && BigInt(digits) > MAX_SAFE) void token',
  },
  {
    id: 'E',
    name: 'graded price derived from the raw price (x3)',
    file: 'src/features/price-check/price-lookup.ts',
    from: 'graded: gradedSection({ sources: [], observations: [], dropped: [] }),',
    to: "graded: gradedSection({ sources: [{ id: 'derived', label: 'derived', state: 'ok' }], observations: raw.status === 'observations' ? raw.rows.map((r) => ({ ...r.observation, subject: { type: 'graded' as const, company: 'PSA' as const, grade: '10', qualifier: null }, price: { ...r.observation.price, minorUnits: r.observation.price.minorUnits * 3n } })) : [], dropped: [] }),",
  },
  {
    id: 'F',
    name: 'a write RPC exposed to the read-only client',
    file: 'src/net/spike-fetch.ts',
    from: "  'get_card_variant_price_history',\n])",
    to: "  'get_card_variant_price_history',\n  'add_card_acquisition',\n])",
  },
  {
    id: 'G',
    name: 'the expo-modules-core image-picker patch is not registered',
    file: 'pnpm-workspace.yaml',
    from: 'expo-modules-core@57.0.18: patches/expo-modules-core@57.0.18.patch',
    to: 'expo-modules-core@57.0.18: patches/none.patch',
  },
  {
    id: 'H',
    name: 'Activity recreation identity preservation removed (navigation is not restored)',
    file: 'src/ui/AppRoot.tsx',
    from: 'restorableNavigationState(runtime.navigation.get()) as InitialState | undefined',
    to: 'undefined as InitialState | undefined',
  },
  {
    id: 'I',
    name: 'a late price answer of A is published after B signed in',
    file: 'src/features/price-check/price-check-flow-store.ts',
    from: 'const stale = controller.signal.aborted || !lease.isCurrent() || this.state.lookup.key !== key',
    to: 'const stale = false',
  },
  {
    id: 'J',
    name: 'an A -> B -> A round trip resurrects a lease of the first A session',
    file: 'src/auth/identity-authority.ts',
    from: 'return this.currentUserId === userId && this.currentEpoch === epoch',
    to: 'return this.currentUserId === userId',
  },
  {
    id: 'K',
    name: 'one touch target shrunk below 48 dp',
    file: 'src/features/ui/kit.tsx',
    from: '        minHeight: TOUCH_48,\n        minWidth: TOUCH_48,\n        paddingHorizontal: SPACE.lg,',
    to: '        minHeight: 44,\n        minWidth: TOUCH_48,\n        paddingHorizontal: SPACE.lg,',
  },
  {
    id: 'L',
    name: 'money above 2^53 converted through Number',
    file: 'src/money/wire.ts',
    from: "      throw new UnsafeMoneyTransportError(field, 'not a plain integer string')\n    }\n    return BigInt(value)",
    to: "      throw new UnsafeMoneyTransportError(field, 'not a plain integer string')\n    }\n    return BigInt(Number(value))",
  },
  {
    id: 'M',
    name: 'the card screen reloads on every mount (a recreation repeats the price request)',
    file: 'src/features/price-check/CardPriceScreen.tsx',
    from: 'void store.enter(cardId, variantId)',
    to: 'void store.openCard(cardId, variantId)',
  },
  {
    id: 'N',
    name: 'leaving the card screen no longer cancels the request or forgets the printing',
    file: 'src/features/price-check/CardPriceScreen.tsx',
    from: "() => navigation.addListener('beforeRemove', () => store.leave()),",
    to: "() => navigation.addListener('beforeRemove', () => undefined),",
  },
  {
    id: 'O',
    name: 'the photo is not deleted when the person leaves the photo entry',
    file: 'src/features/price-check/PhotoEntryScreen.tsx',
    from: '        void feature.photo.release()',
    to: '        void 0',
  },
  {
    id: 'Q',
    name: 'the transient cross-tab instruction is restored (Search jumps back to the photo entry)',
    file: 'src/state/navigation-memory.ts',
    from: '([key]) => !(TRANSIENT_PARAMS as readonly string[]).includes(key),',
    to: '() => true,',
  },
  {
    id: 'P',
    name: 'the feature is registered in a private registry instead of the runtime one',
    file: 'src/wiring/runtime.ts',
    from: 'createP169Feature({ ...deps.priceFeature, authority, registry, photo })',
    to: 'createP169Feature({ ...deps.priceFeature, authority, registry: new ScopedRegistry(), photo })',
  },
]

function jest() {
  const r = spawnSync('pnpm', ['exec', 'jest', '--selectProjects', 'unit', '--bail', '1'], {
    cwd: appRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 128 * 1024 * 1024,
  })
  const out = `${r.stdout}\n${r.stderr}`
  const summary = /Tests:\s+(.*)/.exec(out)?.[1] ?? 'no summary'
  const failedTests = /Tests:\s+(\d+) failed/.exec(out)
  const suiteFailed = /Test suite failed to run/.test(out)
  const failing = [...out.matchAll(/● (.+ › .+)$/gm)].map((m) => m[1])
  const assertion = /expect\(|Expected|Received|toBe|toEqual|toContain/.test(out)
  return {
    status: r.status,
    summary,
    failing: [...new Set(failing)].slice(0, 4),
    suiteFailed,
    failedCount: failedTests ? Number(failedTests[1]) : 0,
    assertion,
  }
}

const results = []
for (const m of MUTANTS) {
  if (only && !only.test(m.id)) continue
  const file = P(m.file)
  const original = readFileSync(file, 'utf8')
  const count = original.split(m.from).length - 1
  if (count !== 1) {
    results.push({
      id: m.id,
      mutant: m.name,
      result: 'NOT_APPLIED',
      detail: `pattern found ${String(count)} times`,
    })
    console.log(JSON.stringify(results.at(-1)))
    continue
  }
  try {
    writeFileSync(file, original.replace(m.from, m.to))
    const r = jest()
    const killed = r.status !== 0 && r.failedCount > 0 && !r.suiteFailed && r.assertion
    results.push({
      id: m.id,
      mutant: m.name,
      result: killed ? 'KILLED' : r.suiteFailed ? 'INVALID_BUILD_ERROR' : 'SURVIVED',
      summary: r.summary,
      failingTests: r.failing,
    })
  } finally {
    writeFileSync(file, original)
  }
  console.log(JSON.stringify(results.at(-1)))
}
const diff = spawnSync('git', ['diff', '--stat', '--', ...new Set(MUTANTS.map((m) => m.file))], {
  cwd: appRoot,
  encoding: 'utf8',
})
const killed = results.filter((r) => r.result === 'KILLED').length
console.log(
  `\n${String(killed)}/${String(results.length)} killed; tree after restore: ${diff.stdout.trim() === '' ? 'clean' : diff.stdout}`,
)
mkdirSync(join(appRoot, '.build'), { recursive: true })
writeFileSync(join(appRoot, '.build', 'p173-mutations.json'), JSON.stringify(results, null, 2))
process.exit(killed === results.length && diff.stdout.trim() === '' ? 0 : 1)

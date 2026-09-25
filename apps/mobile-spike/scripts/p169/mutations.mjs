#!/usr/bin/env node
/**
 * P169 mutation proofs: each mutant plants ONE of the defects the P169 brief names, runs the P169
 * unit tests, and must make them FAIL (assertion failures, not a crash of the harness). Every file
 * is restored in a finally block, and the script ends by checking `git diff` of the mutated files
 * is empty.
 *
 *   node scripts/p169/mutations.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const P = (p) => join(appRoot, p)

const MUTANTS = [
  {
    name: 'auto-select the first printing',
    file: 'src/features/price-check/price-check-flow-store.ts',
    from: 'const resolution = resolveVariant(outcome.value.variants, variantId)',
    to: 'const resolution = resolveVariant(outcome.value.variants, variantId ?? outcome.value.variants[0]?.variantId)',
  },
  {
    name: 'cache key by card NAME instead of card id',
    file: 'src/features/price-check/price-lookup.ts',
    from: '`search_prices:${card.cardId}`',
    to: '`search_prices:${card.name}`',
  },
  {
    name: 'NULL amount rendered as zero',
    file: 'src/features/ui/kit.tsx',
    from: 'const text = formatMoney(value)',
    to: "const text = formatMoney(value ?? { minorUnits: 0n, currency: 'NOK' })",
  },
  {
    name: 'unsafe JSON number accepted (transport scan disabled, so it reaches BigInt/Number)',
    file: 'src/net/exact-transport-guard.ts',
    from: 'if (digits.length >= 16 && BigInt(digits) > MAX_SAFE) return token',
    to: 'if (digits.length >= 16 && BigInt(digits) > MAX_SAFE) void token',
  },
  {
    name: 'graded price derived from the raw price (x3 "PSA 10")',
    file: 'src/features/price-check/price-lookup.ts',
    from: 'graded: gradedSection({ sources: [], observations: [], dropped: [] }),',
    to: "graded: gradedSection({ sources: [{ id: 'derived', label: 'derived', state: 'ok' }], observations: raw.status === 'observations' ? raw.rows.map((r) => ({ ...r.observation, subject: { type: 'graded' as const, company: 'PSA' as const, grade: '10', qualifier: null }, price: { ...r.observation.price, minorUnits: r.observation.price.minorUnits * 3n } })) : [], dropped: [] }),",
  },
  {
    name: 'identity epoch dropped (stores not reset on A -> B)',
    file: 'src/features/feature.ts',
    from: "  deps.registry.register('p169-catalog-search', search)\n  deps.registry.register('p169-price-lookup', prices)\n  deps.registry.register('p169-price-check', priceCheck)\n",
    to: '',
  },
  {
    name: 'price result published after cancel / variant switch',
    file: 'src/features/price-check/price-check-flow-store.ts',
    from: 'const stale = controller.signal.aborted || !lease.isCurrent() || this.state.lookup.key !== key',
    to: 'const stale = !lease.isCurrent()',
  },
  {
    name: 'acquisition call introduced into the read-only feature',
    file: 'src/features/price-check/price-check-flow-store.ts',
    from: '  addToCollectionIntent(): AddToCollectionIntent | null {\n',
    to: "  addToCollectionIntent(): AddToCollectionIntent | null {\n    void (globalThis as unknown as { sb?: { rpc(n: string): Promise<unknown> } }).sb?.rpc('add_card_acquisition')\n",
  },
  {
    name: 'freshness label omitted for stale data',
    file: 'src/features/price-check/price-copy.ts',
    from: '(${age})`} · ${FRESHNESS_COPY[freshness]}`',
    to: '(${age})`}`',
  },
]

function jest() {
  const r = spawnSync(
    'pnpm',
    ['exec', 'jest', '--selectProjects', 'unit', '--runInBand', 'tests/unit/p169'],
    {
      cwd: appRoot,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      maxBuffer: 64 * 1024 * 1024,
    },
  )
  const out = `${r.stdout}\n${r.stderr}`
  const summary = /Tests:\s+(.*)/.exec(out)?.[1] ?? 'no summary'
  const failed = [...out.matchAll(/● (.+)$/gm)].map((m) => m[1]).filter((t) => !/Console/.test(t))
  return { status: r.status, summary, failed }
}

const results = []
for (const m of MUTANTS) {
  const file = P(m.file)
  const original = readFileSync(file, 'utf8')
  const count = original.split(m.from).length - 1
  if (count !== 1) {
    results.push({
      mutant: m.name,
      result: 'NOT_APPLIED',
      detail: `pattern found ${String(count)} times`,
    })
    continue
  }
  try {
    writeFileSync(file, original.replace(m.from, m.to))
    const r = jest()
    results.push({
      mutant: m.name,
      result: r.status !== 0 && r.failed.length > 0 ? 'KILLED' : 'SURVIVED',
      summary: r.summary,
      failingTests: r.failed.slice(0, 4),
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
console.log(
  `\n${String(results.filter((r) => r.result === 'KILLED').length)}/${String(MUTANTS.length)} killed; tree after restore: ${diff.stdout.trim() === '' ? 'clean' : diff.stdout}`,
)
writeFileSync(join(appRoot, '.build', 'p169-mutations.json'), JSON.stringify(results, null, 2))

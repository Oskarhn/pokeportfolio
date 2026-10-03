#!/usr/bin/env node
/**
 * Engine-neutral exact-money proof.
 *
 *   node scripts/hermes-money-proof.mjs
 *
 * 1. Bundles the REAL native formatter (src/money/format-money.ts + the shared domain it imports)
 *    together with the shared hand-written vectors (tests/support/money-vectors.ts) into ONE plain
 *    script that uses only `print`/`console.log`. Nothing from Jest or the app is in it.
 * 2. Runs it under Node: must print PASS for every vector (this is Node/V8, NOT Hermes).
 * 3. Compiles it with hermesc (Hermes compiler 1.0.0 from the `hermes-compiler` package): this proves
 *    the syntax and BigInt literals COMPILE for Hermes. It does not execute anything.
 *
 * The output script is written to .build/hermes-money-proof.js. To prove the same numbers ON Hermes
 * (the part that is NOT verified today) run that file under any Hermes runtime that provides
 * `print` or `console.log` (a standalone `hermes` binary, or evaluate it inside the app on an
 * emulator/device) and expect `RESULT pass=N fail=0`.
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(appRoot, '..', '..')
const outDir = join(appRoot, '.build')
mkdirSync(outDir, { recursive: true })

// esbuild is a dependency of the repo's tsx; resolve it from there rather than adding a dependency.
const requireFromRoot = createRequire(join(repoRoot, 'package.json'))
const tsxPath = requireFromRoot.resolve('tsx')
const esbuild = createRequire(tsxPath)('esbuild')

const entry = `
import { formatMoney, ABSENT } from '${join(appRoot, 'src/money/format-money.ts').replaceAll('\\', '/')}'
import { MONEY_VECTORS } from '${join(appRoot, 'tests/support/money-vectors.ts').replaceAll('\\', '/')}'
import { parseNullableMoneyInput, requireKnownAmount, parseOptionalChargeInput } from '${join(appRoot, 'src/write/money-input.ts').replaceAll('\\', '/')}'
import { serializeMinorUnits, moneyArg } from '${join(appRoot, 'src/write/money-wire.ts').replaceAll('\\', '/')}'
import { generateIdempotencyKey } from '${join(appRoot, 'src/write/idempotency-key.ts').replaceAll('\\', '/')}'

const out = typeof print === 'function' ? print : (...a) => console.log(...a)
let pass = 0
let fail = 0
function check(name, actual, expected) {
  if (actual === expected) { pass += 1; out('PASS ' + name) }
  else { fail += 1; out('FAIL ' + name + ' expected=' + JSON.stringify(expected) + ' actual=' + JSON.stringify(actual)) }
}
for (const v of MONEY_VECTORS) check(v.name, formatMoney({ minorUnits: v.minor, currency: v.currency }), v.expected)
check('absent is a dash, not zero', formatMoney(null), ABSENT)
check('absent (undefined)', formatMoney(undefined), ABSENT)
check('runtime has BigInt', typeof BigInt, 'function')
check('2^53+1 is exact as bigint', String(2n ** 53n + 1n), '9007199254740993')
check('Number() would lose it', String(Number(2n ** 53n + 1n)), '9007199254740992')

// P175: the WRITE-side boundary (money-input.ts / money-wire.ts), on the SAME engine this proof
// compiles for. Blank never becomes 0, an explicit 0 stays 0, and >2^53 round-trips exactly.
check('write: blank input is null, not 0n', parseNullableMoneyInput('', 'NOK'), null)
check('write: explicit zero is 0n', parseNullableMoneyInput('0', 'NOK'), 0n)
check('write: comma decimal separator', parseNullableMoneyInput('100,50', 'NOK'), 10050n)
check('write: JPY has no fractional minor unit', parseNullableMoneyInput('1500', 'JPY'), 1500n)
check(
  'write: >2^53 kroner input parses exactly',
  parseNullableMoneyInput('90071992547409.93', 'NOK'),
  9007199254740993n,
)
check(
  'write: serializeMinorUnits(2^53+1) is the exact decimal string',
  serializeMinorUnits(9007199254740993n),
  '9007199254740993',
)
check(
  'write: moneyArg round-trips exactly through BigInt()',
  BigInt(String(moneyArg(9007199254740993n))),
  9007199254740993n,
)
check('write: requireKnownAmount(explicit 0) is 0n', requireKnownAmount('0', 'NOK', 'x'), 0n)
check('write: parseOptionalChargeInput(blank) is 0n by name', parseOptionalChargeInput('', 'NOK'), 0n)
{
  let threw = false
  try { requireKnownAmount('', 'NOK', 'required') } catch { threw = true }
  check('write: requireKnownAmount(blank) throws, never 0n', threw, true)
}
check('write: idempotency key is a UUID-shaped string', /^[0-9a-f-]{36}$/i.test(generateIdempotencyKey()), true)
check('write: two idempotency keys differ', generateIdempotencyKey() !== generateIdempotencyKey(), true)
out('RESULT pass=' + pass + ' fail=' + fail)
if (fail > 0) throw new Error('money proof failed')
`

const outFile = join(outDir, 'hermes-money-proof.js')
await esbuild.build({
  stdin: { contents: entry, resolveDir: appRoot, loader: 'ts' },
  bundle: true,
  format: 'iife',
  platform: 'neutral',
  target: 'es2020',
  alias: { '@shared': join(repoRoot, 'src') },
  outfile: outFile,
  logLevel: 'error',
})
console.log(`bundled ${outFile}`)

const node = spawnSync(process.execPath, [outFile], { encoding: 'utf8' })
const lines = node.stdout.trim().split('\n')
console.log(`NODE  ${lines.at(-1)}  (exit ${String(node.status)})`)
if (node.status !== 0) {
  console.error(node.stdout, node.stderr)
  process.exit(1)
}

const hermesc = join(
  appRoot,
  'node_modules',
  'hermes-compiler',
  'hermesc',
  process.platform === 'win32'
    ? 'win64-bin'
    : process.platform === 'darwin'
      ? 'osx-bin'
      : 'linux64-bin',
  process.platform === 'win32' ? 'hermesc.exe' : 'hermesc',
)
const version = spawnSync(hermesc, ['-version'], { encoding: 'utf8' })
const release = /Hermes release version: (\S+)/.exec(version.stdout)?.[1] ?? 'unknown'
const hbc = join(outDir, 'hermes-money-proof.hbc')
const compiled = spawnSync(hermesc, ['-O', '-emit-binary', '-out', hbc, outFile], {
  encoding: 'utf8',
})
if (compiled.status !== 0) {
  console.error(compiled.stdout, compiled.stderr)
  console.log('HERMESC compile FAILED')
  process.exit(1)
}
console.log(`HERMESC ${release}: compiled to bytecode OK (${hbc})`)
console.log(
  'HERMES RUNTIME: not executed by this script (hermesc cannot run code). On a device or emulator, ' +
    'build with EXPO_PUBLIC_RUNTIME_PROOF=1 and read `P166_PROOF RESULT` from logcat ' +
    '(src/diagnostics/runtime-proof.ts, scripts/android-runtime-check.mjs).',
)

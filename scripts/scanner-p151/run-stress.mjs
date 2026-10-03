/**
 * Runs the P151 scanner stress harness at FULL size (100 iterations per mode) through vitest.
 *   pnpm scanner:stress                       all modes, 100 iterations each
 *   pnpm scanner:stress --scale 10            ~1,000 iterations each
 *   pnpm scanner:stress -t "mode 4"           forward any other argument to vitest
 * Synthetic lifecycle stress only (fake OCR/visual workers, catalog and canvas) — see the header of
 * tests/ui/scanner-p151-stress.test.ts for exactly what it does and does not prove.
 */
import { spawnSync } from 'node:child_process'

/** The seven modes: repeated scans, mixed valid/invalid frames, open/close, cancel/restart and bounded
 *  concurrency live in the first file; worker crash/recovery and 100 open/close cycles of the OCR and
 *  visual workers, and cache eviction across 50 index generations, live in the other three. */
const STRESS_FILES = [
  'tests/ui/scanner-p151-stress.test.ts',
  'tests/ui/scanner-p151-ocr-lifecycle.test.ts',
  'tests/ui/scanner-p151-visual-client-lifecycle.test.ts',
  'tests/ui/scanner-p151-worker-cache.test.ts',
]

const args = process.argv.slice(2)
let scale = '1'
const forwarded = []
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--scale' && args[i + 1] !== undefined) {
    scale = args[i + 1]
    i += 1
  } else {
    forwarded.push(args[i])
  }
}
const result = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['exec', 'vitest', 'run', ...STRESS_FILES, ...forwarded],
  {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, P151_STRESS: '1', P151_STRESS_SCALE: scale },
  },
)
process.exit(result.status ?? 1)

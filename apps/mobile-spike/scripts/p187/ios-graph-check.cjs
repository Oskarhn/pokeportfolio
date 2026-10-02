#!/usr/bin/env node
/**
 * P187: bundles the app for iOS through Expo's own Metro pipeline (`expo export`, supported on
 * Windows) and fails if the bundled module graph carries another platform's implementation or lacks
 * part of the scanner chain. This is the Windows-side proof that the JS side is iOS-ready; it says
 * nothing about native code (that needs a Mac, see docs/mobile/IOS_BUILD_AND_DEVICE_RUNBOOK.md).
 *
 *   node scripts/p187/ios-graph-check.cjs [ios|android]
 * Needs the scanner assets (`pnpm assets:scanner`) because model-assets.ts require()s them.
 */
const { execFileSync } = require('node:child_process')
const { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { analyzeGraph } = require('./ios-graph-lib.cjs')

const platform = process.argv[2] ?? 'ios'
const appRoot = join(__dirname, '..', '..')
const outDir = join(appRoot, '.build', `graph-${platform}`)
if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true })

const expoCli = join(appRoot, 'node_modules', 'expo', 'bin', 'cli')
execFileSync(
  process.execPath,
  [
    expoCli,
    'export',
    '--platform',
    platform,
    '--output-dir',
    outDir,
    '--dump-sourcemap',
    '--no-minify',
  ],
  { cwd: appRoot, stdio: ['ignore', 'inherit', 'inherit'] },
)

function findMaps(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...findMaps(full))
    else if (entry.name.endsWith('.map')) found.push(full)
  }
  return found
}

const maps = findMaps(outDir)
if (maps.length !== 1) throw new Error(`expected exactly one source map, found ${maps.length}`)
const { sources } = JSON.parse(readFileSync(maps[0], 'utf8'))
const result = analyzeGraph(sources, platform)
console.log(JSON.stringify({ platform, ...result }, null, 2))
if (result.violations.length > 0 || result.missing.length > 0) process.exit(1)

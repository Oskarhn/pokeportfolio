#!/usr/bin/env node
/**
 * Post-build, pre-upload artefact gate (P160): the built `dist/` must be COMPLETE and must contain
 * no secret-shaped string. Defence in depth behind scripts/check-public-env.mjs — that guard judges
 * the inputs, this one judges what actually got written, so a value that slipped past the input
 * rules (an unforeseen variable name, a value inlined by a plugin) still cannot be published.
 *
 *   node scripts/check-dist-secrets.mjs [dir]        (default: dist)
 *
 * Fails closed: a missing directory, an artefact without its completeness markers (a build that
 * aborted after copying `public/` leaves exactly such a partial tree), or a scan that examined no
 * file at all is a failure, never a pass.
 *
 * Output: file paths and categories only. The matched text is never read out of this process.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { findSecretShapes } from './lib/public-env-guard.mjs'

/** Emitted by a COMPLETE build (index.html by Vite's HTML step; the other two by our plugins). */
const COMPLETENESS_MARKERS = ['index.html', 'build-meta.json', '_headers']
const TEXT_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.css',
  '.html',
  '.json',
  '.map',
  '.txt',
  '.xml',
  '.svg',
  '.webmanifest',
])

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else if (entry.isFile()) yield path
  }
}

const root = process.argv[2] ?? 'dist'
const findings = []

try {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    findings.push({ path: root, category: 'directory_missing' })
  } else {
    for (const marker of COMPLETENESS_MARKERS) {
      if (!existsSync(join(root, marker))) {
        findings.push({ path: marker, category: 'artifact_incomplete' })
      }
    }
    let scanned = 0
    for (const file of walk(root)) {
      if (!TEXT_EXTENSIONS.has(extname(file).toLowerCase())) continue
      scanned += 1
      const shapes = findSecretShapes(readFileSync(file, 'utf8'))
      const rel = relative(root, file).split('\\').join('/')
      if (shapes.secretKey) findings.push({ path: rel, category: 'secret_key_shaped_present' })
      if (shapes.serviceRoleJwt) findings.push({ path: rel, category: 'service_role_jwt_present' })
    }
    if (scanned === 0) findings.push({ path: root, category: 'nothing_scanned' })
    if (findings.length === 0)
      console.log(`check-dist-secrets: OK (${String(scanned)} text files scanned)`)
  }
} catch {
  // No message, no stack: nothing that could quote file content.
  findings.push({ path: root, category: 'internal_error' })
}

if (findings.length > 0) {
  console.log(`check-dist-secrets: FAIL (${String(findings.length)} finding(s))`)
  for (const f of findings) console.log(`  ${f.path}: ${f.category}`)
  console.log('  Nothing was uploaded by this step. Do not publish this directory.')
  process.exit(1)
}

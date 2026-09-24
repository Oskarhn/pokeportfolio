#!/usr/bin/env node
/**
 * Read-only structural check of the repository's GitHub Actions VARIABLES that feed the public
 * build (P160): `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`.
 *
 *   node scripts/check-github-public-vars.mjs [owner/repo]
 *
 * Uses the authenticated `gh` CLI. The two values are read INTO THIS PROCESS ONLY and judged by
 * scripts/lib/public-env-guard.mjs in the deploy profile; the output is a field name and an error
 * category per problem, never a value, a prefix, a length, or a `gh` error text. Nothing is written
 * anywhere and nothing on GitHub is changed. Exit 0 = both variables are well-formed for a hosted
 * deploy, 1 = not.
 *
 * "Well-formed" is a shape verdict. It does not prove a key is the right key, or that a previously
 * exposed key was rotated — only the owner's dashboard actions establish that.
 */
import { execFileSync } from 'node:child_process'
import { formatGuardReport, validatePublicEnv } from './lib/public-env-guard.mjs'

const NAMES = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY']

function gh(args) {
  // stderr is discarded on purpose: an error body must never be able to quote a value.
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

try {
  const repo =
    process.argv[2] ??
    gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim()
  /** @type {Record<string, string | undefined>} */
  const env = {}
  const unreadable = []
  for (const name of NAMES) {
    try {
      env[name] = gh(['api', `repos/${repo}/actions/variables/${name}`, '--jq', '.value']).replace(
        /\r?\n$/,
        '',
      )
    } catch {
      unreadable.push(name)
    }
  }
  for (const name of unreadable) console.log(`  ${name}: unreadable_or_missing`)
  const result = validatePublicEnv(env, { requireHosted: true, requirePresent: false })
  for (const line of formatGuardReport(result)) console.log(line)
  process.exit(result.ok && unreadable.length === 0 ? 0 : 1)
} catch {
  console.log('check-github-public-vars: FAIL (internal_error) — no details printed.')
  process.exit(1)
}

#!/usr/bin/env node
/**
 * Pre-build gate for the public (`VITE_*`) configuration (P160). Runs as the FIRST step of
 * `prebuild` (package.json), so it precedes asset staging, `tsc -b` and `vite build` for every
 * `pnpm build` — local, CI, Cloudflare Pages and the CI Production deploy job. `vite.config.ts`
 * runs the same validator again for any `vite build`/`vite` invoked directly.
 *
 *   node scripts/check-public-env.mjs [--mode production] [--require-hosted] [--allow-missing]
 *
 * Reads the effective environment IN PROCESS (`.env*` files via Vite's own loader, overridden by
 * the process environment, exactly Vite's precedence). Prints field names and error categories
 * only — never a value, a substring, a length, or an exception message (see
 * scripts/lib/public-env-guard.mjs). Exit 0 = OK, 1 = refused.
 *
 * `--require-hosted` (or CF_PAGES=1 / PP_REQUIRE_HOSTED_PUBLIC_ENV=1) selects the deploy profile:
 * a real `https://<ref>.supabase.co` URL and a `sb_publishable_…` key, no placeholders.
 */
import { loadEnv } from 'vite'
import {
  collectPublicEnv,
  formatGuardReport,
  resolveRequireHosted,
  validatePublicEnv,
} from './lib/public-env-guard.mjs'

const args = process.argv.slice(2)
const modeIndex = args.indexOf('--mode')
const mode = modeIndex === -1 ? 'production' : (args[modeIndex + 1] ?? 'production')

try {
  const env = collectPublicEnv(loadEnv(mode, process.cwd(), 'VITE_'), process.env)
  const result = validatePublicEnv(env, {
    requireHosted: args.includes('--require-hosted') || resolveRequireHosted(process.env),
    requirePresent: !args.includes('--allow-missing'),
  })
  for (const line of formatGuardReport(result)) console.log(line)
  process.exit(result.ok ? 0 : 1)
} catch {
  // Deliberately no message and no stack: an exception here could be quoting a rejected value.
  console.log('public-env-guard: FAIL (internal_error) — refusing to continue; no details printed.')
  process.exit(1)
}

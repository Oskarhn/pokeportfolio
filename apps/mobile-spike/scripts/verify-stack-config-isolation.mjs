#!/usr/bin/env node
/**
 * P180 §15 regression check (LOCAL_ONLY, no Docker, no database): proves
 * scripts/local-backend.mjs's `transformConfig` no longer leaks state between stack identities.
 *
 * BEFORE this fix, `transformConfig(source)` closed over this module's own top-level
 * `resolveStackIdentity()` result — computed ONCE at import time from `process.env` and, as a
 * fallback, whatever `.local-backend/stack.json` a PREVIOUS `start`/`prepare` happened to leave on
 * disk. A named-stack builder (scripts/p169/local-backend.mjs, used by every scripts/p17{3,7,8,9}/
 * phase) imports `transformConfig` for its own config generation; because the import is evaluated
 * before the importing script's own code runs, it silently inherited whatever identity was already
 * recorded — P177's own disclosed finding ("a stray port-1770-based db port 56092 collision").
 *
 * This script reproduces exactly the scenario the mission asks for: create identity A, create
 * identity B, reload A — and asserts the values stay independent. Run it directly:
 *
 *   node scripts/verify-stack-config-isolation.mjs
 *
 * It is not part of `pnpm test` (transformConfig lives in a `.mjs` file, and this repo's Jest
 * transform only covers `.js`/`.ts`/`.jsx`/`.tsx` — the same reason scripts/verify-norges-bank-
 * contract.mjs is a standalone script, not a Jest test) — this is the equivalent manual gate for
 * config-generation code, checked here rather than left unverified.
 */
import { transformConfig } from './local-backend.mjs'

const SOURCE = `project_id = "pokeportfolio"

[api]
port = 54321

[db]
port = 54322
shadow_port = 54320

[auth]
enabled = true
site_url = "http://127.0.0.1:54321"
additional_redirect_urls = ["http://old"]

[studio]
enabled = true

[edge_runtime]
enabled = true
inspector_port = 8083
`

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    console.error(
      `FAIL ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`,
    )
    process.exitCode = 1
    return false
  }
  console.log(`PASS ${label}`)
  return true
}

const identityA = { projectId: 'pokeportfolio-a-stack', portOffset: 1000, enableEdgeRuntime: false }
const identityB = { projectId: 'pokeportfolio-b-stack', portOffset: 1770, enableEdgeRuntime: true }

const configA1 = transformConfig(SOURCE, identityA)
const configB = transformConfig(SOURCE, identityB)
// "reload A": a SECOND, independent call with A's identity, sandwiched after B's call ran — the
// exact shape of "a named stack build happening after some other stack was already active".
const configA2 = transformConfig(SOURCE, identityA)

assertEqual(
  configA1,
  configA2,
  'identity A is unaffected by identity B running in between (reload A)',
)
assertEqual(
  configA1.includes('project_id = "pokeportfolio-a-stack"'),
  true,
  "A's config carries A's own project id",
)
assertEqual(
  configB.includes('project_id = "pokeportfolio-b-stack"'),
  true,
  "B's config carries B's own project id, never A's",
)
assertEqual(configA1.includes('port = 55321'), true, "A: port shifted by A's own offset (1000)")
assertEqual(
  configB.includes('port = 56091'),
  true,
  "B: port shifted by B's own offset (1770), not A's",
)
assertEqual(
  configA1.includes('pokeportfolio-b-stack') || configB.includes('pokeportfolio-a-stack'),
  false,
  "neither config ever mentions the other identity's project id",
)
assertEqual(
  configA1.includes('http://127.0.0.1:55321'),
  true,
  "A's site_url uses A's own api port (54321 + 1000)",
)
assertEqual(
  configB.includes('http://127.0.0.1:56091'),
  true,
  "B's site_url uses B's own api port (54321 + 1770), not A's",
)

if (process.exitCode === 1) {
  console.error('\nstack config isolation check FAILED')
} else {
  console.log('\nstack config isolation check passed: identities never leak into each other')
}

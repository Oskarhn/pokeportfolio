/**
 * P163 — the names-only GitHub configuration check. Pure logic only: the CLI needs an
 * authenticated `gh` and is deliberately not run against the real repository by any test.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  LEGACY_VARIABLES,
  REQUIRED_SECRETS,
  evaluateReleaseConfig,
} from '../../scripts/lib/release-config-check.mjs'

const allSecrets = [...REQUIRED_SECRETS]

describe('evaluateReleaseConfig', () => {
  it('passes when every required secret exists and no legacy variable remains', () => {
    expect(evaluateReleaseConfig({ secrets: allSecrets, variables: [] })).toEqual({
      ok: true,
      findings: [],
    })
  })

  it('reports each missing secret by name and category only', () => {
    const r = evaluateReleaseConfig({ secrets: [], variables: [] })
    expect(r.ok).toBe(false)
    expect(r.findings.map((f) => f.name)).toEqual([...REQUIRED_SECRETS])
    expect(new Set(r.findings.map((f) => f.category))).toEqual(new Set(['secret_missing']))
  })

  it('fails while a legacy VITE_* variable still exists, even with every secret present', () => {
    const r = evaluateReleaseConfig({ secrets: allSecrets, variables: ['VITE_SUPABASE_URL'] })
    expect(r.ok).toBe(false)
    expect(r.findings).toEqual([{ name: 'VITE_SUPABASE_URL', category: 'legacy_variable_present' }])
  })

  it('ignores unrelated variables and secrets', () => {
    expect(
      evaluateReleaseConfig({ secrets: [...allSecrets, 'OTHER'], variables: ['SOMETHING_ELSE'] })
        .ok,
    ).toBe(true)
  })

  it('the names it demands match what the workflow actually references', () => {
    const workflow = readFileSync('.github/workflows/deploy-production.yml', 'utf-8')
    for (const name of REQUIRED_SECRETS) expect(workflow).toContain(`secrets.${name}`)
    for (const name of LEGACY_VARIABLES) expect(workflow).not.toContain(`vars.${name}`)
  })

  it('the CLI reads names only: no value-bearing jq path, no value output', () => {
    const cli = readFileSync('scripts/check-github-release-config.mjs', 'utf-8')
    expect(cli).toContain(".secrets[].name'")
    expect(cli).toContain(".variables[].name'")
    expect(cli).not.toMatch(/\.value\b/)
  })
})

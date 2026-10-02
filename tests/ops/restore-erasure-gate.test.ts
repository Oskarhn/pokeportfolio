import { describe, expect, it } from 'vitest'
import {
  appendEntry,
  evaluateRestore,
  hashAccountId,
  parseRegistry,
  REGISTRY_HEADER,
  RegistryError,
} from '../../scripts/restore-gate/erasure-registry'

/**
 * P156: the decision half of the restore promotion gate. The database half — a real dump taken
 * before a deletion, restored into a disposable database, and judged by the CLI — is
 * tests/db/p156_restore_resurrection.test.ts.
 */

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

describe('the registry format', () => {
  it('stores a hash, never the id, and is case-insensitive about the id', () => {
    const text = appendEntry(null, A.toUpperCase(), '2026-09-20')
    expect(text.startsWith(`${REGISTRY_HEADER}\n`)).toBe(true)
    expect(text).not.toContain(A)
    expect(text).not.toContain(A.toUpperCase())
    expect(parseRegistry(text)).toEqual([{ hash: hashAccountId(A), erasedOn: '2026-09-20' }])
  })

  it('is idempotent and append-only', () => {
    const once = appendEntry(null, A, '2026-09-20')
    const twice = appendEntry(once, A, '2026-09-21')
    expect(twice).toBe(once)
    expect(parseRegistry(appendEntry(once, B, '2026-09-22'))).toHaveLength(2)
  })

  it.each([
    ['no header', 'deadbeef 2026-01-01\n'],
    ['a short hash', `${REGISTRY_HEADER}\nabc 2026-01-01\n`],
    ['an email where a hash belongs', `${REGISTRY_HEADER}\nperson@example.invalid 2026-01-01\n`],
    ['a missing date', `${REGISTRY_HEADER}\n${'a'.repeat(64)}\n`],
    ['trailing junk', `${REGISTRY_HEADER}\n${'a'.repeat(64)} 2026-01-01 extra\n`],
  ])('refuses a malformed registry: %s', (_name, text) => {
    expect(() => parseRegistry(text)).toThrow(RegistryError)
  })

  it('refuses something that is not an account id instead of hashing it', () => {
    expect(() => hashAccountId('person@example.invalid')).toThrow(RegistryError)
  })
})

describe('the promotion decision', () => {
  const registry = parseRegistry(appendEntry(null, A, '2026-09-20'))

  it('a restored image that contains an erased account is NOT promotable', () => {
    const v = evaluateRestore({ restoredIds: [A, B], registry, allowEmpty: false })
    expect(v).toMatchObject({ status: 'resurrected', matches: 1, idsChecked: 2 })
  })

  it('matches regardless of id case', () => {
    expect(
      evaluateRestore({ restoredIds: [A.toUpperCase()], registry, allowEmpty: false }).status,
    ).toBe('resurrected')
  })

  it('an image with only accounts that were never erased is clean', () => {
    expect(evaluateRestore({ restoredIds: [B], registry, allowEmpty: false }).status).toBe('clean')
  })

  it('an EMPTY registry is a refusal, not a pass, unless the operator says so on purpose', () => {
    expect(evaluateRestore({ restoredIds: [A, B], registry: [], allowEmpty: false }).status).toBe(
      'registry_empty',
    )
    expect(evaluateRestore({ restoredIds: [B], registry: [], allowEmpty: true }).status).toBe(
      'clean',
    )
  })

  it('an erased account still wins over allowEmpty being irrelevant: a non-empty registry is always applied', () => {
    expect(evaluateRestore({ restoredIds: [A], registry, allowEmpty: true }).status).toBe(
      'resurrected',
    )
  })
})

interface FixtureOverwriteGuard {
  decideFixtureAction: (args: {
    exists: boolean
    force: boolean
    reuse: boolean
  }) => 'create' | 'reuse' | 'overwrite' | 'blocked'
  blockedMessage: (fixturePath: string, previousSummary?: string) => string
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const guard = require('../../scripts/fixture-overwrite-guard.js') as FixtureOverwriteGuard
const { blockedMessage, decideFixtureAction } = guard

/**
 * P180 §14: the pure decision behind seed-local-backend.mts's "no silent overwrite" guard —
 * re-running the seed script used to create brand-new synthetic users and clobber fixture.json
 * with no warning every time, orphaning the previous run's rich fixture user (P179's finding).
 */
describe('decideFixtureAction', () => {
  it('creates when no fixture exists yet, regardless of flags', () => {
    expect(decideFixtureAction({ exists: false, force: false, reuse: false })).toBe('create')
    expect(decideFixtureAction({ exists: false, force: true, reuse: false })).toBe('create')
  })

  it('blocks an existing fixture by default — the exact silent-overwrite case this closes', () => {
    expect(decideFixtureAction({ exists: true, force: false, reuse: false })).toBe('blocked')
  })

  it('reuses an existing fixture unchanged when --reuse is passed', () => {
    expect(decideFixtureAction({ exists: true, force: false, reuse: true })).toBe('reuse')
  })

  it('overwrites an existing fixture only when --force is explicitly passed', () => {
    expect(decideFixtureAction({ exists: true, force: true, reuse: false })).toBe('overwrite')
  })

  it('reuse takes precedence over force when both are somehow passed — the safer read wins', () => {
    expect(decideFixtureAction({ exists: true, force: true, reuse: true })).toBe('reuse')
  })
})

describe('blockedMessage', () => {
  it('names both escape hatches and the previous users, and is explicit that nothing was dropped', () => {
    const message = blockedMessage(
      '/x/fixture.json',
      'existing users a@example.invalid / b@example.invalid',
    )
    expect(message).toContain('--reuse')
    expect(message).toContain('--force')
    expect(message).toContain('a@example.invalid')
    expect(message).not.toMatch(/\bdrop\b|\btruncate\b/i)
    expect(message).toContain('not deleted')
  })
})

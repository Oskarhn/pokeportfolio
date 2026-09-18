/**
 * Mutation-proof regression tests for the P130-08/P142 Production-deploy gating logic
 * (scripts/lib/deploy-guards.mjs). Each describe block proves the real check rejects the exact
 * case it exists to catch, and reproduces a naive/old-style implementation against the same
 * fixture to prove the false pass would be real — the same pattern established in
 * tests/config/verifier-fail-closed.test.ts for the release verifiers this gate reuses
 * (scripts/lib/build-identity.mjs, scripts/lib/verifier-summary.mjs).
 */
import { describe, expect, it } from 'vitest'
import { isRemoteMainCurrent, isBuildIdentityExact } from '../../scripts/lib/deploy-guards.mjs'

describe('isRemoteMainCurrent — stale-run refusal (P142 §10/§30)', () => {
  it('the SHA this run was triggered for still equals what origin/main reports', () => {
    expect(isRemoteMainCurrent('abc123', 'abc123')).toBe(true)
  })

  it('main advanced past this run (Mutation E: stale SHA) — must refuse, not deploy the old SHA', () => {
    expect(isRemoteMainCurrent('def456', 'abc123')).toBe(false)
  })

  it('an unreadable remote (empty string, e.g. `git ls-remote` failed) never counts as current', () => {
    expect(isRemoteMainCurrent('', 'abc123')).toBe(false)
  })

  it('a missing githubSha never counts as current (fail closed on missing input, not a vacuous pass)', () => {
    expect(isRemoteMainCurrent('abc123', '')).toBe(false)
  })

  it('whitespace from the raw `git ls-remote` line is tolerated', () => {
    expect(isRemoteMainCurrent('abc123\n', 'abc123')).toBe(true)
  })

  it('OLD (mutation proof): a naive prefix check would wrongly accept a stale SHA that merely shares a prefix', () => {
    const oldPrefixCheck = (remote: string, expected: string) => remote.startsWith(expected)
    // main advanced from abc123 to abc123999 (a plausible-looking but WRONG "still current" read
    // under a prefix check) — the real function correctly refuses this.
    expect(oldPrefixCheck('abc123999', 'abc123')).toBe(true)
    expect(isRemoteMainCurrent('abc123999', 'abc123')).toBe(false)
  })
})

describe('isBuildIdentityExact — build-identity mismatch must block deploy (P142 §12/§32)', () => {
  const githubSha = 'a'.repeat(40)

  it('a build-meta.json declaring exactly the expected SHA passes', () => {
    const text = JSON.stringify({ sha: githubSha, builtAt: '2026-09-18T00:00:00.000Z' })
    expect(isBuildIdentityExact(text, githubSha)).toBe(true)
  })

  it('Mutation D: a dirty build (+dirty suffix) must be rejected, never treated as a match', () => {
    const text = JSON.stringify({ sha: `${githubSha}+dirty`, builtAt: '2026-09-18T00:00:00.000Z' })
    expect(isBuildIdentityExact(text, githubSha)).toBe(false)
  })

  it('a different commit entirely is rejected', () => {
    const text = JSON.stringify({ sha: 'b'.repeat(40), builtAt: '2026-09-18T00:00:00.000Z' })
    expect(isBuildIdentityExact(text, githubSha)).toBe(false)
  })

  it('malformed JSON fails closed rather than throwing past the caller', () => {
    expect(isBuildIdentityExact('not json', githubSha)).toBe(false)
  })

  it('a missing sha field fails closed', () => {
    expect(isBuildIdentityExact(JSON.stringify({ builtAt: 'now' }), githubSha)).toBe(false)
  })

  it('a missing expected githubSha never produces a vacuous pass', () => {
    const text = JSON.stringify({ sha: githubSha })
    expect(isBuildIdentityExact(text, '')).toBe(false)
  })

  it('OLD (mutation proof): a naive substring/.includes() check would wrongly accept a dirty build — the exact P130-27 false-pass class, applied to build-meta.json instead of the bundle text', () => {
    const dirtyText = JSON.stringify({ sha: `${githubSha}+dirty` })
    const oldIncludesCheck = (text: string, sha: string) => text.includes(sha)
    expect(oldIncludesCheck(dirtyText, githubSha)).toBe(true)
    expect(isBuildIdentityExact(dirtyText, githubSha)).toBe(false)
  })
})

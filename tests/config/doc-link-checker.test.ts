/**
 * Unit tests for scripts/lib/doc-link-checker.mjs, backing scripts/check-doc-links.mjs
 * (P176 §21: relative links resolve, no sandbox paths, no secret-shaped strings committed).
 */
import { describe, expect, it } from 'vitest'
import {
  classifyLinkTarget,
  extractLinkTargets,
  findSecretShapes,
  referencesSandboxPath,
  stripFragment,
} from '../../scripts/lib/doc-link-checker.mjs'

describe('extractLinkTargets', () => {
  it('extracts every markdown link target in order', () => {
    const text = 'See [A](./a.md) and [B](../b.md#section) and [C](https://example.com).'
    expect(extractLinkTargets(text)).toEqual(['./a.md', '../b.md#section', 'https://example.com'])
  })

  it('returns an empty array for text with no links', () => {
    expect(extractLinkTargets('no links here')).toEqual([])
  })
})

describe('classifyLinkTarget', () => {
  it('classifies http(s) and mailto as external', () => {
    expect(classifyLinkTarget('https://example.com').kind).toBe('external')
    expect(classifyLinkTarget('http://example.com').kind).toBe('external')
    expect(classifyLinkTarget('mailto:a@b.com').kind).toBe('external')
  })

  it('classifies a pure fragment as anchor', () => {
    expect(classifyLinkTarget('#section').kind).toBe('anchor')
  })

  it('classifies everything else as relative', () => {
    expect(classifyLinkTarget('./docs/FOO.md').kind).toBe('relative')
    expect(classifyLinkTarget('../BAR.md').kind).toBe('relative')
    expect(classifyLinkTarget('HANDOVER.md').kind).toBe('relative')
  })
})

describe('stripFragment', () => {
  it('removes a trailing fragment', () => {
    expect(stripFragment('docs/FOO.md#section')).toBe('docs/FOO.md')
  })

  it('leaves a target with no fragment unchanged', () => {
    expect(stripFragment('docs/FOO.md')).toBe('docs/FOO.md')
  })

  it('a pure fragment strips to an empty string', () => {
    expect(stripFragment('#section')).toBe('')
  })
})

describe('findSecretShapes', () => {
  it('finds a Supabase secret-key-shaped token', () => {
    expect(findSecretShapes('token=sb_secret_abcdefghijklmnop')).toContain('supabase secret key')
  })

  it('finds a JWT-shaped token', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dGhpc2lzYXNpZ25hdHVyZQ'
    expect(findSecretShapes(jwt).length).toBeGreaterThan(0)
  })

  it('finds a PEM private key block', () => {
    expect(findSecretShapes('-----BEGIN RSA PRIVATE KEY-----\nMIIB...')).toContain(
      'generic private key block',
    )
  })

  it('returns an empty array for ordinary prose, including the word "secret"', () => {
    expect(findSecretShapes('rotate the exposed secret key before deploying')).toEqual([])
  })

  it('does not flag a short SHA or a plain hex migration prefix as a JWT', () => {
    expect(findSecretShapes('d8682e047b757f63673a63ac8185a4806d68cb98')).toEqual([])
  })
})

describe('referencesSandboxPath', () => {
  it('flags a Windows Claude temp/scratchpad path', () => {
    expect(
      referencesSandboxPath(
        'C:\\Users\\Oskar\\AppData\\Local\\Temp\\claude\\project\\scratchpad\\x.txt',
      ),
    ).toBe(true)
  })

  it('flags a POSIX /tmp/claude path', () => {
    expect(referencesSandboxPath('/tmp/claude/some-session/file.txt')).toBe(true)
  })

  it('does not flag an ordinary repo-relative or project worktree path', () => {
    expect(referencesSandboxPath('docs/CURRENT_STATE/NATIVE_MOBILE.md')).toBe(false)
    expect(referencesSandboxPath('C:\\Users\\Oskar\\Documents\\Pokemonapp-worktrees\\p173')).toBe(
      false,
    )
  })
})

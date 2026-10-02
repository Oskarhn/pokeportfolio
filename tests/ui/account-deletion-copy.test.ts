import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * P189: what the product SAYS about deletion must stay true. These read the shipped copy sources
 * (web page, web dialog, native sheet, Privacy page) and refuse the claims the project cannot
 * support: a retention period, "erased from every backup", an invented support contact.
 */

const SOURCES = [
  'src/features/legal/AccountDeletionPage.tsx',
  'src/features/profile/DeleteAccountSection.tsx',
  'apps/mobile-spike/src/ui/screens/DeleteAccountPanel.tsx',
  'src/features/legal/PrivacyPage.tsx',
]
const read = (p: string): string => readFileSync(p, 'utf8')
// Visible text only: JSX text and string literals, not comments.
const visible = (p: string): string =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s+/g, ' ')

describe('deletion copy makes only supportable claims', () => {
  it.each(SOURCES)('%s states no retention period for backups or logs', (p) => {
    const text = visible(p)
    expect(text).not.toMatch(/\b\d+\s*(days?|weeks?|months?)\b[^.]{0,40}(backup|log)/i)
    expect(text).not.toMatch(/(backup|log)s?[^.]{0,60}\b\d+\s*(days?|weeks?|months?)\b/i)
  })

  it.each(SOURCES)('%s never claims immediate erasure from every backup', (p) => {
    const text = visible(p)
    expect(text).not.toMatch(/(erased|deleted|removed)[^.]{0,40}(from )?(all|every) backups?/i)
    expect(text).not.toMatch(/immediately[^.]{0,40}backups?/i)
  })

  it('the three user-facing surfaces all say that earlier backups are not rewritten', () => {
    for (const p of SOURCES.slice(0, 3)) {
      expect(visible(p)).toMatch(/not rewritten/i)
    }
  })

  it('exactly one contact address exists across the deletion surfaces, the one Privacy already used', () => {
    expect(read('src/features/legal/contact.ts')).toContain("'oskarhn06@outlook.com'")
    for (const p of SOURCES) {
      const addresses = read(p).match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? []
      expect(addresses).toEqual([])
    }
  })
})

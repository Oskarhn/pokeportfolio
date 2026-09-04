import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * P103 — static accessibility audit for the scanner UI (no model loading, no DB, no rendering
 * infrastructure required — this project has none, see D-109/D-110's own notes). Mirrors
 * scanner-network-audit.test.ts's established pattern: source-text assertions instead of a
 * rendered component tree.
 *
 * Scope: the two jsx-a11y findings P101 previously suppressed for the whole scanner directory
 * (media-has-caption, img-redundant-alt) are now handled narrowly (one inline eslint-disable with
 * a justification comment; a reworded alt string) — this test pins both fixes so neither can
 * silently regress back to a directory-wide suppression, plus the accessible-name/live-region
 * contract on the controls named in the P103 prompt (shutter, close, retake, manual search,
 * candidate selection, status announcements).
 */

const SCANNER_PAGE = join(process.cwd(), 'src', 'features', 'scanner', 'ScannerPage.tsx')

function source(): string {
  return readFileSync(SCANNER_PAGE, 'utf-8')
}

describe('P103 scanner a11y static audit', () => {
  it('no alt text anywhere in ScannerPage.tsx contains a redundant "image/picture/photo" word', () => {
    const text = source()
    const altMatches = [...text.matchAll(/\balt=(\{[^}]*\}|"[^"]*"|'[^']*')/g)]
    expect(altMatches.length).toBeGreaterThan(0)
    for (const match of altMatches) {
      const value = match[1] ?? ''
      expect(value.toLowerCase()).not.toMatch(/\b(image|picture|photo)\b/)
    }
  })

  it('the live camera preview <video> is muted (no audio track ever exists) and carries a documented media-has-caption exception', () => {
    const text = source()
    const videoIndex = text.indexOf('<video')
    expect(videoIndex).toBeGreaterThan(-1)
    const preceding = text.slice(Math.max(0, videoIndex - 400), videoIndex)
    expect(preceding).toMatch(/eslint-disable-next-line jsx-a11y\/media-has-caption/)
    expect(preceding).toMatch(/no audio or dialogue/i)

    const cameraSession = readFileSync(
      join(process.cwd(), 'src', 'features', 'scanner', 'camera-session.ts'),
      'utf-8',
    )
    expect(cameraSession).toMatch(/CAMERA_VIDEO_PROPS[\s\S]*?muted:\s*true/)
  })

  it('eslint.config.js no longer suppresses jsx-a11y rules for the whole scanner directory', () => {
    const eslintConfig = readFileSync(join(process.cwd(), 'eslint.config.js'), 'utf-8')
    expect(eslintConfig).not.toMatch(
      /features\/scanner\/\*\*\/\*\.tsx[^]*?jsx-a11y\/media-has-caption['"]\s*:\s*['"]off['"]/,
    )
    expect(eslintConfig).not.toContain("'jsx-a11y/img-redundant-alt': 'off'")
  })

  it('the close-scanner and shutter controls have explicit accessible names', () => {
    const text = source()
    expect(text).toMatch(/aria-label="Close scanner"/)
    expect(text).toMatch(/aria-label="Capture card"/)
  })

  it('the manual-search entry point and its cancel control have accessible names', () => {
    const text = source()
    expect(text).toMatch(/Not right\? Search manually/)
    expect(text).toContain('Search manually') // dialog heading
  })

  it('candidate selection buttons expose pressed state via aria-pressed', () => {
    const text = source()
    expect(text).toMatch(/aria-pressed=\{selected\}/)
  })

  it('processing/result/no-match status text is announced via role="status"', () => {
    const text = source()
    const statusOccurrences = text.match(/role="status"/g) ?? []
    expect(statusOccurrences.length).toBeGreaterThanOrEqual(5)
  })

  it('the batch-remove control names the specific candidate being removed', () => {
    const text = source()
    expect(text).toMatch(/aria-label=\{`Remove \$\{item\.candidate\.name\}`\}/)
  })
})

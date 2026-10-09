import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * P202: iOS Safari zooms the whole page when a text control smaller than 16px takes focus, and does
 * not zoom back out, which shifts the layout under the user's thumb. Every text-entry control
 * therefore has to be `text-base` (16px) on touch widths; desktop may shrink it with `md:text-*`.
 *
 * This is a source-level guard because the affected controls sit behind data and wizard steps that
 * a route-level browser test does not reach.
 */

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(dir, entry.name))
      : entry.name.endsWith('.tsx')
        ? [join(dir, entry.name)]
        : [],
  )
}

// The scanner's amber diagnostics field is an owner/debug surface, not product UI.
const ALLOWED = ['border-amber-800/60']

describe('form controls are at least 16px on touch widths', () => {
  it('no <input>, <select> or <textarea> is sized text-sm / text-xs without a text-base base size', () => {
    const offenders: string[] = []
    for (const file of sourceFiles('src')) {
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(/<(input|select|textarea)\b/g)) {
        const start = match.index
        let segment = source.slice(start, start + 900)
        const end = segment.search(/\/>|<\/(select|textarea)>/)
        if (end > 0) segment = segment.slice(0, end)
        if (/type="(checkbox|radio|hidden|range|file)"/.test(segment)) continue
        const classMatch = /className=(?:"([^"]*)"|\{`([^`]*)`\})/.exec(segment)
        const classes = classMatch?.[1] ?? classMatch?.[2] ?? ''
        if (ALLOWED.some((a) => classes.includes(a))) continue
        const small = /(^|\s)text-(sm|xs|\[1[0-5]px\])(\s|$)/.test(classes)
        const base = /(^|\s)text-base(\s|$)/.test(classes)
        if (small && !base) {
          const line = source.slice(0, start).split('\n').length
          offenders.push(`${file}:${line}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})

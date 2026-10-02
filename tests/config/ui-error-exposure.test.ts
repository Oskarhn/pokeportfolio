/**
 * P130-26 static guard: no screen renders an error's own message.
 *
 * A UI file may not read `<something>Error.message` / `err.message` / `caught.message` unless the
 * line goes through `userMessage(...)` or is on the reviewed allowlist below, where each entry says
 * why the text is product-authored (a typed error whose message is fixed in this codebase) or never
 * reaches the screen. A new `setError(err.message)` fails here — the way the original leak shipped.
 * Behaviour (what the sanitiser returns for injected backend failures) is tests/ui/user-error.test.ts.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOTS = ['src/features', 'src/ui', 'src/auth']
const FILE = /\.(ts|tsx)$/
const MESSAGE_READ = /\b(?:[A-Za-z_.]*(?:rror|err|caught|failure|cause)|e|ex)\??\.message\b/

/** `file` → reasons the listed read is not a backend message reaching a person. */
const ALLOWED: Record<string, string> = {
  'src/features/admin/InvitationsPage.tsx':
    'throws new Error(...) inside queryFn (never rendered) and maps RPC codes to fixed admin sentences',
  'src/features/openings/controller.ts':
    'input to mapOpeningErrorMessage, which returns one of a fixed set of sentences',
  'src/features/price-check/scan-session.ts':
    'ScannerIdentificationError messages are one of four fixed strings (scanner-identification.ts)',
  'src/features/purchases/PurchaseFormPage.tsx':
    'guarded by instanceof FxRateNotFoundError (UserFacingError, authored text)',
  'src/features/scanner/errors.ts':
    'scanner-typed errors (ScannerEngineError etc.) carry pre-sanitised copy; checked by name',
  'src/features/scanner/ScannerPage.tsx':
    'captureError is the {title, message} produced by describeCaptureError, not an Error',
  'src/features/scanner/visual/visual-worker.ts':
    'worker-internal diagnostic posted to the client; surfaced only through scanner debug state',
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...walk(path))
    else if (FILE.test(name) && !/\.test\./.test(name)) out.push(path.replace(/\\/g, '/'))
  }
  return out
}

/** Lines that read an error message and do not go through the sanitiser. */
function offendingLines(text: string): string[] {
  return text.split('\n').filter((line) => {
    if (/^\s*(\*|\/\/)/.test(line)) return false
    if (/userMessage\(/.test(line)) return false
    return MESSAGE_READ.test(line)
  })
}

describe('P130-26 — UI sources do not render raw error messages', () => {
  const files = ROOTS.flatMap(walk)

  it('finds the UI sources (the audit is not vacuous)', () => {
    expect(files.length).toBeGreaterThan(50)
  })

  it('every direct error-message read is on the reviewed allowlist', () => {
    const unreviewed: string[] = []
    for (const file of files) {
      const lines = offendingLines(readFileSync(file, 'utf8'))
      if (lines.length > 0 && !(file in ALLOWED)) unreviewed.push(`${file}: ${lines[0]!.trim()}`)
    }
    expect(unreviewed).toEqual([])
  })

  it('every allowlist entry still has a hit (stale entries are removed, not kept)', () => {
    for (const file of Object.keys(ALLOWED)) {
      expect(offendingLines(readFileSync(file, 'utf8')).length, file).toBeGreaterThan(0)
    }
  })

  it('mutation: the audit flags the shape that originally leaked', () => {
    expect(offendingLines('  onError: (e: Error) => { setError(e.message) }')).toHaveLength(1)
    expect(offendingLines('  setError(mutationError.message)')).toHaveLength(1)
    expect(offendingLines('  setError(userMessage(mutationError))')).toHaveLength(0)
  })
})

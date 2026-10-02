/**
 * P164 cross-track mutants — the eight integration defects, applied ONE AT A TIME to the integrated
 * tree. Run with the P151 runner (a mutant is KILLED only by a real assertion failure or a hang
 * timeout, never by a compile/load error; every file is restored byte-for-byte, SHA-256 verified):
 *
 *   node scripts/scanner-p151/run-mutations.mjs --mutants scripts/p164/mutants.mjs [--only C1,C2]
 *
 * `tests` is the narrowest set that must notice the defect. Browser-only witnesses (Playwright,
 * tests/e2e/authenticated/p164-cross-track.spec.ts) are run by hand for the mutants that name one.
 */
const SESSION = 'tests/ui/price-check-scan-session.test.ts'
const INTEGRATION = 'tests/ui/p161-scanner-price-check-integration.test.ts'
const GUARD = 'tests/ui/price-check-read-only.test.ts'
const PAGE = 'tests/ui/p161-price-check-photo-input.test.ts'
const TRANSPORT = 'tests/data/p164-price-check-real-transport.test.ts'
const SKEW = 'tests/data/p164-search-prices-skew.test.ts'

export const MUTANTS = [
  {
    id: 'C1',
    what: 'commitBatch exposed from Price Check: the read-only port forwards the acquisition path',
    file: 'src/features/scanner/scanner-identification.ts',
    find: '    dispose: () => {\n      controller.dispose()\n    },\n  }',
    replace:
      "    dispose: () => {\n      controller.dispose()\n    },\n    commitBatch: (...args: Parameters<ScannerUiController['commitBatch']>) =>\n      controller.commitBatch(...args),\n  } as ReadOnlyScannerPort",
    tests: [SESSION, INTEGRATION, 'tests/ui/scanner-p151-identification.test.ts'],
  },
  {
    id: 'C2a',
    what: 'scanner stale-result gate off: a newer scan no longer aborts the older one',
    file: 'src/features/scanner/controller.ts',
    find: '    activeScan?.abort.abort()\n    scanSequence += 1',
    replace: '    scanSequence += 1',
    tests: [INTEGRATION, 'tests/ui/scanner-p151-controller-ordering.test.ts'],
  },
  {
    id: 'C2b',
    what: 'scanner publish gate removed: an aborted scan can still write shared state / deliver',
    file: 'src/features/scanner/controller.ts',
    find: '    throwIfAnalysisAborted(signal)\n\n    const match = matchScannerObservation(',
    replace: '    const match = matchScannerObservation(',
    tests: [INTEGRATION, 'tests/ui/scanner-p151-controller-ordering.test.ts'],
  },
  {
    id: 'C2c',
    what: 'Price Check session ignores its abort signal: a stale result is delivered',
    file: 'src/features/price-check/scan-session.ts',
    find: "      if (isAborted(controller.signal)) return { status: 'abandoned' }\n",
    replace: '',
    tests: [SESSION, INTEGRATION],
  },
  {
    id: 'C3a',
    what: 'lease bypass in the scanner acquisition path: commitBatch writes through the shared client',
    file: 'src/features/scanner/controller.ts',
    find: '    const db = leasedDb(lease)\n',
    replace: '    const db = undefined\n',
    tests: [
      'tests/ui/scanner-controller.test.ts',
      'tests/ui/export-identity-lease-coverage.test.ts',
    ],
  },
  {
    id: 'C3b',
    what: 'lease bypass: commitBatch keeps writing after the identity lease ended (only `disposed` stops it)',
    file: 'src/features/scanner/controller.ts',
    find: '      if (disposed || !lease.isCurrent()) break',
    replace: '      if (disposed) break',
    tests: ['tests/ui/scanner-controller.test.ts'],
  },
  {
    id: 'C4a',
    what: 'A’s export delivers after the identity changed: the delivery gate ignores the lease',
    file: 'src/features/export/fileDelivery.ts',
    find: "  if (lease === null || !lease.isCurrent()) return { status: 'stale' }",
    replace: '  void lease',
    tests: [
      'tests/ui/export-file-delivery.test.ts',
      'tests/ui/export-identity-lease-coverage.test.ts',
    ],
  },
  {
    id: 'C4b',
    what: 'A’s export keeps reading after the identity changed: the lease guard no longer checks the lease',
    file: 'src/data/export/identity-guard.ts',
    find: '    assertUnchanged() {\n      lease.assertCurrent()\n      return Promise.resolve()',
    replace: '    assertUnchanged() {\n      return Promise.resolve()',
    tests: [
      'tests/data/export-fetch-attacks.test.ts',
      'tests/data/export-quick-portfolio-csv.test.ts',
    ],
  },
  {
    id: 'C5a',
    what: 'unsafe headline accepted: Price Check no longer refuses a response the guard had to rewrite',
    file: 'src/data/price-check.ts',
    find: "  if (invoked.response?.headers.get(EXACT_TRANSPORT_REWRITE_HEADER) != null) {\n    throw new PriceCheckError('malformed_response')\n  }\n",
    replace: '',
    tests: [TRANSPORT, SKEW],
  },
  {
    id: 'C5b',
    what: 'unsafe headline accepted: the pricing consumer keeps quoted digits of a rounded number',
    file: 'src/data/pricing.ts',
    find: '    if (invoked.response?.headers.get(EXACT_TRANSPORT_REWRITE_HEADER) != null) return new Map()\n',
    replace: '',
    tests: [SKEW],
  },
  {
    id: 'C5c',
    what: 'unsafe headline accepted (second layer): the headline parser turns a rounded number into BigInt(rounded)',
    file: 'src/domain/price-check/raw-observations.ts',
    find: "typeof minor === 'number' && Number.isSafeInteger(minor) && minor >= 0 ? String(minor) : null",
    replace:
      "(typeof minor === 'number' && minor >= 0) || (typeof minor === 'string' && /^\\d+$/.test(minor)) ? String(minor) : null",
    tests: [TRANSPORT, 'tests/domain/price-check/raw-observations.test.ts'],
  },
  {
    id: 'C6a',
    what: 'invented graded price: a multiplier appears in Price Check code',
    file: 'src/domain/price-check/graded.ts',
    find: 'export function gradedSection(input: {',
    replace: 'const GRADED_MULTIPLIER = 1.5\nexport function gradedSection(input: {',
    tests: [PAGE],
  },
  {
    id: 'C6b',
    what: 'invented graded price: with no graded source the section claims to be available',
    file: 'src/domain/price-check/graded.ts',
    find: "  if (input.sources.length === 0) unavailable = 'graded_source_not_configured'",
    replace:
      "  if (input.sources.length === 0)\n    return { status: 'available', observations: [], unavailable: null, dropped: input.dropped, sources: input.sources }",
    tests: [
      'tests/domain/price-check/identity-graded-scan.test.ts',
      'tests/ui/price-check-render.test.ts',
    ],
  },
  {
    id: 'C7',
    what: 'explicit variant confirmation dropped: a multi-printing card is auto-resolved to the first',
    file: 'src/domain/price-check/identity.ts',
    find: "  return { status: 'choice_required', variants }",
    replace:
      "  const [first] = variants\n  if (first !== undefined) return { status: 'confirmed', variant: first, basis: 'chosen' }\n  return { status: 'choice_required', variants }",
    tests: [
      'tests/domain/price-check/identity-graded-scan.test.ts',
      'tests/ui/price-check-render.test.ts',
    ],
  },
  {
    id: 'C8a',
    what: 'no scanner cleanup on account switch: the scan screen no longer disposes its session',
    file: 'src/features/price-check/PriceCheckScanPage.tsx',
    find: '      created?.dispose()\n',
    replace: '',
    tests: [PAGE],
  },
  {
    id: 'C8b',
    what: 'no cleanup on account switch: the authenticated subtree is no longer keyed by the user id',
    file: 'src/auth/AuthIdentityBoundary.tsx',
    find: '<Fragment key={identityKey(session?.user.id ?? null)}>{children}</Fragment>',
    replace: '<Fragment>{children}</Fragment>',
    tests: [
      'tests/ui/auth-identity-boundary.test.ts',
      'tests/ui/identity-switch-mount-lifecycle.test.ts',
    ],
  },
]

/**
 * P161 mutants for the scanner + Price Check integration. Run with the P151 runner (same rules: a
 * mutant is KILLED only by a real assertion failure — or a hang timeout — never by a compile error;
 * every mutated file is restored byte-for-byte and its SHA-256 verified):
 *
 *   node scripts/scanner-p151/run-mutations.mjs --mutants scripts/scanner-p161/mutants.mjs [--only X1,X2]
 *
 * Each mutant re-introduces ONE integration defect. `tests` is the narrowest set that must notice it.
 */
const INTEGRATION = 'tests/ui/p161-scanner-price-check-integration.test.ts'
const SESSION = 'tests/ui/price-check-scan-session.test.ts'
const GUARD = 'tests/ui/price-check-read-only.test.ts'
const PAGE = 'tests/ui/p161-price-check-photo-input.test.ts'

export const MUTANTS = [
  {
    id: 'X1',
    what: 'stale result accepted: the session ignores its shared abort signal and delivers whatever finishes',
    file: 'src/features/price-check/scan-session.ts',
    find: "      if (isAborted(controller.signal)) return { status: 'abandoned' }\n",
    replace: '',
    tests: [SESSION, INTEGRATION],
  },
  {
    id: 'X1b',
    what: 'stale result accepted: a newer analysis no longer aborts the older one (session level)',
    file: 'src/features/price-check/scan-session.ts',
    find: '    this.inFlight?.abort()\n    const controller = new AbortController()',
    replace: '    const controller = new AbortController()',
    tests: [SESSION, INTEGRATION],
  },
  {
    id: 'X1c',
    what: 'stale result accepted: the scanner controller stops aborting a superseded scan (latest-wins gone)',
    file: 'src/features/scanner/controller.ts',
    find: '    activeScan?.abort.abort()\n    scanSequence += 1',
    replace: '    scanSequence += 1',
    tests: [INTEGRATION],
  },
  {
    id: 'X1d',
    what: 'stale result accepted: the scanner publish gate is removed',
    file: 'src/features/scanner/controller.ts',
    find: '    throwIfAnalysisAborted(signal)\n\n    const match = matchScannerObservation(',
    replace: '    const match = matchScannerObservation(',
    tests: [INTEGRATION],
  },
  {
    id: 'X2',
    what: 'visual-only HIGH: the confidence cap is bypassed, so Price Check pre-selects a sibling printing',
    file: 'src/domain/scanner/engine.ts',
    find: "  if (tier === 'high' && signals.collectorNumber === null && signals.normalizedName === null) {",
    replace: '  if (false as boolean) {',
    tests: [INTEGRATION],
  },
  {
    id: 'X2b',
    what: 'HIGH pre-selects the runner-up when the scanner’s own best candidate was filtered out',
    file: 'src/domain/price-check/scan.ts',
    find: 'scannerBestId === undefined || scannerBestId === best.candidateId',
    replace: 'true',
    tests: ['tests/domain/price-check/identity-graded-scan.test.ts', SESSION],
  },
  {
    id: 'X3',
    what: 'commitBatch exposed: the read-only port forwards the acquisition path',
    file: 'src/features/scanner/scanner-identification.ts',
    find: '    dispose: () => {\n      controller.dispose()\n    },\n  }',
    replace:
      "    dispose: () => {\n      controller.dispose()\n    },\n    commitBatch: (...args: Parameters<ScannerUiController['commitBatch']>) =>\n      controller.commitBatch(...args),\n  } as ReadOnlyScannerPort",
    tests: [SESSION, INTEGRATION, 'tests/ui/scanner-p151-identification.test.ts'],
  },
  {
    id: 'X3b',
    what: 'commitBatch reachable by name: Price Check imports the full controller factory',
    file: 'src/features/price-check/scan-session.ts',
    find: 'export type ScanResult =',
    replace:
      "import { getScannerUiController as __leak } from '../scanner/controller'\nexport const __leaked = __leak\nexport type ScanResult =",
    tests: [GUARD],
  },
  {
    id: 'X4',
    what: 'wrong-variant value: a card with several variants is auto-resolved to the first one',
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
    id: 'X5',
    what: 'missing graded price replaced by a value: with no graded source the section claims to be available',
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
    id: 'X5b',
    what: 'graded price derived from raw by a multiplier: a multiplier appears in Price Check code',
    file: 'src/domain/price-check/graded.ts',
    find: 'export function gradedSection(input: {',
    replace: 'const GRADED_MULTIPLIER = 1.5\nexport function gradedSection(input: {',
    tests: [PAGE],
  },
  {
    id: 'X6',
    what: 'removed size guard: the pre-decode dimension check is gone (photo path shared with Price Check)',
    file: 'src/features/scanner/capture.ts',
    find: '  if (declared !== null) throwForVerdict(assessImageDimensions(declared.width, declared.height))',
    replace: '  void declared',
    tests: [PAGE],
  },
  {
    id: 'X7',
    what: 'leaked worker after unmount: session.dispose() no longer releases the scanner',
    file: 'src/features/price-check/scan-session.ts',
    find: '    this.disposed = true\n    this.port.dispose()',
    replace: '    this.disposed = true',
    tests: [SESSION, INTEGRATION],
  },
  {
    id: 'X7b',
    what: 'leaked worker after unmount: the scan screen no longer disposes its session on cleanup',
    file: 'src/features/price-check/PriceCheckScanPage.tsx',
    find: '      created?.dispose()\n',
    replace: '',
    tests: [PAGE],
  },
  {
    id: 'X8',
    what: 'missing price converted to zero: a headline row without a value becomes a 0 observation',
    file: 'src/domain/price-check/raw-observations.ts',
    find: 'minor >= 0 ? String(minor) : null',
    replace: "minor >= 0 ? String(minor) : '0'",
    tests: [
      'tests/domain/price-check/raw-observations.test.ts',
      'tests/data/price-observations.test.ts',
      'tests/ui/price-check-render.test.ts',
    ],
  },
  {
    id: 'X9',
    what: 'photo pick race: the page no longer begins a newer capture (older decode can overtake)',
    file: 'src/features/price-check/PriceCheckScanPage.tsx',
    find: '    const token = captureGuard.begin()\n',
    replace: '    const token = 0\n',
    tests: [PAGE],
  },
  {
    id: 'X10',
    what: 'A→B leak: the scan screen is no longer keyed by identity, so A’s photo/candidates survive a switch',
    file: 'src/features/price-check/PriceCheckScanPage.tsx',
    find: "<PriceCheckScanScreen key={userId ?? 'signed-out'} userId={userId} />",
    replace: '<PriceCheckScanScreen userId={userId} />',
    tests: [PAGE],
  },
]

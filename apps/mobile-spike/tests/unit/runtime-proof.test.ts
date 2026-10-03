import { runAndLogRuntimeProof, runRuntimeProof } from '../../src/diagnostics/runtime-proof'

// Proves the in-app proof itself is correct on Node/V8. Evidence about Hermes comes only from the
// same function running on a device or emulator (docs/mobile/P166_RUNTIME_AND_STITCH_REVIEW.md).
describe('in-app exact-money runtime proof', () => {
  it('passes every check on this engine', () => {
    const result = runRuntimeProof()
    expect(result.lines.filter((l) => l.startsWith('FAIL'))).toEqual([])
    expect(result.fail).toBe(0)
    expect(result.pass).toBeGreaterThanOrEqual(35)
  })

  it('reports the engine and never claims Hermes under Jest', () => {
    expect(runRuntimeProof().engine).toBe('not-hermes')
  })

  it('ends the log with a single filterable verdict line', () => {
    const lines: string[] = []
    runAndLogRuntimeProof((l) => lines.push(l))
    expect(lines.every((l) => l.startsWith('P166_PROOF '))).toBe(true)
    expect(lines.at(-1)).toMatch(/^P166_PROOF RESULT pass=\d+ fail=0 engine=not-hermes$/)
  })
})

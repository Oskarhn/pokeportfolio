/// <reference types="vitest/config" />
import { defineConfig } from 'vite'

// P117 high-volume property/fuzz suite (docs/TESTING.md's "infrastructure-free" tier, taken to
// deliberately high iteration counts). Kept OUT of `pnpm test`/`pnpm check` on purpose: these are
// the same pure-domain/client invariants the normal suite already checks at ordinary fast-check
// defaults, re-run here at orders of magnitude more cases to hunt for the rare counterexample a
// few hundred runs would miss, plus dedicated fuzz/state-machine/scale suites too slow for the
// per-commit gate. No database, no browser — everything here is a pure function or an in-memory
// state machine. Run on demand via `pnpm test:soak`; not part of CI's per-push gate.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/soak/**/*.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 60_000,
  },
})

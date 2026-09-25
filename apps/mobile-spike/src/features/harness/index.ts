import { registerRootComponent } from 'expo'
import { P169HarnessApp } from './P169HarnessApp'

// Separate app entry for the P169 harness (scripts/p169/build-harness.mjs points the Android build
// at this file). The P166 app entry (../../../index.ts) is unchanged.
type Proofs = typeof import('./p169-proof') & typeof import('../../diagnostics/runtime-proof')
if (process.env.EXPO_PUBLIC_RUNTIME_PROOF === '1') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ;(require('../../diagnostics/runtime-proof') as Proofs).runAndLogRuntimeProof()
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ;(require('./p169-proof') as Proofs).runAndLogP169Proof()
}

registerRootComponent(P169HarnessApp)

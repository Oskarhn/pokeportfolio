import { registerRootComponent } from 'expo'
import App from './App'

// Opt-in at bundle time only (EXPO_PUBLIC_* is inlined by babel-preset-expo): runs the exact-money
// proofs once on the engine that executes this bundle and logs `P166_PROOF ...` (shell money) and
// `P169_PROOF ...` (Price Check domain) lines to logcat.
type Proofs = typeof import('./src/diagnostics/runtime-proof') &
  typeof import('./src/diagnostics/price-check-proof')
if (process.env.EXPO_PUBLIC_RUNTIME_PROOF === '1') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ;(require('./src/diagnostics/runtime-proof') as Proofs).runAndLogRuntimeProof()
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ;(require('./src/diagnostics/price-check-proof') as Proofs).runAndLogP169Proof()
}

registerRootComponent(App)

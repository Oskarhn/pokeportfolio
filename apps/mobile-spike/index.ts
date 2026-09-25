import { registerRootComponent } from 'expo'
import App from './App'

// Opt-in at bundle time only (EXPO_PUBLIC_* is inlined by babel-preset-expo): runs the exact-money
// proof once on the engine that executes this bundle and logs `P166_PROOF ...` lines (logcat).
type RuntimeProof = typeof import('./src/diagnostics/runtime-proof')
if (process.env.EXPO_PUBLIC_RUNTIME_PROOF === '1') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ;(require('./src/diagnostics/runtime-proof') as RuntimeProof).runAndLogRuntimeProof()
}

registerRootComponent(App)

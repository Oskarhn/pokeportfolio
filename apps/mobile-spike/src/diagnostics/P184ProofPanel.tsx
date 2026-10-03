import { useState } from 'react'
import { View } from 'react-native'
import type { CardRecognitionPort } from '../features/price-check/recognition'
import type { ScannerImageInput } from '../photo/photo-store'
import { Body, SecondaryButton } from '../ui/components'
import { SPACE } from '../ui/theme'
import {
  formatTally,
  pendingScanDelayMs,
  runOverlappedBurst,
  runSequentialStress,
  setNextScanDelayMs,
} from './p184-proof'

/**
 * Proof-build-only controls (P184; rendered only when EXPO_PUBLIC_RUNTIME_PROOF=1): hold the next
 * analysis so a device driver can race it against a second photo / navigation / backgrounding /
 * sign-out, and repeat the analysis of the photo on screen for the performance and memory gates.
 * Every action goes through the same `recognition` port the screen uses.
 */
export function P184ProofPanel({
  recognition,
  input,
}: {
  recognition: CardRecognitionPort
  input: ScannerImageInput | null
}) {
  const [status, setStatus] = useState('idle')
  const [delay, setDelay] = useState(pendingScanDelayMs())

  return (
    <View style={{ gap: SPACE.sm }} testID="p184-proof-panel">
      <Body muted testID="p184-proof-status">{`proof ${status} delay=${String(delay)}`}</Body>
      <SecondaryButton
        label="Proof: hold next scan 20 s"
        testID="p184-proof-delay"
        onPress={() => {
          setNextScanDelayMs(20_000)
          setDelay(20_000)
        }}
      />
      <SecondaryButton
        label="Proof: analyse 25 times"
        testID="p184-proof-stress-25"
        onPress={() => {
          if (input === null) return
          void runSequentialStress(recognition, input, 25, (t) =>
            setStatus(formatTally('stress25', t)),
          )
        }}
      />
      <SecondaryButton
        label="Proof: analyse 100 times"
        testID="p184-proof-stress-100"
        onPress={() => {
          if (input === null) return
          void runSequentialStress(recognition, input, 100, (t) =>
            setStatus(formatTally('stress100', t)),
          )
        }}
      />
      <SecondaryButton
        label="Proof: burst of 8 overlapping"
        testID="p184-proof-burst-8"
        onPress={() => {
          if (input === null) return
          void runOverlappedBurst(recognition, input, 8, 150, (t) =>
            setStatus(formatTally('burst8', t)),
          )
        }}
      />
    </View>
  )
}

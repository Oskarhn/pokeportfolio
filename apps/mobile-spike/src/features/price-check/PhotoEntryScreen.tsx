import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, Image, ScrollView, View } from 'react-native'
import { useFocusEffect, useIsFocused } from '@react-navigation/native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { toScannerInput } from '../../photo/photo-store'
import {
  Body,
  Heading,
  InlineNotice,
  Loading,
  PrimaryButton,
  SecondaryButton,
  SectionHeader,
  StatusBadge,
  CardRow,
} from '../../ui/components'
import { useStore } from '../../ui/runtime-context'
import { SPACE, useTheme } from '../../ui/theme'
import { useP169, type P169StackParams } from '../navigation'
import { ActionButton, LiveStatus, Section } from '../ui/kit'
import { P184_PROOF_ENABLED } from '../../diagnostics/p184-proof'
import { P184ProofPanel } from '../../diagnostics/P184ProofPanel'
import { shouldResumeRecognition } from './recognition-lifecycle'
import type { RecognitionOutcome } from './recognition'
import type { ScanCandidate } from './p165-domain/price-check/scan'

/**
 * Photo -> identification entry (P182). A photo is analysed on-device (OCR + visual embedding,
 * see ../scanner-native/recognition-pipeline.ts); the image itself is never uploaded (deleted when
 * the person leaves this screen or the identity changes, same PhotoStore contract as before). A
 * HIGH result pre-highlights a candidate — it never saves a card, chooses a printing/finish, or
 * infers a grade/condition/price. The person always confirms explicitly (mission §13/§16).
 */
export function PhotoEntryScreen({
  navigation,
}: NativeStackScreenProps<P169StackParams, 'P169PhotoEntry'>) {
  const { feature } = useP169()
  const photo = useStore(feature.photo)
  const t = useTheme()
  const [recognition, setRecognition] = useState<RecognitionOutcome | null>(null)
  const [showAllCandidates, setShowAllCandidates] = useState(false)
  // Bumped to start a fresh recognition of the SAME photo after the app came back to the
  // foreground (P184): backgrounding cancels the running recognition instead of letting it burn
  // CPU, and the person finds the photo analysed again when they return.
  const [resumeKey, setResumeKey] = useState(0)
  // Only the screen the person is looking at analyses: another mounted instance of this screen
  // (a second stack entry) sharing the one recognition port would cancel this one's scan and be
  // cancelled in turn, forever.
  const focused = useIsFocused()
  // Set only by THIS screen's background handler: a cancelled answer is re-analysed on return
  // solely when the app itself cancelled it, never because someone else superseded the scan.
  const cancelledByBackgroundRef = useRef(false)
  const inFlightRef = useRef(false)
  const outcomeStatusRef = useRef<RecognitionOutcome['status'] | null>(null)
  const photoReadyRef = useRef(false)
  photoReadyRef.current = photo.status === 'ready' && photo.image !== null

  useFocusEffect(
    useCallback(
      () => () => {
        void feature.photo.release()
      },
      [feature.photo],
    ),
  )

  const runRecognition = useCallback(() => {
    let live = true
    setRecognition(null)
    outcomeStatusRef.current = null
    setShowAllCandidates(false)
    if (focused && photo.status === 'ready' && photo.image !== null) {
      inFlightRef.current = true
      void feature.recognition.recognize(toScannerInput(photo.image)).then((outcome) => {
        if (!live) return
        inFlightRef.current = false
        outcomeStatusRef.current = outcome.status
        setRecognition(outcome)
        // Cancelled while the app was in the background but the app is already back: the person
        // is looking at this screen, so analyse again instead of leaving it blank.
        if (
          outcome.status === 'cancelled' &&
          cancelledByBackgroundRef.current &&
          AppState.currentState === 'active'
        ) {
          cancelledByBackgroundRef.current = false
          setResumeKey((key) => key + 1)
        }
      })
    }
    return () => {
      live = false
      inFlightRef.current = false
      // Leaving the screen (the photo is released on blur), a new photo or an identity change ends
      // this run: stop the recognition at its next checkpoint instead of letting it finish the
      // expensive stages and the catalog query for an answer nobody will see.
      feature.recognition.cancelActive?.()
    }
    // resumeKey is a deliberate re-run trigger, not a value read inside.
  }, [feature.recognition, photo.status, photo.image, resumeKey, focused])

  useEffect(runRecognition, [runRecognition])

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'background') {
        cancelledByBackgroundRef.current = inFlightRef.current
        feature.recognition.cancelActive?.()
      } else if (
        state === 'active' &&
        shouldResumeRecognition({
          photoReady: photoReadyRef.current,
          outcomeStatus: outcomeStatusRef.current,
          inFlight: inFlightRef.current,
        })
      ) {
        setResumeKey((key) => key + 1)
      }
    })
    return () => subscription.remove()
  }, [feature.recognition])

  const manual = () => navigation.navigate('P169Search')
  const openCard = (candidateId: string) => navigation.navigate('P169Card', { cardId: candidateId })
  const retake = () => {
    setRecognition(null)
    void feature.photo.release()
  }

  return (
    <ScrollView
      style={{ backgroundColor: t.background }}
      contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.lg }}
      testID="p169-photo-entry"
    >
      <Heading>Identify a card from a photo</Heading>
      {feature.recognition.implemented ? null : (
        <InlineNotice tone="info" testID="p169-recognition-unavailable">
          Card recognition from a photo is not available in this app yet. A photo does not currently
          identify the card automatically — choose the card and its printing yourself.
        </InlineNotice>
      )}
      <ActionButton
        testID="p169-choose-manually"
        label="Choose the card manually"
        onPress={manual}
      />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm }}>
        <ActionButton
          testID="p169-photo-library"
          variant="secondary"
          label="Choose a photo anyway"
          hint="The photo stays on this device and is deleted when you leave"
          disabled={photo.status === 'acquiring'}
          onPress={() => void feature.photo.acquire('library')}
        />
        <ActionButton
          testID="p169-photo-camera"
          variant="secondary"
          label="Take a photo"
          hint="The photo stays on this device and is deleted when you leave"
          disabled={photo.status === 'acquiring'}
          onPress={() => void feature.photo.acquire('camera')}
        />
      </View>
      {photo.status === 'acquiring' ? <Loading label="Waiting for the photo" /> : null}
      {photo.status === 'cancelled' ? (
        <LiveStatus testID="p169-photo-cancelled">No photo chosen.</LiveStatus>
      ) : null}
      {photo.status === 'denied' ? (
        <LiveStatus testID="p169-photo-denied">
          {photo.canAskAgain
            ? 'Camera access was not allowed. You can try again, or choose a photo from your library instead.'
            : 'Camera access was not allowed. Turn it on in the system settings, or choose a photo from your library instead.'}
        </LiveStatus>
      ) : null}
      {photo.status === 'unavailable' ? (
        <LiveStatus testID="p169-photo-unavailable" tone="danger">
          {photo.unavailableReason === 'no_camera'
            ? 'The camera is not available here. Choose a photo from your library instead.'
            : photo.unavailableReason === 'restart_required'
              ? 'The photo picker stopped working after a system setting changed. Close and reopen the app, then try again.'
              : 'The photo could not be opened. Try again.'}
        </LiveStatus>
      ) : null}
      {photo.status === 'ready' && photo.image !== null ? (
        <Section testID="p169-photo-ready">
          <Image
            accessibilityLabel="The photo you chose"
            source={{ uri: photo.image.uri }}
            style={{ width: '46%', aspectRatio: 0.72, borderRadius: 8, alignSelf: 'center' }}
          />
          <RecognitionSection
            outcome={recognition}
            showAllCandidates={showAllCandidates}
            onShowAllCandidates={() => setShowAllCandidates(true)}
            onOpenCard={openCard}
            onRetake={retake}
            onChooseManually={manual}
          />
        </Section>
      ) : null}
      {P184_PROOF_ENABLED ? (
        <P184ProofPanel
          recognition={feature.recognition}
          input={
            photo.status === 'ready' && photo.image !== null ? toScannerInput(photo.image) : null
          }
        />
      ) : null}
    </ScrollView>
  )
}

function RecognitionSection({
  outcome,
  showAllCandidates,
  onShowAllCandidates,
  onOpenCard,
  onRetake,
  onChooseManually,
}: {
  outcome: RecognitionOutcome | null
  showAllCandidates: boolean
  onShowAllCandidates: () => void
  onOpenCard: (candidateId: string) => void
  onRetake: () => void
  onChooseManually: () => void
}) {
  if (outcome === null) {
    return <Loading label="Analysing the photo" />
  }
  if (outcome.status === 'cancelled') {
    return null
  }
  if (outcome.status === 'not_available') {
    return (
      <Body testID="p169-photo-not-recognised" muted>
        This photo was not analysed: no recognizer is available in the app. Choose the card
        manually.
      </Body>
    )
  }
  if (outcome.status === 'abstain_quality') {
    return (
      <View style={{ gap: SPACE.sm }} testID="p169-recognition-abstain">
        <InlineNotice tone="warning">{outcome.reason}</InlineNotice>
        <SecondaryButton
          label="Retake the photo"
          onPress={onRetake}
          testID="p169-recognition-retake"
        />
      </View>
    )
  }
  if (outcome.status === 'error') {
    return (
      <View style={{ gap: SPACE.sm }} testID="p169-recognition-error">
        <InlineNotice tone="danger">
          This photo could not be analysed. Choose the card manually, or try again.
        </InlineNotice>
        <SecondaryButton label="Try again" onPress={onRetake} testID="p169-recognition-retry" />
      </View>
    )
  }
  const scan = outcome.outcome
  if (scan.kind === 'no_match') {
    return (
      <Body testID="p169-recognition-no-match" muted>
        This photo did not match a card in the catalog. Choose the card manually.
      </Body>
    )
  }
  const preselected = scan.kind === 'high' ? scan.preselectedId : null
  const confidenceLabel =
    scan.kind === 'high'
      ? 'High confidence'
      : scan.confidence === 'MEDIUM'
        ? 'Needs confirmation'
        : 'Low confidence'
  const visibleCandidates = showAllCandidates ? scan.candidates : scan.candidates.slice(0, 1)
  return (
    <View style={{ gap: SPACE.md }} testID="p169-recognition-result">
      <SectionHeader
        title={scan.kind === 'high' ? 'Likely match' : 'Possible matches'}
        testID="p169-recognition-heading"
      />
      <StatusBadge
        label={confidenceLabel}
        tone={
          scan.kind === 'high' ? 'positive' : scan.confidence === 'MEDIUM' ? 'warning' : 'neutral'
        }
        accessibilityLabel={`Match confidence: ${confidenceLabel}`}
        testID="p169-recognition-confidence"
      />
      {visibleCandidates.map((candidate: ScanCandidate) => (
        <CardRow
          key={candidate.candidateId}
          testID={`p169-recognition-candidate-${candidate.candidateId}`}
          title={candidate.name}
          value={null}
          subtitle={[candidate.setName, candidate.collectorNumber, candidate.languageLabel]
            .filter((part): part is string => part !== null)
            .join(' · ')}
          onPress={() => onOpenCard(candidate.candidateId)}
          wrapText
          accessibilityLabel={`${candidate.name}, ${candidate.setName ?? 'unknown set'}, ${candidate.collectorNumber ?? 'no printed number'}`}
        />
      ))}
      {!showAllCandidates && scan.candidates.length > 1 ? (
        <SecondaryButton
          label="Choose another card"
          onPress={onShowAllCandidates}
          testID="p169-recognition-choose-another"
        />
      ) : null}
      {preselected !== null ? (
        <PrimaryButton
          label="Confirm this card"
          onPress={() => onOpenCard(preselected)}
          testID="p169-recognition-confirm"
        />
      ) : null}
      <SecondaryButton
        label="Retake the photo"
        onPress={onRetake}
        testID="p169-recognition-retake"
      />
      <SecondaryButton
        label="Choose the card manually"
        onPress={onChooseManually}
        testID="p169-photo-choose-manually"
      />
    </View>
  )
}

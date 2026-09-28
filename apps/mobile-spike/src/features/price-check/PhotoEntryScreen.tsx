import { useCallback, useEffect, useState } from 'react'
import { Image, ScrollView, View } from 'react-native'
import { useFocusEffect } from '@react-navigation/native'
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
    setShowAllCandidates(false)
    if (photo.status === 'ready' && photo.image !== null) {
      void feature.recognition.recognize(toScannerInput(photo.image)).then((outcome) => {
        if (live) setRecognition(outcome)
      })
    }
    return () => {
      live = false
    }
  }, [feature.recognition, photo.status, photo.image])

  useEffect(runRecognition, [runRecognition])

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
            style={{ width: '100%', aspectRatio: 0.72, borderRadius: 8 }}
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
  const visibleCandidates = showAllCandidates ? scan.candidates : scan.candidates.slice(0, 1)
  return (
    <View style={{ gap: SPACE.md }} testID="p169-recognition-result">
      <SectionHeader
        title={scan.kind === 'high' ? 'Likely match' : 'Possible matches'}
        testID="p169-recognition-heading"
      />
      {scan.kind === 'review' ? (
        <StatusBadge
          label={scan.confidence === 'MEDIUM' ? 'Needs confirmation' : 'Low confidence'}
          tone={scan.confidence === 'MEDIUM' ? 'warning' : 'neutral'}
          testID="p169-recognition-confidence"
        />
      ) : null}
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

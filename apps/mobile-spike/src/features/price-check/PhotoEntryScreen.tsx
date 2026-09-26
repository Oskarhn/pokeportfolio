import { useCallback, useEffect, useState } from 'react'
import { Image, ScrollView, View } from 'react-native'
import { useFocusEffect } from '@react-navigation/native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { toScannerInput } from '../../photo/photo-store'
import { Heading, Loading } from '../../ui/components'
import { useStore } from '../../ui/runtime-context'
import { SPACE, usePalette } from '../../ui/theme'
import { useP169, type P169StackParams } from '../navigation'
import { ActionButton, Label, LiveStatus, Section } from '../ui/kit'
import type { RecognitionOutcome } from './recognition'

/**
 * Photo -> identification entry. The honest state today: the native app can take or choose a photo
 * (the runtime's PhotoStore), but it CANNOT recognise a card from it, so the only way on is "Choose
 * the card manually". A photo taken here is shown, passed to the recognition port (which answers
 * not_available), and deleted when the person leaves the screen (blur, pop, tab switch) or the
 * identity changes. Nothing is uploaded.
 */
export function PhotoEntryScreen({
  navigation,
}: NativeStackScreenProps<P169StackParams, 'P169PhotoEntry'>) {
  const { feature } = useP169()
  const photo = useStore(feature.photo)
  const p = usePalette()
  const [recognition, setRecognition] = useState<RecognitionOutcome | null>(null)

  useFocusEffect(
    useCallback(
      () => () => {
        void feature.photo.release()
      },
      [feature.photo],
    ),
  )

  useEffect(() => {
    let live = true
    setRecognition(null)
    if (photo.status === 'ready' && photo.image !== null) {
      void feature.recognition.recognize(toScannerInput(photo.image)).then((outcome) => {
        if (live) setRecognition(outcome)
      })
    }
    return () => {
      live = false
    }
  }, [feature.recognition, photo.status, photo.image])

  const manual = () => navigation.navigate('P169Search')

  return (
    <ScrollView
      style={{ backgroundColor: p.background }}
      contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.lg }}
      testID="p169-photo-entry"
    >
      <Heading>Identify a card from a photo</Heading>
      <Section testID="p169-recognition-unavailable">
        <LiveStatus>
          Card recognition from a photo is not available in this app yet. A photo does not currently
          identify the card automatically — choose the card and its printing yourself.
        </LiveStatus>
      </Section>
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
          {recognition?.status === 'not_available' ? (
            <Label testID="p169-photo-not-recognised">
              This photo was not analysed: no recognizer is available in the app. Choose the card
              manually.
            </Label>
          ) : null}
          <ActionButton
            testID="p169-photo-choose-manually"
            label="Choose the card manually"
            onPress={manual}
          />
        </Section>
      ) : null}
    </ScrollView>
  )
}

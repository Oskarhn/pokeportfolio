import { useCallback } from 'react'
import { Image, ScrollView, View } from 'react-native'
import { useFocusEffect } from '@react-navigation/native'
import { toScannerInput } from '../../photo/photo-store'
import { Badge, Body, Button, Card, Heading, Loading } from '../components'
import { useRuntime, useStore } from '../runtime-context'
import { SPACE } from '../theme'

/**
 * Bounded native-photo feasibility screen. It acquires an image (opt-in), shows a preview, and can
 * show the typed reference a future scanner port would receive. Nothing is recognised, saved to the
 * collection or uploaded. Leaving the screen (or changing identity) deletes the owned image file.
 */
export function PhotoSpikeScreen() {
  const { photo } = useRuntime()
  const state = useStore(photo)

  useFocusEffect(
    useCallback(() => {
      return () => {
        void photo.release()
      }
    }, [photo]),
  )

  return (
    <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.lg }} testID="photo-spike">
      <Heading>Photo (spike)</Heading>
      <Badge label="FEASIBILITY ONLY" />
      <Body muted>
        Choose or take a card photo to preview it. The photo stays on this device: it is not
        uploaded, recognised or saved to your collection. It is deleted when you leave this screen.
      </Body>
      <View style={{ flexDirection: 'row', gap: SPACE.sm, flexWrap: 'wrap' }}>
        <Button
          testID="photo-library"
          label="Choose photo"
          onPress={() => void photo.acquire('library')}
          disabled={state.status === 'acquiring'}
        />
        <Button
          testID="photo-camera"
          variant="secondary"
          label="Take photo"
          onPress={() => void photo.acquire('camera')}
          disabled={state.status === 'acquiring'}
        />
      </View>
      {state.status === 'acquiring' ? <Loading label="Waiting for the photo" /> : null}
      {state.status === 'denied' ? (
        <Card testID="photo-denied">
          <Body>Camera access was not allowed.</Body>
          <Body muted>
            {state.canAskAgain
              ? 'You can try again, or choose a photo from your library instead.'
              : 'Turn it on in the system settings, or choose a photo from your library instead.'}
          </Body>
        </Card>
      ) : null}
      {state.status === 'unavailable' ? (
        <Card testID="photo-unavailable">
          <Body>
            {state.unavailableReason === 'no_camera'
              ? 'The camera is not available here. Choose a photo from your library instead.'
              : 'The photo could not be opened. Try again.'}
          </Body>
        </Card>
      ) : null}
      {state.status === 'cancelled' ? (
        <Body muted testID="photo-cancelled">
          No photo chosen.
        </Body>
      ) : null}
      {state.status === 'ready' && state.image !== null ? (
        <Card testID="photo-ready">
          <Image
            testID="photo-preview"
            accessibilityLabel="Preview of the chosen card photo"
            source={{ uri: state.image.uri }}
            style={{ width: '100%', aspectRatio: 0.72, borderRadius: 8 }}
            resizeMode="contain"
          />
          <Body muted testID="photo-meta">
            {state.image.width}
            {'×'}
            {state.image.height} {'·'} {state.image.source}
          </Body>
          <Body muted testID="photo-scanner-ref">
            Scanner input: {JSON.stringify(toScannerInput(state.image))}
          </Body>
        </Card>
      ) : null}
    </ScrollView>
  )
}

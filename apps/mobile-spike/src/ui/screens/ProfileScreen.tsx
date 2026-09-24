import { ScrollView } from 'react-native'
import { Badge, Body, Button, Card, Heading } from '../components'
import { useRuntime, useStore } from '../runtime-context'
import { SPACE } from '../theme'

export function ProfileScreen({ backendHost }: { backendHost: string }) {
  const { auth } = useRuntime()
  const session = useStore(auth)
  return (
    <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.lg }} testID="profile">
      <Heading>Profile</Heading>
      <Card>
        <Body muted>Signed in as</Body>
        <Body testID="profile-email">{session.email ?? 'unknown'}</Body>
      </Card>
      <Card>
        <Body muted>Backend</Body>
        <Body testID="profile-host">{backendHost}</Body>
        <Badge label="READ-ONLY SPIKE BUILD" />
        <Body muted>
          Provisional native feasibility build. Not a product UI: navigation, colours and icon are
          not approved.
        </Body>
      </Card>
      {session.notice !== null ? (
        <Body testID="profile-notice">{session.notice.message}</Body>
      ) : null}
      <Button
        testID="sign-out"
        variant="danger"
        label="Sign out"
        onPress={() => void auth.signOut()}
      />
    </ScrollView>
  )
}

import {
  AppScreen,
  Body,
  DestructiveButton,
  SectionHeader,
  SegmentedControl,
  Surface,
} from '../components'
import { useRuntime, useStore } from '../runtime-context'
import { DeleteAccountPanel } from './DeleteAccountPanel'
import { useThemeMode, type ThemeMode } from '../theme'

export function ProfileScreen({ backendHost }: { backendHost: string }) {
  const { auth } = useRuntime()
  const session = useStore(auth)
  const { mode, setMode } = useThemeMode()
  return (
    <AppScreen testID="profile">
      <Surface>
        <Body muted>Signed in as</Body>
        <Body testID="profile-email">{session.email ?? 'unknown'}</Body>
      </Surface>
      <SectionHeader title="Appearance" />
      <SegmentedControl<ThemeMode>
        testID="profile-theme-mode"
        value={mode}
        onChange={setMode}
        options={[
          { value: 'dark', label: 'Dark', testID: 'profile-theme-dark' },
          { value: 'light', label: 'Light', testID: 'profile-theme-light' },
          { value: 'system', label: 'System', testID: 'profile-theme-system' },
        ]}
      />
      {session.notice !== null ? (
        <Body testID="profile-notice">{session.notice.message}</Body>
      ) : null}
      <DestructiveButton testID="sign-out" label="Sign out" onPress={() => void auth.signOut()} />
      <DeleteAccountPanel />
      <Body testID="profile-host" muted>
        {backendHost}
      </Body>
    </AppScreen>
  )
}

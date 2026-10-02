import { useState } from 'react'
import { ScrollView, View } from 'react-native'
import {
  BottomSheet,
  Body,
  DestructiveButton,
  SectionHeader,
  SecondaryButton,
  SwitchRow,
  TextField,
} from '../components'
import { useRuntime, useStore } from '../runtime-context'
import { SPACE } from '../theme'

/**
 * Profile → Delete account (P189). Native counterpart of the web Settings flow; the same backend
 * contract (see account/account-deletion-controller.ts). Friction is deliberate but not hostile:
 * a separate action that opens a sheet, a plain statement of what is and is not deleted, the
 * password typed again (the server verifies it) and an explicit acknowledgement before the
 * destructive button is even enabled. Nothing here can be triggered by a single tap.
 *
 * The sheet's copy matches the web dialog and the public page (`/account-deletion`): it promises no
 * backup retention period and says exactly what a deletion does not reach.
 */
export function DeleteAccountPanel() {
  const { accountDeletion, auth } = useRuntime()
  const state = useStore(accountDeletion)
  const session = useStore(auth)
  const [password, setPassword] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)

  const open = state.phase === 'confirming' || state.phase === 'working'
  const working = state.phase === 'working'

  function close() {
    if (working) return
    accountDeletion.cancel()
    setPassword('')
    setAcknowledged(false)
  }

  async function confirm() {
    if (working || !acknowledged || password.length === 0) return
    const typed = password
    // Cleared at once: the password lives in component state only for the duration of the request.
    setPassword('')
    await accountDeletion.confirm(typed)
  }

  return (
    <View testID="delete-account" style={{ gap: SPACE.sm }}>
      <SectionHeader title="Delete account" />
      <Body muted>
        Permanently delete your account and everything in it. Unlike signing out, this also removes
        your sign-in.
      </Body>
      <DestructiveButton
        testID="delete-account-open"
        label="Delete account…"
        onPress={() => {
          setPassword('')
          setAcknowledged(false)
          accountDeletion.open()
        }}
        disabled={session.userId === null}
      />
      <BottomSheet
        visible={open}
        onClose={close}
        title="Delete your account?"
        testID="delete-account-sheet"
      >
        <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 520 }}>
          <View style={{ gap: SPACE.md }}>
            <Body>
              {session.email !== null ? `This deletes ${session.email}. ` : ''}It cannot be undone.
            </Body>
            <Body muted testID="delete-account-covers">
              Deleted right away: your sign-in and display name; all tracked cards, graded cards and
              sealed products; purchases, sales, openings, valuations and acquisition history; tags,
              collections, storage locations, retailers and manual card definitions; your own sealed
              product definitions and portfolio history; your settings. This device also forgets any
              unsent purchase or sale and the scanner photo it was holding.
            </Body>
            <Body muted testID="delete-account-not-covered">
              Not covered: database backups made earlier are not rewritten and may still contain
              your data until they are replaced or expire — no date is promised, and if a backup is
              ever restored the deletion is re-applied before it is used. The invitation you signed
              up with is kept as a record with your email address removed. Files you exported are on
              your device. To export first, use the web app (Profile → Export &amp; backup); it is
              not required.
            </Body>
            <Body muted>
              If something goes wrong part-way, the account is locked against changes and you can
              run this again to finish.
            </Body>
            <TextField
              testID="delete-account-password"
              label="Your password"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              editable={!working}
              errorText={state.error}
            />
            <SwitchRow
              testID="delete-account-ack"
              label="I understand this is permanent and cannot be undone."
              value={acknowledged}
              onValueChange={setAcknowledged}
              disabled={working}
            />
            {working ? (
              <Body muted testID="delete-account-working">
                Deleting your account… keep the app open.
              </Body>
            ) : null}
            <DestructiveButton
              testID="delete-account-confirm"
              label={working ? 'Deleting…' : 'Permanently delete account'}
              onPress={() => void confirm()}
              disabled={working || !acknowledged || password.length === 0}
            />
            <SecondaryButton
              testID="delete-account-cancel"
              label="Cancel"
              onPress={close}
              disabled={working}
            />
          </View>
        </ScrollView>
      </BottomSheet>
    </View>
  )
}

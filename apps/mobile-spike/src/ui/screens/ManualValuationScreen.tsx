import { useEffect } from 'react'
import { Alert, ScrollView } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { Body, Button, FailureView, Heading, TextField } from '../components'
import type { CollectionStackParams } from '../navigation-types'
import { useRuntime, useStore } from '../runtime-context'
import { SPACE } from '../theme'
import { clearManualValuation, setManualValuation } from '../../write/collection-writes'
import { initialManualValuationDraft } from '../../write/drafts'
import { InvalidMoneyInputError, requireKnownAmount } from '../../write/money-input'

/**
 * Manual valuation (P175): set an explicit value (including an explicit 0), or clear it back to the
 * automatic resolved value. `mode` on the draft keeps the two requests distinct at every layer —
 * "Clear" never sends `p_value_minor: 0`, and "Set to 0" never calls `clear_manual_valuation`.
 */
export function ManualValuationScreen({
  route,
}: NativeStackScreenProps<CollectionStackParams, 'ManualValuation'>) {
  const { holdingId } = route.params
  const { auth, writeForms } = useRuntime()
  const session = useStore(auth)
  const form = useStore(writeForms.manualValuation)
  const draft = form.draft

  useEffect(() => {
    writeForms.manualValuation.ensureContext(() => initialManualValuationDraft(holdingId))
  }, [writeForms.manualValuation, holdingId])

  async function onSet() {
    let valueMinor: bigint
    try {
      valueMinor = requireKnownAmount(
        draft.valueInput,
        'NOK',
        'Enter a value, or use Clear instead.',
      )
    } catch (error) {
      Alert.alert(
        'Check your entry',
        error instanceof InvalidMoneyInputError ? error.message : 'Check the value above.',
      )
      return
    }
    await writeForms.manualValuation.submit(session.userId, (db, d) =>
      setManualValuation(
        { holdingId: d.holdingId, valueMinor, note: d.note === '' ? undefined : d.note },
        db,
      ),
    )
  }

  async function onClear() {
    await writeForms.manualValuation.submit(session.userId, (db, d) =>
      clearManualValuation(d.holdingId, db),
    )
  }

  return (
    <ScrollView
      contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.lg }}
      testID="p175-manual-valuation"
    >
      <Heading>Manual valuation</Heading>
      <TextField
        testID="p175-manual-value"
        label="Value (NOK) — 0 is a valid, known value"
        value={draft.valueInput}
        onChangeText={(text) => writeForms.manualValuation.updateDraft({ valueInput: text })}
        keyboardType="decimal-pad"
        placeholder="0.00"
      />
      <TextField
        testID="p175-manual-note"
        label="Note (optional)"
        value={draft.note}
        onChangeText={(text) => writeForms.manualValuation.updateDraft({ note: text })}
      />
      {form.failure !== null ? <FailureView failure={form.failure} /> : null}
      {form.status === 'success' ? (
        <Body testID="p175-manual-valuation-success">Saved.</Body>
      ) : null}
      <Button
        testID="p175-confirm-manual-value"
        label="Set value"
        disabled={form.status === 'submitting'}
        onPress={() => void onSet()}
      />
      <Button
        testID="p175-clear-manual-value"
        label="Clear manual value (use market price)"
        variant="secondary"
        disabled={form.status === 'submitting'}
        onPress={() => void onClear()}
      />
    </ScrollView>
  )
}

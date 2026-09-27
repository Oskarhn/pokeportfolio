import { useEffect } from 'react'
import { Alert, ScrollView } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import type { CardCondition } from '@shared/data/collection'
import { Body, Button, FailureView, Heading, TextField } from '../components'
import type { SearchStackParams } from '../navigation-types'
import { useRuntime, useStore } from '../runtime-context'
import { SPACE } from '../theme'
import { addCardAcquisition } from '../../write/collection-writes'
import { initialAcquisitionDraft } from '../../write/drafts'
import { assertValidEventDate, InvalidEventDateError } from '../../write/event-date'
import { InvalidMoneyInputError, requireKnownAmount } from '../../write/money-input'

/**
 * Add-card-acquisition (P175): a card confirmed on Price Check, entered as owned inventory with no
 * purchase receipt. `origin` is fixed to 'other' (the schema's most permissive origin — see
 * `acquisition_lots_origin_cost_state_consistency`, which requires a NARROWER cost-basis state for
 * every other origin); a gift/found-specific workflow with its own origin value and cost-state
 * mapping is a scope choice left for later (see output_175.txt BLOCKERS), not an oversight.
 */
export function AddAcquisitionScreen({
  route,
  navigation,
}: NativeStackScreenProps<SearchStackParams, 'P175AddAcquisition'>) {
  const { cardId, variantId } = route.params
  const { auth, writeForms } = useRuntime()
  const session = useStore(auth)
  const form = useStore(writeForms.acquisition)
  const draft = form.draft

  useEffect(() => {
    writeForms.acquisition.ensureContext(() => initialAcquisitionDraft(variantId))
  }, [writeForms.acquisition, variantId])

  function validate(): { unitCostBasisMinor: bigint | undefined; quantity: number } | null {
    try {
      const unitCostBasisMinor = draft.costKnown
        ? requireKnownAmount(draft.unitCostInput, 'NOK', 'Enter the cost, or mark it unknown.')
        : undefined
      assertValidEventDate(draft.acquiredOn)
      const quantity = Number.parseInt(draft.quantity, 10)
      if (!Number.isInteger(quantity) || quantity < 1) {
        Alert.alert('Check your entry', 'Enter a quantity of 1 or more.')
        return null
      }
      return { unitCostBasisMinor, quantity }
    } catch (error) {
      const message =
        error instanceof InvalidMoneyInputError || error instanceof InvalidEventDateError
          ? error.message
          : 'Check the values above.'
      Alert.alert('Check your entry', message)
      return null
    }
  }

  async function onConfirm() {
    const validated = validate()
    if (validated === null) return
    const result = await writeForms.acquisition.submit(session.userId, (db, d, idempotencyKey) =>
      addCardAcquisition(
        {
          cardVariantId: d.cardVariantId,
          gradingState: 'raw',
          condition: d.condition as CardCondition,
          origin: 'other',
          costBasisState: d.costKnown ? 'known' : 'unknown',
          unitCostBasisMinor: validated.unitCostBasisMinor,
          quantity: validated.quantity,
          acquiredOn: d.acquiredOn,
          lotNotes: d.notes === '' ? undefined : d.notes,
          clientRequestKey: idempotencyKey,
        },
        db,
      ),
    )
    if (result.ok) navigation.getParent()?.navigate('CollectionTab', { screen: 'CollectionList' })
  }

  return (
    <ScrollView
      contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.lg }}
      testID="p175-add-acquisition"
    >
      <Heading>Add to collection</Heading>
      <Body muted>Card variant {cardId === variantId ? cardId : `${cardId} · ${variantId}`}</Body>
      <Button
        testID="p175-cost-toggle"
        label={
          draft.costKnown ? 'Cost known — tap to mark unknown' : 'Cost unknown — tap to enter it'
        }
        variant="secondary"
        onPress={() => writeForms.acquisition.updateDraft({ costKnown: !draft.costKnown })}
      />
      {draft.costKnown ? (
        <TextField
          testID="p175-unit-cost"
          label="Cost per card (NOK)"
          value={draft.unitCostInput}
          onChangeText={(text) => writeForms.acquisition.updateDraft({ unitCostInput: text })}
          keyboardType="decimal-pad"
          placeholder="0.00"
        />
      ) : (
        <Body muted>No cost will be recorded — it stays unknown, never zero.</Body>
      )}
      <TextField
        testID="p175-quantity"
        label="Quantity"
        value={draft.quantity}
        onChangeText={(text) => writeForms.acquisition.updateDraft({ quantity: text })}
        keyboardType="number-pad"
      />
      <TextField
        testID="p175-acquired-on"
        label="Acquired on (YYYY-MM-DD)"
        value={draft.acquiredOn}
        onChangeText={(text) => writeForms.acquisition.updateDraft({ acquiredOn: text })}
      />
      <TextField
        testID="p175-notes"
        label="Notes (optional)"
        value={draft.notes}
        onChangeText={(text) => writeForms.acquisition.updateDraft({ notes: text })}
      />
      {form.failure !== null ? <FailureView failure={form.failure} /> : null}
      {form.status === 'success' ? (
        <Body testID="p175-acquisition-success">Added to your collection.</Body>
      ) : null}
      <Button
        testID="p175-confirm-acquisition"
        label="Add to collection"
        disabled={form.status === 'submitting'}
        accessibilityHint="Saves this card to your collection. This cannot be undone from here."
        onPress={() => void onConfirm()}
      />
    </ScrollView>
  )
}

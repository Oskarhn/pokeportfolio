import { useEffect, useState } from 'react'
import { Alert } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import {
  Body,
  DateField,
  FailureView,
  Heading,
  Loading,
  MoneyField,
  PrimaryButton,
  RadioRow,
  TaskScreen,
  TextField,
} from '../components'
import type { CollectionStackParams } from '../navigation-types'
import { useRuntime, useStore } from '../runtime-context'
import { listWritableLots, type WritableLot } from '../../collection/lot-reads'
import { initialOpeningDraft } from '../../write/drafts'
import { assertValidEventDate, InvalidEventDateError } from '../../write/event-date'
import { InvalidMoneyInputError, parseOptionalChargeInput } from '../../write/money-input'
import { createOpening } from '../../write/opening-writes'

/**
 * Record-opening (P175), minimal scope (see write/opening-writes.ts's header): opens an
 * ALREADY-OWNED sealed lot. `create_opening` takes no cost argument, so this cannot create a
 * second spend by construction. No pulled-card tracking; `trackingCompleteness` is always
 * 'unknown'.
 */
export function RecordOpeningScreen({
  route,
}: NativeStackScreenProps<CollectionStackParams, 'RecordOpening'>) {
  const { holdingId } = route.params
  const { auth, writeForms } = useRuntime()
  const session = useStore(auth)
  const form = useStore(writeForms.opening)
  const draft = form.draft
  const [lots, setLots] = useState<WritableLot[] | null>(null)
  const [lotsFailed, setLotsFailed] = useState(false)

  useEffect(() => {
    writeForms.opening.ensureContext(() => initialOpeningDraft(holdingId))
  }, [writeForms.opening, holdingId])

  useEffect(() => {
    let cancelled = false
    setLots(null)
    setLotsFailed(false)
    void listWritableLots(holdingId).then(
      (result) => {
        if (cancelled) return
        const sealed = result.filter((lot) => lot.sealedIntent !== null)
        setLots(sealed)
        if (sealed.length === 1 && sealed[0] !== undefined) {
          writeForms.opening.updateDraft({ lotId: sealed[0].lotId })
        }
      },
      () => {
        if (!cancelled) setLotsFailed(true)
      },
    )
    return () => {
      cancelled = true
    }
  }, [holdingId])

  function validate(): { quantity: number } | null {
    if (draft.lotId === '') {
      Alert.alert('Check your entry', 'Choose which sealed lot you are opening.')
      return null
    }
    try {
      assertValidEventDate(draft.openedOn)
      const quantity = Number.parseInt(draft.quantity, 10)
      const chosen = lots?.find((l) => l.lotId === draft.lotId)
      if (!Number.isInteger(quantity) || quantity < 1) {
        Alert.alert('Check your entry', 'Enter a quantity of 1 or more.')
        return null
      }
      if (chosen !== undefined && quantity > chosen.quantityRemaining) {
        Alert.alert(
          'Check your entry',
          `Only ${String(chosen.quantityRemaining)} remain in this lot.`,
        )
        return null
      }
      return { quantity }
    } catch (error) {
      Alert.alert(
        'Check your entry',
        error instanceof InvalidEventDateError || error instanceof InvalidMoneyInputError
          ? error.message
          : 'Check the values above.',
      )
      return null
    }
  }

  async function onConfirm() {
    const validated = validate()
    if (validated === null) return
    await writeForms.opening.submit(session.userId, (db, d, idempotencyKey) =>
      createOpening(
        {
          sourceLotId: d.lotId,
          quantity: validated.quantity,
          openedOn: d.openedOn,
          bulkRemainderEstimateNokMinor:
            d.bulkRemainderEstimateInput === ''
              ? undefined
              : parseOptionalChargeInput(d.bulkRemainderEstimateInput, 'NOK'),
          notes: d.notes === '' ? undefined : d.notes,
          idempotencyKey,
        },
        db,
      ),
    )
  }

  if (lots === null && !lotsFailed) return <Loading label="Loading sealed lots" />

  const body = lotsFailed ? (
    <Body muted>Could not load this holding&apos;s lots.</Body>
  ) : lots !== null && lots.length === 0 ? (
    <Body muted>No sealed lots left to open in this holding.</Body>
  ) : (
    <>
      {(lots ?? []).map((lot) => (
        <RadioRow
          key={lot.lotId}
          testID={`p175-opening-lot-${lot.lotId}`}
          label={`Lot ${lot.lotId.slice(0, 8)}`}
          meta={`${String(lot.quantityRemaining)} remaining`}
          selected={draft.lotId === lot.lotId}
          onPress={() => writeForms.opening.updateDraft({ lotId: lot.lotId })}
        />
      ))}
      <TextField
        testID="p175-opening-quantity"
        label="Quantity to open"
        value={draft.quantity}
        onChangeText={(text) => writeForms.opening.updateDraft({ quantity: text })}
        keyboardType="number-pad"
      />
      <DateField
        testID="p175-opening-date"
        label="Opened on (YYYY-MM-DD)"
        value={draft.openedOn}
        onChangeText={(text) => writeForms.opening.updateDraft({ openedOn: text })}
      />
      <MoneyField
        testID="p175-opening-bulk-estimate"
        label="Untracked-contents value estimate, NOK (optional)"
        value={draft.bulkRemainderEstimateInput}
        onChangeText={(text) =>
          writeForms.opening.updateDraft({ bulkRemainderEstimateInput: text })
        }
      />
      <TextField
        testID="p175-opening-notes"
        label="Notes (optional)"
        value={draft.notes}
        onChangeText={(text) => writeForms.opening.updateDraft({ notes: text })}
      />
      {form.failure !== null ? <FailureView failure={form.failure} /> : null}
      {form.status === 'success' ? (
        <Body testID="p175-opening-success">Opening recorded.</Body>
      ) : null}
    </>
  )

  return (
    <TaskScreen
      testID="p175-record-opening"
      footer={
        <PrimaryButton
          testID="p175-confirm-opening"
          label="Record opening"
          disabled={form.status === 'submitting' || lots === null || lots.length === 0}
          accessibilityHint="Marks this sealed lot as opened. This cannot be undone from here."
          onPress={() => void onConfirm()}
        />
      }
    >
      <Heading>Record opening</Heading>
      {body}
    </TaskScreen>
  )
}

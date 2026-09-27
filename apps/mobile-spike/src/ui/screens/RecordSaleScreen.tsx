import { useEffect, useState } from 'react'
import { Alert } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { isSupportedCurrencyCode, type CurrencyCode } from '@shared/domain/currency'
import {
  Body,
  BottomSheet,
  DateField,
  FailureView,
  Heading,
  Loading,
  MoneyField,
  PrimaryButton,
  RadioRow,
  SelectRow,
  TaskScreen,
  TextField,
} from '../components'
import type { CollectionStackParams } from '../navigation-types'
import { useRuntime, useStore } from '../runtime-context'
import { listWritableLots, type WritableLot } from '../../collection/lot-reads'
import { initialSaleDraft } from '../../write/drafts'
import { assertValidEventDate, InvalidEventDateError } from '../../write/event-date'
import {
  InvalidMoneyInputError,
  parseOptionalChargeInput,
  requireKnownAmount,
} from '../../write/money-input'
import { createSale } from '../../write/sale-writes'

/** Every currency the shared money domain supports, matching RecordPurchaseScreen (P178 §17). */
const SALE_CURRENCIES: CurrencyCode[] = ['NOK', 'EUR', 'USD', 'GBP', 'JPY']

/**
 * Record-sale (P175): sells a quantity of one lot of the holding. Known and unknown cost-basis lots
 * are sold through the exact same call — `create_sale` alone decides `realized_result_nok_minor`
 * (null for unknown, a signed value for known); this screen never computes or guesses it. Only one
 * line per sale, same reasoning as the purchase screen (no multi-holding picker yet).
 */
export function RecordSaleScreen({
  route,
}: NativeStackScreenProps<CollectionStackParams, 'RecordSale'>) {
  const { holdingId } = route.params
  const { auth, writeForms } = useRuntime()
  const session = useStore(auth)
  const form = useStore(writeForms.sale)
  const draft = form.draft
  const [lots, setLots] = useState<WritableLot[] | null>(null)
  const [lotsFailed, setLotsFailed] = useState(false)

  useEffect(() => {
    writeForms.sale.ensureContext(() => initialSaleDraft(holdingId))
  }, [writeForms.sale, holdingId])

  useEffect(() => {
    let cancelled = false
    setLots(null)
    setLotsFailed(false)
    void listWritableLots(holdingId).then(
      (result) => {
        if (cancelled) return
        setLots(result)
        if (result.length === 1 && result[0] !== undefined) {
          writeForms.sale.updateDraft({ lotId: result[0].lotId })
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

  const currency: CurrencyCode = isSupportedCurrencyCode(draft.currency) ? draft.currency : 'NOK'
  const [currencySheetOpen, setCurrencySheetOpen] = useState(false)

  function validate(): { unitGrossMinor: bigint; quantity: number } | null {
    if (draft.lotId === '') {
      Alert.alert('Check your entry', 'Choose which lot you are selling.')
      return null
    }
    try {
      const unitGrossMinor = requireKnownAmount(
        draft.unitGrossInput,
        currency,
        'Enter what the buyer paid per unit — type 0 if it was given away.',
      )
      assertValidEventDate(draft.soldOn)
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
      return { unitGrossMinor, quantity }
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
    await writeForms.sale.submit(session.userId, (db, d, idempotencyKey) =>
      createSale(
        [
          {
            lotId: d.lotId,
            quantity: validated.quantity,
            unitGrossMinor: validated.unitGrossMinor,
          },
        ],
        {
          soldOn: d.soldOn,
          currency,
          marketplace: d.marketplace === '' ? undefined : d.marketplace,
          feesMinor: parseOptionalChargeInput(d.feesInput, currency),
          shippingCostMinor: parseOptionalChargeInput(d.shippingCostInput, currency),
          notes: d.notes === '' ? undefined : d.notes,
        },
        idempotencyKey,
        db,
      ),
    )
  }

  if (lots === null && !lotsFailed) return <Loading label="Loading lots" />

  const canSubmit = !lotsFailed && lots !== null && lots.length > 0

  return (
    <>
      <TaskScreen
        testID="p175-record-sale"
        footer={
          <PrimaryButton
            testID="p175-confirm-sale"
            label="Record sale"
            disabled={form.status === 'submitting' || !canSubmit}
            accessibilityHint="Saves this sale. This cannot be undone from here."
            onPress={() => void onConfirm()}
          />
        }
      >
        <Heading>Record sale</Heading>
        {lotsFailed ? (
          <Body muted>Could not load this holding&apos;s lots.</Body>
        ) : lots !== null && lots.length === 0 ? (
          <Body muted>Nothing left to sell in this holding.</Body>
        ) : (
          <>
            {(lots ?? []).length > 1 ? (
              <Body muted>{(lots ?? []).length} lots — choose one:</Body>
            ) : null}
            {(lots ?? []).map((lot) => (
              <RadioRow
                key={lot.lotId}
                testID={`p175-lot-${lot.lotId}`}
                label={`Lot ${lot.lotId.slice(0, 8)}`}
                meta={`${String(lot.quantityRemaining)} remaining`}
                selected={draft.lotId === lot.lotId}
                onPress={() => writeForms.sale.updateDraft({ lotId: lot.lotId })}
              />
            ))}
            <TextField
              testID="p175-sale-quantity"
              label="Quantity sold"
              value={draft.quantity}
              onChangeText={(text) => writeForms.sale.updateDraft({ quantity: text })}
              keyboardType="number-pad"
            />
            <SelectRow
              testID="p178-sale-currency"
              label="Currency"
              value={currency}
              onPress={() => setCurrencySheetOpen(true)}
            />
            <MoneyField
              testID="p175-sale-unit-gross"
              label={`Price paid per unit (${currency})`}
              value={draft.unitGrossInput}
              onChangeText={(text) => writeForms.sale.updateDraft({ unitGrossInput: text })}
              placeholder={currency === 'JPY' ? '0' : '0.00'}
            />
            <MoneyField
              testID="p175-sale-fees"
              label="Marketplace fees (optional)"
              value={draft.feesInput}
              onChangeText={(text) => writeForms.sale.updateDraft({ feesInput: text })}
            />
            <MoneyField
              testID="p175-sale-shipping"
              label="Shipping you paid (optional)"
              value={draft.shippingCostInput}
              onChangeText={(text) => writeForms.sale.updateDraft({ shippingCostInput: text })}
            />
            <DateField
              testID="p175-sale-date"
              label="Sold on (YYYY-MM-DD)"
              value={draft.soldOn}
              onChangeText={(text) => writeForms.sale.updateDraft({ soldOn: text })}
            />
            <TextField
              testID="p175-sale-marketplace"
              label="Marketplace (optional)"
              value={draft.marketplace}
              onChangeText={(text) => writeForms.sale.updateDraft({ marketplace: text })}
            />
            <TextField
              testID="p175-sale-notes"
              label="Notes (optional)"
              value={draft.notes}
              onChangeText={(text) => writeForms.sale.updateDraft({ notes: text })}
            />
            {form.failure !== null ? <FailureView failure={form.failure} /> : null}
            {form.status === 'success' ? (
              <Body testID="p175-sale-success">Sale recorded.</Body>
            ) : null}
          </>
        )}
      </TaskScreen>
      <BottomSheet
        testID="p178-sale-currency-sheet"
        visible={currencySheetOpen}
        onClose={() => setCurrencySheetOpen(false)}
        title="Currency"
      >
        {SALE_CURRENCIES.map((code) => (
          <RadioRow
            key={code}
            testID={`p178-sale-currency-option-${code}`}
            label={code}
            selected={code === currency}
            onPress={() => {
              writeForms.sale.updateDraft({ currency: code })
              setCurrencySheetOpen(false)
            }}
          />
        ))}
      </BottomSheet>
    </>
  )
}

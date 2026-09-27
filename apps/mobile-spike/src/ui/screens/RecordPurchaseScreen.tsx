import { useEffect, useMemo } from 'react'
import { Alert, ScrollView } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { allocatePurchaseCharges } from '@shared/domain/allocation'
import { isSupportedCurrencyCode, type CurrencyCode } from '@shared/domain/currency'
import { Body, Button, Card, FailureView, Heading, MoneyText, TextField } from '../components'
import type { SearchStackParams } from '../navigation-types'
import { useRuntime, useStore } from '../runtime-context'
import { SPACE } from '../theme'
import { initialPurchaseDraft } from '../../write/drafts'
import { assertValidEventDate, InvalidEventDateError } from '../../write/event-date'
import {
  InvalidMoneyInputError,
  parseOptionalChargeInput,
  requireKnownAmount,
} from '../../write/money-input'
import { createPurchase } from '../../write/purchase-writes'

/**
 * Record-purchase (P175): one receipt, one line (the confirmed card). `create_purchase` and the
 * pure allocator already support many lines; this screen keeps to one because there is no card
 * picker inside the Collection tab yet to add a SECOND line's card — see output_175.txt BLOCKERS.
 * Every total shown below comes from `@shared/domain/allocation`'s `allocatePurchaseCharges`, the
 * exact SAME function `create_purchase` uses server-side (P144) — this screen computes nothing of
 * its own.
 */
export function RecordPurchaseScreen({
  route,
  navigation,
}: NativeStackScreenProps<SearchStackParams, 'P175RecordPurchase'>) {
  const { cardId, variantId } = route.params
  const { auth, writeForms } = useRuntime()
  const session = useStore(auth)
  const form = useStore(writeForms.purchase)
  const draft = form.draft

  useEffect(() => {
    writeForms.purchase.ensureContext(() => initialPurchaseDraft(variantId))
  }, [writeForms.purchase, variantId])

  const currency: CurrencyCode = isSupportedCurrencyCode(draft.currency) ? draft.currency : 'NOK'

  const preview = useMemo(() => {
    try {
      const unitPrice = requireKnownAmount(draft.unitPriceInput, currency, '')
      const quantity = Number.parseInt(draft.quantity, 10)
      if (!Number.isInteger(quantity) || quantity < 1) return null
      const lineTotal = unitPrice * BigInt(quantity)
      const shipping = parseOptionalChargeInput(draft.shippingInput, currency)
      const customs = parseOptionalChargeInput(draft.customsInput, currency)
      const discount = parseOptionalChargeInput(draft.discountInput, currency)
      const allocation = allocatePurchaseCharges([lineTotal], shipping, customs, discount)
      const total = lineTotal + shipping + customs - discount
      return { total, currency, attributable: allocation.attributable[0] ?? 0n }
    } catch {
      return null
    }
  }, [
    draft.unitPriceInput,
    draft.quantity,
    draft.shippingInput,
    draft.customsInput,
    draft.discountInput,
    currency,
  ])

  function validate(): { unitPriceMinor: bigint; quantity: number } | null {
    try {
      const unitPriceMinor = requireKnownAmount(
        draft.unitPriceInput,
        currency,
        'Enter a unit price for this line — type 0 if it was free.',
      )
      assertValidEventDate(draft.purchasedOn)
      const quantity = Number.parseInt(draft.quantity, 10)
      if (!Number.isInteger(quantity) || quantity < 1) {
        Alert.alert('Check your entry', 'Enter a quantity of 1 or more.')
        return null
      }
      return { unitPriceMinor, quantity }
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
    // There is no retailer-management RPC ported to the native write seam (P175 scope: see
    // output_175.txt BLOCKERS), so a typed retailer/source name is folded into the free-text notes
    // rather than silently discarded — `p_retailer_id` itself stays unset.
    const result = await writeForms.purchase.submit(session.userId, (db, d, idempotencyKey) =>
      createPurchase(
        {
          purchasedOn: d.purchasedOn,
          currency,
          lines: [
            {
              lineType: 'card',
              cardVariantId: d.cardVariantId,
              quantity: validated.quantity,
              unitPriceMinor: validated.unitPriceMinor,
              spendClass: 'collectible',
            },
          ],
          shippingMinor: parseOptionalChargeInput(d.shippingInput, currency),
          customsMinor: parseOptionalChargeInput(d.customsInput, currency),
          discountMinor: parseOptionalChargeInput(d.discountInput, currency),
          notes:
            [d.retailerName !== '' ? `Retailer/source: ${d.retailerName}` : '', d.notes]
              .filter((s) => s !== '')
              .join(' — ') || undefined,
        },
        idempotencyKey,
        db,
      ),
    )
    if (result.ok) navigation.getParent()?.navigate('CollectionTab', { screen: 'CollectionList' })
  }

  return (
    <ScrollView
      contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.lg }}
      testID="p175-record-purchase"
    >
      <Heading>Record purchase</Heading>
      <Body muted>Card variant {cardId === variantId ? cardId : `${cardId} · ${variantId}`}</Body>
      <TextField
        testID="p175-purchase-quantity"
        label="Quantity"
        value={draft.quantity}
        onChangeText={(text) => writeForms.purchase.updateDraft({ quantity: text })}
        keyboardType="number-pad"
      />
      <TextField
        testID="p175-purchase-unit-price"
        label={`Unit price (${currency})`}
        value={draft.unitPriceInput}
        onChangeText={(text) => writeForms.purchase.updateDraft({ unitPriceInput: text })}
        keyboardType="decimal-pad"
        placeholder="0.00"
      />
      <TextField
        testID="p175-purchase-shipping"
        label="Shipping (optional)"
        value={draft.shippingInput}
        onChangeText={(text) => writeForms.purchase.updateDraft({ shippingInput: text })}
        keyboardType="decimal-pad"
      />
      <TextField
        testID="p175-purchase-customs"
        label="Customs (optional)"
        value={draft.customsInput}
        onChangeText={(text) => writeForms.purchase.updateDraft({ customsInput: text })}
        keyboardType="decimal-pad"
      />
      <TextField
        testID="p175-purchase-discount"
        label="Discount (optional)"
        value={draft.discountInput}
        onChangeText={(text) => writeForms.purchase.updateDraft({ discountInput: text })}
        keyboardType="decimal-pad"
      />
      <TextField
        testID="p175-purchase-date"
        label="Purchased on (YYYY-MM-DD)"
        value={draft.purchasedOn}
        onChangeText={(text) => writeForms.purchase.updateDraft({ purchasedOn: text })}
      />
      <TextField
        testID="p175-purchase-retailer"
        label="Retailer / source (optional)"
        value={draft.retailerName}
        onChangeText={(text) => writeForms.purchase.updateDraft({ retailerName: text })}
      />
      <TextField
        testID="p175-purchase-notes"
        label="Notes (optional)"
        value={draft.notes}
        onChangeText={(text) => writeForms.purchase.updateDraft({ notes: text })}
      />
      <Card testID="p175-purchase-preview">
        <Body muted>Receipt total</Body>
        <MoneyText
          testID="p175-purchase-total"
          emphasis
          value={
            preview !== null ? { minorUnits: preview.total, currency: preview.currency } : null
          }
        />
      </Card>
      {form.failure !== null ? <FailureView failure={form.failure} /> : null}
      {form.status === 'success' ? (
        <Body testID="p175-purchase-success">Purchase recorded.</Body>
      ) : null}
      <Button
        testID="p175-confirm-purchase"
        label="Record purchase"
        disabled={form.status === 'submitting'}
        accessibilityHint="Saves this purchase receipt. This cannot be undone from here."
        onPress={() => void onConfirm()}
      />
    </ScrollView>
  )
}

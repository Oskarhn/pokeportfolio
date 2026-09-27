import { useEffect, useMemo, useState } from 'react'
import { Alert } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { allocatePurchaseCharges } from '@shared/domain/allocation'
import { isSupportedCurrencyCode, type CurrencyCode } from '@shared/domain/currency'
import {
  Body,
  BottomSheet,
  DateField,
  FailureView,
  Heading,
  MoneyField,
  MoneyText,
  PrimaryButton,
  RadioRow,
  SelectRow,
  Surface,
  TaskScreen,
  TextField,
} from '../components'
import type { SearchStackParams } from '../navigation-types'
import { useRuntime, useStore } from '../runtime-context'
import { formatMoney } from '../../money/format-money'
import { initialPurchaseDraft } from '../../write/drafts'
import { assertValidEventDate, InvalidEventDateError } from '../../write/event-date'
import {
  InvalidMoneyInputError,
  parseOptionalChargeInput,
  requireKnownAmount,
} from '../../write/money-input'
import { createPurchase } from '../../write/purchase-writes'

/** Every currency the shared money domain supports (P178 §17) — not a hand-picked subset, so a
 *  future currency added to `@shared/domain/currency` needs no change here beyond this list. */
const PURCHASE_CURRENCIES: CurrencyCode[] = ['NOK', 'EUR', 'USD', 'GBP', 'JPY']

/**
 * Record-purchase (P175): one receipt, one line (the confirmed card). `create_purchase` and the
 * pure allocator already support many lines; this screen keeps to one because there is no card
 * picker inside the Collection tab yet to add a SECOND line's card — see output_175.txt BLOCKERS.
 * Every total shown below comes from `@shared/domain/allocation`'s `allocatePurchaseCharges`, the
 * exact SAME function `create_purchase` uses server-side (P144) — this screen computes nothing of
 * its own.
 *
 * P178 closes the JPY UI gap P177 found: this screen used to hardcode the Norwegian krone on the
 * draft regardless of the person's choice, so JPY (the shared domain's own zero-exponent proof,
 * FINANCIAL_MODEL §1) could never be exercised through the real app. The currency is now a real
 * field on the draft, driving both the
 * exponent every money parser below uses (`write/money-input.ts` → `@shared/domain/money`) and the
 * `currency` sent to `create_purchase` — nothing here re-implements currency-exponent logic.
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
  const [currencySheetOpen, setCurrencySheetOpen] = useState(false)

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
      return { total, currency, quantity, attributable: allocation.attributable[0] ?? 0n }
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
              // A raw card line requires a condition server-side (`create_purchase`'s own
              // validation) — found by P177's device run, which the client-side type let through
              // as optional and every unit/backend test happened to supply explicitly. 'NM'
              // matches AddAcquisitionScreen's own default; a condition picker is a separate,
              // larger UI change left for later, same as that screen's.
              gradingState: 'raw',
              condition: 'NM',
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

  const totalValue =
    preview !== null ? { minorUnits: preview.total, currency: preview.currency } : null

  return (
    <>
      <TaskScreen
        testID="p175-record-purchase"
        footer={
          <>
            <PrimaryButton
              testID="p175-confirm-purchase"
              label="Record purchase"
              disabled={form.status === 'submitting'}
              accessibilityHint="Saves this purchase receipt. This cannot be undone from here."
              onPress={() => void onConfirm()}
            />
            {preview !== null ? (
              <Body muted testID="p178-purchase-footer-summary">
                Adds {preview.quantity} {preview.quantity === 1 ? 'copy' : 'copies'} {'·'} Total
                cost {formatMoney({ minorUnits: preview.total, currency: preview.currency })}
              </Body>
            ) : null}
          </>
        }
      >
        <Heading>Record purchase</Heading>
        <Body muted>Records a purchase you already made. Nothing is charged in the app.</Body>
        <Body muted>Card variant {cardId === variantId ? cardId : `${cardId} · ${variantId}`}</Body>
        <TextField
          testID="p175-purchase-quantity"
          label="Quantity"
          value={draft.quantity}
          onChangeText={(text) => writeForms.purchase.updateDraft({ quantity: text })}
          keyboardType="number-pad"
        />
        <SelectRow
          testID="p178-purchase-currency"
          label="Currency"
          value={currency}
          onPress={() => setCurrencySheetOpen(true)}
        />
        <MoneyField
          testID="p175-purchase-unit-price"
          label={`Unit price (${currency})`}
          value={draft.unitPriceInput}
          onChangeText={(text) => writeForms.purchase.updateDraft({ unitPriceInput: text })}
          placeholder={currency === 'JPY' ? '0' : '0.00'}
        />
        <MoneyField
          testID="p175-purchase-shipping"
          label="Shipping (optional)"
          value={draft.shippingInput}
          onChangeText={(text) => writeForms.purchase.updateDraft({ shippingInput: text })}
        />
        <MoneyField
          testID="p175-purchase-customs"
          label="Customs (optional)"
          value={draft.customsInput}
          onChangeText={(text) => writeForms.purchase.updateDraft({ customsInput: text })}
        />
        <MoneyField
          testID="p175-purchase-discount"
          label="Discount (optional)"
          value={draft.discountInput}
          onChangeText={(text) => writeForms.purchase.updateDraft({ discountInput: text })}
        />
        <DateField
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
        <Surface testID="p175-purchase-preview">
          <Body muted>Receipt total</Body>
          <MoneyText testID="p175-purchase-total" size="large" value={totalValue} />
        </Surface>
        {form.failure !== null ? <FailureView failure={form.failure} /> : null}
        {form.status === 'success' ? (
          <Body testID="p175-purchase-success">Purchase recorded.</Body>
        ) : null}
      </TaskScreen>
      <BottomSheet
        testID="p178-currency-sheet"
        visible={currencySheetOpen}
        onClose={() => setCurrencySheetOpen(false)}
        title="Currency"
      >
        {PURCHASE_CURRENCIES.map((code) => (
          <RadioRow
            key={code}
            testID={`p178-currency-option-${code}`}
            label={code}
            selected={code === currency}
            onPress={() => {
              writeForms.purchase.updateDraft({ currency: code })
              setCurrencySheetOpen(false)
            }}
          />
        ))}
      </BottomSheet>
    </>
  )
}

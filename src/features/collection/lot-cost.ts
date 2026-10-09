import { isSupportedCurrencyCode } from '../../domain/currency'
import { toDecimalString } from '../../domain/money'
import { formatNokMinor } from '../../ui/money-format'

/**
 * A lot's per-card cost for display. `unit_cost_basis_minor` is in the lot's ORIGINAL currency
 * (`cost_basis_currency`); printing it as NOK showed 45,00 EUR as "45,00 NOK" and a 10 000 JPY card
 * as "100,00 NOK". The frozen NOK conversion is the comparable figure; a foreign lot shows both.
 */
export function lotUnitCostLabel(lot: {
  costBasisCurrency: string | null
  unitCostBasisMinor: bigint | null
  unitCostBasisNokMinor: bigint | null
}): string | null {
  if (lot.unitCostBasisMinor === null) return null
  const currency = lot.costBasisCurrency ?? 'NOK'
  if (currency === 'NOK') {
    return `${formatNokMinor(lot.unitCostBasisNokMinor ?? lot.unitCostBasisMinor)} NOK / card`
  }
  const original = isSupportedCurrencyCode(currency)
    ? `${toDecimalString({ minorUnits: lot.unitCostBasisMinor, currency })} ${currency}`
    : `${currency} ${lot.unitCostBasisMinor.toString()} minor units`
  return lot.unitCostBasisNokMinor === null
    ? `${original} / card`
    : `${original} / card · ${formatNokMinor(lot.unitCostBasisNokMinor)} NOK`
}

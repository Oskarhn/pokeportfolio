import { formatNokMinor } from '../../ui/money-format'

/**
 * The "<unit value> NOK / card × <quantity>" caption beside a holding's total value.
 *
 * It exists only for a KNOWN unit value on a stack of more than one copy. An unknown unit value
 * (no price, or the provenance query failed or has not answered) is not zero: the caption is
 * absent, never "0,00 NOK / card" next to a "—" total (FINANCIAL_MODEL.md section 1 M1,
 * DESIGN_SYSTEM.md section 7). A genuine zero is a real value and is shown.
 */
export function perCopyCaption(
  unitValueMinor: bigint | null | undefined,
  quantity: number,
): string | null {
  if (unitValueMinor === null || unitValueMinor === undefined || quantity <= 1) return null
  return `${formatNokMinor(unitValueMinor)} NOK / card × ${String(quantity)}`
}

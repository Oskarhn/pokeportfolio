import { fromDecimalString } from '@shared/domain/money'
import { InvalidMoneyInputError } from '@shared/domain/errors'
import type { CurrencyCode } from '@shared/domain/currency'

/**
 * The exact native money-input boundary (P175, mirrors the web's unreleased
 * `src/ui/money-format.ts` — src/domain/money.ts's `fromDecimalString` is unchanged between the
 * released base and that branch, so this file is the thin UI-layer half only, ported rather than
 * imported for the same reason `auth/identity-authority.ts` ports P149).
 *
 * A blank field and a typed zero are different financial facts (FINANCIAL_MODEL.md §1.1): `""`
 * means "no amount was entered" and must never become `0n`. `,` and `.` both work as the decimal
 * separator; the digits themselves are parsed EXACTLY by the shared domain parser for the given
 * currency's own exponent (JPY has none) — never through `Number()`, never rounded.
 */

/** `""` / whitespace -> `null` (never `0n`). Otherwise an exact `bigint`, or throws for a value
 *  that is not a valid amount in this currency (too many fraction digits, not a number, etc). */
export function parseNullableMoneyInput(raw: string, currency: CurrencyCode): bigint | null {
  const normalized = raw.trim().replace(',', '.')
  if (normalized === '') return null
  return fromDecimalString(normalized, currency).minorUnits
}

/** A field the server needs to be a KNOWN amount (a purchase line's unit price, a sale line's
 *  price, an acquisition's cost when its cost-basis state is 'known'). Blank is refused with
 *  `missingMessage`; an explicit "0" is accepted as a known zero. */
export function requireKnownAmount(
  raw: string,
  currency: CurrencyCode,
  missingMessage: string,
): bigint {
  const parsed = parseNullableMoneyInput(raw, currency)
  if (parsed === null) throw new InvalidMoneyInputError(missingMessage)
  return parsed
}

/** An optional additive charge (shipping, customs, a discount, marketplace fees): the server
 *  columns are `NOT NULL DEFAULT 0` because the ABSENCE of a charge is zero, not unknown. The only
 *  parser that turns blank into `0n`, and it does so by name so every such choice stays visible. */
export function parseOptionalChargeInput(raw: string, currency: CurrencyCode): bigint {
  return parseNullableMoneyInput(raw, currency) ?? 0n
}

export { InvalidMoneyInputError }

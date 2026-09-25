/**
 * Guards for reading untrusted wire data (an Edge Function response, and behind it a third-party
 * provider). Plain `key in object` lookups are unsafe on such data: `'constructor' in {}` and
 * `'toString' in {}` are true, so a hostile or buggy payload could select an object prototype
 * member instead of a table entry. Everything here checks OWN properties only.
 */
import { getCurrencyMeta, isSupportedCurrencyCode, type CurrencyCode } from '../currency'

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** The entry for `key` if it is an own property of `table`, else undefined. */
export function ownEntry<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined
}

/** A currency code this codebase knows, checked without trusting prototype members. */
export function asCurrencyCode(value: unknown): CurrencyCode | null {
  if (typeof value !== 'string' || !isSupportedCurrencyCode(value)) return null
  return getCurrencyMeta(value).code === value ? value : null
}

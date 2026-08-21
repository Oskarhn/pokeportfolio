import { supabase } from './supabase-client'
import type { CurrencyCode } from '../domain/currency'

/**
 * Client for the fetch-fx-rate Edge Function (M8, FINANCIAL_MODEL.md §7). Resolves and caches a
 * Norges Bank rate for one (currency, date) pair. A manual override never goes through this file —
 * it is entered directly onto the purchase form and sent to create_purchase/update_purchase with
 * fx_source = 'manual', never written to the shared fx_rates cache (see the Edge Function header).
 *
 * The function always answers HTTP 200 with an `{ ok, ... }` body for every business outcome (see
 * its own header for why) — `data` is read directly rather than through `.error`, the same
 * defensive shape src/features/auth/InvitePage.tsx already uses for redeem-invitation.
 */

export interface ResolvedFxRate {
  rate: string
  rateDate: string
  source: 'norges_bank'
}

export class FxRateNotFoundError extends Error {}
export class FxRateUnavailableError extends Error {}

interface FxFunctionBody {
  ok: boolean
  rate?: string
  rateDate?: string
  source?: 'norges_bank'
  error?: string
  message?: string
}

const GENERIC_UNAVAILABLE_MESSAGE =
  'Could not resolve an exchange rate. Check the date, or enter one manually.'

export async function fetchFxRate(
  baseCurrency: Exclude<CurrencyCode, 'NOK'>,
  date: string,
): Promise<ResolvedFxRate> {
  const invoked = await supabase.functions.invoke('fetch-fx-rate', {
    body: { baseCurrency, date },
  })
  const body = invoked.data as FxFunctionBody | null

  if (!invoked.error && body?.ok && body.rate && body.rateDate && body.source) {
    return { rate: body.rate, rateDate: body.rateDate, source: body.source }
  }

  if (body?.error === 'no_rate_found') {
    throw new FxRateNotFoundError(
      body.message ?? `No Norges Bank rate available for ${baseCurrency}/NOK on or before ${date}`,
    )
  }
  throw new FxRateUnavailableError(body?.message ?? GENERIC_UNAVAILABLE_MESSAGE)
}

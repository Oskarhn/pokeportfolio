/**
 * Norges Bank exchange-rate API client (docs/API_SOURCES.md, "Norges Bank — FX rates").
 *
 * Endpoint and orientation re-verified live 2026-08-21 for this milestone: a request for
 * `B.EUR.NOK.SP` over 2026-08-10..2026-08-14 returned `10.986` for 2026-08-13 and `10.9325` for
 * 2026-08-14, matching the values already recorded in API_SOURCES.md from the 2026-08-16
 * verification. `BASE_CUR` is the first currency in the pair and the returned number is NOK per
 * one unit of it — i.e. exactly `fx_rate_to_nok` as FINANCIAL_MODEL.md §7 defines it: multiply an
 * amount in the base currency by this rate to get NOK. No inversion needed anywhere in this file
 * or its caller.
 *
 * Norges Bank publishes business days only — a date with no trading has no observation in the
 * response at all, not a null. The caller (supabase/functions/fetch-fx-rate) is responsible for
 * requesting a window ending at the target date and picking the last observation, which is what
 * makes the weekend/holiday fallback (FINANCIAL_MODEL.md §7, "most recent prior business-day
 * rate") correct by construction rather than by a guessed date arithmetic rule.
 */

const NORGES_BANK_HOST = 'https://data.norges-bank.no'
const REQUEST_TIMEOUT_MS = 8000

export class NorgesBankError extends Error {}

export interface NorgesBankObservation {
  /** ISO date (YYYY-MM-DD) the observation applies to. */
  date: string
  /** Decimal string — NOK per one unit of the requested base currency. */
  rate: string
}

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/
const CURRENCY_SHAPE = /^[A-Z]{3}$/

/**
 * Fetches every published observation for `baseCurrency`/NOK between `startDate` and `endDate`
 * (inclusive), ascending by date. The host is fixed and never derived from caller input — there is
 * no parameter through which a caller could redirect this request anywhere else (no SSRF surface).
 */
export async function fetchNorgesBankRates(params: {
  baseCurrency: string
  startDate: string
  endDate: string
}): Promise<NorgesBankObservation[]> {
  if (!CURRENCY_SHAPE.test(params.baseCurrency)) {
    throw new NorgesBankError('invalid base currency code')
  }
  if (!DATE_SHAPE.test(params.startDate) || !DATE_SHAPE.test(params.endDate)) {
    throw new NorgesBankError('invalid date')
  }

  const url = new URL(`${NORGES_BANK_HOST}/api/data/EXR/B.${params.baseCurrency}.NOK.SP`)
  url.searchParams.set('format', 'sdmx-json')
  url.searchParams.set('startPeriod', params.startDate)
  url.searchParams.set('endPeriod', params.endDate)
  url.searchParams.set('locale', 'en')

  const controller = new AbortController()
  const timeoutHandle = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(url, { method: 'GET', signal: controller.signal })
  } catch (error) {
    throw new NorgesBankError(
      `Norges Bank request failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    )
  } finally {
    clearTimeout(timeoutHandle)
  }

  if (response.status === 404) {
    // No series for this currency pair, or genuinely no observation in range — not an error.
    return []
  }
  if (!response.ok) {
    throw new NorgesBankError(`Norges Bank returned HTTP ${response.status}`)
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new NorgesBankError('Norges Bank response was not valid JSON')
  }

  return parseSdmxJson(body)
}

/**
 * Structural validation of the SDMX-JSON shape, rather than trusting it blindly — this is external
 * input from a network response, even though the host itself is trusted and fixed.
 */
function parseSdmxJson(body: unknown): NorgesBankObservation[] {
  if (typeof body !== 'object' || body === null) {
    throw new NorgesBankError('unexpected Norges Bank response shape (not an object)')
  }
  const data = (body as Record<string, unknown>)['data']
  if (typeof data !== 'object' || data === null) {
    throw new NorgesBankError('unexpected Norges Bank response shape (no data)')
  }
  const dataSets = (data as Record<string, unknown>)['dataSets']
  if (!Array.isArray(dataSets) || dataSets.length === 0) {
    return []
  }
  const series = (dataSets[0] as Record<string, unknown> | undefined)?.['series']
  if (typeof series !== 'object' || series === null) {
    return []
  }
  const seriesEntries = Object.values(series as Record<string, unknown>)
  if (seriesEntries.length === 0) {
    return []
  }
  const observations = (seriesEntries[0] as Record<string, unknown> | undefined)?.['observations']
  if (typeof observations !== 'object' || observations === null) {
    return []
  }

  const structure = (data as Record<string, unknown>)['structure']
  const dimensions = (structure as Record<string, unknown> | undefined)?.['dimensions']
  const observationDims = (dimensions as Record<string, unknown> | undefined)?.['observation']
  if (!Array.isArray(observationDims) || observationDims.length === 0) {
    throw new NorgesBankError('unexpected Norges Bank response shape (no observation dimension)')
  }
  const timeValues = (observationDims[0] as Record<string, unknown> | undefined)?.['values']
  if (!Array.isArray(timeValues)) {
    throw new NorgesBankError('unexpected Norges Bank response shape (no time values)')
  }

  const result: NorgesBankObservation[] = []
  for (const [indexKey, value] of Object.entries(observations as Record<string, unknown>)) {
    const index = Number(indexKey)
    if (!Number.isInteger(index) || index < 0 || index >= timeValues.length) continue
    const dateId = (timeValues[index] as Record<string, unknown> | undefined)?.['id']
    if (typeof dateId !== 'string' || !DATE_SHAPE.test(dateId)) continue
    if (!Array.isArray(value) || typeof value[0] !== 'string') continue
    const rateNumber = Number(value[0])
    if (!Number.isFinite(rateNumber) || rateNumber <= 0) continue
    result.push({ date: dateId, rate: value[0] })
  }

  result.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  return result
}

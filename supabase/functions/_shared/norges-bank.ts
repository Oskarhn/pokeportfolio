/**
 * Norges Bank exchange-rate API client (docs/API_SOURCES.md, "Norges Bank — FX rates").
 *
 * Endpoint and orientation re-verified live 2026-08-21 for this milestone: a request for
 * `B.EUR.NOK.SP` over 2026-08-10..2026-08-14 returned `10.986` for 2026-08-13 and `10.9325` for
 * 2026-08-14, matching the values already recorded in API_SOURCES.md from the 2026-08-16
 * verification. `BASE_CUR` is the first currency in the pair.
 *
 * IMPORTANT — UNIT_MULT (re-verified live 2026-09-14, P130-02/P134): the raw SDMX observation is
 * NOT always NOK per one unit of the base currency. Norges Bank publishes some low-value
 * currencies scaled up so the printed number stays a convenient size. The series-level `UNIT_MULT`
 * attribute says by how much: multiply the printed value by `10^UNIT_MULT` to get "NOK per one
 * [BASE_CUR]-in-UNIT_MULT-multiples" — equivalently, the printed value is NOK per `10^UNIT_MULT`
 * units of the base currency. Confirmed live: EUR and USD both carry `UNIT_MULT: 0` ("Units" — the
 * printed number already is NOK per 1 unit, e.g. `10.986` = NOK per 1 EUR), while JPY carries
 * `UNIT_MULT: 2` ("Hundreds" — `6.0375` is NOK per **100** JPY, not per 1 JPY). This project's
 * canonical `fx_rate_to_nok` contract (FINANCIAL_MODEL.md §7) is always NOK per ONE unit of the
 * base currency, so `normalizeObservationValue` below divides the printed value by `10^UNIT_MULT`
 * before this module ever returns it. This is the one place in the system allowed to know Norges
 * Bank's SDMX quirks — every caller (`fetch-fx-rate`, `ingest-fx`) and every SQL/domain consumer of
 * `fx_rates.rate` / `fx_rate_to_nok` sees only the already-normalized per-unit rate, so a currency
 * with a non-zero UNIT_MULT needs no special-casing anywhere else in the codebase.
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
  /**
   * Decimal string — NOK per ONE unit of the requested base currency (canonical
   * `fx_rate_to_nok` shape, FINANCIAL_MODEL.md §7). Already corrected for Norges Bank's
   * `UNIT_MULT` — callers never see the raw per-100 (or other multiple) provider value.
   */
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
  const seriesEntry = seriesEntries[0] as Record<string, unknown> | undefined
  const observations = seriesEntry?.['observations']
  if (typeof observations !== 'object' || observations === null) {
    return []
  }
  if (Object.keys(observations as Record<string, unknown>).length === 0) {
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

  // Series-level, not observation-level (confirmed live 2026-09-14): one UNIT_MULT applies to
  // every observation this series publishes, so it is resolved once, outside the observation loop.
  const unitMult = resolveUnitMult(structure, seriesEntry)

  const result: NorgesBankObservation[] = []
  for (const [indexKey, value] of Object.entries(observations as Record<string, unknown>)) {
    const index = Number(indexKey)
    if (!Number.isInteger(index) || index < 0 || index >= timeValues.length) continue
    const dateId = (timeValues[index] as Record<string, unknown> | undefined)?.['id']
    if (typeof dateId !== 'string' || !DATE_SHAPE.test(dateId)) continue
    if (!Array.isArray(value) || typeof value[0] !== 'string') continue
    const rateNumber = Number(value[0])
    if (!Number.isFinite(rateNumber) || rateNumber <= 0) continue
    result.push({ date: dateId, rate: normalizeObservationValue(value[0], unitMult) })
  }

  result.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  return result
}

/**
 * Resolves the series-level `UNIT_MULT` SDMX attribute as a plain integer exponent.
 *
 * SDMX-JSON does not inline attribute values on the series itself: `series.attributes` is an array
 * of integer *indices*, positionally parallel to `structure.attributes.series` (the attribute
 * *definitions*, each carrying its own `values` lookup table). To read UNIT_MULT you must: find
 * UNIT_MULT's position in the definitions array, read the index at that same position in
 * `series.attributes`, then look that index up in the definition's own `values` array — e.g. for
 * JPY (live 2026-09-14): `structure.attributes.series[2].id === 'UNIT_MULT'`,
 * `series.attributes[2] === 0`, `structure.attributes.series[2].values[0] === { id: '2', name:
 * 'Hundreds' }`. The position of UNIT_MULT among the attribute definitions is not assumed fixed
 * (Norges Bank could reorder or add attributes) — it is located by `id`, every time.
 *
 * Fails closed (throws `NorgesBankError`) rather than defaulting to 0 whenever UNIT_MULT cannot be
 * resolved to a plain integer: for a series where the true multiplier is non-zero, silently
 * assuming "Units" would store a rate wrong by a power of ten with no signal anywhere that it
 * happened. Every caller already has a real error path for "Norges Bank unreachable" /
 * "no_rate_found", so refusing here just routes into that existing, already-handled failure mode
 * instead of writing a wrong number.
 */
function resolveUnitMult(
  structure: unknown,
  seriesEntry: Record<string, unknown> | undefined,
): number {
  const attributeIndices = seriesEntry?.['attributes']
  if (!Array.isArray(attributeIndices)) {
    throw new NorgesBankError('unexpected Norges Bank response shape (no series attributes)')
  }

  const attributesRoot = (structure as Record<string, unknown> | undefined)?.['attributes']
  const seriesAttributeDefs = (attributesRoot as Record<string, unknown> | undefined)?.['series']
  if (!Array.isArray(seriesAttributeDefs)) {
    throw new NorgesBankError(
      'unexpected Norges Bank response shape (no series attribute metadata)',
    )
  }

  const definitionIndex = seriesAttributeDefs.findIndex(
    (definition) => (definition as Record<string, unknown> | undefined)?.['id'] === 'UNIT_MULT',
  )
  if (definitionIndex === -1) {
    throw new NorgesBankError('Norges Bank response is missing UNIT_MULT series metadata')
  }

  const valueIndex = attributeIndices[definitionIndex]
  if (typeof valueIndex !== 'number' || !Number.isInteger(valueIndex) || valueIndex < 0) {
    throw new NorgesBankError('Norges Bank response has a malformed UNIT_MULT attribute reference')
  }

  const definition = seriesAttributeDefs[definitionIndex] as Record<string, unknown>
  const values = definition['values']
  if (!Array.isArray(values) || valueIndex >= values.length) {
    throw new NorgesBankError('Norges Bank UNIT_MULT attribute value index is out of range')
  }

  const rawId = (values[valueIndex] as Record<string, unknown> | undefined)?.['id']
  if (typeof rawId !== 'string' || !/^-?\d+$/.test(rawId)) {
    throw new NorgesBankError(
      `Norges Bank UNIT_MULT is not a plain integer: ${JSON.stringify(rawId)}`,
    )
  }

  return Number(rawId)
}

/**
 * Applies `UNIT_MULT` to a raw SDMX observation value: `normalized = observation / 10^unitMult`
 * (FINANCIAL_MODEL.md §7's per-unit `fx_rate_to_nok` contract; SDMX's own UNIT_MULT definition —
 * "multiplying the observation by 10^UNIT_MULT gives a value expressed in the UNIT" — is exactly
 * this relationship inverted). Implemented as exact decimal-point shifting over the digit string,
 * never `Number` arithmetic: a floating-point division here would risk silently corrupting a value
 * that is about to become a frozen, never-recomputed monetary rate (FINANCIAL_MODEL.md §7,
 * invariant F11) — the same "no float for money" rule the client's own `src/domain` modules follow,
 * applied at the point where an external decimal string first enters the system.
 *
 * `unitMult === 0` (EUR, USD — "Units") is a no-op: the digit string is returned unchanged, not
 * reformatted, so this function is provably transparent for every currency Norges Bank does not
 * rescale.
 */
function normalizeObservationValue(rawValue: string, unitMult: number): string {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(rawValue)
  if (!match) {
    throw new NorgesBankError(`unexpected Norges Bank observation value shape: ${rawValue}`)
  }
  if (unitMult === 0) {
    return rawValue
  }

  const integerPart = match[1]!
  const fractionPart = match[2] ?? ''
  const digits = integerPart + fractionPart
  // Where the decimal point sits within `digits` after shifting left by `unitMult` places
  // (dividing by 10^unitMult); a negative `unitMult` shifts right (multiplies) by the same formula.
  const pointIndex = integerPart.length - unitMult

  let shifted: string
  if (pointIndex <= 0) {
    shifted = `0.${'0'.repeat(-pointIndex)}${digits}`
  } else if (pointIndex >= digits.length) {
    shifted = `${digits}${'0'.repeat(pointIndex - digits.length)}`
  } else {
    shifted = `${digits.slice(0, pointIndex)}.${digits.slice(pointIndex)}`
  }

  return normalizeDecimalString(shifted)
}

/** Strips insignificant leading/trailing zeros introduced by digit-shifting, without touching the
 *  numeric value itself (e.g. "007.500" -> "7.5", "0.060375" stays "0.060375"). */
function normalizeDecimalString(value: string): string {
  let result = value
  if (result.includes('.')) {
    result = result.replace(/0+$/, '')
    result = result.replace(/\.$/, '')
  }
  result = result.replace(/^0+(\d)/, '$1')
  return result
}

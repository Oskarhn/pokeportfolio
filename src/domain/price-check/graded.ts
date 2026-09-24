/**
 * Graded price observations (PSA / BGS / CGC / …), P153.
 *
 * STATUS: no authorized graded price source exists for this project (docs/API_SOURCES.md — TCGdex
 * carries no graded prices; PSA's API offers no price data; PriceCharting and Scrydex are paid and
 * the project's standing spend authorization is $0). This module therefore defines the model and
 * the validation a graded source must pass, and `gradedSection` reports "not configured" honestly
 * when no source is wired. It never derives a graded price from a raw price, and it never treats
 * one company's grade as another's: PSA 10, BGS 10 and CGC 10 are three unrelated subjects.
 *
 * A future adapter returns `unknown` wire data; only what survives `parseGradedObservations`
 * reaches the UI, and `kind` (sold / listing / index) is mandatory — a graded number whose basis
 * the source does not state is dropped, not defaulted.
 */
import { fromMinorUnits } from '../money'
import { parseInstant } from './freshness'
import { asCurrencyCode, asRecord } from './wire'
import type {
  DroppedObservation,
  GradedPriceSection,
  GradedSourceStatus,
  GradingCompany,
  PriceKind,
  PriceObservation,
  UnavailableReason,
} from './types'

export const GRADING_COMPANIES: readonly GradingCompany[] = [
  'PSA',
  'BGS',
  'CGC',
  'SGC',
  'ACE',
  'TAG',
]

const PRICE_KINDS: readonly PriceKind[] = ['listing', 'sold', 'index']
const MINOR_UNITS_PATTERN = /^\d{1,18}$/
/** "10", "9", "9.5" — a whole grade 1–10 or a half grade. */
const GRADE_PATTERN = /^(?:10|[1-9])(?:\.5)?$/

export interface GradedSourceDescriptor {
  readonly id: string
  readonly label: string
}

export interface GradedParseContext {
  readonly source: GradedSourceDescriptor
  readonly fetchedAt: string
  readonly synthetic?: boolean
}

function parseOne(
  wire: unknown,
  ctx: GradedParseContext,
): { observation: PriceObservation } | { dropped: DroppedObservation } {
  const provider = ctx.source.id
  const record = asRecord(wire)
  if (record === null) return { dropped: { reason: 'malformed_price', provider } }

  const company = record.company
  if (typeof company !== 'string' || !GRADING_COMPANIES.includes(company as GradingCompany)) {
    return { dropped: { reason: 'unknown_company', provider } }
  }
  const grade = record.grade
  if (typeof grade !== 'string' || !GRADE_PATTERN.test(grade)) {
    return { dropped: { reason: 'malformed_grade', provider } }
  }
  const kind = record.kind
  if (typeof kind !== 'string' || !PRICE_KINDS.includes(kind as PriceKind)) {
    return { dropped: { reason: 'missing_kind', provider } }
  }
  const currency = asCurrencyCode(record.currency)
  if (currency === null) {
    return { dropped: { reason: 'unsupported_currency', provider } }
  }
  const valueMinor = record.valueMinor
  if (typeof valueMinor !== 'string' || !MINOR_UNITS_PATTERN.test(valueMinor)) {
    return { dropped: { reason: 'malformed_price', provider } }
  }
  const observedRaw = record.observedAt
  const qualifier =
    typeof record.qualifier === 'string' && record.qualifier.trim() !== ''
      ? record.qualifier.trim()
      : null

  return {
    observation: {
      subject: { type: 'graded', company: company as GradingCompany, grade, qualifier },
      provider,
      providerLabel: ctx.source.label,
      metric: typeof record.metric === 'string' ? record.metric : kind,
      metricLabel: typeof record.metricLabel === 'string' ? record.metricLabel : kind,
      basisNote:
        typeof record.basisNote === 'string' && record.basisNote !== ''
          ? record.basisNote
          : 'Basis as stated by the source.',
      kind: kind as PriceKind,
      price: fromMinorUnits(BigInt(valueMinor), currency),
      windowDays: null,
      observedAt:
        typeof observedRaw === 'string' && parseInstant(observedRaw) !== null ? observedRaw : null,
      fetchedAt: ctx.fetchedAt,
      condition: null,
      synthetic: ctx.synthetic ?? false,
    },
  }
}

export function parseGradedObservations(
  wire: unknown,
  ctx: GradedParseContext,
): { observations: PriceObservation[]; dropped: DroppedObservation[] } {
  const observations: PriceObservation[] = []
  const dropped: DroppedObservation[] = []
  if (!Array.isArray(wire)) return { observations, dropped }
  for (const item of wire) {
    const parsed = parseOne(item, ctx)
    if ('observation' in parsed) observations.push(parsed.observation)
    else dropped.push(parsed.dropped)
  }
  return { observations, dropped }
}

/** The graded section for a card variant. With no consulted source it is `unavailable` for the
 *  honest reason that no authorized source is configured; with sources that answered but returned
 *  nothing it is `unavailable: graded_no_data`; with sources that failed, `provider_error`. */
export function gradedSection(input: {
  readonly sources: readonly GradedSourceStatus[]
  readonly observations: readonly PriceObservation[]
  readonly dropped: readonly DroppedObservation[]
}): GradedPriceSection {
  if (input.observations.length > 0) {
    return {
      status: 'available',
      observations: input.observations,
      unavailable: null,
      dropped: input.dropped,
      sources: input.sources,
    }
  }
  let unavailable: UnavailableReason
  if (input.sources.length === 0) unavailable = 'graded_source_not_configured'
  else if (input.sources.some((s) => s.state === 'error')) unavailable = 'provider_error'
  else unavailable = 'graded_no_data'
  return {
    status: 'unavailable',
    observations: [],
    unavailable,
    dropped: input.dropped,
    sources: input.sources,
  }
}

/** Groups graded observations by company, then orders each company's rows by grade descending and
 *  qualifier, so a table can show "PSA: 10, 9, 8" without ever merging companies. */
export function groupGradedByCompany(
  observations: readonly PriceObservation[],
): { company: GradingCompany; rows: PriceObservation[] }[] {
  const byCompany = new Map<GradingCompany, PriceObservation[]>()
  for (const observation of observations) {
    if (observation.subject.type !== 'graded') continue
    const rows = byCompany.get(observation.subject.company) ?? []
    rows.push(observation)
    byCompany.set(observation.subject.company, rows)
  }
  const gradeValue = (o: PriceObservation): number =>
    o.subject.type === 'graded' ? Number(o.subject.grade) : 0
  return GRADING_COMPANIES.filter((c) => byCompany.has(c)).map((company) => ({
    company,
    rows: [...(byCompany.get(company) ?? [])].sort(
      (a, b) =>
        gradeValue(b) - gradeValue(a) ||
        (a.subject.type === 'graded' ? (a.subject.qualifier ?? '') : '').localeCompare(
          b.subject.type === 'graded' ? (b.subject.qualifier ?? '') : '',
        ),
    ),
  }))
}

import { useState } from 'react'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  addCardAcquisition,
  createStorageLocation,
  getManualCard,
  listStorageLocations,
  type CardCondition,
  type CostBasisState,
  type Grader,
  type GradingState,
  type LotOrigin,
} from '../../data/collection'
import { getCardVariantWithCard, type CatalogVariantWithCard } from '../../data/catalog'
import { localTodayIso } from '../../platform/local-date'
import { CardImage } from '../catalog/CardImage'
import {
  Button,
  ChoiceGroup,
  FormMessage,
  FormSection,
  SelectField,
  TextField,
} from '../../ui/form'
import { parseNokInput } from '../../ui/money-format'
import { CONDITION_LABEL, FINISH_LABEL, GRADER_LABEL, ORIGIN_LABEL } from './labels'
import { fixedCostBasisState } from './origin-basis'

const CONDITIONS: CardCondition[] = ['MT', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO']
const GRADERS: Grader[] = ['psa', 'cgc', 'bgs', 'ace', 'sgc', 'tag', 'other']
const ORIGINS: LotOrigin[] = ['purchase', 'opening', 'gift', 'trade_in', 'pre_tracking', 'other']

/** Whether a direct per-card cost is even askable for this origin — a pull or a gift never shows
 *  a cost field (FINANCIAL_MODEL.md §5.2/E12; M6 prompt §56). */
function costIsApplicable(origin: LotOrigin): boolean {
  return origin === 'purchase' || origin === 'other'
}

interface CardIdentity {
  displayName: string
  displaySubtitle: string
  imageBaseUrl: string | null
}

export function AddToCollectionPage() {
  const search = useSearch({ from: '/add' })
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const variantId = search.variantId
  const manualCardId = search.manualCardId

  const variantQuery = useQuery({
    queryKey: ['add-flow-variant', variantId],
    queryFn: () => getCardVariantWithCard(variantId ?? ''),
    enabled: variantId !== undefined,
  })
  const manualQuery = useQuery({
    queryKey: ['add-flow-manual-card', manualCardId],
    queryFn: () => getManualCard(manualCardId ?? ''),
    enabled: manualCardId !== undefined,
  })
  const locations = useQuery({ queryKey: ['storage-locations'], queryFn: listStorageLocations })

  const [gradingState, setGradingState] = useState<GradingState>('raw')
  const [condition, setCondition] = useState<CardCondition>('NM')
  const [grader, setGrader] = useState<Grader>('psa')
  const [grade, setGrade] = useState('')
  const [certNumber, setCertNumber] = useState('')
  const [manualValue, setManualValue] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [origin, setOrigin] = useState<LotOrigin>('purchase')
  const [costKnown, setCostKnown] = useState(true)
  const [costPerCard, setCostPerCard] = useState('')
  const [acquiredOn, setAcquiredOn] = useState(localTodayIso)
  const [storageLocationId, setStorageLocationId] = useState('')
  const [newLocationName, setNewLocationName] = useState('')
  const [isFavorite, setIsFavorite] = useState(false)
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null)

  const addMutation = useMutation({
    mutationFn: addCardAcquisition,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['portfolio'] })
      await queryClient.invalidateQueries({ queryKey: ['portfolio-counts'] })
      // New ownership changes the live current-value figures Home derives from its summary.
      await queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] })
      await navigate({ to: '/portfolio' })
    },
  })

  const createLocationMutation = useMutation({
    mutationFn: createStorageLocation,
    onSuccess: async (location) => {
      await queryClient.invalidateQueries({ queryKey: ['storage-locations'] })
      setStorageLocationId(location.id)
      setNewLocationName('')
    },
  })

  if (!search.variantId && !search.manualCardId) {
    return (
      <div className="mx-auto w-full max-w-md space-y-3 py-8 text-center">
        <p className="text-sm text-slate-400">
          Start from a card's detail page, or add a card the catalog doesn't have.
        </p>
        <Link to="/catalog" className="text-sm text-sky-400 underline-offset-4 hover:underline">
          Search the catalog
        </Link>
      </div>
    )
  }

  const loading =
    (search.variantId ? variantQuery.isPending : false) ||
    (search.manualCardId ? manualQuery.isPending : false)
  if (loading) {
    return <div className="mx-auto h-64 w-full max-w-xl animate-pulse rounded-lg bg-slate-800/60" />
  }

  const variant: CatalogVariantWithCard | null | undefined = variantQuery.data
  const manual = manualQuery.data
  if ((variantId && !variant) || (manualCardId && !manual)) {
    return (
      <p
        role="alert"
        className="mx-auto w-full max-w-xl rounded-lg border border-rose-900/60 bg-rose-950/40 p-3 text-sm text-rose-200"
      >
        That card could not be found.
      </p>
    )
  }

  const identity: CardIdentity = variant
    ? {
        displayName: variant.cardName,
        displaySubtitle:
          `${variant.setName} · #${variant.localId} · ${FINISH_LABEL[variant.finish] ?? variant.finish}` +
          (variant.subtype ? ` · ${variant.subtype}` : ''),
        imageBaseUrl: variant.imageBaseUrl,
      }
    : manual
      ? {
          displayName: manual.name,
          displaySubtitle:
            [manual.setName, manual.collectorNumber ? `#${manual.collectorNumber}` : null]
              .filter(Boolean)
              .join(' · ') || 'Manual entry',
          imageBaseUrl: null,
        }
      : { displayName: 'Unknown card', displaySubtitle: '', imageBaseUrl: null }

  async function handleSubmit() {
    setError(null)

    const quantityNumber = Number.parseInt(quantity, 10)
    if (!Number.isFinite(quantityNumber) || quantityNumber <= 0) {
      setError('Enter a quantity of at least 1.')
      return
    }
    if (gradingState === 'graded' && grade.trim() === '') {
      setError('Enter the grade.')
      return
    }

    let unitCostBasisMinor: bigint | undefined
    let costBasisState: CostBasisState = fixedCostBasisState(origin) ?? 'unknown'
    if (costIsApplicable(origin)) {
      if (costKnown) {
        try {
          unitCostBasisMinor = parseNokInput(costPerCard)
        } catch {
          setError('Enter a valid cost per card, e.g. 149 or 149,50.')
          return
        }
        costBasisState = 'known'
      } else {
        costBasisState = 'unknown'
      }
    }

    let manualValueMinor: bigint | undefined
    if (gradingState === 'graded' && manualValue.trim() !== '') {
      try {
        manualValueMinor = parseNokInput(manualValue)
      } catch {
        setError('Enter a valid manual value, e.g. 2500.')
        return
      }
    }

    try {
      await addMutation.mutateAsync({
        cardVariantId: variant?.id,
        manualCardId: manual?.id,
        gradingState,
        condition: gradingState === 'raw' ? condition : undefined,
        grader: gradingState === 'graded' ? grader : undefined,
        grade: gradingState === 'graded' ? Number.parseFloat(grade) : undefined,
        certNumber:
          gradingState === 'graded' && certNumber.trim() !== '' ? certNumber.trim() : undefined,
        isFavorite,
        holdingNotes: notes.trim() !== '' ? notes.trim() : undefined,
        origin,
        costBasisState,
        unitCostBasisMinor,
        quantity: quantityNumber,
        acquiredOn,
        storageLocationId: storageLocationId !== '' ? storageLocationId : undefined,
        manualValueMinor,
      })
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : 'Could not save this card.')
    }
  }

  return (
    <div className="mx-auto w-full max-w-xl space-y-6 py-2">
      <div className="flex gap-4">
        <CardImage
          imageBaseUrl={identity.imageBaseUrl}
          alt={identity.displayName}
          quality="high"
          className="h-32 w-24 shrink-0"
        />
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-slate-100">
            {identity.displayName}
          </h1>
          <p className="text-sm text-slate-400">{identity.displaySubtitle}</p>
        </div>
      </div>

      <form
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault()
          void handleSubmit()
        }}
        noValidate
      >
        <FormSection title="Card">
          <TextField
            label="Quantity"
            type="number"
            inputMode="numeric"
            min={1}
            value={quantity}
            onChange={(event) => {
              setQuantity(event.target.value)
            }}
          />
          <ChoiceGroup
            label="Raw or graded"
            value={gradingState}
            onChange={setGradingState}
            options={[
              ['raw', 'Raw'],
              ['graded', 'Graded'],
            ]}
          />
          {gradingState === 'raw' ? (
            <ChoiceGroup
              label="Condition"
              value={condition}
              onChange={setCondition}
              options={CONDITIONS.map((c) => [c, CONDITION_LABEL[c]] as const)}
            />
          ) : (
            <>
              <ChoiceGroup
                label="Grader"
                value={grader}
                onChange={setGrader}
                options={GRADERS.map((g) => [g, GRADER_LABEL[g]] as const)}
              />
              <TextField
                label="Grade"
                inputMode="decimal"
                placeholder="10"
                value={grade}
                onChange={(event) => {
                  setGrade(event.target.value)
                }}
              />
              <TextField
                label="Certification number"
                hint="Optional"
                value={certNumber}
                onChange={(event) => {
                  setCertNumber(event.target.value)
                }}
              />
              <TextField
                label="Manual value (NOK)"
                hint="Optional — separate from acquisition cost, marked as your own estimate"
                inputMode="decimal"
                placeholder="2500"
                value={manualValue}
                onChange={(event) => {
                  setManualValue(event.target.value)
                }}
              />
            </>
          )}
        </FormSection>

        <FormSection title="How you got it">
          <ChoiceGroup
            label="Acquisition origin"
            value={origin}
            onChange={setOrigin}
            options={ORIGINS.map((o) => [o, ORIGIN_LABEL[o]] as const)}
          />
          {costIsApplicable(origin) ? (
            <>
              <ChoiceGroup
                label="Cost"
                value={costKnown ? 'known' : 'unknown'}
                onChange={(value) => {
                  setCostKnown(value === 'known')
                }}
                options={[
                  ['known', 'Known'],
                  ['unknown', 'Unknown'],
                ]}
              />
              {costKnown ? (
                <TextField
                  label="Cost per card (NOK)"
                  inputMode="decimal"
                  placeholder="149,00"
                  value={costPerCard}
                  onChange={(event) => {
                    setCostPerCard(event.target.value)
                  }}
                />
              ) : (
                <p className="text-xs text-slate-500">
                  Recorded with no cost — never shown as 0 kr.
                </p>
              )}
            </>
          ) : (
            <p className="text-xs text-slate-500">
              {origin === 'opening'
                ? 'From a pack opening — no individual purchase cost is recorded here.'
                : origin === 'gift'
                  ? 'Gifted — no money changed hands.'
                  : origin === 'trade_in'
                    ? 'Received in a trade — no cost basis is recorded here.'
                    : 'Already in your collection — historical cost is treated as unknown.'}
            </p>
          )}
          <TextField
            label="Acquired on"
            type="date"
            value={acquiredOn}
            onChange={(event) => {
              setAcquiredOn(event.target.value)
            }}
          />
        </FormSection>

        <FormSection title="Storage & notes">
          <SelectField
            label="Storage location"
            hint="Optional"
            value={storageLocationId}
            onChange={(event) => {
              setStorageLocationId(event.target.value)
            }}
          >
            <option value="">None</option>
            {locations.data?.map((location) => (
              <option key={location.id} value={location.id}>
                {location.name}
              </option>
            ))}
          </SelectField>
          <div className="flex items-end gap-2">
            <TextField
              label="New location"
              hint="Optional"
              value={newLocationName}
              onChange={(event) => {
                setNewLocationName(event.target.value)
              }}
            />
            <Button
              type="button"
              variant="quiet"
              className="w-auto shrink-0"
              disabled={newLocationName.trim() === '' || createLocationMutation.isPending}
              onClick={() => {
                createLocationMutation.mutate(newLocationName.trim())
              }}
            >
              Add
            </Button>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={isFavorite}
              onChange={(event) => {
                setIsFavorite(event.target.checked)
              }}
              className="h-5 w-5 rounded border-slate-700 bg-slate-900 text-sky-600 focus-visible:outline-2 focus-visible:outline-sky-500"
            />
            Favourite
          </label>
          <TextField
            label="Notes"
            hint="Optional"
            value={notes}
            onChange={(event) => {
              setNotes(event.target.value)
            }}
          />
        </FormSection>

        {error ? <FormMessage tone="error">{error}</FormMessage> : null}

        <Button type="submit" disabled={addMutation.isPending}>
          {addMutation.isPending ? 'Saving…' : 'Add to collection'}
        </Button>
      </form>
    </div>
  )
}

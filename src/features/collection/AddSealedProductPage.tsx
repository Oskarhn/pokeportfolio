import { useState } from 'react'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  addCardAcquisition,
  createStorageLocation,
  listStorageLocations,
  SEALED_INTENT_LABEL,
  type CostBasisState,
  type SealedIntent,
} from '../../data/collection'
import {
  getSealedProduct,
  searchSealedProducts,
  SEALED_PRODUCT_TYPE_LABEL,
} from '../../data/sealedProducts'
import { SealedProductImage } from '../catalog/SealedProductImage'
import { localTodayIso } from '../../platform/local-date'
import {
  Button,
  ChoiceGroup,
  FormMessage,
  FormSection,
  SelectField,
  TextField,
} from '../../ui/form'
import { parseNokInput } from '../../ui/money-format'
import { useDebouncedValue } from '../../ui/useDebouncedValue'

/** The frozen origin subset for a sealed acquisition (M11 prompt §29) — a sealed product is never
 *  "pulled" (that's a card leaving a pack, the opposite direction) and is never a trade-in target
 *  here either; the card add-flow's own ORIGIN_LABEL (labels.ts) isn't reused because its full set
 *  includes both of those, which would misrepresent what's actually offered for sealed. This is a
 *  narrower type than LotOrigin (not the full enum) precisely so that narrowing is enforced by the
 *  compiler, not just by which buttons happen to be rendered. */
type SealedOrigin = 'purchase' | 'gift' | 'pre_tracking' | 'other'
const SEALED_ORIGINS: SealedOrigin[] = ['purchase', 'gift', 'pre_tracking', 'other']
const SEALED_ORIGIN_LABEL: Record<SealedOrigin, string> = {
  purchase: 'Purchased',
  gift: 'Gifted',
  pre_tracking: 'Existing collection',
  other: 'Other',
}

/** Same cost-askability rule as AddToCollectionPage's costIsApplicable (FINANCIAL_MODEL.md
 *  §5.2/E12) — a gift or pre-existing item never shows a cost field. */
function costIsApplicable(origin: SealedOrigin): boolean {
  return origin === 'purchase' || origin === 'other'
}

function fixedCostBasisState(origin: SealedOrigin): CostBasisState | null {
  switch (origin) {
    case 'gift':
      return 'not_paid'
    case 'pre_tracking':
      return 'unknown'
    default:
      return null // purchase / other: the user chooses known vs unknown
  }
}

/**
 * "Add sealed product" (M11 prompt §61-66) — AddToCollectionPage's sealed counterpart, same
 * origin/cost-basis-state logic, minus the fields that only make sense for a card (condition,
 * grading, manual value at add time). Reached with an optional `?sealedProductId=` pre-fill from
 * the sealed catalog detail page or a Holding Detail "Add another copy" link; without one, an
 * inline picker (typeahead over searchSealedProducts) is the first step, since QuickAddMenu links
 * here with nothing pre-selected.
 */
export function AddSealedProductPage() {
  const search = useSearch({ from: '/portfolio/sealed/new' })
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [selectedProductId, setSelectedProductId] = useState<string | undefined>(
    search.sealedProductId,
  )
  const [pickerQuery, setPickerQuery] = useState('')
  const debouncedPickerQuery = useDebouncedValue(pickerQuery, 250)

  const productQuery = useQuery({
    queryKey: ['sealed-product', selectedProductId],
    queryFn: () => getSealedProduct(selectedProductId ?? ''),
    enabled: selectedProductId !== undefined,
  })
  const pickerResults = useQuery({
    queryKey: ['sealed-product-picker', debouncedPickerQuery],
    queryFn: () => searchSealedProducts({ query: debouncedPickerQuery || undefined, limit: 10 }),
    enabled: selectedProductId === undefined,
  })
  const locations = useQuery({ queryKey: ['storage-locations'], queryFn: listStorageLocations })

  const [quantity, setQuantity] = useState('1')
  const [intent, setIntent] = useState<SealedIntent>('undecided')
  const [origin, setOrigin] = useState<SealedOrigin>('purchase')
  const [costKnown, setCostKnown] = useState(true)
  const [costPerUnit, setCostPerUnit] = useState('')
  const [acquiredOn, setAcquiredOn] = useState(localTodayIso)
  const [storageLocationId, setStorageLocationId] = useState('')
  const [newLocationName, setNewLocationName] = useState('')
  const [isFavorite, setIsFavorite] = useState(false)
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null)

  // P130-04: same fixed-per-mount, retry-stable idempotency key as AddToCollectionPage's own fix —
  // see that page's comment for the full rationale.
  const [clientRequestKey] = useState(() => crypto.randomUUID())

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

  if (selectedProductId === undefined) {
    return (
      <div className="mx-auto w-full max-w-md space-y-4 py-2">
        <header className="space-y-1.5">
          <h1 className="text-xl font-semibold tracking-tight text-slate-100">
            Add sealed product
          </h1>
          <p className="text-sm text-slate-400">Choose a product to add to your Portfolio.</p>
        </header>
        <TextField
          label="Search sealed products"
          value={pickerQuery}
          onChange={(event) => {
            setPickerQuery(event.target.value)
          }}
          placeholder="Booster box, ETB, tin…"
        />
        {pickerResults.data && pickerResults.data.length > 0 ? (
          <ul className="space-y-1">
            {pickerResults.data.map((product) => (
              <li key={product.id}>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedProductId(product.id)
                  }}
                  className="flex w-full items-center gap-3 rounded-lg border border-slate-800 px-3 py-2 text-left hover:bg-slate-800/60"
                >
                  <SealedProductImage
                    imageUrl={product.imageUrl}
                    productType={product.productType}
                    alt={product.name}
                    className="h-12 w-12 shrink-0"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-slate-100">
                      {product.name}
                    </span>
                    <span className="block truncate text-xs text-slate-500">
                      {SEALED_PRODUCT_TYPE_LABEL[product.productType]}
                      {product.setName ? ` · ${product.setName}` : ''}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : pickerResults.isPending ? (
          <div className="h-24 animate-pulse rounded-lg bg-slate-800/60" />
        ) : (
          <p className="text-sm text-slate-500">
            No match.{' '}
            <Link to="/catalog" className="text-sky-400 underline-offset-4 hover:underline">
              Search the full sealed catalog
            </Link>{' '}
            to add a custom product instead.
          </p>
        )}
      </div>
    )
  }

  if (productQuery.isPending) {
    return <div className="mx-auto h-64 w-full max-w-xl animate-pulse rounded-lg bg-slate-800/60" />
  }
  if (productQuery.isError || !productQuery.data) {
    return (
      <p
        role="alert"
        className="mx-auto w-full max-w-xl rounded-lg border border-rose-900/60 bg-rose-950/40 p-3 text-sm text-rose-200"
      >
        That sealed product could not be found.
      </p>
    )
  }

  const product = productQuery.data

  async function handleSubmit() {
    setError(null)

    const quantityNumber = Number.parseInt(quantity, 10)
    if (!Number.isFinite(quantityNumber) || quantityNumber <= 0) {
      setError('Enter a quantity of at least 1.')
      return
    }

    let unitCostBasisMinor: bigint | undefined
    let costBasisState: CostBasisState = fixedCostBasisState(origin) ?? 'unknown'
    if (costIsApplicable(origin)) {
      if (costKnown) {
        try {
          unitCostBasisMinor = parseNokInput(costPerUnit)
        } catch {
          setError('Enter a valid cost per unit, e.g. 899 or 899,00.')
          return
        }
        costBasisState = 'known'
      } else {
        costBasisState = 'unknown'
      }
    }

    try {
      await addMutation.mutateAsync({
        sealedProductId: product.id,
        sealedIntent: intent,
        gradingState: 'raw',
        origin,
        costBasisState,
        unitCostBasisMinor,
        quantity: quantityNumber,
        acquiredOn,
        storageLocationId: storageLocationId !== '' ? storageLocationId : undefined,
        isFavorite,
        holdingNotes: notes.trim() !== '' ? notes.trim() : undefined,
        clientRequestKey,
      })
    } catch (mutationError) {
      setError(
        mutationError instanceof Error ? mutationError.message : 'Could not save this product.',
      )
    }
  }

  return (
    <div className="mx-auto w-full max-w-xl space-y-6 py-2">
      <div className="flex gap-4">
        <SealedProductImage
          imageUrl={product.imageUrl}
          productType={product.productType}
          alt={product.name}
          className="h-32 w-32 shrink-0"
        />
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-slate-100">{product.name}</h1>
          <p className="text-sm text-slate-400">
            {[
              SEALED_PRODUCT_TYPE_LABEL[product.productType],
              product.setName,
              product.language === 'ja' ? 'Japanese' : 'English',
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          <button
            type="button"
            onClick={() => {
              setSelectedProductId(undefined)
            }}
            className="mt-1 text-xs text-sky-400 underline-offset-4 hover:underline"
          >
            Choose a different product
          </button>
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
        <FormSection title="Sealed product">
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
            label="Intent"
            value={intent}
            onChange={setIntent}
            options={(Object.keys(SEALED_INTENT_LABEL) as SealedIntent[]).map(
              (i) => [i, SEALED_INTENT_LABEL[i]] as const,
            )}
          />
          <p className="text-xs text-slate-500">
            Organisational only — never opens anything, and you can change it later from the
            holding.
          </p>
        </FormSection>

        <FormSection title="How you got it">
          <ChoiceGroup
            label="Acquisition origin"
            value={origin}
            onChange={setOrigin}
            options={SEALED_ORIGINS.map((o) => [o, SEALED_ORIGIN_LABEL[o]] as const)}
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
                  label="Cost per unit (NOK)"
                  inputMode="decimal"
                  placeholder="899,00"
                  value={costPerUnit}
                  onChange={(event) => {
                    setCostPerUnit(event.target.value)
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
              {origin === 'gift'
                ? 'Gifted — no money changed hands.'
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
          {addMutation.isPending ? 'Saving…' : 'Add to Portfolio'}
        </Button>
      </form>
    </div>
  )
}

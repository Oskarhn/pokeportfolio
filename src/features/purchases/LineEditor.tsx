import { useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  searchCards,
  getCardVariants,
  type CatalogSearchResult,
  type CatalogVariant,
} from '../../data/catalog'
import {
  listStorageLocations,
  type CardCondition,
  type Grader,
  type GradingState,
} from '../../data/collection'
import { listSealedProducts, type LineType, type SpendClass } from '../../data/purchases'
import { ChoiceGroup, SelectField, TextField } from '../../ui/form'
import { LINE_TYPE_OPTIONS, SPEND_ONLY_LINE_TYPES } from './labels'

const CONDITIONS: CardCondition[] = ['MT', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO']
const GRADERS: Grader[] = ['psa', 'cgc', 'bgs', 'ace', 'sgc', 'tag', 'other']

export interface LineDraft {
  id: string
  lineType: LineType
  cardMode: 'catalog' | 'manual'
  cardVariantId: string | null
  cardDisplayName: string
  manualCardName: string
  sealedProductId: string | null
  gradingState: GradingState
  condition: CardCondition
  grader: Grader
  grade: string
  certNumber: string
  manualValue: string
  description: string
  quantity: string
  unitPrice: string
  spendClassOverride: SpendClass | ''
  storageLocationId: string
  isFavorite: boolean
}

let draftCounter = 0
export function newLineDraft(lineType: LineType = 'card'): LineDraft {
  draftCounter += 1
  return {
    id: `line-${Date.now()}-${draftCounter}`,
    lineType,
    cardMode: 'catalog',
    cardVariantId: null,
    cardDisplayName: '',
    manualCardName: '',
    sealedProductId: null,
    gradingState: 'raw',
    condition: 'NM',
    grader: 'psa',
    grade: '',
    certNumber: '',
    manualValue: '',
    description: '',
    quantity: '1',
    unitPrice: '',
    spendClassOverride: '',
    storageLocationId: '',
    isFavorite: false,
  }
}

/** One line of the new-purchase multi-line editor (M8 prompt §19-21). Card/sealed identity, raw
 *  vs graded configuration and spend-class override live here; quantity/price/allocation preview
 *  math lives in the parent, which owns every line's totals at once. */
export function LineEditorRow({
  draft,
  index,
  onChange,
  onRemove,
  canRemove,
}: {
  draft: LineDraft
  index: number
  onChange: (patch: Partial<LineDraft>) => void
  onRemove: () => void
  canRemove: boolean
}) {
  const headingId = useId()
  const isSpendOnly = SPEND_ONLY_LINE_TYPES.includes(draft.lineType)

  return (
    <div className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 id={headingId} className="text-sm font-semibold text-slate-200">
          Line {index + 1}
        </h3>
        {canRemove ? (
          <button
            type="button"
            onClick={onRemove}
            className="text-xs font-medium text-rose-300 hover:text-rose-200"
          >
            Remove
          </button>
        ) : null}
      </div>

      <SelectField
        label="Type"
        value={draft.lineType}
        onChange={(event) => {
          onChange({ lineType: event.target.value as LineType })
        }}
      >
        {LINE_TYPE_OPTIONS.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </SelectField>

      {draft.lineType === 'card' ? <CardLineFields draft={draft} onChange={onChange} /> : null}
      {draft.lineType === 'sealed' ? <SealedLineFields draft={draft} onChange={onChange} /> : null}
      {isSpendOnly ? (
        <TextField
          label="Description"
          value={draft.description}
          onChange={(event) => {
            onChange({ description: event.target.value })
          }}
          placeholder="e.g. Deck box and sleeves"
        />
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        <TextField
          label="Quantity"
          type="number"
          min={1}
          step={1}
          inputMode="numeric"
          value={draft.quantity}
          onChange={(event) => {
            onChange({ quantity: event.target.value })
          }}
        />
        <TextField
          label="Unit price"
          type="text"
          inputMode="decimal"
          value={draft.unitPrice}
          onChange={(event) => {
            onChange({ unitPrice: event.target.value })
          }}
          placeholder="0.00"
        />
      </div>

      {['shipping_standalone', 'customs_standalone', 'other'].includes(draft.lineType) ? (
        <SelectField
          label="Spend class"
          hint="Auto follows the purchase's dominant class unless you choose one."
          value={draft.spendClassOverride}
          onChange={(event) => {
            onChange({ spendClassOverride: event.target.value as SpendClass | '' })
          }}
        >
          <option value="">Auto</option>
          <option value="collectible">Collectible</option>
          <option value="hobby">Accessory / hobby</option>
        </SelectField>
      ) : null}
    </div>
  )
}

function CardLineFields({
  draft,
  onChange,
}: {
  draft: LineDraft
  onChange: (patch: Partial<LineDraft>) => void
}) {
  const [query, setQuery] = useState('')
  const [selectedCard, setSelectedCard] = useState<CatalogSearchResult | null>(null)

  const results = useQuery({
    queryKey: ['purchase-line-card-search', query],
    queryFn: () => searchCards({ query, language: null, limit: 6 }),
    enabled: query.trim().length >= 2,
  })
  const variants = useQuery({
    queryKey: ['purchase-line-card-variants', selectedCard?.cardId],
    queryFn: () => getCardVariants(selectedCard?.cardId ?? ''),
    enabled: !!selectedCard && selectedCard.variantCount > 1,
  })
  const locations = useQuery({ queryKey: ['storage-locations'], queryFn: listStorageLocations })

  function selectCard(card: CatalogSearchResult) {
    setSelectedCard(card)
    setQuery('')
    if (card.variantCount === 1) {
      // Resolved once variants load — see the effect-free follow-up below via a second query
      // read: for the single-variant case, fetch immediately and pick the sole result.
      void getCardVariants(card.cardId).then((list) => {
        const only = list[0]
        if (only) {
          onChange({
            cardVariantId: only.id,
            cardDisplayName: `${card.name} (#${card.localId})`,
          })
        }
      })
    } else {
      onChange({ cardVariantId: null, cardDisplayName: `${card.name} (#${card.localId})` })
    }
  }

  function variantLabel(variant: CatalogVariant): string {
    const parts: string[] = [variant.finish]
    if (variant.stamp) parts.push(variant.stamp)
    if (variant.subtype) parts.push(variant.subtype)
    return parts.join(' · ')
  }

  return (
    <div className="space-y-3">
      <ChoiceGroup
        label="Card identity"
        value={draft.cardMode}
        options={[
          ['catalog', 'From catalog'],
          ['manual', "Catalog doesn't have it"],
        ]}
        onChange={(value) => {
          onChange({ cardMode: value, cardVariantId: null, manualCardName: '' })
          setSelectedCard(null)
        }}
      />

      {draft.cardMode === 'catalog' ? (
        <div className="space-y-2">
          {draft.cardVariantId ? (
            <div className="flex items-center justify-between rounded-lg border border-sky-800 bg-sky-950/30 px-3 py-2 text-sm text-sky-100">
              <span>{draft.cardDisplayName}</span>
              <button
                type="button"
                className="text-xs text-sky-300 hover:text-sky-200"
                onClick={() => {
                  onChange({ cardVariantId: null, cardDisplayName: '' })
                  setSelectedCard(null)
                }}
              >
                Change
              </button>
            </div>
          ) : (
            <>
              <TextField
                label="Search catalog"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value)
                }}
                placeholder="Card name or set + number"
              />
              {results.data && results.data.results.length > 0 ? (
                <ul className="max-h-48 space-y-1 overflow-y-auto">
                  {results.data.results.map((card) => (
                    <li key={card.cardId}>
                      <button
                        type="button"
                        onClick={() => {
                          selectCard(card)
                        }}
                        className="flex w-full items-center justify-between rounded-lg border border-slate-800 px-3 py-2 text-left text-sm text-slate-200 hover:bg-slate-800/60"
                      >
                        <span className="truncate">{card.name}</span>
                        <span className="shrink-0 text-xs text-slate-500">
                          {card.setName} · #{card.localId}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {selectedCard && variants.data && variants.data.length > 1 ? (
                <SelectField
                  label="Variant"
                  value={draft.cardVariantId ?? ''}
                  onChange={(event) => {
                    onChange({ cardVariantId: event.target.value })
                  }}
                >
                  <option value="" disabled>
                    Choose a variant
                  </option>
                  {variants.data.map((variant) => (
                    <option key={variant.id} value={variant.id}>
                      {variantLabel(variant)}
                    </option>
                  ))}
                </SelectField>
              ) : null}
            </>
          )}
        </div>
      ) : (
        <TextField
          label="Card name"
          value={draft.manualCardName}
          onChange={(event) => {
            onChange({ manualCardName: event.target.value })
          }}
          placeholder="e.g. Pikachu — Base Set 58/102 (Japanese promo)"
        />
      )}

      <ChoiceGroup
        label="Raw or graded"
        value={draft.gradingState === 'graded' ? 'graded' : 'raw'}
        options={[
          ['raw', 'Raw'],
          ['graded', 'Graded'],
        ]}
        onChange={(value) => {
          onChange({ gradingState: value === 'graded' ? 'graded' : 'raw' })
        }}
      />

      {draft.gradingState === 'graded' ? (
        <div className="grid grid-cols-2 gap-3">
          <SelectField
            label="Grader"
            value={draft.grader}
            onChange={(event) => {
              onChange({ grader: event.target.value as Grader })
            }}
          >
            {GRADERS.map((g) => (
              <option key={g} value={g}>
                {g.toUpperCase()}
              </option>
            ))}
          </SelectField>
          <TextField
            label="Grade"
            inputMode="decimal"
            value={draft.grade}
            onChange={(event) => {
              onChange({ grade: event.target.value })
            }}
            placeholder="10"
          />
          <TextField
            label="Cert number"
            value={draft.certNumber}
            onChange={(event) => {
              onChange({ certNumber: event.target.value })
            }}
          />
          <TextField
            label="Manual value (NOK)"
            inputMode="decimal"
            value={draft.manualValue}
            onChange={(event) => {
              onChange({ manualValue: event.target.value })
            }}
            placeholder="Optional"
          />
        </div>
      ) : (
        <SelectField
          label="Condition"
          value={draft.condition}
          onChange={(event) => {
            onChange({ condition: event.target.value as CardCondition })
          }}
        >
          {CONDITIONS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </SelectField>
      )}

      {locations.data && locations.data.length > 0 ? (
        <SelectField
          label="Storage location"
          value={draft.storageLocationId}
          onChange={(event) => {
            onChange({ storageLocationId: event.target.value })
          }}
        >
          <option value="">Unassigned</option>
          {locations.data.map((location) => (
            <option key={location.id} value={location.id}>
              {location.name}
            </option>
          ))}
        </SelectField>
      ) : null}
    </div>
  )
}

function SealedLineFields({
  draft,
  onChange,
}: {
  draft: LineDraft
  onChange: (patch: Partial<LineDraft>) => void
}) {
  const products = useQuery({ queryKey: ['sealed-products'], queryFn: listSealedProducts })
  return (
    <SelectField
      label="Sealed product"
      value={draft.sealedProductId ?? ''}
      onChange={(event) => {
        onChange({ sealedProductId: event.target.value || null })
      }}
    >
      <option value="" disabled>
        Choose a product
      </option>
      {(products.data ?? []).map((product) => (
        <option key={product.id} value={product.id}>
          {product.name} ({product.language})
        </option>
      ))}
    </SelectField>
  )
}

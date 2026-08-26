import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { CardCondition } from '../../data/collection'
import { getCardVariants, searchCards, type CatalogSearchResult } from '../../data/catalog'
import { CardImage } from '../catalog/CardImage'
import { Button, ChoiceGroup, FormMessage, TextField } from '../../ui/form'
import { Sheet } from '../../ui/Sheet'
import { CONDITION_LABEL, FINISH_LABEL } from '../collection/labels'
import type { PullDraft } from './draft'
import { PULL_COST_NOTE } from './copy'

const CONDITIONS: CardCondition[] = ['MT', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO']

/**
 * The pull-entry sheet (prompt §10): search the shared catalog, tap a result, pick the printing
 * where several exist, set quantity, Add — and the sheet stays open for the next card so a stack
 * of commons costs a few taps each. A full-page navigation cycle per common card would make
 * hits-only tracking of a booster box miserable on a phone; this is the same pattern Search's
 * per-result quick-add already established.
 *
 * Manual cards are reachable here (prompt §11): an energy, a promo the catalog lacks, or any card
 * without market pricing is legitimate inventory — the pull needs no price to be valid.
 *
 * No scanner button: M15 owns that entry point, and a dead control is worse than none (prompt §10).
 */
export function PullPickerSheet({
  open,
  onClose,
  onAdd,
}: {
  open: boolean
  onClose: () => void
  onAdd: (pull: Omit<PullDraft, 'key' | 'quantity'>, quantity: number) => void
}) {
  const [query, setQuery] = useState('')
  const [selectedCard, setSelectedCard] = useState<CatalogSearchResult | null>(null)
  const [manualMode, setManualMode] = useState(false)

  function resetAndClose() {
    setQuery('')
    setSelectedCard(null)
    setManualMode(false)
    onClose()
  }

  return (
    <Sheet open={open} onClose={resetAndClose} title="Add pulled card">
      {manualMode ? (
        <ManualPullForm
          onCancel={() => {
            setManualMode(false)
          }}
          onAdd={(pull, quantity) => {
            onAdd(pull, quantity)
            setManualMode(false)
          }}
        />
      ) : selectedCard ? (
        <VariantPullForm
          card={selectedCard}
          onBack={() => {
            setSelectedCard(null)
          }}
          onAdd={(pull, quantity) => {
            onAdd(pull, quantity)
            setSelectedCard(null)
            setQuery('')
          }}
        />
      ) : (
        <div className="space-y-3">
          <input
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
            }}
            placeholder="Search for cards…"
            aria-label="Search for cards"
            className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus-visible:border-sky-500"
          />
          <CatalogResults
            query={query}
            onPick={(card) => {
              setSelectedCard(card)
            }}
          />
          <button
            type="button"
            onClick={() => {
              setManualMode(true)
            }}
            className="min-h-11 w-full rounded-lg border border-dashed border-slate-700 text-sm font-medium text-slate-300 hover:bg-slate-800/40"
          >
            Card not in the catalog? Add it manually
          </button>
          <p className="text-xs text-slate-500">{PULL_COST_NOTE}</p>
        </div>
      )}
    </Sheet>
  )
}

function CatalogResults({
  query,
  onPick,
}: {
  query: string
  onPick: (card: CatalogSearchResult) => void
}) {
  const results = useQuery({
    queryKey: ['opening-pull-search', query],
    queryFn: () => searchCards({ query, language: null, limit: 20 }),
    enabled: query.trim().length > 0,
  })

  if (query.trim() === '') {
    return <p className="p-3 text-sm text-slate-500">Start typing to search the catalog.</p>
  }
  if (results.isPending) {
    return <div className="h-16 animate-pulse rounded-lg bg-slate-800/60" />
  }
  if (results.isError) {
    return (
      <p role="alert" className="text-sm text-rose-300">
        The catalog could not be searched right now.
      </p>
    )
  }
  const list = results.data.results
  if (list.length === 0) {
    return (
      <div className="space-y-1 p-3">
        <p className="text-sm text-slate-500">No catalog cards match.</p>
        <p className="text-xs text-slate-500">
          You can still record the pull — add it manually below.
        </p>
      </div>
    )
  }
  return (
    <div className="max-h-80 space-y-1 overflow-y-auto">
      {list.map((card) => (
        <button
          key={card.cardId}
          type="button"
          onClick={() => {
            onPick(card)
          }}
          className="flex min-h-14 w-full items-center gap-3 rounded-lg border border-slate-800 px-3 py-2 text-left hover:bg-slate-800/60"
        >
          <CardImage
            imageBaseUrl={card.imageBaseUrl}
            alt={card.name}
            quality="low"
            className="h-12 w-9 shrink-0"
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-slate-100">{card.name}</span>
            <span className="block truncate text-xs text-slate-500">
              {card.setName} · #{card.localId}
              {card.rarity ? ` · ${card.rarity}` : ''}
            </span>
          </span>
        </button>
      ))}
    </div>
  )
}

/** One card selected: choose the exact printing when several variants exist, then quantity. */
function VariantPullForm({
  card,
  onBack,
  onAdd,
}: {
  card: CatalogSearchResult
  onBack: () => void
  onAdd: (pull: Omit<PullDraft, 'key' | 'quantity'>, quantity: number) => void
}) {
  const variants = useQuery({
    queryKey: ['opening-pull-variants', card.cardId],
    queryFn: () => getCardVariants(card.cardId),
  })
  const [variantId, setVariantId] = useState<string | null>(null)
  const [condition, setCondition] = useState<CardCondition>('NM')
  const [quantity, setQuantity] = useState('1')

  const list = variants.data ?? []
  const activeVariants = list.filter((variant) => variant.isActive)
  const effectiveVariantId =
    variantId ?? (activeVariants.length === 1 ? (activeVariants[0]?.id ?? null) : null)
  const chosen = activeVariants.find((variant) => variant.id === effectiveVariantId) ?? null

  const parsedQuantity = Number.parseInt(quantity, 10)

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (!chosen || !Number.isFinite(parsedQuantity) || parsedQuantity < 1) return
        onAdd(
          {
            cardVariantId: chosen.id,
            manualCardId: null,
            manualIdentity: null,
            displayName: card.name,
            subtitle: `${card.setName} · #${card.localId}`,
            imageBaseUrl: card.imageBaseUrl,
            finishLabel: FINISH_LABEL[chosen.finish] ?? chosen.finish,
            condition,
          },
          parsedQuantity,
        )
      }}
      noValidate
    >
      <div className="flex items-center gap-3">
        <CardImage
          imageBaseUrl={card.imageBaseUrl}
          alt={card.name}
          quality="low"
          className="h-12 w-9 shrink-0"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-slate-100">{card.name}</p>
          <p className="truncate text-xs text-slate-500">
            {card.setName} · #{card.localId}
          </p>
        </div>
        <button
          type="button"
          onClick={onBack}
          className="shrink-0 text-xs text-sky-400 underline-offset-4 hover:underline"
        >
          Change
        </button>
      </div>

      {variants.isPending ? (
        <div className="h-10 animate-pulse rounded-lg bg-slate-800/60" />
      ) : activeVariants.length > 1 ? (
        <ChoiceGroup
          label="Printing"
          value={chosen?.id ?? ''}
          onChange={setVariantId}
          options={activeVariants.map(
            (variant) => [variant.id, FINISH_LABEL[variant.finish] ?? variant.finish] as const,
          )}
        />
      ) : null}

      <ChoiceGroup
        label="Condition"
        value={condition}
        onChange={setCondition}
        options={CONDITIONS.map((c) => [c, CONDITION_LABEL[c]] as const)}
      />

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

      {!chosen && !variants.isPending ? (
        <FormMessage tone="error">Choose which printing you pulled.</FormMessage>
      ) : null}

      <Button type="submit" disabled={!chosen}>
        Add pull
      </Button>
      <p className="text-xs text-slate-500">{PULL_COST_NOTE}</p>
    </form>
  )
}

/** The catalog-missing fallback (M6/D-037 path): identity is whatever the user can state, cost is
 *  structurally absent, and the pull resolves honestly to no value until one exists. */
function ManualPullForm({
  onAdd,
  onCancel,
}: {
  onAdd: (pull: Omit<PullDraft, 'key' | 'quantity'>, quantity: number) => void
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [setName_, setSetName] = useState('')
  const [collectorNumber, setCollectorNumber] = useState('')
  const [condition, setCondition] = useState<CardCondition>('NM')
  const [quantity, setQuantity] = useState('1')
  const [error, setError] = useState<string | null>(null)

  const parsedQuantity = Number.parseInt(quantity, 10)

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (name.trim() === '') {
          setError('Give the card a name.')
          return
        }
        if (!Number.isFinite(parsedQuantity) || parsedQuantity < 1) {
          setError('Enter a quantity of at least 1.')
          return
        }
        setError(null)
        onAdd(
          {
            cardVariantId: null,
            manualCardId: null,
            manualIdentity: {
              name: name.trim(),
              setName: setName_.trim() !== '' ? setName_.trim() : undefined,
              collectorNumber: collectorNumber.trim() !== '' ? collectorNumber.trim() : undefined,
            },
            displayName: name.trim(),
            subtitle:
              [setName_.trim(), collectorNumber.trim() ? `#${collectorNumber.trim()}` : null]
                .filter(Boolean)
                .join(' · ') || 'Manual entry',
            imageBaseUrl: null,
            finishLabel: null,
            condition,
          },
          parsedQuantity,
        )
      }}
      noValidate
    >
      <TextField
        label="Card name"
        value={name}
        onChange={(event) => {
          setName(event.target.value)
        }}
      />
      <div className="grid grid-cols-2 gap-3">
        <TextField
          label="Set"
          hint="Optional"
          value={setName_}
          onChange={(event) => {
            setSetName(event.target.value)
          }}
        />
        <TextField
          label="Collector number"
          hint="Optional"
          value={collectorNumber}
          onChange={(event) => {
            setCollectorNumber(event.target.value)
          }}
        />
      </div>
      <ChoiceGroup
        label="Condition"
        value={condition}
        onChange={setCondition}
        options={CONDITIONS.map((c) => [c, CONDITION_LABEL[c]] as const)}
      />
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
      {error ? <FormMessage tone="error">{error}</FormMessage> : null}
      <p className="text-xs text-slate-500">
        Recorded as your own catalog entry. It has no purchase cost — it belongs to this opening.
      </p>
      <div className="flex gap-2">
        <Button type="button" variant="quiet" onClick={onCancel}>
          Back to search
        </Button>
        <Button type="submit">Add pull</Button>
      </div>
    </form>
  )
}

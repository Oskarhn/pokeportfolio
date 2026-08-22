import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  setSealedLotIntent,
  SEALED_INTENT_LABEL,
  type AcquisitionLot,
  type SealedIntent,
} from '../../data/collection'
import { Sheet } from '../../ui/Sheet'
import { Button, ChoiceGroup, FormMessage, TextField } from '../../ui/form'

const INTENTS: SealedIntent[] = ['keep_sealed', 'planned_to_open', 'undecided']

/**
 * Per-lot "Change intent" (M11 prompt §56-60). Organisational only — never touches cost basis,
 * spend, quantity or market value, and never opens anything (that workflow is M16). Defaults to
 * changing the lot's whole remaining quantity; the optional stepper lets the owner split off just
 * part of it, mirroring what set_sealed_lot_intent already does server-side for a partial change.
 */
export function SealedIntentSheet({
  open,
  onClose,
  holdingId,
  lot,
}: {
  open: boolean
  onClose: () => void
  holdingId: string
  lot: AcquisitionLot
}) {
  const queryClient = useQueryClient()
  const [intent, setIntent] = useState<SealedIntent>(lot.sealedIntent ?? 'undecided')
  const [quantity, setQuantity] = useState(String(lot.quantityRemaining))
  const [error, setError] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: (qty: number) =>
      setSealedLotIntent({
        lotId: lot.id,
        intent,
        quantity: qty === lot.quantityRemaining ? undefined : qty,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['holding-lots', holdingId] })
      await queryClient.invalidateQueries({ queryKey: ['holding-summary', holdingId] })
      await queryClient.invalidateQueries({ queryKey: ['portfolio'] })
      await queryClient.invalidateQueries({ queryKey: ['portfolio-counts'] })
      onClose()
    },
    onError: (mutationError: Error) => {
      setError(mutationError.message)
    },
  })

  return (
    <Sheet open={open} onClose={onClose} title="Change intent">
      <div className="space-y-4">
        <p className="text-xs text-slate-500">
          Organisational only — this never opens anything, and never changes cost or value. ×
          {lot.quantityRemaining} remaining in this lot.
        </p>
        <ChoiceGroup
          label="New intent"
          value={intent}
          onChange={setIntent}
          options={INTENTS.map((i) => [i, SEALED_INTENT_LABEL[i]] as const)}
        />
        {lot.quantityRemaining > 1 ? (
          <TextField
            label="Quantity to change"
            type="number"
            inputMode="numeric"
            min={1}
            max={lot.quantityRemaining}
            value={quantity}
            onChange={(event) => {
              setQuantity(event.target.value)
            }}
            hint={`Up to ${lot.quantityRemaining} — the rest keeps its current intent.`}
          />
        ) : null}
        {error ? <FormMessage tone="error">{error}</FormMessage> : null}
        <Button
          type="button"
          disabled={mutation.isPending}
          onClick={() => {
            setError(null)
            const qty = Number.parseInt(quantity, 10)
            if (!Number.isFinite(qty) || qty <= 0 || qty > lot.quantityRemaining) {
              setError(`Enter a quantity between 1 and ${lot.quantityRemaining}.`)
              return
            }
            mutation.mutate(qty)
          }}
        >
          {mutation.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </Sheet>
  )
}

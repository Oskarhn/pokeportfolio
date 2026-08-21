import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useMutation } from '@tanstack/react-query'
import { createManualCard } from '../../data/collection'
import { Button, FormMessage, TextField } from '../../ui/form'

/** The honest fallback when the shared catalog does not (yet) have a physical card the owner
 *  holds (M6 prompt §16-19, D-017). Deliberately thin: only what identifies the item — no fake
 *  provider id, no guessed rarity, no invented price, no image requirement. */
export function ManualCardPage() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [setName_, setSetName] = useState('')
  const [collectorNumber, setCollectorNumber] = useState('')
  const [language, setLanguage] = useState('')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null)

  const createMutation = useMutation({
    mutationFn: createManualCard,
    onSuccess: async (card) => {
      await navigate({ to: '/add', search: { manualCardId: card.id } })
    },
  })

  async function handleSubmit() {
    setError(null)
    if (name.trim() === '') {
      setError('Enter the card name.')
      return
    }
    try {
      await createMutation.mutateAsync({
        name: name.trim(),
        setName: setName_.trim() || undefined,
        collectorNumber: collectorNumber.trim() || undefined,
        language: language.trim() || undefined,
        notes: notes.trim() || undefined,
      })
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : 'Could not save this card.')
    }
  }

  return (
    <div className="mx-auto w-full max-w-md space-y-6 py-2">
      <header className="space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-100">
          Add a card manually
        </h1>
        <p className="text-sm text-slate-400">
          For a physical card the catalog doesn't have yet. Only what identifies it — no price, no
          image required. Private to your account.
        </p>
      </header>

      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          void handleSubmit()
        }}
        noValidate
      >
        <TextField
          label="Card name"
          required
          value={name}
          onChange={(event) => {
            setName(event.target.value)
          }}
        />
        <TextField
          label="Set or product name"
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
        <TextField
          label="Language"
          hint="Optional, e.g. English or Japanese"
          value={language}
          onChange={(event) => {
            setLanguage(event.target.value)
          }}
        />
        <TextField
          label="Notes"
          hint="Optional"
          value={notes}
          onChange={(event) => {
            setNotes(event.target.value)
          }}
        />
        {error ? <FormMessage tone="error">{error}</FormMessage> : null}
        <Button type="submit" disabled={createMutation.isPending}>
          {createMutation.isPending ? 'Saving…' : 'Continue'}
        </Button>
      </form>
    </div>
  )
}

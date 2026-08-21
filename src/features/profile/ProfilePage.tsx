import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../../auth/useAuth'
import {
  getMyProfile,
  updateMyProfile,
  type Profile,
  type ThemePreference,
} from '../../data/profile'
import { Button, FormMessage, TextField } from '../../ui/form'
import { formatNokMinor, parseNokInput } from '../../ui/money-format'
import { ProfileIcon } from '../../ui/icons'

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

/**
 * Profile: the account-identity bottom-nav destination (M7 prompt §20/§68/§90). Real account
 * information only — display name, email, admin badge, Portfolio display defaults, sign out. No
 * public username, no social profile, no internal UUID or technical Supabase detail (this stays a
 * private, invite-only app).
 */
export function ProfilePage() {
  const { email, isAdmin, signOut } = useAuth()
  const profile = useQuery({ queryKey: ['my-profile'], queryFn: getMyProfile })

  return (
    <div className="mx-auto w-full max-w-md space-y-6 py-2">
      <header className="flex items-center gap-3">
        <div className="flex size-12 items-center justify-center rounded-full bg-slate-800 text-slate-400">
          <ProfileIcon className="size-6" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-100">Profile</h1>
          <p className="text-sm text-slate-400">
            {email}
            {isAdmin ? ' · Administrator' : ''}
          </p>
        </div>
      </header>

      {profile.isPending ? (
        <div className="h-64 w-full animate-pulse rounded-lg bg-slate-800/60" />
      ) : profile.isError ? (
        <p role="alert" className="text-sm text-rose-300">
          Your profile could not be loaded.
        </p>
      ) : (
        // Keyed on id (stable once loaded) so this form's local input state initializes once from
        // the loaded profile and is never forcibly reset by a background refetch while the user is
        // typing — the alternative, syncing via a useEffect + setState on every profile.data
        // change, is the exact cascading-render pattern React's own hooks lint now flags.
        <ProfileForm key={profile.data.id} profile={profile.data} />
      )}

      <Button
        type="button"
        variant="quiet"
        onClick={() => {
          void signOut()
        }}
      >
        Sign out
      </Button>
    </div>
  )
}

function ProfileForm({ profile }: { profile: Profile }) {
  const queryClient = useQueryClient()
  const [displayName, setDisplayName] = useState(profile.displayName ?? '')
  const [nameSaved, setNameSaved] = useState(false)
  const [thresholdInput, setThresholdInput] = useState(
    formatNokMinor(profile.lowValueThresholdMinor),
  )
  const [thresholdError, setThresholdError] = useState<string | null>(null)

  const saveMutation = useMutation({
    mutationFn: updateMyProfile,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['my-profile'] })
    },
  })

  return (
    <>
      <section className="space-y-3 rounded-lg border border-slate-800 p-4">
        <h2 className="text-sm font-semibold text-slate-300">Display name</h2>
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            setNameSaved(false)
            const trimmed = displayName.trim().slice(0, 60)
            saveMutation.mutate(
              { displayName: trimmed || null },
              {
                onSuccess: () => {
                  setNameSaved(true)
                },
              },
            )
          }}
        >
          <TextField
            label="Name"
            hint="Shown only to you"
            value={displayName}
            maxLength={60}
            onChange={(event) => {
              setDisplayName(event.target.value)
              setNameSaved(false)
            }}
          />
          <Button
            type="submit"
            variant="quiet"
            className="w-auto shrink-0"
            disabled={saveMutation.isPending}
          >
            Save
          </Button>
        </form>
        {nameSaved ? <FormMessage tone="success">Saved.</FormMessage> : null}
      </section>

      <section className="space-y-3 rounded-lg border border-slate-800 p-4">
        <h2 className="text-sm font-semibold text-slate-300">Theme</h2>
        <div className="flex gap-2">
          {THEME_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={profile.theme === option.value}
              onClick={() => {
                saveMutation.mutate({ theme: option.value })
              }}
              className={`min-h-9 flex-1 rounded-lg border text-sm font-medium ${
                profile.theme === option.value
                  ? 'border-sky-500 bg-sky-600/20 text-sky-200'
                  : 'border-slate-700 text-slate-300 hover:bg-slate-800'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </section>

      <section className="space-y-3 rounded-lg border border-slate-800 p-4">
        <h2 className="text-sm font-semibold text-slate-300">Low-value threshold</h2>
        <p className="text-xs text-slate-500">
          Cards at or under this value can be filtered out of the default Portfolio view.
        </p>
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            setThresholdError(null)
            try {
              const minor = parseNokInput(thresholdInput)
              saveMutation.mutate({ lowValueThresholdMinor: minor })
            } catch {
              setThresholdError('Enter a valid amount.')
            }
          }}
        >
          <TextField
            label="Threshold (NOK)"
            inputMode="decimal"
            value={thresholdInput}
            onChange={(event) => {
              setThresholdInput(event.target.value)
            }}
          />
          <Button
            type="submit"
            variant="quiet"
            className="w-auto shrink-0"
            disabled={saveMutation.isPending}
          >
            Save
          </Button>
        </form>
        {thresholdError ? <FormMessage tone="error">{thresholdError}</FormMessage> : null}
      </section>
    </>
  )
}

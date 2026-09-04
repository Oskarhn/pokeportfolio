import { useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../../auth/useAuth'
import {
  getMyProfile,
  updateMyProfile,
  type Profile,
  type ThemePreference,
  type CollectionView,
} from '../../data/profile'
import { getPortfolioCounts } from '../../data/portfolio'
import { readLastReminderMark, shouldRemindExport } from '../../domain/export/export-reminder'
import { resetMyPortfolioData } from '../../data/reset'
import { Button, FormMessage, TextField } from '../../ui/form'
import { formatNokMinor, parseNokInput } from '../../ui/money-format'
import { applyTheme } from '../../ui/theme'
import { MoneyDisplay } from '../../ui/MoneyDisplay'
import { Sheet } from '../../ui/Sheet'
import {
  ProfileIcon,
  PencilIcon,
  ShieldIcon,
  GlobeIcon,
  GridIcon,
  ListIcon,
  TableIcon,
  DownloadIcon,
  ChevronDownIcon,
} from '../../ui/icons'

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

const VIEW_OPTIONS: { value: CollectionView; label: string; icon: typeof GridIcon }[] = [
  { value: 'grid', label: 'Grid', icon: GridIcon },
  { value: 'list', label: 'List', icon: ListIcon },
  { value: 'table', label: 'Table', icon: TableIcon },
]

const LANGUAGE_OPTIONS: { value: string | null; label: string }[] = [
  { value: null, label: 'All' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: 'Japanese' },
]

/**
 * Profile: identity page and account/settings hub (M7.1 prompt §50-65, owner feedback pass —
 * supersedes M7's single flat form). More is gone; admin invitations live here now, visible to
 * admins only. Real fields only. Portfolio value and the Sealed stat are real as of M9/M11
 * (portfolio_counts) — Performance stats and profile-picture upload are either honestly
 * unavailable or, for the picture, deliberately deferred (see the note below).
 */
export function ProfilePage() {
  const { email, isAdmin, signOut } = useAuth()
  const profile = useQuery({ queryKey: ['my-profile'], queryFn: getMyProfile })
  const counts = useQuery({
    queryKey: ['portfolio-counts'],
    queryFn: () => getPortfolioCounts(),
  })
  // Periodic export reminder (PRODUCT_SPEC §4.12, D-079). Local-only timestamp; no collection
  // or financial data is ever read or stored here. Evaluated once per mount.
  const [remindExport] = useState(() =>
    shouldRemindExport(readLastReminderMark(window.localStorage), new Date()),
  )

  return (
    <div className="mx-auto w-full max-w-md space-y-6 py-2">
      <h1 className="sr-only">Profile</h1>

      <header className="flex items-center gap-3">
        <div className="flex size-14 items-center justify-center rounded-full bg-slate-800 text-slate-400">
          <ProfileIcon className="size-7" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-lg font-semibold text-slate-100">
            {profile.data?.displayName || 'Unnamed'}
          </p>
          <p className="truncate text-sm text-slate-400">{email}</p>
          {isAdmin ? (
            <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-sky-600/20 px-2 py-0.5 text-[11px] font-medium text-sky-300">
              <ShieldIcon className="size-3" />
              Administrator
            </span>
          ) : null}
        </div>
      </header>

      <section className="grid grid-cols-2 gap-3">
        <StatTile label="Cards" value={counts.data?.physicalCardCount} />
        <StatTile label="Graded" value={counts.data?.gradedCount} />
        <StatTile label="Sealed units" value={counts.data?.sealedUnitCount} wide />
      </section>
      <div className="-mt-3 space-y-1 rounded-xl border border-dashed border-slate-800 p-3 text-xs text-slate-500">
        <div className="flex items-center justify-between">
          <span>Portfolio value</span>
          <MoneyDisplay
            state={counts.data && counts.data.pricedHoldingCount > 0 ? 'known' : 'missing'}
            minorUnits={counts.data?.portfolioValueMinor}
            size="sm"
            hidden={profile.data?.hideValues ?? false}
          />
        </div>
        {counts.data && counts.data.sealedHoldingCount > 0 ? (
          <p>
            {profile.data?.hideValues ? (
              <span aria-label="Value hidden">Cards •••• · Sealed ••••</span>
            ) : (
              <>
                Cards {formatNokMinor(counts.data.cardsValueMinor)} NOK · Sealed{' '}
                {formatNokMinor(counts.data.sealedValueMinor)} NOK
              </>
            )}
            {counts.data.sealedUnpricedHoldingCount > 0
              ? ` · ${counts.data.sealedUnpricedHoldingCount} sealed without a valuation`
              : ''}
          </p>
        ) : null}
      </div>

      {profile.isPending ? (
        <div className="h-64 w-full animate-pulse rounded-xl bg-slate-800/60" />
      ) : profile.isError ? (
        <p role="alert" className="text-sm text-rose-300">
          Your profile could not be loaded.
        </p>
      ) : (
        // Keyed on id (stable once loaded) so this form's local input state initializes once from
        // the loaded profile and is never forcibly reset by a background refetch while the user is
        // typing.
        <ProfileSettings key={profile.data.id} profile={profile.data} isAdmin={isAdmin} />
      )}

      <section className="space-y-2 rounded-2xl border border-slate-800 p-4">
        <h2 className="text-sm font-semibold text-slate-300">Data</h2>
        {remindExport ? (
          <p
            role="status"
            className="rounded-lg border border-dashed border-amber-900/60 bg-amber-950/30 p-3 text-xs leading-relaxed text-amber-100/90"
          >
            It may be a while since your last export. A fresh backup keeps your ledger safe — see{' '}
            <Link to="/profile/export" className="underline underline-offset-2">
              Export &amp; backup
            </Link>
            .
          </p>
        ) : null}
        <Link
          to="/profile/export"
          className="flex min-h-11 items-center justify-between gap-2 rounded-lg text-sm font-medium text-slate-200 hover:text-slate-100"
        >
          <span className="flex items-center gap-2">
            <DownloadIcon className="size-4" />
            Export &amp; backup
          </span>
          <ChevronDownIcon className="size-4 -rotate-90 text-slate-500" />
        </Link>
        <p className="text-xs text-slate-500">
          Download spreadsheet files or a full JSON backup of your Portfolio.
        </p>
      </section>

      <section className="space-y-2 rounded-2xl border border-slate-800 p-4">
        <h2 className="text-sm font-semibold text-slate-300">Account</h2>
        <Button
          type="button"
          variant="quiet"
          onClick={() => {
            void signOut()
          }}
        >
          Sign out
        </Button>
      </section>

      <DangerZone />

      <Footer />
    </div>
  )
}

function StatTile({
  label,
  value,
  wide = false,
}: {
  label: string
  value: number | undefined
  wide?: boolean
}) {
  return (
    <div className={`rounded-xl border border-slate-800 p-4 ${wide ? 'col-span-2' : ''}`}>
      <p className="text-2xl font-semibold tabular-nums text-slate-100">
        {value === undefined ? '—' : value.toLocaleString('nb-NO')}
      </p>
      <p className="text-xs text-slate-500">{label}</p>
    </div>
  )
}

function ProfileSettings({ profile, isAdmin }: { profile: Profile; isAdmin: boolean }) {
  const queryClient = useQueryClient()
  const [displayName, setDisplayName] = useState(profile.displayName ?? '')
  const [editingName, setEditingName] = useState(false)
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
      <section className="space-y-3 rounded-2xl border border-slate-800 p-4">
        <h2 className="text-sm font-semibold text-slate-300">Name</h2>
        {editingName ? (
          <form
            className="flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              const trimmed = displayName.trim().slice(0, 60)
              saveMutation.mutate(
                { displayName: trimmed || null },
                {
                  onSuccess: () => {
                    setEditingName(false)
                  },
                },
              )
            }}
          >
            <TextField
              label="Display name"
              hint="Shown only to you"
              value={displayName}
              maxLength={60}
              autoFocus
              onChange={(event) => {
                setDisplayName(event.target.value)
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
        ) : (
          <button
            type="button"
            onClick={() => {
              setEditingName(true)
            }}
            className="flex min-h-9 items-center gap-2 text-sm text-slate-300 hover:text-slate-100"
          >
            <PencilIcon className="size-4" />
            {profile.displayName || 'Add a display name'}
          </button>
        )}
      </section>

      <section className="space-y-4 rounded-2xl border border-slate-800 p-4">
        <h2 className="text-sm font-semibold text-slate-300">Settings</h2>

        <div className="space-y-1.5">
          <p className="text-xs font-medium text-slate-400">Theme</p>
          <div className="flex gap-2">
            {THEME_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={profile.theme === option.value}
                onClick={() => {
                  applyTheme(option.value)
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
        </div>

        <div className="space-y-1.5">
          <p className="text-xs font-medium text-slate-400">Default Portfolio view</p>
          <div className="flex gap-2">
            {VIEW_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={profile.collectionDefaultView === option.value}
                onClick={() => {
                  saveMutation.mutate({ collectionDefaultView: option.value })
                }}
                className={`flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border text-sm font-medium ${
                  profile.collectionDefaultView === option.value
                    ? 'border-sky-500 bg-sky-600/20 text-sky-200'
                    : 'border-slate-700 text-slate-300 hover:bg-slate-800'
                }`}
              >
                <option.icon className="size-4" />
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <p className="text-xs font-medium text-slate-400">Default density</p>
          <div className="flex gap-2">
            {[1, 2, 3, 4].map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={profile.collectionGridDensity === value}
                onClick={() => {
                  saveMutation.mutate({ collectionGridDensity: value })
                }}
                className={`min-h-9 flex-1 rounded-lg border text-sm font-medium ${
                  profile.collectionGridDensity === value
                    ? 'border-sky-500 bg-sky-600/20 text-sky-200'
                    : 'border-slate-700 text-slate-300 hover:bg-slate-800'
                }`}
              >
                {value}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <p className="text-xs font-medium text-slate-400">Preferred card language</p>
          <div className="flex gap-2">
            {LANGUAGE_OPTIONS.map((option) => (
              <button
                key={option.label}
                type="button"
                aria-pressed={profile.defaultLanguage === option.value}
                onClick={() => {
                  saveMutation.mutate({ defaultLanguage: option.value })
                }}
                className={`flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border text-sm font-medium ${
                  profile.defaultLanguage === option.value
                    ? 'border-sky-500 bg-sky-600/20 text-sky-200'
                    : 'border-slate-700 text-slate-300 hover:bg-slate-800'
                }`}
              >
                <GlobeIcon className="size-4" />
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <label className="flex min-h-9 cursor-pointer items-center justify-between gap-3 rounded-lg border border-slate-700 px-3 text-sm">
          <span className="text-slate-200">
            Use European pricing
            <span className="block text-xs font-normal text-slate-500">
              Prefer Cardmarket (EUR) over TCGplayer (USD) when both have a price
            </span>
          </span>
          <input
            type="checkbox"
            checked={profile.useEuPricing}
            onChange={(event) => {
              saveMutation.mutate({ useEuPricing: event.target.checked })
            }}
            className="size-5 accent-sky-600"
          />
        </label>

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
            label="Low-value threshold (NOK)"
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

      {isAdmin ? (
        <section className="rounded-2xl border border-slate-800 p-4">
          <Link
            to="/admin/invitations"
            className="flex min-h-9 items-center gap-2 text-sm font-medium text-slate-200 hover:text-slate-100"
          >
            <ShieldIcon className="size-4" />
            Manage invitations
          </Link>
        </section>
      ) : null}
    </>
  )
}

/**
 * Danger Zone (P43): the one deliberately destructive operation in the product. "Reset portfolio
 * data" clears owned inventory, purchases/spend, sales, acquisition history, openings and their
 * pulled-card records, valuations and the portfolio-history cache in ONE atomic server call —
 * while preserving the account, settings and reusable setup metadata (retailers, storage
 * locations, tags, collection definitions, manual cards, own sealed products). DECISIONS.md
 * D-084: this full reset is the only place permanent deletion of tracking data is intentional;
 * everything else corrects through the void lifecycle.
 *
 * The confirmation states both sides plainly (what goes, what stays), disables while running and
 * keeps any error visible. On success every user-data query is invalidated and Home shows the
 * honest empty state.
 */
function DangerZone() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const resetMutation = useMutation({
    mutationFn: resetMyPortfolioData,
    onSuccess: async () => {
      setConfirmOpen(false)
      // Every user-data query is now stale by definition — invalidate all of them.
      await queryClient.invalidateQueries()
      await navigate({ to: '/' })
    },
    onError: (mutationError: Error) => {
      setError(mutationError.message)
    },
  })

  return (
    <section className="space-y-2 rounded-2xl border border-rose-900/50 p-4">
      <h2 className="text-sm font-semibold text-rose-300">Danger zone</h2>
      <p className="text-xs text-slate-500">
        Erase your tracked portfolio and start over. Your account is not affected.
      </p>
      <Button
        type="button"
        variant="quiet"
        className="border border-rose-900/60 text-rose-300 hover:bg-rose-950/40"
        onClick={() => {
          setError(null)
          setConfirmOpen(true)
        }}
      >
        Reset portfolio data
      </Button>

      <Sheet
        open={confirmOpen}
        onClose={() => {
          if (!resetMutation.isPending) setConfirmOpen(false)
        }}
        title="Reset your portfolio data?"
      >
        <div className="space-y-3">
          <p className="text-sm text-slate-300">Are you sure? This cannot be undone.</p>
          <div className="rounded-lg border border-rose-900/40 p-3 text-xs text-slate-400">
            <p className="font-medium text-rose-300">This permanently removes:</p>
            <ul className="mt-1 list-inside list-disc space-y-0.5">
              <li>All tracked cards, graded cards and sealed products</li>
              <li>Openings and their pulled-card records</li>
              <li>All purchases and spending records</li>
              <li>All sales and realized results</li>
              <li>Acquisition history and manual valuations</li>
              <li>Your portfolio value history</li>
            </ul>
          </div>
          <div className="rounded-lg border border-slate-800 p-3 text-xs text-slate-400">
            <p className="font-medium text-slate-300">This keeps:</p>
            <ul className="mt-1 list-inside list-disc space-y-0.5">
              <li>Your account, sign-in and settings</li>
              <li>Admin access (administrators only)</li>
              <li>Retailers, storage locations, tags and collections</li>
              <li>Your manual card definitions and sealed product definitions</li>
            </ul>
            <p className="mt-1 text-slate-500">Collections are kept but become empty.</p>
          </div>
          {error ? <FormMessage tone="error">{error}</FormMessage> : null}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="quiet"
              disabled={resetMutation.isPending}
              onClick={() => {
                setConfirmOpen(false)
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              className="border border-rose-900/60 bg-rose-900/80 hover:bg-rose-800"
              disabled={resetMutation.isPending}
              onClick={() => {
                setError(null)
                resetMutation.mutate()
              }}
            >
              {resetMutation.isPending ? 'Resetting…' : 'Yes, reset portfolio'}
            </Button>
          </div>
        </div>
      </Sheet>
    </section>
  )
}

/**
 * Factual provider attribution (API_SOURCES.md — the obligation that document already commits
 * this footer to honour) and a real app-version string sourced from package.json at build time
 * (M7.1 prompt §65), not an invented example number.
 */
function Footer() {
  return (
    <footer className="space-y-2 border-t border-slate-800 pt-4 text-xs text-slate-500">
      <p>
        Card data and images from TCGdex. Price data from Cardmarket and TCGplayer, via TCGdex.
        Exchange rates from Norges Bank.
      </p>
      <p>
        PokePortfolio is unofficial and unaffiliated with The Pokémon Company, Nintendo, Creatures
        or GAME FREAK.
      </p>
      <p className="flex flex-wrap gap-x-3">
        <Link to="/privacy" className="hover:text-slate-300 hover:underline">
          Privacy
        </Link>
        <Link to="/terms" className="hover:text-slate-300 hover:underline">
          Terms
        </Link>
        <Link to="/faq" className="hover:text-slate-300 hover:underline">
          FAQ
        </Link>
      </p>
      <p>v{__APP_VERSION__}</p>
    </footer>
  )
}

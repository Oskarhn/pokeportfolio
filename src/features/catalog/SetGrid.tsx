import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { listRecentSets, type CatalogSet } from '../../data/catalog'
import { chooseSetVisual, initialsFor } from './set-visuals'

/**
 * Search's set-browsing grid (P27 owner feedback), replacing M7.1's horizontal carousel: the
 * owner scrolls DOWN through sets, tiles are larger, and Japanese sets are never showcased.
 *
 * English-only is a product decision enforced at the data layer — `listRecentSets` filters on
 * the catalog's own structured `language` column (written from TCGdex's language-specific
 * endpoint path at ingest), never on title matching. The Search page's separate language chips
 * keep governing card/set text search; this showcase ignores them by design.
 *
 * All 200+ English sets arrive in ONE bounded table read (no per-tile requests). Rendering is
 * incremental — an initial slice plus a "Show more" control — so the page never mounts thousands
 * of DOM nodes at once, while normal vertical scrolling stays the primary interaction. Images
 * lazy-load and degrade to a neutral initials tile on failure; a broken asset never crashes the
 * route and never re-requests its URL.
 */

/** Product decision (owner, P27): the showcase contains English sets only. */
const SHOWCASE_LANGUAGE = 'en' as const

/** One bounded read of the whole English set list (218 rows in the live TCGdex en catalog,
 *  probed 2026-08-24) — comfortably above the real count, far below any page-size concern. */
const SHOWCASE_LIMIT = 300

const INITIAL_TILES = 24
const TILES_PER_STEP = 24

function SetTile({
  set,
  imageFailed,
  onImageError,
}: {
  set: CatalogSet
  imageFailed: boolean
  onImageError: (url: string) => void
}) {
  const visual = chooseSetVisual(set.logoUrl, set.symbolUrl, set.name)
  const imageUrl = visual.kind === 'image' ? (visual.url ?? null) : null
  const showImage = imageUrl !== null && !imageFailed
  const fallbackLabel = imageUrl === null ? visual.label : initialsFor(set.name)
  const meta = [
    set.releasedOn ? set.releasedOn.slice(0, 4) : null,
    set.cardCountOfficial ? `${set.cardCountOfficial} cards` : null,
  ]
    .filter((part) => part !== null)
    .join(' · ')

  return (
    <Link
      to="/catalog/sets/$setId"
      params={{ setId: set.id }}
      role="listitem"
      className="flex flex-col items-center gap-2 rounded-2xl border border-slate-800 bg-slate-900/60 p-3 text-center transition-colors hover:border-slate-600 hover:bg-slate-800/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/40"
    >
      <div className="flex h-16 w-full items-center justify-center sm:h-20">
        {showImage && imageUrl ? (
          <img
            src={imageUrl}
            alt=""
            loading="lazy"
            className="max-h-full max-w-full object-contain"
            onError={() => {
              onImageError(imageUrl)
            }}
          />
        ) : (
          <div
            aria-hidden
            className="flex h-full w-full items-center justify-center rounded-xl bg-slate-800 text-sm font-semibold tracking-wide text-slate-300"
          >
            {fallbackLabel}
          </div>
        )}
      </div>
      <span className="line-clamp-2 min-h-8 text-xs font-medium leading-tight text-slate-100 sm:text-sm">
        {set.name}
      </span>
      <span className="text-[11px] leading-none text-slate-500">{meta || '—'}</span>
    </Link>
  )
}

export function SetGrid() {
  const sets = useQuery({
    queryKey: ['catalog-recent-sets', SHOWCASE_LANGUAGE],
    queryFn: () => listRecentSets({ language: SHOWCASE_LANGUAGE, limit: SHOWCASE_LIMIT }),
  })
  const [visibleCount, setVisibleCount] = useState(INITIAL_TILES)
  const [failedUrls, setFailedUrls] = useState<ReadonlySet<string>>(new Set())

  const markFailed = (url: string) => {
    setFailedUrls((previous) => {
      if (previous.has(url)) return previous
      const next = new Set(previous)
      next.add(url)
      return next
    })
  }

  if (sets.isPending) {
    return (
      <div
        className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4"
        aria-busy="true"
        aria-label="Loading sets"
      >
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="h-40 animate-pulse rounded-2xl bg-slate-800/60" />
        ))}
      </div>
    )
  }

  // A failed showcase load is a visible, recoverable state with its own retry — never a silently
  // missing section and never a crashed route (P27 owner-reported transient failure class).
  if (sets.isError) {
    return (
      <div
        role="alert"
        className="rounded-xl border border-rose-900/60 bg-rose-950/40 p-3 text-sm text-rose-200"
      >
        <p>The set list could not be loaded.</p>
        <button
          type="button"
          onClick={() => {
            void sets.refetch()
          }}
          disabled={sets.isFetching}
          className="mt-2 min-h-9 rounded-lg border border-rose-800 px-3 font-medium hover:bg-rose-900/40 disabled:opacity-60"
        >
          {sets.isFetching ? 'Loading…' : 'Try again'}
        </button>
      </div>
    )
  }

  if (sets.data.length === 0) {
    return <p className="py-8 text-center text-sm text-slate-500">No sets in the catalog yet.</p>
  }

  const visible = sets.data.slice(0, visibleCount)
  const remaining = sets.data.length - visibleCount

  return (
    <div className="space-y-3">
      <div
        className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4"
        role="list"
        aria-label="Browse sets"
      >
        {visible.map((set) => {
          const displayUrl = set.logoUrl ?? set.symbolUrl
          return (
            <SetTile
              key={set.id}
              set={set}
              imageFailed={displayUrl !== null && failedUrls.has(displayUrl)}
              onImageError={markFailed}
            />
          )
        })}
      </div>
      {remaining > 0 ? (
        <button
          type="button"
          onClick={() => {
            setVisibleCount((count) => count + TILES_PER_STEP)
          }}
          className="min-h-11 w-full rounded-xl border border-slate-700 text-sm font-medium text-slate-200 hover:bg-slate-800"
        >
          Show more ({remaining} more sets)
        </button>
      ) : null}
    </div>
  )
}

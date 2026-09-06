import { useEffect } from 'react'

/**
 * Per-route `<title>`/meta management. There is no head-management library in this app (nothing
 * in package.json, index.html's single static `<title>` never changed per route before this) —
 * a `useEffect` mutating the DOM directly is the smallest correct fix and stays inside the CSP's
 * `script-src 'self'`, since it is bundle JS mutating the DOM, not a new inline `<script>` tag.
 *
 * `robots` defaults to `noindex, nofollow` — almost the entire app is private
 * (docs/PRODUCT_SPEC.md §1.1: "Not a public platform"), so a page has to opt into being indexable
 * rather than the other way around. Only the small public set (Privacy/Terms/FAQ) passes
 * `robots: 'index, follow'`.
 */
export interface DocumentMeta {
  title: string
  description?: string
  /** Defaults to `noindex, nofollow` — see module doc above. */
  robots?: string
  /** Absolute or root-relative canonical path. Only ever set on the small public page set —
   *  never on a route carrying a token, search params or auth state. */
  canonicalPath?: string
}

/** The safe baseline — matches index.html's static `<meta name="description">` and the
 *  noindex-by-default posture. A route that never calls this hook (almost every private route)
 *  relies on index.html carrying this same default directly, so the two must be kept in sync. */
const DEFAULT_ROBOTS = 'noindex, nofollow'
const DEFAULT_DESCRIPTION =
  'PokePortfolio — a private Pokémon TCG collection and financial tracker.'

function setMetaContent(name: string, content: string): void {
  let el = document.head.querySelector(`meta[name="${name}"]`)
  if (!el) {
    el = document.createElement('meta')
    el.setAttribute('name', name)
    document.head.appendChild(el)
  }
  el.setAttribute('content', content)
}

export function useDocumentMeta({
  title,
  description,
  robots = DEFAULT_ROBOTS,
  canonicalPath,
}: DocumentMeta): void {
  useEffect(() => {
    const previousTitle = document.title
    document.title = `${title} · PokePortfolio`

    setMetaContent('robots', robots)
    if (description) {
      setMetaContent('description', description)
    }

    if (canonicalPath) {
      let canonicalEl = document.head.querySelector('link[rel="canonical"]')
      if (!canonicalEl) {
        canonicalEl = document.createElement('link')
        canonicalEl.setAttribute('rel', 'canonical')
        document.head.appendChild(canonicalEl)
      }
      canonicalEl.setAttribute('href', `${window.location.origin}${canonicalPath}`)
    }

    return () => {
      document.title = previousTitle
      // Most routes never call this hook at all, so there is no "previous value" to restore —
      // only a safe default to snap back to. Without this, navigating from a page that set
      // `index, follow` to one that never calls the hook would leave the whole rest of the
      // (private) app indexable.
      setMetaContent('robots', DEFAULT_ROBOTS)
      if (description) {
        setMetaContent('description', DEFAULT_DESCRIPTION)
      }
      // Canonical tags are only ever set by the small public pages that pass `canonicalPath`, so
      // it is safe to remove the tag entirely on unmount rather than trying to restore a previous
      // value — the next route that wants one will set it again.
      if (canonicalPath) {
        document.head.querySelector('link[rel="canonical"]')?.remove()
      }
    }
  }, [title, description, robots, canonicalPath])
}

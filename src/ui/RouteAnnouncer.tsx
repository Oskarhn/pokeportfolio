import { useEffect, useRef, useState } from 'react'
import { useRouterState } from '@tanstack/react-router'

const BASE_TITLE = 'PokePortfolio'

/**
 * Screen-reader and tab-title feedback for client-side navigation (P202).
 *
 * A single-page app swaps the view without a page load, so assistive technology hears nothing and
 * every private route kept the static document title. After each pathname change this announces
 * the new page's <h1> through a polite live region and, only when no page set a title of its own
 * (useDocumentMeta pages do), names the tab after that heading. It never moves focus: doing so
 * from a global hook would fight forms and the scanner, which manage their own focus.
 */
export function RouteAnnouncer() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const [message, setMessage] = useState('')
  const titledByUs = useRef(false)
  const first = useRef(true)

  useEffect(() => {
    if (titledByUs.current) {
      document.title = BASE_TITLE
      titledByUs.current = false
    }
    // The initial load is announced by the browser itself; only the tab title is set then.
    const announce = !first.current
    first.current = false
    // Let the destination route render (and lazy chunks resolve) before reading its heading.
    const timer = window.setTimeout(() => {
      const heading = document.querySelector('main h1')?.textContent.trim()
      if (!heading) return
      if (announce) setMessage(heading)
      if (document.title === BASE_TITLE) {
        document.title = `${heading} · ${BASE_TITLE}`
        titledByUs.current = true
      }
    }, 400)
    return () => {
      window.clearTimeout(timer)
    }
  }, [pathname])

  return (
    <p role="status" aria-live="polite" className="sr-only">
      {message}
    </p>
  )
}

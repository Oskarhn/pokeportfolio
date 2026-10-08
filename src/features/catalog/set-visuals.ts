/**
 * Which visual a Search set tile shows (P27): the logo when the set has one, otherwise its
 * symbol, otherwise a neutral initials tile. Pure logic, separate from the component file so
 * both fast-refresh and tests can import it without dragging JSX along. A missing or failed
 * upstream image resolves to a deliberate fallback here — never a browser broken-image icon.
 *
 * P197D: a logo URL the CDN fails to serve (3 of 154 live English logos 404 — Wizards Black Star
 * Promos, Undaunted, Furious Fists) now falls through to the symbol before the initials tile,
 * instead of dropping straight to initials while a working symbol exists.
 */

export interface SetVisualChoice {
  kind: 'image' | 'initials'
  url?: string
  label: string
}

export function initialsFor(name: string): string {
  const [firstWord = '', secondWord = ''] = name.trim().split(/\s+/)
  if (secondWord !== '') return (firstWord.charAt(0) + secondWord.charAt(0)).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

/** `failedUrls` are image URLs the browser already failed to load; they are skipped, never retried. */
export function chooseSetVisual(
  logoUrl: string | null,
  symbolUrl: string | null,
  name: string,
  failedUrls: ReadonlySet<string> = new Set(),
): SetVisualChoice {
  const url = [logoUrl, symbolUrl].find((candidate) => candidate && !failedUrls.has(candidate))
  if (!url) return { kind: 'initials', label: initialsFor(name) }
  return { kind: 'image', url, label: name }
}

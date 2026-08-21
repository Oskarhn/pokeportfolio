import type { ThemePreference } from '../data/profile'

/**
 * Applies a theme preference to the document and remembers it locally so the next load can apply
 * it before the profile has round-tripped from Supabase (Profile prompt §12/§61 — "must actually
 * work"). `system` removes the override entirely and lets `src/styles/index.css`'s
 * `prefers-color-scheme` block decide. Only `light`/`dark` set `data-theme`, matching the CSS
 * selectors in that file exactly.
 */
const STORAGE_KEY = 'pp-theme'

export function applyTheme(preference: ThemePreference): void {
  const root = document.documentElement
  if (preference === 'system') {
    root.removeAttribute('data-theme')
  } else {
    root.setAttribute('data-theme', preference)
  }
  try {
    localStorage.setItem(STORAGE_KEY, preference)
  } catch {
    // Private browsing / storage disabled: theme still applies for this load, just not
    // remembered for the next one. Not worth surfacing to the user.
  }
}

/** Read synchronously, before React or any network request, so the bootstrap script in
 *  index.html and this module agree on where the preference lives. */
export function readStoredThemePreference(): ThemePreference | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    if (value === 'light' || value === 'dark' || value === 'system') return value
    return null
  } catch {
    return null
  }
}

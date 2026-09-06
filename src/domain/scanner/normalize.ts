/**
 * Deterministic text normalization for scanner observations and catalog strings (P67 §6).
 *
 * Design rules:
 * - BOTH sides of every comparison (OCR observation and canonical catalog text) go through the
 *   same function, so the specific folding choices matter less than their consistency.
 * - Conservative about OCR confusions: digits and letters are NEVER swapped here. "0"→"O"
 *   style substitutions are context-sensitive and live only in the collector-number comparator,
 *   where the expected character class is known. A name like "P0kemon" stays distinct from
 *   "Pokemon" at this layer; edit distance handles the rest downstream.
 * - Accents fold ("é"→"e") because the catalog itself is inconsistent in the wild and OCR drops
 *   accents constantly; Pokémon special characters are handled explicitly.
 */

/** Nidoran's gender symbols are part of official card names ("Nidoran♀", "Nidoran♂"). They map
 *  to DISTINCT letters rather than being stripped: stripping would make two different cards
 *  normalize identically, which would fabricate an ambiguity that does not exist. */
const GENDER_SYMBOLS: Record<string, string> = { '♀': 'f', '♂': 'm' }

/** Typographic apostrophes fold to nothing so "Farfetch'd" and "Farfetchd" agree. */
const APOSTROPHES = /['\u2018\u2019\u02BC]/g

/** Dashes and separators become spaces so "Ho-Oh" compares as "ho oh". */
const SEPARATORS = /[-\u2013\u2014.:,·]/g

/** Anything that is not a letter, number or space after folding is OCR noise — dropped. */
const DISALLOWED = /[^\p{L}\p{N} ]/gu

const MULTI_SPACE = /\s+/g

export function normalizeCardText(input: string): string {
  const genderFolded = input.replace(/[♀♂]/g, (ch) => GENDER_SYMBOLS[ch] ?? ch)
  const decomposed = genderFolded.normalize('NFD').replace(/\p{M}/gu, '')
  return decomposed
    .toLowerCase()
    .replace(APOSTROPHES, '')
    .replace(SEPARATORS, ' ')
    .replace(DISALLOWED, '')
    .replace(MULTI_SPACE, ' ')
    .trim()
}

/**
 * Parses a free-text language hint into a catalog language, or null when unknown. Unknown hints
 * are absence of evidence, never a guess.
 */
export function parseLanguageHint(hint: string | null | undefined): 'en' | 'ja' | null {
  if (!hint) return null
  const normalized = hint.trim().toLowerCase()
  if (normalized === '') return null
  if (normalized === 'en' || normalized === 'english' || normalized === 'eng') return 'en'
  if (normalized === 'ja' || normalized === 'jp' || normalized === 'japanese') return 'ja'
  return null
}

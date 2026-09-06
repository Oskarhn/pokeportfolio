// Builds confusable groups from PUBLIC TCGdex metadata already present in the corpus manifest
// (name, setId) — no hosted-catalog access, so this approximates but does not replace the real
// F-03/§17/§18 benchmark against the committed 19,501-card index's actual UUIDs (that remains
// blocked on hosted Supabase credentials, the same standing gap every M15 session since P75 has
// disclosed). Grouping is by EXACT case/diacritic-normalized name across different setIds — this
// alone captures same-Pokemon-across-eras/reprints (Charizard appears in base1/base4/many others),
// same-Trainer-across-sets (Professor's Research, Ultra Ball), and Energy variants, since TCGdex
// gives no cheap access to evolution-family/illustrator/rarity metadata without one HTTP call per
// card (thousands of extra requests this lab does not spend against a free public API — disclosed
// limitation, not silently skipped).
function normalizeName(name) {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Returns Map<normalizedName, cardId[]> for every name shared by 2+ cards across DIFFERENT sets
 *  (same-set duplicates, e.g. reverse-holo variants sharing a name, are not what this measures —
 *  it is deliberately scoped to cross-printing confusability). */
export function buildConfusableGroups(corpusRows) {
  const bySet = new Map()
  for (const row of corpusRows) {
    const key = normalizeName(row.name)
    if (!bySet.has(key)) bySet.set(key, new Map())
    const setMap = bySet.get(key)
    if (!setMap.has(row.setId)) setMap.set(row.setId, [])
    setMap.get(row.setId).push(row.cardId)
  }

  const groups = new Map()
  for (const [key, setMap] of bySet) {
    if (setMap.size < 2) continue // same name must appear in 2+ DIFFERENT sets
    const cardIds = [...setMap.values()].flat()
    if (cardIds.length < 2) continue
    groups.set(key, cardIds)
  }
  return groups
}

/** cardId -> confusable group key, for O(1) lookup during benchmark scoring. */
export function buildCardToGroup(groups) {
  const map = new Map()
  for (const [key, cardIds] of groups) {
    for (const id of cardIds) map.set(id, key)
  }
  return map
}

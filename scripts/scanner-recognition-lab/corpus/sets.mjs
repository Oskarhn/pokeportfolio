// Curated English TCGdex set list for the P91 recognition R&D corpus. Chosen to span every era
// (vintage through current SV) plus sets that are deliberately reprint/confusable-heavy (Legendary
// Collection and Celebrations reprint classic Base Set artwork under new card ids; Crown Zenith
// Galarian Gallery and Hidden Fates Shiny Vault are alternate-art reprints of contemporaries; "151"
// revisits original-Kanto Pokémon that also appear in base1/base2) so same-Pokémon/same-art-
// different-printing groups exist for real, not by chance. Verified reachable against the live
// TCGdex API (`https://api.tcgdex.net/v2/en/sets`, 218 English sets, 2026-09-02).
export const CORPUS_SETS = [
  // vintage (complete WOTC era)
  { id: 'base1', name: 'Base Set' },
  { id: 'base2', name: 'Jungle' },
  { id: 'base3', name: 'Fossil' },
  { id: 'base4', name: 'Base Set 2' },
  { id: 'base5', name: 'Team Rocket' },
  // neo (complete)
  { id: 'neo1', name: 'Neo Genesis' },
  { id: 'neo2', name: 'Neo Discovery' },
  { id: 'neo3', name: 'Neo Revelation' },
  { id: 'neo4', name: 'Neo Destiny' },
  // e-card era sample
  { id: 'ecard1', name: 'Expedition Base Set' },
  // EX era sample
  { id: 'ex1', name: 'Ruby & Sapphire' },
  { id: 'ex6', name: 'FireRed & LeafGreen' },
  // Diamond & Pearl sample
  { id: 'dp1', name: 'Diamond & Pearl' },
  { id: 'dp6', name: 'Legends Awakened' },
  // Platinum / HGSS sample
  { id: 'pl1', name: 'Platinum' },
  { id: 'hgss1', name: 'HeartGold SoulSilver' },
  // Black & White sample
  { id: 'bw1', name: 'Black & White' },
  { id: 'bw11', name: 'Legendary Treasures' },
  // XY sample
  { id: 'xy1', name: 'XY' },
  { id: 'xy12', name: 'Evolutions' },
  // Sun & Moon sample
  { id: 'sm1', name: 'Sun & Moon' },
  { id: 'sm12', name: 'Cosmic Eclipse' },
  // Sword & Shield sample
  { id: 'swsh1', name: 'Sword & Shield' },
  { id: 'swsh7', name: 'Evolving Skies' },
  { id: 'swsh8', name: 'Fusion Strike' },
  // Scarlet & Violet sample
  { id: 'sv01', name: 'Scarlet & Violet' },
  { id: 'sv03.5', name: '151' },
  { id: 'sv08.5', name: 'Prismatic Evolutions' },
  // deliberately reprint/confusable-heavy sets
  { id: 'cel25', name: 'Celebrations' },
  { id: 'cel25cc', name: 'Celebrations Classic Collection' },
  { id: 'lc', name: 'Legendary Collection' },
  { id: 'swsh12.5gg', name: 'Crown Zenith Galarian Gallery' },
  { id: 'sma', name: 'Hidden Fates Shiny Vault' },
]

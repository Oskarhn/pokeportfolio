/**
 * Scanner domain barrel — pure matching logic between OCR/visual observations and the existing
 * canonical card identity. Zero dependencies on React, Supabase or any network layer
 * (docs/ARCHITECTURE.md §2). See ./README.md for the module map and invariants.
 */
export * from './types'
export * from './normalize'
export * from './edit-distance'
export * from './collector-number'
export * from './collector-compare'
export * from './name-similarity'
export * from './set-hint'
export * from './engine'

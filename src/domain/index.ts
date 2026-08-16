/**
 * Barrel export for the domain layer. Pure TypeScript, zero dependencies on
 * React or Supabase — see docs/ARCHITECTURE.md §2. No monetary arithmetic
 * belongs outside this directory.
 */
export * from './currency'
export * from './money'
export * from './decimal'
export * from './allocation'
export * from './fx'
export * from './cost-basis'
export * from './market-value'
export * from './inventory'
export * from './spending'
export * from './sales'
export * from './position'
export * from './errors'

/**
 * Resolution shim for the vendored P165 Price Check domain (./price-check/*.ts), whose files import
 * `../currency` exactly as they do in the web app. It re-exports the ONE shared domain module, so there is
 * no second copy of any money, currency or FX rule: src/domain/currency.ts is byte-identical on released
 * main (d8682e0) and on the P165 candidate (3d03eec).
 */
export * from '@shared/domain/currency'

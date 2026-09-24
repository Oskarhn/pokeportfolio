/**
 * Test stand-in for the web client singleton that shared `src/data/*` modules import as
 * `./supabase-client`. A test installs a fake with `setFakeSupabase`; using the client without one
 * throws, so no unit test can silently reach a network.
 */
let current: unknown = null

export function setFakeSupabase(fake: unknown): void {
  current = fake
}

export const supabase = new Proxy(
  {},
  {
    get(_target, property) {
      if (current === null) throw new Error('unit test used the Supabase client without a fake')
      const value = Reflect.get(current as object, property) as unknown
      return typeof value === 'function'
        ? ((value as (...args: unknown[]) => unknown).bind(current) as unknown)
        : value
    },
  },
) as never

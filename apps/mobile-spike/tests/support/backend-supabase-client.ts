/**
 * The client shared `src/data/*` modules use when the backend project runs: whichever REAL
 * supabase-js client the test installed (each test signs in as its own synthetic user).
 */
let current: unknown = null

export function setBackendClient(client: unknown): void {
  current = client
}

export const supabase = new Proxy(
  {},
  {
    get(_target, property) {
      if (current === null) throw new Error('backend test used the client before installing one')
      const value = Reflect.get(current as object, property) as unknown
      return typeof value === 'function'
        ? ((value as (...args: unknown[]) => unknown).bind(current) as unknown)
        : value
    },
  },
) as never

/**
 * Resolves the privileged database credential an Edge Function needs, preferring the current
 * Supabase secret-key mechanism over the legacy `service_role` JWT (docs/SECURITY.md §6).
 *
 * Background: an M5-session command (`supabase projects api-keys`) returned this project's full
 * key set, including the legacy secret, into a Claude session transcript — never used, stored or
 * committed, but treated as potentially exposed (docs/PROJECT_JOURNAL.md). M6 migrates the
 * project to the new `sb_publishable_…`/`sb_secret_…` keys and retires the legacy pair rather than
 * rotating the JWT signing secret, which would invalidate every existing user session for no
 * reason connected to the actual exposure.
 *
 * The platform injects `SUPABASE_SECRET_KEYS` as a JSON object once new-style keys exist for a
 * project — `{"default": "sb_secret_…"}`, one entry per named secret key, no redeploy required for
 * the injection itself. This falls back to the legacy `SUPABASE_SERVICE_ROLE_KEY` only when the
 * new variable is absent, which is the shape the *local* Supabase stack still emits — hosted
 * `pokeportfolio-dev` carries both once migrated, and this always prefers the new one when both
 * are present.
 */
export function resolveServiceRoleKey(): string | undefined {
  const secretKeys = Deno.env.get('SUPABASE_SECRET_KEYS')
  if (secretKeys) {
    try {
      const parsed = JSON.parse(secretKeys) as Record<string, string>
      const value = parsed.default ?? Object.values(parsed)[0]
      if (value) return value
    } catch {
      // Malformed value: fall through to the legacy variable rather than failing outright.
    }
  }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
}

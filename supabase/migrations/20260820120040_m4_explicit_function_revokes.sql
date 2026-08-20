-- M4 follow-up: revoke EXECUTE by naming the roles, never by revoking from PUBLIC alone.
--
-- Found by running the security verification against the real dev project rather than against CI.
-- The two disagreed, which is the more serious half of the finding.
--
-- WHAT HAPPENED. A Supabase project can carry an event trigger that grants the Data API roles
-- (`anon`, `authenticated`, `service_role`) EXECUTE on newly created public-schema functions —
-- the legacy `auto_expose_new_tables` behaviour. The local stack used by CI has it off, matching
-- the current cloud default; this project has it on. So on the remote, every function arrived with
-- an explicit grant to `anon` already attached.
--
-- `REVOKE EXECUTE ... FROM PUBLIC` does not remove that. It removes PUBLIC's implicit grant and
-- nothing else — a grant made to a named role has to be revoked from that named role. The M4
-- functions where the revoke listed `public, anon, authenticated` came out locked on both
-- environments; the ones where it listed only `public` came out locked on CI and reachable on the
-- remote.
--
-- IMPACT. Three functions were anon-callable on the remote that should not have been:
-- `is_admin()`, `hash_invitation_token(text)` and `card_condition_to_text(card_condition)`. None
-- of them discloses anything. `is_admin()` reads the caller's own row and returns false when there
-- is no caller; `hash_invitation_token` is a pure SHA-256 of the caller's own input, which anyone
-- can compute offline and which confirms nothing about whether a matching invitation exists;
-- `card_condition_to_text` is a cast. The trigger functions were never reachable at all, because
-- PostgREST does not expose functions returning `trigger`.
--
-- So: not a hole. But the deployed privilege surface did not match the intended one, and CI said
-- it did. That is the defect worth fixing — the next function to slip through this gap might not
-- be a pure computation.
--
-- THE FIX, in two parts. This migration names roles explicitly, so the result no longer depends on
-- a project-level setting. `supabase/config.toml` additionally pins `auto_expose_new_tables` off,
-- so the two environments stop diverging at the source. Either alone would do; both together mean
-- the guarantee does not rest on remembering to push config.
--
-- The rule this establishes, and the security checklist now names: revoke from
-- `public, anon, authenticated` and then grant back to exactly the roles that need it. Never
-- revoke from PUBLIC and assume.

-- ── Trigger functions: never callable, by anyone, through any API ────────────────────────────
revoke execute on function public.handle_new_user() from anon, authenticated;
revoke execute on function public.set_updated_at() from anon, authenticated;
revoke execute on function public.purchase_lines_check_owner() from anon, authenticated;
revoke execute on function public.acquisition_lots_check_owner() from anon, authenticated;
revoke execute on function public.enforce_invited_signup() from anon, authenticated;

-- ── Server-only helpers ──────────────────────────────────────────────────────────────────────
revoke execute on function public.hash_invitation_token(text) from anon, authenticated;

-- ── Session-callable, but never anonymously ──────────────────────────────────────────────────
-- is_admin() is read by the invitations policies and by the admin screen. The enum-to-text
-- wrappers are evaluated as part of the holdings_identity index expression on every write. All
-- three need `authenticated`; none has any business being reachable before sign-in.
revoke execute on function public.is_admin() from anon;
revoke execute on function public.card_condition_to_text(public.card_condition) from anon;
revoke execute on function public.grader_to_text(public.grader) from anon;
revoke execute on function public.create_invitation(text, int, text) from anon;
revoke execute on function public.revoke_invitation(uuid) from anon;

-- `invitation_status(text)` keeps its grant to `anon` deliberately: the invited person has no
-- account yet, and the 256-bit token in their link is the credential. See SECURITY.md §5.

-- ── Re-assert the intended grants ────────────────────────────────────────────────────────────
-- Stated positively as well as negatively, so this file reads as the whole intended surface
-- rather than a list of subtractions.
grant execute on function public.is_admin() to authenticated, service_role;
grant execute on function public.card_condition_to_text(public.card_condition) to authenticated, service_role;
grant execute on function public.grader_to_text(public.grader) to authenticated, service_role;
grant execute on function public.create_invitation(text, int, text) to authenticated;
grant execute on function public.revoke_invitation(uuid) to authenticated;
grant execute on function public.invitation_status(text) to anon, authenticated;
grant execute on function public.hash_invitation_token(text) to service_role;
grant execute on function public.claim_invitation(text) to service_role;
grant execute on function public.finalize_invitation_redemption(uuid, uuid) to service_role;
grant execute on function public.release_invitation_claim(uuid) to service_role;
grant execute on function public.before_user_created(jsonb) to supabase_auth_admin;

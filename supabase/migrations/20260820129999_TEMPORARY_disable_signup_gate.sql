-- TEMPORARY. Deliberate negative test of the M4 invite-only gate (docs/TESTING.md).
-- This migration must never reach main. It removes the S2 backstop so CI can demonstrate
-- that the invite-only attack suite actually fails when the gate regresses, rather than
-- being a set of assertions that would pass either way.
drop trigger enforce_invited_signup_before_insert on auth.users;

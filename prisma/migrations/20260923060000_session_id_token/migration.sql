-- feature-specs/09 D4 (amended 2026-09-23 after the first Keycloak run): the broker's id token is kept
-- on the session as the `id_token_hint` of RP-initiated logout; without it Keycloak asks the user to
-- confirm the sign-out on its own page. Additive.
ALTER TABLE "Session" ADD COLUMN "idToken" TEXT;

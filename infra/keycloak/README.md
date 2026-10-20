# Keycloak realm `harness-bible` (feature-specs/09 § 3)

`realm-harness-bible.json` is the realm as code: the only way a setting changes is a reviewed edit to this file. It is imported at start (`--import-realm`) in every environment; a nightly export in staging and production is diffed against it (09 § 8.9).

What it fixes: one confidential OIDC client `hb-web` (PKCE S256 required, one redirect URI, back-channel logout); Google and GitHub as the only identity providers (`trustEmail`, no chooser needed because the application sends `kc_idp_hint`); a browser flow with no username, password or OTP form; a first-broker-login flow that links a second provider to the existing user by verified e-mail; realm roles `reader` … `org_admin` mirrored into `User.role` at sign-in; the `hb` client scope with the `idp`, `hb_role`, `hb_verified` and `org` mappers; brute-force detection, user and admin events with a 90-day expiry, short tokens and a 30-day SSO session.

Two user attributes drive the claims: `hb_role` (one of the role names; set by an operator in Phase 1, by the org admin screen in Phase 4) and `identity_verified` (`true` after a contributor's verification). The realm role list mirrors them for Keycloak's own authorisation; the application reads `hb_role` (single-valued) first and falls back to `reader`.

## Secrets

Never in the file. Keycloak's file vault (`--vault file --vault-dir <dir>`) resolves `${vault.<key>}` where Keycloak supports a vault: the identity providers' client secrets. The file names are `harness-bible_<key>`:

| Vault key | Holds |
|---|---|
| `google-client-secret` | the Google OAuth client secret; redirect URI `<KEYCLOAK>/realms/harness-bible/broker/google/endpoint` |
| `github-client-secret` | the GitHub OAuth app secret; callback `<KEYCLOAK>/realms/harness-bible/broker/github/endpoint` |

The rest are `${env.NAME}` placeholders that `infra/keycloak/start.mjs` renders from the process environment before the import, because Keycloak's importer substitutes nothing inside URLs or client secrets (found 2026-09-23): `APP_URL` (the application's origin), `HB_WEB_CLIENT_SECRET` (the `hb-web` client secret, the same value as the application's `KEYCLOAK_CLIENT_SECRET`), `GOOGLE_CLIENT_ID`, `GITHUB_CLIENT_ID`. `npm run auth:kc` renders and starts; `npm run auth:kc:render` only renders, into `infra/keycloak/.rendered/` (git-ignored), for docker compose and CI. The rendered file is the one Keycloak reads; the checked-in file is the source.

## Development machine (no Docker)

1. A JDK 21 and the Keycloak 26 zip extracted to a folder; set `KEYCLOAK_HOME` to it.
2. Create the vault directory `infra/keycloak/vault/` (git-ignored) with the two files above (placeholders are fine until real provider credentials exist).
3. `npm run auth:kc` renders the realm into `$KEYCLOAK_HOME/data/import/` and starts `kc start-dev --http-port 8081 --import-realm --vault file --vault-dir infra/keycloak/vault` with `APP_URL`, `HB_WEB_CLIENT_SECRET` (from `KEYCLOAK_CLIENT_SECRET`), `GOOGLE_CLIENT_ID` and `GITHUB_CLIENT_ID` from the environment, defaulting to `dev-hb-web-secret` and `unset`; the bootstrap admin is `admin` / `admin` unless `KC_BOOTSTRAP_ADMIN_USERNAME` / `KC_BOOTSTRAP_ADMIN_PASSWORD` say otherwise. On Andre's machine: `JAVA_HOME=%USERPROFILE%\jdk21`, `KEYCLOAK_HOME=%USERPROFILE%\keycloak` (Keycloak 26.7.4).
4. `.env`: `KEYCLOAK_ISSUER=http://localhost:8081/realms/harness-bible`, `KEYCLOAK_CLIENT_ID=hb-web`, `KEYCLOAK_CLIENT_SECRET=dev-hb-web-secret` (or your own value, matched by `HB_WEB_CLIENT_SECRET`).
5. Without Google or GitHub credentials, `npm run auth:kc:fake` creates a second realm `fake-idp` with two password users (`reader@example.test` / `reader-pass-1`, `second@example.test` / `second-pass-2`) and points the `google` and `github` identity providers at it (generic OIDC, PKCE, in place: deleting and recreating a provider leaves Keycloak's user cache pointing at the old one and brokered users then fail their next sign-in), so the whole handshake runs locally. Idempotent.
6. `npm run auth:kc:walk` (with the dev server, OPA and the stand-in up) drives the handshake in a headless browser: sign-in through "Google" with the hint honoured, the account page, linking "GitHub", role mirroring from `hb_role` with the other browser's session revoked, RP-initiated sign-out without a confirmation page, a new sign-in asking for credentials again, and the admin logout reaching the back-channel route. `PW_CHANNEL=msedge` uses the installed Edge instead of Playwright's Chromium. 23 checks; exit code 1 on the first failure.

Without Keycloak the development provider (`AUTH_DEV_PROVIDER=1`, `GET /api/v1/auth/dev?email=`) signs the development reader in; every page works, only the handshake itself needs the broker.

Learned from the first run (2026-09-23): the realm file must embed the built-in scopes `basic`, `acr`, `email`, `profile`, `roles`, `web-origins` (a file that lists `clientScopes` gets no defaults, and `openid` is not a scope); the first-broker-login flow keeps only `idp-create-user-if-unique` (ALTERNATIVE) and a subflow with `idp-auto-link` (REQUIRED), because `idp-detect-existing-broker-user` after the create step fails the flow with `invalid_user_credentials`; RP-initiated logout needs `id_token_hint` to skip Keycloak's confirmation page, so the application keeps the id token on the session row (09 D4).

## CI and staging

`npm run auth:kc:render` then `docker compose up keycloak` runs `quay.io/keycloak/keycloak:26.4` with the rendered file and a vault directory mounted from CI secrets; the admin console listens on the private hostname only (`KC_HOSTNAME_ADMIN`). The CI job `keycloak-realm` renders and imports the realm into a fresh container and applies the stand-in realm; the browser walk (`npm run auth:kc:walk`) runs on the development machine until CI also hosts the application beside Keycloak.

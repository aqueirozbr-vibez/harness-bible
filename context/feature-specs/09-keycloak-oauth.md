# 09 · Keycloak, OAuth and the security backend — feature spec (identity broker, authorisation, protected URLs, controls)

Read `CLAUDE.md` and `context/ai-workflow-rules.md` before starting.

This spec has no screen. It is the backend behind `08-user-auth.md`'s pages and the security layer every later unit builds on. Governing context: `context/architecture.md` (§ 1 identity decision: Keycloak OIDC/SAML broker + a Next.js session; § 2.2 network zones: the web tier reaches Keycloak over HTTPS with an OIDC client secret from the vault and OPA as a localhost sidecar; § 3.4 API surface: every endpoint requires a session or bearer token unless marked public and passes OPA before touching data, one error body everywhere; § 5 auth and access model: roles, OPA with default deny, ownership, rate limits, secrets; § 9 threat model; § 11 invariants 23, 24, 29; § 10 test levels: contract, policy, integration), `context/code-standards.md` (§ API Routes: the fixed handler pipeline with no opt-out, status catalogue, idempotency, public endpoints listed explicitly; § Data: `process.env` only in `lib/env.ts`, secrets from the vault at boot, nothing logs them; middleware touches no data), `context/project-overview.md` (organisational accounts with SSO via Keycloak; individual accounts; tenant isolation; LGPD; the São Paulo region), TRD § 6.1 (route table), § 6.2 (authorisation flow), § 7.7 (login sequence), § 9 (observability and audit), § 11 (testing gates: Rego tests per role × action × class, contract tests for every endpoint, cross-tenant integration tests).

Prerequisite specs: `04-content-domain-schema.md` § 4 (the tenant guard), `05-reader-paths.md` § 5.1 (the `getSession()` seam), `07-bookmarks-notes.md` (the reader-state writes the endpoints wrap), `08-user-auth.md` (the sign-in, sign-out and account pages; § 4.2 cookies; § 5.2 sessions; § 5.3 identity resolution; § 5.5 actions; § 5.7 dev provider).

Scope: tracker units 21 and 22. Keycloak as the identity broker with Google and GitHub as its only identity providers (the sign-in stays "exclusively through SSO — Google or GitHub", as Andre stated on 2026-09-22, with Keycloak in front as the TRD requires); the OIDC client, token validation and session issuance behind spec 08; authorisation (roles, OPA, policies, tenant); the protected-URL matrix for pages, server actions and `/api/v1`; the handler pipeline with rate limits, idempotency, errors and tracing; and the security controls (headers, cookies, CSRF, secrets, audit events, hardening, CI checks). **Amends spec 08**: § 5.1 (providers are reached through Keycloak, not directly), § 5.3 step 6 (linking happens in Keycloak), D1 and D2 (below, § 13).

## 1. Purpose

Identity is Keycloak's, authorisation is policy's, and the application holds neither a password nor a provider secret. A reader signs in with Google or GitHub through Keycloak, which is the only party the application trusts to say who someone is; the application verifies Keycloak's id token, opens a session of its own, and from then on every page, action and endpoint asks two questions in a fixed order: who is this (session), and may they do this to that (policy). The answers fail closed: no session is anonymous, no policy is a deny, no OPA is a deny. Every decision that matters is a row someone can audit.

## 2. Dependencies and order

| Needs | Why |
|---|---|
| Spec 08 (pages, `Session` rows, `Identity`, the dev provider) | this spec is its backend; the pages do not change |
| Keycloak 26 (container in CI and staging; user-local distribution with a JDK 21 on the development machine, § 3.6) | the broker |
| Google OAuth client and GitHub OAuth app, registered to Keycloak's broker endpoints (not to the app) | the identity providers |
| OPA 1.x (single binary; sidecar in production; `opa run --server` locally) | the policy decision point |
| `openid-client` v6 and `jose` | certified OIDC relying party and JWT verification (D2) |
| Migration `0006_security` (§ 9) | `User.keycloakSub`, `AuthEvent`, `RateLimitBucket`, `IdempotencyKey` |
| `lib/env.ts` | Keycloak, OPA and header variables (§ 10) |

Build order: unit 21 = 21a realm as code and the local Keycloak → 21b `lib/auth/oidc.ts` (discovery, PKCE, nonce, token exchange, id-token verification) and `getSession()` on the cookie (08 § 5.2) with tests on a fake issuer → 21c the auth routes (`/api/v1/auth/login`, `/callback`, `/logout`, `/backchannel-logout`, `/dev`) → 21d security headers and the CSP nonce → 21e spec 08's pages on top → verification. Unit 22 = 22a `lib/policy/opa.ts` and `policies/` with Rego tests → 22b `lib/api/handler.ts` with rate limit, idempotency, errors, tracing → 22c the auth routes rewritten through the pipeline, `authorize()` in the existing server actions → 22d the public content endpoints and the reader-state endpoints → 22e `AuthEvent` and the audit hooks → verification.

## 3. Identity architecture

### 3.1 Parties

```
Browser ──(1) /[lang]/login ──▶ Next.js ──(2) authorize (PKCE, state, nonce, kc_idp_hint=google|github)
   ▲                                              │
   │                                              ▼
   │                                    Keycloak realm harness-bible
   │                                     client hb-web · brokers ──▶ Google (OIDC) / GitHub (OAuth 2)
   │                                              │
   │◀─(3) redirect with code ─────────────────────┘
   │
   └──(4) /api/v1/auth/callback ──▶ Next.js: code → tokens (client secret + PKCE) → verify id token (JWKS, iss, aud, nonce, exp)
                                       → resolve User (§ 4.3) → Session row + hb.session cookie → redirect to next
```

Keycloak is the only OIDC issuer the application trusts. Google and GitHub are Keycloak identity providers; the application never holds their client secrets and never calls them. A future organisation IdP (SAML or OIDC) is one more Keycloak identity provider, with no application change (the TRD's design, architecture § 5.1).

### 3.2 Realm as code

`infra/keycloak/realm-harness-bible.json` (imported at start; the file is the source of truth, edited by hand and reviewed like code) with:

| Setting | Value | Why |
|---|---|---|
| Realm | `harness-bible`, display name `The Harness Bible`; `master` is never used for users | separation from the admin realm |
| `sslRequired` | `external` in development, `all` in staging and production | TLS everywhere users are |
| Registration, username/password login, "forgot password", "remember me", e-mail verification | all off; no password policy needed because no password exists | SSO only |
| Browser flow | a copy of `browser` with the username/password form and OTP removed, leaving cookie → identity-provider redirector; a request without `kc_idp_hint` shows Keycloak's provider chooser, which lists only Google and GitHub | no credential form anywhere |
| Brute force detection | on (permanent lockout off; 30 s wait after 5 failures) | applies to the broker endpoints |
| Login with e-mail, duplicate e-mails | e-mail as username; duplicates forbidden | one person, one account |
| Events | user events on (login, login_error, logout, identity-provider link, update profile), 90-day expiry; admin events with representation | the identity audit trail (§ 8.6) |
| Sessions | SSO idle 8 h, SSO max 30 d; client session idle 10 min; access token 5 min; refresh token rotation on; offline sessions off; "revoke refresh token" on | short tokens; the application session is its own (08 § 5.2) |
| Tokens | RS256 (default realm key rotates yearly, previous key kept for verification); `id_token` includes `sid` | verification by JWKS |

Identity providers (`identityProviders[]`):

| Provider | Type | Settings |
|---|---|---|
| `google` | `google` | scopes `openid email profile`; `trustEmail: true` (Google verifies); `hideOnLogin: false`; `syncMode: IMPORT` (attributes taken at first login only); `firstBrokerLoginFlowAlias: hb-first-broker` |
| `github` | `github` | scope `read:user user:email`; `trustEmail: true` (Keycloak's GitHub provider takes the primary verified e-mail); the same flows |

`hb-first-broker` is the first-broker-login flow with "Review Profile" off and "Confirm link existing account" replaced by automatic linking on a verified e-mail (the "Detect existing broker user" + "Automatically set existing user" steps): a person who signed in with Google and later with GitHub gets one Keycloak user. The application therefore never links accounts itself (amends 08 § 5.3 step 6 and the `intent=link` handshake: the account page's `Link GitHub` starts a normal login with `kc_idp_hint=github&prompt=login`; Keycloak links, and the callback's `idp` claim updates `Identity`).

Client `hb-web`:

| Setting | Value |
|---|---|
| Type | OpenID Connect, confidential (client secret from the vault, § 10); standard flow only; implicit, direct grants, service accounts off |
| PKCE | `pkce.code.challenge.method: S256` (required) |
| Redirect URIs | exactly `${APP_URL}/api/v1/auth/callback`; post-logout redirect URIs `${APP_URL}/en`, `${APP_URL}/pt`; web origins `${APP_URL}` |
| Back-channel logout | URL `${APP_URL}/api/v1/auth/backchannel-logout`, session required on; front-channel logout off |
| Scopes | default `openid`, `email`, `profile`; a realm client scope `hb` (default) with mappers: `idp` (identity provider alias of the current login, from the user session note `identity_provider`), `hb_role` (the realm role, single-valued, from the role list below), `org` (user attribute `organisationId`, optional) |
| Consent | off (first party) |

Realm roles: `reader` (default role for new users), `builder`, `contributor`, `curator`, `org_admin`; composite: each includes the previous except `org_admin`, which includes `reader` (architecture § 5.2). Role assignment is an admin act in Keycloak (Phase 1: the pilot operator; Phase 4: the org admin screen through the admin API); the application mirrors the role into `User.role` at every sign-in (§ 4.3) and never writes it itself.

### 3.3 Hostnames and exposure

| Endpoint | Exposure |
|---|---|
| `https://auth.<domain>/realms/harness-bible/*` | public through the edge (TLS, WAF, per-IP rate limit); the only Keycloak surface users reach |
| `https://auth-admin.<domain>/admin/*` (`KC_HOSTNAME_ADMIN`) | private network only; admin console and admin API |
| Keycloak's database | its own PostgreSQL database and role; never the application's |
| Region | São Paulo, as everything else (invariant 29) |

### 3.4 What Keycloak decides and what the application decides

| Question | Decided by |
|---|---|
| Who is this person; which provider vouched; is the e-mail verified | Keycloak (broker flows, `trustEmail`) |
| Which role | Keycloak realm role, mirrored to `User.role` |
| May this subject do this action on this resource | OPA (§ 5) with the application's `User`, ownership and tenant facts |
| Is this browser still signed in to the application | the application's `Session` row and cookie (08 § 5.2) |
| Is this browser still signed in at the broker | Keycloak's SSO session; consulted only on a new login or a back-channel logout |

### 3.5 Identity verification for contributors (Phase 4, kept in view)

`User.identityVerified` mirrors a Keycloak user attribute `identity_verified=true` set by an operator after the contributor's verification (the TRD's "Keycloak attribute"); it is carried as a claim `hb_verified` by one more mapper and mirrored at sign-in like the role. Nothing in Phase 1 sets it.

### 3.6 Development machine

No Docker on Andre's machine (tracker). Keycloak runs from its zip distribution (`kc.bat start-dev --import-realm --http-port 8081` under a JDK 21 in the user profile, like PostgreSQL), with the realm file and a `files-plaintext` vault directory holding the two provider secrets and the client secret; `npm run auth:kc` starts it. Where Keycloak is not running, the dev provider of 08 § 5.7 signs the development user in without it, so every page and test that is not about the handshake works offline. CI and staging run the `quay.io/keycloak/keycloak:26` container from `docker-compose.yml` (a `keycloak` service beside `db`).

## 4. The OIDC client and sessions (amends 08 § 5.1–5.3)

### 4.1 Client (`lib/auth/oidc.ts`)

`openid-client` v6 against `${KEYCLOAK_ISSUER}` (`https://auth.<domain>/realms/harness-bible`): discovery cached for the process, the client secret from `env`, `code_challenge_method=S256`, `response_type=code`, scopes `openid email profile hb`. `jose`'s `createRemoteJWKSet` on the discovered `jwks_uri` verifies every id token and every logout token; the JWKS cache honours the key rotation of § 3.2.

### 4.2 Routes

| Route | Behaviour |
|---|---|
| `GET /api/v1/auth/login?idp=google\|github&next=&intent=` | public; writes `hb.oauth` (08 § 4.2: `state`, `codeVerifier`, `nonce`, `next`, `intent`, `locale`, `idp`) and redirects to Keycloak's authorization endpoint with `kc_idp_hint={idp}` (Keycloak skips its chooser and goes to the provider), `prompt=select_account` for Google (forwarded by Keycloak's provider config), `prompt=login` when `intent=link`. Replaces 08's `/api/v1/auth/{provider}`; the buttons keep their labels |
| `GET /api/v1/auth/callback?code&state` (or `?error&error_description`) | public; `state` must equal the cookie's; `error=access_denied` → `/[lang]/login?error=denied`; exchanges the code with PKCE; verifies the id token (`iss`, `aud=hb-web`, `exp`, `iat` within 5 min, `nonce` equal to the cookie's, `azp`); reads `sub`, `email`, `email_verified`, `name`, `idp`, `hb_role`, `hb_verified`, `sid`; resolves the user (§ 4.3); creates the `Session` row with `idpSessionId = sid` (08 § 5.2) and sets the cookie; deletes `hb.oauth`; discards the access and refresh tokens (D3); redirects to `safeNext` |
| `POST /api/v1/auth/logout` (from the sign-out page's actions) | session; revokes the application session(s); clears the cookie; redirects to Keycloak's `end_session_endpoint` with `id_token_hint` (kept encrypted in the `Session` row? no: D4 stores only `sid`, so the redirect uses `client_id` + `post_logout_redirect_uri` and Keycloak's confirm page is avoided by the realm setting "RP-initiated logout without id_token_hint" allowed for `hb-web`), which ends the broker session and returns to `/[lang]` |
| `POST /api/v1/auth/backchannel-logout` | public, body `logout_token` (JWT): verified against the JWKS with `iss`, `aud`, `iat`, `events` containing `http://schemas.openid.net/event/backchannel-logout`, and `sid`; every `Session` row with that `idpSessionId` is deleted; 200 always (no oracle); rate-limited |
| `GET /api/v1/auth/dev?email=&next=` | 08 § 5.7 unchanged; absent in production |

The `next` cookie value and every redirect go through `safeNext` (08 § 5.4).

### 4.3 User resolution (amends 08 § 5.3)

Inside one transaction, from the verified claims:

1. `User` by `keycloakSub` (new unique column, § 9) → **sign in**: refresh `email` (Keycloak's is canonical), `displayName` when the user never edited it (a `displayNameEdited` flag, § 9), `role` from `hb_role`, `identityVerified` from `hb_verified`; deleted or pending deletion → refuse `deleted`.
2. Else `User` by `email` (a user the pilot operator created ahead, or one migrated from the dev seam) → adopt: set `keycloakSub`, then as 1.
3. Else the allow-list (08 § 5.6; `AUTH_ALLOWED_EMAILS`) → `not-invited`, or **create** `User { keycloakSub, email, displayName, role: READER, locale from the request }`.
4. `Identity` upsert on `(provider = idp, providerAccountId = sub)`: `email`, `lastSignInAt`; the row is the account page's "linked sign-ins" list (one row per provider the person has used through Keycloak).
5. `intent=link`: after Keycloak's automatic linking the callback arrives as any other; the page's `?linked={idp}` is set when the `Identity` row was new.

`email_verified` false cannot happen with `trustEmail` providers; it is still checked and refused (`email`).

### 4.4 Session semantics (08 § 5.2, confirmed)

The application session is independent of Keycloak's after sign-in: 30 days rolling, revocable per row, listed on the account page. A back-channel logout (a person signing out at Google via Keycloak's account console, or an operator ending a Keycloak session) removes the rows with that `sid`. `getSession()` runs in every page and action; it reads no token and calls no network.

## 5. Authorisation

### 5.1 Subjects, actions, resources

```ts
// lib/policy/input.ts
interface PolicySubject { kind: "anonymous" | "user" | "service"; id: string | null; role: Role | null; organisationId: string | null; verified: boolean; sessionId: string | null }
interface PolicyResource { kind: "content" | "search" | "bookmark" | "note" | "path-progress" | "session" | "user" | "org" | "lab-session" | "lab-run" | "suggestion" | "curation" | "audit-export" | "auth"; id: string | null; ownerId?: string | null; organisationId?: string | null; part?: "P0" | "P1" | "P2" | "P3" | null; changeClass?: string | null }
type PolicyAction = "read" | "write" | "delete" | "list" | "start" | "run" | "share" | "submit" | "decide" | "export" | "manage" | "revoke";
interface PolicyContext { releaseId: string; traceId: string; method: string; path: string; now: string }
```

`lib/policy/opa.ts` exports `authorize(subject, action, resource, context): Promise<Decision>` where `Decision = { allow: true } | { allow: false; reason: string }`, and `requireAllowed(...)` which throws `AppError("FORBIDDEN")` on deny. It POSTs `{ input }` to `${OPA_URL}/v1/data/hb/authz/allow` with a 200 ms timeout, one retry, no caching of allows (a deny may be cached for 1 s per identical input to blunt hammering; D6). Unreachable, timeout, non-200 or a non-boolean result → deny with reason `opa_unreachable`. Every decision is logged as a structured line `{traceId, subject.id, subject.role, action, resource.kind, resource.id, allow, reason, ms}` to the OTel logger (never the e-mail).

### 5.2 Policies (`policies/`)

Rego, package `hb.authz`, `default allow := false`, one file per concern, versioned with the rubric later:

| File | Rules (Phase 1 subset; later phases add) |
|---|---|
| `public.rego` | `content` and `search` reads allow for every subject kind; `auth` actions (`login`, `callback`, `backchannel`) allow for anonymous |
| `session.rego` | a `user` subject may `read`/`revoke` a `session` whose `ownerId` is the subject |
| `reader.rego` | a `user` with any role may `read`/`write`/`delete` `bookmark`, `note`, `path-progress` whose `ownerId` is the subject; `list` of the same kinds allows only for the subject's own rows (the resource has `ownerId = subject.id`) |
| `user.rego` | `read`/`write` on `user` only when `resource.id == subject.id` (profile, preferences, deletion request); `manage` reserved for `org_admin` on users of the same `organisationId` (Phase 4) |
| `org.rego` | `read`/`manage` on `org` only for `org_admin` and `resource.organisationId == subject.organisationId` (Phase 4) |
| `roles.rego` | the ladder: `builder ⊇ reader`, `contributor ⊇ builder`, `curator ⊇ contributor`, `org_admin ⊇ reader`; helper `has_role(subject, role)` |
| `agent.rego` | `service:*` subjects: deny `read` on `user` always; `service:adjudicator` may `decide` only when `resource.changeClass != "CURATOR_ALWAYS"` (Phase 4; the invariant 13 rule written now, tested now) |
| `tenant.rego` | any resource with an `organisationId` different from the subject's is denied unless the resource is public; a `null` subject organisation matches only `null` resources |

`policies/tests/*_test.rego` cover every role × action × kind of Phase 1, cross-tenant denies, the agent denies and `opa_unreachable`'s absence (that one is the client's test). `npm run policy:test` runs `opa test policies -v`; `npm run policy:serve` runs `opa run --server --addr 127.0.0.1:8181 --bundle policies`. CI fails on any failing policy test and on a bundle that does not load (`opa check`).

### 5.3 Where the question is asked

| Caller | How |
|---|---|
| `/api/v1` handlers | the pipeline (§ 7) calls `authorize` between session and endpoint, with the resource the spec's `resource(input)` function names; the endpoint never runs on a deny |
| Server actions (paths, reader marks, marks page, account, logout) | `requireAllowed(subjectOf(session), action, resource)` immediately after `getSession()` and before any write; the existing actions gain that one line each (unit 22c) |
| Pages | reads of a reader's own rows are already bound by the tenant guard (04 § 4); role-gated pages (Phase 3 labs, Phase 4 improve, admin) call `authorize` in the page and render 403 through `forbidden()` (Next's `forbidden.tsx`) or redirect to login when anonymous |
| The tenant guard | stays the last line: even an allowed query cannot cross a `userId`/`organisationId` boundary (invariant 24) |

Ownership is a policy fact, not an `if` in a handler: the caller passes `ownerId` from the row it is about to touch (or from the route, for user-scoped kinds where the id is the user's own), and the policy compares.

## 6. Protected URLs

### 6.1 Pages and server actions

| Route | Anonymous | Signed in (`reader`+) | Notes |
|---|---|---|---|
| `/[lang]`, `/[lang]/ch/[n]/[section]`, `/[lang]/ref/[id]`, `/[lang]/search` | read | read; per-user blocks render | public content |
| `/[lang]/paths`, `/[lang]/paths/[path]` | read without progress; `Start path` links | full | 05 D5 |
| `/[lang]/marks` | the sign-in notice (07 § 7) | full | stays a notice, not a redirect (07) |
| `/[lang]/login` | the page | redirect to `next` | 08 |
| `/[lang]/logout` | "already signed out" | the confirm | 08 |
| `/[lang]/account` | redirect to `/[lang]/login?next=…` | own account | org admin instruments Phase 4 |
| `/[lang]/ch/[n]/@lab`, `/[lang]/labs/**` | redirect to login | `builder`+ else 403 page | Phase 3 |
| `/[lang]/ch/[n]/@assistant` | redirect to login | any role | Phase 2 |
| `/[lang]/ch/[n]/@improve/new`, `/[lang]/improve/[id]` | redirect to login | `contributor` verified else 403; owner or curator on `[id]` | Phase 4 |
| `/[lang]/improve/queue` | redirect | `curator` else 403 | Phase 4 |
| Server actions | `NO_SESSION` result or redirect to login | policy per § 5.3 | every action, no exception |

`proxy.ts` (middleware) gains one responsibility besides the locale: it sets the security headers and the CSP nonce (§ 8.1). It does not read the session (a cookie's presence proves nothing; the page decides), keeping code-standards' "middleware touches no data".

### 6.2 `/api/v1`

The architecture § 3.4 table stands; this spec fixes the Phase 1 rows and the shape every later row follows:

| Endpoint | `auth` | Policy (action · resource) | Rate limit | Idempotent |
|---|---|---|---|---|
| `GET /api/v1/releases/current`, `/chapters`, `/chapters/{n}`, `/sections/{id}`, `/figures/{id}/derive` | `public` | `read · content` | 600/min/IP (edge) + 120/min/IP (handler) | — |
| `GET /api/v1/search` | `public` | `read · search` | 120/min/IP | — |
| `GET /api/v1/paths` | `session` | `list · path-progress` (owner) | 60/min/user | — |
| `PUT /api/v1/paths/{path}/progress` | `session` | `write · path-progress` (owner) | 60/min/user | PUT idempotent by nature |
| `PUT` / `DELETE /api/v1/bookmarks/{sectionId}` | `session` | `write` / `delete · bookmark` (owner) | 60/min/user | idempotent (07 § 5.2) |
| `PUT /api/v1/notes/{sectionId}` | `session` | `write · note` (owner) | 60/min/user | idempotent |
| `GET /api/v1/auth/login`, `/callback` | `public` | `login · auth` | 10/min/IP | — |
| `POST /api/v1/auth/logout` | `session` | `revoke · session` (owner) | 10/min/user | — |
| `POST /api/v1/auth/backchannel-logout` | `public` (token-verified) | `backchannel · auth` | 60/min/IP | by `jti` |
| `GET /api/v1/auth/dev` | `public`, non-production only | `login · auth` | 10/min/IP | — |
| `GET /api/v1/me` | `session` | `read · user` (self) | 60/min/user | — |
| `GET /api/v1/me/sessions`, `DELETE /api/v1/me/sessions/{id}` | `session` | `read` / `revoke · session` (owner) | 60/min/user | — |

Anything not listed is 404. `auth: "bearer"` (a Keycloak access token in `Authorization: Bearer` for non-browser clients) is part of the pipeline's contract from day one: the token is verified against the JWKS (`iss`, `aud`, `exp`, `typ=Bearer`), the subject is resolved as in § 4.3 without creating users, and the roles come from `hb_role`; no Phase 1 endpoint enables it (D7).

## 7. The handler pipeline (`lib/api/handler.ts`)

```ts
export const GET = handler({
  auth: "public" | "session" | "bearer" | "session-or-bearer",
  role?: Role,                                   // minimum role; checked before policy as a cheap gate
  params?: ZodSchema, query?: ZodSchema, body?: ZodSchema, response: ZodSchema,
  rateLimit?: { key: "ip" | "user"; limit: number; windowS: number },
  idempotent?: boolean,                          // honours Idempotency-Key on POST/PATCH; PUT/DELETE are idempotent by construction
  policy: { action: PolicyAction; resource: (input) => PolicyResource },
  run: (input: { params, query, body, session, traceId }) => Promise<Output>,
});
```

Steps, in order, none skippable:

1. **Trace**: `traceId` from a valid incoming `traceparent`, else a new one; the response carries `traceparent`; the OTel span opens here.
2. **Parse**: `params`, `query` (repeatable keys as arrays), `body` (JSON ≤ 64 KB; 413 above; `Content-Type` must be `application/json` for bodies) with the zod schemas → 400 `INVALID_INPUT` with the failing path in `detail`, or 422 when the schema's refinement names a semantic rule.
3. **Session**: `getSession()` (cookie) or the bearer path per `auth`; `public` continues anonymous; `session` without one → 401 `NO_SESSION`; `role` unmet → 403 `ROLE_REQUIRED`.
4. **Origin check** for browser mutations: a cookie-authenticated `POST`/`PUT`/`PATCH`/`DELETE` must carry `Origin` or `Referer` equal to `APP_URL` (or `Sec-Fetch-Site: same-origin`) → else 403 `BAD_ORIGIN` (§ 8.3).
5. **Rate limit**: token bucket in `RateLimitBucket` keyed `{scope}:{key}:{path}` (§ 9), one atomic `INSERT … ON CONFLICT DO UPDATE … RETURNING`; over → 429 `RATE_LIMITED` with `Retry-After`; every response carries `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` (IETF draft headers, architecture § 10 contract tests).
6. **Idempotency**: when `idempotent` and the method is `POST`/`PATCH`, `Idempotency-Key` (UUID, required → 400 without) looked up in `IdempotencyKey` scoped `(userId, path, key)`: a stored response is replayed with `Idempotency-Replayed: true`; a key in flight → 409 `IN_PROGRESS`; a different body under the same key → 422 `IDEMPOTENCY_MISMATCH` (body hash compared); rows expire after 24 h.
7. **Policy**: `authorize(subjectOf(session), policy.action, policy.resource(input), context)` → deny → 403 `FORBIDDEN` (`opa_unreachable` is also 403; the reason goes to the log, never to the body).
8. **Endpoint**: `run(input)` inside `withTenant(tenantOf(session))` for a user subject; `AppError` codes map to the catalogue (`NOT_FOUND` 404, `CONFLICT` 409, `UNKNOWN_SECTION` 404, `NOTE_TOO_LONG` 422, `BUDGET_EXCEEDED` 402, `RATE_LIMITED` 429); anything else → 500 `INTERNAL` with the trace id and no message from the error.
9. **Serialise**: `response.parse(output)` (a handler cannot leak a field the schema does not name); lists as `{ items, count, ms }`; `Cache-Control: no-store` on every non-public response and `private, max-age=0` on public ones (the data cache is server-side); `Content-Type: application/json; charset=utf-8`.
10. **Span end and audit**: status, ms, `subject.id`, policy decision on the span; `AuthEvent` rows for the auth routes (§ 8.6).

Error body everywhere: `{ code, message, detail?, traceId }`, `message` in the request's locale (`Accept-Language` or the `[lang]` of the referring page; EN default), declarative, naming the fix. The OpenAPI 3.1 document is generated from the schemas (`npm run api:openapi`) and every endpoint has a contract test in `tests/contract/` (request, response, error body, rate-limit headers).

## 8. Security controls

### 8.1 Response headers (`proxy.ts` for the CSP nonce; `next.config.ts` `headers()` for the static ones)

| Header | Value |
|---|---|
| `Content-Security-Policy` | `default-src 'self'; script-src 'self' 'nonce-{nonce}' 'strict-dynamic'; style-src-elem 'self' 'nonce-{nonce}'; style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self' ${KEYCLOAK_ORIGIN}; base-uri 'self'; object-src 'none'; upgrade-insecure-requests` (development drops `upgrade-insecure-requests` and adds `'unsafe-eval'` for React refresh). The nonce is generated per request in `proxy.ts`, passed as `x-nonce`, and applied by Next to its own scripts and by the root layout to the theme script of 08 § 6.3. `style-src-attr 'unsafe-inline'` covers the components' `style={{}}` attributes (a hash list would break on every change); no inline `<style>` element exists |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains; preload` (production only) |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` (belt to the CSP's braces) |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Cross-Origin-Resource-Policy` | `same-origin` |
| `Cache-Control` | pages with a session: `private, no-store`; content pages anonymous: `private, max-age=0, must-revalidate` (the data cache is server-side; an intermediary never caches a page that may carry per-user blocks) |

Verified by a contract test that fetches `/en`, `/en/ch/21/21.3`, `/en/account` and one API route and asserts every header; Mermaid SVGs and the code panes carry no script (04's pipeline strips them), so `'strict-dynamic'` holds.

### 8.2 Cookies

08 § 4.2 stands, tightened: in production the session cookie is `__Host-hb.session` (`Secure`, `Path=/`, no `Domain`), the handshake cookie `__Host-hb.oauth`; development keeps `hb.session` / `hb.oauth` on `http://localhost`. `HttpOnly` on both; `SameSite=Lax` (the callback needs the cookie on a top-level navigation from Keycloak; `Strict` would drop it). The cookie holds an opaque token; nothing in it is readable or forgeable; a leaked value is revoked from the account page or by `revokeAllSessions`. No cookie is set on `/api/v1` responses except by the auth routes.

### 8.3 CSRF and request forgery

- Server actions: Next's built-in origin check on every action (`Origin` must match the host; `serverActions.allowedOrigins` lists `APP_URL` only).
- `/api/v1` mutations with a cookie session: the origin check of § 7 step 4.
- OAuth: `state` (CSRF), `nonce` (id-token replay), PKCE (code interception); the handshake cookie is single-use and 10 minutes old at most.
- Sign-out: `POST` only (08 § 6.2); a `GET /logout` renders a page and changes nothing.
- The dev provider is a `GET` (a link the developer clicks) and does not exist in production.
- No custom `X-CSRF` token is needed: every cookie-authenticated mutation is either a server action or a JSON API call with the origin check, and `SameSite=Lax` blocks cross-site `POST` navigations.

### 8.4 Session security

- Session id: 32 bytes from `crypto.getRandomValues`, stored hashed (SHA-256) so a database read yields no usable token; compared by primary key (constant time is not a concern for hashed ids).
- Fixation: a new session at every sign-in; the old cookie, if any, is replaced; `revokeOtherSessions` offered on the account page.
- Privilege change: when a mirrored role differs from the stored one at sign-in, every other session of the user is revoked (a role downgrade takes effect on all devices within one request on those devices' next load, because `getSession()` reads the row).
- Expiry: 30 days rolling (08 D10), `expiresAt` indexed, sweep job; a back-channel logout removes the rows of that broker session.
- Concurrency: at most 20 open sessions per user; the 21st sign-in revokes the oldest (D8).

### 8.5 Secrets and configuration

| Secret | Lives in | Read by |
|---|---|---|
| `KEYCLOAK_CLIENT_SECRET` | vault → `lib/env.ts` at boot | `lib/auth/oidc.ts` only |
| Google and GitHub client secrets | Keycloak's vault (`files-plaintext` locally; the platform vault in staging and production) | Keycloak only; the application never has them |
| `DATABASE_URL` | vault → env | Prisma |
| Keycloak admin credentials | the platform vault; a bootstrap admin only on the private hostname | operators |

Rules: `.env` is git-ignored and `.env.example` holds names and shapes only; nothing logs an env value; `lib/env.ts` refuses to boot in production when `KEYCLOAK_ISSUER`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET`, `OPA_URL` or `APP_URL` is missing, or when `AUTH_DEV_PROVIDER` is set; the CI secret scanner (gitleaks) runs on every push with zero findings required (architecture § 5.7 extends it to prompt templates later).

### 8.6 Audit events (`AuthEvent`, § 9)

One row per: `sign_in` (with `idp`), `sign_in_refused` (reason), `sign_out`, `sign_out_all`, `session_revoked` (by whom: self or backchannel), `backchannel_logout`, `role_changed` (from → to, mirrored), `deletion_requested`, `identity_linked`, `policy_denied` (action, resource kind, reason; sampled at 100% in Phase 1). Columns: `userId?`, `sessionId?`, `kind`, `detail` (JSON without free text or e-mails), `ipHash` (SHA-256 of the IP with a daily salt, LGPD), `userAgent` (the `deviceOf` summary of 08, not the raw string), `traceId`, `createdAt`; retained 90 days (a sweep with the sessions). Phase 4 moves the decision-grade events to the ledger; the table stays as the operational log. Keycloak's own event log holds the broker side (§ 3.2).

### 8.7 Input, output and errors

- Every boundary parses with zod (code-standards); route params such as `sectionId` use the branded parsers of `lib/schemas/ids.ts`; `next` paths go through `safeNext`; `Idempotency-Key` must be a UUID; JSON bodies are size-capped before parsing.
- Errors never carry stack traces, SQL, or the OPA reason; the trace id is the handle for support.
- Section bodies remain validated against the § 4.2 vocabulary of 03 (no `<script>`, no handlers, no `javascript:`); search snippets admit `<mark>` only (06); notes render as text (07). The CSP is the second line, not the first.
- Redirects: only `safeNext` results and Keycloak's discovered endpoints; no `Location` is ever built from a request value.

### 8.8 Dependencies and CI gates

| Gate | Tool | Rule |
|---|---|---|
| Vulnerable dependencies | `npm run audit:check` in CI (`npm audit` of the production tree and of the whole tree; `lib/security/audit.ts`); Renovate weekly | no high or critical open for more than 7 days. The production tree admits none. The development tree admits only an advisory no released version fixes, named in `DEV_EXCEPTIONS` with its reason and a review day, from which it fails the gate again (2026-10-20: `braces`, through the linter alone) |
| Lockfile | `package-lock.json` committed; `npm ci` in CI | no floating install |
| Secrets in the repo | gitleaks | zero findings |
| Policy | `opa check` + `opa test` | all deny cases pass |
| Contract | every `/api/v1` endpoint incl. error bodies and rate-limit headers | no untyped endpoint |
| Headers | the § 8.1 test | every header present |
| Cross-tenant | integration tests attempting each user-scoped endpoint and action as another user | every attempt 403 or empty |
| Keycloak realm | the realm file imported into a fresh container in CI; a smoke login with a test identity provider (Keycloak's built-in OIDC provider pointed at a second realm acting as a fake Google) | the handshake works end to end without Google or GitHub credentials in CI |

### 8.9 Keycloak hardening checklist (operations)

Admin console on the private hostname only; the bootstrap admin replaced by named operator accounts with OTP; realm `harness-bible` roles for operators kept in `master` with least privilege (`manage-users`, `view-events`); events on with 90-day expiry; brute-force detection on; `sslRequired=all`; a dedicated PostgreSQL database and role; production `KC_HTTP_ENABLED=false`, `KC_PROXY_HEADERS=xforwarded` behind the edge; backups of the Keycloak database with the application's (same region); the realm file is the only way a setting changes (a drift check exports the realm nightly and diffs it against the file).

### 8.10 Threats specific to this layer (extends architecture § 9)

| Attack | Control | Detection | Residual risk |
|---|---|---|---|
| Stolen session cookie | `HttpOnly`, `Secure`, `__Host-`, hashed ids, 30-day expiry, per-row revocation, sign-out everywhere | `AuthEvent` sign-ins from a new device summary; the account page's sessions list | A cookie exfiltrated by malware on the device is valid until revoked |
| Login CSRF / mix-up | `state` bound to the cookie, `nonce` in the id token, one issuer, `kc_idp_hint` only as a hint | callback `state` mismatches counted | none material |
| Authorization code interception | PKCE S256, single-use codes at Keycloak, TLS | Keycloak `CODE_TO_TOKEN_ERROR` events | none material |
| Account takeover through an unverified provider e-mail | `trustEmail` only on providers that verify; `email_verified` re-checked; automatic linking only on verified e-mail | Keycloak `IDENTITY_PROVIDER_FIRST_LOGIN` events | a provider's own compromise |
| Privilege escalation | roles only from Keycloak claims mirrored at sign-in; policy default deny; role gate + policy; tenant guard | `role_changed` events; policy deny rate | a mis-assigned role in Keycloak: admin events log it |
| Cross-tenant read | tenant guard + `tenant.rego` + ownership facts; raw SQL listed | cross-tenant integration tests; `policy_denied` events | a raw SQL path (reviewed) |
| Brute force / abuse of auth routes | 10/min/IP on login and callback; Keycloak brute-force detection; edge rate limit | 429 counts | distributed attempts are the edge's problem |
| XSS | CSP with nonce and `strict-dynamic`; validated bodies; React escaping; no `dangerouslySetInnerHTML` outside the two listed places | CSP report endpoint (`report-to`, Phase 2 when a collector exists) | a CSP bypass through an allowed `'self'` script (none is user-controlled) |
| Clickjacking | `frame-ancestors 'none'`, `X-Frame-Options: DENY` | — | none |
| Open redirect | `safeNext` | tests | none |
| Token replay at the back-channel endpoint | `jti` idempotency, `iat` window, JWKS verification | 200-always with a logged mismatch | none material |

## 9. Data contract and schema (migration `0006_security`)

```prisma
model User { …; keycloakSub String? @unique; displayNameEdited Boolean @default(false); identities Identity[]; authEvents AuthEvent[] }

enum IdentityProvider { GOOGLE GITHUB }           // 08; the provider Keycloak brokered for that sign-in
// Identity unchanged from 08 § 4.3: (provider, providerAccountId = Keycloak sub) unique

model AuthEvent {
  id        String   @id @default(uuid())
  userId    String?
  user      User?    @relation(fields: [userId], references: [id])
  sessionId String?
  kind      String                                // sign_in · sign_in_refused · sign_out · sign_out_all · session_revoked · backchannel_logout · role_changed · deletion_requested · identity_linked · policy_denied
  detail    Json                                  // no free text, no e-mail
  ipHash    String
  userAgent String                                // deviceOf() summary
  traceId   String
  createdAt DateTime @default(now())
  @@index([userId, createdAt])
  @@index([createdAt])
}

model RateLimitBucket {
  key       String   @id                          // "{scope}:{id}:{path}"
  tokens    Float
  updatedAt DateTime
}

model IdempotencyKey {
  userId    String
  path      String
  key       String
  bodyHash  String
  status    Int?                                  // null while in flight
  response  Json?
  createdAt DateTime @default(now())
  @@id([userId, path, key])
  @@index([createdAt])
}
```

`AuthEvent` and `IdempotencyKey` are user-scoped for the tenant guard (`userId`, nullable on `AuthEvent` for anonymous refusals: the guard exemption of 08 D6 lists them with `Session`); `RateLimitBucket` is not account data (keys hash the IP; the guard ignores the model). The atomic bucket update is one `$executeRaw` (`INSERT … ON CONFLICT DO UPDATE SET tokens = LEAST(limit, tokens + refill) - 1 … RETURNING`), listed in `RAW_SQL.md`.

`lib/schemas/auth.ts` (08) gains `IdTokenClaimsSchema` (`iss`, `sub`, `aud`, `exp`, `iat`, `nonce`, `sid`, `email`, `email_verified`, `name?`, `idp`, `hb_role`, `hb_verified?`, `azp`), `LogoutTokenSchema`, `PolicyInputSchema`, `ErrorBodySchema`, and `lib/schemas/api/` starts with the Phase 1 endpoints' request and response schemas.

## 10. Environment (`lib/env.ts`)

| Variable | Use |
|---|---|
| `APP_URL` | 08; the redirect URI, `allowedOrigins`, `form-action` |
| `KEYCLOAK_ISSUER` | `https://auth.<domain>/realms/harness-bible` (`http://localhost:8081/realms/harness-bible` locally) |
| `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET` | `hb-web` |
| `OPA_URL` | `http://127.0.0.1:8181`; unset in development means every `authorize` denies, so the dev script starts OPA (D6) |
| `AUTH_ALLOWED_EMAILS`, `AUTH_DEV_PROVIDER` | 08 § 5.6 |
| `IP_HASH_SALT` | rotated daily by the operator (or derived from the date and a static secret); `AuthEvent.ipHash` |
| Removed | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` (08 § 5.6): they belong to Keycloak now |

`.env.example` documents them; production boot refuses missing values (§ 8.5).

## 11. States and error catalogue (backend view)

| Situation | Response |
|---|---|
| Callback without the handshake cookie, or `state` mismatch | 302 `/[lang]/login?error=state`; `AuthEvent sign_in_refused { reason: "state" }` |
| Provider or Keycloak returns `error=access_denied` | 302 `?error=denied` |
| Token exchange or id-token verification fails | 302 `?error=provider`; the reason in the log only |
| `email_verified` false | 302 `?error=email` |
| Not on the allow-list | 302 `?error=not-invited` |
| User deleted or pending deletion | 302 `?error=deleted` |
| `/api/v1` without a session | 401 `NO_SESSION` `Sign in to use this endpoint.` |
| Role below the gate | 403 `ROLE_REQUIRED` `This needs the builder role.` |
| Policy deny or OPA unreachable | 403 `FORBIDDEN` `You cannot do this to that resource.` (reason logged) |
| Origin mismatch on a cookie mutation | 403 `BAD_ORIGIN` |
| Rate limited | 429 `RATE_LIMITED` with `Retry-After` |
| Idempotency: in flight / mismatch | 409 `IN_PROGRESS` / 422 `IDEMPOTENCY_MISMATCH` |
| Body over 64 KB | 413 `PAYLOAD_TOO_LARGE` |
| Back-channel logout with a bad token | 200 with an empty body; `AuthEvent backchannel_logout { verified: false }` |
| Keycloak unreachable at login | 302 `?error=provider` (login) ; existing sessions unaffected |
| OPA bundle fails to load | OPA keeps the last good bundle (operations alert); the application sees no change |

## 12. Out of scope

- Organisation IdPs (SAML/OIDC through Keycloak): the realm supports adding one; onboarding, `Organisation.ssoIssuer` and the org admin screen are Phase 4.
- Bearer-token clients and API keys for organisations (the pipeline supports `auth: "bearer"`; no endpoint enables it, D7).
- The ledger (Phase 4); `AuthEvent` is the Phase 1 audit table.
- A CSP report collector (`report-to`), the WAF and edge rate-limit configuration (infrastructure, not the repository).
- MFA at the provider, passkeys, Keycloak's account console for end users (the account page of 08 is the user's surface).
- Curation, labs and assistant policies beyond the rules written now for invariant 13.

## 13. Decisions this spec needs

| # | Decision | Recommendation |
|---|---|---|
| D1 | Keycloak in Phase 1 after all. | Yes: Keycloak brokers Google and GitHub, the application is one OIDC client, and the TRD's design (architecture § 1, § 5.1) is kept. Sign-in stays exclusively Google or GitHub, as Andre asked. **Material: reverses 08 D1's deferral; costs a Keycloak instance in every environment (a zip on the development machine).** |
| D2 | OIDC library. | `openid-client` v6 (certified RP: discovery, PKCE, nonce, token exchange, back-channel logout token validation) with `jose` for JWKS verification, instead of 08's `arctic` (which has no OIDC discovery or nonce handling). **Material: replaces 08 D2.** |
| D3 | Tokens after sign-in. | The access and refresh tokens are discarded; the application session is its own (08 § 5.2) and no Keycloak API is called on behalf of the user in Phase 1. Routine, stated (Phase 4's admin API uses a service account, not user tokens). |
| D4 | RP-initiated logout without `id_token_hint`. | ~~Store only `sid`; allow `hb-web` to log out with `client_id` + `post_logout_redirect_uri`~~ **Amended 2026-09-23 after the first Keycloak run: no such client setting exists; without `id_token_hint` Keycloak shows its logout confirmation page. The session row keeps the id token (`Session.idToken`, migration `0007_session_id_token`) and the logout route sends it as `id_token_hint` with `client_id` and `post_logout_redirect_uri`. The id token is not a credential and Keycloak accepts an expired one as a hint; D3 still discards the access and refresh tokens.** |
| D5 | Account linking. | Keycloak's first-broker-login flow links providers by verified e-mail; the application does not. Routine, amends 08 § 5.3. |
| D6 | OPA locally. | `opa run --server` started by `npm run dev` through a `concurrently` script; unset `OPA_URL` denies everything so a missing sidecar is loud, never silent. Routine. |
| D7 | Bearer auth in Phase 1. | In the pipeline's contract and tests, enabled on no endpoint. Routine. |
| D8 | Sessions per user. | At most 20; the oldest is revoked. Routine. |
| D9 | Rate-limit store. | PostgreSQL bucket rows with one atomic raw statement, not Redis (no new infrastructure; the counts are small). Routine; revisit at the Phase 2 load test. |
| D10 | Middleware sets headers. | `proxy.ts` sets the CSP nonce and the static headers; it still reads no data. Routine (a one-line note in code-standards). |

## 14. Verification (in addition to `ai-workflow-rules.md` § 7)

1. The realm file imports into a fresh Keycloak (container in CI, the zip locally): realm `harness-bible`, client `hb-web` with PKCE required, both identity providers, the `hb` scope with its three mappers, the browser flow without a password form, brute force on, events on; the nightly drift export equals the file.
2. tsc, lint, `npm test`: `oidc.ts` against a fake issuer (`jose`-signed tokens): accepts a valid id token; refuses wrong `iss`, wrong `aud`, expired, future `iat`, wrong `nonce`, unsigned, a key not in the JWKS; the back-channel logout token likewise; `resolveUser` covers the five branches of § 4.3 including role mirroring and the revoke-on-downgrade rule; `handler.ts` unit tests for every pipeline step in order (a spy asserts the order and that a failing step stops the rest); rate-limit bucket maths; idempotency replay, in-flight and mismatch; `safeNext`; policy client: deny on timeout, non-200, non-boolean; messages parity. `npm run policy:test`: every role × action × kind of § 5.2, cross-tenant, agent denies. `npm run build`, token grep.
3. Contract tests (`tests/contract/`): every endpoint of § 6.2 against the generated OpenAPI document; error body shape on 400, 401, 403, 404, 409, 413, 422, 429; `RateLimit-*` and `Retry-After` headers; the § 8.1 headers on four routes; `Cache-Control` per route class.
4. Integration (database + OPA): as user A, `PUT /api/v1/bookmarks/21.3` creates the row and is idempotent; as user B, `DELETE` of A's bookmark is 403 with a `policy_denied` event; `GET /api/v1/me/sessions` lists A's sessions only; `DELETE /api/v1/me/sessions/{B's id}` is 403; the existing server actions refuse without a session and with a foreign owner; OPA stopped → every `authorize` denies within 250 ms and the reader still renders (public reads) while `toggleBookmark` returns `FORBIDDEN`.
5. End to end with Keycloak running (locally or in CI with the fake-provider realm): `/en/login` → `Continue with GitHub` → `/api/v1/auth/login?idp=github` 302 to `…/realms/harness-bible/protocol/openid-connect/auth?…&kc_idp_hint=github&code_challenge=…&state=…&nonce=…` → provider → callback sets `hb.session`, creates `User` with `keycloakSub`, the `Identity` row (`GITHUB`), `Session.idpSessionId = sid`, an `AuthEvent sign_in`, lands on `next`; a second login with Google on the same e-mail lands on the same user (Keycloak linked it) with a second `Identity` row and `?linked=google` from the account page's `Link Google`; `/en/logout` → `Sign out` → the row is gone, Keycloak's session ended (a new `/api/v1/auth/login` asks the provider again); a Keycloak admin logout of the user (admin API) reaches `/backchannel-logout` and removes the rows; a callback replayed with the same `code` is refused; `?next=//evil.example` lands on `/en`.
6. Security headers: Playwright reads the CSP on `/en/ch/21/21.3` and confirms the theme script and Next's scripts carry the nonce, no console CSP violation on the reader, search, paths, marks and account pages (light and dark); `frame-ancestors` blocks an iframe test page.
7. Cookies: in production build (`next build && next start` with `NODE_ENV=production` and TLS terminated by a local proxy, or asserted through the `Set-Cookie` string): `__Host-hb.session; HttpOnly; Secure; SameSite=Lax; Path=/`; the dev build sets `hb.session` without `Secure`.
8. Rate limits: 11 `GET /api/v1/auth/login` in a minute from one IP → the 11th is 429 with `Retry-After`; `RateLimit-Remaining` decrements; `GET /api/v1/search` 121 times → 429.
9. Idempotency: two `POST` (on the first idempotent POST of Phase 2, or a test-only route behind `NODE_ENV=test`) with the same key → second carries `Idempotency-Replayed: true`; a different body → 422.
10. Audit: the `AuthEvent` rows of step 5 exist with hashed IPs and device summaries, no e-mail in `detail`; the 90-day sweep removes old rows.
11. Production boot: `NODE_ENV=production` with `AUTH_DEV_PROVIDER=1` or without `OPA_URL` refuses to start with a message naming the variable.
12. `git status` shows only: `infra/keycloak/**`, `docker-compose.yml` (keycloak service), `policies/**`, `lib/policy/*`, `lib/api/handler.ts` + tests, `lib/auth/{oidc,rules,session,link}.ts` + tests, `lib/schemas/{auth,api/**}.ts`, `lib/db/{client,security}.ts`, `lib/db/RAW_SQL.md`, `prisma/schema.prisma` + `prisma/migrations/…_security`, `lib/env.ts`, `.env.example`, `proxy.ts`, `next.config.ts`, `app/[lang]/layout.tsx` (nonce), `app/api/v1/**`, the server actions of paths, reader, marks, account and logout (the `requireAllowed` line), `package.json` (`openid-client`, `jose`, `concurrently`, scripts `policy:*`, `auth:kc`, `api:openapi`), `tests/{contract,integration}/**`, `.github/workflows/*` (audit, gitleaks, opa, contract), `architecture.md` § 1, § 2.2, § 3.4, § 5, § 9, § 10 (updated rows), `code-standards.md` (D10 note), and the tracker.

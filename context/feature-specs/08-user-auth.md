# 08 · User authentication — feature spec (SSO sign-in, sign-out, account settings)

Read `CLAUDE.md` and `context/ai-workflow-rules.md` before starting.

Source of truth for the screens: there is no login or settings screen in the UI package. `docs/design/screens/Account-Admin.html` (with `png/Account-Admin.png`) is the organisation admin's view (Phase 4) and fixes the vocabulary this spec reuses: the head row (`organisation account · admin view`, the name as `h1.h2`, a `dl` of `account` / `sign-in` `■ sso on · saml` / `residency` / `signed in as`), instruments with `inst-h` labels, the seats table (`member`, `email`, `role`, `sso` `■ LINKED` / `■ PENDING FIRST SIGN-IN`, `last active`), the Retention instrument (`LGPD`, `Request deletion`), the top bar's `Account` item. § 6 derives the sign-in page, the sign-out page and the user's settings page from that vocabulary and from `context/ui-context.md` (§ 8 instrument panel, § 9.1 buttons, § 9.2 forms and `Seg`, § 9.8 empty and notice states, § 9.10 interaction states, § 12 theme rule: `data-theme` on `<html>`, persisted per viewer, a Light / System / Dark control in Account settings). Governing context: `context/architecture.md` (§ 1 identity decision, § 3.4 "every endpoint requires a session unless marked public", § 4 accounts models `Organisation`, `User`, `Seat`, `Session`, § 7 account deletion 30 days after request with the ledger keeping a pseudonym), `context/code-standards.md` (`lib/auth/` holds the session helpers; `process.env` only in `lib/env.ts`; no API routes outside `app/api/v1/`; middleware checks at most that the session cookie exists; the URL holds view state; `localStorage` holds per-viewer conveniences only), `context/project-overview.md` (Phase 1 gate: 20 pilot accounts onboarded via SSO; individual accounts with a fixed small cap; LGPD retention). TRD § 7.7: the browser reaches `/login`, is sent to the identity provider, comes back with an id token and receives a session cookie.

Prerequisite specs: `04-content-domain-schema.md` § 4 (the tenant guard), `05-reader-paths.md` § 5.1 (the `getSession()` seam and `tenantOf`, which every page and action already calls; the development user), `07-bookmarks-notes.md` (the marks page and the sign-in notice that link to the account).

Scope: tracker unit 21 (the session half; the handler pipeline, OPA and the public content endpoints move to spec 09). Sign-in exclusively through SSO with Google or GitHub, the session cookie and its rows, sign-out, and the user's own settings page. Organisation SSO through customer identity providers (Keycloak brokering SAML/OIDC) is not built in this unit (§ 10, D1).

## 1. Purpose

A reader signs in with the Google or GitHub account they already have, in two clicks, and lands back where they were. The session is a cookie backed by a row the reader can see and revoke. Sign-out is a page, not a link, so nothing signs a reader out by accident. The account page shows who is signed in, the linked sign-ins, the open sessions, and the three preferences the product has (edition language, theme, shortcuts), and carries the LGPD deletion request. There are no passwords, no e-mail codes, no sign-up form: the identity provider is the whole of it.

## 2. Dependencies and order

| Needs | Why |
|---|---|
| Migration `0002_accounts` (done): `User`, `Session`, `Organisation`, `Seat` | the account rows; `Session` already has the TRD's shape |
| Migration `0005_identity` (this spec, § 4.3) | the link between a provider account and a `User`; session bookkeeping columns |
| OAuth clients: Google (OpenID Connect) and GitHub (OAuth 2, `read:user user:email`) | the two providers; one client id and secret each, per environment |
| `lib/env.ts` | five new variables (§ 5.6) |
| Chrome (done): `TopBar`, `Notice`, `InstrumentPanel`, `Field`, `Seg`, `Button`, `ConfirmDialog` | the pages are composed from them |
| The `getSession()` seam (05) | this unit replaces its body; its contract (`SessionUser`, `tenantOf`) stays |

Build order: 21a migration `0005_identity` + env → 21b `lib/auth/` (cookie, session rows, OAuth start and callback, identity linking rules) with tests → 21c the routes (`/api/v1/auth/*`), `getSession()` on the cookie, the dev provider → 21d the sign-in page, the sign-out page, the top-bar state and the redirects of the existing sign-in links → 21e the account page with its actions and the theme control → verification.

## 3. Routes and rendering

| Route | Behaviour |
|---|---|
| `/[lang]/login` | the sign-in page (§ 6.1); `?next=/en/ch/21/21.3` is where to return (same-origin path only, § 5.4); `?error=` names a failed attempt (§ 7); signed in already → redirect to `next` or `/[lang]` |
| `GET /api/v1/auth/{provider}` | `provider` ∈ `google`, `github`: writes the handshake cookie and redirects to the provider (`?next=` and `?intent=link` carried in the cookie); public, rate-limited 10/min per IP once the pipeline exists |
| `GET /api/v1/auth/{provider}/callback` | validates state, exchanges the code, resolves the identity (§ 5.3), creates the session, sets the cookie, redirects to `next`; on failure redirects to `/[lang]/login?error=…`; public |
| `GET /api/v1/auth/dev?email=` | development provider (§ 5.7): signs in as that user without a provider; absent in production |
| `/[lang]/logout` | the sign-out page (§ 6.2): a confirm with `Sign out` and `Sign out everywhere`; the actions revoke and redirect to `/[lang]`; signed out already → the "already signed out" state |
| `/[lang]/account` | the user's settings (§ 6.3); signed out → redirect to `/[lang]/login?next=/[lang]/account`; the org admin instruments of `Account-Admin` arrive in Phase 4 on the same route |
| `/[lang]/account?linked=github`, `?unlinked=`, `?saved=profile`, `?saved=preferences`, `?revoked=1`, `?error=` | outcomes of the page's actions, in the URL (the paths and marks pattern) |

Rendering: all three pages are RSC and dynamic (they read the cookie). The login page and the sign-out page have no `loading.tsx` (05 and 06's lesson). Metadata: `Sign in · The Harness Bible`, `Sign out · The Harness Bible`, `Account · The Harness Bible` (candidates); `robots: noindex` on all three; `alternates.languages`.

Middleware (`proxy.ts`): unchanged. The account page redirects in the page, not in middleware (code-standards: middleware touches no data; a cookie can exist and be expired).

Performance: `getSession()` is one indexed read of `Session` joined to `User` per request, memoised by React `cache` as today; `lastSeenAt` is written at most once an hour per session (§ 5.2). The OAuth callback makes two provider requests (token, profile) and one transaction.

## 4. Data contract

```ts
// lib/schemas/auth.ts
type Provider = "google" | "github";

interface SessionUser {                        // unchanged from 05, plus the session id
  readonly id: string; readonly organisationId: string | null; readonly role: Role;
  readonly displayName: string; readonly locale: string;
  readonly sessionId: string | null;           // null only for the development seam without a cookie (§ 5.7)
}

interface ProviderProfile {                    // what a provider handshake yields, after validation
  readonly provider: Provider;
  readonly providerAccountId: string;          // Google `sub`, GitHub numeric id as a string
  readonly email: string;                      // lower-cased
  readonly emailVerified: boolean;
  readonly name: string | null;
}

interface AccountData {                        // the account page
  readonly user: { readonly id: string; readonly email: string; readonly displayName: string; readonly role: Role; readonly locale: "en" | "pt"; readonly createdAt: Date; readonly organisation: { readonly name: string } | null };
  readonly identities: ReadonlyArray<{ readonly provider: Provider; readonly email: string; readonly linkedAt: Date; readonly lastSignInAt: Date }>;
  readonly sessions: ReadonlyArray<{ readonly id: string; readonly current: boolean; readonly device: string; readonly createdAt: Date; readonly lastSeenAt: Date; readonly expiresAt: Date }>;
  readonly marks: { readonly bookmarks: number; readonly notes: number };
  readonly release: { readonly id: ReleaseId; readonly gitSha: string };
  readonly sourceLang: Lang;
}
```

Zod: `ProviderSchema`, `NextPathSchema` (§ 5.4), `ProviderProfileSchema`, `DisplayNameSchema = z.string().trim().min(1).max(60)`, `PreferenceLocaleSchema = z.enum(["en", "pt"])`, `AccountDataSchema`. Google's id-token claims and GitHub's `/user` and `/user/emails` responses are validated with their own schemas at the boundary (code-standards: no raw JSON downstream).

### 4.1 Rules (pure, `lib/auth/rules.ts`)

- `resolveIdentity(profile, existing: { byIdentity: User | null; byEmail: User | null })` → `{ action: "sign-in", userId }` | `{ action: "link-existing", userId }` | `{ action: "create" }` | `{ action: "refuse", reason: "email-unverified" | "deleted" | "not-invited" }` (§ 5.3, D4).
- `allowedEmail(email, allowList)`: the pilot allow-list (§ 5.6); an empty list allows everyone.
- `safeNext(candidate, locale)`: a same-origin path under `/en/` or `/pt/`, else `/${locale}` (§ 5.4).
- `deviceOf(userAgent)`: `Edge on Windows`, `Safari on iPhone`, `Chrome on Android`, `Firefox on macOS`, else `Unknown browser` (candidates), for the sessions table; a small regex table, not a library.
- `shouldTouch(lastSeenAt, now)`: true when older than one hour (§ 5.2).
- `sessionExpiry(now)`: `now + 30 d`; `shouldExtend(expiresAt, now)`: true when less than 29 days remain (rolling expiry once a day).

### 4.2 Cookies

| Cookie | Value | Attributes |
|---|---|---|
| `hb.session` | 32 random bytes, base64url; the row holds `sha256(token)` as `Session.id` | `HttpOnly; Secure` (not in development on `http://localhost`); `SameSite=Lax`; `Path=/`; `Max-Age` 30 days, rewritten when extended |
| `hb.oauth` | JSON `{ provider, state, codeVerifier, next, intent, locale }` | `HttpOnly; Secure; SameSite=Lax; Path=/api/v1/auth; Max-Age=600`; deleted by the callback |

`SameSite=Lax` lets the provider's redirect back to `/callback` carry the cookie. No token, id or e-mail is ever in a URL the app builds, except the provider's own authorisation URL.

### 4.3 Schema change (migration `0005_identity`)

```prisma
enum IdentityProvider { GOOGLE GITHUB }

model Identity {
  id                String           @id @default(uuid())
  userId            String
  user              User             @relation(fields: [userId], references: [id])
  provider          IdentityProvider
  providerAccountId String
  email             String           // as the provider reported it at the last sign-in, lower-cased
  createdAt         DateTime         @default(now())
  lastSignInAt      DateTime         @default(now())

  @@unique([provider, providerAccountId])
  @@index([userId])
}

model Session {
  id           String   @id                     // sha256 of the cookie token, hex
  userId       String
  user         User     @relation(fields: [userId], references: [id])
  expiresAt    DateTime
  idpSessionId String?                          // Keycloak later (D1)
  createdAt    DateTime @default(now())
  lastSeenAt   DateTime @default(now())         // new
  device       String   @default("")            // new: deviceOf(user agent) at sign-in

  @@index([userId])
  @@index([expiresAt])                          // new: the sweep
}

model User { …; identities Identity[]; deletionRequestedAt DateTime? }   // new column; `deletedAt` stays the hard-delete marker
```

`Identity` is user-scoped for the tenant guard (`userId`), as `Session` is. `User.email` stays unique and is the linking key (D4). `User.locale` holds `en-GB` / `pt-BR` as today (05); the account page maps it to `en` / `pt`. Written by hand as before (`prisma migrate diff` for the additive part is safe here; there is no generated column in these tables); `RAW_SQL.md` lists nothing new unless the diff needs cleaning.

## 5. Backend

### 5.1 OAuth clients (`lib/auth/oauth.ts`)

> **Amended by `09-keycloak-oauth.md` (2026-09-22)**: the providers are reached through Keycloak, which brokers Google and GitHub; the application is one OIDC client (`lib/auth/oidc.ts`, `openid-client` + `jose`), the routes are `/api/v1/auth/login?idp=` and `/api/v1/auth/callback`, and account linking is Keycloak's first-broker-login flow (09 § 3.2, § 4). The two buttons, the pages, the cookies, the `Session` rows and the dev provider of this spec stand. The table below records the direct-to-provider design that 09 replaced.

Library: `arctic` (OAuth 2 / OIDC clients with PKCE, no framework coupling; D2). One client per provider built from `env`:

| Provider | Authorisation | Scopes | Profile |
|---|---|---|---|
| Google | OpenID Connect with PKCE; `prompt=select_account` | `openid email profile` | the id token's `sub`, `email`, `email_verified`, `name` (decoded and validated; the signature is verified by the token exchange over TLS with the client secret, so no JWKS fetch is needed) |
| GitHub | OAuth 2 with `state` | `read:user user:email` | `GET https://api.github.com/user` (`id`, `name`, `login`) and `GET /user/emails` (the `primary` and `verified` entry; refused when none) |

Redirect URIs: `${APP_URL}/api/v1/auth/google/callback` and `…/github/callback`, registered at each provider per environment.

`startSignIn(provider, { next, intent, locale })` returns the provider URL and the `hb.oauth` payload; `finishSignIn(provider, { code, state }, cookie)` validates `state`, exchanges the code, fetches the profile and returns a `ProviderProfile`. Both take an injected `fetch`/client so tests run without the network.

### 5.2 Sessions (`lib/auth/session.ts`)

| Function | Effect |
|---|---|
| `createSession(userId, device)` | random token; insert `Session { id: sha256(token), expiresAt: +30 d, device }` inside the user's tenant context; returns the token for the cookie |
| `getSession()` (replaces the 05 body; React `cache`) | read `hb.session`; no cookie → the development seam (§ 5.7) or null; hash → `Session` with `User` (`deletedAt` null; `expiresAt > now`), inside `withTenant` of the row's user (the guard needs a context: the lookup runs with `{ userId: null }` on the `Session` model by primary key, listed as the one guard exemption, or the model is read with `$allOperations` bypass for `findUnique` by id, D6); touches `lastSeenAt` and extends `expiresAt` per § 4.1, at most once an hour; returns `SessionUser` with `sessionId` |
| `revokeSession(user, sessionId)` | delete the row (own sessions only, by the tenant context) |
| `revokeOtherSessions(user, currentId)` | `deleteMany` where `id != currentId` |
| `revokeAllSessions(user)` | `deleteMany` |
| `sweepExpiredSessions()` | `deleteMany` where `expiresAt < now`; called by the seed and by a `npm run auth:sweep` script (a cron later) |

The cookie is set and cleared only in route handlers and server actions (`cookies()` from `next/headers`); components never touch it.

### 5.3 Identity resolution (`lib/auth/link.ts`)

Given a `ProviderProfile`, inside a transaction:

1. `emailVerified` false → refuse `email-unverified` (the provider must vouch for the address, or two people could share one account).
2. Allow-list (§ 5.6) refuses `not-invited`.
3. `Identity` by `(provider, providerAccountId)` exists → its user; `deletedAt` or `deletionRequestedAt` set → refuse `deleted`; update `lastSignInAt` and `email`; **sign in**.
4. Else `User` by `email` exists → same deletion check; create the `Identity` on that user (**link-existing**: the reader signed in with the other provider before, or was invited by e-mail later).
5. Else **create**: `User { email, displayName: name ?? local part of the email, role: READER, organisationId: null, locale: from the request locale }` and the `Identity`.
6. `intent=link` (from the account page, signed in as `U`): the profile must resolve to no user or to `U` itself; another user → refuse `linked-elsewhere`; the `Identity` is created on `U`.

The rules are pure in `lib/auth/rules.ts`; `link.ts` runs them against the rows. Roles above `READER`, organisations and seats are assigned elsewhere (Phase 4 admin; D5).

### 5.4 The `next` path

`safeNext` accepts only a path starting with `/en/` or `/pt/` (or exactly `/en`, `/pt`) that does not start with `//` or contain `\`; everything else becomes `/{locale}`. The callback never redirects to an absolute URL.

### 5.5 Server actions

Sign-out page (`app/[lang]/logout/actions.ts`, form actions): `signOut` (revoke the current session, clear the cookie, redirect to `/[lang]`), `signOutEverywhere` (revoke all, clear, redirect).

Account page (`app/[lang]/account/actions.ts`, form actions, zod → session → tenant context → redirect with the outcome):

| Action | Form fields | Effect |
|---|---|---|
| `updateProfile` | `displayName`, `locale` | `User.displayName`; `?saved=profile` |
| `updatePreferences` | `locale` (`en` / `pt`) | `User.locale`; redirect to `/{newLocale}/account?saved=preferences` (the page changes edition with the preference) |
| `revokeSession` | `sessionId` | own session only; when it is the current one, behaves as `signOut`; `?revoked=1` |
| `revokeOtherSessions` | — | `?revoked=1` |
| `unlinkIdentity` | `provider` | refused when it is the only identity (`?error=last-identity`); `?unlinked={provider}` |
| `requestDeletion` | `confirm` = the literal `delete` (typed) | `deletionRequestedAt = now`, every session revoked, cookie cleared, redirect to `/[lang]/login?notice=deletion-requested`; the hard delete after 30 days is a later job (architecture § 7, with the ledger pseudonym in Phase 4) |

Linking a provider is not an action: the `Link Google` / `Link GitHub` buttons are links to `/api/v1/auth/{provider}?intent=link&next=/[lang]/account`.

Theme and shortcuts are not actions: they are per-viewer `localStorage` values (ui-context § 12; `hb.theme`, and the existing `hb.keys`), set by a client control (§ 6.3).

### 5.6 Environment (`lib/env.ts`)

| Variable | Use |
|---|---|
| `APP_URL` | absolute origin for the redirect URIs (`http://localhost:3000` in development) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | the Google OAuth client |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | the GitHub OAuth app |
| `AUTH_ALLOWED_EMAILS` | optional, comma-separated e-mails and `@domain` entries; the pilot's 20 accounts; empty or unset allows everyone (D7) |
| `AUTH_DEV_PROVIDER` | `"1"` enables `/api/v1/auth/dev` (§ 5.7); ignored under `NODE_ENV=production` |
| `DEV_SESSION_USER_ID` | **removed** (D3) |

A provider whose id or secret is unset is hidden from the sign-in page and its routes answer 404; both unset in production is a boot error.

### 5.7 Development provider

`GET /api/v1/auth/dev?email=dev@harness-bible.local&next=` creates the session for the `User` with that e-mail (creating the user as `READER` when absent, `displayName` from the local part), sets the cookie and redirects. It exists only when `AUTH_DEV_PROVIDER=1` and `NODE_ENV !== "production"`; the seed's development user is reached this way, and Playwright signs in through it. Without a cookie `getSession()` returns null in every environment: the `DEV_SESSION_USER_ID` fallback goes (D3), and the tracker's "remove the line from `.env` for the signed-out state" becomes "open `/[lang]/logout`".

## 6. Layout and components

Components in `components/auth/` (sign-in and sign-out) and `components/account/` (settings). Server unless marked.

### 6.1 `SignInPage` (`/[lang]/login`)

A centred column (`main.auth`, `max-width: 520px`, `margin: 48px auto`, padding 16px on phones), one instrument:

```
┌ topbar (Sign in item current) ─────────────────────────────────┐
│                                                                │
│        sign in · release 2026.09                               │
│        Sign in to the Harness Bible                            │
│        Progress, bookmarks and notes are kept per account      │
│        and follow you across devices and editions.             │
│        ┌ SIGN-IN · sso ─────────────────── no passwords ┐      │
│        │ [ Continue with Google            google ]     │      │
│        │ [ Continue with GitHub            github ]     │      │
│        │ By continuing you accept the retention policy… │      │
│        └────────────────────────────────────────────────┘      │
│        ✢ You will return to 21.3 · Worked numbers  (when next) │
└ statusbar: sign in | EN · source EN | pinned release | loaded ──┘
```

- Head: `.cap` `sign in · release {id}`, `h1.h1` `Sign in to the Harness Bible`, `.muted.paths-blurb` the sentence.
- `InstrumentPanel` label `Sign-in` · meta `sso` · timestamp `no passwords` (candidates): a `.col` of one `Button` per enabled provider (`href` to `/api/v1/auth/{provider}?next=…`, class `.rail-btn.auth-btn`, label `Continue with Google` / `Continue with GitHub`, `.meta` `google` / `github`); the first is the view's one primary (`variant="primary"` on Google; D8). Under them `.help` `By continuing you accept the retention policy of this account: assistant conversations 30 days as text, then metadata; identity kept for provenance with consent.` (candidate) with the words `retention policy` linking to `/[lang]/account#retention` once it exists (a plain span until then).
- `next` present and resolving to a section: an `.empty` inline row (the `filters-note` style of 06) `✢` `You will return to {id} · {title}` (candidate); otherwise `You will return to the book` when `next` is set, nothing when it is not.
- `?error=` → a `Notice` above the instrument (§ 7); `?notice=deletion-requested` → a `Notice` `Deletion requested` / `Your sessions were closed. The account is deleted after 30 days; write to support to cancel before then.` (candidate).
- The status bar's first cell reads `sign in`.

The page is not shown to a signed-in reader: the route redirects to `next`.

### 6.2 `SignOutPage` (`/[lang]/logout`)

Same column. Signed in: `InstrumentPanel` label `Sign out` · meta `{displayName}`: `p.ui` `Sign out of the Harness Bible on this device?` (candidate) and a `.row` with `Button` `Sign out` (form → `signOut`) and `Button variant="quiet"` `Sign out everywhere` (form → `signOutEverywhere`, `.meta` `{n} sessions`), and a `Cancel` link back to `next` or `/[lang]`. Signed out: the `Empty` `You are signed out.` with the action `Sign in` (a link to `/[lang]/login`). Neither variant needs JavaScript.

### 6.3 `AccountPage` (`/[lang]/account`)

Desktop (1440): `main.account` with the paths page's `28px 40px 32px` padding and 24px gaps; the `Account-Admin` head row (name left, a `dl` of four facts right, aligned to the bottom); then a `repeat(2, minmax(0,1fr))` grid of instruments; then the status bar.

```
┌ topbar (Account current) ────────────────────────────────────────────────────┐
│ account · individual                     account       sign-in    signed in as│
│ Andre Ponto                              a1b2·c3d4     ■ google   andre@… ·   │
│                                                        ■ github   reader      │
│ ┌ PROFILE ─────────────── member since 21 Sep ┐ ┌ SESSIONS · 2 open ────────┐ │
│ │ display name [Andre Ponto        ]           │ │ device  signed in  last  ▸│ │
│ │ e-mail        andre@… (from google)          │ │ Edge on Windows · this…   │ │
│ │ role          reader · set by the org admin  │ │ Safari on iPhone   [Sign out]│
│ │                              [Save profile]  │ │            [Sign out everywhere]│
│ └──────────────────────────────────────────────┘ └───────────────────────────┘ │
│ ┌ PREFERENCES ─ per account · per device ──────┐ ┌ LINKED SIGN-INS · 2 ──────┐ │
│ │ edition language  [EN | PT]  (account)       │ │ ■ google  andre@…  linked… │ │
│ │ theme     [Light | System | Dark] (device)   │ │ ■ github  andre@…  [Unlink]│ │
│ │ shortcuts [On | Off]              (device)   │ │ [Link GitHub] (when absent)│ │
│ └──────────────────────────────────────────────┘ └───────────────────────────┘ │
│ ┌ YOUR MARKS · 12 bookmarks · 9 notes → /marks ┐ ┌ RETENTION · LGPD ─────────┐ │
│ └──────────────────────────────────────────────┘ │ kv rows … [Request deletion]│
│                                                  └───────────────────────────┘ │
└ statusbar: account · andre@… | EN · source EN | pinned release | loaded ───────┘
```

- **Head** (`AccountHead`): `.cap` `account · individual` or `account · {organisation}` (candidate), `h1.h2` `{displayName}`; `dl.account-facts` (four `.col` cells as the screen): `account` `.tex` `{id as 4·4 of the uuid's first 8}`, `sign-in` one `StatusMark ok` per linked provider (`google`, `github`), `signed in as` `{email} · {role}`, `member since` `{day-month-year}`. Since 2026-10-12, for a curator or an organisation admin, a third cell: the `Book management` button to `/[lang]/account/book`, which holds Book status, the curator roster and the audit export (feature-specs/47 § 4).
- **`ProfileInstrument`** (`Profile` · timestamp `member since {date}`): a form (`updateProfile`) with `Field` `display name` (`.input`, 60 chars, counter) and read-only `dl.kv` rows `e-mail` `{email}` + `.meta` `from {provider}`, `role` `{role}` + `.meta` `set by the organisation admin` (candidate), or, where the development provider is on, a switch of the roles (`DevRoleSwitch`, feature-specs/29 § 16); footer `Save profile` (`Button size="sm"`). Errors inline (`Field error`).
- **`PreferencesInstrument`** (`Preferences` · meta `per account · per device`): three `Seg` rows with a `.flabel` and a `.meta` scope note: `edition language` `EN | PT` (a form per segment posting `updatePreferences`; `account`), `theme` `Light | System | Dark` (client `ThemeControl`, `device`), `shortcuts` `On | Off` (client `ShortcutsControl` on `hb.keys`, `device`). `ThemeControl` sets `data-theme` on `<html>` and writes `hb.theme` in try/catch; the root layout gains a 6-line inline script before `<body>` paints that reads `hb.theme` and sets `data-theme` (no flash of the wrong theme; the only inline script in the app, listed in ui-context § 12).
- **`SessionsInstrument`** (`Sessions` · meta `{n} open`): `table.tbl.small` `device` / `signed in` / `last seen` / `expires` / action; the current row carries `StatusMark ok` `this session`; each other row a form `Sign out` (`revokeSession`); footer `Sign out everywhere` (quiet, `revokeOtherSessions`, disabled when only one). Rows are at most 20 (the newest; more are a note `{k} older sessions not shown`, candidate).
- **`IdentitiesInstrument`** (`Linked sign-ins` · meta `{n}`): one row per identity: `StatusMark ok` `{provider}`, `.small` `{email}`, `.meta` `linked {date} · last used {date}`, `Unlink` (quiet form, `unlinkIdentity`, hidden when it is the only one); under them a `Button` `Link Google` / `Link GitHub` for each provider not yet linked (a link with `intent=link`).
- **`MarksSummary`**: the `YourMarks` cells of 05 reused with counts and links to `/[lang]/marks`.
- **`RetentionInstrument`** (`Retention` · meta `LGPD` · timestamp `policy v1.0`, `id="retention"`): the screen's `dl.kv` rows (`assistant conversations` `text 30 days`, `thereafter` `metadata only`, `contributor identity` `for provenance, with consent`, `saved lab runs` `until a member deletes them`) and the line `Deletion is on request. Each request is a record in the audit chain.`; `Request deletion` (`Button variant="destructive" size="sm"`) opens a `ConfirmDialog` variant with a typed confirmation: `Delete this account?` / `Sessions close now; the account and its marks are deleted after 30 days. Type delete to confirm.` (candidate), a `.input.mono` bound to the form field `confirm`, `Cancel`, destructive `Request deletion` (the dialog's form posts `requestDeletion`; `ConfirmDialog` gains an optional `children` slot for the input).
- Outcome line: `?saved=` / `?revoked=` / `?linked=` / `?unlinked=` → `Notice` `Saved.` / `Session signed out.` / `{Provider} linked.` / `{Provider} unlinked.`; `?error=` → `ErrorBox` (§ 7).
- Status bar: `account · {email}` | `{lang} · source {sourceLang}` | `pinned release {id}` | `loaded {s} s`.

### 6.4 Chrome and existing links

- **`TopBar`**: takes `session: { displayName } | null`; signed out the end cluster shows `Sign in` linking to `/[lang]/login?next={current path}`; signed in it shows `Account` as today (`aria-current="page"` on the account page). Every page passes `user` from `getSession()` (the reader, paths, search, marks and home pages already call it).
- **Sign-in notice** (05 § 6.2, used by paths and marks): its `Account` link becomes `Sign in` to `/[lang]/login?next=…`.
- **Book Home hero**: the signed-out variant gains nothing new (the top-bar item is enough; D9).

### 6.5 Responsive

- `< 1200px`: `.account-grid` one column.
- `< 1000px`: `.account-head` stacks (name, then the facts as a two-column `dl`).
- `< 768px` (phone): padding 16px; the sessions table drops the `expires` column (`.desktop-only` cell); buttons 44px; the sign-in column full width. No horizontal overflow at 390.

### 6.6 New composition classes (`globals.css`, then ui-context § 9.9)

| Class | Rule | Used by |
|---|---|---|
| `.auth` | `max-width: 520px; margin: 48px auto; padding: 0 16px; display: flex; flex-direction: column; gap: 20px` | sign-in, sign-out |
| `.auth-btn` | `.rail-btn` with `min-height: 44px` | provider buttons |
| `.account` | `flex: 1 1 auto; padding: 28px 40px 32px; display: flex; flex-direction: column; gap: 24px` | account page |
| `.account-head` | `display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 48px; align-items: end` | head row |
| `.account-facts` | `display: flex; gap: 28px; margin: 0` with `dt.cap` over `dd` | the four facts |
| `.account-grid` | `display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 24px; align-items: start` | instruments |
| `.pref-row` | `.between` with `min-height: 40px; gap: 16px` and `.flabel` left, `Seg` + `.meta` right | preferences |
| `.sessions-table td` | vertical alignment and the 28px quiet button | sessions |

## 7. States

| State | Render |
|---|---|
| Signed out, any page | top bar `Sign in`; `/account` redirects to login with `next` |
| Login, no provider configured | the instrument shows an `Empty` `No sign-in provider is configured.` (candidate) + `.muted` the two env names; production boot refuses this |
| Login `?error=state` | `Notice` `Sign-in did not complete` / `The sign-in took too long or the browser lost its place. Try again.` (candidates) |
| `?error=denied` | `You cancelled at the provider. Nothing was changed.` |
| `?error=email` | `The provider did not confirm your e-mail address. Verify it there, then try again.` |
| `?error=not-invited` | `This e-mail is not on the pilot list. Ask your organisation admin for an invitation.` |
| `?error=deleted` | `This account is pending deletion. Write to support to cancel the request.` |
| `?error=provider` | `The provider did not answer. Try again in a minute.` |
| `?error=linked-elsewhere` (account page) | `ErrorBox` `That {provider} account is linked to another user.` |
| `?error=last-identity` | `ErrorBox` `Keep at least one sign-in linked.` |
| Session expired mid-visit | the next request finds no valid row: pages render signed out; a form action answers `NO_SESSION` and redirects to login with `next` |
| Account pending deletion | sign-in refused (`deleted`); rows still exist until the hard delete |
| Dev provider in production | 404 |
| Loading | none (dynamic pages render in one pass) |
| Error | `app/[lang]/account/error.tsx` as in 02 § 7; the auth routes answer a redirect to `?error=provider` on any exception and log the trace id |

## 8. Strings

Keys under `auth.*` (sign-in and sign-out), `account.*`, and `chrome.signIn`. PT values marked *candidate* need Andre's confirmation.

| Key | EN | PT |
|---|---|---|
| `chrome.signIn` | Sign in | Entrar *(candidate)* |
| `auth.metaTitle` · `.cap` · `.title` · `.blurb` | Sign in · The Harness Bible · sign in · release {id} · Sign in to the Harness Bible · Progress, bookmarks and notes are kept per account and follow you across devices and editions. | Entrar · The Harness Bible · entrar · release {id} · Entrar na Harness Bible · Progresso, favoritos e notas ficam na conta e acompanham você entre dispositivos e edições. *(candidate)* |
| `auth.panel.label` · `.meta` · `.stamp` · `.google` · `.github` · `.retention` · `.retentionLink` | Sign-in · sso · no passwords · Continue with Google · Continue with GitHub · By continuing you accept the retention policy of this account: assistant conversations 30 days as text, then metadata; identity kept for provenance with consent. · retention policy | Entrar · sso · sem senhas · Continuar com Google · Continuar com GitHub · Ao continuar você aceita a política de retenção desta conta: conversas com o assistente por 30 dias como texto, depois só metadados; identidade mantida para proveniência, com consentimento. · política de retenção *(candidate)* |
| `auth.return.section` · `.book` | You will return to {id} · {title} · You will return to the book | Você voltará para {id} · {title} · Você voltará para o livro *(candidate)* |
| `auth.empty.none` · `.hint` | No sign-in provider is configured. · Set GOOGLE_CLIENT_ID or GITHUB_CLIENT_ID and their secrets. | Nenhum provedor de login está configurado. · Defina GOOGLE_CLIENT_ID ou GITHUB_CLIENT_ID e seus segredos. *(candidate)* |
| `auth.error.title` · `.state` · `.denied` · `.email` · `.notInvited` · `.deleted` · `.provider` | Sign-in did not complete · The sign-in took too long or the browser lost its place. Try again. · You cancelled at the provider. Nothing was changed. · The provider did not confirm your e-mail address. Verify it there, then try again. · This e-mail is not on the pilot list. Ask your organisation admin for an invitation. · This account is pending deletion. Write to support to cancel the request. · The provider did not answer. Try again in a minute. | O login não foi concluído · O login demorou demais ou o navegador perdeu o ponto. Tente novamente. · Você cancelou no provedor. Nada foi alterado. · O provedor não confirmou seu e-mail. Verifique lá e tente novamente. · Este e-mail não está na lista do piloto. Peça um convite ao administrador da sua organização. · Esta conta está com exclusão pendente. Escreva para o suporte para cancelar o pedido. · O provedor não respondeu. Tente novamente em um minuto. *(candidate)* |
| `auth.notice.deletionTitle` · `.deletion` | Deletion requested · Your sessions were closed. The account is deleted after 30 days; write to support to cancel before then. | Exclusão solicitada · Suas sessões foram encerradas. A conta é excluída após 30 dias; escreva para o suporte para cancelar antes disso. *(candidate)* |
| `auth.out.metaTitle` · `.label` · `.question` · `.confirm` · `.everywhere` · `.sessions` · `.cancel` · `.already` · `.signIn` | Sign out · The Harness Bible · Sign out · Sign out of the Harness Bible on this device? · Sign out · Sign out everywhere · {n, plural, one {# session} other {# sessions}} · Cancel · You are signed out. · Sign in | Sair · The Harness Bible · Sair · Sair da Harness Bible neste dispositivo? · Sair · Sair de todos os dispositivos · {n, plural, one {# sessão} other {# sessões}} · Cancelar · Você saiu. · Entrar *(candidate)* |
| `auth.statusbar.in` · `.out` | sign in · sign out | entrar · sair *(candidate)* |
| `account.metaTitle` · `.cap.individual` · `.cap.org` · `.facts.account` · `.facts.signIn` · `.facts.signedInAs` · `.facts.since` | Account · The Harness Bible · account · individual · account · {name} · account · sign-in · signed in as · member since | Conta · The Harness Bible · conta · individual · conta · {name} · conta · login · conectado como · membro desde *(candidate)* |
| `account.role.READER` … `.ORG_ADMIN` | reader · builder · contributor · curator · admin | leitor · construtor · contribuidor · curador · admin *(candidate)* |
| `account.profile.label` · `.since` · `.displayName` · `.email` · `.emailFrom` · `.role` · `.roleNote` · `.save` · `.nameError` | Profile · member since {date} · display name · e-mail · from {provider} · role · set by the organisation admin · Save profile · 1 to 60 characters | Perfil · membro desde {date} · nome de exibição · e-mail · de {provider} · papel · definido pelo administrador da organização · Salvar perfil · de 1 a 60 caracteres *(candidate)* |
| `account.prefs.label` · `.meta` · `.language` · `.theme` · `.shortcuts` · `.scopeAccount` · `.scopeDevice` · `.light` · `.system` · `.dark` · `.on` · `.off` | Preferences · per account · per device · edition language · theme · shortcuts · account · device · Light · System · Dark · On · Off | Preferências · por conta · por dispositivo · idioma da edição · tema · atalhos · conta · dispositivo · Claro · Sistema · Escuro · Ligados · Desligados *(candidate)* |
| `account.sessions.label` · `.open` · `.device` · `.signedIn` · `.lastSeen` · `.expires` · `.current` · `.signOut` · `.everywhere` · `.older` | Sessions · {n} open · device · signed in · last seen · expires · this session · Sign out · Sign out everywhere · {k} older sessions not shown | Sessões · {n} abertas · dispositivo · entrou · visto por último · expira · esta sessão · Sair · Sair de todos os dispositivos · {k} sessões mais antigas não exibidas *(candidate)* |
| `account.device.edgeWindows` … `.unknown` | Edge on Windows · Chrome on Windows · Firefox on Windows · Safari on macOS · Chrome on macOS · Safari on iPhone · Safari on iPad · Chrome on Android · Unknown browser | Edge no Windows · … · Navegador desconhecido *(candidate; keys carry the pairs, the rule maps a user agent to a key)* |
| `account.identities.label` · `.linked` · `.unlink` · `.link` | Linked sign-ins · linked {date} · last used {date} · Unlink · Link {provider} | Logins vinculados · vinculado em {date} · usado por último em {date} · Desvincular · Vincular {provider} *(candidate)* |
| `account.provider.google` · `.github` | Google · GitHub | Google · GitHub |
| `account.retention.label` · `.meta` · `.policy` · `.conversations` · `.conversationsValue` · `.thereafter` · `.thereafterValue` · `.identity` · `.identityValue` · `.runs` · `.runsValue` · `.note` · `.request` | Retention · LGPD · policy v1.0 · assistant conversations · text 30 days · thereafter · metadata only · contributor identity · for provenance, with consent · saved lab runs · until a member deletes them · Deletion is on request. Each request is a record in the audit chain. · Request deletion | Retenção · LGPD · política v1.0 · conversas com o assistente · texto por 30 dias · depois · só metadados · identidade do contribuidor · para proveniência, com consentimento · execuções de lab salvas · até que um membro as exclua · A exclusão é feita a pedido. Cada pedido é um registro na cadeia de auditoria. · Solicitar exclusão *(candidate)* |
| `account.delete.title` · `.body` · `.field` · `.word` · `.cancel` · `.confirm` · `.mismatch` | Delete this account? · Sessions close now; the account and its marks are deleted after 30 days. Type delete to confirm. · type delete · delete · Cancel · Request deletion · Type delete exactly. | Excluir esta conta? · As sessões são encerradas agora; a conta e suas marcas são excluídas após 30 dias. Digite delete para confirmar. · digite delete · delete · Cancelar · Solicitar exclusão · Digite delete exatamente. *(candidate)* |
| `account.notice.title` · `.saved` · `.revoked` · `.linked` · `.unlinked` | Done · Saved. · Session signed out. · {provider} linked. · {provider} unlinked. | Feito · Salvo. · Sessão encerrada. · {provider} vinculado. · {provider} desvinculado. *(candidate)* |
| `account.error.title` · `.linkedElsewhere` · `.lastIdentity` · `.session` · `.failed` · `.pageTitle` · `.body` · `.retry` | The change was not made · That {provider} account is linked to another user. · Keep at least one sign-in linked. · Sign in again to change the account. · The change did not save. Retry. · Account did not load · Trace {traceId}. Retry, or reload the page. · Retry | A alteração não foi feita · Essa conta {provider} está vinculada a outro usuário. · Mantenha ao menos um login vinculado. · Entre novamente para alterar a conta. · A alteração não foi salva. Tente novamente. · A conta não carregou · Rastreio {traceId}. Tente novamente ou recarregue a página. · Tentar novamente *(candidate)* |
| `account.statusbar` | account · {email} | conta · {email} *(candidate)* |
| `paths.signIn.account` (changed) · `paths.signIn.body` (changed) | Sign in · Reading paths work without an account; progress and marks need one. | Entrar · … *(unchanged body; candidate)* |

`tests/messages.test.ts` parity applies.

## 9. Keyboard, accessibility

- The provider buttons are links (`a.btn`) with visible labels; the page has one `h1`; the instrument is a labelled region.
- The sign-out page and every account action work without JavaScript (forms); the theme and shortcut controls are the only client-side settings and degrade to "System" / "On" without JavaScript (their `Seg` is disabled with a `title` `needs JavaScript`, candidate).
- `Seg` controls are `role="group"` with `aria-pressed` buttons (existing primitive); the sessions table has `th` headers and the current row's mark carries a text label.
- The deletion dialog: focus on the input, `esc` cancels, the confirm button disabled until the word matches (server-checked too).
- The theme script sets `data-theme` before paint; `color-scheme` follows (ui-context § 12).
- axe AA zero violations on `/en/login`, `/en/logout`, `/en/account`, `/pt/account`.

## 10. Out of scope for this unit

- Organisation SSO through customer identity providers (Keycloak brokering SAML/OIDC), organisation onboarding, `Organisation.ssoIssuer`, seat assignment, roles above `READER`, the org admin instruments of `Account-Admin` (Phase 4; D1, D5).
- The handler pipeline (`lib/api/handler.ts`), OPA and the public content endpoints (spec 09); the auth routes are written so they wrap in it when it lands.
- Passwords, magic links, passkeys, MFA (the provider's job), e-mail change (the provider's e-mail is the account e-mail), avatars.
- The hard delete 30 days after `deletionRequestedAt` and its ledger record (a job with the ledger, Phase 4); until then the row and its marks stay.
- Rate limiting of the auth routes beyond what the pipeline adds (spec 09).
- Session lists longer than 20, IP addresses and geolocation in the sessions table.

## 11. Decisions this spec needs

| # | Decision | Recommendation |
|---|---|---|
| D1 | Sign-in exclusively through Google or GitHub. | Yes, as Andre stated on 2026-09-22. *Superseded by 09 D1 (2026-09-22): Keycloak brokers the two providers in Phase 1; the sign-in stays Google or GitHub only.* |
| D2 | OAuth library. | *Superseded by 09 D2: `openid-client` + `jose` against Keycloak. The original recommendation (`arctic` direct to the providers, no Auth.js because its v5 beta does not declare Next 16 and its adapter schema would replace `Session`) is kept here for the record.* |
| D3 | The development seam. | Replace `DEV_SESSION_USER_ID` with the dev provider route (`/api/v1/auth/dev`, guarded by `AUTH_DEV_PROVIDER=1` and not production): one code path for sessions everywhere; Playwright signs in through it. Routine, stated. |
| D4 | Identity linking. | By verified e-mail: an identity reaching a `User` with the same e-mail links to it; an unverified e-mail is refused. Routine, stated (the alternative, always creating a new user, would fork one person into two accounts). |
| D5 | Organisations and roles at sign-in. | Every new sign-in is an individual `READER` with `organisationId` null; roles and seats are assigned by the org admin (Phase 4) or by hand in the pilot. Routine, stated. |
| D6 | Reading the session row. | `Session.findUnique` by primary key runs with a `{ userId: null }` context as the tenant guard's one documented exemption (the row itself names the user), recorded in `lib/db/client.ts` and `RAW_SQL.md`'s neighbour note. Routine, stated. |
| D7 | Pilot allow-list. | `AUTH_ALLOWED_EMAILS` (e-mails and `@domains`), empty allows everyone; the pilot sets it. Routine. |
| D8 | Primary button. | Google is the primary (`btn-p`), GitHub default: one warm primary per view. Routine. |
| D9 | Where sign-in is offered. | The top bar's `Sign in` item, the sign-in notices on paths and marks, and the redirect from `/account`; no modal, no hero button. Routine. |
| D10 | Session lifetime. | 30 days rolling, extended once a day, `lastSeenAt` written at most hourly; sweep by script. Routine. |

## 12. Verification (in addition to `ai-workflow-rules.md` § 7)

1. Migration `0005_identity` applies; `prisma generate` exposes `Identity` and the new `Session` columns; `.env.example` documents the five variables; `DEV_SESSION_USER_ID` is gone from `lib/env.ts`, `.env.example` and the tracker's notes.
2. tsc, lint, `npm test` (rules: `resolveIdentity` for every branch of § 5.3 including `intent=link`, `allowedEmail` with e-mails and domains, `safeNext` refusing `//evil`, `https://…`, `/api/…` and accepting `/pt/ch/21/21.3`, `deviceOf` on eight user agents, `shouldTouch` / `shouldExtend`; OAuth: `startSignIn` builds the Google URL with PKCE and the GitHub URL with state, `finishSignIn` with a fake exchange returns a validated profile and refuses a state mismatch and an unverified GitHub e-mail; integration: `createSession` → `getSession()` with the cookie → `revokeSession`; a second user cannot revoke the first's session; an expired row yields null; the link flow creates, links and refuses `linked-elsewhere`; messages parity), `npm run build`, token grep.
3. `/en/login` renders the head, both provider buttons (Google primary) with `href` to the auth routes carrying `next`, the retention line; with `?next=/en/ch/21/21.3` the return row reads `You will return to 21.3 · Worked numbers`; `?error=denied` shows its notice; a request with a valid cookie redirects to `next`.
4. `GET /api/v1/auth/google` answers 302 to `accounts.google.com` with `code_challenge`, `state`, `prompt=select_account` and sets `hb.oauth`; `GET /api/v1/auth/github` answers 302 to `github.com/login/oauth/authorize` with `scope=read:user user:email`; the callback without the cookie redirects to `/en/login?error=state`; `GET /api/v1/auth/dev?email=dev@harness-bible.local&next=/en/paths` sets `hb.session` and lands on `/en/paths` with the marks instrument (signed in); the same request under `NODE_ENV=production` is 404 (build + start once).
5. Top bar: signed out `Sign in` → `/en/login?next=/en/ch/21/21.3` from the reader; signed in `Account`; the paths and marks sign-in notices link to login with `next`.
6. `/en/logout`: `Sign out` clears the cookie and lands on `/en` signed out; the row is gone; a second visit shows `You are signed out.` with `Sign in`; `Sign out everywhere` from a browser with two sessions (two contexts through the dev provider) removes both rows.
7. `/en/account` signed out redirects to `/en/login?next=/en/account`; signed in shows the head facts (`■ google` when the dev user has a Google identity inserted by SQL; the dev provider alone shows no sign-in mark and the identities instrument's `Link Google` / `Link GitHub`), profile, preferences, two sessions with `this session` on one, `Sign out` on the other removing it (`?revoked=1`), `Sign out everywhere` leaving one, retention with the dialog: `Request deletion` disabled until `delete` is typed, confirm → `/en/login?notice=deletion-requested`, the user has `deletionRequestedAt`, no session rows; the dev provider then refuses that e-mail with `?error=deleted` (reset by SQL after).
8. Profile: save `Andre Ponto` → `?saved=profile` and the head; 61 characters → the inline error. Preferences: `PT` → `/pt/account?saved=preferences`, `User.locale = pt-BR`, the page in PT; `Dark` → `<html data-theme="dark">` and `hb.theme` in `localStorage`, persisting across a reload before paint (no flash: screenshot at 0 ms of navigation shows the dark background); `System` removes the attribute; `Off` sets `hb.keys` and the reader's `j` no longer navigates.
9. Identities: an `Identity` inserted by SQL for GitHub shows the row and `Unlink` is hidden while it is the only one; a second identity shows `Unlink` on both and one unlinks (`?unlinked=github`).
10. `/pt/login`, `/pt/logout`, `/pt/account` at 390 and 1440: no overflow, PT strings; the sessions table drops `expires` on phones.
11. axe on `/en/login`, `/en/logout` (signed in), `/en/account`, `/pt/account`: zero AA violations.
12. `git status` shows only: `prisma/schema.prisma` + `prisma/migrations/…_identity`, `lib/env.ts`, `.env.example`, `lib/auth/{oauth,session,link,rules,cookies}.ts` + tests, `lib/schemas/auth.ts`, `lib/db/client.ts` (D6) and `lib/db/account.ts` (`getAccountData`, profile and preference writes), `app/api/v1/auth/**`, `app/[lang]/{login,logout,account}/**`, `components/auth/*`, `components/account/*`, `components/chrome/TopBar.tsx` (+ every page passing the session), `components/paths/YourMarks.tsx` and `components/marks/MarksPage.tsx` (the sign-in link), `components/ui/ConfirmDialog.tsx` (children slot), `app/[lang]/layout.tsx` (theme script), `globals.css` (§ 6.6), `ui-context.md` § 9.9 and § 12, `architecture.md` § 1, § 3.2, § 3.4 (auth routes), § 4 (`Identity`), `package.json` (`arctic`), `messages/*`, tests, `prisma/seed.ts` (the dev user without the env id), and the tracker.

# 47 · Book management — feature spec (a curator's page under the account: Book status, the curator roster, the audit export)

Read `CLAUDE.md` and `context/ai-workflow-rules.md` before starting.

Source of truth: Andre's stories of 2026-10-12 and his seven answers the same day (§ 2). Prerequisite specs: `02-book-home.md` § 6.3 and § 6.4 (Book status and its legend), `08-user-auth.md` § 6.3 (the account page), `38-account-admin-and-audit.md` § 3 and § 4 (the audit export, the roster).

Scope: tracker unit 67, one unit. It is numbered after spec 46's draft, whose units are 65 and 66, and is built before them on Andre's word.

## 1. Purpose

Andre's stories, as he wrote them:

- As a Curator, I want to observe 3 things: a) Book Status (Box at the bottom of the Harness Bible Home); b) Curator Roster (Box at the bottom of the Account page) and c) Audit Export (Box at the Account page).
- I want all 3: a, b and c in a single page; this page is a subpage of the account page, accessible through a button at the top of the page, called book mgmt.
- Move the components from the other pages where they are currently.

The three boxes keep what they show and how they work. What changes is where they are and who sees them.

## 2. Decisions (Andre, 2026-10-12)

| # | Question | Answer |
|---|---|---|
| D1 | Who sees the button and opens the page | curators and organisation admins: the roles `CURATOR` and `ORG_ADMIN` |
| D2 | What stays on the home | the box moves; its legend stays on the home, under the chapter grid it explains |
| D3 | What non-curators keep | nothing of the three on screen; the audit export's API and policy are unchanged (38 D1 stands for the API); the Rubric page's link to the roster is shown to the page's roles only |
| D4 | Name and address | `Book management` (PT candidate `Gestão do livro`), at `/[lang]/account/book` |
| D5 | The button | on the account head's row, right of the four facts; the new page opens with `← Account` above its title |
| D6 | The layout | Book status across the page, then the roster and the audit export side by side; one column under 1200px |
| D7 | Book status's legend cell on the new page | dropped: the box shows its four number cells there |

What follows from them, on the spec's reading:

- **D1, by role.** "Curator" is the role, as the curator queue reads it (`user.role === "CURATOR"`, spec 36 § 4), not whether the roster gives the person parts. An organisation admin opens the page although no organisational account exists yet (architecture § 5.1).
- **D3 amends spec 38.** D2 there ("the roster shown to every signed-in reader") now reads: shown to curators and organisation admins. The audit export's form moves with the page. Its API still serves any signed-in person for their own account or a chapter. A contributor keeps two exports on screen that are not this form: a suggestion's record (35 § 15) and a chapter's history (37 § 19).
- **D2 amends spec 02.** The home's last instrument is the legend. The home keeps its numbers where they already are: the hero's blurb and the status bar's verify and lab counts.

## 3. The page (`/[lang]/account/book`)

### 3.1 Who

- Signed out: redirect to `/[lang]/login?next=/[lang]/account/book`, as the account page does.
- Signed in without `CURATOR` or `ORG_ADMIN`: 404, as the curator queue answers. Nothing says the page exists.
- The rule is one function, `managesBook(role)` in `lib/auth/rules.ts`. The page, the account head's button and the Rubric page's link all ask it.

### 3.2 Layout

`main.account` (the account page's padding and gaps), then the status bar:

```
┌ topbar (Account current) ────────────────────────────────────────────────────┐
│ ← account                                curators and organisation admins     │
│ Book management                                                               │
│ ┌ BOOK STATUS · release 2026.09 · sha 7f3a9c1e ──── nightly check … ────────┐ │
│ │ 41/41 chapters │ 34/35 labs │ 2 stale │ 2026.09 release · pinned           │ │
│ │ verify ████░ 100% · 41/41   lab ci ████░ 97% · 34/35            #7f3a·9c1e │ │
│ └────────────────────────────────────────────────────────────────────────────┘ │
│ ┌ CURATOR ROSTER ────────────────────┐ ┌ AUDIT EXPORT · chapter 29 ──────────┐ │
│ │ part · chapters · curators · …     │ │ scope · chapter · from · to · …     │ │
│ └────────────────────────────────────┘ └─────────────────────────────────────┘ │
└ statusbar: book management · {name} | EN · source EN | pinned release | loaded ┘
```

- **Head** (`.account-head`): left, a `.cap` link `← account` to `/[lang]/account`, and `h1.h2` `Book management`; right, `.meta` `curators and organisation admins`.
- **Book status** (`BookStatus`, spec 02 § 6.3): the same instrument, without its fifth cell (D7). Its grid becomes `330px repeat(3, minmax(0, 1fr))`. It is two columns under 1000px and one under 640px, as before, with no rule under the last row.
- **The roster and the audit export** (`RosterInstrument`, `AuditExportPanel`, spec 38): unchanged components, in the account page's `.account-grid`. That grid is two columns at 1200px and wider, and one column below (D6). The roster keeps `id="roster"` and the export `id="audit"`, so `#roster` and `#audit` still land on them.
- **The roster's header** says who sees it now: `curators and organisation admins · read-only` replaces `visible to all accounts · read-only`.
- **Status bar**: `book management · {displayName}` (the session carries the name, not the e-mail) | `{lang} · source {sourceLang}` | `pinned release {id}` | `loaded {s} s`.
- **Top bar**: `Account` current, compact, as on the account page. Metadata: `Book management · The Harness Bible`, `noindex`, alternates `/en/account/book` and `/pt/account/book`.

### 3.3 Data

What the account page read for the two moved boxes, and the home's status:

- `getHomeData(locale, user)` gives the release, the status and the chapters the export offers;
- `readRosterPanel(now)`;
- `latestAuditExportView(user.id, now)`.

The account page stops reading all three. No query, door, endpoint or policy rule is added or changed.

## 4. The account page

- **The button** (`AccountHead`): `Button href="/[lang]/account/book" size="sm"` `Book management`, the head's third cell (`.account-head-actions`, aligned to the bottom like the facts). It shows only where `managesBook(role)` holds. Where the head stacks (under 1000px), it stands under the facts.
- **Removed**: the audit export from `.account-grid`, which keeps seven instruments, and the roster under it. The route stops loading them (§ 3.3).

## 5. The home

- **Removed**: `BookStatus` from `BookHome`.
- **The legend** (`HomeLegend`, which replaces `BookStatusLegend`) is the page's last instrument, where Book status was. It is an `InstrumentPanel` labelled `legend`, holding spec 02 § 6.4's eight rows unchanged, four columns at 1000px and wider, two below, one under 640px. Each row's mark column keeps its 118px.
- **Unchanged**: the hero, the parts, the status bar's counts.

## 6. The Rubric page

The rubric's caption line ends with a link, `the curator roster`, to `/[lang]/account#roster`. It now goes to `/[lang]/account/book#roster`, and the segment with its dot shows only where the session's role passes `managesBook`. The route passes the role to `RubricPage`, which stays public.

## 7. Strings

| Key | EN | PT (candidate) |
|---|---|---|
| `account.book.open` | Book management | Gestão do livro |
| `account.book.metaTitle` | Book management · The Harness Bible | Gestão do livro · The Harness Bible |
| `account.book.back` | ← account | ← conta |
| `account.book.title` | Book management | Gestão do livro |
| `account.book.who` | curators and organisation admins | curadores e administradores da organização |
| `account.book.statusbar` | book management · {name} | gestão do livro · {name} |
| `account.book.error` (the page's own error boundary) | Book management did not load | A gestão do livro não carregou |
| `account.roster.visibility` (changed) | curators and organisation admins · read-only | curadores e administradores da organização · só leitura |

The legend's label is the existing `home.legend.label`.

## 8. Verification (in addition to `ai-workflow-rules.md` § 7)

1. **A curator** sees `Book management` on `/en/account`, follows it, and gets the page with its three instruments. `#roster` and `#audit` land on theirs. Axe finds nothing, and `← account` goes back.
2. **A reader and a contributor** see no button. `/en/account/book` answers 404, and the account page has no roster and no audit export.
3. **Signed out**, `/en/account/book` redirects to sign-in with `next`.
4. **The home** has no Book status and has the legend, signed in and signed out, axe clean.
5. **The Rubric page** shows the roster's link to a curator and to nobody else.
6. **The PT truncation suite** measures the new page as a curator. The home and the account page are measured again with their new content.
7. **Unchanged suites pass**: the audit export's estimate and pack, and the roster.

## 9. Documents this amends

- spec 02 § 6.3 and § 6.4: the instrument has moved and the legend stays;
- spec 08 § 6.3: the head's button;
- spec 38 § 3, § 4 and D2: where the form and the roster are, and who sees them;
- architecture § 3.2: the route;
- ui-context: the classes;
- project-overview's step 2 and its Book Home success criterion: where Book status is;
- the tracker.

## 10. As built, and the review (unit 67, 2026-10-12)

Built as § 3 to § 6 say, with one difference: the status bar names the person by display name, since the session carries no e-mail. The page has its own error boundary (`Book management did not load`), so a failed read does not say the account did not load.

**The review**, one read-only pass over the whole unit, found nothing high or medium. Its eight low findings are fixed in the unit's commit:

- the page's own error boundary;
- the account head's name column keeps at least its longest word now that the button shares the row (between 1000 and 1199 px a long e-mail squeezed it to nothing);
- the roster command told the operator the roster is public, and two comments said every signed-in account reads it;
- four places in the context files still described the old placement: architecture's roles table, the overview's step 16 and its feature list, spec 02's grid rule and cell list, ui-context's Home row;
- the browser suite gains a reader, an organisation admin, and the two anchors landing in view.

**Verified:**

- type check, lint;
- the unit tests of `lib/auth` and the catalogues;
- the roster's database suite, with the command's new line;
- the browser suites `book-management` (6 cases), `accounts` and `rubric`;
- the PT truncation suite, every screen clean, the new page and the account page as a curator included;
- in Chromium at 1440, 1100, 1000 and 390 px, light and dark: no horizontal overflow, axe clean.


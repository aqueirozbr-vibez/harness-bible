# 25 · Assistant 2.0, the reader's statistics — feature spec (the observability series recomputed for one reader, and the panel that shows them)

Read `CLAUDE.md` and `context/ai-workflow-rules.md` before starting.

Source of truth for the screen: none in `docs/design/screens/`: no screen of the package shows a statistics panel for the assistant. The panel is built from `context/ui-context.md` alone: § 8 (the instrument, tiled in a ruled grid), § 9.3 (`.tbl`), § 9.6 (`.meter` with a `.mark`), § 13.5 (numbers), and the two precedents already in the product, the Book status cells (`.status-cells`, `.cellnum`) and the account page's `BudgetInstrument`. There is no chart library and none is added: the forms are single numbers, meters and one ruled table.

Prerequisite specs: `21-assistant-retention-observability.md` (the nine series and their SQL files, the budget meter), `15-conversations-api.md` (the rows the series read).

Scope: tracker unit 42. The definitions of the series for one reader as pure functions, the loader that feeds them through the tenant guard, and the `StatsPanel` component. Not here: the page that shows the panel and refreshes it (spec 26), the operator's dashboard and alerts (spec 21, unchanged), an organisation's view.

## 1. Purpose

The third thing Andre asked the assistant's page to hold is "a dashboard of the observability stats". The product already computes nine series (spec 21 § 5.3): citation rate, flag rate, refusal rate by cause, first-token p95, the grounded distribution, cost per active account, cache-read share, edition mismatch and the purge. They exist as SQL files for Grafana and for `npm run assistant:metrics`, they count every reader's rows, and no page reads them.

A page a reader opens cannot show every reader's numbers (D1). This spec gives the reader the same measures over their own turns: how often their answers were fully cited, how often they were refused and why, how long the first token took, how the grader scored them. On a single-reader machine, which is what the development database is, that is every turn there is.

## 2. Dependencies and order

| Needs | Why |
|---|---|
| `Message`, `SensorVerdict`, `Flag`, `Conversation`, `BudgetLedger` rows (specs 11, 15) | what is counted |
| `lib/metrics/sql/*.sql` and `formatValue` (`lib/metrics/assistant.ts`) | the definitions to match, and the one way a value is printed |
| The thresholds in `lib/metrics/dashboard.ts` (`CITATION_RATE_FLOOR`, `REFUSAL_RATE_CEILING`, `FIRST_TOKEN_P95_MS`) | the marks |
| `budgetFacts`, `BudgetInstrument` (spec 21 § 4.1) | cost, unchanged |
| `conversationStats` (`lib/db/assistant.ts`) | the retention line |

This unit depends on neither unit 40 nor unit 41.

Build order: 42a the pure definitions (`lib/metrics/reader.ts`) with their unit tests → 42b the loader (`lib/db/assistantStats.ts`) and the parity test against the SQL files → 42c `StatsPanel`, its strings and classes, the browser pass at the panel's width.

## 3. The series for one reader (42a)

`lib/metrics/reader.ts`, pure: `statsOf(rows: ReadonlyArray<StatRow>): ReaderStats`. Each definition is the SQL file's, word for word, over the rows it is given.

| Cell | SQL file it matches | Numerator | Denominator |
|---|---|---|---|
| citation rate | `citation-rate.sql` | answers whose citation verdict is `PASS` with no claim replaced | answers (an assistant row with no refusal cause and a model id) whose citation verdict is not `NA` |
| refusal rate, and one line per cause | `refusal-rate.sql` | assistant rows with a refusal cause | every assistant row: an answer, a refusal or a failed turn |
| first-token p95 | `first-token-p95.sql` | — | assistant rows with a first-token time; the value is the 95th percentile, interpolated as PostgreSQL's `percentile_cont` does |
| grounded p50 and p10 | `grounded.sql` | — | assistant rows the grader scored |
| flag rate | `flag-rate.sql` | flagged assistant rows | every assistant row |
| edition mismatch, per reader language | `edition-mismatch.sql` | answers whose cited edition is not the conversation's language | answers that cite an edition |
| text purged | `purge.sql` | conversations whose text the retention run cleared in the window | — |
| cache-read share | `cache-read-share.sql` | cache-read tokens | input, cache-read and cache-write tokens of the frontier alias's answered calls |

`percentileCont(values, p)` is a pure function of its own, tested against values PostgreSQL returns for the same lists.

Not recomputed: **cost per active account**. It divides a platform's spend by its readers and has no meaning for one reader. The reader's cost is what the account page already shows, the budget meter, and the panel shows that instrument unchanged (§ 5).

Two of the cells are not the reader's alone. `BudgetLedger` rows belong to whoever pays: the reader on an individual account, the organisation otherwise. The cache-read share and the budget meter are therefore the payer's, and the panel says whose (D5).

## 4. The loader (42b)

`lib/db/assistantStats.ts`:

```ts
export type StatsWindow = { readonly kind: "month"; readonly month: string } | { readonly kind: "all" };
export function readerStats(user: SessionUser, window: StatsWindow): Promise<ReaderStats>;
```

- Inside `withTenant(tenantOf(user))`, through Prisma: the reader's assistant rows in the window, selecting only the columns the definitions read (`refusalCause`, `modelId`, `substituted`, `firstTokenMs`, `grounded`, `citesEdition`, the citation verdict, the flag's reason, the conversation's locale), and the count of conversations purged in the window. The guard supplies the tenant filter (invariant 24).
- The cache-read sums through `tenantOfPrincipal`, as `monthSpend` reads them, filtered to the frontier alias and answered calls.
- No raw SQL, so nothing is added to `lib/db/RAW_SQL.md`, and the nine files stay as they are: the script's and the gate's, never a request handler's (D3).
- No endpoint and no policy kind: a server component reads the loader for the signed-in reader, as the account page reads `budgetFacts`.

**Parity test** (`tests/integration/assistant-stats.test.ts`, a database suite): a fixture reader is given turns dated inside a month no other row falls in; for that window each SQL file's month value equals the pure function's value for that reader. If a definition is changed in one place and not the other, this is the test that fails.

## 5. The panel (42c)

`components/assistant/StatsPanel.tsx`, a server component, 330px wide where it stands as a rail (spec 26):

```
aside.stats[aria-label="Assistant statistics"]
  .inst
    .inst-h      .t "assistant stats"   .sep   "your turns"          .ts "Oct 2026" | "all time"
    nav.seg      "this month" | "all time"                           (links; the page's `w` parameter)
    .stats-grid  two columns, ruled, no gap; one cell per measure:
        .cap  "citation rate"      .midnum "—"   .faint "n / d answers"     .meter with .mark at the floor       .cap "floor 90 %"
        .cap  "refusal rate"       .midnum "—"   .faint "n / d turns"       .meter with .mark at the ceiling     .cap "ceiling 20 %"
        .cap  "first token p95"    .midnum "—"   .faint "n = d"                                                  .cap "limit 2000 ms"
        .cap  "grounded p50"       .midnum "—"   .faint "p10 — · n = d"
        .cap  "flag rate"          .midnum "—"   .faint "n / d turns"
        .cap  "cache read share"   .midnum "—"   .faint "your account" | "your organisation"
    .inst-b      .cap "refusals by cause"
                 table.tbl   cause · turns · share        (one row per cause that occurred; the causes' labels are `assistant.refusal.cause.*`)
    .inst-b      dl.kv       "cites another edition"   "n / d · pt"
                             "text purged"             "n conversations"
                             "text kept until"         date            (from `conversationStats`, as the account page prints it)
    .inst-f      "release {id} · counted from your own turns"
  BudgetInstrument                                                     (the account page's component, unchanged)
```

- Every value is printed by `formatValue`, so the panel, the script and the gate print a rate the same way. A measure with nothing to divide by prints `-`, as `formatValue` does, with its zero count beside it.
- The three thresholds are read from `lib/metrics/dashboard.ts`; the panel holds no number of its own. A value on the wrong side of its threshold changes the meter's fill to `.fail` and adds the words `below floor`, `above ceiling` or `over limit` to the caption: by word, never by colour alone.
- Each meter is `role="meter"` with `aria-valuenow`, `aria-valuemin`, `aria-valuemax` and a label that names the mark (ui-context § 9.6).
- With no turn in the window the grid is replaced by one `Empty` block (§ 6).
- New classes: `.stats`, `.stats-grid`, `.stats-cell`, added to `globals.css` and to ui-context § 9.9 with the unit.

Invariant 26 is kept by construction: the panel ranks no one, counts no messages per session and measures no time on a page.

## 6. Strings (`assistant.stats.*`; EN and PT candidates; Andre's to confirm)

| Key | EN | PT |
|---|---|---|
| `label` | Assistant statistics | Estatísticas do assistente |
| `title` | assistant stats | estatísticas do assistente |
| `yours` | your turns | seus turnos |
| `month` | this month | este mês |
| `all` | all time | desde o início |
| `citationRate` | citation rate | taxa de citação |
| `refusalRate` | refusal rate | taxa de recusa |
| `firstToken` | first token p95 | primeiro token p95 |
| `grounded` | grounded p50 | fundamentação p50 |
| `groundedBasis` | p10 {p10} · n = {n} | p10 {p10} · n = {n} |
| `flagRate` | flag rate | taxa de sinalização |
| `cacheShare` | cache read share | parcela lida do cache |
| `ofAnswers` | {n} / {d} answers | {n} / {d} respostas |
| `ofTurns` | {n} / {d} turns | {n} / {d} turnos |
| `samples` | n = {n} | n = {n} |
| `floor` | floor {value} | piso {value} |
| `ceiling` | ceiling {value} | teto {value} |
| `limit` | limit {value} | limite {value} |
| `belowFloor` | below floor | abaixo do piso |
| `aboveCeiling` | above ceiling | acima do teto |
| `overLimit` | over limit | acima do limite |
| `payerYou` | your account | sua conta |
| `payerOrg` | your organisation | sua organização |
| `byCause` | refusals by cause | recusas por causa |
| `thCause` / `thTurns` / `thShare` | cause / turns / share | causa / turnos / parcela |
| `edition` | cites another edition | cita outra edição |
| `purged` | text purged | texto removido |
| `purgedValue` | {n, plural, one {# conversation} other {# conversations}} | {n, plural, one {# conversa} other {# conversas}} |
| `keptUntil` | text kept until | texto mantido até |
| `foot` | release {id} · counted from your own turns | release {id} · contado dos seus turnos |
| `empty` | No turns in this window yet. | Nenhum turno nesta janela ainda. |
| `meterLabel` | {name}: {value}; {mark} | {name}: {value}; {mark} |

## 7. Keyboard, accessibility

The window control is two links in a `nav`, the current one `aria-current="page"`. The table has a caption and column headers. Meters carry their value in text beside them. Nothing truncates; the two-column grid becomes one column where a PT label would not fit in half of 330px, decided in the browser pass and recorded.

## 8. Out of scope

- Every reader's numbers on a page: those stay in Grafana and the script (spec 21 D4).
- An organisation's view for its administrators: Phase 4's Account-Admin.
- A series by day (D6), exports of the numbers, and alerts for a reader.
- Any new measure. The panel shows what spec 21 already defines.

## 9. Decisions this spec needs

| # | Decision | Options | Recommended |
|---|---|---|---|
| D1 | Whose numbers the page shows | A the reader's own turns / B the organisation's, to its administrators / C every reader's, to an operator role | **A**: a page any reader opens must not show other tenants' rows (invariant 24), and no operator role exists to gate C. On Andre's machine A is every turn. If he wants C as well, it is a role and a policy rule first |
| D2 | The window | A the current calendar month in UTC, as the budget meter / B that and all time, behind two links / C the last 30 days | **B**: the month matches the meter beside it; all time is the only window with enough turns to read a percentile on a small account |
| D3 | How the numbers are computed | A Prisma inside the tenant guard, pure functions, a parity test against the SQL files / B the SQL files with a reader parameter, called from the page | **A**: `RAW_SQL.md` records that the files are never a request handler's, and a unit test forbids `"userId"` in them. Two definitions are the cost, and the parity test is what holds them together |
| D4 | The thresholds | A shown as marks, read from `lib/metrics/dashboard.ts` / B not shown to a reader | **A**: they are the product's own bars (the overview's success criteria), and a number without its bar says little |
| D5 | The cells that belong to the payer | A shown, with the cell saying whose / B hidden from organisation members | **A**: the account page already shows an organisation's meter to its members |
| D6 | A series by day | A totals for the window only / B a ruled table, one row per day | **A** for this unit: 330px holds the grid and one table; B can follow if the totals prove too coarse |
| D7 | A small sample | A always the value with its count / B hide a value under a minimum count | **A**: every cell prints its denominator, and no minimum is invented |

## 10. Verification (in addition to `ai-workflow-rules.md` § 7)

1. `reader.test.ts`: each definition on fixture rows, among them an answer with a replaced claim (outside the numerator), a walk whose citation verdict is `NA` (outside the rate), a failed turn (in the refusal rate's denominator, not its numerator), a refusal of each cause, a turn with no first token, an ungraded answer, a flagged refusal; `percentileCont` on lists of one, two and twenty values against PostgreSQL's results.
2. The parity test of § 4 passes with the database, and is skipped, not failed, without one.
3. A second reader's turns never change the first reader's numbers (an integration case with two fixture readers).
4. The panel on the development database, both windows: each cell's `n / d` agrees with a count made by hand through `npm run assistant:metrics` for the same window, the development database having one reader.
5. A fresh account shows the empty block and the budget meter with no error.
6. A threshold crossed (fixture: citation rate under 90 %) shows the `.fail` fill and the words `below floor`; the meter's accessible name includes the mark.
7. PT at 330px: every string from the catalogue, nothing truncated or overflowing; the grid's column count recorded.
8. axe: zero WCAG 2.2 AA violations on the panel with data and empty, EN and PT.
9. Token grep clean; the three classes in `globals.css` and ui-context § 9.9; message parity; `lib/db/RAW_SQL.md` unchanged; no file under `lib/metrics/sql/` changed; `npm run observe:generate -- --check` still up to date.
10. Invariants: 24 (the guard filters every read; case 3), 26 (no ranking, no per-session count, no time on page).

## 11. As built (unit 42, 2026-10-04)

Built as 42a to 42c. Where the build differs from the sections above, this section is later.

**42a, `lib/metrics/reader.ts`.** As § 3: `statsOf(rows)` and `percentileCont(values, p)`, pure. Two things § 3's table did not say: the flag rate keeps its line per reason (`flagsByReason`), as the statement does, so parity can be checked on it although the panel shows the total alone; and the lines by cause, by reason and by language are in key order, as the statements' `ORDER BY` leaves them. The percentile values the unit tests quote (2415, 2340, 0.55, 1905) were read from PostgreSQL itself with the same lists.

**42b, `lib/db/assistantStats.ts`.** `readerStats(user, window)` returns `ReaderPanelStats`: the series of 42a, and beside them the two measures that are not counted from message rows, `purged` and `cacheReadShare`, with `payer` (`account` or `organisation`). Message rows and the purge count are read inside `withTenant(tenantOf(user))`; the token sums inside `withTenant(tenantOfPrincipal(…))`, filtered to `hb-frontier` and `ok`. No raw SQL, nothing added to `lib/db/RAW_SQL.md`, no endpoint, no policy kind.

**The parity test passes for every series.** `tests/integration/assistant-stats.test.ts`: one reader alone in July 2031 with nine turns (five answers that made claims, one with a claim replaced, two refusals of different causes, a walk, a failed turn, two flags, two answers in Portuguese citing the English edition, one purged conversation, four ledger rows of which two count). For that month each statement's value equals `readerStats`'s: citation rate, refusal rate with its causes, first-token p95, grounded p50 and p10, flag rate with its reasons, edition mismatch per language, the purge and the cache-read share. Two readers share August 2031: each one's numbers are their own while the statement counts both (§ 10.3). The suite is skipped, not failed, without a database.

**42c, `StatsPanel`.** As § 5, with these differences:

- **The cells' number is `.cellnum` (24px), not `.midnum` (40px).** `2340 ms` at 40px mono is wider than half of a 330px rail. `.cellnum` is the size the product's other grid of cells uses (Book status), so the grid stays two to a row.
- **The window control is `.seg-links`**, the link form of the segmented control the stylesheet already has, with `aria-current="page"` on the open window; one string was added for its name, `assistant.stats.windowLabel` ("Statistics window" / "Janela das estatísticas").
- **The floor's mark is the cool tick** (`.mark.ok`: a gate that is good to cross) and the ceiling's the red one, as ui-context § 9.6 distinguishes them.
- **The refusals table is absent when the window has no refusal**, and the edition line prints `-` when no answer cited an edition.
- The panel is a server-rendered component with no client code. It imports `formatValue` and the thresholds from `lib/metrics/`, which read files and the database, so it must stay out of client bundles: it is rendered by a page beside the dock, never inside it.

**Verified in this unit:** § 10.1 (`lib/metrics/reader.test.ts`, 12 cases), § 10.2 and § 10.3 (the integration suite, 12 cases, run twice so that a second run's ledger rows are shown to change nothing), § 10.9 (`lib/db/RAW_SQL.md` and `lib/metrics/sql/` untouched, `npm run observe:generate -- --check` up to date, message parity), § 10.10.

**Verified with unit 43, where a page first shows the panel:** § 10.4 to § 10.8 (the panel on the development database, a fresh account, a crossed threshold, PT at 330px, axe). All passed; spec 26 § 13 has the numbers, the one change to § 10.4's method (a per-reader count in SQL instead of the script, which counts every reader), and the two layout faults the screenshots showed and that were fixed there.

# Harness Bible Interactive — UI context

Sources: `docs/design/screens/hb.css` (v0.9.0, the token and component source), `docs/design/style-guide.html` (v0.9.0, 21 Sep 2026, 14 sections), `docs/design/screens/Components.html`, the 18 screens under `docs/design/screens/`, and the PNG renders under `docs/design/png/`. Companions: `context/project-overview.md`, `context/architecture.md`.

The design is finished and lives in hb.css. This file documents it and fixes how it is carried into this codebase. When this file and hb.css disagree, hb.css wins; update this file.

Sections 1 to 12 restate the design system. Section 13 fixes the implementation conventions for Next.js and Tailwind v4 that the UI package does not cover. Section 14 is the checklist to run before any UI change is considered done.

## 1. Principles

Five rules decide every other rule. Quote them when a decision is contested.

1. **Every panel is an instrument.** A panel has a label, a version and a timestamp before it has content. If you cannot name what it measures, it is not a panel.
2. **Numbers carry provenance.** Every figure carries a source-tier chip, a derive link or an illustrative mark. A bare number is a defect, not a style choice.
3. **State in form, not only colour.** Verified, stale and failed differ in shape, line and word as well as hue. The interface reads correctly in greyscale and in print.
4. **Parity is a layout constraint.** Portuguese and English ship together. Every label is sized for the longer edition; nothing truncates; figures are identical in both.
5. **The harness is visible.** Versions, hashes, budgets, rubric scores and run logs are shown, not hidden behind a friendly surface. The reader is an engineer.

The framing: the interface is a lab bench. Nothing decorates. If an element does not carry information, it is removed.

## 2. Colour tokens

23 tokens × 2 themes. Light is "lab paper", dark is "instrument black". Contrast is WCAG 2.x against `--bg` of the same theme.

| Token | Light | Dark | Role | Light vs bg | Dark vs bg |
|---|---|---|---|---|---|
| `--bg` | `#F1F1EC` | `#111210` | page | — | — |
| `--bg-2` | `#E7E8E1` | `#191A17` | band, hover | surface | surface |
| `--bg-3` | `#DCDDD4` | `#23241F` | pressed, rail | surface | surface |
| `--surface` | `#F7F7F3` | `#161714` | inputs, peeks | surface | surface |
| `--ink` | `#141512` | `#E9E9E2` | text, strong rule | 16.18 | 15.40 |
| `--ink-2` | `#44463F` | `#BDBEB4` | secondary text, control borders | 8.45 | 10.01 |
| `--ink-3` | `#5F6158` | `#92948A` | captions, faint | 5.55 | 6.11 |
| `--rule` | `#C9CAC0` | `#34362F` | row rules, decorative only | 1.46 | 1.53 |
| `--rule-2` | `#A9ABA0` | `#4A4C44` | dashed rules, timeline spine, decorative only | 2.05 | 2.15 |
| `--rule-strong` | `#141512` | `#E9E9E2` | instrument frame, header rule | 16.18 | 15.40 |
| `--act` | `#A34E00` | `#F0913F` | actions only | 5.08 | 7.90 |
| `--act-hover` | `#833E00` | `#F5A763` | primary button hover | 6.98 | 9.47 |
| `--on-act` | `#FFFFFF` | `#111210` | text on `--act` | 5.76 on act | 7.90 on act |
| `--act-bg` | `#F2E3D2` | `#2B1C0E` | new row, running block | tint | tint |
| `--ver` | `#0E5C70` | `#6CBFD3` | verification, links | 6.66 | 8.97 |
| `--ver-bg` | `#D9E7EA` | `#12262C` | verified tint | tint | tint |
| `--fail` | `#A3261C` | `#F2735F` | failure, diverge, killed | 6.50 | 6.61 |
| `--fail-bg` | `#F3DDD8` | `#2C1512` | error tint | tint | tint |
| `--warn` | `#7A5800` | `#E2B84A` | stale, illustrative, request more | 5.75 | 10.01 |
| `--warn-bg` | `#EFE3C2` | `#272010` | notice tint | tint | tint |
| `--code-bg` | `#E9EAE3` | `#191A17` | code panes | surface | surface |
| `--sel` | `#CFE0E4` | `#1E3A42` | selected row, text selection | tint | tint |
| `--focus` | `#0E5C70` | `#6CBFD3` | focus ring | 6.66 | 8.97 |

Two extra tokens used by the terminal pane: `--term-bg` `#141512` / `#0A0B09`, `--term-ink` `#F1F1EC` / `#E9E9E2`.

Measured pairs: ver on ver-bg 5.95 light / 7.49 dark; warn on warn-bg 5.10 light / 8.60 dark. Lowest text contrast in use is 5.08 (act on bg, light).

### 2.1 One hue, one job

| Hue | Token | Means | Used for | Never used for |
|---|---|---|---|---|
| warm | `--act` | something you can do, or is being done | primary button, running state, "new" in diffs, the ✢ glyph | emphasis, headings, success |
| cool | `--ver` | checked against a source or a run | verified, reproduced, derived chips, cross-references, citations, focus ring | calls to action |
| red | `--fail` | failed or declined | not reproduced, diverge, killed, declined, field errors, destructive button outline | warnings, stale content |
| ochre | `--warn` | provisional | stale > 90 days, illustrative figures, request more | errors, actions |

Rules:
- Semantic colour is never the only signal. Each state also carries a word, a shape (filled, hollow or half-filled square) or a line style.
- `--rule` and `--rule-2` are decorative. Any boundary that identifies a control uses `--ink-2` or stronger (8.45:1 or better).
- Links are cool. Every traversal (derive line, section, chapter, lab, citation) uses `--ver` with a dotted or solid rule, never the warm action colour.
- One warm primary per view.

## 3. Typography

Two families. The split is semantic: if you would copy it into a terminal or a spreadsheet, it is mono.

| Token | Stack | Weights | Used for |
|---|---|---|---|
| `--sans` | "IBM Plex Sans", "Helvetica Neue", Helvetica, Arial, sans-serif | 400, 500, 600, italic 400 | prose, headings, controls, UI text |
| `--mono` | "IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace | 400, 500, 600 | metadata, numbers, ids, versions, hashes, labels, captions, code, status |

Base: 14px / 1.45, antialiased, `font-feature-settings: "ss02"`.

### 3.1 Scale (14 roles)

| Class | Size / line | Weight · tracking | Family | Use |
|---|---|---|---|---|
| `.h-display` | 56 / 60 | 400 · −.02em, balance | sans | book title on Home only |
| `.h1` | 40 / 46 | 500 · −.015em, balance | sans | chapter title, page title |
| `.h2` | 28 / 34 | 500 · −.01em, balance | sans | section title (`21.3 Worked numbers`) |
| `.h3` | 20 / 26 | 600 | sans | instrument body heading, subsection |
| `.h4` | 16 / 22 | 600 | sans | lab title, empty-state heading |
| `.prose` | 17 / 28 | 400, max-width 680px, `p+p` margin 16 | sans | chapter text |
| `.ui` | 14 / 20 | 400 / 500 | sans | controls, body copy in panels |
| `.small` | 13 / 18 | 400 | sans | secondary copy, table cells |
| `.meta` | 12 / 16 | 400, tabular | mono, `--ink-2` | version strings, timestamps, formulas |
| `.cap` | 12 / 16 | lowercase · .01em | mono, `--ink-3` | caption above a heading, panel classifiers |
| `.label` | 11 / 14 | uppercase · .06em | mono, `--ink-2` | field labels, small classifiers |
| `.tex` | 11 | .02em; hb.css's opacity .8 is not ported: it fails AA contrast (axe, 2026-09-22) | mono, `--ink-3` | chrome texture only: hash fragments, base64 stubs |
| `.midnum` | 40 / 44 | −.02em, tabular | mono | one mid-size number in an instrument |
| `.bignum` | 88 / 88 | 400 · −.04em, tabular | mono | the one big number in an instrument or verdict |

Helpers: `.mono`, `.muted` (`--ink-2`), `.faint` (`--ink-3`), `.num` / `td.n` / `th.n` (tabular numerals), `.glyph` (mono, `--act`, for ✢), `.score` (mono, tabular).

Mobile (≤ 640px): `.h-display` 40/44, `.h1` 32/38, `.bignum` 64/64.

Rules:
- Tabular numerals on every number in a column, meter, counter or timestamp. Numbers in running prose stay proportional.
- A `.cap` sits above a heading as a quiet classifier. It never repeats the heading and never ends in a full stop.
- Mono marks what a sensor can check: ids, numbers, versions, hashes.

## 4. Space, rules, radii, elevation

### 4.1 Spacing (4px base)

| Token | px | Use |
|---|---|---|
| `--s1` | 4 | inside components |
| `--s2` | 8 | inside components |
| `--s3` | 12 | inside components; instrument header and footer padding |
| `--s4` | 16 | between related blocks; instrument body padding |
| `--s5` | 24 | between related blocks; gap between instruments that stand apart |
| `--s6` | 32 | between sections |
| `--s7` | 48 | between sections; desktop page horizontal padding |
| `--s8` | 64 | page margins on wide screens only |
| `--s9` | 96 | page margins on wide screens only |

Any spacing value not on this scale is a defect.

### 4.2 Rules and line meanings

| Line | Means |
|---|---|
| 1px `--rule` | separation: table rows, boxes, footers |
| 1px `--rule-strong` | instrument frame and header |
| 1.5px `--rule-strong` | table header, section head, totals |
| dashed `--rule-2` | absent or not yet: empty state, no lab, practitioner chip |
| dotted | provisional or traversable: illustrative, open, cross-reference underline |
| 3px double `--ink` | analyst chip only |
| 3px inset bar (`box-shadow: inset 3px 0 0`) | error, notice, invalid field |

Structure classes: `.rt .rb .rl .rr` (1px rule per side), `.rt-s .rb-s` (1.5px strong), `.box` (1px rule), `.box-s` (1px strong), `.band` (`--bg-2` fill). Layout helpers: `.row` (flex, center, gap 8), `.col`, `.grow`, `.between`.

### 4.3 Radius

**0, everywhere.** Buttons, inputs, chips, panels, focus rings, meters. A corner is a measurement boundary; rounding it suggests a consumer object. There is no radius scale because there is no radius. `border-radius` appears in the codebase only as `0` on native inputs.

### 4.4 Elevation

**None.** No drop shadows. Layers are shown by a strong rule and a surface change (`.peek`: 1px `--rule-strong` on `--surface`). `box-shadow` is used only as a hard inset bar (`inset 3px 0 0`, `inset 2px 0 0`), a hard underline (`0 1px 0`), the nav current indicator (`inset 0 -2px 0`), or the evidence-A frame. No gradients. No fills except where a state needs one.

## 5. Provenance marks

Every figure in the book carries one chip. The tier is legible in line form alone, so the system survives greyscale, print and colour-vision differences.

### 5.1 Source-tier chips (`.chip .t-*`, 20px tall, mono 11px)

| Chip | Class | Encoding | Use when the figure comes from |
|---|---|---|---|
| `pri` primary | `.t-pri` | solid ink fill, bg text | the original: statute, standard, paper, official filing |
| `ven` vendor | `.t-ven` | single 1px ink rule | the maker: docs, pricing page, vendor benchmark |
| `anl` analyst | `.t-anl` | 3px double rule | an independent analyst or benchmark |
| `pra` practitioner | `.t-pra` | dashed `--ink-2` | a practitioner write-up or talk |
| `ill` illustrative | `.t-ill` | dotted `--warn` on `--warn-bg` | a value chosen to show a mechanism; always spelled out |
| `ƒ` / `der` derived | `.t-der` | 1px `--ver` on `--ver-bg` | computed by derive.py; paired with a `.derive` link |
| `opn` open | `.t-opn` | dotted `--ink-3` | source unresolved; tracked in the chapter registry |

The chip follows the figure it qualifies. The abbreviation inside `<i>` is bold.

### 5.2 Inline marks

| Class | Renders | Use |
|---|---|---|
| `.fig-ill` | ochre wash + 1px ochre underline | an illustrative figure in prose |
| `.fig-der` | 1px cool underline | a derived figure in prose |
| `.derive` | 18px cool outlined chip, `ƒ L38` | link to the exact derive.py line; opens the code pane |
| `.xref` | mono .86em, cool, dotted underline | cross-reference `26.3`, `ch12`, `Lab 21`; opens the peek panel |
| `.src-link` | the `.derive` form, the word `link` or `doi` | the Sources table's link column (feature-specs/10, 2026-09-23): opens the cited document in a new tab with `noopener noreferrer`; the `aria-label` names the row and the citation; hover and focus fill `--ver-bg` |
| `.cite` | 20px cool outlined chip, `ch21 · 21.3` | assistant citation, one per claim |
| `.nocover` | mono 12px, dashed `--rule-2` box, `--ink-3` | "the book does not cover this" |
| `.hash` | mono 11px `--ink-3`, `overflow-wrap: anywhere` | `prev … · hash …` on ledger records |

Classification tree: a figure is cited (pri / ven / anl / pra, links to a source row in N.9), derived (der + ƒ Lnn, reproduced by derive.py in CI), illustrative (ill, spelled out in text, never in a decision aid alone), or open (opn, blocks promotion to a decision aid).

## 6. Status states

Nine states. Inline marks (`.st`) sit in running text and tables; blocks (`.st-block`) head an instrument or a run. The square's form repeats the meaning of the colour.

| State | Inline | Block | Colour · form | Meaning |
|---|---|---|---|---|
| Verified | `.st.st-ok` | `.st-block.sb-ok` | ver · solid square / ver-bg block | every VERIFY check passes on this version |
| Redteam passed | `.st-ok` | `.sb-ok` | ver · solid | no open red-team finding |
| Stale > 90 d | `.st-warn` | `.sb-warn` | ochre · solid / warn-bg block | a fast-moving figure's source is older than 90 days |
| Unverified | `.st-mute` | `.sb-mute` | grey · hollow / dashed block | content changed since the last verify run |
| Reproduced | `.st-ok` | `.sb-ok` | ver · solid | the lab suite matches the book in CI |
| Not reproduced | `.st-fail` | `.sb-fail` | red · solid / filled red block | a lab result diverges from the book |
| Running | `.st-run` (+ `.caret`) | `.sb-act` | warm · half-filled / act-bg block | a run or grading job is in progress |
| Killed | `.st-fail` | `.sb-fail` | red | a run was stopped before it finished |
| No lab | `.st-mute` | `.sb-mute` | grey · hollow | chapter has an instrument or checklist instead |

Rules:
- Status text is always the full word, uppercase via CSS. Never an icon alone. Never abbreviated below "Stale > 90 d".
- `.sb-fail` is the only filled red block; `.sb-ok`, `.sb-warn`, `.sb-act` are tinted with a 1px border of their hue.
- The running caret blinks once per 1.1s and holds still under reduced motion.
- The lab verdict (`REPRODUCED` / `NOT REPRODUCED` / `KILLED`) is the one big element of the output pane, 46px mono, then the diff.

## 7. Evidence tier badges (`.ev .ev-*`, 24px square; `.ev-lg` 40px)

The badge's weight falls with its strength. Only G is red, because it is the one tier that should stop a reader.

| Badge | Tier | Base | Encoding | Source chip equivalent |
|---|---|---|---|---|
| A | Reproducible | 100 | solid ink + 2px inset bg frame + 1px ink outline | der |
| B | Primary published | 85 | solid ink | pri |
| C | Primary vendor | 70 | 2px ink rule | ven |
| D | Independent analyst | 60 | 2px `--ink-2` rule | anl |
| E | Practitioner | 40 | 1px `--ink-2` rule | pra |
| F | Reported | 25 | dashed `--ink-3` | none |
| G | Opinion | 5 | dotted `--fail`, red text | none |
| U | Unverifiable | 0 | dotted `--ink-3`, struck through | opn |

Score display: formula in `.meta` (`70 × 1.0 × 1.0 × 0.8 = 56`), result in `.midnum` or `.score`; the live score instrument shows a `.bignum` with a `.meter` carrying two `.mark` ticks at floor and accept. Thresholds by change class (wording 40/5; cited figure 70/25; derived 100/100 A only; new claim 85/40; curator always for safety, OT boundary, scenario parameter, structure) are rendered as a banded bar: fail-bg below floor, warn-bg between, ver-bg above accept.

## 8. Instrument panel (the core component)

Everything the product shows sits in an instrument: `.inst › .inst-h · .inst-b · .inst-f`.

| Part | Class | Spec |
|---|---|---|
| Frame | `.inst` | 1px `--rule-strong`, `--bg` fill, no shadow |
| Header | `.inst-h` | one line of 32px (a 24px line, 3.5px padding above and below, the rule), padding 12 at the sides, bottom rule strong, mono 11px `--ink-2`. Its parts wrap: a label, a version or a timestamp that does not fit moves to the next 24px line whole, and nothing is clipped. (Changed 2026-10-05, unit 23c: the style guide's `nowrap` with hidden overflow cut the end off every header longer than its instrument, which with PT strings 30 % longer was most of them.) |
| Label | `.inst-h .t` | uppercase mono 500, `--ink`; names what the instrument measures (chapter, lab, suggestion id, budget) |
| Separator | `.inst-h .sep` | `·` in `--rule-2` |
| Version | plain span after `.sep` | semver of the thing measured; omit only if unversioned |
| Timestamp | `.inst-h .ts` | right-aligned, `--ink-3`; states the event, not just the time: "verified 12 Sep 2026", "ran 10:14" |
| Body | `.inst-b` | 16px padding; a caption, one heading, at most one big number, then a `.kv` list |
| Key–value | `.kv` | 2-column grid; `dt` lowercase mono 11 `--ink-3`; `dd` right-aligned mono 12 tabular |
| Footer | `.inst-f` | min 32px, top rule light, mono 11 `--ink-3`; provenance texture (release, sha) and at most two actions, primary last |

Rules: label, version, timestamp come first, in that order. Instruments tile edge to edge in a ruled grid with no gap, or stand apart by `--s5`. They never nest.

## 9. Components

Every class below exists in hb.css. Do not invent a variant; extend hb.css and this file together.

### 9.1 Buttons (`.btn`)

| Variant | Class | Spec |
|---|---|---|
| default | `.btn` | 36px, padding 0 14, 1px `--rule-strong`, transparent, 14px 500; hover `--bg-2` |
| primary | `.btn-p` | `--act` fill, `--on-act` text, a caption (`.meta`) inside it included: `--ink-2` on `--act` is under 4.5:1; hover `--act-hover` |
| quiet | `.btn-q` | transparent border, `--ink-2` text |
| destructive | `.btn-d` | outlined `--fail`, never filled |
| large | `.btn-lg` | 44px, padding 0 18 |
| small | `.btn-sm` | 28px, padding 0 10, 13px |
| disabled | `[disabled]` | `--ink-3` text, `--rule` border, `not-allowed`; a `.help` beside it states why |
| icon | `.iconbtn` | 32px square, 1px `--rule`; requires `aria-label` |
| key hint | `.kbd` | 18px, 1px `--rule-2`, mono 10.5 |

Rules: labels are verbs that describe the result (Run, Save run, Attach as evidence, Submit for grading). One warm primary per view. Touch (`pointer: coarse`): every button, segment and toggle grows to 44 × 44 minimum.

### 9.2 Inputs

| Element | Class | Spec |
|---|---|---|
| wrapper | `.field` | column, gap 6 |
| label | `.field > label`, `.flabel` | lowercase mono 11 `--ink-2`, above the field, always visible |
| text / select | `.input`, `.select` | 40px, padding 0 12, 1px `--ink-2`, `--surface` fill, radius 0 |
| textarea | `.textarea` | min 96px, padding 10 12, line 22, vertical resize |
| mono input | `.input.mono` | for anchors, ids, URLs |
| error | `.input.err`, and since unit 51c `.textarea.err` and `.select.err` | `--fail` border + 3px inset red bar; pair with `.help.err` |
| help | `.help` | 12px `--ink-3`; `.help.err` in `--fail` |
| checkbox | `.check` | 16px, `accent-color: --ink` |
| segmented | `.seg` | 1px `--ink-2`; buttons 32px; pressed = `--ink` fill, `--bg` text; `aria-pressed` |
| language toggle | `.langtoggle` | 1px `--rule-strong`, mono 12, 28px, min-width 40; pressed = ink fill |
| counter | `.counter` | mono 11 tabular, live (`aria-live="polite"`), `142 / 200 words` |

Rules: labels above, errors below, never placeholder-only. Error help says what failed and what would pass ("Tier G · score 5 is below the floor of 25 for a cited figure. Attach a tier B paper with code or a tier D benchmark.").

### 9.3 Tables (`.tbl`)

Heavy header, light rows. `th`: lowercase mono 11 `--ink-3`, 1.5px strong bottom rule. `td`: 13px, 1px `--rule` bottom, top-aligned. `.n` cells right-aligned mono 12.5 tabular. `.m` cells mono 12. `tr.sel` uses `--sel`. `tfoot` under a 1.5px rule, mono 12. `caption` top-left as `.cap`. No zebra striping, no vertical rules. Wrap wide tables in `.scroll`. A header cell wraps (since unit 23c): in a rail, a header that could not wrap made its table wider than the rail.

Diff table: book value is always the left column. `= match` in `.d-match` (cool), `≠ diverge` in `.d-div` with `tr.row-div` (fail-bg row), `+ new` in `.d-new` with `tr.row-new` (act-bg row). Symbol and word, then colour.

### 9.4 Timeline (`.tl`)

Grid `120px 24px 1fr` (76px on mobile). `.tl-t` right-aligned mono 11 time; `.tl-m` marker column with a 1px `--rule-2` spine; `.tl-b` body. Markers: `i.o` hollow = received; `i` filled ink = processed; `i.v` cool = approved; `i.f` red = declined or failed. Every record shows `prev …· hash …` in `.hash`, 12 hex characters.

### 9.5 Code and output

| Element | Class | Spec |
|---|---|---|
| pane | `.code` | `--code-bg`, 1px `--rule`, mono 12.5 / 20 |
| header | `.code-h` | 32px, file and range, actions right (`Copy`, `Open in Labs`, `Run`) |
| body | `.code-b` | `white-space: pre`, horizontal scroll |
| line | `.ln[data-n]` | generated line number, 44px gutter, `--ink-3` |
| linked line | `.ln.hl` | ver-bg + 2px cool inset bar: the line a `ƒ` link opens |
| failing line | `.ln.hl-f` | fail-bg + red bar |
| edited line | `.ln.hl-a` | act-bg + warm bar |
| syntax | `.k` `--act`, `.s` `--ver`, `.c` `--ink-3` italic, `.fn` 600 | three hues and italics only |
| terminal | `.term` | `--term-bg` / `--term-ink`, mono 12 / 19, padding 12 14, `role="log"` or `region` with aria-label |

Code regions carry an `aria-label` naming file and line range.

### 9.6 Meters and loaders

`.meter`: 8px tall, 1px `--ink-2` frame, transparent, flat fill in `--ink` (`.warn`, `.fail`, `.ver` change the fill). `.mark`: 2px tick, `--fail` (or `.ok` for `--ver`), named in the aria-label and caption. Always `role="meter"` with `aria-valuenow/min/max`. The value is printed in text beside every bar.

`.loader`: mono 12 status string with `.blocks` characters (`▮▯` or `█░`) and always a number: percentage, count or seconds. **No spinners, no skeleton shimmer.**

### 9.7 Chips and marks in text

`.chip`, `.derive`, `.xref`, `.cite`, `.nocover`, `.st`, `.ev` are all inline-flex and vertically aligned to sit in running prose at 17/28.

### 9.8 Chrome

| Element | Class | Spec |
|---|---|---|
| top bar | `.topbar` | 48px, bottom rule strong |
| brand | `.brand` | `✢ Harness Bible` + faint `interactive`, mono 13, right rule |
| primary nav | `.nav a` | 44px min, padding 0 18, right rule; current = `aria-current="page"`, `--ink`, 2px inset bottom bar, 500 |
| search | in `.grow` | 32px field, 1px `--rule`, `.cap` "search", placeholder "chapters, labs, registries", `.kbd` `/` |
| release stamp | `.tex` | `release 2026.09 · sha 7f3a9c1e` |
| language toggle | `.langtoggle` | EN / PT, `role="group"`, `aria-label="Edition language"` |
| status bar | `.statusbar` | 28px, top rule strong, mono 11, cells with right rules; last cell right-aligned with a timing (`loaded 0.38 s`, `first token 1.3 s`) |
| outline rail | `.outline a` | 13px `--ink-2`; current `aria-current="location"` 600; `.n` mono 11 number column 34px |
| tree | `.tree li` | mono 12.5 / 26, box-drawing characters `├─ └─ │` in `--ink-3`, `✢` glyph in `--act` on nodes |
| peek panel | `.peek` | 1px strong on `--surface`, `role="dialog"`, `.inst-h` header with `esc` kbd, footer links "open in place" / "side by side"; focus returns to the link on close |
| dock | `.dock` | left rule strong, `--bg` |
| empty state | `.empty` | dashed `--rule-2`, padding 32 (20 mobile); a `.cap`, a `.h4` or `.ui` line, a muted reason, and the one action that fills it |
| error | `.error` | 1px `--fail` + 3px inset bar on `--fail-bg`, `role="alert"`; says what failed, what was kept, what to do next |
| notice | `.notice` | 1px `--warn` + 3px inset bar on `--warn-bg` |

### 9.9 Book Home and chrome composition (added 2026-09-22 with feature-specs/02-book-home.md)

Composition classes that the UI package expressed as inline styles. They live in `globals.css` `@layer components` beside the ported hb.css classes.

| Class | Rule | Where |
|---|---|---|
| `.topbar-mid`, `.topbar-end`, `.searchbox-form`, `.searchbox`, `.searchbox-input`, `.statusbar-end` | the top bar's middle and end clusters, the 420px search field, the right-aligned status cell. Below 1000px the top bar wraps: brand and nav on the first row, toggle and account at its end, search and release stamp on a full-width second row. From 1000px to 1199px the release stamp (`.topbar-mid .tex`) is hidden: with the nav's five items the middle cluster is 148–362px wide there, too narrow for the search field and the stamp side by side, and the stamp had wrapped under the field and out of the bar (feature-specs/48 § 32, unit 72's review). The status bar carries the release on most pages; from 1200px the stamp shows, on two lines up to about 1239px | chrome |
| `.home-main` | `padding: 28px 40px 32px; column; gap: 24px` (`20px 16px 24px` below 1000px) | Book Home |
| `.home-hero`, `.home-hero-solo` | `minmax(0,1fr) 460px` hero row; solo variant when no Continue reading instrument | Book Home |
| `.home-blurb` | 17/26, max-width 700 | Book Home |
| `.status-cells`, `.status-cell`, `.status-cell-first`, `.cellnum` | the four-cell grid `330px repeat(3, 1fr)`, two columns under 1000px and one under 640px with no rule under the last row; 24/28 mono cell numbers. Since 2026-10-12 on Book management, without the legend cell (feature-specs/47 D7) | Book status |
| `.legend-row`, `.legend-mark`, `.home-legend`, `.home-legend-rows` | 22px rows with a 118px mark column; since 2026-10-12 the home's last instrument, `legend`, its rows four abreast, two under 1000px and one under 640px (feature-specs/47 § 5) | legend |
| `.part-grid` | 9-column edge-to-edge `<ol>`; 5 columns below 1000px, 3 below 768px | part sections |
| `.tile`, `.tile-head`, `.tile-n`, `.tile-title`, `.tile-meta`, `.tile-marks` | chapter tile anatomy; title reserves 54px (three lines) | chapter tiles |
| `.tile-cur` | `--surface` fill + 2px inset bottom ink bar | the reader's current chapter |
| `.tile-stale` | 3px inset top `--warn` bar | a chapter with a fast-moving figure > 90 d |
| `.tile-fail` | 3px inset left `--fail` bar | a chapter whose lab does not reproduce |
| `.tile-glance` | `--bg-2` band, `padding: 14px 16px`, `grid-column: span var(--span-N)` where the grid sets `--span-9/5/3` to complete the row | at-a-glance and appendix cells |
| `.reading-mark` | `--act` caption `reading 21.3` | current tile |
| `.st-plain` | status mark without uppercase or tracking | "no lab · prose" marks |
| `.sb-sm` | small status block, min 20px, 10.5px; wraps its text and never overflows the tile (the PT `desatualizado 97 d` chip drops to a second line under the number) | `stale 97 d`, `1 open` chips |
| `.reader`, `.reader-outline`, `.reader-main`, `.reader-rail`, `.reader-rail-inline` | the `280px 1fr 344px` reader grid and its three columns; below 1000px the rail hides and `.reader-rail-inline` (the same instruments, in the reading column) shows; below 768px one column | Reader Chapter (feature-specs/03 § 5) |
| `.reader-title`, `.standfirst`, `.section-head`, `.section-title` | 720px title, 17/26 standfirst, 680px section head | Reader Chapter |
| `.source-rows` with `.src-link` | the layer-9 table (`# · claim or figure · source · link · tier · verified`); the `link` column renders only when a row of the chapter has a link, its cell is the `.src-link` tag or empty; the citation is plain text, never a link | Reader Chapter, Sources (feature-specs/10 § 6) |
| `.outline-layers` | the nested nine-layer list under the current chapter, 1px left rule | outline |
| `.prose h3`, `.prose > * + *`, `.prose table.tbl`, `.prose .code`, `.prose .fig` | rhythm of the pre-rendered body: 16px between blocks, 20/26 sub-headings, 680px panes | section body |
| `.fig` | figure frame on `--surface` with a light header rule, SVG padded 20/20/16, caption 10/14 | figures |
| `.fig svg …` | Mermaid diagrams rendered at ingestion arrive with Mermaid's own classes and no styles; these rules colour them from tokens in both themes: `text`/`tspan` ink in `--mono` 12px, `.node` shapes and `rect.actor` on `--bg` with an ink stroke, `.cluster` on `--bg-2`, edges and `.messageLine*` in `--ink-3` at 1.5px, markers `--ink-3`, `.edgeLabel` on `--surface`, `.note` on `--warn-bg`, dashed `.messageLine1`/`.loopLine`. Mermaid gives an actor's label the same `actor` class as its box, so `text.actor` is set back to ink | figures (added 2026-09-22 with feature-specs/04) |
| `.flash` | `--sel` background for 1.5 s on a line or figure the reader jumped to; no animation | derive chips, figures table |
| `.peek-float`, `.peek-help`, `.peek-body`, `.sheet` | the floating peek (absolute, 380px, beside its link), the fixed `?` map (top right, 380px), the phone contents sheet (fixed bottom, 70vh) | peek, keyboard map, phone |
| `.actions-list .btn` | full-width buttons with the label left and the hint right | section actions |
| `.figures-row` | pointer cursor on a figures-table row that can jump to its figure | figures table |
| `.paths`, `.paths-head`, `.paths-grid`, `.paths-grid-one`, `.paths-blurb` | the reading-paths page: 28/40/32 padding, a `1fr 520px` head row aligned to the bottom, three equal instruments (one column below 1200px; a single 720px column on `/paths/[path]`) | Book-Paths (added 2026-09-22 with feature-specs/05) |
| `.marks-grid`, `.marks-cell`, `.marks-count`, `.marks-latest` | the "Your marks" instrument: `120px 120px 1fr` cells, 24/28 mono counts; two columns with the latest note spanning below 768px | Book-Paths |
| `.path-inst`, `.path-body`, `.path-foot`, `.kv-prose`, `.path-progress` | a path instrument that stretches to its row, prose `dd`s in `--sans` 13px on a 92px key column, the progress block | Book-Paths |
| `.sequence`, `.sequence-group`, `.sequence-stop`, `.stop-current`, `.tree`, `.read-state` (`.is-read`, `.is-progress`), `.stop-label`, `.stop-title`, `.stop-read`, `.stop-in_progress`, `.stop-at`, `.stop-mark`, `.stop-min` | the grouped stop list: `✢` group rows, `├─ └─` tree glyphs in `--ink-3`, `□ ■ ◧` read state in `--ink-3` / `--ver` / `--act`, the in-progress row on `--act-bg` with a 600 title and `· at NN.k` in `--act` | Book-Paths |
| `.dialog-box` | a `.peek` fixed at the top third of the viewport for confirm dialogs (reset path) | Book-Paths |
| `.home-paths-link` | the `Reading paths →` caption link under the Book Home blurb | Book Home |
| `.search`, `.search-filters`, `.search-filters-form`, `.search-main`, `.search-rail`, `.search-head`, `.search-title-row`, `.search-summary` | the search page: `296px 1fr 320px`; the rail drops below the results as two columns under 1200px; one column under 1000px with the filters in a two-column grid above the results; 16px padding on phones | Book-Search (added 2026-09-22 with feature-specs/06) |
| `.filter-group`, `.filter-row`, `.filter-off`, `.filter-ordinal`, `.filters-apply` | the `fieldset.rt` groups (no side rules, 14px top gap), 28px value rows, disabled values in `--ink-3`, the layer ordinal column, the no-JS Apply button hidden once `html.js` is set | filters |
| `.seg-links` | a `Seg` whose segments are links (`aria-current` on the current one; since unit 51b a segment with nowhere to go is `.is-off`): ink-filled when pressed, same 32px height and rules as `.seg button` | sort |
| `.filters-note` | the inline `.empty` row above the results: `✢` and one line, horizontal | results |
| `.hit`, `.hit-head`, `.hit-lead`, `.hit-label`, `.hit-kind`, `.hit-body`, `.hit-meta`, `.hit mark`, `.hit-foot` | one result: 72px mono label, title link, faint context, the kind label right; snippet and meta indented 82px (0 on phones); `mark` on `--sel` with a `--ver` hairline below | results |
| `.query-bars`, `.query-terms`, `.rail-btn`, `.marks-legend` | the Query instrument's four mono bar rows (`pre`, 12/18; eight cells a bar, so the label, the bar and the milliseconds fit the 320px rail; it scrolls sideways when a language's stage names are longer, and takes keyboard focus for that), the terms block, full-width rail buttons with their meta right, the marks legend | rail |
| `.topbar-search` | with `.topbar-compact`, keeps the search field visible on phones as a full-width third row (the release stamp hidden) | search page chrome |
| `.statusnote` | the transient `copied` cell in the status bar, in `--ver` | status bar |
| `.mark-btn` (`.is-on`), `.mark-square`, `.mark-flag` | the bookmark toggle in the actions rail: pressed state in `--ver` on `--ver-bg` with an 8px square before the label; the read-only `■ bookmarked` flag after the layer cap | Reader Chapter (added 2026-09-22 with feature-specs/07) |
| `.note-editor`, `.note-foot`, `.note-status` (`.is-dirty`, `.is-error`), `.counter.is-near`, `.counter.is-over` | the note editor under the rail actions: a ruled block with the `.textarea` at 14/22, the status line and buttons (44px on phones), the counter in `--warn` from 1900 and `--fail` over 2000 | Reader Chapter |
| `.marks-page`, `.marks-lists`, `.mark-list`, `.mark-row`, `.mark-head`, `.mark-id`, `.mark-title`, `.mark-context`, `.mark-gone`, `.note-body` | the marks page: 28/40/32 padding, two instruments side by side (one column under 1200px), ruled rows with a 44px mono id column, the 600 title link, the faint chapter context (its own line on phones), the `--warn` "not in release" cap, note text in `pre-wrap` at 60ch | Book marks page (`/[lang]/marks`) |
| `.auth`, `.auth-btn` | the sign-in and sign-out pages: a centred 520px column with 48px margins (24px on phones), 44px provider buttons with their meta right | Sign-in, Sign-out (added 2026-09-22 with feature-specs/08) |
| `.account`, `.account-head`, `.account-head-actions`, `.account-facts`, `.account-grid`, `.account-inst`, `.pref-row`, `.sessions-table-wrap`, `.sessions-table`, `.topbar-account` | the account page: 28/40/32 padding, the Account-Admin head row (name left, four `dt.cap`/`dd` facts right, stacked as a two-column `dl` under 1000px; for a curator or an organisation admin a third cell with the `Book management` button, which stacks under the facts there, feature-specs/47 § 4), two instruments per row (one under 1200px), 40px preference rows with a `Seg` and its scope note, the sessions table in a scrolling wrapper with a right-aligned action column, the top bar's `Sign in` / `Account` item | Account |
| `.reader-dock`, `.outline-condensed`, `.outline-expand`, `.outline-part`, `.outline-numbers`, `.outline-layer`, `.outline-path`, `.inst-strip`, `.inst-strip-end`, `.dock`, `.dock-head-actions`, `.dock-iconbtn`, `.dock-modes`, `.dock-mode-row`, `.dock-context`, `.dock-log`, `.dock-ask` | the reader with the assistant open: the grid keeps 64px for the condensed outline and reserves 520px for the dock, and the reading column scrolls inside itself so the fixed dock always sits between the top bar and the status bar. The condensed rail is a 48px expand button, the part's roman numeral, 44px mono chapter numbers (the current one 64px on `--bg-2` with a 2px inset ink bar and its section's ordinal under the number) and the path count at the foot. The chapter instrument becomes one strip (`.inst-strip`) at the head of the column. The dock is a flex column: `.inst-h` header, the mode block, the log (`flex: 1 1 auto; overflow: auto`) and the ask form; the checked mode radio takes the pressed ink form of § 9.10. Under 1000px the dock is an overlay of `min(520px, 100vw)` and the grid stops reserving space; under 768px it does not render at all and the reading column shows a `.notice` in its place (`phone-only`): the phone sheet of feature-specs/20 was skipped on 2026-10-03 | Assistant dock (feature-specs/16 § 4; added 2026-09-25 with unit 30) |
| `.turn`, `.turn-current`, `.turn-you`, `.turn-assistant`, `.turn-body`, `.turn-actions`, `.turn-counts`, `.answer-pending`, `.dock-textarea`, `.dock-ask-row`, `.dock-lang`, `.verdicts`, `.verdicts-toggle`, `.verdicts-glyph`, `.verdicts-summary`, `.verdicts-grid`, `.verdicts-foot`, `.cited-band`, `.cited-line`, `.cited-passage`, `.dock-backdrop` | one turn and its receipt: the question on `--bg-2` with a 2px left rule, the assistant's block indented 12px, the streamed draft as plain text with the `.caret` and nothing else, the action row with its count pushed right (its buttons `Copy with citations`, `Flag this answer`, since unit 75 `Start a research` — a link to the Research page seeded from the answer, feature-specs/48 § 9.1 — and a lab turn's `Open Lab NN`), and the verdicts box on `--surface` — a 32px toggle (its bottom rule only while open) over a `112px 1fr auto` `dl` and the `.inst-f` record line. In the reading column, `.cited-band` is the `--ver` band under the section head and `.cited-passage` the 2px inset rule and `--ver-bg` wash on a paragraph the open answer cites; `.dock-backdrop` is nothing until the dock becomes an overlay under 1000px | Assistant dock, turns and verdicts (feature-specs/16 § 5.4–5.8, § 7; added 2026-09-25 with unit 30) |
| `.refusal`, `.refusal-head`, `.refusal-body`, `.refusal-covers`, `.refusal-pointer`, `.refusal-foot` | the refusal card in place of an answer's body: a `.box-s` with a 3px `--fail` inset bar, a 32px head rule carrying the `refused` mark and `cause · …`, the catalogue sentence at 14/22, the `what the book does cover` rows (a `.cite` chip and the section's title, 28px, each the peek's link), and the `.inst-f` footer with the code line left and the 24px quiet `Flag this refusal` right | Refusal card (feature-specs/17 § 3; added 2026-10-03 with unit 31) |
| `.flag-flagged` | a flagged message's button once the flag is stored: the same 28px button, disabled, reading as the mono caption it has become — `flagged · wrong citation` — so the row keeps its shape and says with what | Flag button (feature-specs/17 § 4; added 2026-10-03 with unit 31) |
| `.conversation-log`, `.log-head`, `.log-turns`, `.log-turn` (`.is-current`, `.is-refused`), `.log-turn-head`, `.log-key`, `.log-earlier`, `.log-earlier-cap`, `.log-earlier-row`, `.log-none`, `.log-foot`, `.log-toggle`, `.log-backdrop` | the conversation log rail: at 1360px and up a fixed 232px `.rl` column between the reading column and the dock, which the grid makes room for through `body:has(.conversation-log)`; 64px rows (`t1 · 10:31`, the mark, the question wrapping with `overflow-wrap: anywhere`, the caption), the current row on `--bg-2` with a 2px inset `--act` bar and a refused row with the `--fail` bar; the verdict key, the earlier-conversations rows (44px), and the `.inst-f` foot with the `.tex` hash fragment. Below 1360px the rail is hidden and the dock's header shows `.log-toggle` (`Log · 4 turns`), which opens the same rail as an overlay to the dock's left with a backdrop; under 768px none of it renders | Conversation log (feature-specs/17 § 5; added 2026-10-03 with unit 31) |
| `.assistant-page` (`[data-view]`), `.assistant-page-notice`, `.assistant-conversations` (`.is-open`), `.conversations-new`, `.conversations-tree`, `.conversations-open`, `.conversations-more`, `.conversations-none`, `.assistant-stats`, `.assistant-views` | the assistant's page (feature-specs/26): a grid `232px minmax(0, 1fr) 330px` under the top bar and above the status bar, each region scrolling on its own. The conversations are a tree of `.log-earlier-row` links, the open one marked with the act bar and unfolded into the log's own turn rows; the dock is static, at most 680px wide and centred in the middle column; the statistics sit in a 16px-padded rail. From 1000px to 1359px the conversations leave the grid and open as a fixed 232px overlay from the dock header's toggle; under 1000px the grid is one column and `.assistant-views`, a `.seg-links` of three links, puts one region in front through `data-view` | the assistant's page (added 2026-10-03 with feature-specs/17, rebuilt 2026-10-04 with feature-specs/26) |
| `.dock.is-over`, `.dock-backdrop.is-over`, `.conversation-log.is-over`, `.log-backdrop.is-over`, `.dock-phone` | the dock on any page but a reader section (feature-specs/24 § 5.6): no page gives it a column, so from 768px up it lies over the right 520px at every width with the 50 % `--bg` backdrop that closes it, the form it already took under 1000px; its log rail is the overlay the header's `Log · n turns` toggles, at every width. Under 768px the dock does not render and `.dock-phone`, a fixed strip at the foot of the page with the notice and a close link, says so | every page under the locale (added 2026-10-04 with feature-specs/24) |
| `.stats`, `.stats-window`, `.stats-grid`, `.stats-cell`, `.stats-causes` | the reader's statistics (feature-specs/25 § 5): one instrument whose bare body is the window control (`.seg-links`, this month and all time), a ruled grid of cells two to a row at the rail's 330px, each a `.cap` name, a `.cellnum` value, its count in `.cap.faint` and, for a share with a threshold, a `.meter` with the `.mark` and the threshold's caption (in `--fail` with the words `below floor` or `above ceiling` when crossed); then the refusals by cause as a `.tbl` and the retention facts as a `.kv`. The account page's budget meter follows it, 24px below. The Research page's statistics (feature-specs/48 § 11.6; unit 73) are the same instrument with five cells and no meter in them, each cell's line a `.cap.faint.col` of one part to a row (`3 done`, `2 refused`), since a run-on line in a cell some 117px wide parts a count from its word; the retention line a `.small` under the grid | the assistant page's right rail (added 2026-10-04 with feature-specs/25); the Research page's third region (unit 73) |
| `.budget-inst`, `.budget-head`, `.budget-meter`, `.budget-scale`, `.budget-notice`, `.budget-breakdown`, `.budget-unit` | the model budget meter on the account page, after the Account-Admin screen's instrument: `.budget-head` puts the `.bignum` percentage beside the `.meta` `1.84 M of 2.50 M tokens`, bottoms aligned, wrapping on a phone; `.budget-meter` is the 14px `Meter` with the cap `.mark` inside its right edge (`--fail` fill at the cap); `.budget-scale` is the `.between.meta` line under it (`0` · `0.66 M left` · `hard cap 2.50 M` in `--fail`, or `no cap set`); `.budget-notice` is the projection as a `.notice.small`, and at the cap an `.error.small` in `--fail` with `role="status"`; `.budget-breakdown` is the `.tbl` at 12.5px with its `caption.cap`, the row notes `.faint.small`, a row with nothing in it `.faint`; `.budget-unit` is the `.meta.faint` line that states the unit. Never colour alone: every state is a sentence | Budget meter (feature-specs/21 § 4.2; added 2026-10-04 with unit 35b) |
| `.proposal-panel`, `.proposal-body`, `.proposal-anchor`, `.proposal-rests`, `.proposal-sources`, `.proposal-source`, `.proposal-note`, `.proposal-where`, `.proposal-actions`, `.proposal-consent`, `.proposal-confirm`, `.proposal-failure` | a research proposal under its answer (feature-specs/43 § 5.1; added 2026-10-10 with unit 60b): an `.inst` of the turn's, its header an `h3` with the id and `not part of the answer`; the body's lines in `.meta`, the sources as rows with their badge and score, the change in the outcome page's `.tbl.outcome-change` (the `ChangeTable` component); the footer's consent in the body's face (`--sans` 13px), not the footer's mono; the change's two cells stacked under 768px; 44px targets under `pointer: coarse` |
| `.research-log`, `.research-log-head`, `.research-log-months`, `.research-log-refuted`, `.research-log-table`, `.queue-research-note` | the research log (feature-specs/43 § 7.2; added 2026-10-11 with unit 60d): the landing page's measure, two `.tbl` each in a focusable `.roster-scroll` region on a phone, row headers and ids unbroken; and the researcher's note in the queue's detail. Also from 60d: the queue's evidence table scrolls in its own region on a phone, and a `.statusbar` cell wraps under 768px rather than widen the page |
| `.improve-home-proposals` | the reader's research proposals on the Improve landing page (feature-specs/43 § 6; added 2026-10-10 with unit 60c): a section with the page's `.tbl.improve-home-table`, the id's cell never broken at its hyphen |
| `.research-line`, `.research-label` | the research line under an answer (feature-specs/43 § 4; added 2026-10-10 with unit 60a): the turn's last child after the verdicts box, the `.inst-f` style — 11px mono, `--ink-3`, wrapping — reading `research ·` then the state's word as a `.st.st-plain` mark in its hue (the caret while the run is under way, `--ver` for a proposal, `--warn` while waiting for the budget, hollow grey for a skip, `off`, `not run` and `failed`) and, after another `·`, the detail where there is one (the days, the reset, the day's count); `aria-atomic`, no live role of its own since the log is one; never inside the answer block. Since unit 75 (feature-specs/48 § 9.3) a legacy run's alone — no new turn has one — and `off` has no `switch on` link, the account page's switch being gone | Research in the product (feature-specs/43 § 4) |
| `.research-page`, `.research-frame`, `.run`, `.run-body`, `.run-steps`, `.run-steps-toggle`, `.run-steps-list`, `.run-report`, `.run-report-body`, `.run-report-cap`, `.run-ref`, `.run-pages-slot`, `.run-pages`, `.run-pages-list`, `.run-page`, `.run-page-link`, `.run-page-host`, `.run-page-title`, `.run-findings`, `.finding`, `.finding-cap`, `.finding-body`, `.finding-anchor`, `.finding-sources`, `.finding-note`, `.finding-use`, `.run-actions`, `.seed-card-body`, `.seed-card-scratch`, `.research-runs`, `.research-run-row`, `.research-meta-part`, `.finding-action`, `.finding-press` | the Research page (feature-specs/48 § 11.3; added 2026-10-12 with unit 72; a finding's button, unit 74). It reuses the Assistant page's `.assistant-page` (with `[data-view]`), `.assistant-conversations`, `.assistant-stats` and `.assistant-views` as they are; `.research-page` is the one modifier and sets only the column's padding under 768px; the frame line (`.research-frame`, a `.cap` under the header on a light rule) is the column's and, since unit 77, the Research dock's. A run is an `article.run` — the question in the turn's `.turn-you`, then `.run-body` indented 12px (0 under 768px): the caption, the run's `.research-line` with no top margin or side padding, the steps (a mono 12px list on a dashed `--rule-2` spine, its toggle the caption with `▸`/`▾`, folded once the run ends), the report (plain paragraphs at 14/22 under the `report · from the web, not from the book` caption, a page reference `[n]` cool and dotted as a traversal), the pages read (an `.inst` of numbered rows, each a link out whose host is cool, an address wrapping anywhere, the row a `run-<runId>-page-<n>` target on `--sel`), the findings (each ruled, unfilled, headed by its numbering caption, its change in the outcome page's `.tbl.outcome-change` stacked under 768px) and the cost row. The containers that are empty — no steps, no report, no pages, no finding, no cost — take no room. The seed is an `.inst` whose header names the answer and links it. In the list, the open research's runs are `.research-run-row` links under it, and each part of a research's meta is a `.research-meta-part` that never wraps, its `·` kept with it, so the 232px row breaks between parts (unit 72's review). 44px targets for the steps' toggle and a run's row under `pointer: coarse`. Under each finding, since unit 74, `.finding-action`: its status line (`.finding-use`, which takes the focus when it replaces the pressed button) above the button of the person's role, the button with its help line under it (`.finding-press`), the step 1 throttle notice in its place, and a proposed finding's `.proposal-panel` stretched to the finding's width with no top margin; its buttons 44px under `pointer: coarse` | the Research page (feature-specs/48 § 11; unit 72; § 8.1, unit 74) |
| `.purged` | a turn whose words the 30 days took: the line `text purged after 30 days · citations and verdicts kept` as a `.nocover.purged` span in `--ink-3` where the answer's body or the question was, never colour alone; the chips, the verdicts box and the record footer stay, a walk keeps its strip and bars, a lab its table. The log row's `.small` reads `text purged`, and a purged conversation's row in the list and the rail says so in its `.meta`. On the account page the retention instrument gains a `.meta` line under its `.kv`: `21 conversations · oldest text kept until 25 Oct 2026` | Retention evidence (feature-specs/21 § 3.2; added 2026-10-03 with unit 35a) |
| `.dock-context-pick`, `.compare`, `.compare-side`, `.compare-open`, `.labturn`, `.lab-figures`, `.brief`, `.brief-stance`, `.brief-claims` | compare, lab and brief in the dock: in the context block, compare's picker row (a `.flabel`, a 32px mono `.select` of the release's chapters with the current and the unverified ones disabled and named so, the `swap` `.xref`) over the context line `context · ch21 v1.0.0 ↔ ch28 v1.0.0`; lab's line names the lab and its last run, or an `.empty` when the chapter has none; brief's names Part III. The bodies between the turn's head and its verdicts: `.compare` is two `.compare-side` columns (one below 1200px), each a `.cap` `ch21 · title` over an `ol.claims` with chips (a replaced claim in the `.nocover` form where it was said), and `.compare-open` a full-width `.notice` for the point the book leaves open; `.labturn` is a `.kv` of the lab's facts with left-aligned values, the model's one sentence, the `.tbl.lab-figures` diff table in a `.scroll` (caption `figures Lab 21 checks`; figure chip, the chapter's value as `.fig-der` with its `ƒ L8` chip, the run's value, `= match` in `.d-match` or `≠ diverge` in `.d-div` on a `tr.row-div`) and then the claims as explain renders them; `.brief` is the `.cap` `executive brief · {decision}`, the `.brief-stance` mark (ver, warn or muted) with its condition, the numbered `ol.brief-claims` and the muted count of Part III chapters cited | Compare, lab and brief (feature-specs/19 § 3, § 6; added 2026-10-03 with unit 33c) |
| `.walk-form`, `.walk-pick`, `.walk-inputs`, `.walk-form-row`, `.turn-walk`, `.walk`, `.walk-steps` (`.is-done`, `.is-now`, `.is-later`), `.walk-body`, `.walk-run` (`.is-failed`), `.walk-result`, `.walk-bars`, `.walk-headline`, `.walk-explain`, `.walk-foot`, `.walk-summary`, `.walk-missing`, `.walking`, `.walking-band`, `.walking-line`, `.aid-tree`, `.aid-tree-list`, `.aid-tree-root`, `.aid-tree-step` (`.is-done`, `.is-now`, `.is-later`), `.aid-tree-mark` | the decision-aid walk: in the ask slot, the form in place of the composer — the `.seg` picker under a `.flabel`, the two-column inputs grid of `.field` + `.input.mono` with the range as `.help` (or the 422's `.help.err`), the primary `Run at these inputs` right of the aid's section line. In a turn, the user line as a row (`you · 10:40 · mode changed…` left, the section right) over `section.inst.walk` on `--surface`: the step strip as an `ol` grid of n columns, each `li` a 44px button under a 2px top rule (ink done, `--act` now with `aria-current="step"`, `--rule` and `--ink-3` later); the body with the read-only inputs grid on step 1, the `.loader` run line (`lab-21/derive.py ▮▮▮▮▮▮▮▮▮▮ 100% · exit 0 · 0.6 s`, `--fail` when the run failed) and the step's result — `.cap` caption, the `.walk-bars` grid of label · `.meter` · mono value, the `.midnum` headline in `--ver` beside the explanation at 14/22 with its `ƒ L8` chip and the muted prices line; the `.inst-f` footer with Back, the quiet `Flag this step` and the primary Next or Done. Done collapses the instrument to the `.walk-summary` row (`walked · 4 steps · 76.9%`). In the reading column under the section head, `.walking-band` is the run-tone band on `--act-bg` (`walking` mark, `The assistant is walking this aid with your inputs. Step 2 of 4.`) and `.aid-tree` the `.cap` `decision aid · will the task survive its worker?` over a `.tree.box` list: the `✢` root in `--act`, `├─ └─` rows in `--ink-3`, the done rows in `--ink-2`, the current row on `--act-bg` with `aria-current="step"`, and the marks in words (`done`, `now`) pushed right | Decision-aid walk (feature-specs/18 § 5; added 2026-10-03 with units 32c and 32d) |
| `.phone-only`, `.desktop-only`, `.band-source`, `.chapter-strip`, `.action-bar`, `.action-bar-three`, `.action-bar-btn`, `.action-bar-primary`, `.topbar-compact` | the phone reader: source band, one-strip instrument, the 60px action bar (primary in `--act`) and the compact top bar (brand and toggle only). `.action-bar-three` is the bar's three-column form, which it has carried since the bookmark cell joined Contents and Ask (2026-09-24, unit 37d); the cell reuses `.mark-btn.is-on` and `.mark-square` from the rail, so the pressed state is the same word, square and `--ver-bg` wash at every width | Reader Chapter (feature-specs/03 § 6.10, 07 § 6.6) |
| `.suggest-page`, `.improve-strip`, `.suggest-start`, `.anchor-step`, `.anchor-step-head`, `.anchor-step-back`, `.anchor-kind`, `.seg-links > .is-off`, `.anchor-list`, `.anchor-list-id`, `.anchor-list-entry`, `.anchor-list-age` (`.is-stale`), `.anchor-list-foot`, `.anchor-text`, `.anchor-quote`, `.anchor-quote-marks`, `.anchor-create`, `.anchor-change` | step 1 of the suggest form, from the Improve-Suggest screen's inline styles. `.improve-strip` is the chapter context strip on `.band` with its bottom rule: the screen's 44px line, wrapping and growing with PT, 8px above and below so that a wrapped strip's link keeps its target clear of the top bar (unit 51c). `.anchor-step` is the 392px left column (24/20/24/24, 18px apart). `.anchor-kind` holds the `.seg-links` kind control, where a kind with nothing to choose is `.is-off`, a faint disabled link. `.anchor-list` is the 12.5px list of figures or rows with `tr.sel`; on the selected row the id is 600, the entry 500, and a stale age is `--warn`. `.anchor-quote` is the anchored text: a `.box` on `--surface` with a 3px `--ver` inset bar, 15/24, its chip and mark 10px below. `.anchor-create` holds the button: for a section, first its four kinds of change (34 D4), native radios in 28px `.check` rows under a `.flabel` legend with the next-step line, then the primary `Create draft`, then a refusal's `.error`. Under 768px the column is the page's width (34 § 16) | Improve-Suggest, step 1 (feature-specs/34 § 4, § 13; added 2026-10-07 with unit 51b) |
| `.suggest-edit`, `.edit-form`, `.edit-step`, `.edit-step-title`, `.improve-strip-draft`, `.improve-strip-id`, `.class-panel`, `.class-panel-name`, `.class-panel-moved`, `.value-grid`, `.value-arrow`, `.value-before`, `.value-after`, `.value-line`, `.save-status` | the suggest form's edit page, from the Improve-Suggest screen's inline styles. `.suggest-edit` is the three-column grid (392px, the form, 376px); its left column is step 1's `.anchor-step`. `.edit-form` is the middle column (24/32, 22px apart), each step an `.edit-step`: a `.rt-s` rule with 14px above, a head of the `.meta` number beside the `.h4` title (`.edit-step-title`, 10px), and the kind's `.cap` at the right. `.improve-strip-draft` is the strip's right end — `.cap` `suggestion`, the id in ink at 500 (`.improve-strip-id`), the muted `.st-block` — pushed right and wrapped as one. `.class-panel` is the Change class `.inst`: the class at 500, a `.kv`, and `.class-panel-moved`, the class-changed line, a status region spaced only once it says something. `.value-grid` is step 2's grid (1fr 28px 1fr 1.25fr, bottoms aligned): `.value-before` struck through in `--ink-3` on `--bg-2` with a `--rule` border, the 40px `.value-arrow`, and `.value-after` with an `--act` border, a 3px inset bar and 600 `--act` text (`.input.err` over it when the value is not a decimal). `.value-line` is the printed change with `.d-new` and its `.cap` percentage. Under 1200px the empty right track goes and the anchor column is 300–340px; under 1000px the anchor column stands above the form with a bottom rule; under 768px the grid is a block and the page the "desktop or tablet" notice (34 § 16, § 19). `.save-status` is the status bar's last cell on this page, which wraps rather than runs past the bar | Improve-Suggest, the edit page (feature-specs/34 § 5, § 17; added 2026-10-08 with unit 51c) |
| `.edit-fields`, `.source-pick`, `.source-text`, `.source-pick-use`, `.text-grid`, `.text-field` (`.text-field-tall`), `.passage-hints`, `.edit-choice`, `.edit-check`, `.row-edit-grid`, `.row-text`, `.row-now`, `.new-row-links` | step 2's other five kinds, which no screen draws, in the value editor's form. `.edit-fields` stacks an editor's fields 12px apart. `.source-pick` is the section's source text: a mono `.textarea` at 12.5/20, 220px high and resizable, that takes no edit (`.source-text`; `aria-readonly`, not `readonly`, which in Chromium takes the keyboard's selection away), with its `.help` under it, then the `Use the selected text` `.btn-sm` beside a status line (`.source-pick-use`). `.text-grid` sets a passage and its replacement side by side (1fr 28px 1fr, tops aligned), each a 120px `.text-field` (180px for a restructure), with the sensor's checks under it as `.help`, or `.help.err` for what intake refuses (`.passage-hints`). `.edit-choice` is a fieldset of native radios in 28px `.check` rows under a `.flabel` legend, as step 1's `.anchor-change`; `.edit-check` a checkbox row. `.row-edit-grid` is a row field's current value beside the proposed one (1fr 28px 1fr, bottoms aligned): the current one `.row-now` in `--ink-2` on `--bg-2` with a `--rule` border, struck through as `.value-before` once a new one is written; a claim and a citation are 64px `.row-text` areas. `.new-row-links` sets the link and the DOI side by side. On touch, a radio or checkbox row is 44px | Improve-Suggest, the other kinds' editors (feature-specs/34 § 5, § 18; added 2026-10-08 with unit 51c, part 2) |
| `.evidence-step`, `.evidence-list`, `.evidence-item` (`.is-pending`), `.evidence-failed`, `.evidence-head`, `.evidence-ordinal`, `.evidence-kind`, `.evidence-what`, `.evidence-title`, `.evidence-where`, `.evidence-score`, `.evidence-tier-pending`, `.evidence-foot`, `.evidence-math`, `.evidence-low`, `.evidence-loader`, `.evidence-wait`, `.evidence-corroboration`, `.evidence-corroboration-mark`, `.evidence-empty`, `.evidence-add`, `.evidence-add-row`, `.evidence-add-form`, `.evidence-file` (`.is-busy`), `.evidence-file-input`, `.evidence-file-button`, `.evidence-file-name`, `.evidence-upload-step` | step 3, the evidence items, from the Improve-Suggest screen's inline styles. `.evidence-item` is a `.box` on `--surface` (12/14, 8px apart), and the next one drops its top border. Its head (`.evidence-head`, not wrapping) holds the faint `.meta` ordinal, the 60px `.label` kind (the screen's 44px holds `link` and `DOI`, not PT's `arquivo` or `execução`; unit 51d, part 2), the title at 500 over its `.tex` place and note (`.evidence-what`, which wraps), the `.ev` badge and the 20px `.score`. Its foot (`.evidence-foot`, 84px in, 16 more than the screen's with the kind column) holds the mono 12px arithmetic, with a factor below 1.0 in `--warn` (`.evidence-low`), the `.st` status and the quiet `Remove`. A pending item is dashed in `--rule-2` with no fill, its badge a dashed `·` (`.evidence-tier-pending`), its loader in `--act`. A wait at the cap is an `.error` 84px in (`.evidence-wait`), and an item not opened, or opened and graded `U` all the same, is the Components screen's `.error` (`.evidence-failed`). The corroboration row is ruled on three sides on `--bg-2`. The empty state is the Components screen's `.empty`, 16/20. The add row wraps, and its field opens under it. The upload's field (`.evidence-file`) is the `.input` box with the picker's button at its left on `--bg-2`, ruled off in `--ink-2`, then the file's name, which wraps (no ellipsis, § 11; unit 51d's review). The file input lies transparent over the whole box (`.evidence-file-input`), so the box draws the focus ring with `:focus-within`, as the search box does, and dims while a step is out. The upload's loader and its step (`.evidence-upload-step`) follow the buttons | Improve-Suggest, the evidence items (feature-specs/34 § 5, § 22, § 23; added 2026-10-08 with unit 51d) |
| `.rationale-step`, `.rationale-text`, `.rationale-foot`, `.score-column`, `.score-body`, `.score-head`, `.score-thresholds`, `.score-scale`, `.score-meter`, `.score-ticks`, `.score-tick` (`.is-start`, `.is-end`), `.score-tick-start`, `.score-tick-end`, `.score-how`, `.score-rows`, `.score-total`, `.score-sum`, `.prediction-body`, `.prediction-badge`, `.prediction-suffice`, `.identity-body`, `.submit-panel`, `.submit-button`, `.submit-save`, `.submit-meta`, `.submit-problem-detail`, `.anchor-changed-texts`, `.anchor-changed-text`, `.from-research`, `.from-research-body`, `.from-research-sources`, `.edit-prefilled` | step 4 and the right column, from the Improve-Suggest screen's inline styles. The rationale's textarea is 208px, 14/22, its help and the counter under it on one line, the counter `--fail` past 200 (`.counter.is-over`). `.score-column` is the 376px rail (24/24/24/20, ruled at its left), its `.inst` instruments 18px apart: the 88px `.bignum` in `--fail`, `--warn` or `--ver` by where the score stands, with `accept ≥` and `floor` beside it; the shared `.meter`, 14px here, its floor tick `--fail` and its acceptance tick `--ink`, with 5px of tick above and below; the scale's labels under it, centred on their ticks, or starting or ending at a tick near an end, whose number then gives way; "how it is computed" as a `.kv` under a `.rt` rule, its total line 600 in ink. The prediction's `.st-block` wraps rather than runs past the rail, and its `would suffice` box is a `--rule` box on `--surface`, 10/12. Submit and `Save draft` are the rail's width; the meta line wraps. An anchor's changed texts scroll in a 160px box that takes the focus. Under 1200px the rail stands under the anchor column with the rule at its right; under 1000px after the form. A draft made from a research finding (feature-specs/48 § 8.2; unit 74) has `from your research` at the rail's head, an `.inst.from-research`: the researcher's note under its cap with the help line that it is not the rationale, the link back to the run, and the finding's sources not among the evidence as a list of addresses wrapping anywhere; step 2 carries the `.help.edit-prefilled` line under its heading | Improve-Suggest, step 4 and the right column (feature-specs/34 § 5, § 6, § 26; added 2026-10-08 with unit 51e) |
| `.improve-home`, `.improve-home-head`, `.improve-home-lines`, `.improve-home-queue`, `.improve-home-own`, `.improve-home-empty`, `.improve-home-table` | the Improve landing page, which no screen draws: the Rubric page's measure (28/48/32, 28px apart) up to 1120px, the head 10px apart with its three sentences at 68ch, the queue's line and the person's own suggestions as a `.tbl` with ids and anchors in mono and the numbers right-aligned, a row that waits on its owner marked with a `--warn` `.st`. Under 768px 20/16/24, the table scrolled within its own box | the Improve landing page (feature-specs/35 § 3, § 10; added 2026-10-08 with unit 52a) |
| `.improve-home-starts`, `.improve-home-research`, `.improve-new`, `.improve-new-head`, `.improve-new-choose`, `.improve-new-back`, `.improve-new-chapter`, `.improve-new-part`, `.improve-new-list`, `.improve-new-row`, `.improve-new-title` | Improve's two starts, which no screen draws. On the landing page, `.improve-home-starts` is the head's wrapping row — the primary `New suggestion`, the rubric's `.xref` and, where the section is, the `From a research` `.xref` to `#from-research` — 10px by 18px apart; `.improve-home-research` is that section, 12px apart: its heading, the step 1 throttle notice once above the table for a throttled contributor, the page's `.tbl.improve-home-table` (research `.xref` and the run's day in `.meta`, the anchor's id in `.meta` with its section's title, the kind of change, and a finding's `.finding-action` in the last cell) and its keep line as `.help`. The new-suggestion chooser (`.improve-new`) has the landing page's measure (28/48/32, 28px apart, up to 1120px) and head; under a part's `.cap` heading, or a chapter's `.h4` heading with its `.meta` line and the `← chapters` `.xref`, `.improve-new-list` is a ruled `ol` two to a row (one under 768px), each `li` ruled under and each row its link (`.improve-new-row`, 36px, 8/6, 14/20 in ink): the number and the version in `.meta`, the title (`.improve-new-title`) wrapping whole; under the pointer the row is on `--sel` and the title a traversal (`--ver`, dotted underline), and on touch the row is 44px. Under 768px 20/16/24 | Improve's starts (feature-specs/48 § 10; added 2026-10-13 with unit 76) |
| `.outcome`, `.outcome-head`, `.outcome-head-caps`, `.outcome-top`, `.outcome-pair`, `.outcome-decision` (`.is-fail`, `.is-warn`, `.is-ok`), `.outcome-decision-body`, `.outcome-decision-head`, `.outcome-decision-badge`, `.outcome-score`, `.outcome-line`, `.outcome-anchor-body`, `.outcome-quote`, `.outcome-change`, `.outcome-evidence`, `.outcome-evidence-item`, `.outcome-evidence-what`, `.outcome-evidence-math`, `.outcome-sensor-failed`, `.outcome-suffice`, `.outcome-suffice-row`, `.outcome-actions` | the adjudication page, from the Improve-Adjudication screen's inline styles: 28/40, 22px apart, under the edit page's context strip. Decision (380px) beside the Anchor, then Reasons across, then Sensors beside What would suffice at 1.15 to 1, each an `.inst`. The Decision box takes its outcome's colour on its own background, the border and the big number alike: `--fail` declined, `--warn` request more or with a curator, `--ver` accepted, `--rule-strong` on `--bg` while deciding or closed; its badge sits on the number's baseline, its mono line wraps anywhere. The quote is ruled at its left in `--ver`; the change's before and after are a `.tbl` with a 140px head column, the proposed row the shared `.row-new`. A failing sensor's row is on `--fail-bg`. Under 1200px every pair is one column; under 768px 20/16/24 | Improve-Adjudication (feature-specs/35 § 4, § 11; added 2026-10-08 with unit 52b) |
| `.outcome-page` (`.has-aside`), `.outcome-aside`, `.outcome-aside-note`, `.outcome-other`, `.outcome-other-head`, `.outcome-other-body`, `.outcome-other-quote`, `.outcome-other-change`, `.outcome-other-was`, `.outcome-other-now`, `.outcome-other-after`, `.outcome-other-score`, `.outcome-other-item`, `.outcome-request`, `.outcome-request-cap`, `.outcome-request-what`, `.proposal-fixed` | the adjudication page's right column and a derived figure's request, from the screen's dock. The page is the main column beside the owner's 472px column, ruled at its left on `--bg`, 28/28/28/24, 18px apart (not `.dock`, which the assistant's dock fixes to the viewport). The compact suggestion is the screen's: its head 4px apart; its Anchor and Score `.inst` boxes 12px inside; a value's change as the struck-through value in `--ink-3`, an arrow and the new one at 600, both 18px; the `.midnum` in `--fail`, `--warn` or `--ver` by where it stands; the strongest item boxed in `--rule` on `--surface`, 10/12. The request is a `.notice`, its cap in `--warn`, its request at 500. The throttle rule and what the adjudicator saw sit under a `.rt`, 14px down, 6px apart, the first in the column unruled. The edit page's fixed change in a revision is the page's before and after table (`.outcome-change`). Under 1200px the column stands under the main one, ruled above; under 768px 20/16/24 | Improve-Adjudication's right column (feature-specs/35 § 4, § 12; added 2026-10-08 with unit 52b, part 2) |
| `.record-page`, `.record`, `.record-head`, `.record-head-caps`, `.record-panels`, `.record-panel-body`, `.record-quote`, `.record-change`, `.record-change-row`, `.record-value`, `.record-was`, `.record-now`, `.record-decision` (`.is-ok`, `.is-warn`, `.is-fail`), `.record-score`, `.record-score-row`, `.record-badge`, `.record-items`, `.record-item`, `.record-item-head`, `.record-item-what`, `.record-timeline-body`, `.record-entry`, `.record-entry-head`, `.record-entry-title`, `.record-actions`, `.record-rail`, `.record-rail-body`, `.record-version`, `.record-version-row`, `.record-version-from`, `.record-version-bump`, `.record-rail-kv`, `.record-rail-branch`, `.record-chain-line`, `.record-export`, `.record-export-button` | the record page, from the Improve-Record screen's inline styles. The main column (28/40, 22px apart) beside the 440px `.rl` rail (28/24/28/20, 16px apart). The three panels at 1.35 to 1 to 1, 16px apart; Change's before and after on a 44px cap column, a value's change 18px mono, struck through in `--ink-3` before and 600 after; Decision in its outcome's colour on its own background, as the decision page's box; the items 14px apart. The timeline is the shared `.tl` (open marker for a submission, `.v` for an accept and a merge, `.f` for a decline), padded 20/20/4/4, each entry's head between its 600 title and the actor's `.meta`, then the body and the `.hash` line. The chain's line is the `.st` without its capitals, 12px: `.st-ok` verified, `.st-fail` broken, and `.st-mute` for a suggestion with no record yet, which has nothing verified. The export (unit 52c, part 2) stands under the chain's box, 8px apart: its button the full width, centred. A merge under way (unit 54b, part 3) fills Version: the version left in 14px `--ink-3` mono, an arrow, the version made as the screen's `.midnum`, and the bump's `st-block sb-mute`, 10px apart and wrapping; the book's rule as `.help`; branch, commit and merged by as the shared `.kv`, the branch breaking anywhere. It fills Lab gate with the chapter's lab and lint as `.st` marks in `.between` rows, the book's suite with its `.meter` (`.ver`, or `.warn` with a failure elsewhere), and the unrelated failure's `.help`. Merged (unit 54c), Version's `.kv` gains the release and "merged by" the curator's name or pseudonym, and Source row's box becomes a `.kv` of the row's verification date before and after and its age today. Under 1200px the rail stands under the main column, ruled above; under 900px the panels are one column; under 768px 20/16/24 | Improve-Record (feature-specs/35 § 5, § 14, § 15; feature-specs/37 § 16; added 2026-10-08 with unit 52c, parts 1 and 2) |
| `.queue-page`, `.queue-list`, `.queue-head`, `.queue-marks`, `.queue-table` (`tr.is-selected`), `.queue-item`, `.queue-group`, `.queue-id`, `.queue-anchor`, `.queue-decided`, `.queue-decided-list`, `.queue-detail`, `.queue-detail-head`, `.queue-detail-id`, `.queue-detail-id-row`, `.queue-detail-title`, `.queue-change`, `.queue-change-side`, `.queue-value`, `.queue-was`, `.queue-now`, `.queue-evidence`, `.queue-evidence-what`, `.queue-strongest`, `.queue-total`, `.queue-ok`, `.queue-band-wrap`, `.queue-band` (`-under`, `-between`, `-accepted`, `-tick`, `-score`), `.queue-band-labels`, `.queue-adjudication`, `.queue-adjudication-list`, `.queue-detail-actions`, `.queue-rail`, `.queue-rail-body` | the curator queue, from the Curator-Queue screen's inline styles. Three columns: the `.rr` queue at 480px (20/20/20/24, 14px apart), the detail (24/28, 18px apart), the `.rl` rail at 360px (20, 16px apart). The table is 12.5px, cells 8/6, a group's heading row 12/6/6 ruled under in `--rule-2`, the selected row on `--act-bg` with `--act` at its left. An item's row (`.queue-item`) selects it wherever it is clicked, its id's link stretched over the row; it is on `--sel` under the pointer, as every `.tbl` row with a link is, and while the id has the keyboard's focus (Andre, 2026-10-11). The detail's id is a 28px `.midnum`; Change is current beside proposed with an arrow, the current struck through in `--fail`, the proposed 600 in `--act`, a value 18px mono. The Evidence table is 12.5px, its strongest score and its total 600; the band is 12px framed in `--ink-2`, its zones on `--fail-bg`, `--warn-bg` and `--ver-bg`, the floor and acceptance ticks 1px, the score 3px in its band's colour, at data-driven positions. Adjudication's two lists side by side. Under 1200px the rail spans both columns under them; under 900px one column; under 768px 16px all round, the table scrolling within itself | Curator-Queue (feature-specs/36 § 4, § 13; added 2026-10-08 with unit 53b) |
| `.queue-decision`, `.queue-decision-body`, `.queue-decision-top`, `.queue-decision-fields` (`.has-select`), `.queue-decision-select`, `.queue-decision-note`, `.queue-decision-actions`, `.queue-decision-status` | the curator's decision panel and the decision once made, from the Curator-Queue screen's `Curator override`. An `.inst` framed in `--act`, its header ruled in `--act`, the body 14px apart. The segmented control sits beside the criterion's meta. The code or criterion select sits beside the note in two columns (one under 900px); the select and the note are 13px, the note 76px high at 19px. The actions are 10px apart. The status footer is 8/12, 10px apart, in `--ink-2`, and drawn only once it says something (`sr-only` while idle, still a live region). Since unit 53's review: the note's label is a `.flabel` in a `.between` row with its live `.counter` (`n of 400`, `.is-over` past it); and while the decision is incomplete, what it still needs is a `.small.muted` line above the actions, which the button names (`aria-describedby`) | Curator-Queue (feature-specs/36 § 5.3, § 14, § 17; added 2026-10-08 with unit 53c) |
| `.queue-rail-reading`, `.queue-rail-legend`, `.queue-rail-key` (`.is-review`), `.queue-rail-row` (`.is-review`), `.queue-rail-name`, `.queue-rail-bar` (`i`, `i.queue-rail-zone`), `.queue-rail-tick` (`.is-review`), `.queue-rail-review`, `.queue-rail-scale` (`span.is-at`), `.queue-rail-kv`, `.queue-rail-foot` | the calibration rail's three instruments, from the Curator-Queue screen's inline styles. The body is 12px apart. The legend's keys are 2×12px ticks, `--ver` for the target and `--fail` for the review line, 6px from their words and 14px apart. A row is 5px apart, its bar 10px framed in `--ink-2`, filled in `--ink` to its data-driven width over a scale of 0–25 %, with 2px ticks standing 4px out at both lines. A row past the review line is padded 8, pulled out 8, on `--warn-bg` with `--warn` inset 3px at its left, its name and rate 600 and the rate in `--warn`, its bar on `--bg` and filled in `--warn`, with the `st-block sb-warn` chip and the review's id 4px under it. κ's bar has the retirement zone on `--fail-bg` under its value's fill, and a 16px scale under it whose middle labels are centred on their lines. Precision's rows are the shared `.kv`, and its footer sets the rubric's link and its hash at the two ends | Curator-Queue (feature-specs/36 § 6.4, § 15; added 2026-10-08 with unit 53d) |
| `.queue-merge-body`, `.queue-merge-kv`, `.queue-merge-branch`, `.queue-merge-missing`, `.queue-merge-list`, `.queue-merge-details`, `.queue-merge-diff` (`.diff-add`, `.diff-del`, `.diff-hunk`, `.diff-meta`), `.queue-merge-output`, `.queue-merge-actions` | an accepted suggestion's merge in the queue's detail (`QueueMerge`): an `.inst` with its state's `.st` in the header and the check's time, a sentence, a `.kv` of the version, branch, commit, lint, lab and book suite, the branch name breaking anywhere; what a hand-made branch lacks in `--warn`; lists of figures and results 4px apart; the diff and the lab's output each in a `<details>`, a 12/18 mono box on `--surface` framed in `--rule`, at most 320px high and scrolling, wrapping its lines (a book's paragraph is one line): in the word diff a removed run struck in `--fail` and an added one underlined in `--ver`, a file's and a hunk's header in `--ink-3`. `Re-run check` is a `.btn-sm` with its live line beside it in the footer. Since part 3 the same panel stands on the contributor's adjudication page, between the Decision and Reasons, without the footer; a change the check returned has the Decision box in `--warn` with the `sb-warn` badge "Check failed". Since unit 54c the footer holds `Merge` first once the check passed: a `.btn-sm.btn-p`, whose first press shows `Cancel` (`.btn-q`) and the sentence asking for the second in the live line, 10px apart and wrapping; the `.queue-merge-actions` rows stack in the footer. A merge under way is the `run` mark ("merging into main") and a merged one the `ok` mark, with no footer; the `.kv` gains the release | Curator-Queue, Improve-Adjudication (feature-specs/37 § 15, § 16, § 18; added 2026-10-09 with unit 54b, parts 2 and 3; unit 54c) |
| `.audit-inst`, `.audit-form`, `.audit-scope-row`, `.audit-window-row`, `.audit-seg`, `.audit-kinds`, `.audit-ask`, `.audit-status`, `.audit-last` | the audit export's form, on Book management since 2026-10-12 (feature-specs/38 § 3; 47 § 3.2): an instrument whose body is the scope's `.seg` beside the chapter's `.select` (`auto minmax(0, 1fr)`), the window's two `.input.mono` dates side by side, the four `.check` kinds in two columns under a `.flabel` legend, the estimate as a `.meta` live region beside the `.btn.btn-p`, a status line (`role=status`, `.text-fail` on a refusal) and the last export as a `.kv.rt` (date and count, the head hash's twelve characters with a `.st` mark, the download `.xref` with the URL's life); one column under 640 px; the scope's `.seg` is `min-height` 40 px with 38 px buttons, so on a coarse pointer the frame grows with the 44 px touch targets (the 55 review) | Account-Admin (feature-specs/38 § 11; added 2026-10-10 with unit 55b) |
| `.roster-inst`, `.roster-table`, `.account-roster` | the curator roster, on Book management since 2026-10-12 (feature-specs/38 § 4; 47 § 3.2): an instrument with a bare body holding a `.tbl` of five columns — part, chapters (`.meta`), curators by display name, queue (`.n`), median decision time (`.n`, days with one decimal) — the empty cells `.faint` in words (`no curator yet`, `no decision this quarter`), the footer's rule with a `.xref` to the rubric, the table in a `.roster-scroll` region (`tabIndex=0`, `role=region`, named) that scrolls horizontally, since a scrollable region must be reachable by a keyboard; the budget breakdown (21 § 4.2) gains the `Grading` and `Adjudication` rows, faint at zero as the labs are, each naming the suggestions it served | Account-Admin (feature-specs/38 § 9; added 2026-10-10 with units 55a and 55c) |
| `.revert-panel`, `.revert-note`, `.queue-sample-verdict` | a curator's revert, and the month's verdict on a sampled item (feature-specs/37 § 8, 36 § 7.2): the decision panel's own frame (`.queue-decision`, `--act`), its lede, the note as a `.flabel` row with its `.counter` over the shared `.queue-decision-note`, the actions 10px apart (`Stands` as `.btn-sm`, `Revert` as `.btn-sm.btn-p`, `Cancel` as `.btn-q` on the first press), and the status footer as a live region; the verdict given is a `.small` line with its `.st` mark, who and when, and the revert's `.xref` | Improve-Record, Curator-Queue (feature-specs/37 § 22; added 2026-10-10 with unit 54e) |
| `.history-page`, `.history`, `.history-head`, `.history-head-caps`, `.history-title-row`, `.history-head-marks`, `.history-strip`, `.history-stat`, `.history-table`, `.history-summary`, `.history-evidence`, `.history-before`, `.history-after`, `.history-row-reverted`, `.history-foot`, `.history-rail`, `.history-credit`, `.history-credit-foot`, `.history-tree`, `.history-override`, `.history-chain`, `.history-chain-line` | a chapter's improvement history, from the Chapter-History screen's inline styles: the main column (32/40/32/48, 24px apart) beside the 380px `.rl` rail (32/24/24, 20px apart). The strip is five columns on a `.rt-s.rb` rule, each `.rr` cell 14/16 with its `.cap`, `.midnum` and `.meta`; the ledger is the shared `.tbl` at 13px in a `.scroll` box, the summary column at most 34ch, a struck `--ink-3` before and a 600 after, the override's `st-warn` and the revert's `st-fail` marks on their own line, a reverted row in `--ink-2`; the footer `.inst-f` with the export as an `.xref`. The rail's credit is a list of `.between` rows ruled under, its two sentences in a `.rt` box 12/16; the layers are the shared `.tree`, wrapping, a quiet layer `.faint`, an override in `--warn`; the chain check a `.rt` block 12px down with the `.st` line and the head as `.tex`. Under 1200px the rail stands under the main column, ruled above, and the strip is two columns; under 768px 20/16/24, the strip one column with each stat ruled under | Chapter-History (feature-specs/37 § 7, § 20; added 2026-10-10 with unit 54d) |
| `.seed-chip`, `.queue-decided-item`, `.queue-legend` | a seed revealed, from the Curator-Queue screen's "Decided today" and legend. The chip is `seed · known answer` in 10.5px mono, `--ink-2`, framed 1px dotted in `--ink-2`, padded 1/5, never wrapping. A decided item is its line, then, for a seed, the chip and its mark (`st-ok` match, `st-warn` diverged), 4px apart. The legend sets the chip beside its sentence, 10px apart and not wrapping under it. The seed's detail reveals it in a `queue-decision` panel with the chip in its header and the two decisions as a `.kv` | Curator-Queue (feature-specs/36 § 7.1, § 16; added 2026-10-09 with unit 53e) |

### 9.10 Hover, active and focus (added 2026-09-22)

One language for every pointer state, inside the rules of § 2.1 and § 4.4: no shadows, no transitions, state in form as well as colour. Hover rules apply only under `@media (hover: hover)` so touch devices never get a stuck hover.

| State | Rule |
|---|---|
| Traversal hover (`.xref`, `.derive`, `.cite`, `.src-link`, tile titles, footer and account links) | text `--ver`; a dotted rule turns solid or a solid underline appears (`text-underline-offset: 3px`); chips take `--ver-bg` |
| Chapter tile hover | the whole tile is the link target (a stretched `::after` on the title); the tile fills with `--sel` and the title turns `--ver` with a dotted underline; the current tile's bottom bar turns `--ver` |
| Primary nav hover | `--ink` text and a 2px inset bottom bar in `--rule-2`; the current item's bar is `--ink` |
| Button hover | default `--bg-3`; primary `--act-hover`; quiet `--bg-2`; destructive `--fail-bg`; icon button `--bg-2` with an `--ink-2` border; disabled unchanged |
| Segment and toggle hover | unpressed segments `--bg-3` |
| Pressed (`:active`) | inverts to ink on bg, the same form as a pressed segment; primary stays `--act-hover`; destructive fills `--fail`; a tile takes `--ver-bg` |
| Search field | hover border `--rule-2`; `:focus-within` border `--ink-2` and the inner input drops its own ring |
| Table row that contains a link | `--sel` on hover |
| Keyboard focus | unchanged: 2px `--focus` ring, offset 2px, on every interactive element |

`--sel` is the interaction tint: selected row, text selection, hovered surface. Hover never uses the warm colour except on the primary button, and never uses a shadow or a size change.

## 10. Layout patterns

Frames in the UI package: desktop 1440px wide, mobile 390 × 844.

| Pattern | Screens | Structure |
|---|---|---|
| App shell | all desktop | `.topbar` 48 → main → `.statusbar` 28. Main padding 24–28px vertical, 48px horizontal. |
| Home | Book-Home | hero (cap, `.h-display`, blurb) + two instruments side by side (Continue reading, Book status with 5 cells); then one 9-column `<ol>` grid per part with edge-to-edge tiles. Since 2026-10-12 Book status is on Book management with 4 cells, and the home ends with the grid's legend (feature-specs/47) |
| Reader, three columns | Reader-Chapter | outline rail (chapter list + nine layers + path progress + keys) · reading column (`.prose` max 680, figures, code pane) · right rail instruments (chapter, figures in section, actions, render check). Peek panel opens beside the text. |
| Research page | none (feature-specs/48 § 11.2; unit 72) | the Assistant page's three regions as they are — the person's researches 232px · the research column, its content 680px · the statistics rail 330px — two columns from 1000px to 1359px (the researches behind the column header's toggle) and one column with the three-link region switch under 1000px, phones included. The column is a `.dock` with `data-dock="research"`: its header (`reads the web`, the release, the researcher's guide), the frame line, the log of runs, the composer |
| Assistant page | none (feature-specs/26 § 4) | conversations rail 232px (a tree: every conversation, the open one unfolded into its turns) · the dock as the main column, its content 680px · statistics rail 330px. Two columns from 1000px to 1359px (the conversations behind the dock header's toggle); one column and a three-link region switch under 1000px, phones included |
| Any page + dock | none (feature-specs/24 § 5.6) | the page as it is, dimmed by the backdrop · assistant dock 520px fixed on the right, over the page · the log rail an overlay behind the dock header's toggle |
| Any page + Research dock | none (feature-specs/48 § 12; unit 77) | the Assistant's overlay as it is (`.dock.is-over`, `.dock-backdrop.is-over`), on every page but the Research page, sign-in and sign-out from 768px, beside a reader section too, whose grid stays as it is: research highlights nothing in the reader, so it is given no column · header (`reads the web`, the release, the researcher's guide, `Open the Research page`, close) · the frame line · the open research's runs, in a log that holds what it positions (`position: relative`, so a visually hidden label far down the log never makes the fixed dock taller than its box) · the composer; no list, no delete. Under 768px it does not render, and `.dock-phone` says so with the Research page and the close. One dock at a time: the Assistant's wins a URL with both |
| Reader + dock | Assistant-Answer, Assistant-Refusal-Walk | outline rail condenses to 64px (numbers only) · reading column narrows · assistant dock 520px on the right; a 232px conversation log rail appears in the four-column variant |
| IDE | Labs-IDE | lab header bar (opened from, title, run number, verdict block, actions) · collapsible chapter text panel (`[` key) · file tree · editor · run history · output pane (verdict hero 46px mono, diff table, log tail, diagnosis) · two-row sandbox status bar |
| Form with rail | Improve-Suggest | four numbered steps in the main column (anchor, change, evidence, rationale) · right rail: live Score instrument, predicted outcome, identity, actions |
| Decision page | Improve-Adjudication, Improve-Record | context strip (`← back to 23.3`, chapter meta, suggestion id) · decision panel with `.bignum` · anchor panel · reasons table · sensors · "what would suffice" · timeline · right rail (version, lab gate, source row, credit, chain check, export) |
| Queue | Curator-Queue | queue rail grouped by change class with SLA column · detail pane · override form · calibration rail with meters |
| Admin | Account-Admin | header (org, account id, sso, residency, billing period, signed in as) · grid of instruments: budget, IDE minutes, retention, seats, audit export, residency, sandbox policy, roster. The budget instrument is built since unit 35b (2026-10-04) on the reader's own account page (`BudgetInstrument`, feature-specs/21 § 4.2), read-only: `Change cap` and the rest of this screen are Phase 4 |
| Mobile reader | Mobile-Reader-PT | compact top bar with brand and EN/PT (44px targets) · source-language band · one-strip chapter instrument · prose · bottom action bar with two 60px targets (Sumário, Perguntar sobre 21.3) |
| Mobile assistant | Mobile-Assistant | full-height modal sheet (`role="dialog" aria-modal="true"`) with grab handle, header, mode strip, conversation, two 44px buttons, collapsed verdict bar, input with EN button; no top nav or status bar **Not built: skipped 2026-10-03 (Andre's decision); under 768px the page shows a notice instead.** |

Breakpoints:

| Width | Behaviour |
|---|---|
| < 640px | mobile type scale; instrument headers wrap; timeline 76px time column; empty-state padding 20 |
| < 768px | mobile: only the chapter reader and the assistant sheet render; `@lab` and the suggest form's edit page show a "desktop or tablet" notice; step 1 of the suggest form and the Rubric page render at every width (Andre, 2026-10-07: a zoomed desktop is a narrow viewport, WCAG 1.4.10), and so does the new-suggestion chooser before it (feature-specs/48 § 10.1; unit 76); no top nav or status bar |
| 768–999px | tablet: single reading column with dock and rails as overlays; IDE allowed |
| ≥ 1000px | desktop: rails and dock side by side; style-guide TOC becomes sticky |
| 1440px | design frame width; page padding 48px; wider screens add `--s8`/`--s9` margins, content does not stretch beyond the frame |

Grid rules: instruments tile edge to edge under one header, or stand apart by `--s5` (24px). Grids are `repeat(N, minmax(0, 1fr))` with 24px gap. Rails are fixed widths (64, 232, 330, 520); the reading column is `minmax(0, 1fr)`.

## 11. Language parity, voice, formats

- Both editions ship together. Budget 30% extra length for Portuguese prose; short labels can double (`Save run` → `Salvar execução` +88%; `Request more` → `Solicitar mais evidências` +108%).
- Wrap, never truncate. Button rows and status rows use `flex-wrap`; a label that does not fit moves to the next line whole. No ellipsis on any label, heading, status or chip. Only ids and hashes may break anywhere (`overflow-wrap: anywhere`).
- Size every control to its content, never to a fixed width. Columns are sized for the PT string.
- This is tested, not only stated: `npm run test:layout` renders the primary screens in PT with a padded catalogue, every string at least 30 % longer than its EN counterpart (`lib/i18n/pad.ts`), at 1440px and 390px, and fails on a label that is elided, clamped, clipped or spilling and on a page that scrolls sideways (`tests/layout/`). What it found on its first run is what changed here: instrument headers wrap (§ 8), a status mark `.st` wraps its word under itself, a table's header cells wrap (§ 9.3), a full-width rail button `.rail-btn` grows with a label longer than the rail, and a preformatted loader scrolls instead of being cut.
- Figures are identical across editions: same value, precision and derive line. Only separators and month names change.

| Kind | en-GB | pt-BR |
|---|---|---|
| decimal | 1,000.5 | 1.000,5 |
| percentage | 36.5% | 36,5% |
| date | 12 Sep 2026 | 12 set 2026 |
| date + time | 03 Sep 17:05 | 03 set 17:05 |
| currency | $0.25 per M tokens | US$ 0,25 por M tokens |
| ratio | 13× | 13× |
| clock | 24-hour | 24-hour |

Ids, versions, hashes and code never localise. Quoted source titles stay in their original language followed by `[en]` or `[pt]` in mono, with `lang` set on the element.

Voice: short declarative sentences, specifics over adjectives, British spelling (organisation, colour, licence, behaviour, analyse, optimise). No exclamation marks. No "seamless", "powerful", "unlock", "supercharge". Buttons are verbs that describe the result. Errors say what failed, what was kept and what to do next. A number replaces an adjective whenever one exists. Status feedback is a persistent status-bar line, never a toast.

## 12. Accessibility (WCAG 2.2 AA, a release gate)

| Criterion | Rule |
|---|---|
| contrast | text ≥ 4.5:1 (lowest in use: ink-3 5.55 light, act 5.08 light); control boundaries and focus ≥ 3:1; rules are decorative |
| focus visible | `outline: 2px solid var(--focus); outline-offset: 2px` on every interactive element; never removed; never colour-only on a filled button |
| target size | ≥ 24 × 24 desktop; ≥ 44 × 44 under `pointer: coarse` |
| figures | every chart and diagram has a text alternative giving its numbers and source tier |
| code | code regions labelled with file and line range; line numbers generated with `::before`, not read aloud |
| never colour alone | status has a word and a shape; chips have a line form; diffs have `= ≠ +` |
| reduced motion | under `prefers-reduced-motion: reduce`, no blinking caret, no smooth scroll, no transitions |
| language | `lang` per edition and on every quoted source in the other language |
| semantics | real `button`, `a`, `input` + `label`; `aria-current` on outline and nav; `aria-label` on icon-only controls; `aria-pressed` on segments and toggles; live regions for verdicts and stream completion; `role="meter"`, `role="log"`, `role="dialog" aria-modal` where shown |

Keyboard map (press `?`): `/` search · `j` `k` next / previous section · `[` `]` previous / next chapter · `g l` this chapter's lab · `a` ask about this section · `r` open the Research dock (feature-specs/48 § 12, since unit 77) · `esc` close panel or peek · `?` show the map. Single-key shortcuts are off while focus is in a field and can be disabled in settings. `ctrl ↵` runs a lab from the editor.

This is tested, not only stated: `npm run test:e2e` runs the reader's primary flows in EN and PT and scans every screen they reach with axe for the WCAG 2.2 AA rules, presses `?` and `esc` on every reader page of the book while it walks it with `j` and `]`, and clicks every cross-reference to see its peek open and the focus come back (`tests/e2e/`). What its first run found is what changed here: a caption inside a primary button takes the button's text colour (§ 9.1), and the Query instrument's bars fit the rail and can be scrolled from the keyboard (`.query-bars`).

## 13. Implementation conventions for this codebase

These are decisions for the Next.js and Tailwind v4 app, not in the UI package.

### 13.1 Tokens live in one place

- `app/globals.css` is the only file that contains a hex colour, a font stack or a pixel spacing value. It defines the 25 colour tokens, `--sans`, `--mono` and `--s1`…`--s9` on `:root`, mirroring hb.css exactly, then redefines the colour tokens for dark under `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { … } }` and again under `:root[data-theme="dark"]`, and sets `color-scheme`.
- The same tokens are exposed to Tailwind v4 through `@theme inline` (`--color-bg: var(--bg)`, `--color-ink: var(--ink)`, `--color-act: var(--act)`, …, `--font-sans: var(--sans)`, `--font-mono: var(--mono)`, `--spacing-s1: var(--s1)` …) so utilities such as `bg-bg-2`, `text-ink-3`, `border-rule-strong`, `font-mono`, `p-s4` resolve to tokens. Tailwind's default palette, radius and shadow scales are not used; `rounded-*` and `shadow-*` utilities are forbidden.
- Theme is set by `data-theme` on `<html>` (`light` / `dark` / absent = system), persisted per viewer in `localStorage` (`hb.theme`) inside try/catch, with a Light / System / Dark segmented control in Account settings (`components/account/DeviceControls.tsx`, which also holds the shortcuts On / Off control on `hb.keys`). `<body>` carries an explicit background. The root layout carries the one inline script of the app (`lib/theme.ts` `THEME_SCRIPT`, with the request's CSP nonce): it applies the stored theme before paint so there is no flash (feature-specs/08 § 6.3, built 2026-09-22).
- Fonts load through `next/font/google` (IBM Plex Sans 400/500/600 + italic 400; IBM Plex Mono 400/500/600) with `display: swap`, and their CSS variables feed `--sans` and `--mono`. No Google Fonts `<link>` in the app.
- `globals.css` declares `@source not "../context";` because Tailwind v4 scans every non-ignored file for class candidates and the context documents name forbidden utilities in prose. Any new folder of prose or fixtures that mentions class names gets the same exclusion.

### 13.2 Component classes are ported, not reinvented

- The component rules of hb.css (§ 3–9 above) are ported into `app/globals.css` under `@layer components`, unscoped (the `.hb` prefix is dropped because the whole app is the scope). Class names stay identical to hb.css so the screens in `docs/design/screens/` remain a visual reference that can be diffed against the running app.
- React components in `components/` (see `context/architecture.md` § 3.1) render these classes. A React component never restyles a class with ad-hoc utilities; if a variant is missing, it is added to `globals.css` and to this file.
- Tailwind utilities are used for layout (flex, grid, gap, padding, width) and only with token values. Utilities never set a colour, radius, shadow, font family or font size that is not a token or a hb.css role class.
- Inline `style=""` is not used except for data-driven widths (`.meter > i` width, `.mark` left) and grid template columns that depend on data.
- **Where the port differs from hb.css.** A page built on a screen meets these, and its screen match lists the ones it shows as deliberate differences (rules § 7.9). Written down on 2026-10-07 by unit 51a, which found every class the seven Improve screens use already ported (feature-specs/34 § 12); each row is the code's, dated by the commit that made it.

| Class | hb.css | `globals.css` | Why, since |
|---|---|---|---|
| `.tex` | opacity .8 | no opacity | AA contrast (axe); 2026-09-22 |
| `.row`, `.between`, `.inst-f`, `.seg` | one line | `flex-wrap: wrap` | a row of buttons or statuses wraps rather than cutting a string a third longer in PT (§ 11); the first port, 2026-09-22 |
| `.inst-h` | one 32px line, `nowrap` | its parts wrap whole onto 24px lines | § 8; unit 23c, 2026-10-05 |
| `.inst-h .xref` | — | `line-height: 1` | a cross-reference, set smaller, does not stretch the header's 24px line; unit 23c |
| `.st`, `.tbl th` | `nowrap` | they wrap; a header cell sits at the bottom of its row | the wrap: a PT status or header wider than its column, unit 23c (2026-10-05); the bottom alignment: the first port |
| `.statusbar`, `.statusbar > *` | 28px; cells `height: 100%` | `min-height: 28px`, wrapping; cells `min-height: 27px` | the bar is the 28px that the dock's `bottom` and the reader's cap count on, and grows rather than cutting a cell; the first port, and the cells 2026-10-03 |
| `.field`, `.tl-b` | — | `min-width: 0` | they shrink inside a grid or flex track instead of widening it; the first port |
| `.code`, `.code-b` | `.code` clips (`overflow: hidden`) | `.code` does not clip, and keeps its zero minimum width by `min-width: 0`; long lines scroll inside `.code-b` (`overflow-x: auto`) | the first port |
| `.meter` | `overflow: hidden` | `overflow: visible` | the `.mark` ticks stand 3px proud of the bar instead of being clipped to it; the first port |
| `.loader` | `white-space: pre` | `pre-wrap` | a long status line wraps; `.query-bars` puts `pre` back where the bars must stay whole; the first port |
| `.tl-i` | `120px 24px 1fr` | `120px 24px minmax(0, 1fr)`; under 640px `76px 24px minmax(0, 1fr)` with an 8px gap; the last item's spine stops at its marker | the first port |
| hover and pressed states | a few hovers: `.btn:hover` on `--bg-2`, `.btn-p:hover` the fill alone, none on the brand | § 9.10's one language: `.btn:hover` on `--bg-3`, the primary's border with its fill, the brand on `--bg-2` with its `b` underlined dotted, and the rest of § 9.10's table | § 9.10; 2026-09-22 |
| `.tree` | `.tree li` only | `.tree` 12.5px, an 18px indent, `--ink-3` text | the reading paths (feature-specs/05). A tree whose rows are ink, as Chapter-History's layer tree, takes a class of its own |
| `.dock` | a left rule on `--bg` | the assistant's dock: fixed beside the page, 520px, between the bars, not rendered under 768px; on the assistant's own page `.assistant-page .dock` makes it the static main column (feature-specs/26). Since unit 72 (feature-specs/48 § 12) the Research page's column is a `.dock` too, and each says whose it is with `data-dock="assistant"` or `data-dock="research"`: a key finds its own dock by that attribute, never by the class. Since unit 77 the Research dock is `.dock.is-over` with `data-dock="research"` on every page but the Research page, sign-in and sign-out | feature-specs/16. An `aside.dock` that is neither the Assistant's nor research's, as Improve-Adjudication's other open suggestion, takes a class of its own |

### 13.3 Component-to-class map

| React component (architecture § 3.1) | hb.css classes it renders |
|---|---|
| TopBar, StatusBar, LangToggle, SearchBox, KeyboardMap | `.topbar .brand .nav .langtoggle .statusbar .kbd .tex` |
| Outline | `.outline .n`; path progress `.meter` |
| InstrumentPanel | `.inst .inst-h .t .sep .ts .inst-b .kv .inst-f` |
| SectionBody | `.prose`, `.fig-ill .fig-der`, `.h2` section head with `.cap` layer label |
| FigureChip, SourceTierChip | `.chip .t-*` |
| DeriveChip | `.derive` (opens CodeBlock at the line) |
| CodeBlock | `.code .code-h .code-b .ln .hl .hl-f .hl-a .k .s .c .fn`, `.btn-sm` actions |
| MermaidFigure | SSR SVG inside `.box` with a `.cap` "mermaid · rendered" and a visible caption; alt text from the release |
| PeekPanel | `.peek` + `.inst-h` + `.inst-f`; `role="dialog"` |
| AssistantDock, Composer, AnswerStream, CitationChip, SensorVerdicts, ResearchLine, ProposalPanel, FlagButton, DecisionAidForm | `.dock`, `.seg` mode radio, `role="log"`, `.cite .nocover`, verdicts table `.tbl` with `.st`, `.research-line` with `.st.st-plain`, `.proposal-panel` (an `.inst`, `.ev` badges, `.check` consent), `.field .textarea .counter .select`, `.btn-p` Ask, `.loader .blocks` for derive runs |
| LabShell, FileTree, Editor, OutputPane, DiffTable, Terminal, SandboxStatusBar, RunHistory | lab header with `.h4` + `.st-block`, `.tree`, CodeMirror 6 themed with the tokens (gutter `--ink-3`, active line `--sel`, edited `--act-bg`), verdict hero (46px mono in `--fail` / `--ver`), `.tbl` with `.d-*` and `tr.row-*`, `.term`, two `.statusbar` rows with `.meter`, `.error` diagnosis |
| AnchorPicker, ClassPanel, ProposedChange (since unit 51c the six editors: ValueEditor, TextEditor, ClaimEditor, RestructureEditor, RowEditor, NewRowEditor, with SourcePicker and PassageChecks), EvidenceList, RationaleCounter, ScoreInstrument; since unit 76 SuggestChooser and SuggestGateNotice | `.seg-links` anchor type (a link per kind, since unit 51b), `.tbl` source rows with `tr.sel`, the class as an `.inst` with a `.kv`, `.input` before/after, `.ev`, `.score`, `.loader` while grading, `.counter`, `.inst` with `.bignum` + `.meter` + two `.mark`; the chooser's `.improve-new` with `.improve-new-list` rows, and the gate's `.notice` |
| RecordTimeline, AdjudicationResult, RubricTables, HistoryLedger | `.tl .tl-i .tl-t .tl-m .tl-b .hash`, `.inst` with `.bignum` + `.st-block`, `.tbl` |
| QueueDetail, OverrideForm | `.tbl` grouped rows with SLA cell, `.seg` decision, `.select` coded reason, `.textarea` note with `.counter`, `.btn-p`; calibration `.meter.warn/.fail/.ver` with `.mark` |
| ResearchDock, ResearchConversations, RunBlock, RunLine, RunSteps, RunReport, RunPages, FindingCard, FindingAction, SeedCard, ResearchMount, ResearchShortcut (feature-specs/48 § 11, § 12; unit 72; FindingAction unit 74; the dock unit 77) | `.finding-action` with `.finding-use`, `.finding-press`, `.notice`, `ConfirmDialog`'s `.peek.dialog-box` and `.proposal-panel`; `.assistant-page.research-page`, `.dock[data-dock="research"]` with `.research-frame` (the dock: `.dock.is-over`, `.dock-backdrop.is-over`, `.dock-iconbtn`, `.dock-phone.phone-only`), `.assistant-conversations` with `.log-earlier-row` and `.research-run-row`, `article.run` with `.turn-you`, `.run-body`, `.research-line` and `.st.st-plain`, `.run-steps`, `.run-report` with `.cite` and `.run-ref`, `.inst.run-pages`, `.finding` with `.tbl.outcome-change`, `.inst.seed-card`, `.notice`, `.error`, `.empty` |
| BudgetMeter, Seats, Roster, RetentionNotice, ResidencySelect, AuditExportForm | `.inst`, `.midnum`, `.meter`, `.tbl`, `.seg`, `.check`, radio group, `.notice` |
| Empty states, errors, notices (any feature) | `.empty`, `.error` (`role="alert"`), `.notice` |

### 13.4 Icons and glyphs

There is no icon library. Do not add one.

| Need | Use |
|---|---|
| taxonomy node, brand mark | `✢` in `.glyph` (mono, `--act`) |
| derived figure | `ƒ` inside `.derive` / `.t-der` |
| progress and loaders | `▮▯` or `█░` in `.blocks`; running caret `▮` via `.caret` |
| tree structure | box-drawing `├─ └─ │` in `--ink-3` |
| status | an 8px square drawn by `.st::before` (filled, hollow, half-filled), never a pictogram |
| diff result | `=` `≠` `+` before the word |
| read state in paths | `■` read, `□` unread, `◧` in progress |
| close, expand, collapse | inline SVG, 12px viewBox, `stroke="currentColor" stroke-width="1.5" fill="none"`, inside `.iconbtn` with `aria-label`; or the text glyphs `×` and `⇤` |
| back links | `←` text in `.cap` ("← back to 15.9") |
| section markers, list bullets, emphasis | none. No emoji, no coloured discs, no icon fonts, no illustration |

### 13.5 Numbers and data display

- Every figure rendered from content carries its provenance mark (§ 5). A component that receives a `Figure` row without a tier renders nothing and logs a defect; it never renders a bare number.
- One `.bignum` per instrument at most; `.midnum` for secondary readings. The denominator and the date are part of the number (`34/35`, `verified 12 Sep 2026`).
- Percentages, counts and seconds in loaders and status bars use tabular numerals and one decimal at most (`73.6%`, `0.38 s`, `2 m 48 s`).
- Hashes show 12 hex characters; `#c41e·07b2` style fragments are chrome texture (`.tex`), never content.
- Charts and diagrams are trees, ruled tables or single big numbers. Mermaid figures from the release render server-side to SVG with token colours only. No third-party chart library.

### 13.6 Motion

The only animation in the system is the 1.1s step blink of the running caret. No transitions on hover, no slide-in panels, no smooth scroll except the native `scroll-behavior: smooth` under `no-preference`. Everything is disabled under `prefers-reduced-motion: reduce`.

### 13.7 What is forbidden

- Any hex, rgb or hsl value outside `app/globals.css`.
- `border-radius` other than 0; `rounded-*` utilities.
- `box-shadow` other than the hard inset bars and underlines listed in § 4.4; `shadow-*` utilities; gradients; blur.
- Cards, tiles or panels with a fill and no header; floating containers.
- Spinners, skeleton shimmer, toasts, snackbars, modals for feedback.
- Icon libraries, icon fonts, emoji, illustration, hero imagery.
- Truncation (`text-overflow: ellipsis`, `truncate`, `line-clamp`) on any label, heading, status, chip or cell other than an id or hash.
- Fixed-width controls sized for the EN string.
- A number without a tier chip, derive link or illustrative mark.
- The warm colour on anything that is not an action or a running state; the cool colour on a call to action.
- Status conveyed by colour or icon alone.
- Leaderboards, rankings, streaks, timers, "time on page".
- Exclamation marks, "seamless", "powerful", "unlock", "supercharge", "oops", "success!".

## 14. Checklist before a UI change is done

1. Every colour, font and spacing value resolves to a token; grep for `#`, `rgb(`, `rounded`, `shadow` in the diff returns nothing outside `globals.css`.
2. Every panel has a label, a version (or an explicit reason it is unversioned) and a timestamp that names its event.
3. Every figure has a chip, a derive link or an illustrative mark; every link is cool; the one primary action is warm.
4. Every state shows a word and a shape or line style, and reads correctly with colour removed.
5. The PT strings are present, at least as long as the EN fixture demands, and nothing truncates at 390px or 1440px (`npm run test:layout`; a new screen is added to its list).
6. Focus ring visible on every interactive element; targets ≥ 24px desktop and ≥ 44px touch; `aria-*` roles per § 12; axe reports zero AA violations.
7. Reduced motion disables the caret blink; no other animation exists.
8. The screen matches its PNG in `docs/design/png/` in structure and vocabulary; differences are deliberate and recorded here.

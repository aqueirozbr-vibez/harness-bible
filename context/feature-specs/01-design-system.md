# 01 · Design system — feature spec (tokens, component layer, UI primitives)

Read `CLAUDE.md` and `context/ai-workflow-rules.md` before starting.

Rewritten 2026-09-23 to describe the design system as it was decided and built (tracker units 2, 3 and 13, all done on 2026-09-22). The first version of this file asked for shadcn/ui; Andre rejected it the same day (tracker · Architecture Decisions: "No shadcn/ui. The design system is hb.css."), because a UI kit conflicts with ui-context § 13.7, code-standards § Styling and the no-UI-kit decision, and its components need the `rounded-*` and `shadow-*` utilities the token layer removes. This spec is the contract every later unit has built on; it changes only through a reviewed edit here and in `context/ui-context.md` together.

Source of truth: `docs/design/hb.css` v0.9.0 and the style guide (`docs/design/`), summarised in `context/ui-context.md` (§ 2 tokens, § 3 typography, § 4 space and rules, § 5 provenance marks, § 6 status states, § 7 evidence tiers, § 8 instrument panel, § 9 components, § 12 accessibility, § 13 implementation conventions, § 14 checklist). Governing context: `context/architecture.md` § 3.1 (`components/ui/` and `lib/schemas/`), `context/code-standards.md` § Styling (role classes first, layout utilities second, state classes last; no string literals in JSX).

Scope: the three layers under every screen. (1) The token block and the Tailwind theme in `app/globals.css`. (2) The hb.css component classes ported into the same file. (3) The React primitives in `components/ui/` that render those classes, plus `lib/utils.ts` `cn()` and the domain unions in `lib/schemas/domain.ts` the primitives type against. Chrome (`TopBar`, `StatusBar`, `InstrumentPanel`) is spec 02; every screen composition class is the spec of the screen that added it.

## 1. Purpose

One place for every colour, font and spacing value; one class per hb.css component, named exactly as in the UI package so the 18 screens stay a diffable reference; one small React primitive per component, typed so a wrong tier, tone or variant fails to compile. The system is the style guide's "state in form" principle made enforceable: no colour without a token, no number without a provenance mark, no status by colour alone, no radius, shadow, spinner, toast, icon library or truncation anywhere.

## 2. Dependencies and order

| Needs | Why |
|---|---|
| Next.js 16 scaffold with Tailwind CSS 4 (unit 1, done) | the `@import "tailwindcss"` entry and the utility scan |
| `clsx` and `zod` (added in unit 3) | `cn()` and the domain unions; both are in the architecture's allowed list |
| `next/font/google` in the root layout (unit 4) | the `--font-plex-*` variables the token block falls back from |

Build order as it happened: unit 2 the token block, dark theme, `@theme inline` and `@layer base` → unit 3 the eighteen primitives with `lib/utils.ts` and `lib/schemas/domain.ts` → unit 13 every remaining hb.css component class under `@layer components` → verification. Every later screen adds its composition classes to `globals.css` and ui-context § 9.9 in its own unit (rules § 3.4).

## 3. Layer 1 · tokens (`app/globals.css`, ui-context § 13.1)

The file opens with `@import "tailwindcss";` and `@source not "../context";` (Tailwind v4 scans every non-ignored file for class candidates, and the context documents name forbidden utilities in prose).

### 3.1 The token block

`:root` holds, mirroring hb.css v0.9.0 exactly: the 25 colour tokens (`--bg`, `--bg-2`, `--bg-3`, `--surface`, `--ink`, `--ink-2`, `--ink-3`, `--rule`, `--rule-2`, `--rule-strong`, `--act`, `--act-hover`, `--on-act`, `--act-bg`, `--ver`, `--ver-bg`, `--fail`, `--fail-bg`, `--warn`, `--warn-bg`, `--code-bg`, `--sel`, `--focus`, `--term-bg`, `--term-ink`), the two font stacks (`--sans`, `--mono`, each reading `var(--font-plex-*, "IBM Plex …")` first), the nine spacing steps `--s1` (4px) … `--s9` (96px), and `color-scheme: light`.

The dark values (instrument black) are defined twice with the same body: under `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { … } }` for the system preference, and under `:root[data-theme="dark"]` for a viewer who pinned dark. `data-theme` on `<html>` is `light`, `dark` or absent (system); the account page's Light / System / Dark control writes it and `localStorage` `hb.theme`, and the root layout's one inline script (`lib/theme.ts`, nonced) applies the stored value before paint (spec 08 § 6.3). `<body>` carries an explicit background.

This is the only file in the repository that may contain a hex colour, a font stack or a pixel spacing value (verification § 12.1).

### 3.2 The Tailwind theme

`@theme inline` first clears Tailwind's own scales (`--color-*`, `--radius-*`, `--shadow-*`, `--inset-shadow-*`, `--drop-shadow-*`, `--font-*` set to `initial`) and then maps every token: `--color-bg: var(--bg)` … `--color-term-ink`, `--font-sans: var(--sans)`, `--font-mono: var(--mono)`, `--spacing-s1: var(--s1)` … `--spacing-s9`. Consequences a unit relies on: `bg-bg-2`, `text-ink-3`, `border-rule-strong`, `font-mono`, `p-s4`, `gap-s2` compile to `var(--*)`; `rounded-md`, `shadow-md`, `bg-red-500`, `text-sm` do not compile at all. Utilities are for layout (flex, grid, gap, padding, width) and nothing else.

### 3.3 The base layer

`@layer base` carries hb.css's scope rules applied to the document: `body` (background, ink, `--sans`, 14px / 1.45, antialiased, `ss02`), links inherit colour with no underline, `button` reset to inherit font and colour with no background or border, form controls with `border-radius: 0`, `:focus-visible` as a 2px `--focus` outline offset 2px (never removed), `::selection` in `--sel`, native smooth scroll under `prefers-reduced-motion: no-preference`, and every animation and transition disabled under `reduce`.

## 4. Layer 2 · component classes (`app/globals.css` `@layer components`, ui-context § 13.2)

Every component rule of hb.css is ported unprefixed (the `.hb` scope is dropped because the whole app is the scope) with the class names unchanged. The layer is grouped in the order of hb.css: type roles (`.mono .cap .meta .label .tex .h1 … .bignum .midnum`), rules and structure, app chrome (`.topbar .brand .nav .statusbar .kbd`), instrument panel (`.inst .inst-h .t .sep .ts .inst-b .kv .inst-f`), the seven source-tier chips (`.chip .t-*`), status marks (`.st` and its tones, the `.caret` keyframe), evidence tiers (`.ev .ev-*`, `.ev-lg`), buttons (`.btn .btn-p .btn-q .btn-d .btn-sm .btn-lg .iconbtn`), inputs (`.field .input .textarea .select .counter .seg .check`), tables (`.tbl` and its row states), the hash-chained timeline (`.tl …`), code and output (`.code .code-h .code-b .ln .hl .k .s .c .fn .term`), meters and loaders (`.meter .mark .loader .blocks`), peek and side panels (`.peek`), empty and error states (`.empty .error .notice`), then the chrome composition classes and, after them, one block per screen spec (Book Home, search, reading paths, reader chapter, Mermaid figures, marks, sign-in and account), the interaction states of ui-context § 9.10 (hover, active, pressed, the search field ring), the 44px touch targets on coarse pointers, and the mobile type scale.

Rules of the layer:

- A class is added only in a unit scoped to it, with the matching ui-context edit in the same commit (rules § 3.4, § 5). An existing class is never restyled; a missing variant is a new class, never an ad-hoc utility on the caller.
- One deliberate deviation from hb.css is recorded inline: `.tex` lost hb.css's `opacity: .8` because the release stamp failed AA contrast on every page (axe, unit 19).
- Mermaid SVGs rendered at ingestion reuse two names hb.css owns (`.label`, `.row`); the reader block neutralises them inside `.fig svg` (spec 04, tracker · Architecture Decisions).
- Inline `style=""` appears only for data-driven widths (`.meter > i`, `.mark` left) and data-driven grid templates.

## 5. Layer 3 · the primitives (`components/ui/`, architecture § 3.1)

`components/ui/` is ours to edit, not a generated folder. Each file exports one function component that maps a typed prop to an hb.css class through a `Record`, takes every visible string as a prop (the primitives render no text of their own, so `ill` can become `ilu` through next-intl, code-standards § Styling), accepts `className` for layout utilities only, and carries its ARIA contract. Server components unless marked client.

| Primitive | Renders | Props (all `readonly`) | ARIA and rules |
|---|---|---|---|
| `Chip` | `.chip .t-*` | `tier: SourceTier`, `abbr` (the localised two- or three-letter mark inside `<i>`), `children` (the locator or text), `className` | the seven tiers map one-to-one to `.t-pri .t-ven .t-anl .t-pra .t-ill .t-der .t-opn`; a figure without a tier is never rendered (ui-context § 13.5) |
| `DeriveLink` | `.derive` `ƒ L{line}` | `line`, `href?`, `title?`, `className` | opens the code pane at the line; `title` names the file and line |
| `Xref` | `a.xref` | `href`, `children`, `className` | the peek route handles the click (spec 03) |
| `Cite` | `.cite` | `children`, `href?`, `className` | cool colour, never warm |
| `NoCover` | `.nocover` | `children`, `className` | "the book does not cover this" (spec Phase 2) |
| `StatusMark` | `.st` + tone class, optional `.caret` | `tone: StatusTone`, `children` (the word), `label?` (`aria-label` and `title`), `caret?`, `className` | the 8px square is drawn by `::before`; the word is always present (state never by colour alone) |
| `StatusBlock` | `.st-block` + tone | `tone: StatusTone`, `children`, `className` | the large block form for verdict heroes |
| `EvidenceBadge` | `.ev .ev-{tier}`, `.ev-lg` | `tier: EvidenceTier`, `size?: "sm" \| "lg"`, `label?` (`aria-label`), `className` | tiers A–G and U |
| `Button` | `.btn` + `.btn-p .btn-q .btn-d` + `.btn-sm .btn-lg`; `<button>`, `next/link` with `href`, or a plain `<a>` with `native` | `variant?: "default" \| "primary" \| "quiet" \| "destructive"`, `size?: "sm" \| "md" \| "lg"`, `href?`, `native?`, `children` (a verb), `className`, the button attributes | one warm primary per view; destructive is outlined, never filled; `native` exists for route handlers that redirect off-site (the sign-in routes, spec 09) which a client navigation cannot follow; 44px minimum on touch |
| `IconButton` | `.iconbtn` | `label` (required `aria-label`), `children` (an inline 12px stroke SVG or a text glyph), `className`, the button attributes | never an icon font |
| `Kbd` | `.kbd` | `children`, `className` | the keyboard map's keys |
| `Field` | `.field` with `label`, help, error and counter | `label`, `htmlFor`, `children` (the control), `help?`, `error?`, `counter?`, `counterLive?` (default `polite`), `counterClassName?`, `className` | the counter is `aria-live`; the error text is tied to the control by id |
| `Seg` (client) | `.seg` of `<button aria-pressed>` | `options: { value, label }[]`, `value`, `onChange`, `labelledBy?` or `label?`, `className` | `role="group"`; generic over the value union; the sort links of the search page use `.seg-links` with `aria-current` instead, because axe refuses `aria-pressed` on an anchor |
| `Meter` | `.meter > i` + `.mark` | `value`, `min?`, `max?`, `label`, `tone?`, `marks?: { at, ok? }[]`, `className` | `role="meter"` with `aria-valuenow/min/max` and `aria-label` |
| `Loader` | `.loader` with `.blocks` | `children` (the verb line), `prefix?`, `progress?: { done, total }`, `width?`, `glyphs?` (`▮▯` or `█░`), `className` | `role="status"`; the running caret is the only animation in the system |
| `Empty` | `.empty` | `caption?`, `children`, `action?`, `className` | the empty state is a sentence and, at most, one action |
| `ErrorBox` | `.error` | `title`, `children`, `actions?`, `className` | `role="alert"`; no toast, no modal |
| `Notice` | `.notice` | `title`, `children`, `className` | the one-line notice after a redirect (`?saved=`, `?removed=`) |
| `ConfirmDialog` (client, added in unit 20) | `.peek.dialog-box` | `open`, `title`, `body`, `cancelLabel`, `confirmLabel`, `onCancel`, `onConfirm?` or `formAction?` with `fields?`, `children?`, `confirmDisabled?` | `role="dialog" aria-modal aria-labelledby`; focus trapped, `esc` cancels, focus returns to the element that opened it; the confirm is a click or a form submit with hidden fields; the one confirm primitive (`ResetPathDialog`, `DeleteNoteDialog`, `DeleteAccountDialog` wrap it) |

### 5.1 `lib/utils.ts`

```ts
export function cn(...inputs: ReadonlyArray<ClassValue>): string   // clsx only
```

`cn()` accepts strings, arrays and `{ class: boolean }` maps, drops falsy values and joins the rest. It does not resolve Tailwind conflicts (no `tailwind-merge`): utilities here are layout-only, so a collision is a caller defect, and tailwind-merge would also need an `extendTailwindMerge` configuration for the `s*` spacing scale (tracker · Architecture Decisions). Order in JSX: role classes first, layout utilities second, state classes last.

### 5.2 `lib/schemas/domain.ts`

The zod unions the primitives type against, mirroring the TRD § 4.2 enums exactly and kept in sync with `prisma/schema.prisma`: `SourceTierSchema` (`PRIMARY VENDOR ANALYST PRACTITIONER ILLUSTRATIVE DERIVED OPEN`), `EvidenceTierSchema` (`A`–`G`, `U`), `StatusToneSchema` (`ok fail warn mute run`: the nine product states of ui-context § 6 on five tones), `LangSchema` (`EN PT`), `VerifyStatusSchema`, `LayerSchema` with `LAYER_ORDER` (the nine layers), `DiffStatusSchema` (`MATCH DIVERGE NEW`). A primitive receives the inferred type, never a raw string.

## 6. States

The primitives carry states as classes and ARIA, never as colour alone: `aria-pressed` on segments and toggles (`.is-on` mirrors it for the bookmark button, spec 07), `aria-busy` during an optimistic write, `aria-current` on the active nav, outline and sort links, `disabled` on a button that cannot act (with the reason beside it, never a tooltip), `role="alert"` on an error, `role="status"` on a loader, `aria-live="polite"` on a counter. Hover, active and pressed forms are the classes of ui-context § 9.10. Reduced motion stops the caret; nothing else moves.

## 7. Strings

None. Every primitive takes its text as a prop; callers pass next-intl strings from `messages/en.json` and `messages/pt.json` (parity enforced by `tests/messages.test.ts`). The only literals a primitive may render are glyphs (`ƒ`, `▮▯`, `█░`, `×`, `←`) and the characters of an id, version or hash.

## 8. Accessibility (ui-context § 12)

Text contrast ≥ 4.5:1 on both themes (the `.tex` deviation above exists for this); the 2px focus ring on every interactive element; targets ≥ 24px on desktop and ≥ 44px on touch (the `pointer: coarse` block); every figure mark has text (the chip abbreviation plus its word); every state has a word and a shape; `lang` per edition on `<html>`; axe WCAG 2.2 AA zero violations is a release gate, run per screen in each unit's verification.

## 9. Out of scope

- shadcn/ui, Radix, any UI kit, icon library, chart library, CSS-in-JS or `tailwind-merge` (rules § 2.5; the forbidden list).
- Chrome components and screen compositions (spec 02 onwards).
- A Storybook or a component gallery page: the screens in `docs/design/screens/` are the reference, and unit 3's temporary sheet rendering all primitives was reverted after verification.
- Runtime theming beyond light / system / dark; per-organisation branding.

## 10. Decisions

| # | Decision | Taken |
|---|---|---|
| D1 | No shadcn/ui; the design system is the ported hb.css layer plus the primitives in `components/ui/`, which are ours to edit. | Andre, 2026-09-22 (tracker · Architecture Decisions) |
| D2 | Keep Tailwind CSS 4, layout utilities only; tokens live once in `globals.css` and reach Tailwind through `@theme inline`; the default palette, radius and shadow scales are cleared so the forbidden utilities do not compile. | Agent, confirmed by Andre, 2026-09-22 |
| D3 | `cn()` is clsx alone. | Agent, 2026-09-22; revisit only if a real utility conflict appears |
| D4 | Primitives take their text as props and render no string of their own. | Agent, 2026-09-22 |
| D5 | No icon library: glyphs, status squares drawn by CSS, and inline 12px stroke SVG only (ui-context § 13.4). | Agent, 2026-09-22 |
| D6 | The Tailwind scan excludes `context/` (`@source not`). | Agent, 2026-09-22 |
| D7 | `.tex` drops hb.css's `opacity: .8` for AA contrast. | Agent, 2026-09-22 (unit 19, axe) |
| D8 | `Button` renders a plain `<a>` when `native` is set, for redirecting route handlers. | Agent, 2026-09-23 (Keycloak run) |

## 11. Verification (unit 2, 3 and 13 results; rerun whenever this layer changes)

1. `npx tsc --noEmit` exit 0; `npm run lint` zero warnings; `npm run build` passes.
2. Token grep: `#[0-9a-fA-F]{3,6}`, `rgb(`, `hsl(`, `rounded`, `shadow-`, `truncate`, `line-clamp`, `transition-`, `animate-` match only in `app/globals.css`.
3. The served CSS carries every token; `bg-bg-2`, `p-s4`, `text-ink-3`, `font-mono` compile to `var(--*)`; `rounded-md` and `shadow-md` do not compile; the built CSS contains no default palette, `truncate`, `rounded` or `shadow` rule.
4. Every primitive renders the expected markup on a page that uses it: chips with `<i>` abbreviations, status marks with a word, evidence badges, buttons as `<button>` and `<a>` with the disabled state, `role="meter"` with marks, `role="alert"`, `role="status"`, `role="dialog"` with focus return.
5. Both themes: the dark background is present at navigation commit after a reload (no flash) and `Dark`, `System`, `Light` in the account page switch `data-theme`; `<html>` carries the `--font-plex-*` variables.
6. axe: zero WCAG 2.2 AA violations on a screen composed only of primitives and chrome (the sign-in page is the smallest such screen).
7. The 18 screens in `docs/design/screens/` remain diffable: every class a screen uses exists in `globals.css` under the same name, or its absence is recorded in ui-context § 9.9 as deliberate.

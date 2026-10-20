import type { Locale } from "@/lib/i18n/routing";
import { ANCHOR_OF_CHANGE_KIND } from "@/lib/rubric/changeClass";
import type { Role } from "@/lib/schemas/auth";
import { FigureIdSchema, SectionIdSchema, SourceRowIdSchema } from "@/lib/schemas/ids";
import { CHANGE_KINDS, type AnchorKind, type ChangeKind } from "@/lib/schemas/improve";

/*
 * Step 1 of the suggest form (feature-specs/34 § 4, § 7; unit 51b): which kind an anchor id is, where a choice on
 * the page leads, what choosing a kind selects, which section the lists are read from, and whether the person may
 * start a draft at all. Pure: the page reads the rows and asks these. Since unit 76 (feature-specs/48 § 10.1) the way
 * to step 1 from Improve's `New suggestion`, a chapter and then a section: the chooser's address and its `ch`.
 */

/** The kind an id is written as, the three forms being disjoint (lib/schemas/ids.ts); null for anything else. */
export function anchorKindOf(id: string): AnchorKind | null {
  if (SectionIdSchema.safeParse(id).success) return "SECTION";
  if (FigureIdSchema.safeParse(id).success) return "FIGURE";
  if (SourceRowIdSchema.safeParse(id).success) return "SOURCE_ROW";
  return null;
}

/** The two digits of the chapter an id names: `"15.3"`, `"15.9 r12"` and `"F-15-12"` → `"15"`. */
export function chapterDigitsOf(id: string, kind: AnchorKind): string {
  return kind === "FIGURE" ? id.slice(2, 4) : id.slice(0, 2);
}

/**
 * Step 1's address: the anchor's chapter, the anchor, and the section the person came from when it is not the
 * anchor itself, which is the section whose figures the page lists (34 § 4). A row's id holds a space, which the
 * query writes as `+`, so the address carries no whitespace and survives the sign-in's `next` (lib/auth/rules.ts).
 */
export function suggestStartHref(locale: Locale, anchor: string, kind: AnchorKind, from: string): string {
  const query = new URLSearchParams({ anchor });
  if (from !== anchor) query.set("from", from);
  return `/${locale}/ch/${chapterDigitsOf(anchor, kind)}/improve/new?${query.toString()}`;
}

/**
 * The new-suggestion chooser's address (feature-specs/48 § 10.1; unit 76): the release's chapters, or with a chapter's
 * two digits its sections, each of which leads to step 1 (`suggestStartHref`).
 */
export function suggestChooserHref(locale: Locale, chapter: string | null = null): string {
  return chapter === null ? `/${locale}/improve/new` : `/${locale}/improve/new?${new URLSearchParams({ ch: chapter }).toString()}`;
}

/** The chooser's `ch` as the query carries it: a chapter's two digits, `00` to `99`; null for anything else, which reads as no chapter chosen. */
export function chooserChapterOf(value: unknown): string | null {
  return typeof value === "string" && /^\d{2}$/.test(value) ? value : null;
}

/**
 * The section the lists are read from, which the page shows and returns to: a section's own, a figure's own, and
 * for a row — whose Sources layer has no figures to list — the section the person came from, when `from` is one of
 * the chapter's, else the chapter's first. `from` decides for a row alone, so an address cannot set a section's or a
 * figure's anchor beside another section's lists.
 */
export function homeSectionOf(from: string | undefined, anchor: string, kind: AnchorKind, figureSection: string | null): string {
  const digits = chapterDigitsOf(anchor, kind);
  if (kind === "SECTION") return anchor;
  if (kind === "FIGURE" && figureSection !== null) return figureSection;
  if (kind === "SOURCE_ROW" && from !== undefined && SectionIdSchema.safeParse(from).success && from.slice(0, 2) === digits) return from;
  return `${digits}.1`;
}

/**
 * What choosing a kind selects, so that something is always chosen and the page always shows an anchored text: the
 * section the person came from; its first figure; the first row its figures cite, else the chapter's first row.
 * Null when the kind has nothing to choose: a section without figures, a chapter without rows.
 */
export function firstOfKind(
  kind: AnchorKind,
  home: string,
  figures: ReadonlyArray<{ readonly id: string | null }>,
  cited: ReadonlyArray<{ readonly id: string }>,
  rows: ReadonlyArray<{ readonly id: string }>,
): string | null {
  if (kind === "SECTION") return home;
  if (kind === "FIGURE") return figures.find((figure) => figure.id !== null)?.id ?? null;
  return cited[0]?.id ?? rows[0]?.id ?? null;
}

/**
 * The kinds of change an anchor of this kind takes, in the order 30 § 4.1 lists them: a section's four (edit a
 * passage, add a claim, add a source row, restructure), a figure's value, a row's edit. The draft's kind is final
 * (31 § 4: `PATCH` refuses another), so a section's is chosen here, at step 1 (34 D4).
 */
export function changeKindsFor(kind: AnchorKind): ReadonlyArray<ChangeKind> {
  return CHANGE_KINDS.filter((change) => ANCHOR_OF_CHANGE_KIND[change] === kind);
}

/** What step 1 shows the person: the form, or why not (34 § 7). */
export type SuggestGate =
  | { readonly kind: "form" }
  | { readonly kind: "role"; readonly role: Role }
  | { readonly kind: "unverified" }
  | { readonly kind: "throttled"; readonly until: Date };

/**
 * Whether the person may start a draft, asked in the order the create endpoint refuses (lib/api/endpoints/
 * suggestions.ts): the role first — a contributor, or a curator, who is one on the ladder (policies/hb/roles.rego;
 * an organisation admin is not) — then a verified identity, which the policy asks, then the throttle, which the
 * endpoint reads. The endpoint still decides: this only spares the person a form they could not send.
 */
export function suggestGate(user: { readonly role: Role; readonly identityVerified: boolean }, throttledUntil: Date | null, now: Date): SuggestGate {
  if (user.role !== "CONTRIBUTOR" && user.role !== "CURATOR") return { kind: "role", role: user.role };
  if (!user.identityVerified) return { kind: "unverified" };
  if (throttledUntil !== null && throttledUntil > now) return { kind: "throttled", until: throttledUntil };
  return { kind: "form" };
}

import type { SessionUser } from "@/lib/auth/session";
import { contributorStandingOf } from "@/lib/db/account";
import { getChapterData, getCurrentRelease, getHomeData } from "@/lib/db/content";
import type { Locale } from "@/lib/i18n/routing";
import { suggestChooserHref, suggestGate, suggestStartHref, type SuggestGate } from "@/lib/improve/suggest";
import type { HomePart } from "@/lib/schemas/home";
import { padChapter, parseChapterNumber } from "@/lib/schemas/ids";

/*
 * The new-suggestion chooser's loader (feature-specs/48 § 10.1, A11; unit 76): what `/[lang]/improve/new` shows a person,
 * read with the queries that exist and nothing written. First the gate step 1 asks (`suggestGate`, the create endpoint's
 * order): a person who does not draft — a role that does not, an identity not verified, the throttle — is told so at the
 * top, and given no list, so nobody walks two steps to learn they cannot draft. Then the release's chapters, by part, as
 * Book Home groups them (`getHomeData`, cached per release: the dock's catalogue, which the spec names, has no part, and a
 * field added to that cached shape would be served without it until the cache turned), every chapter of the release,
 * verified or not, since the draft door takes an anchor in any (only research reads verified chapters alone, 48 A5); or,
 * with `ch`, that chapter's sections, the outline's layers as the reader reads them (`getChapterData`), each leading to
 * step 1 at the section. A `ch` that names no chapter of the release reads as none chosen.
 */

export interface ChooserChapter {
  /** The chapter's two digits, as its addresses write it. */
  readonly digits: string;
  /** The edition's title: PT where the PT edition is at parity, EN otherwise, as Book Home prints it. */
  readonly title: string;
  readonly version: string;
  /** `?ch=NN`: its sections. */
  readonly href: string;
}

export interface ChooserPart {
  readonly key: HomePart["key"];
  readonly chapters: ReadonlyArray<ChooserChapter>;
}

export interface ChooserSection {
  readonly id: string;
  readonly title: string;
  /** Step 1 at the section (`suggestStartHref`). */
  readonly href: string;
}

/** What the chooser holds: why the person cannot draft, the release's chapters, or a chapter's sections. */
export type ChooserBody =
  | { readonly kind: "gate"; readonly gate: Exclude<SuggestGate, { readonly kind: "form" }> }
  | { readonly kind: "chapters"; readonly parts: ReadonlyArray<ChooserPart> }
  | {
      readonly kind: "sections";
      readonly chapter: ChooserChapter;
      /** The language of the sections' titles: the edition's, EN until PT is at parity. */
      readonly contentLang: "en" | "pt";
      readonly sections: ReadonlyArray<ChooserSection>;
    };

export interface SuggestChooserData {
  readonly release: { readonly id: string; readonly gitSha: string };
  readonly body: ChooserBody;
}

export interface SuggestChooserInput {
  readonly locale: Locale;
  readonly user: SessionUser;
  /** The chapter chosen, its two digits (`chooserChapterOf`); null for the chapters' list. */
  readonly chapter: string | null;
}

export async function getSuggestChooser({ locale, user, chapter }: SuggestChooserInput): Promise<SuggestChooserData> {
  const [standing, release] = await Promise.all([contributorStandingOf(user), getCurrentRelease()]);
  const gate = suggestGate(user, standing.throttledUntil, new Date());
  if (gate.kind !== "form") return { release, body: { kind: "gate", gate } };

  const home = await getHomeData(locale, null);
  const parts: ReadonlyArray<ChooserPart> = home.parts.map((part) => ({
    key: part.key,
    chapters: part.chapters.map((tile) => {
      const digits = padChapter(parseChapterNumber(tile.number));
      return { digits, title: tile.title, version: tile.version, href: suggestChooserHref(locale, digits) };
    }),
  }));
  const chosen = chapter === null ? undefined : parts.flatMap((part) => part.chapters).find((candidate) => candidate.digits === chapter);
  /* the outline is the same in every section's data: the chapter's first layer is read, which every chapter has */
  const data = chosen === undefined ? null : await getChapterData(locale, Number(chosen.digits), `${chosen.digits}.1`, null);
  if (chosen === undefined || data === null) return { release, body: { kind: "chapters", parts } };
  return {
    release,
    body: {
      kind: "sections",
      chapter: chosen,
      contentLang: data.chapter.editionLang === "PT" ? "pt" : "en",
      sections: data.outline.layers.map((layer) => ({ id: layer.id, title: layer.title, href: suggestStartHref(locale, layer.id, "SECTION", layer.id) })),
    },
  };
}

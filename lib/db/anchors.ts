import { getPrisma } from "@/lib/db/client";
import type { Part } from "@/lib/db/generated/enums";
import { currentRelease, requireDatabase } from "@/lib/db/shared";
import type { Locale } from "@/lib/i18n/routing";
import { figureText, rowText, sectionText } from "@/lib/improve/anchorText";
import { chipChapters, type ReleaseFigure, type ReleaseReference } from "@/lib/improve/readings";
import type { SourceTier } from "@/lib/schemas/domain";
import { FigureIdSchema, SectionIdSchema, SourceRowIdSchema } from "@/lib/schemas/ids";
import type { AnchorKind } from "@/lib/schemas/improve";
import { sha256 } from "@/pipeline/renderHash";

/*
 * An anchor resolved against the pinned release (feature-specs/31 § 3): the section, the figure or the source row
 * a suggestion points at, with the text it holds now, the hash of that text, its tier and date, and who else in
 * the book reads it. Content rows are the release's and nobody's, so this reads them as the content loaders do.
 *
 * The text is the source edition's (EN): a suggestion changes the book's source, whatever language the
 * contributor reads it in. `readBy` carries the titles in the contributor's language where the PT edition is at
 * parity, as the reader shows them.
 */

export interface ReadBy {
  readonly section: string;
  readonly title: string;
  readonly chapterNumber: number;
  readonly part: Part;
}

export interface ResolvedAnchor {
  readonly kind: AnchorKind;
  readonly chapterNumber: number;
  readonly chapterVersionId: string;
  readonly chapterVersion: string;
  readonly releaseId: string;
  readonly part: Part;
  readonly sectionAnchor: string;
  readonly figureAnchor: string | null;
  readonly sourceRowAnchor: string | null;
  /** What the anchor says: a section's source text, a figure's label and value, a row's claim and citation. */
  readonly currentText: string;
  /** For a section: its figures, which a text edit must not overlap (31 § 5); empty for a figure or a row. */
  readonly figures: ReadonlyArray<{ readonly id: string; readonly valueText: string }>;
  /** For a figure: its value as the book prints it and its unit (`$0.30`, `USD`), which a value's edit starts from (34 § 5); null for a section or a row. */
  readonly value: { readonly text: string; readonly unit: string | null } | null;
  /** For a source row: its fields as the release has them, which a row's edit is read against (34 § 5); null for a section or a figure. */
  readonly row: { readonly claim: string; readonly citation: string; readonly url: string | null; readonly doi: string | null } | null;
  readonly contentSha256: string;
  readonly tier: SourceTier | null;
  readonly verifiedOn: Date | null;
  readonly fastMoving: boolean;
  readonly scenarioParam: boolean;
  readonly readBy: ReadonlyArray<ReadBy>;
}

const ID_OF: Readonly<Record<AnchorKind, { safeParse: (value: unknown) => { success: boolean } }>> = { SECTION: SectionIdSchema, FIGURE: FigureIdSchema, SOURCE_ROW: SourceRowIdSchema };

/** Whether `id` has the form of an anchor of that kind: `21.3`, `F-21-03`, `21.9 r4`. */
export function anchorIdWellFormed(kind: AnchorKind, id: string): boolean {
  return ID_OF[kind].safeParse(id).success;
}

type SectionWithVersion = { readonly anchor: string; readonly titleEn: string; readonly titlePt: string | null; readonly chapterVersion: { readonly chapterNumber: number; readonly chapter: { readonly part: Part }; readonly editions: ReadonlyArray<{ readonly lang: "EN" | "PT"; readonly status: "PARITY" | "PENDING" }> } };

function readByOf(section: SectionWithVersion, locale: Locale): ReadBy {
  const parity = locale === "pt" && section.chapterVersion.editions.some((edition) => edition.lang === "PT" && edition.status === "PARITY");
  return { section: section.anchor, title: parity && section.titlePt !== null ? section.titlePt : section.titleEn, chapterNumber: section.chapterVersion.chapterNumber, part: section.chapterVersion.chapter.part };
}

const SECTION_OF_READER = { anchor: true, titleEn: true, titlePt: true, chapterVersion: { select: { chapterNumber: true, chapter: { select: { part: true } }, editions: { select: { lang: true, status: true } } } } } as const;

/** The anchor as it stands in the pinned release, or null when the release has no such section, figure or row. */
export async function resolveAnchor(kind: AnchorKind, id: string, locale: Locale): Promise<ResolvedAnchor | null> {
  requireDatabase();
  if (!anchorIdWellFormed(kind, id)) return null;
  const prisma = getPrisma();
  const release = await currentRelease();
  const inRelease = { chapterVersion: { releaseId: release.id } } as const;

  if (kind === "SECTION") {
    const section = await prisma.section.findFirst({
      where: { anchor: id, ...inRelease },
      select: { anchor: true, markdownEn: true, figures: { select: { anchor: true, valueText: true }, orderBy: { ordinal: "asc" } }, chapterVersion: { select: { id: true, version: true, chapterNumber: true, verifiedAt: true, chapter: { select: { part: true } } } } },
    });
    if (section === null) return null;
    const { chapterVersion } = section;
    return {
      kind,
      chapterNumber: chapterVersion.chapterNumber,
      chapterVersionId: chapterVersion.id,
      chapterVersion: chapterVersion.version,
      releaseId: release.id,
      part: chapterVersion.chapter.part,
      sectionAnchor: section.anchor,
      figureAnchor: null,
      sourceRowAnchor: null,
      currentText: sectionText(section),
      contentSha256: sha256(sectionText(section)),
      figures: section.figures.map((figure) => ({ id: figure.anchor, valueText: figure.valueText })),
      value: null,
      row: null,
      tier: null,
      verifiedOn: chapterVersion.verifiedAt,
      fastMoving: false,
      scenarioParam: false,
      readBy: [],
    };
  }

  if (kind === "FIGURE") {
    const figure = await prisma.figure.findFirst({
      where: { anchor: id, section: inRelease },
      select: {
        id: true,
        anchor: true,
        label: true,
        valueText: true,
        unit: true,
        tier: true,
        fastMoving: true,
        scenarioParam: true,
        sourceRow: { select: { verifiedAt: true } },
        section: { select: { anchor: true, chapterVersion: { select: { id: true, version: true, chapterNumber: true, verifiedAt: true, chapter: { select: { part: true } } } } } },
      },
    });
    if (figure === null) return null;
    /* The same figure in another section of the release: a shared figure reaches that chapter too (33 § 4.2). */
    const elsewhere = await prisma.figure.findMany({ where: { anchor: id, section: inRelease, NOT: { id: figure.id } }, select: { section: { select: SECTION_OF_READER } }, orderBy: { section: { anchor: "asc" } } });
    const { chapterVersion } = figure.section;
    const text = figureText(figure);
    return {
      kind,
      chapterNumber: chapterVersion.chapterNumber,
      chapterVersionId: chapterVersion.id,
      chapterVersion: chapterVersion.version,
      releaseId: release.id,
      part: chapterVersion.chapter.part,
      sectionAnchor: figure.section.anchor,
      figureAnchor: figure.anchor,
      sourceRowAnchor: null,
      currentText: text,
      contentSha256: sha256(text),
      figures: [],
      value: { text: figure.valueText, unit: figure.unit },
      row: null,
      tier: figure.tier,
      verifiedOn: figure.sourceRow?.verifiedAt ?? chapterVersion.verifiedAt,
      fastMoving: figure.fastMoving,
      scenarioParam: figure.scenarioParam,
      readBy: elsewhere.map((other) => readByOf(other.section, locale)),
    };
  }

  const row = await prisma.sourceRow.findFirst({
    where: { anchor: id, ...inRelease },
    select: {
      anchor: true,
      claim: true,
      citation: true,
      url: true,
      doi: true,
      tier: true,
      verifiedAt: true,
      fastMoving: true,
      chapterVersion: { select: { id: true, version: true, chapterNumber: true, chapter: { select: { part: true } } } },
      figures: { select: { section: { select: SECTION_OF_READER } }, orderBy: { section: { anchor: "asc" } } },
    },
  });
  if (row === null) return null;
  const text = rowText(row);
  const seen = new Set<string>();
  const readBy = row.figures.map((figure) => readByOf(figure.section, locale)).filter((entry) => !seen.has(entry.section) && seen.add(entry.section));
  return {
    kind,
    chapterNumber: row.chapterVersion.chapterNumber,
    chapterVersionId: row.chapterVersion.id,
    chapterVersion: row.chapterVersion.version,
    releaseId: release.id,
    part: row.chapterVersion.chapter.part,
    sectionAnchor: `${String(row.chapterVersion.chapterNumber).padStart(2, "0")}.9`,
    figureAnchor: null,
    sourceRowAnchor: row.anchor,
    currentText: text,
    contentSha256: sha256(text),
    figures: [],
    value: null,
    row: { claim: row.claim, citation: row.citation, url: row.url, doi: row.doi },
    tier: row.tier,
    verifiedOn: row.verifiedAt,
    fastMoving: row.fastMoving,
    scenarioParam: false,
    readBy,
  };
}

/**
 * The pinned release's rows the cross-chapter sensor's rules read for an anchor (feature-specs/33 § 4.2, § 15): for a
 * row, the figures bound to it and the references to it; for a section, the references to it; for a figure, every
 * figure of the release that prints its value, with the chapters each one's chip names. And the release's tree hash,
 * which the lint sensor checks the files it reads against.
 */
export async function releaseReadings(kind: AnchorKind, id: string): Promise<{ readonly figures: ReadonlyArray<ReleaseFigure>; readonly references: ReadonlyArray<ReleaseReference>; readonly gitSha: string }> {
  requireDatabase();
  const prisma = getPrisma();
  const release = await currentRelease();
  const inRelease = { chapterVersion: { releaseId: release.id } } as const;
  const SECTION = { anchor: true, chapterVersion: { select: { chapterNumber: true, chapter: { select: { part: true } } } } } as const;
  const references =
    kind === "FIGURE"
      ? []
      : (await prisma.crossReference.findMany({ where: { targetKind: kind === "SECTION" ? "section" : "sourceRow", targetId: id, ...inRelease }, select: { from: { select: SECTION } }, orderBy: { from: { anchor: "asc" } } })).map((r) => ({
          from: r.from.anchor,
          part: r.from.chapterVersion.chapter.part,
          target: id,
        }));
  if (kind === "SECTION") return { figures: [], references, gitSha: release.gitSha };

  if (kind === "SOURCE_ROW") {
    const bound = await prisma.figure.findMany({ where: { sourceRow: { anchor: id, ...inRelease } }, select: { anchor: true, valueText: true, tier: true, section: { select: SECTION } }, orderBy: [{ section: { anchor: "asc" } }, { ordinal: "asc" }] });
    const figures = bound.map((f) => ({ id: f.anchor, chapter: f.section.chapterVersion.chapterNumber, section: f.section.anchor, part: f.section.chapterVersion.chapter.part, valueText: f.valueText, tier: f.tier, sourceRow: id, names: [] }));
    return { figures, references, gitSha: release.gitSha };
  }

  const anchored = await prisma.figure.findFirst({ where: { anchor: id, section: inRelease }, select: { valueText: true } });
  if (anchored === null) return { figures: [], references, gitSha: release.gitSha };
  const same = await prisma.figure.findMany({ where: { valueText: anchored.valueText, section: inRelease }, select: { anchor: true, valueText: true, tier: true, section: { select: { ...SECTION, htmlEn: true } } }, orderBy: [{ section: { anchor: "asc" } }, { ordinal: "asc" }] });
  /* each section's chips read once */
  const chips = new Map<string, ReadonlyMap<string, ReadonlyArray<number>>>();
  const figures = same.map((f) => {
    const named = chips.get(f.section.anchor) ?? chipChapters(f.section.htmlEn);
    chips.set(f.section.anchor, named);
    return { id: f.anchor, chapter: f.section.chapterVersion.chapterNumber, section: f.section.anchor, part: f.section.chapterVersion.chapter.part, valueText: f.valueText, tier: f.tier, sourceRow: null, names: named.get(f.anchor) ?? [] };
  });
  return { figures, references, gitSha: release.gitSha };
}

/** The pinned release's version of a chapter, for a sentence about an anchor that is no longer there; null when the release has no such chapter. */
export async function currentChapterVersion(chapterNumber: number): Promise<{ readonly id: string; readonly version: string } | null> {
  requireDatabase();
  const release = await currentRelease();
  return getPrisma().chapterVersion.findFirst({ where: { chapterNumber, releaseId: release.id }, select: { id: true, version: true } });
}


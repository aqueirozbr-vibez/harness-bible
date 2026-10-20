import { z } from "zod";

import type { SessionUser } from "@/lib/auth/session";
import { getPrisma } from "@/lib/db/client";
import { sectionMarksOf } from "@/lib/db/marks";
import { getContinueReading, getReaderProgress } from "@/lib/db/reader-state";
import { ageDays, cached, currentRelease, escapeHtml, firstParagraph, localise, pad, ptAtParity, requireDatabase, STALE_AFTER_DAYS, titleFor } from "@/lib/db/shared";
import { withSystem } from "@/lib/db/tenant";
import type { Locale } from "@/lib/i18n/routing";
import { ChapterDataSchema, classifyRef, CodeBlockViewSchema, PeekDataSchema, sourceLinkOf, type ChapterData, type ChapterDataInput, type PeekData, type PeekDataInput } from "@/lib/schemas/chapter";
import { HomeDataSchema, type HomeData, type HomeDataInput } from "@/lib/schemas/home";
import { chapterStartHref, parseChapterNumber } from "@/lib/schemas/ids";

/*
 * Content loaders (feature-specs/04 § 8). Every loader reads the current
 * release once, assembles a plain DTO, caches it per release, and validates it
 * through the page's zod contract on the way out. Dates cross the cache as ISO
 * strings; the contracts coerce them (D18). Per-user fields (Continue reading,
 * the outline's path block) are added outside the cache from lib/db/reader-state.
 */

const NEIGHBOUR_WINDOW = 8;

type LabState = HomeDataInput["parts"][number]["chapters"][number]["lab"];
type PartKey = "P0" | "P1" | "P2" | "P3";

const PART_KEYS: ReadonlyArray<PartKey> = ["P0", "P1", "P2", "P3"];

/* ── release ─────────────────────────────────────────────────────────────── */

export interface CurrentRelease {
  readonly id: string;
  readonly gitSha: string;
  readonly renderHash: string;
  readonly publishedAt: Date;
  readonly ingestedAt: Date;
}

const loadCurrentRelease = cached("release", async () => {
  const r = await currentRelease();
  return { id: r.id, gitSha: r.gitSha, renderHash: r.renderHash, publishedAt: r.publishedAt.toISOString(), ingestedAt: r.ingestedAt.toISOString() };
});

export async function getCurrentRelease(): Promise<CurrentRelease> {
  requireDatabase();
  const r = await loadCurrentRelease();
  return { ...r, publishedAt: new Date(r.publishedAt), ingestedAt: new Date(r.ingestedAt) };
}

/**
 * Whether every one of these chapters passed verification in the release (spec 13 § 4.1's `R-UNVERIFIED`): the fact the
 * Assistant's turn reads for the chapters it is asked of (`workers/answer/run.ts` `chaptersVerifiedFor`), and since unit
 * 71 a research's start for the chapters its question names (feature-specs/48 § 5.2). No chapter is true. Content rows
 * are the release's and nobody's, read outside any tenant, as the loaders read them.
 */
export async function chaptersPassed(releaseId: string, chapters: ReadonlyArray<number>): Promise<boolean> {
  const wanted = [...new Set(chapters)];
  if (wanted.length === 0) return true;
  const passed = await withSystem(async () => getPrisma().chapterVersion.count({ where: { releaseId, chapterNumber: { in: wanted }, verifyStatus: "PASSED" } }));
  return passed === wanted.length;
}

/* ── book home ───────────────────────────────────────────────────────────── */

const loadHome = cached("home", async (locale: Locale): Promise<HomeDataInput> => {
  const prisma = getPrisma();
  const now = new Date();
  const release = await currentRelease();
  const versions = await prisma.chapterVersion.findMany({
    where: { releaseId: release.id },
    orderBy: { chapterNumber: "asc" },
    include: {
      chapter: true,
      editions: true,
      lab: { select: { ciVerdict: true, ciCheckedAt: true, ciDivergedSince: true } },
      sourceRows: { where: { fastMoving: true }, orderBy: { verifiedAt: "asc" }, take: 1, select: { verifiedAt: true, claim: true } },
    },
  });

  const tiles = versions.map((cv) => {
    const oldestFast = cv.sourceRows[0] ?? null;
    const staleAge = oldestFast === null ? null : ageDays(oldestFast.verifiedAt, now);
    const staleDays = staleAge !== null && staleAge > STALE_AFTER_DAYS ? staleAge : null;
    const lab: LabState =
      cv.lab === null
        ? { kind: "no_lab", carries: cv.chapter.carries === "PROSE" ? "prose" : "instrument" }
        : cv.lab.ciVerdict === "REPRODUCED"
          ? { kind: "reproduced" }
          : { kind: "not_reproduced", since: (cv.lab.ciDivergedSince ?? cv.lab.ciCheckedAt ?? release.ingestedAt).toISOString() };
    return {
      part: cv.chapter.part,
      staleWhat: oldestFast === null || oldestFast.claim.length === 0 ? "source rows" : oldestFast.claim,
      checkedAt: cv.lab?.ciCheckedAt ?? null,
      tile: {
        number: cv.chapterNumber,
        title: titleFor(cv.editions, locale, cv.chapterNumber),
        version: cv.version,
        daysSinceVerify: cv.verifiedAt === null ? null : ageDays(cv.verifiedAt, now),
        verify: cv.verifyStatus,
        redteam: cv.redteamStatus,
        redteamOpen: cv.redteamOpen,
        lab,
        staleDays,
        current: null,
        href: `/${locale}/ch/${pad(cv.chapterNumber)}`,
      },
    };
  });

  const parts: HomeDataInput["parts"] = PART_KEYS.flatMap((key) => {
    const own = tiles.filter((t) => t.part === key);
    if (own.length === 0) return [];
    return [
      {
        key,
        chapters: own.map((t) => t.tile),
        labCount: own.filter((t) => t.tile.lab.kind !== "no_lab").length,
        curators: [],
        glance: {
          verifyPassed: own.filter((t) => t.tile.verify === "PASSED").length,
          labsReproduced: own.filter((t) => t.tile.lab.kind === "reproduced").length,
          stale: own.filter((t) => t.tile.staleDays !== null).map((t) => ({ chapter: t.tile.number, days: t.tile.staleDays ?? 0, what: t.staleWhat })),
        },
      },
    ];
  });

  const all = tiles.map((t) => t.tile);
  const checks = tiles.map((t) => t.checkedAt).filter((d): d is Date => d !== null);
  return {
    release: {
      id: release.id,
      gitSha: release.gitSha,
      publishedAt: release.publishedAt.toISOString(),
      nightlyCheckAt: checks.length === 0 ? null : new Date(Math.max(...checks.map((d) => d.getTime()))).toISOString(),
    },
    status: {
      chapters: all.length,
      verifyPassed: all.filter((c) => c.verify === "PASSED").length,
      labs: all.filter((c) => c.lab.kind !== "no_lab").length,
      labsReproduced: all.filter((c) => c.lab.kind === "reproduced").length,
      labsDiverging: all.flatMap((c) => (c.lab.kind === "not_reproduced" ? [{ chapter: c.number, since: c.lab.since }] : [])),
      stale: all.flatMap((c) => (c.staleDays === null ? [] : [{ chapter: c.number, days: c.staleDays }])),
      redteamOpen: all.flatMap((c) => (c.redteamOpen > 0 ? [{ chapter: c.number, count: c.redteamOpen }] : [])),
    },
    parts,
    continueReading: null,
    sourceLang: "EN",
  };
});

/** Everything Book Home renders (feature-specs/02-book-home.md § 4); Continue reading and the current tile come from the session's progress. */
export async function getHomeData(locale: Locale, user: SessionUser | null): Promise<HomeData> {
  requireDatabase();
  const input = await loadHome(locale);
  const continueReading = user === null ? null : await getContinueReading(locale, user);
  const currentChapter = continueReading === null ? null : Number(continueReading.sectionId.slice(0, 2));
  const parts = input.parts.map((p) => ({
    ...p,
    chapters: p.chapters.map((c) => (c.number === currentChapter && continueReading !== null ? { ...c, current: { sectionId: continueReading.sectionId } } : c)),
  }));
  return HomeDataSchema.parse({ ...input, parts, continueReading });
}

/* ── chapter reader ──────────────────────────────────────────────────────── */

const loadChapter = cached("chapter", async (locale: Locale, chapter: number, sectionId: string): Promise<ChapterDataInput | null> => {
  const prisma = getPrisma();
  const now = new Date();
  const release = await currentRelease();
  const cv = await prisma.chapterVersion.findUnique({
    where: { chapterNumber_releaseId: { chapterNumber: chapter, releaseId: release.id } },
    include: {
      chapter: true,
      editions: true,
      lab: { select: { anchor: true, ciVerdict: true, ciCheckedAt: true, expectedRuntimeS: true } },
      sections: { orderBy: { ordinal: "asc" }, select: { anchor: true, ordinal: true, titleEn: true, titlePt: true } },
      sourceRows: { orderBy: { ordinal: "asc" } },
    },
  });
  if (cv === null) return null;
  const section = await prisma.section.findUnique({
    where: { chapterVersionId_anchor: { chapterVersionId: cv.id, anchor: sectionId } },
    include: { figures: { orderBy: { ordinal: "asc" }, include: { derive: true, sourceRow: { select: { id: true, anchor: true } } } } },
  });
  if (section === null) return null;
  /* The history's rows (37 § 7; unit 54d): one per version the chapter has had — a merge's, or an editorial release's — never a release that re-inserted it unchanged. */
  const [versions, partRows] = await Promise.all([
    prisma.chapterVersion.findMany({ where: { chapterNumber: chapter }, distinct: ["version"], select: { version: true } }),
    prisma.chapterVersion.findMany({
      where: { releaseId: release.id, chapter: { part: cv.chapter.part } },
      orderBy: { chapterNumber: "asc" },
      select: { chapterNumber: true, editions: { select: { lang: true, status: true, title: true } } },
    }),
  ]);

  const usePt = ptAtParity(cv.editions, locale);
  const editionLang = usePt && section.htmlPt !== null ? "PT" : "EN";
  const edition = cv.editions.find((e) => e.lang === (usePt ? "PT" : "EN")) ?? cv.editions.find((e) => e.lang === "EN");
  const title = titleFor(cv.editions, locale, chapter);
  const standfirst = edition !== undefined && edition.standfirst.length > 0 ? edition.standfirst : title;
  const layerTitle = (s: { titleEn: string; titlePt: string | null }): string => (usePt && s.titlePt !== null ? s.titlePt : s.titleEn);
  const href = (anchor: string): string => `/${locale}/ch/${pad(chapter)}/${anchor}`;

  const rowById = new Map(cv.sourceRows.map((r) => [r.id, r]));
  const rowView = (r: (typeof cv.sourceRows)[number]) => {
    const link = sourceLinkOf(r.url, r.doi);
    /* the pipeline refuses such a target; a hand-inserted row is logged, never rendered (feature-specs/10 § 6.4) */
    if (link === null && r.url !== null) console.warn(`source row ${r.anchor}: stored url is not http(s); link suppressed`);
    return {
      id: r.anchor,
      ordinal: r.ordinal,
      claim: r.claim.length > 0 ? r.claim : null,
      citation: r.citation.length > 0 ? r.citation : r.claim.length > 0 ? r.claim : "—",
      url: r.url,
      doi: r.doi,
      link,
      tier: r.tier,
      verifiedAt: r.verifiedAt.toISOString(),
      fastMoving: r.fastMoving,
      stale: r.fastMoving && ageDays(r.verifiedAt, now) > STALE_AFTER_DAYS,
    };
  };
  const citedRowIds = [...new Set(section.figures.flatMap((f) => (f.sourceRowId === null ? [] : [f.sourceRowId])))];
  const sectionRows = (section.layer === "SOURCES" ? cv.sourceRows : citedRowIds.flatMap((id) => rowById.get(id) ?? []).sort((a, b) => a.ordinal - b.ordinal)).map(rowView);

  const figures = section.figures.map((f) => {
    const row = f.sourceRowId === null ? undefined : rowById.get(f.sourceRowId);
    return {
      id: f.anchor,
      label: f.label,
      valueText: f.valueText,
      tier: f.scenarioParam ? ("SCENARIO" as const) : f.tier,
      derive: f.derive === null ? null : { labId: f.derive.labId, filePath: f.derive.filePath, line: f.derive.line, key: f.derive.key },
      sourceRowId: f.sourceRow?.anchor ?? null,
      fastMoving: f.fastMoving,
      ageDays: row === undefined ? null : ageDays(row.verifiedAt, now),
    };
  });

  const codeBlocks = z.array(CodeBlockViewSchema).parse(section.codeBlocks).map((b) => ({ ...b, labHref: b.labHref === null ? null : localise(`href="${b.labHref}"`, locale).slice(6, -1) }));

  const numbers = partRows.map((p) => p.chapterNumber);
  const from = Math.min(...numbers);
  const to = Math.max(...numbers);
  const start = Math.max(from, Math.min(chapter - 2, to - NEIGHBOUR_WINDOW + 1));
  const neighbours = partRows
    .filter((p) => p.chapterNumber >= start && p.chapterNumber < start + NEIGHBOUR_WINDOW)
    .map((p) => ({ number: p.chapterNumber, title: titleFor(p.editions, locale, p.chapterNumber), href: chapterStartHref(locale, parseChapterNumber(p.chapterNumber)) }));

  const index = cv.sections.findIndex((s) => s.anchor === section.anchor);
  const prevSection = index > 0 ? cv.sections[index - 1] : null;
  const nextSection = index >= 0 && index + 1 < cv.sections.length ? cv.sections[index + 1] : null;
  const checkAges = cv.sourceRows.map((r) => ageDays(r.verifiedAt, now));

  return {
    release: { id: release.id, gitSha: release.gitSha },
    chapter: {
      number: chapter,
      part: cv.chapter.part === "P4" ? "P3" : cv.chapter.part,
      title,
      standfirst,
      version: cv.version,
      sourceLang: cv.sourceLang,
      editionLang,
      verify: cv.verifyStatus,
      redteam: cv.redteamStatus,
      redteamOpen: cv.redteamOpen,
      verifiedAt: cv.verifiedAt?.toISOString() ?? null,
      contentHash: cv.contentHash,
      words: cv.words,
      derivedFigures: { linked: cv.derivedLinked, total: cv.derivedTotal },
      citedFigures: { total: cv.citedTotal, fastMoving: cv.citedFastMoving },
      oldestCheckDays: checkAges.length === 0 ? null : Math.max(...checkAges),
      historyCount: versions.length,
      lab:
        cv.lab === null
          ? null
          : {
              id: cv.lab.anchor,
              verdict: cv.lab.ciVerdict ?? "NOT_REPRODUCED",
              lastRunAt: cv.lab.ciCheckedAt?.toISOString() ?? null,
              lastRunBy: "ci",
              expectedRuntimeS: cv.lab.expectedRuntimeS,
            },
    },
    outline: {
      partTitleKey: cv.chapter.part === "P4" ? "P3" : cv.chapter.part,
      range: { from, to, count: partRows.length },
      neighbours,
      layers: cv.sections.map((s) => ({ id: s.anchor, ordinal: s.ordinal, title: layerTitle(s), href: href(s.anchor) })),
    },
    section: {
      id: section.anchor,
      ordinal: section.ordinal,
      layer: section.layer,
      title: layerTitle(section),
      bodyHtml: localise(editionLang === "PT" ? (section.htmlPt ?? section.htmlEn) : section.htmlEn, locale),
      figures,
      sourceRows: sectionRows,
      hasSourceLinks: sectionRows.some((r) => r.link !== null),
      prev: prevSection === null ? null : { id: prevSection.anchor, href: href(prevSection.anchor) },
      next: nextSection === null ? null : { id: nextSection.anchor, href: href(nextSection.anchor) },
      codeBlocks,
    },
    progress: null,
    marks: null,
  };
});

/** Everything the chapter reader renders for one section (feature-specs/03-reader-chapter.md § 4); null when the section is not in the release. */
export async function getChapterData(locale: Locale, chapter: number, sectionId: string, user: SessionUser | null): Promise<ChapterData | null> {
  requireDatabase();
  const input = await loadChapter(locale, chapter, sectionId);
  if (input === null) return null;
  const progress = user === null ? null : await getReaderProgress(user, chapter);
  const marks = user === null ? null : await sectionMarksOf(user, sectionId);
  return ChapterDataSchema.parse({ ...input, progress, marks });
}

/* ── peek ────────────────────────────────────────────────────────────────── */

const loadPeek = cached("peek", async (locale: Locale, id: string): Promise<PeekDataInput | null> => {
  const ref = classifyRef(id);
  if (ref === null) return null;
  const prisma = getPrisma();
  const release = await currentRelease();

  if (ref.kind === "section") {
    const s = await prisma.section.findFirst({
      where: { anchor: ref.sectionId, chapterVersion: { releaseId: release.id } },
      include: { chapterVersion: { include: { editions: true } } },
    });
    if (s === null) return null;
    const usePt = ptAtParity(s.chapterVersion.editions, locale) && s.htmlPt !== null;
    const chapterTitle = titleFor(s.chapterVersion.editions, locale, s.chapterVersion.chapterNumber);
    const layerTitle = usePt && s.titlePt !== null ? s.titlePt : s.titleEn;
    return {
      id,
      kind: "section",
      title: chapterTitle,
      caption: `${chapterTitle.toLowerCase()} · ${layerTitle.toLowerCase()}`,
      version: s.chapterVersion.version,
      bodyHtml: localise(firstParagraph(usePt ? (s.htmlPt ?? s.htmlEn) : s.htmlEn), locale),
      verifiedAt: s.chapterVersion.verifiedAt?.toISOString() ?? null,
      openHref: `/${locale}/ch/${ref.sectionId.slice(0, 2)}/${ref.sectionId}`,
    };
  }

  const cv = await prisma.chapterVersion.findUnique({
    where: { chapterNumber_releaseId: { chapterNumber: ref.chapter, releaseId: release.id } },
    include: { editions: true, lab: true },
  });
  if (cv === null) return null;
  const chapterTitle = titleFor(cv.editions, locale, ref.chapter);

  if (ref.kind === "chapter") {
    const edition = cv.editions.find((e) => e.lang === (ptAtParity(cv.editions, locale) ? "PT" : "EN")) ?? cv.editions.find((e) => e.lang === "EN");
    return {
      id,
      kind: "chapter",
      title: chapterTitle,
      caption: `chapter ${pad(ref.chapter)}`,
      version: cv.version,
      bodyHtml: `<p>${escapeHtml(edition?.standfirst ?? chapterTitle)}</p>`,
      verifiedAt: cv.verifiedAt?.toISOString() ?? null,
      openHref: chapterStartHref(locale, parseChapterNumber(ref.chapter)),
    };
  }

  if (cv.lab === null) return null;
  return {
    id,
    kind: "lab",
    title: `Lab ${pad(ref.chapter)} — ${chapterTitle}`,
    caption: `lab ${pad(ref.chapter)} · readme`,
    version: cv.version,
    bodyHtml: localise(firstParagraph(cv.lab.readme), locale),
    verifiedAt: cv.lab.ciCheckedAt?.toISOString() ?? null,
    openHref: `/${locale}/labs/${cv.lab.anchor}`,
  };
});

/** The peek panel's target (spec 03 § 6.8); null when the id is not in the release. */
export async function getPeek(locale: Locale, id: string): Promise<PeekData | null> {
  requireDatabase();
  const input = await loadPeek(locale, id);
  return input === null ? null : PeekDataSchema.parse(input);
}

/* ── the assistant dock's context ────────────────────────────────────────── */

/**
 * What the dock needs of the release, whatever page it is opened on (feature-specs/24 § 3.3). Since Assistant 2.0
 * the dock stands beside no chapter: its header names the release, its explain line says how much of the book is
 * verified, and compare, lab and walk pick from the whole release. Nothing here is a body, a figure or a source row.
 */
export interface DockCatalogue {
  readonly releaseId: string;
  /** The edition answers cite: the one retrieval reads, EN until the PT editions are plain text and embedded (feature-specs/12 § 10). */
  readonly editionLang: string;
  /** Chapters that passed VERIFY in this release, and how many it has: the explain line's two numbers. */
  readonly verified: number;
  readonly total: number;
  /** The release's chapters, for compare's two selects: the unverified ones are listed but disabled (spec 19 § 3). */
  readonly chapters: ReadonlyArray<{ readonly number: number; readonly title: string; readonly version: string; readonly verified: boolean }>;
  /** The release's labs with CI's last run, for lab mode's select and context line (spec 19 § 3). */
  readonly labs: ReadonlyArray<{ readonly id: string; readonly chapter: number; readonly title: string; readonly version: string; readonly verified: boolean; readonly verdict: string | null; readonly checkedAt: string | null }>;
}

const loadDockCatalogue = cached("dock-catalogue", async (locale: Locale): Promise<DockCatalogue> => {
  const release = await currentRelease();
  const all = await getPrisma().chapterVersion.findMany({
    where: { releaseId: release.id },
    orderBy: { chapterNumber: "asc" },
    select: {
      chapterNumber: true,
      version: true,
      verifyStatus: true,
      editions: { select: { lang: true, title: true, status: true } },
      lab: { select: { anchor: true, title: true, ciVerdict: true, ciCheckedAt: true } },
    },
  });
  return {
    releaseId: release.id,
    editionLang: "EN",
    verified: all.filter((row) => row.verifyStatus === "PASSED").length,
    total: all.length,
    chapters: all.map((row) => ({ number: row.chapterNumber, title: titleFor(row.editions, locale, row.chapterNumber), version: row.version, verified: row.verifyStatus === "PASSED" })),
    labs: all.flatMap((row) =>
      row.lab === null
        ? []
        : [{ id: row.lab.anchor, chapter: row.chapterNumber, title: row.lab.title, version: row.version, verified: row.verifyStatus === "PASSED", verdict: row.lab.ciVerdict, checkedAt: row.lab.ciCheckedAt?.toISOString() ?? null }],
    ),
  };
});

export async function getDockCatalogue(locale: Locale): Promise<DockCatalogue> {
  requireDatabase();
  return loadDockCatalogue(locale);
}

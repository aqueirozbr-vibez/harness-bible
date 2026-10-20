import { tenantOf, type SessionUser } from "@/lib/auth/session";
import { getPrisma } from "@/lib/db/client";
import { marksOf } from "@/lib/db/marks";
import { ageDays, cached, currentRelease, pad, requireDatabase, STALE_AFTER_DAYS, titleFor, type Editions } from "@/lib/db/shared";
import { withTenant } from "@/lib/db/tenant";
import type { Locale } from "@/lib/i18n/routing";
import { chaptersOf, PATH_DEFINITIONS, type PathDefinition, type PathKey, stopId, stopsOf, type StopDefinition } from "@/lib/paths/definitions";
import { activeRow, applyRead, doneCount, firstSection, latestRow, minutesFor, sectionsOfStop, stopState, type ChapterSections, type ProgressRow } from "@/lib/paths/progress";
import type { ChapterDataInput } from "@/lib/schemas/chapter";
import type { HomeDataInput } from "@/lib/schemas/home";
import { PathsDataSchema, type PathsData, type PathsDataInput } from "@/lib/schemas/paths";

/*
 * Reader-state loaders and writes (feature-specs/05 § 5.2, § 5.3). Release
 * content for the paths is cached per release; the user's rows are read inside
 * the session's tenant context and never cached.
 */

interface SectionContent {
  readonly anchor: string;
  readonly ordinal: number;
  readonly titleEn: string;
  readonly titlePt: string | null;
  readonly words: number;
}

interface ChapterContent {
  readonly number: number;
  readonly version: string;
  readonly editions: Editions;
  readonly sections: ReadonlyArray<SectionContent>;
  readonly lab: { readonly anchor: string; readonly verdict: "REPRODUCED" | "NOT_REPRODUCED" | "KILLED" | "ERROR" | null } | null;
  /** ISO date of the oldest fast-moving source row, or null. */
  readonly oldestFastMoving: string | null;
}

interface PathContent {
  readonly release: { readonly id: string; readonly gitSha: string };
  readonly chapters: Record<string, ChapterContent>;
}

const PATH_CHAPTERS: ReadonlyArray<number> = [...new Set(PATH_DEFINITIONS.flatMap(chaptersOf))].sort((a, b) => a - b);

/** The release rows the three paths touch: titles, sections with word counts, lab verdicts, staleness. */
const loadPathContent = cached("path-content", async (): Promise<PathContent> => {
  const prisma = getPrisma();
  const release = await currentRelease();
  const versions = await prisma.chapterVersion.findMany({
    where: { releaseId: release.id, chapterNumber: { in: [...PATH_CHAPTERS] } },
    include: {
      editions: true,
      sections: { orderBy: { ordinal: "asc" }, select: { anchor: true, ordinal: true, titleEn: true, titlePt: true, words: true } },
      lab: { select: { anchor: true, ciVerdict: true } },
      sourceRows: { where: { fastMoving: true }, orderBy: { verifiedAt: "asc" }, take: 1, select: { verifiedAt: true } },
    },
  });
  const chapters: Record<string, ChapterContent> = {};
  for (const cv of versions) {
    chapters[String(cv.chapterNumber)] = {
      number: cv.chapterNumber,
      version: cv.version,
      editions: cv.editions.map((e) => ({ lang: e.lang, status: e.status, title: e.title, standfirst: e.standfirst })),
      sections: cv.sections,
      lab: cv.lab === null ? null : { anchor: cv.lab.anchor, verdict: cv.lab.ciVerdict },
      oldestFastMoving: cv.sourceRows[0]?.verifiedAt.toISOString() ?? null,
    };
  }
  return { release: { id: release.id, gitSha: release.gitSha }, chapters };
});

function chapterSectionsOf(content: PathContent): ChapterSections {
  return new Map(Object.values(content.chapters).map((c) => [c.number, c.sections.map((s) => s.anchor)]));
}

function sectionContent(content: PathContent, anchor: string): { readonly chapter: ChapterContent; readonly section: SectionContent } | null {
  const chapter = content.chapters[String(Number(anchor.slice(0, 2)))];
  const section = chapter?.sections.find((s) => s.anchor === anchor);
  return chapter === undefined || section === undefined ? null : { chapter, section };
}

async function progressRows(user: SessionUser): Promise<ReadonlyArray<ProgressRow & { readonly startedAt: Date }>> {
  const rows = await withTenant(tenantOf(user), () => getPrisma().readingPathProgress.findMany({ where: {} }));
  return rows.flatMap((r) => (PATH_DEFINITIONS.some((d) => d.key === r.path) ? [{ path: r.path as PathKey, pathVersion: r.pathVersion, lastSectionId: r.lastSectionId, completedStops: r.completedStops, updatedAt: r.updatedAt, startedAt: r.startedAt }] : []));
}

/* ── paths page ──────────────────────────────────────────────────────────── */

function stopView(stop: StopDefinition, definition: PathDefinition, content: PathContent, chapters: ChapterSections, row: ProgressRow | null, locale: Locale, now: Date) {
  const sections = sectionsOfStop(stop, chapters);
  const words = sections.reduce((sum, anchor) => sum + (sectionContent(content, anchor)?.section.words ?? 0), 0);
  const { state, at } = stopState(stop, chapters, row);
  const first = sections[0] ?? null;
  const href = first === null ? `/${locale}/paths/${definition.key}` : `/${locale}/ch/${first.slice(0, 2)}/${first}`;
  const chapter = stop.kind === "chapter" ? content.chapters[String(stop.chapter)] : undefined;
  const staleAge = chapter?.oldestFastMoving === null || chapter?.oldestFastMoving === undefined ? null : ageDays(new Date(chapter.oldestFastMoving), now);
  return {
    id: stopId(stop),
    kind: stop.kind,
    label: stop.kind === "chapter" ? pad(stop.chapter) : stop.label,
    title: chapter === undefined ? null : titleFor(chapter.editions, locale, chapter.number),
    titleKey: stop.kind === "sections" ? stop.titleKey : null,
    href,
    sections,
    minutes: minutesFor(words),
    state,
    at,
    stale: staleAge !== null && staleAge > STALE_AFTER_DAYS ? { days: staleAge } : null,
    lab: chapter?.lab !== null && chapter?.lab !== undefined && chapter.lab.verdict !== "REPRODUCED" ? { id: chapter.lab.anchor, verdict: chapter.lab.verdict ?? "NOT_REPRODUCED" } : null,
  };
}

function pathView(definition: PathDefinition, content: PathContent, chapters: ChapterSections, row: (ProgressRow & { startedAt: Date }) | null, locale: Locale, now: Date): PathsDataInput["paths"][number] {
  const groups = definition.groups.map((g) => ({ titleKey: g.titleKey, stops: g.stops.map((s) => stopView(s, definition, content, chapters, row, locale, now)) }));
  const stops = groups.flatMap((g) => g.stops);
  const minutes = stops.reduce((a, s) => a + s.minutes, 0);
  const minutesLeft = stops.filter((s) => s.state !== "read").reduce((a, s) => a + s.minutes, 0);
  return {
    key: definition.key,
    version: definition.version,
    stopNoun: definition.stopNoun,
    groups,
    total: stopsOf(definition).length,
    done: doneCount(definition, row),
    minutes,
    minutesLeft,
    resume: row === null ? null : { sectionId: row.lastSectionId, href: `/${locale}/ch/${row.lastSectionId.slice(0, 2)}/${row.lastSectionId}` },
    outdated: row !== null && row.pathVersion !== definition.version,
    startedAt: row?.startedAt ?? null,
    updatedAt: row?.updatedAt ?? null,
  };
}

/** Everything the paths page renders (feature-specs/05 § 4). */
export async function getPathsData(locale: Locale, user: SessionUser | null): Promise<PathsData> {
  requireDatabase();
  const now = new Date();
  const content = await loadPathContent();
  const chapters = chapterSectionsOf(content);
  const rows = user === null ? [] : await progressRows(user);
  const paths = PATH_DEFINITIONS.map((d) => pathView(d, content, chapters, rows.find((r) => r.path === d.key) ?? null, locale, now));
  const latest = latestRow(rows);
  const activeView = latest === null ? undefined : paths.find((p) => p.key === latest.path);
  return PathsDataSchema.parse({
    release: content.release,
    paths,
    marks: user === null ? null : await marksOf(user, locale),
    active: latest === null || activeView === undefined ? null : { key: latest.path, done: activeView.done, total: activeView.total, resume: latest.lastSectionId },
    signedIn: user !== null,
    sourceLang: "EN",
  });
}

/* ── hooks into Book Home and the reader ─────────────────────────────────── */

/** Continue reading for Book Home (02 § 6.2): the most recently updated path, or null. */
export async function getContinueReading(locale: Locale, user: SessionUser): Promise<HomeDataInput["continueReading"]> {
  const rows = await progressRows(user);
  const latest = latestRow(rows);
  if (latest === null) return null;
  const content = await loadPathContent();
  const found = sectionContent(content, latest.lastSectionId);
  if (found === null) return null;
  const definition = PATH_DEFINITIONS.find((d) => d.key === latest.path);
  if (definition === undefined) return null;
  const pt = locale === "pt" && found.section.titlePt !== null;
  return {
    sectionId: latest.lastSectionId,
    sectionTitle: pt ? (found.section.titlePt ?? found.section.titleEn) : found.section.titleEn,
    chapterTitle: titleFor(found.chapter.editions, locale, found.chapter.number),
    chapterVersion: found.chapter.version,
    layer: found.section.ordinal,
    lastReadAt: latest.updatedAt.toISOString(),
    path: { key: latest.path, done: doneCount(definition, latest), total: stopsOf(definition).length },
    href: `/${locale}/ch/${latest.lastSectionId.slice(0, 2)}/${latest.lastSectionId}`,
  };
}

/** The reading-path block of the outline (03 § 6.1): the active path for this chapter, or null. */
export async function getReaderProgress(user: SessionUser, chapter: number): Promise<ChapterDataInput["progress"]> {
  const rows = await progressRows(user);
  if (rows.length === 0) return null;
  const content = await loadPathContent();
  const chapters = chapterSectionsOf(content);
  const anchors = chapters.get(chapter) ?? [`${pad(chapter)}.1`];
  const active = anchors.map((a) => activeRow(PATH_DEFINITIONS, rows, a, chapters)).find((r) => r !== null) ?? null;
  if (active === null) return null;
  const definition = PATH_DEFINITIONS.find((d) => d.key === active.path);
  if (definition === undefined) return null;
  return { path: active.path, done: doneCount(definition, active), total: stopsOf(definition).length };
}

/* ── writes, called by the server actions ────────────────────────────────── */

/** Upsert the user's row at the path's first section; returns that section id. */
export async function startPathFor(user: SessionUser, key: PathKey): Promise<string> {
  requireDatabase();
  const definition = PATH_DEFINITIONS.find((d) => d.key === key);
  if (definition === undefined) throw new Error(`unknown path ${key}`);
  const content = await loadPathContent();
  const first = firstSection(definition, chapterSectionsOf(content));
  if (first === null) throw new Error(`path ${key} has no sections in the release`);
  await withTenant(tenantOf(user), () =>
    getPrisma().readingPathProgress.upsert({
      where: { userId_path: { userId: user.id, path: key } },
      create: { userId: user.id, path: key, pathVersion: definition.version, lastSectionId: first, completed: 0, completedStops: [] },
      update: { pathVersion: definition.version, lastSectionId: first, completed: 0, completedStops: [] },
    }),
  );
  return first;
}

export async function resetPathFor(user: SessionUser, key: PathKey): Promise<void> {
  requireDatabase();
  await withTenant(tenantOf(user), () => getPrisma().readingPathProgress.deleteMany({ where: { path: key } }));
}

/** Record a section view against the active path; false when no started path contains it. */
export async function recordSectionReadFor(user: SessionUser, sectionId: string): Promise<boolean> {
  requireDatabase();
  const rows = await progressRows(user);
  if (rows.length === 0) return false;
  const content = await loadPathContent();
  const chapters = chapterSectionsOf(content);
  const active = activeRow(PATH_DEFINITIONS, rows, sectionId, chapters);
  if (active === null) return false;
  const definition = PATH_DEFINITIONS.find((d) => d.key === active.path);
  if (definition === undefined) return false;
  const next = applyRead(definition, active, sectionId, chapters);
  await withTenant(tenantOf(user), () =>
    getPrisma().readingPathProgress.update({
      where: { userId_path: { userId: user.id, path: active.path } },
      data: { lastSectionId: next.lastSectionId, completedStops: [...next.completedStops], completed: next.completed },
    }),
  );
  return true;
}

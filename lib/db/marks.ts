import { tenantOf, type SessionUser } from "@/lib/auth/session";
import { getPrisma } from "@/lib/db/client";
import { cached, currentRelease, pad, requireDatabase, titleFor, type Editions } from "@/lib/db/shared";
import { withTenant } from "@/lib/db/tenant";
import { AppError } from "@/lib/errors";
import type { Locale } from "@/lib/i18n/routing";
import { excerpt, NOTE_MAX, noteLength, normaliseNote, orderBookmarks, orderNotes } from "@/lib/marks/rules";
import { MarksDataSchema, type MarksData, type MarksDataInput, type SectionMarks } from "@/lib/schemas/marks";
import type { PathsDataInput } from "@/lib/schemas/paths";

/*
 * Bookmarks and notes: reads and writes (feature-specs/07-bookmarks-notes.md § 5).
 * Every query runs inside the session's tenant context and relies on the
 * guard's injected `userId`; `where` never names the user. Release content is
 * cached per release; the user's rows are read per request.
 */

interface MarkSection {
  readonly ordinal: number;
  readonly titleEn: string;
  readonly titlePt: string | null;
}

interface MarkChapter {
  readonly number: number;
  readonly editions: Editions;
  readonly sections: Record<string, MarkSection>;
}

interface MarkContent {
  readonly release: { readonly id: string; readonly gitSha: string };
  readonly chapters: Record<string, MarkChapter>;
}

/** Every chapter's titles and section titles at the current release, for the lists. */
const loadMarkContent = cached("mark-content", async (): Promise<MarkContent> => {
  const prisma = getPrisma();
  const release = await currentRelease();
  const versions = await prisma.chapterVersion.findMany({
    where: { releaseId: release.id },
    include: { editions: true, sections: { select: { anchor: true, ordinal: true, titleEn: true, titlePt: true } } },
  });
  const chapters: Record<string, MarkChapter> = {};
  for (const cv of versions) {
    const sections: Record<string, MarkSection> = {};
    for (const s of cv.sections) sections[s.anchor] = { ordinal: s.ordinal, titleEn: s.titleEn, titlePt: s.titlePt };
    chapters[String(cv.chapterNumber)] = {
      number: cv.chapterNumber,
      editions: cv.editions.map((e) => ({ lang: e.lang, status: e.status, title: e.title, standfirst: e.standfirst })),
      sections,
    };
  }
  return { release: { id: release.id, gitSha: release.gitSha }, chapters };
});

const chapterOf = (sectionId: string): number => Number(sectionId.slice(0, 2));
const hrefOf = (locale: Locale, sectionId: string): string => `/${locale}/ch/${pad(chapterOf(sectionId))}/${sectionId}`;

/** Whether the section exists at the current release. */
async function sectionExists(sectionId: string): Promise<boolean> {
  const content = await loadMarkContent();
  return content.chapters[String(chapterOf(sectionId))]?.sections[sectionId] !== undefined;
}

function placeOf(content: MarkContent, sectionId: string, locale: Locale) {
  const chapter = content.chapters[String(chapterOf(sectionId))];
  const section = chapter?.sections[sectionId];
  if (chapter === undefined || section === undefined) return null;
  const pt = locale === "pt" && section.titlePt !== null;
  return { title: pt ? (section.titlePt ?? section.titleEn) : section.titleEn, chapterTitle: titleFor(chapter.editions, locale, chapter.number), ordinal: section.ordinal };
}

/** The section's title in the edition, or null when it is not in the release (the sign-in page's return row, 08 § 6.1). */
export async function sectionTitleOf(sectionId: string, locale: Locale): Promise<string | null> {
  requireDatabase();
  const content = await loadMarkContent();
  return placeOf(content, sectionId, locale)?.title ?? null;
}

/* ── reads ───────────────────────────────────────────────────────────────── */

/** The user's bookmark and note on one section (07 § 5.1). */
export async function sectionMarksOf(user: SessionUser, sectionId: string): Promise<SectionMarks> {
  return withTenant(tenantOf(user), async () => {
    const prisma = getPrisma();
    const [bookmark, note] = await Promise.all([
      prisma.bookmark.findFirst({ where: { sectionId }, select: { id: true } }),
      prisma.note.findFirst({ where: { sectionId }, select: { body: true, updatedAt: true } }),
    ]);
    return { bookmarked: bookmark !== null, note: note === null ? null : { body: note.body, updatedAt: note.updatedAt } };
  });
}

/** Everything the marks page renders (07 § 4); empty lists when signed out. */
export async function getMarksData(locale: Locale, user: SessionUser | null): Promise<MarksData> {
  requireDatabase();
  const content = await loadMarkContent();
  if (user === null) {
    return MarksDataSchema.parse({ release: content.release, bookmarks: [], notes: [], syncedAt: null, signedIn: false, sourceLang: "EN" });
  }
  const { bookmarks, notes, progressAt } = await withTenant(tenantOf(user), async () => {
    const prisma = getPrisma();
    const [bookmarks, notes, progress] = await Promise.all([
      prisma.bookmark.findMany({ where: {}, select: { sectionId: true, createdAt: true } }),
      prisma.note.findMany({ where: {}, select: { sectionId: true, body: true, updatedAt: true } }),
      prisma.readingPathProgress.findFirst({ where: {}, orderBy: { updatedAt: "desc" }, select: { updatedAt: true } }),
    ]);
    return { bookmarks, notes, progressAt: progress?.updatedAt ?? null };
  });
  const bookmarkRows = bookmarks.map((b) => ({ sectionId: b.sectionId, chapterNumber: chapterOf(b.sectionId), href: hrefOf(locale, b.sectionId), section: placeOf(content, b.sectionId, locale), createdAt: b.createdAt }));
  const noteRows = notes.map((n) => ({ sectionId: n.sectionId, chapterNumber: chapterOf(n.sectionId), href: hrefOf(locale, n.sectionId), section: placeOf(content, n.sectionId, locale), body: n.body, updatedAt: n.updatedAt }));
  const stamps = [...bookmarks.map((b) => b.createdAt), ...notes.map((n) => n.updatedAt), ...(progressAt === null ? [] : [progressAt])];
  const input: MarksDataInput = {
    release: content.release,
    bookmarks: orderBookmarks(bookmarkRows),
    notes: orderNotes(noteRows),
    syncedAt: stamps.length === 0 ? null : new Date(Math.max(...stamps.map((d) => d.getTime()))),
    signedIn: true,
    sourceLang: "EN",
  };
  return MarksDataSchema.parse(input);
}

/** Counts and the latest note for the "Your marks" instrument (05 § 6.2; moved here by 07 D10). */
export async function marksOf(user: SessionUser, locale: Locale): Promise<PathsDataInput["marks"]> {
  return withTenant(tenantOf(user), async () => {
    const prisma = getPrisma();
    const [bookmarks, notes, latestNote, latestBookmark, latestProgress] = await Promise.all([
      prisma.bookmark.count({ where: {} }),
      prisma.note.count({ where: {} }),
      prisma.note.findFirst({ where: {}, orderBy: { updatedAt: "desc" } }),
      prisma.bookmark.findFirst({ where: {}, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
      prisma.readingPathProgress.findFirst({ where: {}, orderBy: { updatedAt: "desc" }, select: { updatedAt: true } }),
    ]);
    const stamps = [latestNote?.updatedAt, latestBookmark?.createdAt, latestProgress?.updatedAt].filter((d): d is Date => d !== undefined);
    const short = latestNote === null ? "" : excerpt(latestNote.body);
    return {
      bookmarks,
      notes,
      latest: latestNote === null || short.length === 0 ? null : { sectionId: latestNote.sectionId, text: short, at: latestNote.updatedAt, href: hrefOf(locale, latestNote.sectionId) },
      syncedAt: stamps.length === 0 ? null : new Date(Math.max(...stamps.map((d) => d.getTime()))),
    };
  });
}

/* ── writes, called by the server actions ────────────────────────────────── */

async function requireSection(sectionId: string): Promise<void> {
  if (!(await sectionExists(sectionId))) {
    throw new AppError("UNKNOWN_SECTION", `${sectionId} is not a section of the current release`);
  }
}

/** Set or clear the bookmark; both directions are idempotent. Returns the resulting state. */
export async function setBookmarkFor(user: SessionUser, sectionId: string, on: boolean): Promise<boolean> {
  requireDatabase();
  if (on) await requireSection(sectionId);
  await withTenant(tenantOf(user), async () => {
    const prisma = getPrisma();
    if (on) {
      await prisma.bookmark.upsert({ where: { userId_sectionId: { userId: user.id, sectionId } }, create: { userId: user.id, sectionId }, update: {} });
    } else {
      await prisma.bookmark.deleteMany({ where: { sectionId } });
    }
  });
  return on;
}

/** Upsert the note with the normalised body; an empty body deletes the row and returns null. */
export async function saveNoteFor(user: SessionUser, sectionId: string, body: string): Promise<{ body: string; updatedAt: Date } | null> {
  requireDatabase();
  const text = normaliseNote(body);
  if (text.length === 0) {
    await deleteNoteFor(user, sectionId);
    return null;
  }
  if (noteLength(text) > NOTE_MAX) {
    throw new AppError("NOTE_TOO_LONG", `a note is at most ${NOTE_MAX} characters`);
  }
  await requireSection(sectionId);
  const row = await withTenant(tenantOf(user), () =>
    getPrisma().note.upsert({
      where: { userId_sectionId: { userId: user.id, sectionId } },
      create: { userId: user.id, sectionId, body: text },
      update: { body: text },
      select: { body: true, updatedAt: true },
    }),
  );
  return { body: row.body, updatedAt: row.updatedAt };
}

/** Delete the note; true when a row went. Allowed on any section id so stale marks can be cleared. */
export async function deleteNoteFor(user: SessionUser, sectionId: string): Promise<boolean> {
  requireDatabase();
  const result = await withTenant(tenantOf(user), () => getPrisma().note.deleteMany({ where: { sectionId } }));
  return result.count > 0;
}

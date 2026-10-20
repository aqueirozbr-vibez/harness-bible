import { recordPeople } from "@/lib/db/account";
import { getPrisma } from "@/lib/db/client";
import { getChapterData } from "@/lib/db/content";
import { mergedOfChapter } from "@/lib/db/improve";
import { checkedView } from "@/lib/db/ledger";
import { requireDatabase } from "@/lib/db/shared";
import type { Locale } from "@/lib/i18n/routing";
import { historyOf, type MergedInput, type VersionInput } from "@/lib/improve/history";
import { ProposalSchema } from "@/lib/schemas/improve";
import type { ChapterHistory } from "@/lib/schemas/history";
import type { ChapterData } from "@/lib/schemas/chapter";

/*
 * The loader of a chapter's improvement history (feature-specs/37 § 7; unit 54d): the chapter's merged suggestions
 * through the one door, their records from the ledger's chapter view with the chain checked on this request, never
 * cached; the chapter's version in every release, for the editorial rows; the current version's layers; and the
 * people, named by consent. Public: nothing here depends on who reads. Nothing is written.
 */

export type ChapterHistoryData = { readonly kind: "missing" } | { readonly kind: "page"; readonly chapter: ChapterData["chapter"]; readonly release: ChapterData["release"]; readonly strip: ChapterData["outline"]; readonly history: ChapterHistory };

/** The chapter's version in every release, oldest first, with what the editorial rows say of each. */
async function versionsOf(chapterNumber: number): Promise<ReadonlyArray<VersionInput>> {
  requireDatabase();
  const rows = await getPrisma().chapterVersion.findMany({
    where: { chapterNumber },
    select: { version: true, verifyStatus: true, release: { select: { id: true, publishedAt: true } }, lab: { select: { ciVerdict: true } }, _count: { select: { sections: true } } },
  });
  return rows
    .map((row) => ({ release: row.release.id, version: row.version, publishedAt: row.release.publishedAt, sections: row._count.sections, verify: row.verifyStatus, lab: row.lab?.ciVerdict ?? null }))
    .sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime() || a.release.localeCompare(b.release));
}

/** The history alone, as `GET /api/v1/chapters/{n}/history` answers it; null for a chapter the release has not. */
export async function readChapterHistory(chapterNumber: number, now: Date = new Date()): Promise<ChapterHistory | null> {
  const data = await getChapterData("en", chapterNumber, `${String(chapterNumber).padStart(2, "0")}.1`, null);
  if (data === null) return null;
  return historyFor(chapterNumber, data, now);
}

async function historyFor(chapterNumber: number, data: ChapterData, now: Date): Promise<ChapterHistory> {
  const [rows, versions] = await Promise.all([mergedOfChapter(chapterNumber), versionsOf(chapterNumber)]);
  const ids = rows.map((row) => row.id);
  const { rows: records, chain } = await checkedView({ suggestionId: { in: ids } });
  /* the people the rows and the records name: contributors by consent, curators and endorsers by name (invariant 27) */
  const actorIds = records.flatMap((record) => (record.actor.startsWith("user:") ? [record.actor.slice("user:".length)] : []));
  const people = await recordPeople([...new Set([...rows.flatMap((row) => (row.userId === null ? [] : [row.userId])), ...actorIds])]);
  const merged: MergedInput[] = rows.map((row) => {
    const proposal = ProposalSchema.safeParse(row.proposal);
    return { id: row.id, origin: row.origin, userId: row.userId, fromResearch: row.fromResearch, changeKind: row.changeKind, changeClass: row.changeClass, curatorReason: row.curatorReason, proposal: proposal.success ? proposal.data : null, score: row.score, anchor: row.anchor, merge: row.merge, adjudication: row.adjudication, graded: row.graded };
  });
  return historyOf({
    chapter: chapterNumber,
    merged,
    records: records.map((record) => ({ seq: record.seq, kind: record.kind, actor: record.actor, suggestionId: record.suggestionId, payload: record.payload, hash: record.hash })),
    versions,
    layers: data.outline.layers.map((layer) => ({ section: layer.id, title: layer.title })),
    people,
    chain,
    checkedAt: now,
  });
}

/** The page's data: the chapter's header as the reader has it in the viewer's locale, and its history. */
export async function getChapterHistory(locale: Locale, chapterNumber: number, now: Date = new Date()): Promise<ChapterHistoryData> {
  const data = await getChapterData(locale, chapterNumber, `${String(chapterNumber).padStart(2, "0")}.1`, null);
  if (data === null) return { kind: "missing" };
  return { kind: "page", chapter: data.chapter, release: data.release, strip: data.outline, history: await historyFor(chapterNumber, data, now) };
}

import { recordPeople } from "@/lib/db/account";
import { getPrisma } from "@/lib/db/client";
import { curatorsOfParts, decisionWaitsSince, queueCountByPart } from "@/lib/db/improve";
import { currentRelease } from "@/lib/db/shared";
import { quarterStart, rosterPanelOf, type RosterPanel } from "@/lib/improve/roster";
import { PARTS } from "@/lib/schemas/improve";

/*
 * The curator roster panel's reads (feature-specs/38 § 4; unit 55c): the current release's chapters by part, the
 * roster in force, the queue's count by part and the quarter's decision waits, all through their own doors; the
 * arithmetic is `rosterPanelOf`. Every signed-in account reads it (38 D2), so nothing here takes a caller and
 * nothing it returns names a person but a curator's display name, the roster being public (29 § 6.3).
 */
export async function readRosterPanel(now: Date = new Date()): Promise<RosterPanel> {
  const release = await currentRelease();
  const [chapters, roster, queue, decisions] = await Promise.all([
    getPrisma().chapterVersion.findMany({ where: { releaseId: release.id }, select: { chapterNumber: true, chapter: { select: { part: true } } }, orderBy: { chapterNumber: "asc" } }),
    curatorsOfParts(PARTS, now),
    queueCountByPart(PARTS),
    decisionWaitsSince(quarterStart(now)),
  ]);
  const people = await recordPeople([...new Set(roster.map((entry) => entry.userId))]);
  return rosterPanelOf({ chapters: chapters.map((row) => ({ number: row.chapterNumber, part: row.chapter.part })), roster, people, queue, decisions }, now);
}

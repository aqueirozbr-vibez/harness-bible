import { getPrisma } from "@/lib/db/client";
import { requireDatabase } from "@/lib/db/shared";

/*
 * Releases as a merge reads them (feature-specs/37 § 5; unit 54c): the ids already taken, which the release a merge
 * makes must not be (D1); a release by its id, so that a step run again finds the one it published; and a chapter's
 * version in a release, which the `merged` record is written on. Reads only: a release is written by the pipeline's
 * ingestion alone (invariant 3).
 */

export interface ReleaseRow {
  readonly id: string;
  readonly gitSha: string;
  readonly renderHash: string;
  readonly isCurrent: boolean;
}

export async function releaseIds(): Promise<ReadonlyArray<string>> {
  requireDatabase();
  return (await getPrisma().release.findMany({ select: { id: true } })).map((release) => release.id);
}

export async function releaseOf(id: string): Promise<ReleaseRow | null> {
  requireDatabase();
  return getPrisma().release.findUnique({ where: { id }, select: { id: true, gitSha: true, renderHash: true, isCurrent: true } });
}

/** A source row's verification date in a release, by its anchor (`21.9 r4`); null where the release has no such row. */
export async function sourceRowVerifiedIn(releaseId: string, anchor: string): Promise<Date | null> {
  requireDatabase();
  const row = await getPrisma().sourceRow.findFirst({ where: { anchor, chapterVersion: { releaseId } }, select: { verifiedAt: true } });
  return row?.verifiedAt ?? null;
}

export async function chapterVersionIn(releaseId: string, chapterNumber: number): Promise<{ readonly id: string; readonly version: string } | null> {
  requireDatabase();
  return getPrisma().chapterVersion.findFirst({ where: { releaseId, chapterNumber }, select: { id: true, version: true } });
}

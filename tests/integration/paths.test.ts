import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SessionUser } from "@/lib/auth/session";
import { getPrisma } from "@/lib/db/client";
import { getChapterData, getHomeData } from "@/lib/db/content";
import { getContinueReading, getPathsData, getReaderProgress, recordSectionReadFor, resetPathFor, startPathFor } from "@/lib/db/reader-state";
import { withTenant } from "@/lib/db/tenant";
import { env } from "@/lib/env";

/*
 * Reading paths against the ingested release (feature-specs/05 § 12): two
 * users, isolated by the tenant guard; rows created here are removed after.
 */
const hasDatabase = env.DATABASE_URL !== undefined;

const A_ID = "00000000-0000-4000-8000-00000000a001";
const B_ID = "00000000-0000-4000-8000-00000000b002";
const userA: SessionUser = { id: A_ID, organisationId: null, role: "READER", displayName: "Test A", locale: "en-GB", identityVerified: false, parts: [], sessionId: null };
const userB: SessionUser = { id: B_ID, organisationId: null, role: "READER", displayName: "Test B", locale: "en-GB", identityVerified: false, parts: [], sessionId: null };

async function ensureUser(user: SessionUser, email: string): Promise<void> {
  await withTenant({ userId: user.id, organisationId: null }, () =>
    getPrisma().user.upsert({ where: { id: user.id }, create: { id: user.id, email, displayName: user.displayName, role: "READER" }, update: {} }),
  );
}

async function clear(user: SessionUser): Promise<void> {
  await withTenant({ userId: user.id, organisationId: null }, () => getPrisma().readingPathProgress.deleteMany({ where: {} }));
}

describe.skipIf(!hasDatabase)("reading paths against the release database", () => {
  beforeAll(async () => {
    await ensureUser(userA, "test-a@harness-bible.local");
    await ensureUser(userB, "test-b@harness-bible.local");
    await clear(userA);
    await clear(userB);
  });

  afterAll(async () => {
    await clear(userA);
    await clear(userB);
  });

  it("renders the three paths from the release with word-based minutes", async () => {
    const data = await getPathsData("en", null);
    expect(data.signedIn).toBe(false);
    expect(data.marks).toBeNull();
    expect(data.active).toBeNull();
    expect(data.paths.map((p) => [p.key, p.total, p.done])).toEqual([
      ["executive", 8, 0],
      ["builder", 14, 0],
      ["foundations", 15, 0],
    ]);
    const builder = data.paths[1];
    const ch21 = builder.groups.flatMap((g) => g.stops).find((s) => s.id === "ch21");
    expect(ch21?.title).toBe("Control plane and durable execution");
    expect(ch21?.sections).toHaveLength(9);
    expect(ch21?.minutes).toBeGreaterThanOrEqual(28);
    expect(ch21?.href).toBe("/en/ch/21/21.1");
    expect(builder.groups.flatMap((g) => g.stops).every((s) => s.state === "unread")).toBe(true);
    const aids = data.paths[0].groups.flatMap((g) => g.stops).find((s) => s.id === "decision-aids-8");
    expect(aids?.sections).toEqual(["21.8", "23.8", "28.8", "31.8"]);
    expect(aids?.titleKey).toBe("decisionAids");
  });

  it("refuses reader-state queries outside a tenant context", async () => {
    await expect(getPrisma().readingPathProgress.findMany()).rejects.toMatchObject({ code: "NO_TENANT" });
  });

  it("starts, records, resumes and resets a path for one user without touching another", async () => {
    expect(await startPathFor(userA, "builder")).toBe("16.1");
    let data = await getPathsData("en", userA);
    expect(data.marks).toEqual({ bookmarks: 0, notes: 0, latest: null, syncedAt: expect.any(Date) });
    expect(data.active).toMatchObject({ key: "builder", done: 0, total: 14, resume: "16.1" });
    const stops = () => data.paths[1].groups.flatMap((g) => g.stops);
    expect(stops()[0]).toMatchObject({ id: "ch16", state: "in_progress", at: "16.1" });

    for (let k = 2; k <= 9; k += 1) expect(await recordSectionReadFor(userA, `16.${k}`)).toBe(true);
    expect(await recordSectionReadFor(userA, "17.1")).toBe(true);
    expect(await recordSectionReadFor(userA, "03.2")).toBe(false);
    data = await getPathsData("en", userA);
    expect(data.paths[1].done).toBe(1);
    expect(stops()[0].state).toBe("read");
    expect(stops()[1]).toMatchObject({ id: "ch17", state: "in_progress", at: "17.1" });
    expect(data.paths[1].minutesLeft).toBe(data.paths[1].minutes - stops()[0].minutes);
    expect(data.paths[1].resume?.href).toBe("/en/ch/17/17.1");

    const cont = await getContinueReading("en", userA);
    expect(cont).toMatchObject({ sectionId: "17.1", layer: 1, path: { key: "builder", done: 1, total: 14 }, href: "/en/ch/17/17.1" });
    expect(await getReaderProgress(userA, 17)).toEqual({ path: "builder", done: 1, total: 14 });
    expect(await getReaderProgress(userA, 3)).toBeNull();

    const home = await getHomeData("en", userA);
    expect(home.continueReading?.sectionId).toBe("17.1");
    expect(home.parts.flatMap((p) => p.chapters).find((c) => c.number === 17)?.current).toEqual({ sectionId: "17.1" });
    const chapter = await getChapterData("en", 17, "17.1", userA);
    expect(chapter?.progress).toEqual({ path: "builder", done: 1, total: 14 });

    const other = await getPathsData("en", userB);
    expect(other.active).toBeNull();
    expect(other.paths[1].done).toBe(0);
    expect(await recordSectionReadFor(userB, "16.9")).toBe(false);

    await resetPathFor(userA, "builder");
    data = await getPathsData("en", userA);
    expect(data.active).toBeNull();
    expect(data.paths[1].resume).toBeNull();
  });

  it("completes a sections stop only when every section was read", async () => {
    expect(await startPathFor(userA, "executive")).toBe("00.1");
    for (const s of ["21.8", "23.8", "28.8"]) expect(await recordSectionReadFor(userA, s)).toBe(true);
    let data = await getPathsData("en", userA);
    const aids = () => data.paths[0].groups.flatMap((g) => g.stops).find((s) => s.id === "decision-aids-8");
    expect(aids()?.state).toBe("in_progress");
    expect(data.paths[0].done).toBe(0);
    expect(await recordSectionReadFor(userA, "31.8")).toBe(true);
    data = await getPathsData("en", userA);
    expect(aids()?.state).toBe("read");
    expect(data.paths[0].done).toBe(1);
    await resetPathFor(userA, "executive");
  });
});

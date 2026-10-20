import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SessionUser } from "@/lib/auth/session";
import { getPrisma } from "@/lib/db/client";
import { getChapterData } from "@/lib/db/content";
import { deleteNoteFor, getMarksData, marksOf, saveNoteFor, sectionMarksOf, setBookmarkFor } from "@/lib/db/marks";
import { withTenant } from "@/lib/db/tenant";
import { env } from "@/lib/env";
import { NOTE_MAX } from "@/lib/marks/rules";

/*
 * Bookmarks and notes against the ingested release (feature-specs/07 § 12.2):
 * two users isolated by the tenant guard; rows created here are removed after.
 */
const hasDatabase = env.DATABASE_URL !== undefined;

const A_ID = "00000000-0000-4000-8000-00000000a011";
const B_ID = "00000000-0000-4000-8000-00000000b012";
const userA: SessionUser = { id: A_ID, organisationId: null, role: "READER", displayName: "Marks A", locale: "en-GB", identityVerified: false, parts: [], sessionId: null };
const userB: SessionUser = { id: B_ID, organisationId: null, role: "READER", displayName: "Marks B", locale: "en-GB", identityVerified: false, parts: [], sessionId: null };

async function ensureUser(user: SessionUser, email: string): Promise<void> {
  await withTenant({ userId: user.id, organisationId: null }, () =>
    getPrisma().user.upsert({ where: { id: user.id }, create: { id: user.id, email, displayName: user.displayName, role: "READER" }, update: {} }),
  );
}

async function clear(user: SessionUser): Promise<void> {
  await withTenant({ userId: user.id, organisationId: null }, async () => {
    await getPrisma().bookmark.deleteMany({ where: {} });
    await getPrisma().note.deleteMany({ where: {} });
  });
}

describe.skipIf(!hasDatabase)("bookmarks and notes against the release database", () => {
  beforeAll(async () => {
    await ensureUser(userA, "marks-a@harness-bible.local");
    await ensureUser(userB, "marks-b@harness-bible.local");
    await clear(userA);
    await clear(userB);
  });

  afterAll(async () => {
    await clear(userA);
    await clear(userB);
  });

  it("refuses mark queries outside a tenant context", async () => {
    await expect(getPrisma().bookmark.findMany()).rejects.toMatchObject({ code: "NO_TENANT" });
    await expect(getPrisma().note.findMany()).rejects.toMatchObject({ code: "NO_TENANT" });
  });

  it("toggles a bookmark idempotently and keeps users apart", async () => {
    expect(await setBookmarkFor(userA, "21.3", true)).toBe(true);
    expect(await setBookmarkFor(userA, "21.3", true)).toBe(true);
    const rows = await withTenant({ userId: A_ID, organisationId: null }, () => getPrisma().bookmark.findMany({ where: {} }));
    expect(rows).toHaveLength(1);
    expect((await sectionMarksOf(userA, "21.3")).bookmarked).toBe(true);
    expect((await sectionMarksOf(userB, "21.3")).bookmarked).toBe(false);

    expect(await setBookmarkFor(userA, "21.3", false)).toBe(false);
    expect(await setBookmarkFor(userA, "21.3", false)).toBe(false);
    expect((await sectionMarksOf(userA, "21.3")).bookmarked).toBe(false);
  });

  it("refuses a bookmark on a section outside the release", async () => {
    await expect(setBookmarkFor(userA, "99.9", true)).rejects.toMatchObject({ code: "UNKNOWN_SECTION" });
  });

  it("saves, updates, normalises and deletes a note", async () => {
    const saved = await saveNoteFor(userA, "21.3", "  Check key scope\r\nbefore Lab 21.  ");
    expect(saved?.body).toBe("Check key scope\nbefore Lab 21.");
    expect(saved?.updatedAt).toBeInstanceOf(Date);

    const again = await saveNoteFor(userA, "21.3", "Second draft.");
    expect(again?.body).toBe("Second draft.");
    const rows = await withTenant({ userId: A_ID, organisationId: null }, () => getPrisma().note.findMany({ where: {} }));
    expect(rows).toHaveLength(1);

    expect((await sectionMarksOf(userA, "21.3")).note?.body).toBe("Second draft.");
    expect((await sectionMarksOf(userB, "21.3")).note).toBeNull();

    expect(await saveNoteFor(userA, "21.3", "   ")).toBeNull();
    expect((await sectionMarksOf(userA, "21.3")).note).toBeNull();
    expect(await deleteNoteFor(userA, "21.3")).toBe(false);
  });

  it("refuses a note over the limit or on an unknown section", async () => {
    await expect(saveNoteFor(userA, "21.3", "x".repeat(NOTE_MAX + 1))).rejects.toMatchObject({ code: "NOTE_TOO_LONG" });
    await expect(saveNoteFor(userA, "99.9", "orphan")).rejects.toMatchObject({ code: "UNKNOWN_SECTION" });
    expect(await saveNoteFor(userA, "21.3", "x".repeat(NOTE_MAX))).not.toBeNull();
    await deleteNoteFor(userA, "21.3");
  });

  it("lists bookmarks in book order and notes newest first, with a stale mark flagged", async () => {
    await setBookmarkFor(userA, "21.3", true);
    await setBookmarkFor(userA, "07.2", true);
    await setBookmarkFor(userA, "16.1", true);
    await withTenant({ userId: A_ID, organisationId: null }, () => getPrisma().bookmark.create({ data: { userId: A_ID, sectionId: "99.9" } }));
    await saveNoteFor(userA, "21.3", "first");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await saveNoteFor(userA, "07.2", "second");

    const data = await getMarksData("en", userA);
    expect(data.signedIn).toBe(true);
    expect(data.bookmarks.map((b) => b.sectionId)).toEqual(["07.2", "16.1", "21.3", "99.9"]);
    expect(data.bookmarks[2].href).toBe("/en/ch/21/21.3");
    expect(data.bookmarks[2].section?.title).toBe("Worked numbers");
    expect(data.bookmarks[2].section?.chapterTitle).toBe("Control plane and durable execution");
    expect(data.bookmarks[2].section?.ordinal).toBe(3);
    expect(data.bookmarks[3].section).toBeNull();
    expect(data.notes.map((n) => [n.sectionId, n.body])).toEqual([
      ["07.2", "second"],
      ["21.3", "first"],
    ]);
    expect(data.syncedAt?.getTime()).toBe(data.notes[0].updatedAt.getTime());

    const pt = await getMarksData("pt", userA);
    expect(pt.bookmarks[0].href).toBe("/pt/ch/07/07.2");

    const instrument = await marksOf(userA, "en");
    expect(instrument).toMatchObject({ bookmarks: 4, notes: 2, latest: { sectionId: "07.2", text: "second", href: "/en/ch/07/07.2" } });

    const other = await getMarksData("en", userB);
    expect(other.bookmarks).toHaveLength(0);
    expect(other.notes).toHaveLength(0);

    const signedOut = await getMarksData("en", null);
    expect(signedOut.signedIn).toBe(false);
    expect(signedOut.syncedAt).toBeNull();
  });

  it("carries the marks into the chapter reader's data", async () => {
    const data = await getChapterData("en", 21, "21.3", userA);
    expect(data?.marks).toEqual({ bookmarked: true, note: { body: "first", updatedAt: expect.any(Date) } });
    const out = await getChapterData("en", 21, "21.3", null);
    expect(out?.marks).toBeNull();
  });
});

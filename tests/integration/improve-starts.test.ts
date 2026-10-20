import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { tenantOf, type SessionUser } from "@/lib/auth/session";
import { getPrisma } from "@/lib/db/client";
import { getImproveHome } from "@/lib/db/improveHome";
import { readResearchConversationView, UNUSED_FINDINGS_MAX, unusedFindingsOf } from "@/lib/db/research";
import { getSuggestChooser } from "@/lib/db/suggestChooser";
import { withSystem, withTenant } from "@/lib/db/tenant";
import { env } from "@/lib/env";
import { clearResearchPage, seedResearchPage } from "@/tests/fixtures/research/page";

/*
 * Improve's two starts against the database (feature-specs/48 § 10, § 26; unit 76), on the release this machine holds
 * and the rows the research seed writes (tests/fixtures/research/page.ts):
 *
 * - the chooser lists every chapter of the release once, by part, each leading to its sections; a chapter's sections are
 *   its outline's layers, each leading to step 1 at that section; a `ch` the release has not is the chapters' list; a
 *   reader, an unverified contributor and a throttled one are told why and given no list;
 * - `unusedFindingsOf` holds the `VALID` findings whose run's words are held, newest first, each as the run's own view
 *   gives it, a send's code included — and none of another person's, none drafted or sent, none whose words are gone;
 * - the landing page's loader gives them to their owner with who they are to them, and nothing to anyone else;
 * - since the review: the newest fifty alone, the newest run's first, none with the reader's note, change or sources.
 */

const ready = env.DATABASE_URL !== undefined;
const person = (n: number, role: SessionUser["role"], identityVerified: boolean): SessionUser => ({ id: `00000000-0000-4000-8000-0000000a76${String(n).padStart(2, "0")}`, organisationId: null, role, displayName: `Starts ${String(n)}`, locale: "en", identityVerified, parts: [], sessionId: null });
const READER = person(1, "READER", false);
const CONTRIBUTOR = person(2, "CONTRIBUTOR", true);
const UNVERIFIED = person(3, "CONTRIBUTOR", false);
const THROTTLED = person(4, "CONTRIBUTOR", true);
const OTHER = person(5, "READER", false);
/* one with more unused findings than the landing page lists (review of unit 76) */
const CAPPED = person(6, "READER", false);
const USERS = [READER, CONTRIBUTOR, UNVERIFIED, THROTTLED, OTHER, CAPPED];
const THROTTLED_UNTIL = new Date(Date.now() + 10 * 86_400_000);

describe.skipIf(!ready)("Improve's two starts, against the database (48 § 10)", () => {
  beforeAll(async () => {
    await withSystem(async () => {
      for (const user of USERS) {
        const throttledUntil = user === THROTTLED ? THROTTLED_UNTIL : null;
        await getPrisma().user.upsert({ where: { id: user.id }, update: { role: user.role, identityVerified: user.identityVerified, throttledUntil }, create: { id: user.id, email: `${user.id}@improve-starts.test`, displayName: user.displayName, role: user.role, identityVerified: user.identityVerified, throttledUntil } });
      }
    });
  });

  afterAll(async () => {
    for (const user of USERS) await clearResearchPage(user);
    for (const user of USERS) await withTenant(tenantOf(user), () => getPrisma().researchConversation.deleteMany({}));
    await withSystem(() => getPrisma().user.deleteMany({ where: { id: { in: USERS.map((user) => user.id) } } }));
  });

  it("lists the release's chapters by part, a chapter's sections leading to step 1, and a `ch` the release has not as the chapters", async () => {
    const release = await withSystem(() => getPrisma().release.findFirstOrThrow({ where: { isCurrent: true }, select: { id: true, chapters: { orderBy: { chapterNumber: "asc" }, select: { chapterNumber: true, version: true } } } }));
    const chapters = await getSuggestChooser({ locale: "en", user: CONTRIBUTOR, chapter: null });
    expect(chapters.release.id).toBe(release.id);
    if (chapters.body.kind !== "chapters") throw new Error(`the chapters' list, not ${chapters.body.kind}`);
    const listed = chapters.body.parts.flatMap((part) => part.chapters);
    /* every chapter of the release once, verified or not, in order, with its version */
    expect(listed.map((chapter) => [chapter.digits, chapter.version])).toEqual(release.chapters.map((chapter) => [String(chapter.chapterNumber).padStart(2, "0"), chapter.version]));
    expect(listed.every((chapter) => chapter.href === `/en/improve/new?ch=${chapter.digits}` && chapter.title.length > 0)).toBe(true);
    expect(new Set(chapters.body.parts.map((part) => part.key)).size).toBe(chapters.body.parts.length);

    const sections = await getSuggestChooser({ locale: "pt", user: CONTRIBUTOR, chapter: "21" });
    if (sections.body.kind !== "sections") throw new Error(`chapter 21's sections, not ${sections.body.kind}`);
    expect(sections.body.chapter).toMatchObject({ digits: "21", href: "/pt/improve/new?ch=21" });
    expect(sections.body.sections.map((section) => section.id)).toEqual(["21.1", "21.2", "21.3", "21.4", "21.5", "21.6", "21.7", "21.8", "21.9"]);
    expect(sections.body.sections.map((section) => section.href)).toEqual(sections.body.sections.map((section) => `/pt/ch/21/improve/new?anchor=${section.id}`));
    expect(sections.body.sections.every((section) => section.title.length > 0)).toBe(true);

    expect((await getSuggestChooser({ locale: "en", user: CONTRIBUTOR, chapter: "77" })).body.kind).toBe("chapters");
  });

  it("tells a reader, an unverified contributor and a throttled one why they cannot draft, with no list, as step 1 does", async () => {
    expect((await getSuggestChooser({ locale: "en", user: READER, chapter: null })).body).toEqual({ kind: "gate", gate: { kind: "role", role: "READER" } });
    expect((await getSuggestChooser({ locale: "en", user: UNVERIFIED, chapter: "21" })).body).toEqual({ kind: "gate", gate: { kind: "unverified" } });
    const throttled = await getSuggestChooser({ locale: "en", user: THROTTLED, chapter: "21" });
    expect(throttled.body).toEqual({ kind: "gate", gate: { kind: "throttled", until: THROTTLED_UNTIL } });
  });

  it("holds the unused findings whose run's words are held, newest first, each as the run's view gives it — none of another's, none used, none whose words are gone", async () => {
    const seed = await seedResearchPage(READER);
    const unused = await unusedFindingsOf(READER);
    const view = await readResearchConversationView(READER, seed.done);
    const first = view?.runs[0];
    if (first === undefined) throw new Error("the done research has no run");
    /* the done research's first run: its two that passed (a claim and a figure's value); the purged research's unused one is not offered */
    expect(unused.map((entry) => [entry.research.id, entry.run.id, entry.finding.n, entry.finding.anchor?.id, entry.finding.changeKind, entry.finding.use.state])).toEqual([
      [seed.done, first.id, 1, "21.3", "ADD_CLAIM", "VALID"],
      [seed.done, first.id, 2, "F-21-16", "SET_VALUE", "VALID"],
    ]);
    /* the run's own view of each, less the reader's words, which the row does not show (review of unit 76) */
    expect(first.findings.every((finding) => finding.note !== null && finding.change !== null && finding.sources !== null)).toBe(true);
    expect(unused.map((entry) => entry.finding)).toEqual(first.findings.map((finding) => ({ ...finding, change: null, sources: null, note: null })));
    expect(unused[0]?.research.chapters).toEqual([21]);
    expect(unused[0]?.contentLang).toBe("en");
    expect(await unusedFindingsOf(OTHER)).toEqual([]);

    /* a send's code stays on an unused finding, which its line says (48 § 8.1) */
    const [claim, value] = unused.map((entry) => entry.finding.id);
    await withTenant(tenantOf(READER), () => getPrisma().researchFinding.update({ where: { id: value }, data: { failure: "SENDS_LIMIT" } }));
    expect((await unusedFindingsOf(READER)).map((entry) => entry.finding.use.failure)).toEqual([null, "SENDS_LIMIT"]);
    /* one drafted is used: it leaves, and the other keeps its number in its run */
    await withTenant(tenantOf(READER), () => getPrisma().researchFinding.update({ where: { id: claim }, data: { outcome: "DRAFTED" } }));
    expect((await unusedFindingsOf(READER)).map((entry) => [entry.finding.id, entry.finding.n])).toEqual([[value, 2]]);
    /* its run's words gone: nothing left to use */
    await withTenant(tenantOf(READER), () => getPrisma().researchRun.update({ where: { id: first.id }, data: { textPurgedAt: new Date() } }));
    expect(await unusedFindingsOf(READER)).toEqual([]);
  });

  it("gives the landing page's `From a research` to its owner with who they are to the findings, and nothing to anyone else", async () => {
    for (const user of [READER, CONTRIBUTOR, THROTTLED]) await seedResearchPage(user);
    const reader = await getImproveHome({ locale: "en", user: READER });
    expect(reader.fromResearch?.findings).toHaveLength(2);
    expect(reader.fromResearch?.role).toMatchObject({ kind: "send", configured: env.RESEARCH_PRINCIPAL !== undefined });
    expect((await getImproveHome({ locale: "en", user: CONTRIBUTOR })).fromResearch?.role).toEqual({ kind: "draft" });
    expect((await getImproveHome({ locale: "en", user: THROTTLED })).fromResearch?.role).toEqual({ kind: "throttled", until: THROTTLED_UNTIL.toISOString() });
    expect((await getImproveHome({ locale: "en", user: OTHER })).fromResearch).toBeNull();
    expect((await getImproveHome({ locale: "en", user: null })).fromResearch).toBeNull();
  });

  it("lists the newest fifty unused findings, the newest run's first and in the reader's order, each run's numbers its own (review of unit 76)", async () => {
    const release = await withSystem(() => getPrisma().release.findFirstOrThrow({ where: { isCurrent: true }, select: { id: true } }));
    const now = Date.now();
    const finding = (i: number) => ({ anchor: { kind: "SECTION", id: "21.3" }, changeKind: "ADD_CLAIM", proposal: { kind: "ADD_CLAIM", text: `A claim the reader wrote, number ${String(i)}.`, placeAfter: "end", fastMoving: false }, sources: [{ url: "https://docs.stripe.com/api/idempotent_requests" }], note: `Note ${String(i)}.` });
    const PER_RUN = 30;
    /* two runs of thirty valid findings each, one research: sixty unused, ten more than the page lists */
    const runs = await withTenant(tenantOf(CAPPED), async () => {
      const prisma = getPrisma();
      const conversation = await prisma.researchConversation.create({ data: { userId: CAPPED.id, organisationId: null, locale: "EN", createdAt: new Date(now - 20 * 60_000), lastRunAt: new Date(now - 10 * 60_000) }, select: { id: true } });
      const ids: string[] = [];
      for (const ordinal of [1, 2]) {
        const run = await prisma.researchRun.create({
          data: {
            userId: CAPPED.id,
            releaseId: release.id,
            locale: "EN",
            state: "DONE",
            gap: false,
            sectionAnchors: ["21.3"],
            targetAnchors: ["21.3"],
            questionSha256: "c".repeat(64),
            traceId: "a76cab50".repeat(4),
            conversationId: conversation.id,
            ordinal,
            question: `Question ${String(ordinal)}`,
            found: { findings: Array.from({ length: PER_RUN }, (_, i) => finding(i + 1)), pages: ["https://docs.stripe.com/api/idempotent_requests"], valid: Array.from({ length: PER_RUN }, (_, i) => i + 1), dropped: 0 },
            createdAt: new Date(now - (3 - ordinal) * 10 * 60_000),
            finishedAt: new Date(now - (3 - ordinal) * 10 * 60_000 + 60_000),
          },
          select: { id: true },
        });
        await prisma.researchFinding.createMany({ data: Array.from({ length: PER_RUN }, (_, i) => ({ runId: run.id, userId: CAPPED.id, ordinal: i + 1, outcome: "VALID" as const })) });
        ids.push(run.id);
      }
      return ids;
    });
    const [older, newer] = runs;
    const unused = await unusedFindingsOf(CAPPED);
    expect(UNUSED_FINDINGS_MAX).toBe(50);
    expect(unused).toHaveLength(UNUSED_FINDINGS_MAX);
    expect(unused.map((entry) => [entry.run.id, entry.finding.n])).toEqual([...Array.from({ length: PER_RUN }, (_, i) => [newer, i + 1]), ...Array.from({ length: UNUSED_FINDINGS_MAX - PER_RUN }, (_, i) => [older, i + 1])]);
    /* each with its anchor resolved and its section's title, none with the reader's words */
    expect(unused.every((entry) => entry.finding.anchor?.id === "21.3" && entry.finding.anchor.title !== null)).toBe(true);
    expect(unused.every((entry) => entry.finding.note === null && entry.finding.change === null && entry.finding.sources === null)).toBe(true);
  });
});

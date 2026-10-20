import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { tenantOf, type SessionUser } from "@/lib/auth/session";
import { getPrisma } from "@/lib/db/client";
import { listResearchConversations, readResearchConversationView, readSeedView, researchConversationCounts } from "@/lib/db/research";
import { loadResearchDock, loadResearchPage } from "@/lib/db/researchPage";
import { withSystem, withTenant } from "@/lib/db/tenant";
import { env } from "@/lib/env";
import { researchPageStateOf } from "@/lib/research/links";
import { ResearchConversationViewSchema } from "@/lib/schemas/api";
import { clearResearchPage, seedResearchPage } from "@/tests/fixtures/research/page";

/*
 * The Research page's reads against the database (feature-specs/48 § 11; unit 72), on the rows the research seed writes
 * (tests/fixtures/research/page.ts): the list labels a research by its runs' sections and counts its runs and the
 * findings drafted or sent, never a word of the person's; the counts; the seed answer's card, which another person reads
 * as none; and the page's loader — the open research with its runs, a foreign `research` as no research, `from` valid or
 * invalid, and the composer closed by the day's thirty. Every view the page renders parses as the endpoint's.
 */

const ready = env.DATABASE_URL !== undefined;
const ASKER: SessionUser = { id: "00000000-0000-4000-8000-0000000a7201", organisationId: null, role: "READER", displayName: "Page Asker", locale: "en", identityVerified: false, parts: [], sessionId: null };
const OTHER: SessionUser = { id: "00000000-0000-4000-8000-0000000a7202", organisationId: null, role: "READER", displayName: "Page Other", locale: "en", identityVerified: false, parts: [], sessionId: null };
const USERS = [ASKER, OTHER];

describe.skipIf(!ready)("the Research page's reads, against the database (48 § 11)", () => {
  beforeAll(async () => {
    await withSystem(async () => {
      for (const user of USERS) await getPrisma().user.upsert({ where: { id: user.id }, update: {}, create: { id: user.id, email: `${user.id}@research-page.test`, displayName: user.displayName, role: "READER" } });
    });
  });

  afterAll(async () => {
    for (const user of USERS) await clearResearchPage(user);
    for (const user of USERS) await withTenant(tenantOf(user), () => getPrisma().researchConversation.deleteMany({}));
    await withSystem(() => getPrisma().user.deleteMany({ where: { id: { in: USERS.map((user) => user.id) } } }));
  });

  it("lists the asker's researches newest first, labelled by their runs' sections and counted, and none of another's", async () => {
    const seed = await seedResearchPage(ASKER);
    const rows = await listResearchConversations(ASKER, { limit: 20 });
    /* by their newest run: the one under way began 40 s ago, the follow-up 10 minutes ago, the stale run 2 hours ago */
    expect(rows.map((row) => row.id)).toEqual([seed.underWay, seed.done, seed.seeded, seed.refused, seed.stopped, seed.purged]);
    const byId = new Map(rows.map((row) => [row.id, row]));
    /* the findings that passed (an `INVALID` one never counts), and of those the ones drafted or sent */
    expect(byId.get(seed.done)).toMatchObject({ chapters: [21], runs: 2, findings: 3, used: 1, seeded: false, textPurged: false });
    expect(byId.get(seed.purged)).toMatchObject({ chapters: [21], runs: 1, findings: 3, used: 2, textPurged: true });
    expect(byId.get(seed.seeded)).toMatchObject({ seeded: true, findings: 0, used: 0 });
    /* a refused run planned nothing, so its research names no chapter */
    expect(byId.get(seed.refused)).toMatchObject({ chapters: [], runs: 3 });
    expect(await listResearchConversations(ASKER, { limit: 2 })).toHaveLength(2);
    expect(await listResearchConversations(OTHER, { limit: 20 })).toEqual([]);

    const counts = await researchConversationCounts(ASKER);
    expect(counts.conversations).toBe(6);
    /* the oldest run whose words are held: the stopped research's first, five hours ago, never the purged one's */
    expect(counts.oldestTextAt?.getTime()).toBeGreaterThan(Date.now() - 6 * 3_600_000);
    expect(await researchConversationCounts(OTHER)).toEqual({ conversations: 0, oldestTextAt: null });
  });

  it("reads the seed answer's card for its asker, and nothing of it for another person", async () => {
    const seed = await seedResearchPage(ASKER);
    const view = await readSeedView(ASKER, seed.seedAnswer);
    expect(view).toMatchObject({ cited: ["21.3", "21.4"], answered: true, question: "How long should a server keep an idempotency key?" });
    expect(await readSeedView(OTHER, seed.seedAnswer)).toBeNull();
    expect(await readSeedView(ASKER, "00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("loads the page: the open research with its runs, a foreign one as none, `from` valid or not", async () => {
    const seed = await seedResearchPage(ASKER);
    const now = new Date();
    const open = await loadResearchPage(ASKER, researchPageStateOf({ research: seed.done, from: seed.seedAnswer }), now);
    expect(open.open?.id).toBe(seed.done);
    expect(open.open?.runs.map((run) => run.line.key)).toEqual(["done", "done"]);
    /* `from` is read only while no research is open */
    expect(open.from).toBeNull();
    expect(open.conversations).toBe(6);

    const foreign = await loadResearchPage(OTHER, researchPageStateOf({ research: seed.done }), now);
    expect(foreign.open).toBeNull();
    expect(foreign.list).toEqual([]);

    const seeded = await loadResearchPage(ASKER, researchPageStateOf({ from: seed.seedAnswer }), now);
    expect(seeded.from).toMatchObject({ kind: "seed", messageId: seed.seedAnswer });
    expect((await loadResearchPage(OTHER, researchPageStateOf({ from: seed.seedAnswer }), now)).from).toEqual({ kind: "invalid" });
    expect((await loadResearchPage(ASKER, researchPageStateOf({ from: "not-an-id" }), now)).from).toEqual({ kind: "invalid" });

    /* the open seeded research's card, and the deleted line once its answer is gone */
    const withSeed = await loadResearchPage(ASKER, researchPageStateOf({ research: seed.seeded }), now);
    expect(withSeed.open?.seed).toMatchObject({ kind: "answer", messageId: seed.seedAnswer });
    await withTenant(tenantOf(ASKER), () => getPrisma().researchConversation.update({ where: { id: seed.seeded }, data: { seedMessageId: "00000000-0000-4000-8000-000000000001" } }));
    expect((await loadResearchPage(ASKER, researchPageStateOf({ research: seed.seeded }), now)).open?.seed).toEqual({ kind: "deleted" });
  });

  it("loads the Research dock (48 § 12; unit 77): the open research with its runs as the page reads them, `1`, a foreign or a malformed id as none, and nothing for a signed-out person", async () => {
    const seed = await seedResearchPage(ASKER);
    const now = new Date();
    const page = await loadResearchPage(ASKER, researchPageStateOf({ research: seed.done }), now);
    const dock = await loadResearchDock(ASKER, seed.done, now);
    expect(dock.open?.id).toBe(seed.done);
    expect(dock.open?.runs).toEqual(page.open?.runs);
    expect(dock.closed).toEqual(page.closed);
    expect(dock.findingRole).toEqual(page.findingRole);
    /* a seeded research carries its card in the dock too */
    expect((await loadResearchDock(ASKER, seed.seeded, now)).open?.seed).toMatchObject({ kind: "answer", messageId: seed.seedAnswer });
    expect((await loadResearchDock(ASKER, "1", now)).open).toBeNull();
    expect((await loadResearchDock(ASKER, "not-an-id", now)).open).toBeNull();
    expect((await loadResearchDock(OTHER, seed.done, now)).open).toBeNull();
    const out = await loadResearchDock(null, seed.done, now);
    expect(out.open).toBeNull();
    expect(out.closed).toBeNull();
  });

  it("serves every seeded state as the endpoint's view: the stale run, the findings of a run whose words are gone by their outcome, no invalid finding", async () => {
    const seed = await seedResearchPage(ASKER);
    const stopped = await readResearchConversationView(ASKER, seed.stopped);
    expect(stopped?.runs.map((run) => [run.line.key, run.stale])).toEqual([
      ["notStarted", false],
      ["stopped", false],
      ["failed", false],
      ["notRun", false],
      ["abandoned", true],
    ]);
    const purged = await readResearchConversationView(ASKER, seed.purged);
    expect(purged?.runs[0]?.findings.map((finding) => [finding.n, finding.use.state, finding.textPurged])).toEqual([
      [1, "SENT", true],
      [2, "REFUTED", true],
      [3, "VALID", true],
    ]);
    const done = await readResearchConversationView(ASKER, seed.done);
    expect(done?.runs[0]?.findings.map((finding) => finding.n)).toEqual([1, 2]);
    expect(done?.runs[0]?.pages.map((page) => page.n)).toEqual([1, 2, 3, 4]);
    expect(done?.runs[1]?.pages.map((page) => page.n)).toEqual([1, 2, 3]);
    for (const id of [seed.done, seed.underWay, seed.refused, seed.stopped, seed.purged, seed.seeded]) {
      const view = await readResearchConversationView(ASKER, id);
      expect(view).not.toBeNull();
      if (view === null) continue;
      const parsed = ResearchConversationViewSchema.safeParse({ id: view.conversation.id, locale: "en", seed: view.conversation.seedMessageId, createdAt: view.conversation.createdAt.toISOString(), textPurgedAt: view.conversation.textPurgedAt?.toISOString() ?? null, runs: view.runs });
      expect(parsed.success, id).toBe(true);
    }
  });
});

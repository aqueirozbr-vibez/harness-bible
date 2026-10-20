import { describe, expect, it } from "vitest";

import { handler, type HandlerDeps } from "@/lib/api/handler";
import type { SessionUser } from "@/lib/auth/session";
import type { QueueRow } from "@/lib/db/improve";
import { CurationQueueSchema } from "@/lib/schemas/curation";

import { curationEndpoints, type CurationEndpointDeps } from "./curation";

/*
 * The curator queue's reads (feature-specs/36 § 3, § 11.4; unit 53a), the rows and the pipeline doubled, at a fixed
 * clock: a curator's role and nothing less; the items filed in their groups in the screen's order, each with its
 * deadline from the decision that queued it; a group with nothing absent; the marks; what the caller decided today
 * from midnight; the filters handed to the door; no seed's flag in the answer.
 */

const NOW = new Date("2026-10-10T12:00:00.000Z");
const CURATOR: SessionUser = { id: "33333333-3333-4333-8333-333333333333", organisationId: null, role: "CURATOR", displayName: "A curator", locale: "en", identityVerified: true, parts: ["P1", "P3"], sessionId: "s1" };
const CONTRIBUTOR: SessionUser = { ...CURATOR, id: "11111111-1111-4111-8111-111111111111", role: "CONTRIBUTOR", parts: [] };

const row = (id: string, fields: Partial<QueueRow>): QueueRow =>
  ({
    id,
    state: "CURATOR_QUEUE",
    outcome: "CURATOR_REVIEW",
    changeClass: "CURATOR_ALWAYS",
    curatorReason: "SAFETY_OT",
    score: 40,
    parts: ["P3"],
    submittedAt: new Date("2026-10-08T10:00:00.000Z"),
    decidedAt: new Date("2026-10-08T12:00:00.000Z"),
    anchor: { suggestionId: id, kind: "SECTION", sectionAnchor: "35.2", figureAnchor: null, sourceRowAnchor: null },
    graded: [],
    origin: "HUMAN",
    fromResearch: false,
    ...fields,
  }) as QueueRow;

const ROWS: ReadonlyArray<QueueRow> = [
  row("S-35-0001", {}),
  row("S-15-0377", { changeClass: "CITED_FIGURE", curatorReason: null, outcome: "REQUEST_MORE", score: 66, parts: ["P1", "P3"], anchor: { suggestionId: "S-15-0377", kind: "SOURCE_ROW", sectionAnchor: "15.9", figureAnchor: null, sourceRowAnchor: "15.9 r4" }, graded: [{ tier: "C", adjustedScore: 56 }, { tier: "D", adjustedScore: 42 }] }),
  row("S-22-0356", { curatorReason: "STRUCTURE", decidedAt: new Date("2026-10-09T18:00:00.000Z") }),
  row("S-23-0412", { changeClass: "WORDING", curatorReason: null, outcome: "CURATOR_REVIEW", decidedAt: new Date("2026-10-01T12:00:00.000Z") }),
  row("S-30-0001", { curatorReason: "RUBRIC" }),
];

/** The decision's members and the metrics', which the queue's reads never call. */
const UNUSED: Pick<CurationEndpointDeps, "read" | "write" | "withdraw" | "signal" | "recorded" | "pause" | "calibration" | "accepts" | "reviews" | "seed" | "writeSeed" | "recheck" | "writeMerge" | "signalMerge" | "anchor" | "writeRevert" | "startRevert" | "writeStands"> = {
  read: async () => null,
  write: async () => ({ written: false }),
  withdraw: async () => false,
  signal: async () => undefined,
  recorded: async () => null,
  pause: async () => undefined,
  calibration: async () => [],
  accepts: async () => [],
  reviews: async () => [],
  seed: async () => null,
  writeSeed: async () => ({ written: false }),
  recheck: async () => ({ started: false }),
  writeMerge: async () => ({ written: false }),
  signalMerge: async () => undefined,
  anchor: async () => null,
  writeRevert: async () => ({ written: false }),
  startRevert: async () => undefined,
  writeStands: async () => ({ written: false }),
};

function harness(rows: ReadonlyArray<QueueRow> = ROWS, over: Partial<CurationEndpointDeps> = {}) {
  const asked: Array<{ readonly part: string | null; readonly changeClass: string | null }> = [];
  const since: Date[] = [];
  const deps: CurationEndpointDeps = {
    queue: async (_user, filter) => {
      asked.push(filter);
      return rows;
    },
    decidedSince: async (_user, from) => {
      since.push(from);
      return [{ suggestionId: "S-21-0007", action: "ACCEPT", createdAt: new Date("2026-10-10T09:30:00.000Z"), seed: null }];
    },
    now: () => NOW,
    seedShare: 0,
    samplePerMonth: null,
    seeds: async () => {
      throw new Error("no seed is asked for at share 0 (36 § 7.1)");
    },
    merged: async () => {
      throw new Error("nothing is drawn while the sample is unset (36 § 7.2)");
    },
    merging: async () => [],
    ...UNUSED,
    ...over,
  };
  const pipeline = (session: SessionUser | null): HandlerDeps => ({
    sessionFromRequest: async () => session,
    authorize: async () => ({ allow: true }),
    consume: async () => ({ allowed: true, limit: 120, remaining: 119, resetS: 1, retryAfterS: 0 }),
    idempotency: { begin: async () => ({ kind: "new" }), complete: async () => undefined, abandon: async () => undefined },
    audit: async () => undefined,
    log: () => undefined,
  });
  const { curationQueue } = curationEndpoints(deps);
  const get = (session: SessionUser | null, query = ""): Promise<Response> => handler(curationQueue, pipeline(session))(new Request(`http://localhost:3000/api/v1/curation/queue${query}`), { params: Promise.resolve({}) });
  return { get, asked, since };
}

describe("GET /api/v1/curation/queue (36 § 3)", () => {
  it("is declared as 36 § 3 says: a session, the curator's role, 120 a minute, the policy's read of the curation", () => {
    const { curationQueue } = curationEndpoints();
    expect(curationQueue).toMatchObject({ path: "/api/v1/curation/queue", method: "GET", auth: "session", role: "CURATOR", rateLimit: { key: "user", limit: 120, windowS: 60 }, policy: { action: "read" } });
  });

  it("is refused to a contributor, and to nobody signed in", async () => {
    const { get } = harness();
    const refused = await get(CONTRIBUTOR);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "ROLE_REQUIRED" });
    expect((await get(null)).status).toBe(401);
  });

  it("files each item in its group, in the screen's order, with its deadline from the decision that queued it; a group with nothing is absent", async () => {
    const { get } = harness();
    const response = await get(CURATOR);
    expect(response.status).toBe(200);
    const queue = CurationQueueSchema.parse(await response.json());
    expect(queue.groups.map((group) => [group.group, group.deadlineHours, group.items.map((item) => item.id)])).toEqual([
      ["safety", 24, ["S-35-0001"]],
      ["structure", 120, ["S-22-0356"]],
      /* longest waiting first, whatever order the rows came in: queued 1 October before 8 October */
      ["inspection", 168, ["S-23-0412", "S-15-0377"]],
    ]);
    const [safety] = queue.groups[0].items;
    expect(safety).toMatchObject({ anchor: { kind: "SECTION", id: "35.2", section: "35.2" }, queuedAt: "2026-10-08T12:00:00.000Z", deadline: "2026-10-09T12:00:00.000Z", shared: false });
    const shared = queue.groups[2].items[1];
    expect(shared).toMatchObject({ anchor: { kind: "SOURCE_ROW", id: "15.9 r4", section: "15.9" }, tier: "C", score: 66, parts: ["P1", "P3"], shared: true, deadline: "2026-10-15T12:00:00.000Z" });
  });

  it("files a researcher's proposal under Researcher proposals, seven days, before the inspections, and marks its origin; a curator-always one by its reason (43 § 7.1; unit 60d)", async () => {
    const researched = row("S-21-0101", { changeClass: "NEW_CLAIM", curatorReason: null, outcome: "ACCEPT", origin: "RESEARCHER", score: 85 });
    const safety = row("S-21-0102", { origin: "RESEARCHER" });
    const { get } = harness([...ROWS, researched, safety]);
    const queue = CurationQueueSchema.parse(await (await get(CURATOR)).json());
    expect(queue.groups.map((group) => group.group)).toEqual(["safety", "structure", "researcher", "inspection"]);
    const group = queue.groups.find((entry) => entry.group === "researcher");
    expect(group).toMatchObject({ deadlineHours: 168, items: [{ id: "S-21-0101", origin: "RESEARCHER", deadline: "2026-10-15T12:00:00.000Z" }] });
    /* queued at the same moment: by id */
    expect(queue.groups[0].items.map((item) => [item.id, item.origin])).toEqual([
      ["S-21-0102", "RESEARCHER"],
      ["S-35-0001", "HUMAN"],
    ]);
  });

  it("carries a contributor's draft from a research finding as a person's, filed by its class, with its provenance for the class line (48 § 8.6; unit 74)", async () => {
    const drafted = row("S-21-0103", { changeClass: "WORDING", curatorReason: null, outcome: "CURATOR_REVIEW", fromResearch: true });
    const { get } = harness([...ROWS, drafted]);
    const queue = CurationQueueSchema.parse(await (await get(CURATOR)).json());
    const items = queue.groups.flatMap((group) => group.items.map((item) => ({ group: group.group, ...item })));
    expect(items.find((item) => item.id === "S-21-0103")).toMatchObject({ group: "inspection", origin: "HUMAN", fromResearch: true });
    expect(items.filter((item) => item.fromResearch).map((item) => item.id)).toEqual(["S-21-0103"]);
  });

  it("counts the marks at the clock, says when, and keeps a rubric change out, which has no group in this build", async () => {
    const { get } = harness();
    const queue = CurationQueueSchema.parse(await (await get(CURATOR)).json());
    /* At 10 Oct 12:00: safety was due 9 Oct 12:00 and the old inspection 8 Oct 12:00, both past; structure is due 14 Oct 18:00 and the shared inspection 15 Oct 12:00, both in time. */
    expect(queue.marks).toEqual({ overdue: 2, dueSoon: 0, inSla: 2 });
    expect(queue.now).toBe(NOW.toISOString());
    expect(queue.groups.flatMap((group) => group.items.map((item) => item.id))).not.toContain("S-30-0001");
  });

  it("hands the filters to the door, and says what the caller decided since midnight", async () => {
    const { get, asked, since } = harness();
    const queue = CurationQueueSchema.parse(await (await get(CURATOR, "?part=P1&class=CURATOR_ALWAYS")).json());
    expect(asked).toEqual([{ part: "P1", changeClass: "CURATOR_ALWAYS" }]);
    expect(since).toEqual([new Date("2026-10-10T00:00:00.000Z")]);
    expect(queue.decidedToday).toEqual([{ id: "S-21-0007", action: "ACCEPT", decidedAt: "2026-10-10T09:30:00.000Z", seed: null }]);
    expect(queue.parts).toEqual(["P1", "P3"]);
  });

  it("refuses a class or a part the product has not, and an empty queue has no group", async () => {
    expect((await harness().get(CURATOR, "?class=SOMETHING")).status).toBe(400);
    expect((await harness().get(CURATOR, "?part=P9")).status).toBe(400);
    const empty = CurationQueueSchema.parse(await (await harness([]).get(CURATOR)).json());
    expect(empty.groups).toEqual([]);
    expect(empty.marks).toEqual({ overdue: 0, dueSoon: 0, inSla: 0 });
  });

  it("never carries a seed's flag (36 § 7.1): the answer is held to its strict schema", async () => {
    const text = await (await harness().get(CURATOR)).text();
    expect(text).not.toContain("seeded");
    expect(CurationQueueSchema.safeParse(JSON.parse(text)).success).toBe(true);
  });
});

describe("the queue's seeds and its monthly sample (36 § 7, § 11.7; unit 53e)", () => {
  /** A seed as the door shows it: the suggestion it is of, under its own id, in the queue with what stood, since the offer. */
  const seed = (id: string, offeredAt: string): QueueRow => row(id, { changeClass: "CITED_FIGURE", curatorReason: null, outcome: "REQUEST_MORE", parts: ["P1"], submittedAt: new Date(offeredAt), decidedAt: new Date(offeredAt), anchor: { suggestionId: id, kind: "SOURCE_ROW", sectionAnchor: "15.9", figureAnchor: null, sourceRowAnchor: "15.9 r2" }, graded: [{ tier: "C", adjustedScore: 56 }] });

  it("never offers a seed at share zero, whatever the queue: the seeds are not even asked for (A16)", async () => {
    for (const size of [0, 1, 2, 7, 40]) {
      const rows = Array.from({ length: size }, (_, index) => row(`S-35-${String(index + 1).padStart(4, "0")}`, {}));
      const queue = CurationQueueSchema.parse(await (await harness(rows).get(CURATOR)).json());
      expect(queue.groups.flatMap((group) => group.items).length, `a queue of ${String(size)}`).toBe(size);
    }
  });

  it("at a half, gives as many seeds as items, filed as ordinary items in their group by when they came, with no flag", async () => {
    const asked: number[] = [];
    const { get } = harness(ROWS, {
      seedShare: 0.5,
      seeds: async (_user, wanted) => {
        asked.push(wanted);
        return [seed("S-15-0412", "2026-10-09T08:00:00.000Z")];
      },
    });
    const text = await (await get(CURATOR)).text();
    const queue = CurationQueueSchema.parse(JSON.parse(text));
    /* five real items: the door may offer five, and offered one */
    expect(asked).toEqual([5]);
    expect(queue.groups.find((group) => group.group === "inspection")?.items.map((item) => [item.id, item.queuedAt])).toEqual([
      ["S-23-0412", "2026-10-01T12:00:00.000Z"],
      ["S-15-0377", "2026-10-08T12:00:00.000Z"],
      ["S-15-0412", "2026-10-09T08:00:00.000Z"],
    ]);
    expect(queue.groups.flatMap((group) => group.items).find((item) => item.id === "S-15-0412")).toMatchObject({ state: "CURATOR_QUEUE", outcome: "REQUEST_MORE", tier: "C", deadline: "2026-10-16T08:00:00.000Z", shared: false });
    expect(text).not.toMatch(/seeded|answer|matched/);
  });

  it("draws the month's sample per part from the merged suggestions whose strongest item was tier B, due by the month's end; none while unset", async () => {
    const merged = (id: string, parts: QueueRow["parts"], tier: "B" | "C"): QueueRow => row(id, { state: "MERGED", outcome: "ACCEPT", changeClass: "CITED_FIGURE", curatorReason: null, parts, graded: [{ tier, adjustedScore: 85 }] });
    const { get } = harness(ROWS, { samplePerMonth: 1, merged: async () => [merged("S-36-0198", ["P1"], "B"), merged("S-34-0117", ["P3"], "B"), merged("S-34-0118", ["P3"], "C")] });
    const queue = CurationQueueSchema.parse(await (await get(CURATOR)).json());
    const sampledGroup = queue.groups.find((group) => group.group === "sampled");
    /* one a part from P1 and P3, the caller's; the tier-C one is not of the sample */
    expect(sampledGroup?.deadlineHours).toBeNull();
    expect(sampledGroup?.items.map((item) => [item.id, item.state, item.queuedAt, item.deadline])).toEqual([
      ["S-34-0117", "MERGED", "2026-10-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z"],
      ["S-36-0198", "MERGED", "2026-10-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z"],
    ]);
    expect(queue.groups.map((group) => group.group).at(-1)).toBe("sampled");
  });

  it("reveals a seed under Decided today, under its own id, with the answer and whether it matched", async () => {
    const { get } = harness(ROWS, {
      decidedSince: async () => [
        { suggestionId: "S-37-0226", action: "DECLINE", createdAt: new Date("2026-10-10T09:12:00.000Z"), seed: { answer: "DECLINE", matched: true } },
        { suggestionId: "S-36-0201", action: "ACCEPT", createdAt: new Date("2026-10-10T09:40:00.000Z"), seed: { answer: "KEEP_REQUEST_MORE", matched: false } },
      ],
    });
    const queue = CurationQueueSchema.parse(await (await get(CURATOR)).json());
    expect(queue.decidedToday).toEqual([
      { id: "S-37-0226", action: "DECLINE", decidedAt: "2026-10-10T09:12:00.000Z", seed: { answer: "DECLINE", matched: true } },
      { id: "S-36-0201", action: "ACCEPT", decidedAt: "2026-10-10T09:40:00.000Z", seed: { answer: "KEEP_REQUEST_MORE", matched: false } },
    ]);
  });

  it("files what merges (37 § 6, unit 54b): a passed check ready to merge, anything else merging, each due seven days after its merge's last word; no merge begun reads as none", async () => {
    const accepted = (id: string, check: unknown, state: "MERGING" | "DECIDED" = "MERGING") => ({ ...row(id, { state, outcome: "ACCEPT", changeClass: "WORDING", curatorReason: null }), merge: check === undefined ? null : ({ suggestionId: id, branch: `improve/${id}-wording-35-2`, commitSha: null, versionFrom: "v1.0.0", versionTo: null, bump: "patch", check, mergedAt: null, releaseFrom: "2026.09", releaseTo: null, revertedBy: null } as never) });
    const checked = (verdict: "PASSED" | "NOT_RUN", at: string) => ({ stage: "CHECKED", at, hand: null, sha: "a".repeat(40), main: "b".repeat(40), lint: "PASS", lab: verdict === "PASSED" ? "PASS" : "NOT_RUN", verdict, failure: null, chapters: [], treeHash: "c".repeat(40), bump: "patch", labId: null, touchesLab: false, labRun: null, diff: { text: "", truncated: false }, suite: { reproduced: 0, total: 0, failing: [] } });
    const { get } = harness([], {
      merging: async () => [
        accepted("S-35-0010", checked("PASSED", "2026-10-09T08:00:00.000Z")),
        accepted("S-35-0011", { stage: "MANUAL", at: "2026-10-08T08:00:00.000Z", hand: { refusal: "manual", row: "35.2", detail: "a restructure is made by hand" }, missing: "COMMIT" }),
        accepted("S-35-0012", { stage: "UNAVAILABLE", at: "2026-10-09T09:00:00.000Z", reason: "BOOK_REPO_DIR is not set" }),
        accepted("S-35-0013", checked("NOT_RUN", "2026-10-09T10:00:00.000Z")),
        accepted("S-35-0014", undefined, "DECIDED"),
      ],
    });
    const queue = CurationQueueSchema.parse(await (await get(CURATOR)).json());
    expect(queue.groups.map((group) => [group.group, group.deadlineHours, group.items.map((item) => [item.id, item.merge, item.deadline])])).toEqual([
      ["ready", 168, [["S-35-0010", "READY", "2026-10-16T08:00:00.000Z"]]],
      [
        "merging",
        168,
        [
          ["S-35-0011", "MANUAL", "2026-10-15T08:00:00.000Z"],
          ["S-35-0014", "NONE", "2026-10-15T12:00:00.000Z"],
          ["S-35-0012", "UNAVAILABLE", "2026-10-16T09:00:00.000Z"],
          ["S-35-0013", "NOT_RUN", "2026-10-16T10:00:00.000Z"],
        ],
      ],
    ]);
  });
});

import { describe, expect, it } from "vitest";

import { handler, type HandlerDeps } from "@/lib/api/handler";
import type { SessionUser } from "@/lib/auth/session";
import type { AdjudicatorAcceptRow, CalibrationEventRow, RubricReviewRow } from "@/lib/db/improve";
import { CurationMetricsSchema } from "@/lib/schemas/curation";

import { curationEndpoints, type CurationEndpointDeps } from "./curation";

/*
 * The curator's calibration metrics (feature-specs/36 § 6.2, § 11.1; unit 53d), the rows and the pipeline doubled, at
 * a fixed clock: a curator's, at 60 a minute; this quarter and the three before it, newest first, each from its own
 * rows; the researcher's proposals apart; the reviews by quarter; the lines and the minimum; nobody named.
 */

const NOW = new Date("2026-10-10T12:00:00.000Z");
const CURATOR: SessionUser = { id: "33333333-3333-4333-8333-333333333333", organisationId: null, role: "CURATOR", displayName: "M. Tavares", locale: "en", identityVerified: true, parts: ["P1"], sessionId: "s1" };
const CONTRIBUTOR: SessionUser = { ...CURATOR, id: "11111111-1111-4111-8111-111111111111", role: "CONTRIBUTOR", parts: [] };

const event = (createdAt: string, adjudicatorDecision: CalibrationEventRow["adjudicatorDecision"], curatorAction: CalibrationEventRow["curatorAction"], criterion: string | null = null, origin: CalibrationEventRow["origin"] = "HUMAN"): CalibrationEventRow => ({ criterion, adjudicatorDecision, curatorAction, seeded: false, origin, createdAt: new Date(createdAt) });
const times = <T,>(n: number, make: () => T): T[] => Array.from({ length: n }, make);

/* This quarter: 25 reviewed, six overrides on independence (24 %), and three of the researcher's. Last quarter: four. */
const EVENTS: ReadonlyArray<CalibrationEventRow> = [
  ...times(6, () => event("2026-10-02T09:00:00.000Z", "REQUEST_MORE", "ACCEPT", "independence")),
  ...times(16, () => event("2026-10-03T09:00:00.000Z", "REQUEST_MORE", "KEEP_REQUEST_MORE")),
  ...times(3, () => event("2026-10-04T09:00:00.000Z", "ACCEPT", "ACCEPT", null, "RESEARCHER")),
  ...times(4, () => event("2026-08-14T09:00:00.000Z", "REQUEST_MORE", "ACCEPT", "recency")),
];
const ACCEPTS: ReadonlyArray<AdjudicatorAcceptRow> = [...times(19, () => ({ origin: "HUMAN" as const, decidedAt: new Date("2026-10-05T00:00:00.000Z"), reverted: false })), { origin: "HUMAN", decidedAt: new Date("2026-10-06T00:00:00.000Z"), reverted: true }];
const REVIEWS: ReadonlyArray<RubricReviewRow> = [{ id: "R-1.2-0001", criterion: "independence", quarter: "2026-Q4", rate: 0.24, overridden: 6, reviewed: 25, openedAt: new Date("2026-10-04T09:00:00.000Z") }];

function harness() {
  const asked: Array<{ readonly what: string; readonly from?: string; readonly to?: string; readonly quarters?: ReadonlyArray<string> }> = [];
  const deps: CurationEndpointDeps = {
    queue: async () => [],
    decidedSince: async () => [],
    now: () => NOW,
    read: async () => null,
    write: async () => ({ written: false }),
    withdraw: async () => false,
    signal: async () => undefined,
    recorded: async () => null,
    pause: async () => undefined,
    calibration: async (_user, from, to) => {
      asked.push({ what: "events", from: from.toISOString(), to: to.toISOString() });
      return EVENTS;
    },
    accepts: async (_user, from, to) => {
      asked.push({ what: "accepts", from: from.toISOString(), to: to.toISOString() });
      return ACCEPTS;
    },
    reviews: async (_user, quarters) => {
      asked.push({ what: "reviews", quarters });
      return REVIEWS;
    },
    seedShare: 0,
    samplePerMonth: null,
    seeds: async () => [],
    merged: async () => [],
    seed: async () => null,
    writeSeed: async () => ({ written: false }),
    merging: async () => [],
    recheck: async () => ({ started: false }),
    writeMerge: async () => ({ written: false }),
    signalMerge: async () => undefined,
    anchor: async () => null,
    writeRevert: async () => ({ written: false }),
    startRevert: async () => undefined,
    writeStands: async () => ({ written: false }),
  };
  const pipeline = (session: SessionUser | null): HandlerDeps => ({
    sessionFromRequest: async () => session,
    authorize: async () => ({ allow: true }),
    consume: async () => ({ allowed: true, limit: 60, remaining: 59, resetS: 1, retryAfterS: 0 }),
    idempotency: { begin: async () => ({ kind: "new" }), complete: async () => undefined, abandon: async () => undefined },
    audit: async () => undefined,
    log: () => undefined,
  });
  const { curationMetrics } = curationEndpoints(deps);
  const get = (session: SessionUser | null): Promise<Response> => handler(curationMetrics, pipeline(session))(new Request("http://localhost:3000/api/v1/curation/metrics"), { params: Promise.resolve({}) });
  return { get, asked };
}

describe("GET /api/v1/curation/metrics (36 § 6.2)", () => {
  it("is declared as § 6.2 says: a session, the curator's role, 60 a minute, the policy's read of the curation", () => {
    const { curationMetrics } = curationEndpoints();
    expect(curationMetrics).toMatchObject({ path: "/api/v1/curation/metrics", method: "GET", auth: "session", role: "CURATOR", rateLimit: { key: "user", limit: 60, windowS: 60 }, policy: { action: "read" } });
  });

  it("is refused to a contributor, and to nobody signed in", async () => {
    const { get } = harness();
    expect((await get(CONTRIBUTOR)).status).toBe(403);
    expect((await get(null)).status).toBe(401);
  });

  it("reads the year once, and gives this quarter and the three before it, newest first, each from its own rows", async () => {
    const { get, asked } = harness();
    const response = await get(CURATOR);
    expect(response.status).toBe(200);
    const metrics = CurationMetricsSchema.parse(await response.json());
    expect(asked).toEqual([
      { what: "events", from: "2026-01-01T00:00:00.000Z", to: "2027-01-01T00:00:00.000Z" },
      { what: "accepts", from: "2026-01-01T00:00:00.000Z", to: "2027-01-01T00:00:00.000Z" },
      { what: "reviews", quarters: ["2026-Q4", "2026-Q3", "2026-Q2", "2026-Q1"] },
    ]);
    expect(metrics.quarters.map((quarter) => [quarter.quarter, quarter.from, quarter.all.overrideRate.reviewed])).toEqual([
      ["2026-Q4", "2026-10-01T00:00:00.000Z", 25],
      ["2026-Q3", "2026-07-01T00:00:00.000Z", 4],
      ["2026-Q2", "2026-04-01T00:00:00.000Z", 0],
      ["2026-Q1", "2026-01-01T00:00:00.000Z", 0],
    ]);
    const [q4, q3] = metrics.quarters;
    expect(q4?.all.overrideRate.criteria.find((entry) => entry.criterion === "independence")).toEqual({ criterion: "independence", overridden: 6, rate: 0.24 });
    expect(q4?.all.kappa).toEqual({ pairs: 25, agreed: 19, value: expect.any(Number) });
    expect(q4?.all.precision).toEqual({ accepted: 20, reverted: 1, rate: 0.05 });
    expect(q4?.reviews).toEqual([{ id: "R-1.2-0001", criterion: "independence", rate: 0.24, overridden: 6, reviewed: 25, openedAt: "2026-10-04T09:00:00.000Z" }]);
    /* under twenty decisions: the counts and no rate */
    expect(q3?.all.overrideRate.criteria.find((entry) => entry.criterion === "recency")).toEqual({ criterion: "recency", overridden: 4, rate: null });
    expect(q3?.reviews).toEqual([]);
  });

  it("measures the researcher's proposals apart (spec 44), and gives the lines and the minimum the rail draws", async () => {
    const metrics = CurationMetricsSchema.parse(await (await harness().get(CURATOR)).json());
    expect(metrics.quarters[0]?.researcher.overrideRate.reviewed).toBe(3);
    expect(metrics.quarters[0]?.researcher.precision).toEqual({ accepted: 0, reverted: 0, rate: null });
    expect(metrics).toMatchObject({ now: NOW.toISOString(), minimum: 20, lines: { overrideTarget: 0.1, overrideReview: 0.2, kappaRetire: 0.6, kappaGate: 0.7, precisionTarget: 0.03 } });
  });

  it("names nobody: the answer is held to its strict schema", async () => {
    const text = await (await harness().get(CURATOR)).text();
    expect(CurationMetricsSchema.safeParse(JSON.parse(text)).success).toBe(true);
    expect(text).not.toMatch(/userId|curatorId|suggestionId|note/);
  });
});

import { beforeEach, describe, expect, it } from "vitest";

import { handler, type HandlerDeps } from "@/lib/api/handler";
import type { RubricVersionRow } from "@/lib/db/improve";
import type { LoadedRubric } from "@/lib/rubrics/load";
import { RubricSchema } from "@/lib/schemas/rubric";
import { RUBRIC_V1_2 } from "@/tests/fixtures/rubric";

import { rubricEndpoints, type RubricEndpointDeps } from "./rubric";

/*
 * The rubric's endpoints through the pipeline, with the rows and the files doubled (feature-specs/30 § 5.2,
 * § 10.6): the body is the file of the published row; nothing published, an unknown version and a version that
 * is not one are each refused in the API's error form; a row whose file is missing or has changed is a fault, not
 * a body.
 */

const FILE = {
  ...RUBRIC_V1_2,
  version: "v1.2",
  publishedAt: "2026-07-01",
  appliesAt: "2026-07-01",
  chips: { PRIMARY: "B", VENDOR: "C", ANALYST: "D", PRACTITIONER: "E", ILLUSTRATIVE: null, DERIVED: "A", OPEN: "U" },
  examples: [
    {
      id: "S-36-0198",
      section: "36.3",
      changeKind: "EDIT_ROW",
      changeClass: "CITED_FIGURE",
      fastMoving: true,
      items: [{ tier: "B", relevance: "direct", stake: "none", ageDays: 9, base: 85, factors: { relevance: 1, recency: 1, independence: 1 }, adjusted: 85 }],
      score: 85,
      strongestItem: 0,
      corroboratedBy: null,
      acceptAt: 70,
      floorAt: 25,
      route: "ADJUDICATE",
      decision: "ACCEPT",
    },
  ],
  changelog: [{ version: "v1.2", on: "2026-07-01" }],
};
const RUBRIC = RubricSchema.parse(FILE);
const SHA = "a".repeat(64);
const ROW: RubricVersionRow = { id: "v1.2", publishedAt: new Date("2026-07-01T00:00:00Z"), appliesAt: new Date("2026-07-01T00:00:00Z"), sha256: SHA };
const LOADED: LoadedRubric = { rubric: RUBRIC, sha256: SHA, text: JSON.stringify(FILE) };

const fake = { rows: [] as RubricVersionRow[], files: { "v1.2": LOADED } as Record<string, LoadedRubric | undefined>, asked: [] as string[] };

const deps: RubricEndpointDeps = {
  current: async (at) => fake.rows.filter((row) => row.appliesAt <= at).sort((a, b) => b.appliesAt.getTime() - a.appliesAt.getTime())[0] ?? null,
  read: async (id) => fake.rows.find((row) => row.id === id) ?? null,
  has: (version) => fake.files[version] !== undefined,
  load: (version) => {
    fake.asked.push(version);
    const loaded = fake.files[version];
    if (loaded === undefined) throw new Error("not here");
    return loaded;
  },
};

const pipeline: HandlerDeps = {
  sessionFromRequest: async () => null,
  authorize: async () => ({ allow: true }),
  consume: async () => ({ allowed: true, limit: 120, remaining: 119, resetS: 60, retryAfterS: 0 }),
  idempotency: { begin: async () => ({ kind: "new" }), complete: async () => undefined, abandon: async () => undefined },
  audit: async () => undefined,
  log: () => undefined,
};

const { rubricCurrent, rubricByVersion } = rubricEndpoints(deps);
const current = () => handler(rubricCurrent, pipeline)(new Request("http://localhost:3000/api/v1/rubric/current"), { params: {} });
const byVersion = (version: string) => handler(rubricByVersion, pipeline)(new Request(`http://localhost:3000/api/v1/rubric/${version}`), { params: { version } });

beforeEach(() => {
  fake.rows = [ROW];
  fake.files = { "v1.2": LOADED };
  fake.asked = [];
});

describe("GET /api/v1/rubric/current", () => {
  it("is the file of the version in force, with the public cache rule and the public rate", async () => {
    const response = await current();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(FILE);
    expect(response.headers.get("cache-control")).toBe("private, max-age=0, must-revalidate");
    expect(response.headers.get("RateLimit-Limit")).toBe("120");
    expect(fake.asked).toEqual(["v1.2"]);
  });

  it("is the latest version that applies by today, not one that applies later", async () => {
    const later: RubricVersionRow = { ...ROW, id: "v1.3", appliesAt: new Date("2999-01-01T00:00:00Z") };
    fake.rows = [ROW, later];
    fake.files["v1.3"] = { ...LOADED, rubric: RubricSchema.parse({ ...FILE, version: "v1.3", appliesAt: "2999-01-01", changelog: [...FILE.changelog, { version: "v1.3", on: "2999-01-01" }] }) };
    expect(await (await current()).json()).toMatchObject({ version: "v1.2" });
  });

  it("is 404 when nothing is published", async () => {
    fake.rows = [];
    const response = await current();
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("GET /api/v1/rubric/{version}", () => {
  it("is the file of that published version", async () => {
    const response = await byVersion("v1.2");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(FILE);
  });

  it("is 404 for a version that is not published, in the API's error form", async () => {
    const response = await byVersion("v9.9");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "NOT_FOUND" });
    expect(fake.asked).toEqual([]);
  });

  it("is 400 for something that is not a version", async () => {
    for (const version of ["1.2", "v1", "latest", "v1.2.3"]) {
      const response = await byVersion(version);
      expect(response.status, version).toBe(400);
      expect(await response.json(), version).toMatchObject({ code: "INVALID_INPUT" });
    }
  });

  it("is a fault, not a body, when the published row's file is missing or has changed", async () => {
    fake.files = {};
    expect((await byVersion("v1.2")).status).toBe(500);
    fake.files = { "v1.2": { ...LOADED, sha256: "b".repeat(64) } };
    const changed = await byVersion("v1.2");
    expect(changed.status).toBe(500);
    expect(await changed.json()).toMatchObject({ code: "INTERNAL" });
  });
});

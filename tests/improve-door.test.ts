import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, expectTypeOf, it } from "vitest";

import { callerOf, IMPROVE_SERVICES, SELECTED, type SuggestionForService, type SuggestionForUser } from "@/lib/db/improve";

/*
 * The improvement rows have one door (feature-specs/29 § 2, § 10.2, § 10.9; tracker unit 46b). They are outside the
 * tenant filter, so nothing injects a condition into a query on them: lib/db/improve.ts is where every condition
 * is written, and that only holds while it is the one module that names them. This reads the repository for any
 * other, and holds the door's two projections to what a service may be handed. What the door does with a
 * database is tests/integration/improve.test.ts.
 */

const root = join(import.meta.dirname, "..");
const DOOR = "lib/db/improve.ts";
const read = (...path: string[]): string => readFileSync(join(root, ...path), "utf8").replace(/\r\n/g, "\n");

/** The models of the schema's improvement block, so that a table added to it later is held to the rule without being listed here. */
const schema = read("prisma", "schema.prisma");
const improvementBlock = schema.slice(schema.indexOf("// ---------- improvement"));
const nextMarker = improvementBlock.indexOf("// ----------", 1);
const models = [...(nextMarker === -1 ? improvementBlock : improvementBlock.slice(0, nextMarker)).matchAll(/^model (\w+) \{$/gm)].map((match) => match[1] ?? "");
const delegates = models.map((model) => model.charAt(0).toLowerCase() + model.slice(1));

/** `prisma.suggestion.findMany`, `tx.evidenceItem.create`, …: a query through the client. */
const BY_CLIENT = new RegExp(`\\.(${delegates.join("|")})\\.(find|create|update|upsert|delete|count|aggregate|groupBy)`);
/** `FROM "Suggestion"`, `UPDATE "EvidenceItem"`, …: a query in SQL, which the client's types would not show. */
const BY_SQL = new RegExp(`\\b(FROM|JOIN|INTO|UPDATE|TABLE|ON)\\s+\\\\?"(${models.join("|")})\\\\?"`);

/** Every source file a query could be written in, as a path from the repository's root. Tests are not source: the door's own suites name these tables. */
function sources(directory: string): ReadonlyArray<string> {
  return readdirSync(join(root, directory)).flatMap((name) => {
    const path = `${directory}/${name}`;
    if (name === "node_modules" || name === ".next" || path === "lib/db/generated" || path === "prisma/migrations") return [];
    if (statSync(join(root, path)).isDirectory()) return sources(path);
    return /\.(ts|tsx|mts|sql)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) ? [path] : [];
  });
}

const files = ["app", "components", "lib", "workers", "pipeline", "scripts", "prisma", "infra"].flatMap(sources);
const naming = (pattern: RegExp): ReadonlyArray<string> => files.filter((path) => pattern.test(read(...path.split("/"))));

describe("the one door to the improvement rows", () => {
  it("covers the sixteen tables of the schema's improvement block: 46a's fourteen, the rubric review (unit 53d) and the seed (unit 53e)", () => {
    expect(models).toHaveLength(16);
    expect(delegates).toContain("rubricReview");
    expect(delegates).toContain("curationSeed");
    expect(delegates).toContain("suggestion");
    expect(delegates).toContain("evidenceItem");
    expect(delegates).toContain("curatorRoster");
  });

  it("is the only module that queries them through the client", () => {
    expect(files.length).toBeGreaterThan(200);
    expect(naming(BY_CLIENT)).toEqual([DOOR]);
  });

  it("and no module queries them in SQL", () => {
    expect(naming(BY_SQL)).toEqual([]);
  });

  it("would be seen through: the patterns find a query written either way", () => {
    for (const line of ["await getPrisma().suggestion.findMany({})", "return tx.evidenceItem.create({ data })", "client.curatorRoster.count()", "db.suggestionCounter.upsert(args)"]) expect(BY_CLIENT.test(line), line).toBe(true);
    for (const line of ['SELECT "id" FROM "Suggestion" WHERE "state" = $1', 'UPDATE "EvidenceItem" SET "tier" = $1', 'JOIN \\"Anchor\\" a ON a."suggestionId" = s."id"', 'GRANT SELECT ON "Adjudication" TO hb_metrics']) expect(BY_SQL.test(line), line).toBe(true);
    for (const line of ["const anchor = section.anchor.startsWith(prefix)", "items.merge.length", 'import type { Suggestion } from "@/lib/db/generated/client"', "suggestion.evidence.find((item) => item.ordinal === 1)"]) {
      expect(BY_CLIENT.test(line) || BY_SQL.test(line), line).toBe(false);
    }
  });

  it("is held in CI by the same search", () => {
    const ci = read(".github", "workflows", "ci.yml");
    const step = ci.slice(ci.indexOf("The improvement rows have one door"));
    expect(step.length).toBeGreaterThan(0);
    for (const delegate of delegates) expect(step.slice(0, step.indexOf("\n      - name:")), delegate).toContain(delegate);
    expect(step).toContain(DOOR);
  });
});

/** What a service is handed: the suggestion's own columns and the five kinds of row under it. A person is handed `ownedSuggestion` in place of the first. */
const { ownedSuggestion, ...forService } = SELECTED;
const columnsOf = (selects: Readonly<Record<string, object>>): ReadonlyArray<string> => Object.values(selects).flatMap((select) => Object.keys(select));

describe("what the door hands out (feature-specs/29 § 4.1; architecture § 11, invariant 12)", () => {
  /* Anything that says who a person is, or what a curator wrote: none of it is an agent's to read. */
  const PERSONAL = ["user", "userId", "curator", "curatorId", "curatorActions", "note", "mergedBy", "mergedById", "requestedBy", "requestedById", "email", "displayName", "organisationId", "organisation"];

  it("selects for a service no column that names a person, no curator's action, and no relation to follow to one", () => {
    expect(Object.keys(forService)).toEqual(["suggestion", "anchor", "evidence", "sensorVerdict", "adjudication", "criterion", "merge"]);
    const selected = columnsOf(forService);
    expect(selected.length).toBeGreaterThan(60);
    for (const key of PERSONAL) expect(selected, key).not.toContain(key);
    /* Every selected member is a column switched on: nothing is a nested select, so nothing reaches another table. */
    for (const select of Object.values(SELECTED)) for (const [column, on] of Object.entries(select)) expect(on, column).toBe(true);
  });

  it("selects for a person the same, whose suggestion it is and whether it was drafted from a finding, and nothing else of a person", () => {
    /* `fromResearch` (feature-specs/48 § 8.6; unit 74): a person's to see, never a service's — the adjudicator is not told */
    expect(Object.keys(ownedSuggestion).filter((key) => !(key in SELECTED.suggestion))).toEqual(["userId", "fromResearch"]);
    expect(Object.keys(ownedSuggestion).filter((key) => PERSONAL.includes(key))).toEqual(["userId"]);
  });

  it("says so in its types, which the compiler checks", () => {
    expectTypeOf<SuggestionForService>().not.toHaveProperty("userId");
    expectTypeOf<SuggestionForService>().not.toHaveProperty("user");
    expectTypeOf<SuggestionForService>().not.toHaveProperty("curatorActions");
    expectTypeOf<SuggestionForService>().not.toHaveProperty("fromResearch");
    expectTypeOf<SuggestionForUser>().toHaveProperty("userId").toEqualTypeOf<string | null>();
    expectTypeOf<SuggestionForUser>().not.toHaveProperty("user");
  });

  it("makes a caller of a session: the person, their role and the roster's parts, and nothing else of them", () => {
    const session = { id: "00000000-0000-4000-8000-0000000046d1", organisationId: "org-a", role: "CURATOR" as const, displayName: "Ana Curator", locale: "pt-BR", identityVerified: true, parts: ["P1", "P3"] as const, sessionId: "s" };
    expect(callerOf(session)).toEqual({ kind: "user", userId: session.id, role: "CURATOR", parts: ["P1", "P3"] });
    expect(JSON.stringify(callerOf(session))).not.toContain("Ana");
  });

  it("knows five services, the ones the policy and the ledger name", () => {
    expect([...IMPROVE_SERVICES]).toEqual(["service:intake", "service:grader", "service:adjudicator", "service:researcher", "service:merge"]);
  });
});

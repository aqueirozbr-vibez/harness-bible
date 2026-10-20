import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * The improvement schema as files (feature-specs/29 § 3, § 10.1; tracker unit 46a): what the migration may do, that
 * it creates what the schema declares, how its rows are tied to a suggestion and to a person, and whose rows they
 * are. These read the repository; that the database enforces the checks and the trigger is
 * tests/integration/improve-schema.test.ts.
 */

const root = join(import.meta.dirname, "..");
/* Line endings as `\n` whatever the checkout wrote: the patterns below are written against them. */
const read = (...path: string[]): string => readFileSync(join(root, ...path), "utf8").replace(/\r\n/g, "\n");

const MIGRATION = "20261005120000_improvement";
const schema = read("prisma", "schema.prisma");
const migration = read("prisma", "migrations", MIGRATION, "migration.sql");

/** The schema from the improvement block's heading to the end of the file: the block is the last. */
/* the improvement block: from its marker to the next one (the research block follows it since unit 57) */
const fromMarker = schema.slice(schema.indexOf("// ---------- improvement"));
const nextMarker = fromMarker.indexOf("// ----------", 1);
const block = nextMarker === -1 ? fromMarker : fromMarker.slice(0, nextMarker);
const declared = (keyword: "enum" | "model"): ReadonlyArray<string> => [...block.matchAll(new RegExp(`^${keyword} (\\w+) \\{$`, "gm"))].map((match) => match[1] ?? "");

const ENUMS = ["SuggestionOrigin", "AnchorKind", "ChangeKind", "ChangeClass", "CuratorReason", "EvidenceKind", "EvidenceTier", "EvidenceState", "Decision", "SuggestionState", "SuggestionSensor", "SensorResult", "CuratorActionKind"];
const MODELS = ["Suggestion", "Anchor", "EvidenceItem", "SuggestionSensorVerdict", "Adjudication", "CriterionVerdict", "CuratorAction", "CalibrationEvent", "RubricVersion", "Threshold", "CuratorRoster", "SuggestionCounter", "Merge", "AuditExport"];
/** The block's models since unit 46a's migration, each in a migration of its own, declared after the calibration event: the rubric review (36 § 6.3; unit 53d) and the seed (36 § 7.1; unit 53e). */
const LATER = "20261008130000_rubric_review";
const SEEDS = "20261009120000_curation_seed";
const DECLARED = [...MODELS.slice(0, MODELS.indexOf("CalibrationEvent") + 1), "RubricReview", "CurationSeed", ...MODELS.slice(MODELS.indexOf("CalibrationEvent") + 1)];

/** The migration's statements, without comments, the trigger function's body taken as one piece. */
const statements = migration
  .replace(/\$\$[\s\S]*?\$\$/g, "$$body$$")
  .split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n")
  .split(";")
  .map((statement) => statement.replace(/\s+/g, " ").trim())
  .filter((statement) => statement !== "");

const foreignKeys = statements.flatMap((statement) => {
  const match = /^ALTER TABLE "(\w+)" ADD CONSTRAINT "(\w+)" FOREIGN KEY \("(\w+)"\) REFERENCES "(\w+)"\("\w+"\) ON DELETE (CASCADE|SET NULL|RESTRICT) ON UPDATE CASCADE$/.exec(statement);
  return match === null ? [] : [{ table: match[1] ?? "", column: match[3] ?? "", references: match[4] ?? "", onDelete: match[5] ?? "" }];
});

describe("the improvement block of the schema", () => {
  it("declares the thirteen enums and the fourteen models of feature-specs/29 § 3, with the rubric review of 36 § 6.3 (unit 53d), in a block of its own", () => {
    expect(block.length).toBeGreaterThan(0);
    expect(declared("enum")).toEqual(ENUMS);
    expect(declared("model")).toEqual(DECLARED);
  });

  it("spells each enum as the spec does", () => {
    const members = (name: string): ReadonlyArray<string> =>
      (new RegExp(`^enum ${name} \\{\\n([^}]*)\\}`, "m").exec(schema)?.[1] ?? "")
        .split("\n")
        .map((line) => line.replace(/\/\/.*$/, "").trim())
        .filter((line) => line !== "");
    /* CURATOR since unit 54e: a revert (feature-specs/37 § 8, § 21) */
    expect(members("SuggestionOrigin")).toEqual(["HUMAN", "RESEARCHER", "CURATOR"]);
    expect(members("AnchorKind")).toEqual(["SECTION", "FIGURE", "SOURCE_ROW"]);
    expect(members("ChangeKind")).toEqual(["EDIT_TEXT", "SET_VALUE", "EDIT_ROW", "ADD_CLAIM", "ADD_ROW", "RESTRUCTURE"]);
    expect(members("ChangeClass")).toEqual(["WORDING", "CITED_FIGURE", "DERIVED_FIGURE", "NEW_CLAIM", "CURATOR_ALWAYS"]);
    expect(members("CuratorReason")).toEqual(["SAFETY_OT", "SCENARIO_PARAMETER", "STRUCTURE", "NEW_SOURCE_TIER", "RUBRIC"]);
    expect(members("EvidenceKind")).toEqual(["LINK", "DOI", "UPLOAD", "LAB_RUN"]);
    expect(members("EvidenceTier")).toEqual(["A", "B", "C", "D", "E", "F", "G", "U"]);
    expect(members("EvidenceState")).toEqual(["PENDING", "GRADED"]);
    expect(members("Decision")).toEqual(["ACCEPT", "REQUEST_MORE", "DECLINE", "CURATOR_REVIEW"]);
    expect(members("SuggestionState")).toEqual(["DRAFT", "SUBMITTED", "INTAKE_DECLINED", "GRADED", "SENSED", "DECIDED", "CURATOR_QUEUE", "MERGING", "MERGED", "CLOSED"]);
    expect(members("SuggestionSensor")).toEqual(["SCHEMA", "ANCHOR_EXISTS", "EVIDENCE_PARSES", "RATIONALE_LENGTH", "DERIVE_CONSISTENCY", "CROSS_CHAPTER", "LINT"]);
    expect(members("SensorResult")).toEqual(["PASS", "FAIL", "WARN", "NA"]);
    expect(members("CuratorActionKind")).toEqual(["ACCEPT", "KEEP_REQUEST_MORE", "DECLINE", "MERGE", "REVERT"]);
    /* RETRACTED since unit 63b: a contributor's withdrawal (feature-specs/45 § 5); ERASED since unit 62b: a reader's deletion of a conversation (45 § 3.7) */
    expect(members("LedgerKind").slice(-4)).toEqual(["RESEARCH", "ENDORSED", "RETRACTED", "ERASED"]);
  });
});

describe("the improvement migration (architecture § 11, invariant 30)", () => {
  it("only adds: every statement creates a type, a table, an index, a function or a trigger, adds a value to an enum, or adds a constraint", () => {
    const additive = [
      /^CREATE TYPE "\w+" AS ENUM \(/,
      /^CREATE TABLE "\w+" \(/,
      /^CREATE (UNIQUE )?INDEX "\w+" ON "\w+"\(/,
      /^CREATE FUNCTION \w+\(\) RETURNS trigger /,
      /^CREATE TRIGGER \w+ BEFORE DELETE ON "\w+" /,
      /^ALTER TYPE "\w+" ADD VALUE '\w+'$/,
      /^ALTER TABLE "\w+" ADD CONSTRAINT "\w+" /,
    ];
    expect(statements.length).toBeGreaterThan(60);
    for (const statement of statements) expect(additive.some((pattern) => pattern.test(statement)), statement.slice(0, 90)).toBe(true);
    /* An `ALTER TABLE` here adds constraints and does nothing else to the table. */
    for (const statement of statements.filter((each) => each.startsWith("ALTER TABLE"))) {
      expect(statement, statement.slice(0, 90)).not.toMatch(/\b(DROP|RENAME|ALTER COLUMN|ADD COLUMN|SET NOT NULL)\b/);
    }
  });

  it("alters no table that existed before it", () => {
    const altered = new Set(statements.flatMap((statement) => /^ALTER TABLE "(\w+)"/.exec(statement)?.[1] ?? []));
    for (const table of altered) expect(MODELS, table).toContain(table);
  });

  it("creates exactly the enums and the tables the schema declares", () => {
    expect(statements.flatMap((statement) => /^CREATE TYPE "(\w+)"/.exec(statement)?.[1] ?? [])).toEqual(ENUMS);
    expect(statements.flatMap((statement) => /^CREATE TABLE "(\w+)"/.exec(statement)?.[1] ?? [])).toEqual(MODELS);
  });

  it("adds the rubric review in a migration of its own that only adds: one table, its two indexes and its key to the rubric version, kept as everything decided under one is (unit 53d)", () => {
    const later = read("prisma", "migrations", LATER, "migration.sql")
      .split("\n")
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n")
      .split(";")
      .map((statement) => statement.replace(/\s+/g, " ").trim())
      .filter((statement) => statement !== "");
    expect(later.map((statement) => statement.split(" (")[0])).toEqual([
      'CREATE TABLE "RubricReview"',
      'CREATE INDEX "RubricReview_quarter_idx" ON "RubricReview"("quarter")',
      'CREATE UNIQUE INDEX "RubricReview_criterion_quarter_key" ON "RubricReview"("criterion", "quarter")',
      'ALTER TABLE "RubricReview" ADD CONSTRAINT "RubricReview_rubricVersionId_fkey" FOREIGN KEY',
    ]);
    expect(later.at(-1)).toMatch(/REFERENCES "RubricVersion"\("id"\) ON DELETE RESTRICT ON UPDATE CASCADE$/);
  });

  it("adds the seed in a migration of its own that only adds: one table, its three indexes and its two keys, each going with what it is of (unit 53e)", () => {
    const seeds = read("prisma", "migrations", SEEDS, "migration.sql")
      .split("\n")
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n")
      .split(";")
      .map((statement) => statement.replace(/\s+/g, " ").trim())
      .filter((statement) => statement !== "");
    expect(seeds.map((statement) => statement.split(" (")[0])).toEqual([
      'CREATE TABLE "CurationSeed"',
      'CREATE UNIQUE INDEX "CurationSeed_actionId_key" ON "CurationSeed"("actionId")',
      'CREATE INDEX "CurationSeed_curatorId_actionId_idx" ON "CurationSeed"("curatorId", "actionId")',
      'CREATE UNIQUE INDEX "CurationSeed_curatorId_suggestionId_key" ON "CurationSeed"("curatorId", "suggestionId")',
      'ALTER TABLE "CurationSeed" ADD CONSTRAINT "CurationSeed_suggestionId_fkey" FOREIGN KEY',
      'ALTER TABLE "CurationSeed" ADD CONSTRAINT "CurationSeed_curatorId_fkey" FOREIGN KEY',
    ]);
    expect(seeds.slice(-2).map((statement) => /REFERENCES "(\w+)"\("id"\) ON DELETE (\w+)/.exec(statement)?.slice(1).join(" "))).toEqual(["Suggestion CASCADE", "User CASCADE"]);
  });

  it("gives the ledger its two new kinds, and uses neither", () => {
    expect(statements.filter((statement) => statement.startsWith("ALTER TYPE"))).toEqual([`ALTER TYPE "LedgerKind" ADD VALUE 'RESEARCH'`, `ALTER TYPE "LedgerKind" ADD VALUE 'ENDORSED'`]);
    expect(statements.filter((statement) => /INSERT|'RESEARCH'|'ENDORSED'/.test(statement) && !statement.startsWith("ALTER TYPE"))).toEqual([]);
  });

  it("ties every child to its suggestion by a cascade, so one refusal at the suggestion covers them all", () => {
    const children = foreignKeys.filter((key) => key.references === "Suggestion");
    expect(children.map((key) => key.table).sort()).toEqual(["Adjudication", "Anchor", "CalibrationEvent", "CriterionVerdict", "CuratorAction", "EvidenceItem", "Merge", "SuggestionSensorVerdict"]);
    for (const key of children) expect(key.onDelete, key.table).toBe("CASCADE");
    expect(statements.filter((statement) => statement.startsWith("CREATE TRIGGER"))).toEqual([`CREATE TRIGGER suggestion_kept BEFORE DELETE ON "Suggestion" FOR EACH ROW EXECUTE FUNCTION suggestion_kept()`]);
    expect(migration).toContain(`IF OLD."state" <> 'DRAFT' THEN`);
  });

  it("lets an account be deleted: the rows that name the person keep their record without the person, and the roster rows go", () => {
    const people = foreignKeys.filter((key) => key.references === "User").map((key) => `${key.table}.${key.column} ${key.onDelete}`);
    expect(people.sort()).toEqual(["AuditExport.requestedById SET NULL", "CuratorAction.curatorId SET NULL", "CuratorRoster.userId CASCADE", "Merge.mergedById SET NULL", "Suggestion.userId SET NULL"]);
  });

  it("keeps a rubric version that anything was decided under", () => {
    const rubric = foreignKeys.filter((key) => key.references === "RubricVersion");
    expect(rubric.map((key) => key.table).sort()).toEqual(["Adjudication", "CalibrationEvent", "Suggestion", "Threshold"]);
    for (const key of rubric) expect(key.onDelete, key.table).toBe("RESTRICT");
  });

  it("has no foreign key to a content table: a content row belongs to one release", () => {
    expect([...new Set(foreignKeys.map((key) => key.references))].sort()).toEqual(["RubricVersion", "Suggestion", "User"]);
    expect(foreignKeys).toHaveLength(17);
  });
});

describe("whose rows these are (feature-specs/29 § 2, D1)", () => {
  const guard = read("lib", "db", "client.ts");

  it("are the platform's: the tenant guard filters none of them, as it filters none of the ledger's", () => {
    const lists = ["TENANT_MODELS", "PRINCIPAL_MODELS", "SYSTEM_MODELS", "CONTENT_MODELS"].map((name) => {
      const start = guard.indexOf(`const ${name}`);
      expect(start, name).toBeGreaterThan(-1);
      return guard.slice(start, guard.indexOf(");", start));
    });
    for (const model of DECLARED) for (const list of lists) expect(list, model).not.toContain(`"${model}"`);
  });

  it("are in the register of raw SQL with their migration, whose checks and trigger are written by hand", () => {
    const register = read("lib", "db", "RAW_SQL.md");
    expect(register).toContain(`prisma/migrations/${MIGRATION}`);
    expect(register).toContain("tests/integration/improve-schema.test.ts");
  });
});

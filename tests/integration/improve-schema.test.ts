import { describe, expect, it } from "vitest";

import { getPrisma } from "@/lib/db/client";
import { env } from "@/lib/env";

/*
 * The improvement schema at the database (feature-specs/29 § 3, § 10.1; tracker unit 46a): the checks and the
 * trigger the migration wrote by hand, the cascades, and what an account's deletion does to the rows that name it.
 * These are things the database itself must refuse whatever the client code does, so they are asked of the
 * database, in SQL (lib/db/RAW_SQL.md), and not through lib/db/improve.ts, which has tests of its own.
 *
 * Every case runs inside one transaction that is always rolled back, so the suite leaves no row and cannot meet a
 * real one: its ids are a rubric version nothing publishes (`v0.0`), a fifth-digit serial no counter has reached
 * (`S-15-90377`, the spec's S-15-0377 with a 9 before it), and a person of its own.
 */

const hasDatabase = env.DATABASE_URL !== undefined;

class Rollback extends Error {}

interface Sql {
  /** Run one statement; the number of rows it touched. */
  run(statement: string): Promise<number>;
  rows<Row>(statement: string): Promise<ReadonlyArray<Row>>;
}

/** Run `body` in a transaction that is rolled back whatever happens, and hand back what it returned. */
async function rolledBack<T>(body: (sql: Sql) => Promise<T>): Promise<T> {
  const held: { value?: T } = {};
  try {
    await getPrisma().$transaction(async (tx) => {
      held.value = await body({ run: (statement) => tx.$executeRawUnsafe(statement), rows: (statement) => tx.$queryRawUnsafe(statement) });
      throw new Rollback();
    });
  } catch (error: unknown) {
    if (!(error instanceof Rollback)) throw error;
  }
  return held.value as T;
}

/** What the database said to `statement` after `setup`: its refusal, or null when it took it. A refusal ends the transaction, which is rolled back anyway. */
function refusal(setup: ReadonlyArray<string>, statement: string): Promise<string | null> {
  return rolledBack(async (sql) => {
    for (const each of setup) await sql.run(each);
    try {
      await sql.run(statement);
      return null;
    } catch (error: unknown) {
      return error instanceof Error ? error.message : String(error);
    }
  });
}

const SHA = "a".repeat(64);
const ID = "S-15-90377";
const PERSON = "00000000-0000-4000-8000-00000000046a";

const RUBRIC = `INSERT INTO "RubricVersion" ("id", "publishedAt", "appliesAt", "sha256", "tiers", "adjustments", "examples") VALUES ('v0.0', now(), now(), '${SHA}', '{}', '{}', '{}')`;
const PERSON_ROW = `INSERT INTO "User" ("id", "email", "displayName") VALUES ('${PERSON}', 'improve-schema@harness-bible.local', 'Improve schema suite')`;

interface SuggestionColumns {
  readonly id: string;
  readonly origin: string;
  readonly userId: string;
  readonly chapterNumber: number;
  readonly parts: string;
  readonly changeClass: string;
  readonly curatorReason: string;
  readonly proposal: string;
  readonly proposalKey: string;
  readonly state: string;
}

/** A suggestion as SQL: a person's draft on chapter 15, part P1, with no proposal yet, unless `over` says otherwise. Values are SQL text. */
function suggestion(over: Partial<SuggestionColumns> = {}): string {
  const c: SuggestionColumns = { id: `'${ID}'`, origin: `'HUMAN'`, userId: "NULL", chapterNumber: 15, parts: `ARRAY['P1']::"Part"[]`, changeClass: `'WORDING'`, curatorReason: "NULL", proposal: "NULL", proposalKey: "NULL", state: `'DRAFT'`, ...over };
  return `INSERT INTO "Suggestion" ("id", "origin", "userId", "chapterNumber", "chapterVersionId", "releaseId", "parts", "changeKind", "changeClass", "curatorReason", "proposal", "proposalKey", "locale", "state", "rubricVersionId")
    VALUES (${c.id}, ${c.origin}, ${c.userId}, ${String(c.chapterNumber)}, 'chapter-version-of-the-suite', '2026.09', ${c.parts}, 'EDIT_TEXT', ${c.changeClass}, ${c.curatorReason}, ${c.proposal}, ${c.proposalKey}, 'EN', ${c.state}, 'v0.0')`;
}

const anchor = (kind: string, figure: string, row: string, sha = `'${SHA}'`): string =>
  `INSERT INTO "Anchor" ("suggestionId", "kind", "sectionAnchor", "figureAnchor", "sourceRowAnchor", "currentText", "contentSha256", "existsAtVersion") VALUES ('${ID}', '${kind}', '21.3', ${figure}, ${row}, 'the text as it read', ${sha}, true)`;
const evidence = (ordinal: number, sha = "NULL"): string =>
  `INSERT INTO "EvidenceItem" ("id", "suggestionId", "ordinal", "kind", "contentSha256") VALUES (gen_random_uuid(), '${ID}', ${String(ordinal)}, 'LINK', ${sha})`;
const sensor = (name: string): string =>
  `INSERT INTO "SuggestionSensorVerdict" ("id", "suggestionId", "sensor", "result", "detail", "data") VALUES (gen_random_uuid(), '${ID}', '${name}', 'PASS', 'passes', '{}')`;
const adjudication = (guide = "NULL", prompt = "NULL"): string =>
  `INSERT INTO "Adjudication" ("suggestionId", "decision", "decidedBy", "score", "guideSha256", "promptSha256", "rubricVersionId", "decidedAt", "traceId") VALUES ('${ID}', 'DECLINE', 'intake-rules', 0, ${guide}, ${prompt}, 'v0.0', now(), '${"c".repeat(32)}')`;
const curatorAction = (note: string, curator = "NULL"): string =>
  `INSERT INTO "CuratorAction" ("id", "suggestionId", "curatorId", "action", "note", "queueWaitMs") VALUES (gen_random_uuid(), '${ID}', ${curator}, 'DECLINE', ${note}, 0)`;
const roster = (until: string): string =>
  `INSERT INTO "CuratorRoster" ("id", "userId", "part", "since", "until") VALUES (gen_random_uuid(), '${PERSON}', 'P3', '2026-10-05T12:00:00Z', ${until})`;

const count = async (sql: Sql, table: string, where: string): Promise<number> => Number((await sql.rows<{ n: bigint }>(`SELECT count(*) AS n FROM "${table}" WHERE ${where}`))[0]?.n ?? -1);

describe.skipIf(!hasDatabase)("the improvement schema at the database", () => {
  it("has the fourteen tables and, since units 53d and 53e, the rubric review's and the seed's, and the ledger its two new kinds at the end, and since unit 63b a withdrawal's", async () => {
    const found = await rolledBack(async (sql) => ({
      tables: (await sql.rows<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`)).map((row) => row.table_name),
      kinds: (await sql.rows<{ kind: string }>(`SELECT unnest(enum_range(NULL::"LedgerKind"))::text AS kind`)).map((row) => row.kind),
    }));
    for (const table of ["Suggestion", "Anchor", "EvidenceItem", "SuggestionSensorVerdict", "Adjudication", "CriterionVerdict", "CuratorAction", "CalibrationEvent", "RubricReview", "CurationSeed", "RubricVersion", "Threshold", "CuratorRoster", "SuggestionCounter", "Merge", "AuditExport"]) {
      expect(found.tables, table).toContain(table);
    }
    expect(found.kinds).toEqual(["SUBMITTED", "GRADED", "SENSORS", "DECIDED", "CURATOR", "MERGED", "ANSWER", "EXPORT", "RESEARCH", "ENDORSED", "RETRACTED", "ERASED"]);
  });

  it("starts a suggestion as a draft, an evidence item as pending and a curator's action as not seeded", async () => {
    const defaults = await rolledBack(async (sql) => {
      await sql.run(RUBRIC);
      await sql.run(`INSERT INTO "Suggestion" ("id", "origin", "chapterNumber", "chapterVersionId", "releaseId", "parts", "changeKind", "changeClass", "locale", "rubricVersionId") VALUES ('${ID}', 'HUMAN', 15, 'chapter-version-of-the-suite', '2026.09', ARRAY['P1']::"Part"[], 'EDIT_TEXT', 'WORDING', 'EN', 'v0.0')`);
      await sql.run(evidence(1));
      await sql.run(curatorAction("NULL"));
      return {
        state: (await sql.rows<{ state: string }>(`SELECT "state"::text AS state FROM "Suggestion" WHERE "id" = '${ID}'`))[0]?.state,
        item: (await sql.rows<{ state: string; fetchStatus: string | null }>(`SELECT "state"::text AS state, "fetchStatus" FROM "EvidenceItem" WHERE "suggestionId" = '${ID}'`))[0],
        seeded: (await sql.rows<{ seeded: boolean }>(`SELECT "seeded" FROM "CuratorAction" WHERE "suggestionId" = '${ID}'`))[0]?.seeded,
      };
    });
    expect(defaults.state).toBe("DRAFT");
    expect(defaults.item).toEqual({ state: "PENDING", fetchStatus: null });
    expect(defaults.seeded).toBe(false);
  });

  it("deletes a draft with everything it has", async () => {
    const left = await rolledBack(async (sql) => {
      await sql.run(RUBRIC);
      await sql.run(suggestion());
      await sql.run(anchor("SECTION", "NULL", "NULL"));
      await sql.run(evidence(1));
      await sql.run(evidence(2));
      await sql.run(sensor("SCHEMA"));
      const deleted = await sql.run(`DELETE FROM "Suggestion" WHERE "id" = '${ID}'`);
      return { deleted, anchors: await count(sql, "Anchor", `"suggestionId" = '${ID}'`), items: await count(sql, "EvidenceItem", `"suggestionId" = '${ID}'`), verdicts: await count(sql, "SuggestionSensorVerdict", `"suggestionId" = '${ID}'`) };
    });
    expect(left).toEqual({ deleted: 1, anchors: 0, items: 0, verdicts: 0 });
  });

  it("refuses to delete a suggestion in any state past draft, by name", async () => {
    for (const state of ["SUBMITTED", "INTAKE_DECLINED", "GRADED", "SENSED", "DECIDED", "CURATOR_QUEUE", "MERGING", "MERGED", "CLOSED"]) {
      const said = await refusal([RUBRIC, suggestion({ state: `'${state}'` }), anchor("SECTION", "NULL", "NULL")], `DELETE FROM "Suggestion" WHERE "id" = '${ID}'`);
      expect(said, state).toContain("SUGGESTION_KEPT");
      expect(said, state).toContain(ID);
    }
  });

  it("takes an id of the form S, the chapter in two digits and a serial, where the chapter is the row's own", async () => {
    for (const [id, chapter] of [["S-15-90377", 15], ["S-00-90001", 0], ["S-40-1234567", 40], ["S-15-9037", 15]] as const) {
      expect(await refusal([RUBRIC], suggestion({ id: `'${id}'`, chapterNumber: chapter })), id).toBeNull();
    }
    for (const [id, chapter] of [["S-15-377", 15], ["s-15-90377", 15], ["S-5-90377", 5], ["S-15-90377 ", 15], ["15-90377", 15], ["S-15-9037x", 15], ["S-1x-90377", 15], ["S-16-90377", 15], ["S-15-90377", 16]] as const) {
      expect(await refusal([RUBRIC], suggestion({ id: `'${id}'`, chapterNumber: chapter })), `${id} on chapter ${String(chapter)}`).toContain("Suggestion_id_form");
    }
  });

  it("gives a researcher's proposal no contributor, and lets a person's be without its own", async () => {
    expect(await refusal([RUBRIC, PERSON_ROW], suggestion({ origin: `'RESEARCHER'`, userId: `'${PERSON}'` }))).toContain("Suggestion_researcher_has_no_user");
    expect(await refusal([RUBRIC], suggestion({ origin: `'RESEARCHER'` }))).toBeNull();
    expect(await refusal([RUBRIC, PERSON_ROW], suggestion({ userId: `'${PERSON}'` }))).toBeNull();
    expect(await refusal([RUBRIC], suggestion())).toBeNull();
  });

  it("wants the curator's reason for the class CURATOR_ALWAYS and for no other", async () => {
    expect(await refusal([RUBRIC], suggestion({ changeClass: `'CURATOR_ALWAYS'` }))).toContain("Suggestion_curatorReason_with_its_class");
    expect(await refusal([RUBRIC], suggestion({ curatorReason: `'SAFETY_OT'` }))).toContain("Suggestion_curatorReason_with_its_class");
    expect(await refusal([RUBRIC], suggestion({ changeClass: `'CURATOR_ALWAYS'`, curatorReason: `'SAFETY_OT'` }))).toBeNull();
  });

  it("wants at least one part: a suggestion in none is one no curator could be handed", async () => {
    expect(await refusal([RUBRIC], suggestion({ parts: `ARRAY[]::"Part"[]` }))).toContain("Suggestion_parts_named");
    expect(await refusal([RUBRIC], suggestion({ parts: "NULL" }))).toContain("Suggestion_parts_named");
    expect(await refusal([RUBRIC], suggestion({ parts: `ARRAY['P1', 'P3']::"Part"[]` }))).toBeNull();
  });

  it("keeps a proposal and its key together, and the key a sha256", async () => {
    expect(await refusal([RUBRIC], suggestion({ proposal: `'{"kind":"RESTRUCTURE"}'` }))).toContain("Suggestion_proposalKey_with_its_proposal");
    expect(await refusal([RUBRIC], suggestion({ proposalKey: `'${SHA}'` }))).toContain("Suggestion_proposalKey_with_its_proposal");
    expect(await refusal([RUBRIC], suggestion({ proposal: `'{"kind":"RESTRUCTURE"}'`, proposalKey: `'${SHA.toUpperCase()}'` }))).toContain("Suggestion_proposalKey_form");
    expect(await refusal([RUBRIC], suggestion({ proposal: `'{"kind":"RESTRUCTURE"}'`, proposalKey: `'${SHA.slice(1)}'` }))).toContain("Suggestion_proposalKey_form");
    expect(await refusal([RUBRIC], suggestion({ proposal: `'{"kind":"RESTRUCTURE"}'`, proposalKey: `'${SHA}'` }))).toBeNull();
  });

  it("lets an anchor name the one figure or the one source row its kind says, beside its section", async () => {
    const base = [RUBRIC, suggestion()];
    expect(await refusal(base, anchor("SECTION", "NULL", "NULL"))).toBeNull();
    expect(await refusal(base, anchor("FIGURE", "'F-21-03'", "NULL"))).toBeNull();
    expect(await refusal(base, anchor("SOURCE_ROW", "NULL", "'21.9 r4'"))).toBeNull();
    for (const [kind, figure, row] of [["SECTION", "'F-21-03'", "NULL"], ["SECTION", "NULL", "'21.9 r4'"], ["FIGURE", "NULL", "NULL"], ["FIGURE", "'F-21-03'", "'21.9 r4'"], ["SOURCE_ROW", "NULL", "NULL"], ["SOURCE_ROW", "'F-21-03'", "'21.9 r4'"]] as const) {
      expect(await refusal(base, anchor(kind, figure, row)), `${kind} ${figure} ${row}`).toContain("Anchor_kind_names_its_row");
    }
    expect(await refusal(base, anchor("SECTION", "NULL", "NULL", `'${"A".repeat(64)}'`))).toContain("Anchor_contentSha256_form");
  });

  it("takes a sha256 as 64 lower-case hex characters wherever these tables hold one", async () => {
    const base = [RUBRIC, suggestion({ state: `'DECIDED'` })];
    expect(await refusal(base, evidence(1, `'${SHA}'`))).toBeNull();
    expect(await refusal(base, evidence(1, `'sha256:${SHA}'`))).toContain("EvidenceItem_contentSha256_form");
    expect(await refusal(base, adjudication(`'${SHA}'`, `'${SHA}'`))).toBeNull();
    expect(await refusal(base, adjudication(`'not a hash'`))).toContain("Adjudication_guideSha256_form");
    expect(await refusal(base, adjudication("NULL", `'${SHA}0'`))).toContain("Adjudication_promptSha256_form");
    expect(await refusal([], RUBRIC.replace(SHA, SHA.slice(2)))).toContain("RubricVersion_sha256_form");
    const pack = (hash: string): string => `INSERT INTO "AuditExport" ("id", "scope", "fromSeq", "toSeq", "records", "headHash", "state") VALUES (gen_random_uuid(), '{"kind":"chapter","id":"15"}', 1, 2, 2, '${hash}', 'READY')`;
    expect(await refusal([], pack(SHA))).toBeNull();
    expect(await refusal([], pack("0"))).toContain("AuditExport_headHash_form");
  });

  it("holds one item per ordinal, one verdict per sensor and one adjudication per suggestion", async () => {
    const base = [RUBRIC, suggestion({ state: `'SUBMITTED'` })];
    expect(await refusal([...base, evidence(1)], evidence(1))).toContain("EvidenceItem_suggestionId_ordinal_key");
    expect(await refusal([...base, evidence(1)], evidence(2))).toBeNull();
    expect(await refusal([...base, sensor("SCHEMA")], sensor("SCHEMA"))).toContain("SuggestionSensorVerdict_suggestionId_sensor_key");
    expect(await refusal([...base, adjudication()], adjudication())).toContain("Adjudication_pkey");
  });

  it("keeps a curator's note to 400 characters", async () => {
    const base = [RUBRIC, suggestion({ state: `'CURATOR_QUEUE'` })];
    expect(await refusal(base, curatorAction(`repeat('n', 400)`))).toBeNull();
    expect(await refusal(base, curatorAction(`repeat('n', 401)`))).toContain("CuratorAction_note_length");
  });

  it("keeps a roster row's end after its start, one row per person and part, and a counter from one", async () => {
    expect(await refusal([PERSON_ROW], roster("NULL"))).toBeNull();
    expect(await refusal([PERSON_ROW], roster(`'2026-11-05T12:00:00Z'`))).toBeNull();
    expect(await refusal([PERSON_ROW], roster(`'2026-10-05T12:00:00Z'`))).toContain("CuratorRoster_until_after_since");
    expect(await refusal([PERSON_ROW], roster(`'2026-09-05T12:00:00Z'`))).toContain("CuratorRoster_until_after_since");
    expect(await refusal([PERSON_ROW, roster("NULL")], roster("NULL"))).toContain("CuratorRoster_userId_part_key");
    expect(await refusal([], `INSERT INTO "SuggestionCounter" ("chapterNumber", "next") VALUES (99, 1)`)).toBeNull();
    expect(await refusal([], `INSERT INTO "SuggestionCounter" ("chapterNumber", "next") VALUES (99, 0)`)).toContain("SuggestionCounter_next_from_one");
  });

  it("keeps a rubric version a suggestion was written under", async () => {
    expect(await refusal([RUBRIC, suggestion()], `DELETE FROM "RubricVersion" WHERE "id" = 'v0.0'`)).toContain("Suggestion_rubricVersionId_fkey");
    expect(await refusal([RUBRIC], `DELETE FROM "RubricVersion" WHERE "id" = 'v0.0'`)).toBeNull();
  });

  it("lets an account be deleted: its suggestion, action, merge and export stay without the person, and its roster rows go", async () => {
    const after = await rolledBack(async (sql) => {
      await sql.run(RUBRIC);
      await sql.run(PERSON_ROW);
      await sql.run(suggestion({ userId: `'${PERSON}'`, state: `'MERGED'` }));
      await sql.run(curatorAction("NULL", `'${PERSON}'`));
      await sql.run(`INSERT INTO "Merge" ("suggestionId", "branch", "versionFrom", "bump", "mergedById", "releaseFrom") VALUES ('${ID}', 'improve/S-15-90377-wording', '1.3.2', 'patch', '${PERSON}', '2026.09')`);
      await sql.run(`INSERT INTO "AuditExport" ("id", "requestedById", "scope", "fromSeq", "toSeq", "records", "headHash", "state") VALUES (gen_random_uuid(), '${PERSON}', '{"kind":"account"}', 1, 2, 2, '${SHA}', 'READY')`);
      await sql.run(roster("NULL"));
      const deleted = await sql.run(`DELETE FROM "User" WHERE "id" = '${PERSON}'`);
      return {
        deleted,
        suggestion: (await sql.rows<{ userId: string | null; state: string }>(`SELECT "userId", "state"::text AS state FROM "Suggestion" WHERE "id" = '${ID}'`))[0],
        curator: (await sql.rows<{ curatorId: string | null }>(`SELECT "curatorId" FROM "CuratorAction" WHERE "suggestionId" = '${ID}'`))[0],
        merge: (await sql.rows<{ mergedById: string | null }>(`SELECT "mergedById" FROM "Merge" WHERE "suggestionId" = '${ID}'`))[0],
        exports: await count(sql, "AuditExport", `"requestedById" IS NULL AND "headHash" = '${SHA}' AND "scope"->>'kind' = 'account'`),
        roster: await count(sql, "CuratorRoster", `"userId" = '${PERSON}'`),
      };
    });
    expect(after).toEqual({ deleted: 1, suggestion: { userId: null, state: "MERGED" }, curator: { curatorId: null }, merge: { mergedById: null }, exports: 1, roster: 0 });
  });

  it("left nothing behind", async () => {
    const left = await rolledBack(async (sql) => ({
      suggestions: await count(sql, "Suggestion", `"id" = '${ID}'`),
      rubric: await count(sql, "RubricVersion", `"id" = 'v0.0'`),
      people: await count(sql, "User", `"id" = '${PERSON}'`),
      counter: await count(sql, "SuggestionCounter", `"chapterNumber" = 99`),
    }));
    expect(left).toEqual({ suggestions: 0, rubric: 0, people: 0, counter: 0 });
  });
});

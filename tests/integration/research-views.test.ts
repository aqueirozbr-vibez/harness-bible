import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { env } from "@/lib/env";
import { researchSql } from "@/lib/metrics/research";

import { acquire, METRICS_ROLE_LOCK } from "@/tests/fixtures/exclusive";

/*
 * The research views after research on request (feature-specs/48 § 7, § 11.7, § 26 unit 70; unit 70c), against the
 * database: `ResearchSpend` holds a person's research, embedding and re-rank calls by run, with `person` as their payer,
 * and none of their organisation's Assistant calls; the platform's research principal's calls with `platform`;
 * `cap.sql` counts only the platform's refusals; `cost-per-run.sql` is a run's own calls over the runs read;
 * `ResearchFlag` names no person and no run, and `flags.sql` reads it; the dashboard's role reads all of it and still
 * cannot read `ResearchRun`. The platform's principal is the organisation whose `researchPrincipal` is true, never one
 * by its name (review of unit 70): an organisation named `Research` with no seats that is not the principal pays as a
 * person. Every row is written inside one transaction that is rolled back — the suite's own principal, an organisation
 * merely named as the principal used to be, a person, their calls, their flagged runs — so the suite leaves nothing,
 * not even a `BudgetLedger` row. The real research principal, should the database hold one, is unmarked inside that
 * transaction, since one organisation at most is the principal, and is marked again by the rollback. The rows are dated
 * to January 2020, a month no other row of this database is in.
 */

const hasDatabase = env.DATABASE_URL !== undefined;
const INIT_SQL = readFileSync(join(import.meta.dirname, "..", "..", "infra", "observability", "init.sql"), "utf8");
const FROM = "2020-01-01T00:00:00.000Z";
const TO = "2020-02-01T00:00:00.000Z";
const PLATFORM = "00000000-0000-4000-8000-0000000d7f01";
const ORGANISATION = "00000000-0000-4000-8000-0000000d7f02";
const NAMED = "00000000-0000-4000-8000-0000000d7f04";
const PERSON = "00000000-0000-4000-8000-0000000d7f03";
const RUN = "00000000-0000-4000-8000-0000000d7f11";
const OTHER_RUN = "00000000-0000-4000-8000-0000000d7f12";
const REFUSED_RUN = "00000000-0000-4000-8000-0000000d7f13";

describe.skipIf(!hasDatabase)("the research views by run and payer, and the flags' view (48 § 7, § 11.7)", () => {
  let client: Client;

  /* the role's grants are applied by one suite at a time (tests/fixtures/exclusive.ts) */
  let unlock: () => void = () => undefined;

  beforeAll(async () => {
    unlock = await acquire(METRICS_ROLE_LOCK);
    client = new Client({ connectionString: env.DATABASE_URL });
    await client.connect();
    /* the role's grants as the compose service applies them */
    await client.query(INIT_SQL);
    await client.query("BEGIN");
    /* one principal at most (the partial unique index): the real one, if any, stands aside until the rollback */
    await client.query(`UPDATE "Organisation" SET "researchPrincipal" = false WHERE "researchPrincipal"`);
    await client.query(
      `INSERT INTO "Organisation" (id, name, "seatLimit", "tokenCap", "ideMinutesCap", "tokensPerMinute", "researchPrincipal") VALUES ($1, 'Views platform', 0, 1, 0, 1, true), ($2, 'Views organisation', 5, 1, 0, 1, false), ($3, 'Research', 0, 1, 0, 1, false)`,
      [PLATFORM, ORGANISATION, NAMED],
    );
    await client.query(`INSERT INTO "User" (id, email, "displayName") VALUES ($1, $2, 'Views person')`, [PERSON, `${PERSON}@views.test`]);
    const call = (organisationId: string, kind: string, alias: string, outcome: string, costUsd: string, ref: string | null, day: string) =>
      client.query(`INSERT INTO "BudgetLedger" (id, "organisationId", month, kind, alias, "modelId", "inputTokens", "outputTokens", "costUsd", outcome, ref, "traceId", "createdAt") VALUES (gen_random_uuid()::text, $1, '2020-01', $2::"BudgetKind", $3, $3, 1, 1, $4::numeric, $5, $6, $7, $8::timestamp)`, [organisationId, kind, alias, costUsd, outcome, ref, "d".repeat(32), day]);
    /* a person's research run, charged to their organisation: planner, reader, writer, and retrieval naming the run */
    await call(ORGANISATION, "RESEARCH", "hb-small", "ok", "0.010", RUN, "2020-01-05T10:00:00");
    await call(ORGANISATION, "RESEARCH", "hb-frontier", "ok", "0.500", RUN, "2020-01-05T10:01:00");
    await call(ORGANISATION, "RESEARCH", "hb-frontier", "ok", "0.050", RUN, "2020-01-05T10:02:00");
    await call(ORGANISATION, "EMBED", "hb-embed", "ok", "0", RUN, "2020-01-05T10:00:00");
    await call(ORGANISATION, "RERANK", "hb-rerank", "ok", "0.001", RUN, "2020-01-05T10:00:00");
    /* the same organisation's Assistant: its turn and its retrieval, which name no run */
    await call(ORGANISATION, "ASSISTANT", "hb-frontier", "ok", "0.700", null, "2020-01-05T11:00:00");
    await call(ORGANISATION, "EMBED", "hb-embed", "ok", "0", null, "2020-01-05T11:00:00");
    await call(ORGANISATION, "GRADING", "hb-small", "ok", "0.020", null, "2020-01-05T11:00:00");
    /* a second run of theirs the planner was refused at their own cap: no model answered */
    await call(ORGANISATION, "RESEARCH", "hb-small", "budget", "0", OTHER_RUN, "2020-01-06T10:00:00");
    /* the platform's research principal: the vetting of a sent finding, and two refusals at its cap */
    await call(PLATFORM, "GRADING", "hb-small", "ok", "0.020", null, "2020-01-07T10:00:00");
    await call(PLATFORM, "RESEARCH", "hb-small", "budget", "0", "00000000-0000-4000-8000-0000000d7f21", "2020-01-08T10:00:00");
    await call(PLATFORM, "ADJUDICATION", "hb-frontier", "budget", "0", null, "2020-01-25T10:00:00");
    /* an organisation merely named as the principal used to be found: its research is a person's, its grading not research */
    await call(NAMED, "RESEARCH", "hb-small", "budget", "0", "00000000-0000-4000-8000-0000000d7f22", "2020-01-10T10:00:00");
    await call(NAMED, "GRADING", "hb-small", "ok", "0.020", null, "2020-01-10T10:00:00");
    /* two flagged runs of the person's, one on a report and one on a refusal */
    const run = (id: string, state: string, reason: string) =>
      client.query(`INSERT INTO "ResearchRun" (id, "userId", "organisationId", "releaseId", locale, state, gap, "sectionAnchors", "questionSha256", "traceId", "flagReason", "flaggedAt", "createdAt") VALUES ($1, $2, $3, '2026.09', 'EN', $4::"ResearchState", false, ARRAY['21.3'], $5, $6, $7, '2020-01-09T10:00:00'::timestamp, '2020-01-09T09:00:00'::timestamp)`, [id, PERSON, ORGANISATION, state, "e".repeat(64), "d".repeat(32), reason]);
    await run(RUN, "DONE", "wrong_citation");
    await run(REFUSED_RUN, "REFUSED", "should_not_refuse");
  });

  afterAll(async () => {
    try {
      await client.query("ROLLBACK");
      await client.end();
    } finally {
      unlock();
    }
  });

  const spendOf = async () => (await client.query(`SELECT kind, alias, outcome, "costUsd"::text AS cost, run, payer FROM "ResearchSpend" WHERE day >= $1::timestamp AND day < $2::timestamp ORDER BY payer, kind, alias, cost, run`, [FROM, TO])).rows as Array<{ kind: string; alias: string; outcome: string; cost: string; run: string | null; payer: string }>;
  const statement = async (name: "cap" | "cost-per-run" | "flags") => (await client.query(researchSql(name), [FROM, TO, "month"])).rows as Array<{ key: string; n: number; d: number | null; value: number | null }>;

  it("holds a person's research, embedding and re-rank calls by run as the person's, the platform's calls as the platform's, and none of the organisation's Assistant calls", async () => {
    const spend = await spendOf();
    const person = spend.filter((row) => row.payer === "person");
    expect(person.map((row) => [row.kind, row.alias, row.run])).toEqual([
      ["EMBED", "hb-embed", RUN],
      ["RERANK", "hb-rerank", RUN],
      ["RESEARCH", "hb-frontier", RUN],
      ["RESEARCH", "hb-frontier", RUN],
      ["RESEARCH", "hb-small", OTHER_RUN],
      ["RESEARCH", "hb-small", "00000000-0000-4000-8000-0000000d7f22"],
      ["RESEARCH", "hb-small", RUN],
    ]);
    expect(spend.filter((row) => row.payer === "platform").map((row) => [row.kind, row.run])).toEqual([
      ["ADJUDICATION", null],
      ["GRADING", null],
      ["RESEARCH", "00000000-0000-4000-8000-0000000d7f21"],
    ]);
    expect(spend.some((row) => row.kind === "ASSISTANT")).toBe(false);
    expect(spend.filter((row) => row.payer === "person" && row.run === null)).toEqual([]);
  });

  it("finds the platform's principal by its column alone: one at most, and an organisation named Research with no seats is no principal (review of unit 70)", async () => {
    expect((await client.query(`SELECT id FROM "Organisation" WHERE "researchPrincipal"`)).rows).toEqual([{ id: PLATFORM }]);
    await client.query("SAVEPOINT second_principal");
    try {
      await expect(client.query(`UPDATE "Organisation" SET "researchPrincipal" = true WHERE id = $1`, [NAMED])).rejects.toMatchObject({ code: "23505" });
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT second_principal");
    }
    const named = (await spendOf()).filter((row) => row.run === "00000000-0000-4000-8000-0000000d7f22" || (row.kind === "GRADING" && row.payer === "person"));
    expect(named.map((row) => [row.kind, row.payer])).toEqual([["RESEARCH", "person"]]);
  });

  it("counts in cap.sql only the platform's refusals at its cap, by the twentieth; never a person's at their own", async () => {
    expect((await statement("cap")).map((row) => [row.key, row.n])).toEqual([
      ["before-20th", 1],
      ["from-20th", 1],
    ]);
  });

  it("prices a run by the calls that name it, over the runs whose reader answered", async () => {
    const [cost] = await statement("cost-per-run");
    expect(cost?.n).toBeCloseTo(0.561, 9);
    expect(cost?.d).toBe(1);
    expect(cost?.value).toBeCloseTo(0.561, 9);
  });

  it("gives the flags a view of their day, kind and reason that names no person and no run, and counts them by reason", async () => {
    const columns = (await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'ResearchFlag' ORDER BY ordinal_position`)).rows.map((row: { column_name: string }) => row.column_name);
    expect(columns).toEqual(["day", "kind", "reason"]);
    expect((await statement("flags")).map((row) => [row.key, row.n])).toEqual([
      ["all", 2],
      ["refusal should_not_refuse", 1],
      ["report wrong_citation", 1],
    ]);
  });

  it("lets the dashboard's role read the three views' rows, the same as the application's, and still refuses it ResearchRun", async () => {
    const own = { cap: await statement("cap"), flags: await statement("flags"), cost: await statement("cost-per-run") };
    await client.query("SAVEPOINT as_metrics");
    try {
      await client.query("SET LOCAL ROLE hb_metrics");
      expect({ cap: await statement("cap"), flags: await statement("flags"), cost: await statement("cost-per-run") }).toEqual(own);
      await expect(client.query(`SELECT "flagReason" FROM "ResearchRun" LIMIT 1`)).rejects.toMatchObject({ code: "42501" });
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT as_metrics");
    }
  });
});

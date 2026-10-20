import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { env } from "@/lib/env";
import { monthWindow, SERIES, seriesSql } from "@/lib/metrics/assistant";
import { RESEARCH_SERIES, researchSql } from "@/lib/metrics/research";

import { acquire, METRICS_ROLE_LOCK } from "@/tests/fixtures/exclusive";

/*
 * The dashboard's role against the database (feature-specs/21 § 5.2, § 13.5): infra/observability/init.sql applied
 * as the compose service applies it, then every statement of lib/metrics/sql run *as hb_metrics*, and the reads the
 * role exists to refuse attempted. `SET LOCAL ROLE` takes the role inside a transaction that is rolled back, so the
 * suite needs no password and changes nothing but the grants the file itself states.
 */

const hasDatabase = env.DATABASE_URL !== undefined;
const INIT_SQL = readFileSync(join(import.meta.dirname, "..", "..", "infra", "observability", "init.sql"), "utf8");
const WINDOW = monthWindow("2026-10");

describe.skipIf(!hasDatabase)("hb_metrics, the dashboard's database role", () => {
  let client: Client;

  /** One statement as hb_metrics; the transaction is rolled back whatever happens. */
  async function asMetrics(sql: string, values: ReadonlyArray<string> = []): Promise<{ readonly rows: ReadonlyArray<Record<string, unknown>> } | { readonly denied: string }> {
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL ROLE hb_metrics");
      const result = await client.query(sql, [...values]);
      return { rows: result.rows as ReadonlyArray<Record<string, unknown>> };
    } catch (error: unknown) {
      return { denied: (error as { code?: string }).code ?? "unknown" };
    } finally {
      await client.query("ROLLBACK");
    }
  }

  /* the role's grants are applied by one suite at a time (tests/fixtures/exclusive.ts) */
  let unlock: () => void = () => undefined;

  beforeAll(async () => {
    unlock = await acquire(METRICS_ROLE_LOCK);
    client = new Client({ connectionString: env.DATABASE_URL });
    await client.connect();
    /* Twice: the file must be applicable to a database that already has the role, as the compose service reruns it. */
    await client.query(INIT_SQL);
    await client.query(INIT_SQL);
  });

  afterAll(async () => {
    try {
      await client.end();
    } finally {
      unlock();
    }
  });

  it.each(SERIES.map((series) => series.name))("runs %s with the columns it was granted", async (name) => {
    for (const bucket of ["day", "month"]) {
      const result = await asMetrics(seriesSql(name), [WINDOW.from.toISOString(), WINDOW.to.toISOString(), bucket]);
      expect(result, `${name} by ${bucket}`).toHaveProperty("rows");
    }
  });

  /* the researcher's (feature-specs/44 § 4, § 8.3): the same rows as the application reads, through the two views alone */
  it.each(RESEARCH_SERIES.map((series) => series.name))("runs research/%s with the views' columns, and gets the application's own rows", async (name) => {
    for (const bucket of ["day", "month"]) {
      const values = [WINDOW.from.toISOString(), WINDOW.to.toISOString(), bucket];
      const result = await asMetrics(researchSql(name), values);
      expect(result, `${name} by ${bucket}`).toHaveProperty("rows");
      const own = await client.query(researchSql(name), values);
      expect("rows" in result ? result.rows : null).toEqual(own.rows);
    }
  });

  it.each([
    ['SELECT "text" FROM "Message" LIMIT 1', "a reader's question or an answer"],
    ['SELECT * FROM "Message" LIMIT 1', "a whole message row"],
    ['SELECT "modeResult" FROM "Message" LIMIT 1', "a stored mode result"],
    ['SELECT "aidInputs" FROM "Message" LIMIT 1', "a reader's inputs to a decision aid"],
    ['SELECT "claimText" FROM "Citation" LIMIT 1', "a claim's text"],
    ['SELECT detail FROM "SensorVerdict" LIMIT 1', "a verdict's detail"],
    ['SELECT email FROM "User" LIMIT 1', "an account's e-mail"],
    ['SELECT id FROM "Session" LIMIT 1', "a session"],
    ['SELECT "keyCiphertext" FROM "GatewayKey" LIMIT 1', "a gateway key"],
    ['SELECT payload FROM "LedgerRecord" LIMIT 1', "a ledger record"],
    ['SELECT state FROM "ResearchRun" LIMIT 1', "a research run, which names who asked"],
    ['SELECT * FROM "ResearchRun" LIMIT 1', "a whole research run"],
    ['SELECT outcome FROM "ResearchFinding" LIMIT 1', "a research finding"],
    ['SELECT "suggestionId" FROM "ProposalEndorsement" LIMIT 1', "a reader's name on a proposal"],
    ['SELECT "textEn" FROM "Section" LIMIT 1', "the book's text"],
    ['DELETE FROM "Flag"', "a delete"],
    ['UPDATE "Message" SET substituted = 0', "an update"],
    ['INSERT INTO "Flag" (id, "messageId", "userId", kind, reason) VALUES (\'x\', \'x\', \'x\', \'ANSWER\', \'x\')', "an insert"],
  ])("refuses %s (%s)", async (sql) => {
    expect(await asMetrics(sql)).toEqual({ denied: "42501" });
  });

  it("is read-only by default when it signs in itself, whatever a later grant says", async () => {
    const setting = await client.query<{ setconfig: string[] | null }>("SELECT s.setconfig FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole WHERE r.rolname = 'hb_metrics' AND s.setdatabase = 0");
    expect(setting.rows[0]?.setconfig).toContain("default_transaction_read_only=on");
    const usage = await client.query<{ usage: boolean; create: boolean }>("SELECT has_schema_privilege('hb_metrics', 'public', 'USAGE') AS usage, has_schema_privilege('hb_metrics', 'public', 'CREATE') AS create");
    expect(usage.rows[0]).toEqual({ usage: true, create: false });
  });
});

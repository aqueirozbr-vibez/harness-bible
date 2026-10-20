import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { aliasesFromConfig, startStub, type RunningStub } from "@/infra/gateway/stub/server";
import { budgetView } from "@/lib/budget/view";
import { appendBudgetRow, budgetFacts, gradingUsageOf, monthBreakdown, monthOf, monthSpend, tokenCapOf, type BudgetRowInput, type MonthBreakdown } from "@/lib/db/budget";
import { getPrisma } from "@/lib/db/client";
import type { BudgetKind } from "@/lib/db/generated/enums";
import { findGatewayKey } from "@/lib/db/gateway";
import { withTenant } from "@/lib/db/tenant";
import { env } from "@/lib/env";
import { callModel, type GatewayDeps } from "@/lib/gateway/client";
import { decryptKey } from "@/lib/gateway/keys";
import { requestFor } from "@/lib/gateway/policy";
import type { GatewaySpan } from "@/lib/gateway/span";
import type { Principal } from "@/lib/schemas/gateway";
import { CHECK_PROMPT } from "@/workers/check";
import { ensureKey, keyDb, rotateKey, type KeyDeps } from "@/workers/keys";

/*
 * The gateway's rows against the release database (feature-specs/11 § 6, § 12.2): a key minted through the
 * workers' path and stored encrypted, a call through the client writing its BudgetLedger row, the month's sum,
 * the tenant guard by principal and the append-only guard. The organisation is a fixture row with a fixed id,
 * upserted so it never multiplies; its BudgetLedger rows stay, as nothing may delete them.
 */
const hasDatabase = env.DATABASE_URL !== undefined;

const MASTER_KEY = "test-master-key-for-the-integration";
const SECRET = "fedcba9876543210".repeat(4);
const NOW = new Date();
const ALIASES = aliasesFromConfig(readFileSync(join(import.meta.dirname, "..", "..", "infra", "gateway", "litellm.yaml"), "utf8"));
const ORG_ID = "00000000-0000-4000-8000-00000000d001";
const OTHER_ORG_ID = "00000000-0000-4000-8000-00000000d002";
/** The concurrent-ensure organisation: its own row, so the `/key/generate` count is this test's alone. */
const RACE_ORG_ID = "00000000-0000-4000-8000-00000000d003";
/** The foreign-key organisation and individual user: created and deleted by their test. */
const FK_ORG_ID = "00000000-0000-4000-8000-00000000d004";
const FK_USER_ID = "00000000-0000-4000-8000-00000000d005";
const ORG: Principal = { organisationId: ORG_ID };

describe.skipIf(!hasDatabase)("the gateway rows against the database", () => {
  let stub: RunningStub;
  const spans: GatewaySpan[] = [];
  const lines: string[] = [];

  beforeAll(async () => {
    stub = await startStub({ masterKey: MASTER_KEY, aliases: ALIASES, port: 0, log: (line) => lines.push(line) });
    const prisma = getPrisma();
    /* The fixture owns its values on every run: the minted key copies the organisation's caps, and an operator who
       raised them for a demo (2026-09-25, 800,000 a minute on this row) would otherwise fail the assertion below.
       The demo has its own organisation now, so resetting these touches nobody's key. */
    const fixture = { name: "Gateway integration fixture", seatLimit: 1, tokenCap: BigInt(1_000_000), ideMinutesCap: 0, tokensPerMinute: 1000 };
    for (const id of [ORG_ID, RACE_ORG_ID]) {
      await prisma.organisation.upsert({ where: { id }, create: { id, ...fixture }, update: fixture });
      await withTenant({ userId: null, organisationId: id }, () => prisma.gatewayKey.deleteMany({ where: {} }));
    }
  });
  afterAll(async () => {
    await stub.close();
    await getPrisma().$disconnect();
  });

  function keyDeps(): KeyDeps {
    return { gatewayUrl: stub.url, masterKey: MASTER_KEY, keySecret: SECRET, individual: null, fetch: globalThis.fetch, now: () => NOW, db: keyDb };
  }

  function gatewayDeps(): GatewayDeps {
    return { baseUrl: stub.url, keySecret: SECRET, findKey: findGatewayKey, append: appendBudgetRow, log: (span) => spans.push(span), fetch: globalThis.fetch, now: () => NOW };
  }

  it("mints the organisation's key into GatewayKey, encrypted, and rotates it in place", async () => {
    const minted = await ensureKey(ORG, keyDeps());
    const row = await findGatewayKey(ORG);
    expect(row?.litellmKeyId).toBe(minted.litellmKeyId);
    expect(row?.maxBudgetUsd).toBe("5");
    expect(row?.tokensPerMinute).toBe(1000);
    expect(decryptKey(SECRET, row?.keyCiphertext ?? "")).toMatch(/^sk-[0-9a-f]{32}$/);
    expect((await ensureKey(ORG, keyDeps())).litellmKeyId).toBe(minted.litellmKeyId);
    const rotated = await rotateKey(ORG, keyDeps());
    expect(rotated.litellmKeyId).not.toBe(minted.litellmKeyId);
    expect(rotated.rotatedAt).not.toBeNull();
    const after = await findGatewayKey(ORG);
    expect(after?.id).toBe(row?.id);
    expect(after?.litellmKeyId).toBe(rotated.litellmKeyId);
    expect(await findGatewayKey({ organisationId: OTHER_ORG_ID })).toBeNull();
  });

  it("mints one key for concurrent ensure calls on the same principal and revokes the spares at the gateway", async () => {
    const race: Principal = { organisationId: RACE_ORG_ID };
    const prisma = getPrisma();
    // The first query on a pooled connection is slower than the rest, which would serialise the calls below and
    // hide the race; three trivial concurrent reads open the connections first.
    await Promise.all([findGatewayKey(race), findGatewayKey(race), findGatewayKey(race)]);
    const generated = lines.filter((line) => line.startsWith("POST /key/generate")).length;
    const deleted = lines.filter((line) => line.startsWith("POST /key/delete")).length;
    const results = await Promise.all([ensureKey(race, keyDeps()), ensureKey(race, keyDeps()), ensureKey(race, keyDeps())]);
    const ids = new Set(results.map((result) => result.litellmKeyId));
    expect(ids.size).toBe(1);
    expect(await withTenant({ userId: null, organisationId: RACE_ORG_ID }, () => prisma.gatewayKey.count())).toBe(1);
    const row = await findGatewayKey(race);
    expect(row?.litellmKeyId).toBe([...ids][0]);
    // Three calls, three mints on this machine: whatever the pool allows, every key minted but the row's is deleted again.
    const mints = lines.filter((line) => line.startsWith("POST /key/generate")).length - generated;
    expect(lines.filter((line) => line.startsWith("POST /key/delete")).length - deleted).toBe(mints - 1);
  });

  it("refuses to delete a principal that still holds a gateway key, and keeps its budget rows when it goes", async () => {
    const prisma = getPrisma();
    const orgTenant = { userId: null, organisationId: FK_ORG_ID };
    const userTenant = { userId: FK_USER_ID, organisationId: null };
    await prisma.organisation.upsert({
      where: { id: FK_ORG_ID },
      create: { id: FK_ORG_ID, name: "Gateway foreign-key fixture", seatLimit: 1, tokenCap: BigInt(1_000), ideMinutesCap: 0, tokensPerMinute: 1000 },
      update: {},
    });
    await withTenant(orgTenant, () => prisma.gatewayKey.deleteMany({ where: {} }));
    await withTenant(orgTenant, () => prisma.gatewayKey.create({ data: { litellmKeyId: `fk-org-${Date.now()}`, keyCiphertext: "ciphertext", maxBudgetUsd: 1, tokensPerMinute: 1000 } }));
    await expect(prisma.organisation.delete({ where: { id: FK_ORG_ID } })).rejects.toMatchObject({ code: "P2003" });
    await withTenant(orgTenant, () => prisma.gatewayKey.deleteMany({ where: {} }));
    await prisma.organisation.delete({ where: { id: FK_ORG_ID } });
    expect(await prisma.organisation.findUnique({ where: { id: FK_ORG_ID } })).toBeNull();

    await withTenant(userTenant, () => prisma.user.deleteMany({ where: { id: FK_USER_ID } }));
    await withTenant(userTenant, () => prisma.user.create({ data: { id: FK_USER_ID, email: `fk-${Date.now()}@harness-bible.local`, displayName: "Gateway foreign-key fixture" } }));
    await withTenant(userTenant, () => prisma.gatewayKey.create({ data: { litellmKeyId: `fk-user-${Date.now()}`, keyCiphertext: "ciphertext", maxBudgetUsd: 1, tokensPerMinute: 100 } }));
    // A trace id of this run alone: the row it writes outlives the test, as every BudgetLedger row does.
    const traceId = `f${Date.now().toString(16)}`.padEnd(32, "f").slice(0, 32);
    await appendBudgetRow({ principal: { userId: FK_USER_ID }, month: monthOf(NOW), kind: "ASSISTANT", alias: "hb-small", modelId: "claude-haiku-4-5", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, outcome: "ok", ref: null, traceId, gatewayCallId: null });
    await expect(withTenant(userTenant, () => prisma.user.delete({ where: { id: FK_USER_ID } }))).rejects.toMatchObject({ code: "P2003" });
    await withTenant(userTenant, () => prisma.gatewayKey.deleteMany({ where: {} }));
    await withTenant(userTenant, () => prisma.user.delete({ where: { id: FK_USER_ID } }));
    expect(await withTenant(userTenant, () => prisma.user.count({ where: { id: FK_USER_ID } }))).toBe(0);
    expect(await withTenant(userTenant, () => prisma.budgetLedger.count({ where: { traceId } }))).toBe(1);
  });

  it("calls the stub with the stored key and writes the BudgetLedger row the month's sum reads", async () => {
    const month = monthOf(NOW);
    const before = await monthSpend(ORG, month);
    const message = await callModel(
      { purpose: "assistant", alias: "hb-small", guide: null, principal: ORG, traceId: "d".repeat(32), ref: "integration" },
      { ...requestFor("scopeClassifier"), messages: [{ role: "user", content: CHECK_PROMPT }] },
      gatewayDeps(),
    );
    expect(message.model).toBe("claude-haiku-4-5");
    const after = await monthSpend(ORG, month);
    expect(after.calls).toBe(before.calls + 1);
    expect(after.inputTokens).toBe(before.inputTokens + message.usage.input_tokens);
    expect(Number(after.costUsd)).toBeGreaterThan(Number(before.costUsd));
    const rows = await withTenant({ userId: null, organisationId: ORG_ID }, () => getPrisma().budgetLedger.findMany({ where: { traceId: "d".repeat(32) }, orderBy: { createdAt: "desc" }, take: 1 }));
    expect(rows[0]).toMatchObject({ organisationId: ORG_ID, userId: null, month, kind: "ASSISTANT", alias: "hb-small", modelId: "claude-haiku-4-5", outcome: "ok", ref: "integration" });
    expect(rows[0].gatewayCallId).toMatch(/^[0-9a-f-]{36}$/);
    expect(rows[0].costUsd.toString()).toBe(String(spans[spans.length - 1]["hb.cost_usd"]));
  });

  it("filters GatewayKey and BudgetLedger by principal and refuses a query outside a tenant context", async () => {
    const prisma = getPrisma();
    await expect(prisma.budgetLedger.count()).rejects.toMatchObject({ code: "NO_TENANT" });
    await expect(prisma.gatewayKey.findFirst()).rejects.toMatchObject({ code: "NO_TENANT" });
    await expect(withTenant({ userId: null, organisationId: null }, () => prisma.budgetLedger.count())).rejects.toMatchObject({ code: "NO_TENANT" });
    expect(await withTenant({ userId: null, organisationId: OTHER_ORG_ID }, () => prisma.budgetLedger.count({ where: { traceId: "d".repeat(32) } }))).toBe(0);
    expect(await withTenant({ userId: null, organisationId: ORG_ID }, () => prisma.budgetLedger.count({ where: { traceId: "d".repeat(32) } }))).toBeGreaterThan(0);
    expect(await withTenant({ userId: null, organisationId: OTHER_ORG_ID }, () => prisma.gatewayKey.count())).toBe(0);
  });

  it("never updates or deletes a BudgetLedger row, and the database refuses a row naming both principals or none", async () => {
    const prisma = getPrisma();
    await expect(withTenant({ userId: null, organisationId: ORG_ID }, () => prisma.budgetLedger.updateMany({ where: {}, data: { outcome: "ok" } }))).rejects.toMatchObject({ code: "BUDGET_APPEND_ONLY" });
    await expect(withTenant({ userId: null, organisationId: ORG_ID }, () => prisma.budgetLedger.deleteMany({ where: {} }))).rejects.toMatchObject({ code: "BUDGET_APPEND_ONLY" });
    await expect(
      withTenant({ userId: null, organisationId: ORG_ID }, () =>
        prisma.budgetLedger.create({
          data: { userId: "00000000-0000-4000-8000-000000000001", month: "2026-09", kind: "ASSISTANT", alias: "hb-small", modelId: "claude-haiku-4-5", inputTokens: 0, outputTokens: 0, costUsd: 0, outcome: "ok", traceId: "e".repeat(32) },
        }),
      ),
    ).rejects.toThrow(/BudgetLedger_one_principal/);
  });

  it("sums the tokens of a suggestion's grading calls under its principal, after an instant when one is given (unit 50a)", async () => {
    /* A suggestion of chapter 98, which no book has, and its own for this run: the rows stay, as every BudgetLedger row does. */
    const suggestionId = `S-98-${String(Date.now() % 100_000_000).padStart(8, "0")}`;
    const row = (kind: BudgetKind, ref: string | null, inputTokens: number): BudgetRowInput => ({
      principal: ORG, month: monthOf(new Date()), kind, alias: "hb-small", modelId: "claude-haiku-4-5", inputTokens, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 0, costUsd: 0, outcome: "ok", ref, traceId: randomBytes(16).toString("hex"), gatewayCallId: null,
    });
    expect(await gradingUsageOf(ORG, suggestionId, null)).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });
    /* Two grades of the suggestion; a call of another kind with its ref, and a grade of another suggestion, are not its grading. */
    for (const input of [row("GRADING", suggestionId, 1000), row("GRADING", suggestionId, 2500), row("ADJUDICATION", suggestionId, 9000), row("GRADING", `${suggestionId}0`, 9000)]) await appendBudgetRow(input);
    expect(await gradingUsageOf(ORG, suggestionId, null)).toEqual({ inputTokens: 3500, outputTokens: 14, cacheReadTokens: 6 });
    expect(await gradingUsageOf(ORG, suggestionId, new Date(Date.now() - 60_000))).toEqual({ inputTokens: 3500, outputTokens: 14, cacheReadTokens: 6 });
    expect(await gradingUsageOf(ORG, suggestionId, new Date(Date.now() + 60_000))).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });
    /* Another principal's tenant sees none of them. */
    expect(await gradingUsageOf({ userId: FK_USER_ID }, suggestionId, null)).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });
  });

  it("breaks a month down by kind, counts the assistant's answers by trace, and reads the cap, for the budget meter", async () => {
    /* A month of its own, years ahead, so the deltas below are this case's rows and nobody's meter moves. The rows
       stay, as every BudgetLedger row does: the assertions are differences, never totals. */
    const at = new Date("2031-03-10T12:00:00Z");
    const month = monthOf(at);
    const before = await monthBreakdown(ORG, month);
    const kindOf = (breakdown: MonthBreakdown, kind: string, suggestion = false) => breakdown.kinds.find((row) => row.kind === kind && row.suggestion === suggestion) ?? { kind, suggestion, calls: 0, costUsd: "0" };
    const [one, two, three] = [randomBytes(16).toString("hex"), randomBytes(16).toString("hex"), randomBytes(16).toString("hex")];
    const row = (kind: BudgetKind, traceId: string, costUsd: number, ref: string | null = null): BudgetRowInput => ({
      principal: ORG, month, kind, alias: "hb-frontier", modelId: "claude-opus-5", inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd, outcome: "ok", ref, traceId, gatewayCallId: null,
    });
    /* Two turns: the first drafts twice (a repair) and is graded, the second drafts once. A third trace only retrieves.
       Then Improve's calls (38 § 2): a suggestion graded twice and adjudicated, another graded once — rows that name the suggestion, so they are not the assistant's. */
    const [first, second] = [`S-21-${randomBytes(2).toString("hex")}`, `S-21-${randomBytes(2).toString("hex")}`];
    const improve = [row("GRADING", randomBytes(16).toString("hex"), 0.1, first), row("GRADING", randomBytes(16).toString("hex"), 0.1, first), row("ADJUDICATION", randomBytes(16).toString("hex"), 0.3, first), row("GRADING", randomBytes(16).toString("hex"), 0.1, second)];
    for (const input of [row("ASSISTANT", one, 0.5), row("ASSISTANT", one, 0.25), row("GRADING", one, 0.25), row("ASSISTANT", two, 0.5), row("EMBED", two, 0), row("RERANK", three, 0), ...improve]) {
      await appendBudgetRow(input);
    }

    const after = await monthBreakdown(ORG, month);
    expect(after.answers).toBe(before.answers + 2);
    expect(kindOf(after, "ASSISTANT").calls).toBe(kindOf(before, "ASSISTANT").calls + 3);
    expect(Number(kindOf(after, "ASSISTANT").costUsd) - Number(kindOf(before, "ASSISTANT").costUsd)).toBeCloseTo(1.25, 9);
    expect(Number(kindOf(after, "GRADING").costUsd) - Number(kindOf(before, "GRADING").costUsd)).toBeCloseTo(0.25, 9);
    expect(kindOf(after, "EMBED").calls).toBe(kindOf(before, "EMBED").calls + 1);
    expect(kindOf(after, "RERANK").calls).toBe(kindOf(before, "RERANK").calls + 1);
    /* Improve's rows, apart: by the suggestions they served. */
    expect(kindOf(after, "GRADING", true).calls).toBe(kindOf(before, "GRADING", true).calls + 3);
    expect(Number(kindOf(after, "GRADING", true).costUsd) - Number(kindOf(before, "GRADING", true).costUsd)).toBeCloseTo(0.3, 9);
    expect(kindOf(after, "ADJUDICATION", true).calls).toBe(kindOf(before, "ADJUDICATION", true).calls + 1);
    expect(after.suggestions).toEqual({ grading: before.suggestions.grading + 2, adjudication: before.suggestions.adjudication + 1 });

    /* The breakdown and the month's sum are the same rows read two ways. */
    const spend = await monthSpend(ORG, month);
    expect(after.kinds.reduce((sum, kind) => sum + kind.calls, 0)).toBe(spend.calls);
    expect(after.kinds.reduce((sum, kind) => sum + Number(kind.costUsd), 0)).toBeCloseTo(Number(spend.costUsd), 9);

    /* The cap: the organisation's own for a member, the configured one for an individual, none where there is none. */
    expect(await tokenCapOf(ORG, 200_000)).toBe(1_000_000);
    expect(await tokenCapOf({ userId: FK_USER_ID }, 200_000)).toBe(200_000);
    expect(await tokenCapOf({ userId: FK_USER_ID }, null)).toBeNull();
    expect(await tokenCapOf({ organisationId: "00000000-0000-4000-8000-00000000dfff" }, 200_000)).toBeNull();

    /* And the meter built from them: $1.50 more of this run's is 300,000 more tokens of a 1.00 M cap, in the assistant's row; Improve's $0.30 and $0.30 in their own two rows (38 § 2). */
    const view = budgetView(await budgetFacts(ORG, at, null), at);
    const earlier = budgetView({ month, kinds: before.kinds, answers: before.answers, suggestions: before.suggestions, capTokens: 1_000_000 }, at);
    expect(view.cap).toBe(1_000_000);
    expect(view.used - earlier.used).toBe(420_000);
    expect((view.rows[0]?.tokens ?? 0) - (earlier.rows[0]?.tokens ?? 0)).toBe(300_000);
    expect((view.rows[1]?.tokens ?? 0) - (earlier.rows[1]?.tokens ?? 0)).toBe(60_000);
    expect((view.rows[2]?.tokens ?? 0) - (earlier.rows[2]?.tokens ?? 0)).toBe(60_000);
    expect(view.rows[3]?.tokens).toBe(earlier.rows[3]?.tokens);
    expect(view.suggestions).toEqual(after.suggestions);
    expect(view.answers).toBe(after.answers);
    expect(view.resetsAt).toBe("2031-04-01T00:00:00.000Z");

    /* Another organisation reads none of it. */
    expect((await monthBreakdown({ organisationId: OTHER_ORG_ID }, month)).answers).toBe(0);
  });
});

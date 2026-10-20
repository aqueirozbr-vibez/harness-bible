import { newTraceId } from "@/lib/api/trace";
import { tenantOf, type SessionUser } from "@/lib/auth/session";
import { createConversation } from "@/lib/db/assistant";
import { tenantOfPrincipal } from "@/lib/db/budget";
import { getPrisma } from "@/lib/db/client";
import { withTenant } from "@/lib/db/tenant";
import { contextOf, type GoldenRunDeps, type LedgerCall } from "@/lib/gate/goldenRun";
import type { Principal } from "@/lib/schemas/gateway";
import { TurnEventSchema, type TurnEventLine } from "@/lib/schemas/workers";
import { workersStream, type WorkersClientDeps } from "@/lib/workers/client";
import type { StubStack } from "@/workers/gate/stubStack";

/*
 * How a golden item travels (feature-specs/22 § 4): the four functions `runGolden` is given, over the workers'
 * `/answer` route and the rows the turn writes. One wiring for both grades: with a stub stack the turn's gateway
 * calls are read from the stack's memory and the classifier is told the cause the label names; without one they
 * are the principal's BudgetLedger rows and the classifier is the model's.
 */

/** The account as the conversation functions and the workers' body want it. */
export function sessionOf(id: string, organisationId: string | null): SessionUser {
  return { id, organisationId, role: "READER", displayName: "Gate", locale: "en", identityVerified: false, parts: [], sessionId: null };
}

export function principalOf(user: SessionUser): Principal {
  return user.organisationId === null ? { userId: user.id } : { organisationId: user.organisationId };
}

/** Every conversation of an account with what hangs from it, removed; returns how many conversations there were. */
export async function clearConversations(user: SessionUser): Promise<number> {
  return withTenant(tenantOf(user), async () => {
    const prisma = getPrisma();
    const ids = (await prisma.message.findMany({ select: { id: true } })).map((message) => message.id);
    await prisma.flag.deleteMany({ where: { messageId: { in: ids } } });
    await prisma.citation.deleteMany({ where: { messageId: { in: ids } } });
    await prisma.sensorVerdict.deleteMany({ where: { messageId: { in: ids } } });
    await prisma.message.deleteMany({ where: { id: { in: ids } } });
    return (await prisma.conversation.deleteMany({})).count;
  });
}

async function linesOf(stream: ReadableStream<Uint8Array>): Promise<ReadonlyArray<TurnEventLine>> {
  const text = await new Response(stream).text();
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => TurnEventSchema.parse(JSON.parse(line)));
}

export interface GoldenDepsInput {
  readonly user: SessionUser;
  readonly workers: WorkersClientDeps;
  /** The stub grade's stack; null for the real grade, which goes through the running workers. */
  readonly stack: StubStack | null;
}

export function goldenDeps({ user, workers, stack }: GoldenDepsInput): GoldenRunDeps {
  const principal = principalOf(user);
  return {
    traceId: newTraceId,
    open: async (item) => (await createConversation({ ...user, locale: item.language }, { locale: item.language })).id,
    ask: async (item, conversationId, traceId) => {
      /* The stub cannot judge scope; it is told the cause the label names, which is its switch for a classifier's answer. */
      if (stack !== null && item.expected.refusal?.cause === "R-SCOPE") stack.expectCause(traceId, "R-SCOPE");
      const body = { conversationId, user: { id: user.id, organisationId: user.organisationId, role: "READER", displayName: user.displayName, locale: item.language }, principal, text: item.question, mode: item.mode, context: contextOf(item), aid: null };
      return linesOf(await workersStream("/answer", body, { traceId }, workers));
    },
    calls: async (traceId): Promise<ReadonlyArray<LedgerCall>> => {
      if (stack !== null) return stack.calls(traceId).map((row) => ({ alias: row.alias, kind: row.kind, cacheRead: row.cacheReadTokens, costUsd: row.costUsd }));
      const rows = await withTenant(tenantOfPrincipal(principal), () => getPrisma().budgetLedger.findMany({ where: { traceId }, orderBy: { createdAt: "asc" }, select: { alias: true, kind: true, cacheReadTokens: true, costUsd: true } }));
      return rows.map((row) => ({ alias: row.alias, kind: row.kind, cacheRead: row.cacheReadTokens, costUsd: Number(row.costUsd) }));
    },
    prefixOf: async (messageId) => (await withTenant(tenantOf(user), () => getPrisma().message.findFirst({ where: { id: messageId }, select: { guideSha256: true } })))?.guideSha256 ?? null,
  };
}

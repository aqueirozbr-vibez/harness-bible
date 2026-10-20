import { newTraceId } from "@/lib/api/trace";
import { tenantOf, type SessionUser } from "@/lib/auth/session";
import { createConversation, getConversation } from "@/lib/db/assistant";
import { getPrisma } from "@/lib/db/client";
import { withTenant } from "@/lib/db/tenant";
import { contextOf } from "@/lib/gate/goldenRun";
import { pickRefusalItems } from "@/lib/gate/phase2";
import type { TurnsFacts } from "@/lib/gate/research";
import type { GoldenItem } from "@/lib/schemas/golden";
import { TurnEventSchema } from "@/lib/schemas/workers";
import { workersStream, type WorkersClientDeps } from "@/lib/workers/client";
import { principalOf } from "@/workers/gate/goldenDeps";
import type { StubStack } from "@/workers/gate/stubStack";

/*
 * R1's own turns (feature-specs/44 § 2 R1, as feature-specs/48 § 25 reads it for unit 75): answered golden questions,
 * then one refusal of each cause, asked through the workers over the stub gateway as any reader's are. Since unit 75 a
 * turn hands nothing to research (48 § 9.2), so what is measured is that nothing of research follows it: no `research`
 * in its `final` event, no `ResearchRun` row naming its message, no research call on its trace; and that its answer is
 * the one its `final` gave — the claims' sections, the citations and the refusal as the conversation reads them back
 * after the turn, which nothing wrote over. Until unit 75 the turns were asked in three passes, research off, configured
 * and off again, the hand-over's engine call on a queue no worker read, and the time to the `final` event compared
 * (D2): there is no hand-over left to slow it.
 */

/** The questions the gate asks: the golden set's answerable questions, as spec 44 § 2 names them. */
export const TURN_QUESTIONS = 50;

export interface ResearchTurnsInput {
  readonly golden: ReadonlyArray<GoldenItem>;
  readonly verified: ReadonlySet<number>;
  /** The gate's own reader. */
  readonly user: SessionUser;
  readonly workers: WorkersClientDeps;
  readonly stack: StubStack;
  readonly questions?: number;
  readonly log?: (line: string) => void;
}

interface Asked {
  readonly id: string;
  readonly traceId: string;
  readonly conversationId: string;
  readonly final: Record<string, unknown> | null;
}

/** The answerable golden questions: explained, in a chapter the release verified, no refusal expected. */
export function answerableItems(golden: ReadonlyArray<GoldenItem>, verified: ReadonlySet<number>, count: number): ReadonlyArray<GoldenItem> {
  return golden.filter((item) => (item.expected.refusal ?? null) === null && item.mode === "explain" && verified.has(item.context.chapter)).slice(0, count);
}

/** What an answer is, for "unchanged": its refusal's cause and its citations, in order — what the `final` event and the row both hold. */
export function answerKeyOf(answer: { readonly refusal: string | null; readonly citations: ReadonlyArray<{ readonly sectionId: string; readonly figureId: string | null }> }): string {
  /* an array, not an object: nothing here is a line of the product's (tests/observability.test.ts reads every `{ kind:` built by hand as one) */
  return JSON.stringify([answer.refusal, answer.citations.map((citation) => [citation.sectionId, citation.figureId])]);
}

/** The `final` event's answer in that form; null where the turn ended in no `final`. */
export function finalAnswerOf(final: Record<string, unknown> | null): { readonly refusal: string | null; readonly citations: ReadonlyArray<{ readonly sectionId: string; readonly figureId: string | null }> } | null {
  if (final === null) return null;
  const refusal = final.refusal as { readonly cause?: unknown } | null | undefined;
  const citations = Array.isArray(final.citations) ? (final.citations as ReadonlyArray<{ readonly sectionId?: unknown; readonly figureId?: unknown }>) : [];
  return {
    refusal: typeof refusal?.cause === "string" ? refusal.cause : null,
    citations: citations.map((citation) => ({ sectionId: String(citation.sectionId), figureId: typeof citation.figureId === "string" ? citation.figureId : null })),
  };
}

/** Whether a `final` event carries `research` at all: since unit 75 none does (48 § 9.2). */
export function carriesResearch(final: Record<string, unknown> | null): boolean {
  return final !== null && "research" in final;
}

export async function measureResearchTurns(input: ResearchTurnsInput): Promise<TurnsFacts> {
  const log = input.log ?? (() => undefined);
  const items = answerableItems(input.golden, input.verified, input.questions ?? TURN_QUESTIONS);
  const principal = principalOf(input.user);

  const ask = async (item: GoldenItem, traceId: string = newTraceId()): Promise<Asked> => {
    const conversation = await createConversation({ ...input.user, locale: item.language }, { locale: item.language });
    const body = { conversationId: conversation.id, user: { id: input.user.id, organisationId: input.user.organisationId, role: "READER", displayName: input.user.displayName, locale: item.language }, principal, text: item.question, mode: item.mode, context: contextOf(item), aid: null };
    const text = await new Response(await workersStream("/answer", body, { traceId }, input.workers)).text();
    const final =
      text
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => TurnEventSchema.parse(JSON.parse(line)))
        .find((event) => event.event === "final")?.data ?? null;
    return { id: item.id, traceId, conversationId: conversation.id, final };
  };

  /** The answer the conversation reads back after the turn, in the key's form; null where it holds none. */
  const readBack = async (asked: Asked): Promise<string | null> => {
    const conversation = await getConversation(input.user, asked.conversationId);
    const answer = conversation?.messages.find((message) => message.role === "ASSISTANT") ?? null;
    return answer === null ? null : answerKeyOf({ refusal: answer.refusal?.cause ?? null, citations: answer.citations.map((citation) => ({ sectionId: citation.sectionId, figureId: citation.figureId })) });
  };

  const turns: Asked[] = [];
  for (const item of items) turns.push(await ask(item));
  log(`R1 · ${String(turns.length)} answerable questions asked`);

  /* one refusal of each cause (40 § 12.5): the stub is told the cause it cannot judge */
  const refused: Array<{ readonly cause: string; readonly asked: Asked }> = [];
  for (const [cause, item] of pickRefusalItems(input.golden, input.verified)) {
    const traceId = newTraceId();
    if (cause === "R-SCOPE") input.stack.expectCause(traceId, cause);
    refused.push({ cause, asked: await ask(item, traceId) });
  }

  const answered = turns.filter((asked) => asked.final?.kind === "answer");
  const changed: string[] = [];
  for (const asked of answered) {
    const shown = finalAnswerOf(asked.final);
    if (shown === null || answerKeyOf(shown) !== (await readBack(asked))) changed.push(asked.id);
  }
  /* every run row the gate's reader holds that names one of its turns' messages: none, since nothing writes one */
  const messages = (await Promise.all([...turns, ...refused.map((refusal) => refusal.asked)].map((asked) => getConversation(input.user, asked.conversationId)))).flatMap((conversation) => conversation?.messages.map((message) => message.id) ?? []);
  const runs = await withTenant(tenantOf(input.user), () => getPrisma().researchRun.count({ where: { messageId: { in: messages } } }));
  const researchCallsOf = (asked: Asked): number => input.stack.calls(asked.traceId).filter((row) => row.kind === "RESEARCH").length;
  return {
    questions: answered.length,
    withResearch: [...turns, ...refused.map((refusal) => refusal.asked)].filter((asked) => carriesResearch(asked.final)).map((asked) => asked.id),
    changed,
    runs,
    researchCalls: turns.reduce((sum, asked) => sum + researchCallsOf(asked), 0),
    refusals: refused.map(({ cause, asked }) => ({ cause, refused: asked.final?.kind === "refusal", research: carriesResearch(asked.final), researchCalls: researchCallsOf(asked) })),
  };
}

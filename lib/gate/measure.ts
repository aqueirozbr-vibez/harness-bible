import type { Aid } from "@/lib/aids/schema";
import { newTraceId } from "@/lib/api/trace";
import { getConversation, purgeAssistantText } from "@/lib/db/assistant";
import { calibrationSet } from "@/lib/db/calibration";
import { recordsAt, toChainRecord } from "@/lib/db/ledger";
import type { GateApi, GateTurn } from "@/lib/gate/api";
import {
  flagCheckOf,
  REFUSAL_CAUSES_GATED,
  refusalCheckOf,
  retentionCheckOf,
  substitutionCheckOf,
  type FlagCheck,
  type GateFinal,
  type RefusalCheck,
  type RetentionCheck,
  type RetentionSnapshot,
  type SubstitutionCheck,
} from "@/lib/gate/phase2";
import { walkCheckOf, type WalkOutcome } from "@/lib/gate/walk";
import { canonicalize, type JsonValue } from "@/lib/ledger/canonical";
import { recordHash } from "@/lib/ledger/hash";
import { SseFinalSchema } from "@/lib/schemas/api";
import { NO_COVER, WalkModeResultSchema } from "@/lib/schemas/assistant";
import type { GoldenItem } from "@/lib/schemas/golden";
import { ANSWER_DEADLINE_MS } from "@/lib/workers/client";
import en from "@/messages/en.json";

/*
 * The gate's own turns (feature-specs/22 § 3): what `npm run gate:phase2` asks through the API to measure the
 * criteria no run file holds. Each function asks, reads what came back and what the turn left in the rows, and
 * returns the facts; `lib/gate/phase2.ts` decides what they amount to.
 *
 * The turns go to workers over the stub gateway, because three of the checks need an answer made to order: a
 * classifier that names a cause, a draft with a claim its section does not support. What the stub cannot stand in
 * for is a model's judgement, and none of these criteria is about one: they are about what the product does with it.
 */

/** What the gate can ask of the stub behind the workers, by turn. `workers/gate/stubStack.ts` is the one that answers. */
export interface GateSwitches {
  /** The gateway calls a turn made, in order. */
  readonly calls: (traceId: string) => ReadonlyArray<{ readonly alias: string }>;
  /** The cause the classifier names for this turn. */
  readonly expectCause: (traceId: string, cause: string) => void;
  /** The draft of this turn carries one more claim, which its section does not support. */
  readonly expectClaim: (traceId: string, claim: "uncited") => void;
  readonly uncitedClaim: string;
}

/**
 * The turn's `final` event as the API's own schema reads it, or null when the stream ended some other way. A turn
 * the pipeline refused before any stream (a denied policy, a rate limit, a bad body) is not a measurement at all:
 * the gate stops there and says what the API answered.
 */
function finalOf(turn: GateTurn): GateFinal | null {
  if (turn.refused !== null) throw new Error(`the API answered ${String(turn.status)} to the gate's own question, before any stream: ${turn.refused.slice(0, 300)}`);
  const last = turn.events.at(-1);
  if (last === undefined || last.event !== "final") return null;
  const parsed = SseFinalSchema.safeParse(last.data);
  return parsed.success ? parsed.data : null;
}

/** The ledger record a `final` event names, with its hash computed again from its own fields. */
async function recordOf(final: GateFinal | null) {
  if (final === null) return null;
  const [row] = await recordsAt([final.ledger.seq]);
  if (row === undefined) return null;
  return { row: { seq: row.seq, kind: row.kind, payload: row.payload }, hash: row.hash, rehashed: recordHash(toChainRecord(row)) };
}

/**
 * P2.2: one question per cause, each in a conversation of its own. No turn is asked from anywhere (feature-specs/23
 * § 8): the unverified-chapter question refuses because it names its chapter, not because of where it is asked.
 * The classifier's cause is the stub's to be told; the three rule causes are the flow's own. A cause the golden set
 * has no question for is left out, and the criterion reports it as not asked.
 */
export async function measureRefusals(api: GateApi, switches: GateSwitches, picked: ReadonlyMap<string, GoldenItem>): Promise<ReadonlyArray<RefusalCheck>> {
  const checks: RefusalCheck[] = [];
  for (const cause of REFUSAL_CAUSES_GATED) {
    const item = picked.get(cause);
    if (item === undefined) continue;
    const traceId = newTraceId();
    if (cause === "R-SCOPE") switches.expectCause(traceId, cause);
    const conversationId = await api.open({ locale: item.language });
    const turn = await api.ask(conversationId, { text: item.question, mode: item.mode }, traceId);
    const final = finalOf(turn);
    checks.push(refusalCheckOf(cause, final, switches.calls(traceId), await recordOf(final)));
  }
  return checks;
}

/**
 * P2.3: a question the stub answers with one claim too many. What is read: every `token` event's text, joined,
 * because a sentence can straddle two deltas; the `final` event's claims; and the text the row keeps.
 */
export async function measureSubstitution(api: GateApi, switches: GateSwitches, item: GoldenItem): Promise<SubstitutionCheck> {
  const traceId = newTraceId();
  switches.expectClaim(traceId, "uncited");
  const conversationId = await api.open({ locale: item.language });
  const turn = await api.ask(conversationId, { text: item.question, mode: item.mode }, traceId);
  const final = finalOf(turn);
  const tokens = turn.events.flatMap((event) => (event.event === "token" && typeof event.data.text === "string" ? [event.data.text] : [])).join("");
  const stored = final === null ? null : ((await getConversation(api.user, conversationId))?.messages.find((message) => message.id === final.messageId)?.text ?? null);
  return substitutionCheckOf({ tokens, final, stored, sentence: NO_COVER[item.language], claim: switches.uncitedClaim });
}

/** An answer of the gate's own: what the flag names and the purge is watched on. */
export interface GateAnswer {
  readonly conversationId: string;
  readonly messageId: string;
  readonly ledgerSeq: number;
}

/** The reason the gate's flag gives: one of the coded reasons for an answer (feature-specs/15 § 5.4). */
const FLAG_REASON = "wrong_citation";

/**
 * P2.6a: an ordinary question, its answer flagged through the API, then looked for in the calibration set. The
 * answer is returned too, because the purge of P2.6b is watched on the same turn: a flag is among the things it keeps.
 */
export async function measureFlag(api: GateApi, item: GoldenItem): Promise<{ readonly check: FlagCheck; readonly answer: GateAnswer | null }> {
  const conversationId = await api.open({ locale: item.language });
  const final = finalOf(await api.ask(conversationId, { text: item.question, mode: item.mode }, newTraceId()));
  /* No answer to flag: the turn failed or refused, and the criterion says the flag was not accepted. */
  if (final === null || final.refusal !== null) return { check: flagCheckOf(false, null, { reason: FLAG_REASON, grounded: null, verdicts: 0 }), answer: null };

  const flagged = await api.flag(final.messageId, { kind: "answer", reason: FLAG_REASON });
  const row = (await calibrationSet()).find((candidate) => candidate.messageId === final.messageId) ?? null;
  return {
    check: flagCheckOf(flagged.status >= 200 && flagged.status < 300, row === null ? null : { reason: row.flag.reason, grounded: row.grounded, verdicts: row.verdicts.length }, { reason: FLAG_REASON, grounded: final.grounded, verdicts: final.verdicts.length }),
    answer: { conversationId, messageId: final.messageId, ledgerSeq: final.ledger.seq },
  };
}

/** The conversation as it stands: its words, the answer's citations and verdicts, and the answer's ledger record. */
async function snapshotOf(api: GateApi, answer: GateAnswer): Promise<RetentionSnapshot> {
  const view = await getConversation(api.user, answer.conversationId);
  const message = view?.messages.find((candidate) => candidate.id === answer.messageId);
  const [record] = await recordsAt([answer.ledgerSeq]);
  return {
    textPurgedAt: view !== null && view !== undefined && view.textPurgedAt !== null,
    texts: view?.messages.map((candidate) => candidate.text) ?? [],
    citations: message?.citations ?? [],
    verdicts: message?.verdicts ?? [],
    ledger: record === undefined ? null : { hash: record.hash, payload: canonicalize(record.payload as JsonValue) },
  };
}

/** How far ahead the gate moves the purge's clock: one day past the 30 the reader's words are kept. */
const PURGE_AHEAD_DAYS = 31;

/**
 * P2.6b: the retention purge with its clock 31 days ahead, on the gate's own reader and nobody else
 * (`purgeAssistantText`'s `reader`), watched on the answer P2.6a flagged. It runs the product's own purge, so the
 * gate's other conversations lose their words too; they are the gate's, and the next run replaces them.
 */
export async function measureRetention(api: GateApi, answer: GateAnswer): Promise<RetentionCheck> {
  const before = await snapshotOf(api, answer);
  await purgeAssistantText({ now: new Date(Date.now() + PURGE_AHEAD_DAYS * 86_400_000), abandonedAfterMs: ANSWER_DEADLINE_MS, reader: api.user.id });
  return retentionCheckOf(before, await snapshotOf(api, answer));
}

/**
 * P2.4: one aid walked at its own defaults, which are the book's inputs, as the dock walks it: the same line in
 * place of a question, the aid and its inputs, from the aid's own section. The turn runs the release's script
 * before any model is asked; what comes back is compared with the release's own run of the same lab.
 */
export async function measureWalk(api: GateApi, aid: Aid, releaseResults: unknown): Promise<WalkOutcome> {
  const inputs = Object.fromEntries(aid.inputs.map((input) => [input.key, input.default]));
  const conversationId = await api.open({ locale: "en" });
  const body = { text: en.assistant.walk.userLine.replace("{section}", aid.section), mode: "walk", aidId: aid.id, aidInputs: inputs };
  const turn = await api.ask(conversationId, body, newTraceId());
  const final = finalOf(turn);
  if (final === null) {
    const last = turn.events.at(-1);
    return { kind: "failed", code: last?.event === "error" && typeof last.data.code === "string" ? last.data.code : "NO_FINAL" };
  }
  if (final.refusal !== null) return { kind: "refused", cause: final.refusal.cause };
  const result = WalkModeResultSchema.safeParse(final.modeResult);
  if (!result.success) return { kind: "failed", code: "NO_WALK_RESULT" };
  return { kind: "walked", check: walkCheckOf(aid, { result: result.data, derive: final.verdicts.find((verdict) => verdict.sensor === "derive")?.detail ?? null }, releaseResults) };
}

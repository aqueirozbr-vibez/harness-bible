import { z } from "zod";

import { findAid } from "@/lib/aids/index";
import { aidResultForPrompt, runFailed } from "@/lib/aids/turn";
import type { SessionUser } from "@/lib/auth/session";
import { appendAssistantMessage, appendFailedTurn, appendUserMessage, attachLedger, deriveLinesOf, getConversation } from "@/lib/db/assistant";
import { AppError } from "@/lib/errors";
import { BudgetExceededError, GatewayUnavailableError } from "@/lib/gateway/errors";
import { labModeResultOf } from "@/lib/labs/pseudoSections";
import { append } from "@/lib/ledger/append";
import { sha256Hex } from "@/lib/ledger/hash";
import { ASSISTANT_GUIDE_VERSION, type AnswerRequest, type ConversationTurn, type Mode, type WalkModeResult } from "@/lib/schemas/assistant";
import type { Principal } from "@/lib/schemas/gateway";
import { parseReleaseId, parseSectionId, type SectionId } from "@/lib/schemas/ids";
import { processSecrets } from "@/lib/security/processSecrets";
import { redactSecrets } from "@/lib/security/redact";
import { answerLineOf, failedAnswerLine, logAidRun, logAnswer } from "@/lib/telemetry/lines";
import { runAidForTurn, type AidTurnOptions, type AidTurnRun } from "@/workers/aids/run";
import { labChapterOf } from "@/workers/answer/lab";
import { runAnswer, sectionFacts, type RunDeps } from "@/workers/answer/run";

/*
 * One turn, inside the workers (feature-specs/15 § 6.3). The order matters and is the reason this is its own
 * file: the reader's question is written **before** the flow runs, so a crash leaves the question on the record
 * rather than losing it, and the answer's row and its ledger record are written together afterwards.
 *
 * The events it emits are the stream's (§ 6.1): `meta` once the question is recorded, `status` at each step,
 * `token` for each delta of the draft, and exactly one of `final` or `error`. A refusal is a `final`, not an
 * error: the assistant refusing is the assistant working (code-standards § API Routes).
 *
 * A walk turn (spec 18 § 4) runs the aid's script before any model is asked: `status: running`, the container, and
 * then the flow with the script's values fenced in the prompt. A script that does not finish ends the turn here, as
 * an error event and a failed-turn row, and no model call is spent on it (§ 7).
 */

const MODE_ROWS: Readonly<Record<Mode, "EXPLAIN" | "COMPARE" | "WALK" | "LAB" | "BRIEF">> = {
  explain: "EXPLAIN",
  compare: "COMPARE",
  walk: "WALK",
  lab: "LAB",
  brief: "BRIEF",
};

export interface TurnInput {
  readonly conversationId: string;
  readonly user: SessionUser;
  readonly principal: Principal;
  readonly text: string;
  readonly mode: Mode;
  readonly context: { readonly chapters?: readonly [number, number]; readonly labId?: string } | null;
  /** walk mode: the aid and the inputs the web tier validated against its ranges (spec 18 § 6); null otherwise. */
  readonly aid?: { readonly id: string; readonly inputs: Readonly<Record<string, number>> } | null;
  readonly traceId: string;
}

export type TurnEvent =
  | { readonly event: "meta"; readonly data: Record<string, unknown> }
  | { readonly event: "status"; readonly data: { readonly step: string } }
  | { readonly event: "token"; readonly data: { readonly text: string } }
  | { readonly event: "final"; readonly data: Record<string, unknown> }
  | { readonly event: "error"; readonly data: { readonly code: string; readonly message: string; readonly traceId: string; readonly resetsAt?: string; readonly detail?: Record<string, unknown> } };

export type Emit = (event: TurnEvent) => void;

export interface TurnDeps {
  readonly run?: typeof runAnswer;
  readonly facts?: typeof sectionFacts;
  readonly gateway: RunDeps["gateway"];
  readonly chaptersVerified: RunDeps["chaptersVerified"];
  /** The chapter of the lab a lab turn picked; the database by default, a test passes its own. */
  readonly labChapter?: typeof labChapterOf;
  readonly now?: () => number;
  /** The walk's runner (spec 18 § 4): the container by default, a local interpreter where there is none, and the aids folder for a test's own aid. */
  readonly aid?: AidTurnOptions & { readonly aidsDir?: string; readonly runAid?: typeof runAidForTurn };
}

/** The earlier turns the prompt may read: newest last, and a purged turn is omitted rather than blanked (§ 6.3). */
function conversationTurns(messages: ReadonlyArray<{ readonly role: string; readonly text: string | null; readonly refusal: { readonly cause: string } | null }>): ReadonlyArray<ConversationTurn> {
  return messages
    .filter((message) => message.text !== null)
    .map((message) => ({
      role: message.role === "USER" ? ("user" as const) : ("assistant" as const),
      text: message.text ?? "",
      refusal: (message.refusal?.cause ?? null) as ConversationTurn["refusal"],
    }));
}

/** The flow's walk result after the derive sensor (`workers/answer/flow.ts`): the explanations as the reader sees them. */
const FlowWalkSchema = z.object({ steps: z.array(z.object({ ordinal: z.number().int(), explained: z.string(), withheld: z.boolean() })) });

function explanationsOf(modeResult: unknown): WalkModeResult["explanations"] {
  const parsed = FlowWalkSchema.safeParse(modeResult);
  return parsed.success ? parsed.data.steps.map((step) => ({ ordinal: step.ordinal, text: step.explained, withheld: step.withheld })) : [];
}

/** What the `final` event carries and the row stores for a walk turn: the run and values, plus the checked explanations (spec 18 § 6, D4). */
function walkModeResult(aid: AidTurnRun, flowModeResult: unknown): WalkModeResult {
  /* The hashes stay in the ledger record; the reader's screen gets the run, the values and the explanations. */
  const { aidId, inputs, run, pricesVerifiedAt, sameAsBook, steps } = aid.result;
  return { aidId, inputs, run, pricesVerifiedAt, sameAsBook, steps, explanations: explanationsOf(flowModeResult) };
}

export async function runTurn(input: TurnInput, emit: Emit, deps: TurnDeps): Promise<void> {
  const run = deps.run ?? runAnswer;
  const facts = deps.facts ?? sectionFacts;
  const runAid = deps.aid?.runAid ?? runAidForTurn;
  const started = performance.now();
  /* A secret pasted into a question is removed here, before the question is stored and before anything reads it:
     the row, the fence, the classifier, the ledger's hash and the reader's own turn all carry `[redacted:…]`
     (feature-specs/21 § 6.2, D5). The model has no use for a key, and 30 days is too long to keep one. */
  const redaction = redactSecrets(input.text, processSecrets());
  const text = redaction.text;

  const conversation = await getConversation(input.user, input.conversationId);
  if (conversation === null) throw new AppError("NOT_FOUND", "no such conversation");
  const locale = conversation.locale === "pt" ? "pt" : "en";
  /* What the turn's own line and span say of it, whichever way it ends (feature-specs/21 § 5.1): ids and measures, never the words. */
  const turnOf = (messageId: string) => ({ traceId: input.traceId, messageId, mode: input.mode, locale, secretsRedacted: redaction.findings.length, ms: Math.round(performance.now() - started) }) as const;

  /* The question is written first: a crash after this loses an answer, not a reader's words. A walk's inputs go
     on the same row (spec 18 D4). */
  const asked = await appendUserMessage(input.user, input.conversationId, { text, mode: input.mode, traceId: input.traceId, aidInputs: input.aid?.inputs ?? null });

  emit({
    event: "meta",
    data: {
      messageId: asked.id,
      conversationId: input.conversationId,
      ordinal: asked.ordinal,
      traceId: input.traceId,
      mode: input.mode,
      guide: { version: ASSISTANT_GUIDE_VERSION },
      alias: "hb-frontier",
      /* The question as it was stored, when that is not what was sent: the reader's own turn shows the mark. */
      ...(redaction.findings.length === 0 ? {} : { question: text }),
    },
  });

  let aidRun: AidTurnRun | null = null;
  try {
    /* What the turn's mode works on (feature-specs/23 § 5.1): the aid's chapter and its own section in a walk, the
       lab's chapter in lab mode, nothing in the rest. A conversation has no chapter to fall back on since Assistant
       2.0, and whatever chapter a client sends is not read: the target is resolved here, from the aid and the lab. */
    const walked = input.mode === "walk" && input.aid !== null && input.aid !== undefined ? findAid(input.aid.id, deps.aid?.aidsDir) : null;
    const labChapter = input.mode === "lab" && input.context?.labId !== undefined ? await (deps.labChapter ?? labChapterOf)(conversation.releaseId, input.context.labId) : null;
    const asked_of: AnswerRequest = {
      releaseId: parseReleaseId(conversation.releaseId),
      locale,
      mode: input.mode,
      context: {
        chapter: walked?.chapter ?? labChapter,
        section: walked === null ? null : parseSectionId(walked.section),
        ...(input.context?.chapters === undefined ? {} : { chapters: input.context.chapters }),
        ...(input.context?.labId === undefined ? {} : { labId: input.context.labId }),
      },
      question: text,
      conversation: conversationTurns(conversation.messages),
      aidResult: null,
      principal: input.principal,
      traceId: input.traceId,
    };

    if (input.mode === "walk") {
      /* The script first, in its container, before a model is asked anything (spec 18 § 4 steps 1–3). The web tier
         already checked the aid and the inputs, so a missing aid here is a defect, not a reader's mistake. A chapter
         the release has not verified refuses before anything is spent (spec 13 § 4.1): no run for a walk the flow is
         about to refuse — the flow then refuses it as it refuses any question of that chapter. */
      const aid = input.aid === null || input.aid === undefined ? null : findAid(input.aid.id, deps.aid?.aidsDir);
      if (aid === null || input.aid === null || input.aid === undefined) throw new AppError("AID_UNKNOWN", "a walk turn needs the aid the web tier validated (feature-specs/18 § 6)");
      if (await deps.chaptersVerified(asked_of)) {
        emit({ event: "status", data: { step: "running" } });
        aidRun = await runAid(aid, input.aid.inputs, conversation.releaseId, deps.aid ?? {});
        logAidRun({ traceId: input.traceId, aidId: aid.id, runner: deps.aid?.runner ?? "docker", exitCode: aidRun.run.exitCode, timedOut: aidRun.run.timedOut, ms: aidRun.run.ms });
        if (runFailed(aidRun.run)) {
          const { exitCode, timedOut, ms } = aidRun.run;
          console.warn("aid run failed", input.traceId, aid.id, `exit ${String(exitCode)}`, timedOut ? "timed out" : "", aidRun.run.stderr.slice(-400));
          const failed = await appendFailedTurn(input.user, input.conversationId, {
            ordinal: asked.ordinal + 1,
            mode: MODE_ROWS[input.mode],
            traceId: input.traceId,
            code: "AID_RUN_FAILED",
            data: { exitCode: exitCode ?? "none", timedOut, ms },
          });
          logAnswer(failedAnswerLine(turnOf(failed.id), "AID_RUN_FAILED"));
          emit({ event: "error", data: { code: "AID_RUN_FAILED", message: "the script did not finish at these inputs; nothing was explained", traceId: input.traceId, detail: { exitCode, timedOut, ms } } });
          return;
        }
      }
    }

    const request: AnswerRequest = aidRun === null ? asked_of : { ...asked_of, aidResult: aidResultForPrompt(aidRun.result) };

    const { titles, versions } = await facts(conversation.releaseId);

    const { result, overBudget, promptSha256, lab } = await run(
      request,
      {
        token: (text) => {
          emit({ event: "token", data: { text } });
        },
        status: (step) => {
          emit({ event: "status", data: { step } });
        },
        /* The repair's cause goes to the workers' log with the trace id, never to the reader: it names the schema
           field the draft missed, which is what an operator needs to tune the guide (feature-specs/13 § 8). */
        onRepair: (instruction) => {
          console.warn("repair", input.traceId, input.mode, instruction.slice(0, 600));
        },
      },
      { gateway: deps.gateway, releaseVersions: versions, titles, chaptersVerified: deps.chaptersVerified, now: deps.now },
    );

    /* A walk's result carries the run and the values; a lab's carries the run the model read (spec 19 § 6.2). */
    const modeResult: unknown =
      aidRun !== null ? walkModeResult(aidRun, result.modeResult) : lab !== null && result.kind === "answer" ? labModeResultOf(result.modeResult, lab) : result.modeResult;

    const message = await appendAssistantMessage(input.user, input.conversationId, result, {
      ordinal: asked.ordinal + 1,
      mode: MODE_ROWS[input.mode],
      traceId: input.traceId,
      promptSha256,
      overBudget,
      ledger: null,
      modeResult,
    });

    /* The record carries hashes of the words, never the words: a purged conversation still matches its record
       (feature-specs/14 § 6, invariant 18). A walk's inputs and values are hashed the same way (spec 18 § 4). */
    const record = await append({
      kind: "ANSWER",
      actor: `user:${input.user.id}`,
      suggestionId: null,
      chapterVersionId: null,
      payload: {
        messageId: message.id,
        conversationId: input.conversationId,
        releaseId: conversation.releaseId,
        mode: input.mode,
        refusal: result.refusal === null ? null : { cause: result.refusal.cause, beforeRetrieval: result.refusal.beforeRetrieval },
        citations: result.citations.map((citation) => ({ sectionId: citation.sectionId, figureId: citation.figureId, version: citation.version, editionLang: citation.editionLang })),
        claims: { total: result.claims.length, substituted: result.claims.filter((claim) => claim.substituted).length },
        verdicts: result.verdicts.map((verdict) => ({ sensor: verdict.sensor, verdict: verdict.verdict })),
        grounded: result.grounded,
        repaired: result.repaired,
        guide: result.guide,
        modelId: result.modelId,
        promptSha256: promptSha256 ?? sha256Hex(""),
        questionSha256: sha256Hex(text),
        answerSha256: sha256Hex(result.claims.map((claim) => claim.text).join(" ")),
        timings: { firstTokenMs: result.timings.firstTokenMs, totalMs: result.timings.totalMs },
        usage: result.usage,
        traceId: input.traceId,
        ...(aidRun === null
          ? {}
          : { aid: { id: aidRun.result.aidId, inputsSha256: aidRun.result.inputsSha256, runMs: aidRun.run.ms, exitCode: aidRun.run.exitCode, valuesSha256: aidRun.result.valuesSha256 } }),
      },
    });

    await attachLedger(input.user, message.id, { seq: record.seq, hash: record.hash });
    logAnswer(answerLineOf(turnOf(message.id), result));

    /* Nothing is handed to research any more (feature-specs/48 § 9.2, A2; unit 75): research is a person's to start, from
       the answer's `Start a research`, which writes nothing until they press Start on the Research page. So no run row,
       no mark and no workflow follow a turn, and the `final` event carries no `research`; `SseFinalSchema.research`
       stays optional for the stored finals of earlier turns, which a replay still reads. */

    /* The derive lines of what was cited travel with the answer (feature-specs/23 § 7.3): the dock may be open on
       any page, so it cannot read them from the section beside it. A failed read costs the marks, not the answer. */
    const derives = await deriveLinesOf(conversation.releaseId, result.citations.flatMap((citation) => (citation.figureId === null ? [] : [citation.figureId]))).catch(() => new Map<string, number>());

    emit({
      event: "final",
      data: {
        messageId: message.id,
        ordinal: asked.ordinal + 1,
        kind: result.kind,
        refusal: result.refusal,
        claims: result.claims,
        citations: result.citations,
        verdicts: result.verdicts,
        grounded: result.grounded,
        repaired: result.repaired,
        citesEdition: result.citations[0]?.editionLang ?? null,
        timings: result.timings,
        usage: result.usage,
        overBudget,
        ledger: { seq: record.seq, hash: record.hash, prevHash: record.prevHash },
        modeResult: modeResult ?? null,
        derives: [...derives].map(([figureId, line]) => ({ figureId, line })),
      },
    });
  } catch (error: unknown) {
    /* The turn failed after the question was recorded, so the question does not stand alone: the `ASSISTANT` row
       is written as a failed turn and no ledger record is appended, because nothing was answered (§ 6.3 step 4).
       The budget and an unreachable gateway are the two the reader is told about by name (§ 6.1); anything else
       is an internal failure whose cause stays in the log. */
    const failure = failureOf(error);
    if (failure.code === "INTERNAL") console.error("turn failed", input.traceId, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    const failed = await appendFailedTurn(input.user, input.conversationId, { ordinal: asked.ordinal + 1, mode: MODE_ROWS[input.mode], traceId: input.traceId, code: failure.code });
    logAnswer(failedAnswerLine(turnOf(failed.id), failure.code));
    emit({ event: "error", data: { ...failure, traceId: input.traceId } });
  }
}

/** The error's code as the stream names it, and the budget's reset for the dock's 402 line (§ 6.1). */
function failureOf(error: unknown): { readonly code: string; readonly message: string; readonly resetsAt?: string } {
  if (error instanceof BudgetExceededError) return { code: "BUDGET_EXCEEDED", message: error.message, resetsAt: error.resetsAt.toISOString() };
  if (error instanceof GatewayUnavailableError) return { code: "ASSISTANT_UNAVAILABLE", message: error.message };
  if (error instanceof AppError && error.code === "AID_UNKNOWN") return { code: error.code, message: error.message };
  return { code: "INTERNAL", message: "the turn did not complete" };
}

export type { SectionId };

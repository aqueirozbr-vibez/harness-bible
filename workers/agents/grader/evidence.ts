import { createHash } from "node:crypto";

import { callModel, defaultGatewayDeps, type GatewayDeps } from "@/lib/gateway/client";
import { BudgetExceededError, GatewayRefusedError, GatewayUnavailableError, ProviderRefusalError } from "@/lib/gateway/errors";
import { requestFor } from "@/lib/gateway/policy";
import { ALIAS_PINS } from "@/lib/gateway/prices";
import { stakeOf } from "@/lib/improve/independence";
import { checkGraderBytes, requestWithinLimit } from "@/lib/improve/media";
import { adjustedOf, factorsOf, type Factors } from "@/lib/rubric/score";
import { principalId, type GatewayCall, type Principal } from "@/lib/schemas/gateway";
import type { Relevance, Stake } from "@/lib/schemas/rubric";

import { assembleEvidenceGrader, type EvidenceGraderInput, type EvidencePrompt } from "./assemble";
import { parseEvidenceGrade, type GraderTier } from "./parse";

/*
 * One evidence item graded (feature-specs/32 § 7): the prompt of assemble.ts through the gateway client on the
 * `evidenceGrader` row, the output through parse.ts, and the classifications turned into numbers by `lib/rubric`
 * so that a model's output is never a number of the score (invariant 8). One attempt (invariant 15): a gateway
 * failure, a provider's refusal or an output the parser refuses is tier `U` with the reason and the item is graded
 * all the same — nothing waits for a second try. A budget refusal is the one exception and is thrown: the item is
 * to stay pending with the reset date, not to be graded `U` for lack of budget (§ 8), which is the workflow's to do.
 *
 * Independence is decided here and not in the prompt (§ 7.4): the contributor's address is read for the one
 * comparison with the publisher's domain and goes nowhere near the model. The date is the document's own metadata
 * first, the grader's only when the document stated none (§ 7.2), and the age is counted on the day of grading.
 *
 * A PDF or an image (unit 49f, § 9) is checked before it is sent against what the provider documents it takes
 * (`lib/improve/media.ts`), and the whole request against the provider's request size: what code can see the
 * provider would refuse is `U` by intake rules with the check's code and no call; what code cannot see — a PDF's
 * pages, its encryption — is the provider's refusal, `U` with the gateway's status, as any refusal is. Such a call
 * names its own request row (`evidenceGraderBytes`: one try, no retry that would re-send 32 MB).
 */

export const EVIDENCE_GRADER_REQUEST = requestFor("evidenceGrader");
/** A PDF's or an image's request, from its own row: the same today, and a change to that row applies to the body too. */
export const EVIDENCE_GRADER_BYTES_REQUEST = requestFor("evidenceGraderBytes");

export interface GradeIndependence {
  /** The publisher's host as the fetcher saw it; null for an upload. */
  readonly publisherHost: string | null;
  /** The contributor's verified e-mail address; null for a researcher's suggestion. */
  readonly contributorEmail: string | null;
}

export interface GradeCall {
  readonly principal: Principal;
  readonly traceId: string;
  /** The suggestion's id. */
  readonly ref: string;
}

export interface GradeEvidenceInput {
  readonly prompt: EvidenceGraderInput;
  readonly independence: GradeIndependence;
  readonly call: GradeCall;
}

export interface GradeDeps {
  readonly gateway: GatewayDeps;
  readonly now: () => Date;
}

export const defaultGradeDeps = (): GradeDeps => ({ gateway: defaultGatewayDeps(), now: () => new Date() });

interface GradeCommon {
  /**
   * sha256 of what the grader read (§ 5): the text, cut or whole, which the item's `text` key holds; or, since unit
   * 49f, the PDF's or the image's bytes, which the item's `text` key holds as a copy of its source as it was opened.
   */
  readonly contentSha256: string;
  /** The text the grader read; null for a PDF or an image. */
  readonly text: string | null;
  readonly truncated: boolean;
  readonly reason: string;
  /** The model that answered, or `intake-rules` when none did. */
  readonly gradedBy: string;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly cacheReadTokens: number } | null;
}

export interface Graded extends GradeCommon {
  readonly graded: true;
  readonly tier: GraderTier;
  readonly relevance: Relevance;
  readonly stake: Stake;
  /** The document's own date, else the grader's; null when neither. */
  readonly publishedOn: string | null;
  readonly ageDays: number | null;
  readonly factors: Factors;
  readonly base: number;
  readonly adjusted: number;
}

export interface Unverifiable extends GradeCommon {
  readonly graded: false;
  readonly tier: "U";
}

export type EvidenceGrade = Graded | Unverifiable;

const MS_PER_DAY = 86_400_000;

/** Whole days from the date to today; a date in the future is today. */
export function ageDaysOf(publishedOn: string | null, today: Date): number | null {
  if (publishedOn === null) return null;
  const published = Date.parse(`${publishedOn}T00:00:00Z`);
  if (!Number.isFinite(published)) return null;
  return Math.max(0, Math.floor((today.getTime() - published) / MS_PER_DAY));
}

/**
 * The call and the request a grade makes: the `evidenceGrader` row for a text, and for a PDF or an image the row of
 * its own, which the call names (unit 49f). One place, so that what is measured is what is sent.
 */
export function gradeRequestOf(input: GradeEvidenceInput, prompt: EvidencePrompt = assembleEvidenceGrader(input.prompt)) {
  const bytes = input.prompt.document.content.kind === "bytes";
  const call: GatewayCall = {
    purpose: "grading",
    alias: "hb-small",
    agent: bytes ? "evidence.grade.bytes" : "evidence.grade",
    guide: { agent: "grader", version: input.prompt.guide.version, sha256: input.prompt.guide.sha256 },
    principal: input.call.principal,
    traceId: input.call.traceId,
    ref: input.call.ref,
    ...(bytes ? { row: "evidenceGraderBytes" as const } : {}),
  };
  const params = bytes ? EVIDENCE_GRADER_BYTES_REQUEST : EVIDENCE_GRADER_REQUEST;
  const request = { ...params, system: [...prompt.system], messages: prompt.messages.map((entry) => ({ role: entry.role, content: typeof entry.content === "string" ? entry.content : [...entry.content] })) };
  return { call, request };
}

/**
 * An upper bound of the body the provider receives for this request (§ 9: the 32 MB is the whole payload's). The
 * gateway client adds the principal to `metadata` and the proxy names the pinned model (lib/gateway/client.ts;
 * litellm.yaml), and the proxy re-serialises the body with Python's `json.dumps` before sending it (LiteLLM 1.102.1,
 * read in unit 49f), which escapes a character outside ASCII as `\uXXXX` and puts a space after each separator: at
 * most three bytes for every byte of the rest (a two-byte character becomes six) — except U+007F, the one ASCII
 * character it escapes and JavaScript does not, which becomes six bytes from one. The base64 is ASCII with no
 * separator and passes unchanged, so it is counted as it is, the rest three times and each U+007F three times more,
 * without building the whole body as a second string.
 */
export function requestBytesBound(request: object, call: GatewayCall): number {
  let base64 = 0;
  const wire = { ...request, model: ALIAS_PINS[call.alias] ?? call.alias, metadata: { user_id: principalId(call.principal) } };
  const rest = JSON.stringify(wire, (key: string, value: unknown) => {
    if (key === "data" && typeof value === "string") {
      base64 += value.length;
      return "";
    }
    return value;
  });
  const deletes = rest.split("\u007f").length - 1;
  return base64 + 3 * Buffer.byteLength(rest) + 3 * deletes;
}

function failureReason(error: unknown): string {
  if (error instanceof GatewayUnavailableError) return `gateway unavailable (${error.cause})`;
  if (error instanceof GatewayRefusedError) return `gateway refused (${String(error.status)})`;
  if (error instanceof ProviderRefusalError) return `provider refusal (${error.category ?? "unspecified"})`;
  return "grading failed before an answer";
}

export async function gradeEvidence(input: GradeEvidenceInput, deps: GradeDeps = defaultGradeDeps()): Promise<EvidenceGrade> {
  const prompt = assembleEvidenceGrader(input.prompt);
  const { content } = input.prompt.document;
  const contentSha256 = createHash("sha256")
    .update(content.kind === "bytes" ? content.data : (prompt.text ?? ""))
    .digest("hex");
  const common = { contentSha256, text: prompt.text, truncated: prompt.truncated };
  const unverifiable = (reason: string): Unverifiable => ({ ...common, graded: false, tier: "U", reason, gradedBy: "intake-rules", usage: null });
  if (content.kind === "bytes") {
    const refusal = checkGraderBytes(content.data, content.mediaType);
    if (refusal !== null) return unverifiable(refusal);
  }
  const { call, request } = gradeRequestOf(input, prompt);
  /* The provider counts the whole payload against its request limit, the base64 of a PDF included (§ 9). */
  if (!requestWithinLimit(requestBytesBound(request, call))) return unverifiable("request_too_large");

  let answered: { readonly text: string; readonly model: string; readonly usage: GradeCommon["usage"] };
  try {
    const message = await callModel(call, request, deps.gateway);
    answered = {
      text: message.content.map((block) => ("text" in block ? block.text : "")).join(""),
      model: message.model,
      usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens, cacheReadTokens: message.usage.cache_read_input_tokens ?? 0 },
    };
  } catch (error: unknown) {
    if (error instanceof BudgetExceededError) throw error;
    return unverifiable(failureReason(error));
  }

  const parsed = parseEvidenceGrade(answered.text);
  if (!parsed.ok) return { ...common, graded: false, tier: "U", reason: parsed.reason, gradedBy: answered.model, usage: answered.usage };

  const { grade } = parsed;
  const publishedOn = input.prompt.document.publishedOn ?? grade.publishedOn;
  const ageDays = ageDaysOf(publishedOn, deps.now());
  const stake = stakeOf({ graderStake: grade.stake, publisherHost: input.independence.publisherHost, contributorEmail: input.independence.contributorEmail });
  const factors = factorsOf(input.prompt.rubric, { relevance: grade.relevance, stake, ageDays }, input.prompt.anchor.fastMoving);
  return {
    ...common,
    graded: true,
    tier: grade.tier,
    relevance: grade.relevance,
    stake,
    publishedOn,
    ageDays,
    factors,
    base: input.prompt.rubric.tiers[grade.tier].base,
    adjusted: adjustedOf(input.prompt.rubric, grade.tier, factors),
    reason: grade.reason,
    gradedBy: answered.model,
    usage: answered.usage,
  };
}

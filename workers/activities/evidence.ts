import { createHash, randomBytes } from "node:crypto";
import type { Readable } from "node:stream";

import { ApplicationFailure } from "@temporalio/activity";

import { contributorForGrading, type ContributorForGrading } from "@/lib/db/account";
import type { Principal } from "@/lib/schemas/gateway";
import { researchPrincipalOf } from "@/workers/research/plan";
import { resolveAnchor, type ResolvedAnchor } from "@/lib/db/anchors";
import { contributorIdOf, readEvidenceAsService, readRubricVersion, writeEvidenceFetched, writeEvidenceGraded, writeEvidencePending, writeEvidenceTextKey, type EvidenceForService, type RubricVersionRow, type ServiceCaller } from "@/lib/db/improve";
import { BudgetExceededError } from "@/lib/gateway/errors";
import { loadGuide, type Guide } from "@/lib/guides/load";
import { checkGraderBytes, isGraderBytesType } from "@/lib/improve/media";
import { fastMovingOf, proposalTexts } from "@/lib/improve/proposal";
import { loadRubric, type LoadedRubric } from "@/lib/rubrics/load";
import { ProposalSchema } from "@/lib/schemas/improve";
import type { Locale } from "@/lib/i18n/routing";
import { evidenceSourceKey, evidenceTextKey, type ObjectKey } from "@/lib/schemas/storage";
import { objectStore, type ObjectStore } from "@/lib/storage";
import { cutDocument, DOCUMENT_CHARS_MAX, type EvidenceContent } from "@/workers/agents/grader/assemble";
import { gradeEvidence, type EvidenceGrade, type GradeEvidenceInput } from "@/workers/agents/grader/evidence";
import { openDoi, type DoiOutcome } from "@/workers/fetch/doi";
import { charsetOf, fetchEvidence, type FetchOutcome } from "@/workers/fetch/fetch";
import { decodeDocument, extractHtml } from "@/workers/fetch/html";

import type { EvidenceActivities } from "../workflows/activities";

/*
 * GradeEvidenceWorkflow's activities (feature-specs/32 § 8), as the grader service: `fetchItem` opens the item —
 * a link through the fetcher, a DOI through the opener, an upload through the store — and writes what it found on
 * the row, the bytes under the item's `source` key, and for an item that could not be opened the `U` grade itself
 * (§ 4.4: unreachable or unsupported is `U` by intake rules, no model called); `storeText` reads the source back,
 * extracts the text as the fetcher would, cuts it to the grader's ceiling and stores exactly that under the `text`
 * key with its hash on the row (§ 5: a curator who doubts a grade opens what was graded); `gradeItem` reads that
 * text and the suggestion, grades through the evidence grader, and writes the grade — or, when the principal's
 * budget refused it, the reason and the reset date on a row that stays pending (§ 8).
 *
 * A PDF or an image (unit 49f, § 9) has no text to extract: the grader reads its bytes as the provider's own
 * document or image content, so `storeText` checks them against what the provider documents it takes — the type
 * the bytes themselves say, the size, an image's sides (`lib/improve/media.ts`) — and copies them under the item's
 * `text` key, which only this activity writes, so what the grader read is kept whatever later happens to the source;
 * a file the provider would refuse is `U` by intake rules with the check's reason, and no model is called.
 *
 * What `storeText` reads must be what was opened: an upload's source is under the key its ticket signed, which the
 * contributor may PUT again until the ticket expires, so an upload whose sha256 is no longer the one `fetchItem`
 * recorded is `U` (`source_changed`) and nothing of it is graded; a link's or a DOI's source, which only `fetchItem`
 * writes, is not checked. A text upload of up to D2's 100 MB is hashed
 * whole and read only as far as the grader can use: the first TEXT_HEAD_BYTES, four bytes for each of the
 * DOCUMENT_CHARS_MAX characters it can read (UTF-8's widest); a text cut there or by `cutDocument` is stored with
 * `truncated=true` on its type, so the fence says so (§ 7.5). A fetched page keeps the charset its response named.
 *
 * Each is idempotent on the row: an item already fetched, stored or graded is answered from the row and nothing is
 * done twice, so the engine may run any of them again. Nothing of the contributor is near a prompt: the address is
 * read for `stakeOf` alone, and the suggestion's row carries no name (invariant 12).
 */

export const GRADER_GUIDE_VERSION = "v1.3";

/** The research principal as the grader's contributor: its key, no e-mail (independence 0.7 is never a researcher's, 42 § 3); a run without one cannot grade. */
export function researcherPrincipalOf(principal: Principal | null, suggestionId: string): ContributorForGrading {
  if (principal === null) throw ApplicationFailure.nonRetryable(`${suggestionId}: a researcher's suggestion needs RESEARCH_PRINCIPAL (feature-specs/40 § 7.1)`, "NO_PRINCIPAL");
  return { principal, verifiedEmail: null };
}
const GRADER: ServiceCaller = { kind: "service", id: "service:grader" };

export interface EvidenceActivityDeps {
  readonly fetch: (url: string) => Promise<FetchOutcome>;
  readonly openDoi: (doi: string) => Promise<DoiOutcome>;
  readonly store: () => ObjectStore;
  readonly grade: (input: GradeEvidenceInput) => Promise<EvidenceGrade>;
  /** The id of the suggestion's contributor, for the principal and the address; null for a researcher's. */
  readonly contributorId: (suggestionId: string) => Promise<string | null>;
  /** The platform's research principal (40 § 7.1), which a researcher's suggestion is graded under (42 § 3); null while unset. */
  readonly researchPrincipal: () => Principal | null;
  readonly contributor: (userId: string) => Promise<ContributorForGrading | null>;
  readonly anchor: (kind: ResolvedAnchor["kind"], id: string, locale: Locale) => Promise<ResolvedAnchor | null>;
  readonly rubricVersion: (id: string) => Promise<RubricVersionRow | null>;
  readonly loadRubric: (version: string) => LoadedRubric;
  readonly guide: () => Guide;
  readonly now: () => Date;
}

export const defaultEvidenceDeps = (): EvidenceActivityDeps => ({
  fetch: (url) => fetchEvidence(url),
  openDoi: (doi) => openDoi(doi),
  store: objectStore,
  grade: (input) => gradeEvidence(input),
  contributorId: (suggestionId) => contributorIdOf(GRADER, suggestionId),
  researchPrincipal: () => researchPrincipalOf(),
  contributor: contributorForGrading,
  anchor: resolveAnchor,
  rubricVersion: readRubricVersion,
  loadRubric,
  guide: () => loadGuide("grader", GRADER_GUIDE_VERSION),
  now: () => new Date(),
});

const INTAKE_RULES = "intake-rules";
const sourceKeyOf = (found: EvidenceForService): ObjectKey => (found.item.kind === "UPLOAD" && found.item.storageKey !== null ? (found.item.storageKey as ObjectKey) : evidenceSourceKey(found.suggestion.id, found.item.id));
const dayOf = (value: string | null): Date | null => (value === null ? null : new Date(`${value}T00:00:00Z`));
/** A `Content-Type` without its parameters, lowercased: `text/plain; charset=utf-8` → `text/plain`. */
const baseTypeOf = (contentType: string): string => contentType.split(";")[0]?.trim().toLowerCase() ?? "";
const isoDay = (date: Date | null): string | null => (date === null ? null : date.toISOString().slice(0, 10));

/** The most of a text upload storeText reads: four bytes, UTF-8's widest character, for each character the grader can read. */
export const TEXT_HEAD_BYTES = 4 * DOCUMENT_CHARS_MAX;

interface ReadObject {
  /** The bytes kept: all of them, or the first `keep`. */
  readonly bytes: Buffer;
  /** Of every byte, kept or not. */
  readonly sha256: string;
  /** Whether every byte was kept. */
  readonly whole: boolean;
}

/** A stored object read once: hashed whole, kept whole or up to `keep` bytes. */
export async function readObject(stream: Readable, keep: number | null): Promise<ReadObject> {
  const hash = createHash("sha256");
  const kept: Buffer[] = [];
  let size = 0;
  let held = 0;
  for await (const chunk of stream) {
    const buffer = chunk as Buffer;
    hash.update(buffer);
    size += buffer.length;
    if (keep === null || held < keep) {
      const part = keep === null ? buffer : buffer.subarray(0, keep - held);
      kept.push(part);
      held += part.length;
    }
  }
  return { bytes: Buffer.concat(kept), sha256: hash.digest("hex"), whole: held === size };
}

/** The stored text's type: UTF-8, and `truncated=true` when what is stored was cut (§ 7.5). */
const textTypeOf = (truncated: boolean): string => `text/plain; charset=utf-8${truncated ? "; truncated=true" : ""}`;
const isTruncatedType = (contentType: string): boolean => /;\s*truncated=true\b/i.test(contentType);

async function drain(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** The stored source decoded as the fetcher decoded the page (`decodeDocument`): its type carries the response's charset. */
function decode(bytes: Buffer, contentType: string): string {
  const mediaType = baseTypeOf(contentType);
  return decodeDocument(bytes, charsetOf(contentType), mediaType === "text/html" || mediaType === "application/xhtml+xml");
}

/** The text of a stored source as the fetcher reads a page (§ 4.3); null for a kind that has none until unit 49f. */
export function textOfSource(bytes: Buffer, contentType: string, base: string | undefined): string | null {
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mediaType === "text/html" || mediaType === "application/xhtml+xml") return extractHtml(decode(bytes, contentType), base).text;
  if (mediaType === "text/plain" || mediaType === "text/markdown") return decode(bytes, contentType);
  return null;
}

async function found(itemId: string): Promise<EvidenceForService> {
  const read = await readEvidenceAsService(GRADER, itemId);
  if (read === null) throw ApplicationFailure.nonRetryable(`${itemId}: no such evidence item`, "ITEM_MISSING");
  return read;
}

export function evidenceActivities(deps: EvidenceActivityDeps = defaultEvidenceDeps()): EvidenceActivities {
  /*
   * An object stored for a row its write found gone — the draft deleted, or the item removed from it, while this step
   * ran — is removed again (feature-specs/45 § 4): the delete removed what was there, and a cancel does not stop a
   * running activity. A write refused for any other reason (the item graded meanwhile) leaves the object to its row.
   */
  const orphaned = async (written: boolean, itemId: string, key: ObjectKey): Promise<void> => {
    if (written || (await readEvidenceAsService(GRADER, itemId)) !== null) return;
    await deps.store().remove(key);
  };

  const unverifiable = async (itemId: string, reason: string, publishedOn: Date | null = null): Promise<void> => {
    await writeEvidenceGraded(GRADER, itemId, { tier: "U", baseScore: 0, relevance: null, recency: null, independence: null, adjustedScore: 0, reason, gradedBy: INTAKE_RULES, gradedAt: deps.now(), publishedOn, ageDays: null });
  };

  return {
    async fetchItem(itemId) {
      const read = await found(itemId);
      const { item } = read;
      if (item.state !== "PENDING" || item.fetchStatus !== null) return { opened: (item.fetchStatus ?? "").startsWith("opened:"), fetchStatus: item.fetchStatus ?? "not_supplied" };

      if (item.kind === "UPLOAD") {
        const stored = item.storageKey === null ? null : await deps.store().head(item.storageKey as ObjectKey);
        if (stored === null) {
          await writeEvidenceFetched(GRADER, itemId, { fetchStatus: "not_supplied", host: null, title: null, publishedOn: null, contentSha256: null });
          await unverifiable(itemId, "not_supplied");
          return { opened: false, fetchStatus: "not_supplied" };
        }
        await writeEvidenceFetched(GRADER, itemId, { fetchStatus: "opened:200", host: null, title: null, publishedOn: null, contentSha256: stored.sha256 });
        return { opened: true, fetchStatus: "opened:200" };
      }

      if (item.kind === "LAB_RUN") {
        await writeEvidenceFetched(GRADER, itemId, { fetchStatus: "not_supplied", host: null, title: null, publishedOn: null, contentSha256: null });
        await unverifiable(itemId, "not_supplied");
        return { opened: false, fetchStatus: "not_supplied" };
      }

      /* A link or a DOI: the one way out (§ 4), the DOI two ways at once (§ 6). */
      let landing: FetchOutcome;
      let title: string | null = null;
      let publishedOn: string | null = null;
      if (item.kind === "DOI") {
        const opened = await deps.openDoi(item.doi ?? "");
        if (opened.outcome === "invalid") {
          await writeEvidenceFetched(GRADER, itemId, { fetchStatus: opened.fetchStatus, host: null, title: null, publishedOn: null, contentSha256: null });
          await unverifiable(itemId, "doi_form");
          return { opened: false, fetchStatus: opened.fetchStatus };
        }
        landing = opened.landing;
        title = opened.metadata?.title ?? null;
        publishedOn = opened.outcome === "resolved" ? opened.publishedOn : opened.metadata?.publishedOn ?? null;
      } else {
        landing = await deps.fetch(item.url ?? "");
      }

      if (landing.outcome !== "opened") {
        const host = landing.outcome === "unsupported" ? new URL(landing.finalUrl).hostname : hostOf(landing.at);
        await writeEvidenceFetched(GRADER, itemId, { fetchStatus: landing.fetchStatus, url: landing.outcome === "unsupported" ? landing.finalUrl : item.url, host, title, publishedOn: dayOf(publishedOn), contentSha256: null });
        await unverifiable(itemId, landing.outcome === "unsupported" ? landing.fetchStatus.slice("unsupported:".length) : landing.cause, dayOf(publishedOn));
        return { opened: false, fetchStatus: landing.fetchStatus };
      }

      const page = landing.document.kind === "html" ? landing.document : null;
      /* The charset the response named is kept with the source, so storeText decodes the page as the fetcher did. */
      await deps.store().put(sourceKeyOf(read), landing.body, landing.charset === null ? landing.contentType : `${landing.contentType}; charset=${landing.charset}`);
      const fetched = await writeEvidenceFetched(GRADER, itemId, {
        fetchStatus: landing.fetchStatus,
        url: landing.finalUrl,
        host: new URL(landing.finalUrl).hostname,
        title: title ?? page?.title ?? null,
        publishedOn: dayOf(publishedOn ?? page?.publishedOn ?? null),
        contentSha256: landing.sha256,
      });
      await orphaned(fetched, itemId, sourceKeyOf(read));
      return { opened: true, fetchStatus: landing.fetchStatus };
    },

    async storeText(itemId) {
      const read = await found(itemId);
      const { item } = read;
      if (item.textKey !== null) return { text: true };
      if (item.state !== "PENDING") return { text: false };
      const source = await deps.store().get(sourceKeyOf(read));
      if (source === null) return { text: false };
      const mediaType = baseTypeOf(source.meta.contentType);
      const plain = mediaType === "text/plain" || mediaType === "text/markdown";
      const sourceRead = await readObject(source.body, plain ? TEXT_HEAD_BYTES : null);
      if (item.kind === "UPLOAD" && item.contentSha256 !== null && sourceRead.sha256 !== item.contentSha256) {
        /*
         * The source is not what was opened: an upload PUT again under its ticket. Nothing of it is graded. A link's or
         * a DOI's source only fetchItem writes, so it is not checked: two overlapping attempts of fetchItem could leave
         * the row naming one attempt's bytes and the store the other's, and neither would be the contributor's doing.
         */
        await unverifiable(itemId, "source_changed", item.publishedOn);
        return { text: false };
      }
      const key = evidenceTextKey(read.suggestion.id, item.id);
      if (isGraderBytesType(mediaType)) {
        /* A PDF or an image (§ 9): checked as the provider documents it, then copied under the text key the grader reads. */
        const refusal = checkGraderBytes(sourceRead.bytes, mediaType);
        if (refusal !== null) {
          await unverifiable(itemId, refusal, item.publishedOn);
          return { text: false };
        }
        await deps.store().put(key, sourceRead.bytes, mediaType);
        await orphaned(await writeEvidenceTextKey(GRADER, itemId, key), itemId, key);
        return { text: true };
      }
      const text = textOfSource(sourceRead.bytes, source.meta.contentType, item.url ?? undefined);
      if (text === null) {
        await unverifiable(itemId, "no_text", item.publishedOn);
        return { text: false };
      }
      const cut = cutDocument(text);
      await deps.store().put(key, Buffer.from(cut.text, "utf8"), textTypeOf(cut.truncated || !sourceRead.whole));
      await orphaned(await writeEvidenceTextKey(GRADER, itemId, key), itemId, key);
      return { text: true };
    },

    async gradeItem(itemId) {
      const read = await found(itemId);
      const { item, suggestion } = read;
      if (item.state === "GRADED") return { state: "GRADED", tier: item.tier ?? "U" };
      if (item.textKey === null) {
        await unverifiable(itemId, "no_text", item.publishedOn);
        return { state: "GRADED", tier: "U" };
      }
      /* a person's grading is charged to their principal, a researcher's to the research principal (42 § 3), which has no employer to be independent of */
      const contributorId = suggestion.origin === "RESEARCHER" ? null : await deps.contributorId(suggestion.id);
      const contributor = suggestion.origin === "RESEARCHER" ? researcherPrincipalOf(deps.researchPrincipal(), suggestion.id) : contributorId === null ? null : await deps.contributor(contributorId);
      if (contributor === null) throw ApplicationFailure.nonRetryable(`${suggestion.id}: its contributor is gone`, "NO_PRINCIPAL");

      const stored = await deps.store().get(item.textKey as ObjectKey);
      if (stored === null) {
        await unverifiable(itemId, "text_missing", item.publishedOn);
        return { state: "GRADED", tier: "U" };
      }
      const body = await drain(stored.body);
      const storedType = baseTypeOf(stored.meta.contentType);
      /* The `text` key of a PDF or an image holds its checked copy (storeText): the bytes go to the grader as they are. */
      const content: EvidenceContent = isGraderBytesType(storedType) ? { kind: "bytes", mediaType: storedType, data: body } : { kind: "text", text: body.toString("utf8"), truncated: isTruncatedType(stored.meta.contentType) };
      const source = content.kind === "bytes" ? stored.meta : await deps.store().head(sourceKeyOf(read));

      const anchor = suggestion.anchor;
      if (anchor === null) throw ApplicationFailure.nonRetryable(`${suggestion.id}: no anchor`, "NO_ANCHOR");
      const anchorId = anchor.figureAnchor ?? anchor.sourceRowAnchor ?? anchor.sectionAnchor;
      const resolved = await deps.anchor(anchor.kind, anchorId, suggestion.locale === "PT" ? "pt" : "en");
      const version = await deps.rubricVersion(suggestion.rubricVersionId);
      if (version === null) throw ApplicationFailure.nonRetryable(`${suggestion.id}: rubric version ${suggestion.rubricVersionId} is not published`, "NO_RUBRIC");
      const { rubric } = deps.loadRubric(version.id);
      const proposal = suggestion.proposal === null ? null : ProposalSchema.parse(suggestion.proposal);
      const texts = proposal === null ? { anchoredPassage: "", proposedText: "" } : proposalTexts(proposal);

      const input: GradeEvidenceInput = {
        prompt: {
          guide: deps.guide(),
          rubric,
          anchor: { kind: anchor.kind, id: anchorId, chapter: suggestion.chapterNumber, text: resolved?.currentText ?? anchor.currentText, fastMoving: fastMovingOf(proposal, resolved?.fastMoving ?? false) },
          change: { kind: suggestion.changeKind, anchoredPassage: texts.anchoredPassage, proposedText: texts.proposedText },
          document: { kind: item.kind, host: item.host, mediaType: baseTypeOf(source?.contentType ?? "text/plain"), title: item.title, publishedOn: isoDay(item.publishedOn), content },
        },
        independence: { publisherHost: item.host, contributorEmail: contributor.verifiedEmail },
        call: { principal: contributor.principal, traceId: randomBytes(16).toString("hex"), ref: suggestion.id },
      };

      let grade: EvidenceGrade;
      try {
        grade = await deps.grade(input);
      } catch (error: unknown) {
        if (error instanceof BudgetExceededError) {
          const resetsAt = error.resetsAt.toISOString();
          await writeEvidencePending(GRADER, itemId, `budget cap; resets ${resetsAt.slice(0, 10)}`);
          return { state: "PENDING", resetsAt, waitMs: Math.max(0, error.resetsAt.getTime() - deps.now().getTime()) };
        }
        throw error;
      }

      const at = deps.now();
      if (!grade.graded) {
        await writeEvidenceGraded(GRADER, itemId, { tier: "U", baseScore: 0, relevance: null, recency: null, independence: null, adjustedScore: 0, reason: grade.reason, gradedBy: grade.gradedBy, gradedAt: at, publishedOn: item.publishedOn, ageDays: null });
        return { state: "GRADED", tier: "U" };
      }
      await writeEvidenceGraded(GRADER, itemId, {
        tier: grade.tier,
        baseScore: grade.base,
        relevance: grade.factors.relevance,
        recency: grade.factors.recency,
        independence: grade.factors.independence,
        adjustedScore: grade.adjusted,
        reason: grade.reason,
        gradedBy: grade.gradedBy,
        gradedAt: at,
        publishedOn: dayOf(grade.publishedOn),
        ageDays: grade.ageDays,
      });
      return { state: "GRADED", tier: grade.tier };
    },
  };
}

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};

export const evidenceActivitiesDefault: EvidenceActivities = evidenceActivities();

import type { Guide } from "@/lib/guides/load";
import { canonicalize, type JsonValue } from "@/lib/ledger/canonical";
import { sha256Hex } from "@/lib/ledger/hash";
import type { EvidenceTier } from "@/lib/schemas/domain";
import type { AnchorKind, ChangeClass, ChangeKind, EvidenceKind, SensorResult, SuggestionSensor } from "@/lib/schemas/improve";
import type { Rubric } from "@/lib/schemas/rubric";
import type { TextBlock } from "@/workers/agents/assistant/assemble";

/*
 * The adjudicator's prompt (feature-specs/33 § 5.1, § 5.2), in the fixed order: 1 the guide, 2 the rubric's thresholds
 * — both byte-stable per version and cached — then per call 3 the anchored text, 4 the proposed change, 5 the graded
 * evidence, 6 the sensors' verdicts, with the score's arithmetic, the rationale of a person's suggestion and whether
 * its contributor is verified. Its input is assembled from what was recorded and never from a request (TRD § 7.4):
 * `recordedMismatch` checks each text a stranger wrote — the proposal, the rationale, each grader's reason — against
 * the hash its ledger record holds before anything is built, and a mismatch is a failure that names the text.
 *
 * The parameter type lists exactly what the adjudicator may read. There is no field for a name, an address, an
 * organisation, an employer, a user id, another suggestion, a curator's note, an evidence document or the
 * suggestion's origin, so none can be passed (invariant 12); a person is `{ verified: true }` and a researcher's
 * suggestion has no contributor. Text a stranger wrote is fenced as data (§ 5.2), and a fence's own closing tag inside
 * it is broken, so the text cannot close the fence it is in.
 */

export interface AdjudicatorAnchor {
  readonly kind: AnchorKind;
  /** `21.3`, `F-21-04`, `21.9 r1`. */
  readonly id: string;
  readonly chapter: number;
  /** The anchored text at the release's version: a section's markdown, a figure's line, a row's claim and citation. */
  readonly text: string;
  readonly fastMoving: boolean;
}

export interface AdjudicatorItem {
  readonly ordinal: number;
  readonly kind: EvidenceKind;
  readonly tier: EvidenceTier;
  /** The three factors and the adjusted score, as code computed them (invariant 8); an item that could not be opened has no factors. */
  readonly relevance: number | null;
  readonly recency: number | null;
  readonly independence: number | null;
  readonly adjusted: number;
  /** Whether the fetcher opened it. */
  readonly opened: boolean;
  /** The grader's reason, as stored. */
  readonly reason: string;
}

/** The score's arithmetic: the score, the class's thresholds, the item that decides it and the one that corroborates it, the tiers that would suffice. */
export interface AdjudicatorArithmetic {
  readonly score: number;
  readonly acceptAt: number;
  readonly floorAt: number;
  /** The one tier a class with a single tier accepts; null for the others. */
  readonly onlyTier: EvidenceTier | null;
  readonly strongest: number | null;
  readonly corroboratedBy: number | null;
  readonly wouldSuffice: ReadonlyArray<EvidenceTier>;
}

/** Everything the adjudicator may read, and nothing else. */
export interface AdjudicatorInput {
  readonly guide: Guide;
  readonly rubric: Rubric;
  readonly anchor: AdjudicatorAnchor;
  readonly change: { readonly kind: ChangeKind; readonly changeClass: ChangeClass; readonly proposal: JsonValue };
  readonly items: ReadonlyArray<AdjudicatorItem>;
  readonly arithmetic: AdjudicatorArithmetic;
  readonly sensors: ReadonlyArray<{ readonly sensor: SuggestionSensor; readonly result: SensorResult; readonly detail: string }>;
  /** A person's rationale; null for a researcher's suggestion. */
  readonly rationale: string | null;
  readonly contributor: { readonly verified: true } | null;
}

export interface AdjudicatorPrompt {
  readonly system: ReadonlyArray<TextBlock>;
  readonly messages: ReadonlyArray<{ readonly role: "user"; readonly content: string }>;
  /** sha256 of the request's system and messages, as `Adjudication.promptSha256` records it. */
  readonly sha256: string;
}

/** The texts the ledger's records hold hashes of (33 § 5.2; the forms unit 50a fixed in 33 § 12). */
export interface RecordedTexts {
  readonly proposal: JsonValue;
  readonly rationale: string | null;
  readonly reasons: ReadonlyArray<{ readonly id: string; readonly ordinal: number; readonly reason: string }>;
}

export interface RecordedHashes {
  /** The `submitted` record's: the sha256 of the proposal's RFC 8785 canonical JSON, and of the rationale as stored. */
  readonly proposalSha256: string;
  readonly rationaleSha256: string | null;
  /** The `graded` record's, by item id: the sha256 of each grader's reason as stored. */
  readonly reasonSha256: ReadonlyMap<string, string>;
}

/** The first text that is not what its record says, named; null when every one is. */
export function recordedMismatch(texts: RecordedTexts, recorded: RecordedHashes): string | null {
  if (sha256Hex(canonicalize(texts.proposal)) !== recorded.proposalSha256) return "the proposal is not the one its submitted record holds";
  if ((texts.rationale === null ? null : sha256Hex(texts.rationale)) !== recorded.rationaleSha256) return "the rationale is not the one its submitted record holds";
  for (const item of texts.reasons) {
    if (sha256Hex(item.reason) !== recorded.reasonSha256.get(item.id)) return `item ${String(item.ordinal)}'s reason is not the one its graded record holds`;
  }
  return null;
}

/** The rubric's thresholds as one block, deterministic from the rubric, so a version renders to the same bytes every call. */
export function renderThresholds(rubric: Rubric): string {
  const classes = Object.entries(rubric.thresholds).map(([changeClass, threshold]) =>
    threshold === null ? `${changeClass}: no score decides it; a curator does` : `${changeClass}: accept at ${String(threshold.acceptAt)} · floor ${String(threshold.floorAt)}${threshold.onlyTier === null ? "" : ` · only on tier ${threshold.onlyTier}`}`,
  );
  return [`rubric ${rubric.version} (applies from ${rubric.appliesAt})`, "thresholds by class:", ...classes, "The numbers are code's. You judge what they cannot."].join("\n");
}

/** Text a stranger wrote, inside a fence it cannot close. */
function fenced(tag: string, text: string, attributes = ""): string {
  return `<${tag}${attributes}>\n${text.trim().replace(/<\//g, "<\\/")}\n</${tag}>`;
}

const factor = (value: number | null): string => (value === null ? "none" : `×${value.toFixed(2)}`);
const none = (value: number | null): string => (value === null ? "none" : String(value));

export function assembleAdjudicator(input: AdjudicatorInput): AdjudicatorPrompt {
  const system: ReadonlyArray<TextBlock> = [
    /* Slot 1 and slot 2, byte-stable per version: one breakpoint after the thresholds caches both. */
    { type: "text", text: input.guide.prefix },
    { type: "text", text: renderThresholds(input.rubric), cache_control: { type: "ephemeral" } },
  ];
  const { anchor, change, arithmetic } = input;
  const items = input.items.map((item) =>
    fenced("reason", item.reason, ` item="${String(item.ordinal)}"`).replace(
      /^/,
      `item ${String(item.ordinal)} · ${item.kind} · tier ${item.tier} · relevance ${factor(item.relevance)} · recency ${factor(item.recency)} · independence ${factor(item.independence)} · adjusted ${String(item.adjusted)} · ${item.opened ? "opened" : "not opened"}\n`,
    ),
  );
  const parts = [
    fenced("anchor", anchor.text, ` kind="${anchor.kind}" id="${anchor.id}" chapter="${String(anchor.chapter)}" fast-moving="${String(anchor.fastMoving)}"`),
    `change: ${change.kind} · class ${change.changeClass}\n${fenced("proposal", JSON.stringify(change.proposal))}`,
    `evidence (${String(input.items.length)} item${input.items.length === 1 ? "" : "s"}):\n${items.join("\n")}`,
    `arithmetic: score ${String(arithmetic.score)} · accept at ${String(arithmetic.acceptAt)} · floor ${String(arithmetic.floorAt)} · only tier ${arithmetic.onlyTier ?? "none"} · strongest item ${none(arithmetic.strongest)} · corroborated by item ${none(arithmetic.corroboratedBy)} · would suffice ${arithmetic.wouldSuffice.length === 0 ? "none" : arithmetic.wouldSuffice.join(", ")}`,
    `sensors:\n${input.sensors.map((s) => `${s.sensor} ${s.result} — ${s.detail}`).join("\n")}`,
    input.rationale === null ? "rationale: none" : fenced("rationale", input.rationale),
    `contributor: ${input.contributor === null ? "none" : "verified"}`,
  ];
  const messages = [{ role: "user" as const, content: parts.join("\n\n") }];
  return { system, messages, sha256: sha256Hex(JSON.stringify({ system, messages })) };
}

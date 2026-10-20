import { seeded, shuffle } from "@/lib/golden/assistant";
import { decimalOfPrinted } from "@/lib/improve/value";
import { classOf } from "@/lib/rubric/changeClass";
import { factorsOf, scoreOf, type GradedItem } from "@/lib/rubric/score";
import { routeOf } from "@/lib/rubric/thresholds";
import type { CuratedEvidence, CuratedItem } from "@/lib/schemas/curated";
import type { EvidenceTier, SourceTier } from "@/lib/schemas/domain";
import type { ChangeKind, Decision, Proposal } from "@/lib/schemas/improve";
import type { Relevance, RubricRules } from "@/lib/schemas/rubric";

/*
 * The curated set of suggestions (feature-specs/39 § 3; TRD § 8.1): 100 suggestions generated from the release's own
 * rows, as the assistant's golden set is from its chapters (lib/golden/assistant.ts). Each names a real anchor, a change
 * kind and a proposed change the intake would take, with evidence documents kept as fixture files, and the outcome the
 * rubric's arithmetic expects where arithmetic decides. The generator is deterministic for a release, so the set a
 * curator labels is the set the gate reads; a curator may edit any line.
 *
 * The documents are written to be of a tier: a regulator's notice (B), a standard or a peer-reviewed study (A), a
 * vendor's page (C), the trade press (D), a practitioner's post (E), a forum thread (F), a screenshot with no source
 * (G). What they are is the curator's label; the grader's reading of them is what the set measures.
 */

export interface CuratedSourceSection {
  readonly anchor: string;
  readonly chapter: number;
  /** The section's sentences a wording change may quote, as they stand in the source text. */
  readonly sentences: ReadonlyArray<string>;
}

export interface CuratedSourceFigure {
  readonly anchor: string;
  readonly chapter: number;
  readonly label: string;
  readonly valueText: string;
  readonly unit: string | null;
  readonly derived: boolean;
  readonly scenarioParam: boolean;
  readonly tier: SourceTier;
  /** The vendor the figure is of, as a domain, where it has one: a document of that domain has a stake. */
  readonly vendorDomain: string | null;
  /** The figure moves fast, by the ingestion's reading of its row (30 § 3.4). */
  readonly fastMoving: boolean;
}

export interface CuratedSourceRow {
  readonly anchor: string;
  readonly chapter: number;
  readonly claim: string;
  readonly citation: string;
  readonly verifiedOn: string;
  readonly fastMoving: boolean;
}

export interface CuratedSource {
  readonly release: string;
  /** `YYYY-MM-DD`: the day the set is generated, which the documents' dates count back from. */
  readonly today: string;
  readonly rules: RubricRules;
  readonly sections: ReadonlyArray<CuratedSourceSection>;
  readonly figures: ReadonlyArray<CuratedSourceFigure>;
  readonly rows: ReadonlyArray<CuratedSourceRow>;
}

/** The mix over the change classes (39 § 3): a hundred in all. */
export const CURATED_MIX = { wording: 35, cited: 25, derived: 10, row: 15, claim: 10, curator: 5 } as const;
export const CURATED_TOTAL = CURATED_MIX.wording + CURATED_MIX.cited + CURATED_MIX.derived + CURATED_MIX.row + CURATED_MIX.claim + CURATED_MIX.curator;

/**
 * The tiers the documents are written to be, spread as the rubric's tiers are met in practice: the middle most, the
 * ends least. No A: tier A is a reproducible lab run, which no document a grader reads can be (the derived class's
 * tier A is a LAB_RUN item, the IDE's). A U is a page that cannot be read: no file, a URL nothing serves.
 */
const TIER_CYCLE: ReadonlyArray<EvidenceTier> = ["B", "C", "B", "D", "B", "E", "C", "B", "G", "D", "C", "F", "C", "U", "B", "D"];
const RELEVANCE_CYCLE: ReadonlyArray<Relevance> = ["direct", "direct", "partial", "direct", "direct", "tangential", "direct", "partial"];
const AGE_CYCLE: ReadonlyArray<number | null> = [9, 40, 200, 3, 800, 25, null, 120];

/** What a document of each tier says of itself, so a reader and a grader can tell where it comes from. */
const SOURCE_OF_TIER: Readonly<Record<EvidenceTier, { readonly kind: string; readonly domain: string }>> = {
  A: { kind: "A reproducible lab run (no document is one)", domain: "lab.example" },
  B: { kind: "An official notice of the regulator, in its journal", domain: "regulator.example" },
  C: { kind: "The vendor's own documentation page", domain: "vendor.example" },
  D: { kind: "A report in the trade press", domain: "press.example" },
  E: { kind: "A practitioner's post on their own site", domain: "blog.example" },
  F: { kind: "A thread on a public forum", domain: "forum.example" },
  G: { kind: "A screenshot, with no source named", domain: "screenshots.example" },
  U: { kind: "A page that could not be read", domain: "unreadable.example" },
};

interface Draft {
  readonly chapter: number;
  readonly anchor: CuratedItem["anchor"];
  readonly changeKind: ChangeKind;
  readonly proposal: Proposal;
  readonly rationale: string;
  readonly anchorText: string;
  readonly figure: { readonly tier: SourceTier; readonly scenarioParam: boolean } | null;
  readonly vendorDomain: string | null;
  readonly fastMoving: boolean;
  /** What the evidence says, in a sentence. */
  readonly says: string;
}

const pad = (n: number, width: number): string => String(n).padStart(width, "0");

/** A wording variant of a sentence that keeps its sense and differs in its letters: the schema sensor refuses an `after` equal to its `before`. */
export function rewordOf(sentence: string): string {
  if (/\bis not\b/.test(sentence)) return sentence.replace(/\bis not\b/, "is never");
  if (/\bis\b/.test(sentence)) return sentence.replace(/\bis\b/, "remains");
  if (/\bare\b/.test(sentence)) return sentence.replace(/\bare\b/, "remain");
  if (/\bmust\b/.test(sentence)) return sentence.replace(/\bmust\b/, "has to");
  return `In practice, ${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}`;
}

/** A value near the figure's, as a decimal a proposal writes: the last digit moved by one, never the same. */
export function nearbyValueOf(valueText: string): string | null {
  const decimal = decimalOfPrinted(valueText);
  if (decimal === null) return null;
  const [whole, fraction] = decimal.split(".");
  if (fraction !== undefined && fraction.length > 0) {
    const last = Number(fraction.slice(-1));
    return `${whole}.${fraction.slice(0, -1)}${String(last === 9 ? 8 : last + 1)}`;
  }
  return String(Number(whole) + 1);
}

/** A sentence a wording change can quote: long enough to be found once, short enough to read; from a section's text. */
export function quotableSentences(markdown: string): ReadonlyArray<string> {
  return markdown
    .split("\n")
    .filter((line) => !line.startsWith("#") && !line.startsWith("|") && !line.startsWith("<") && !line.startsWith("```") && !line.includes("{{"))
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 40 && sentence.length <= 220 && !/\d/.test(sentence) && !/[*_`\[\]]/.test(sentence) && /[.!?]$/.test(sentence));
}

function documentsOf(draft: Draft, id: string, index: number, count: number, today: string): { readonly evidence: CuratedEvidence[]; readonly texts: Array<{ readonly file: string; readonly text: string }> } {
  const evidence: CuratedEvidence[] = [];
  const texts: Array<{ readonly file: string; readonly text: string }> = [];
  for (let k = 0; k < count; k += 1) {
    const at = index * 3 + k;
    const tier = TIER_CYCLE[at % TIER_CYCLE.length] ?? "B";
    const relevance = RELEVANCE_CYCLE[at % RELEVANCE_CYCLE.length] ?? "direct";
    const age = AGE_CYCLE[at % AGE_CYCLE.length] ?? null;
    const dated = age === null ? null : new Date(new Date(`${today}T00:00:00Z`).getTime() - age * 86_400_000).toISOString().slice(0, 10);
    /* every fifth vendor-tier document is the figure's own vendor's: a stake the rubric discounts */
    const domain = tier === "C" && draft.vendorDomain !== null && at % 5 === 0 ? draft.vendorDomain : SOURCE_OF_TIER[tier].domain;
    /* the file is named by the item's id, so the name on disk is the id in the labels file */
    const file = `${id}-${String(k + 1)}.txt`;
    const body =
      tier === "U"
        ? ""
        : [`${SOURCE_OF_TIER[tier].kind}, ${dated === null ? "undated" : `dated ${dated}`}, at ${domain}.`, "", relevance === "direct" ? draft.says : relevance === "partial" ? `In passing: ${draft.says}` : `On a related matter, without the figure itself: the section's subject is discussed at length, and the change proposed is not stated.`, "", tier === "G" ? "(The image shows a table cell with the value, cropped; nothing names where it was taken from.)" : `Context: ${draft.anchorText.slice(0, 200)}`].join("\n");
    evidence.push({ file, meantTier: tier, meantRelevance: relevance, dated, domain });
    /* an unreadable page has no file: nothing serves it, and the fetcher answers as it would */
    if (tier !== "U") texts.push({ file, text: body });
  }
  return { evidence, texts };
}

/** The outcome the arithmetic expects from the meant tiers: the score, and the decision where a rule decides it (39 § 3). */
export function expectedOf(rules: RubricRules, evidence: ReadonlyArray<CuratedEvidence>, changeClass: CuratedItem["changeClass"], vendorDomain: string | null, today: string, fastMoving = false): { readonly score: number; readonly decision: Decision | null } {
  const items: GradedItem[] = evidence.map((document, i) => {
    const ageDays = document.dated === null ? null : Math.max(0, Math.round((new Date(`${today}T00:00:00Z`).getTime() - new Date(`${document.dated}T00:00:00Z`).getTime()) / 86_400_000));
    const factors = factorsOf(rules, { relevance: document.meantRelevance, stake: document.domain !== null && document.domain === vendorDomain ? "vendor" : "none", ageDays }, fastMoving);
    return { id: String(i), tier: document.meantTier, opened: document.meantTier !== "U", relevance: factors.relevance, recency: factors.recency, independence: factors.independence, publisher: document.domain };
  });
  const scored = scoreOf(rules, items);
  const strongest = items.find((item) => item.id === scored.strongestId)?.tier ?? null;
  const routed = routeOf(rules, { changeClass, score: scored.score, verdicts: [], strongestTier: strongest });
  const decision: Decision | null = routed.route === "DECLINE_AT_INTAKE" ? "DECLINE" : routed.route === "REQUEST_MORE_BY_RULE" ? "REQUEST_MORE" : null;
  return { score: scored.score, decision };
}

export function generateCuratedSet(source: CuratedSource): { readonly items: ReadonlyArray<CuratedItem>; readonly documents: ReadonlyArray<{ readonly file: string; readonly text: string }> } {
  const random = seeded(`suggestions:${source.release}`);
  const sections = shuffle(source.sections.filter((section) => section.sentences.length > 0), random);
  const cited = shuffle(source.figures.filter((figure) => !figure.derived && !figure.scenarioParam && nearbyValueOf(figure.valueText) !== null), random);
  const derived = shuffle(source.figures.filter((figure) => figure.derived && !figure.scenarioParam && nearbyValueOf(figure.valueText) !== null), random);
  const rows = shuffle(source.rows, random);
  const drafts: Draft[] = [];
  const take = <T>(from: ReadonlyArray<T>, n: number): ReadonlyArray<T> => Array.from({ length: n }, (_, i) => from[i % from.length]).filter((item): item is T => item !== undefined);

  for (const section of take(sections, CURATED_MIX.wording)) {
    const sentence = section.sentences[Math.floor(random() * section.sentences.length)] ?? section.sentences[0] ?? "";
    const after = rewordOf(sentence);
    drafts.push({ chapter: section.chapter, anchor: { kind: "SECTION", id: section.anchor }, changeKind: "EDIT_TEXT", proposal: { kind: "EDIT_TEXT", before: sentence, after }, rationale: "The sentence reads more plainly this way, and the source cited says the same.", anchorText: sentence, figure: null, vendorDomain: null, fastMoving: false, says: `The passage is better put as: "${after}"` });
  }
  for (const figure of take(cited, CURATED_MIX.cited)) {
    const after = nearbyValueOf(figure.valueText) ?? "0";
    drafts.push({ chapter: figure.chapter, anchor: { kind: "FIGURE", id: figure.anchor }, changeKind: "SET_VALUE", proposal: { kind: "SET_VALUE", after, unit: figure.unit }, rationale: `The published figure moved; the source now gives ${after}${figure.unit === null ? "" : ` ${figure.unit}`}.`, anchorText: `${figure.label} · ${figure.valueText}`, figure: { tier: figure.tier, scenarioParam: figure.scenarioParam }, vendorDomain: figure.vendorDomain, fastMoving: figure.fastMoving, says: `${figure.label} is ${after}${figure.unit === null ? "" : ` ${figure.unit}`}, the earlier ${figure.valueText} having been revised.` });
  }
  for (const figure of take(derived, CURATED_MIX.derived)) {
    const after = nearbyValueOf(figure.valueText) ?? "0";
    drafts.push({ chapter: figure.chapter, anchor: { kind: "FIGURE", id: figure.anchor }, changeKind: "SET_VALUE", proposal: { kind: "SET_VALUE", after, unit: figure.unit }, rationale: `A run of the chapter's lab with the current inputs gives ${after}${figure.unit === null ? "" : ` ${figure.unit}`}.`, anchorText: `${figure.label} · ${figure.valueText}`, figure: { tier: figure.tier, scenarioParam: figure.scenarioParam }, vendorDomain: figure.vendorDomain, fastMoving: figure.fastMoving, says: `The lab's run derives ${after}${figure.unit === null ? "" : ` ${figure.unit}`} for ${figure.label}.` });
  }
  for (const [i, row] of take(rows, CURATED_MIX.row).entries()) {
    const proposal: Proposal = i % 2 === 0 ? { kind: "EDIT_ROW", verifiedOn: source.today } : { kind: "EDIT_ROW", citation: `${row.citation}, revised edition` };
    drafts.push({ chapter: row.chapter, anchor: { kind: "SOURCE_ROW", id: row.anchor }, changeKind: "EDIT_ROW", proposal, rationale: i % 2 === 0 ? "The source was checked again today and still says this." : "The source has a revised edition, which the citation should name.", anchorText: `${row.claim} — ${row.citation}`, figure: null, vendorDomain: null, fastMoving: row.fastMoving, says: `${row.claim} The source: ${row.citation}.` });
  }
  for (const section of take(sections.slice(CURATED_MIX.wording), CURATED_MIX.claim)) {
    const text = `A reader of this section should also know that the practice described here is checked against the source on a fixed schedule.`;
    drafts.push({ chapter: section.chapter, anchor: { kind: "SECTION", id: section.anchor }, changeKind: "ADD_CLAIM", proposal: { kind: "ADD_CLAIM", text, placeAfter: "end", fastMoving: false }, rationale: "The section leaves out the schedule the source states.", anchorText: section.sentences[0] ?? "", figure: null, vendorDomain: null, fastMoving: false, says: text });
  }
  for (const section of take(sections.slice(CURATED_MIX.wording + CURATED_MIX.claim), CURATED_MIX.curator)) {
    drafts.push({ chapter: section.chapter, anchor: { kind: "SECTION", id: section.anchor }, changeKind: "RESTRUCTURE", proposal: { kind: "RESTRUCTURE", description: "Move the section's second paragraph before the first, so the rule comes before its exception." }, rationale: "The section states the exception before the rule.", anchorText: section.sentences[0] ?? "", figure: null, vendorDomain: null, fastMoving: false, says: "The usual order of a rule and its exception is the rule first." });
  }

  const items: CuratedItem[] = [];
  const documents: Array<{ readonly file: string; readonly text: string }> = [];
  const serialOf = new Map<number, number>();
  drafts.forEach((draft, index) => {
    const serial = (serialOf.get(draft.chapter) ?? 0) + 1;
    serialOf.set(draft.chapter, serial);
    const id = `G-${pad(draft.chapter, 2)}-${pad(serial, 4)}`;
    const count = 1 + (index % 3 === 0 ? 1 : 0) + (index % 7 === 0 ? 1 : 0);
    const { evidence, texts } = documentsOf(draft, id, index, count, source.today);
    const proposalText = draft.proposal.kind === "EDIT_TEXT" ? draft.proposal.after : draft.proposal.kind === "SET_VALUE" ? `${draft.proposal.after}${draft.proposal.unit === null ? "" : ` ${draft.proposal.unit}`}` : draft.proposal.kind === "ADD_CLAIM" ? draft.proposal.text : draft.proposal.kind === "RESTRUCTURE" ? draft.proposal.description : draft.proposal.kind === "EDIT_ROW" ? (draft.proposal.citation ?? draft.proposal.verifiedOn ?? "") : draft.proposal.claim;
    const classified = classOf({ kind: draft.anchor.kind, figure: draft.figure, text: draft.anchorText }, draft.changeKind, { text: proposalText, sourceTier: null });
    const arithmetic = expectedOf(source.rules, evidence, classified.changeClass, draft.vendorDomain, source.today, draft.fastMoving);
    /* a curator-always class is a curator's to decide, whatever the score says */
    const expected = classified.changeClass === "CURATOR_ALWAYS" ? { score: arithmetic.score, decision: null } : arithmetic;
    items.push({ id, chapter: draft.chapter, anchor: draft.anchor, changeKind: draft.changeKind, changeClass: classified.changeClass, proposal: draft.proposal, rationale: draft.rationale, vendorDomain: draft.vendorDomain, fastMoving: draft.fastMoving, evidence, expected });
    documents.push(...texts);
  });
  return { items, documents };
}

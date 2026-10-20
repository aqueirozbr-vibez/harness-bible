import type { EvidenceTier } from "@/lib/schemas/domain";
import type { AnchorKind, ChangeKind, Decision, Proposal, SuggestionState } from "@/lib/schemas/improve";
import type { LedgerKind } from "@/lib/schemas/ledger";
import type { Route } from "@/lib/schemas/rubric";
import type { MergeStage, SuggestionWaits } from "@/lib/schemas/workflows";

/*
 * The four worked examples (feature-specs/33 § 8; unit 50g), the Phase 4 gate's first criterion: each a suggestion on
 * what release 2026.09 holds, its evidence the fixture's documents and the stub gateway's grades, and where it must end.
 *
 * Where the release has no anchor at the place the PRD names, the nearest one is used, and why is said:
 *  1. 36.3 holds no figure — chapter 36 is unverified in 2026.09 and holds none — so the cited date is F-28-32,
 *     "those obligations apply from 2 December 2027" in 28.7, a primary source's date, and the date the screen's own
 *     sample changes to (→ 2 Dec 2027).
 *  2. Chapter 23's cited figure is F-23-19, the analyst's 35% in 23.2, cited to 23.9 r3.
 *  3. 22.8 holds no figure, so the derived decision aid is F-22-20, the derived success rate after retries in 22.3,
 *     the latest of the chapter's derived figures that is no scenario parameter. A saved lab run arrives with the IDE
 *     (32 § 3), so its tier A run is an item written as the IDE would leave it graded, and no grader is asked.
 *  4. 15.9 is chapter 15's Sources, so the cited price is its row r1, the list prices, which moves fast.
 *
 * The screens' values (2 Aug 2026 → 2 Dec 2027; 2.4× → 1.3×; $0.30 → $0.25) are the design's samples; these propose
 * changes of their own. The documents are the fixture's, on `.example` hosts: nobody's real page is quoted.
 */

/** An item of evidence and how the fixture gives it: a page the fetcher opens, an upload in the store, or a graded run. */
export type ExampleItem =
  | {
      readonly kind: "LINK";
      readonly url: string;
      /** What the fetcher finds there; its date is so many days before the run. */
      readonly document: { readonly title: string; readonly text: string; readonly ageDays: number };
      /** The stub grader's answer (`x-hb-stub-grade`, a tier with its relevance and stake; § 8). */
      readonly grade: string;
    }
  | {
      readonly kind: "UPLOAD";
      /** A file of workers/agents/grader/__fixtures__, stored as the upload. */
      readonly file: string;
      readonly contentType: "image/png";
      readonly grade: string;
    }
  | {
      readonly kind: "LAB_RUN";
      readonly labRunId: string;
      /** As the IDE would leave it graded: tier A, its relevance as a factor, its adjusted score. */
      readonly relevance: number;
      readonly adjusted: number;
      readonly reason: string;
    };

/** Where an example must end (§ 8, § 11.1). */
export interface ExampleEnd {
  readonly state: SuggestionState;
  readonly score: number;
  readonly route: Route;
  readonly decision: Decision;
  readonly decidedBy: "intake-rules" | "adjudicator";
  readonly sufficientTier: EvidenceTier | null;
  /** The tiers the arithmetic says would suffice, where § 8 names them. */
  readonly wouldSuffice?: ReadonlyArray<EvidenceTier>;
  /** What the run then waits for; null for a run that ends there, or waits in its merge. */
  readonly waits: SuggestionWaits;
  /** Where an accept's merge waits (spec 37 § 4; unit 54b): with no repository of the book, which no example writes, `UNAVAILABLE`; null where nothing merges. */
  readonly merge: MergeStage | null;
  readonly records: ReadonlyArray<LedgerKind>;
}

export interface WorkedExample {
  readonly name: string;
  readonly anchor: { readonly kind: AnchorKind; readonly id: string };
  readonly changeKind: ChangeKind;
  readonly proposal: Proposal;
  readonly rationale: string;
  readonly items: ReadonlyArray<ExampleItem>;
  readonly ends: ExampleEnd;
}

const RECORDS: ReadonlyArray<LedgerKind> = ["SUBMITTED", "GRADED", "SENSORS", "DECIDED"];

export const WORKED_EXAMPLES: ReadonlyArray<WorkedExample> = [
  {
    name: "1 · a cited date",
    anchor: { kind: "FIGURE", id: "F-28-32" },
    changeKind: "SET_VALUE",
    proposal: { kind: "SET_VALUE", after: "2028", unit: null },
    rationale: "The amending act moved the date the obligations apply from by a year; the official journal states it.",
    items: [
      {
        kind: "LINK",
        url: "https://journal.example/ai-act/application-timeline",
        document: { title: "Application timeline of the obligations", text: "The obligations for the systems listed in the annex apply from 2 December 2028, the amending act having moved them by one year.", ageDays: 9 },
        grade: "B:direct:none",
      },
    ],
    ends: { state: "MERGING", score: 85, route: "ADJUDICATE", decision: "ACCEPT", decidedBy: "adjudicator", sufficientTier: null, waits: null, merge: "UNAVAILABLE", records: RECORDS },
  },
  {
    name: "2 · a cited figure, on a screenshot",
    anchor: { kind: "FIGURE", id: "F-23-19" },
    changeKind: "SET_VALUE",
    proposal: { kind: "SET_VALUE", after: "40", unit: "%" },
    rationale: "A dashboard I saw shows realistic mixed traffic landing nearer 40% than 35%.",
    items: [{ kind: "UPLOAD", file: "C-vendor.png", contentType: "image/png", grade: "G:direct:none" }],
    ends: { state: "INTAKE_DECLINED", score: 5, route: "DECLINE_AT_INTAKE", decision: "DECLINE", decidedBy: "intake-rules", sufficientTier: null, wouldSuffice: ["B", "D"], waits: { curator: false, revision: true }, merge: null, records: RECORDS },
  },
  {
    name: "3 · a derived decision aid",
    anchor: { kind: "FIGURE", id: "F-22-20" },
    changeKind: "SET_VALUE",
    proposal: { kind: "SET_VALUE", after: "95", unit: "%" },
    rationale: "A run of the chapter's lab with five retries rather than three gives 95%, not 93%.",
    items: [{ kind: "LAB_RUN", labRunId: "lab-22-retries-0005", relevance: 0.6, adjusted: 60, reason: "a run of the chapter's lab, but with a retry count the passage does not use" }],
    ends: { state: "CURATOR_QUEUE", score: 60, route: "REQUEST_MORE_BY_RULE", decision: "REQUEST_MORE", decidedBy: "intake-rules", sufficientTier: "A", waits: { curator: true, revision: true }, merge: null, records: RECORDS },
  },
  {
    name: "4 · a cited price",
    anchor: { kind: "SOURCE_ROW", id: "15.9 r1" },
    changeKind: "EDIT_ROW",
    proposal: { kind: "EDIT_ROW", claim: "List prices: frontier 1.25 / 0.125 / 10; small 0.20 / 0.02 / 1.6" },
    rationale: "The vendor cut the small model's prices; its own page and an analyst's table both show the new ones.",
    items: [
      {
        kind: "LINK",
        url: "https://pricing.vendor.example/models",
        document: { title: "Model pricing", text: "Small model: $0.20 per million input tokens, $0.02 cached, $1.60 output.", ageDays: 10 },
        grade: "C:direct:vendor",
      },
      {
        kind: "LINK",
        url: "https://prices.analyst.example/llm-table",
        document: { title: "Model price table", text: "Small model list price: $0.20 / $0.02 / $1.60 per million tokens (input, cached, output).", ageDays: 150 },
        grade: "D:direct:none",
      },
    ],
    ends: { state: "CURATOR_QUEUE", score: 66, route: "ADJUDICATE", decision: "REQUEST_MORE", decidedBy: "adjudicator", sufficientTier: "D", waits: { curator: true, revision: true }, merge: null, records: RECORDS },
  },
];

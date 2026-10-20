import type { EvidenceTier } from "@/lib/schemas/domain";
import type { ChangeClass, Criterion, CuratorAction, Decider, Decision, Part, SuggestionSensor, WITHDRAWABLE_STATES } from "@/lib/schemas/improve";
import { CuratorPayloadSchema, DecidedPayloadSchema, EndorsedPayloadSchema, ExportPayloadSchema, GradedPayloadSchema, MergedPayloadSchema, RetractedPayloadSchema, SensorsPayloadSchema, SubmittedPayloadSchema, type LedgerKind } from "@/lib/schemas/ledger";

/*
 * A suggestion's record as its page tells it (feature-specs/35 § 5; unit 52c): one presenter from each record's
 * payload to what its entry says — the title's facts, the body's facts, and who acted. Every fact is the payload's
 * own: an id, a code, a count, a version; nothing a person or a model wrote is in a payload but as its hash
 * (invariant 18), so nothing here can show one. Pure; the page words the facts.
 */

/** A record as the presenter reads it: what a ledger row has. */
export interface RecordRow {
  readonly seq: number;
  readonly kind: LedgerKind;
  /** `user:<id>` for a person, `service:<name>` for an agent. */
  readonly actor: string;
  readonly payload: unknown;
  readonly createdAt: Date;
  readonly prevHash: string;
  readonly hash: string;
}

/** Who a record names: a person, by the name the viewer may see or else by the pseudonym the ledger holds; or a service. */
export type RecordActor = { readonly kind: "person"; readonly pseudonym: string; readonly name: string | null } | { readonly kind: "service"; readonly service: string };

export interface GradedItemFacts {
  readonly ordinal: number;
  readonly tier: EvidenceTier;
  readonly base: number;
  readonly relevance: number | null;
  readonly recency: number | null;
  readonly independence: number | null;
  readonly adjusted: number;
}

/** What each kind of record says, from its payload; `UNREADABLE` where a payload does not parse, which the chain check then also judges. */
export type RecordFacts =
  | { readonly kind: "SUBMITTED"; readonly attempt: number; readonly anchor: string; readonly changeClass: ChangeClass; readonly items: number; readonly words: number; readonly verified: boolean | null; readonly rubricVersion: string }
  | { readonly kind: "GRADED"; readonly items: ReadonlyArray<GradedItemFacts>; readonly score: number; readonly gradedBy: string | null; readonly rubricVersion: string }
  | { readonly kind: "SENSORS"; readonly verdicts: ReadonlyArray<{ readonly sensor: SuggestionSensor; readonly result: "PASS" | "FAIL" | "WARN" | "NA" }> }
  | { readonly kind: "DECIDED"; readonly decision: Decision; readonly decidedBy: Decider; readonly score: number; readonly acceptAt: number | null; readonly floorAt: number | null; readonly failingSensor: SuggestionSensor | null; readonly criteria: number; readonly guide: string | null; readonly rubricVersion: string; readonly tokens: number }
  | { readonly kind: "CURATOR"; readonly action: CuratorAction; readonly overrideCode: string | null; readonly criterion: Criterion | null; readonly part: Part; readonly noted: boolean }
  | { readonly kind: "MERGED"; readonly versionFrom: string; readonly versionTo: string; readonly bump: "patch" | "minor" | "major"; readonly lab: string; readonly lint: string; readonly reverts: string | null }
  | { readonly kind: "ENDORSED"; readonly withdrawn: boolean }
  | { readonly kind: "RETRACTED"; readonly from: (typeof WITHDRAWABLE_STATES)[number]; readonly outcome: Decision | null }
  | { readonly kind: "EXPORT"; readonly records: number }
  | { readonly kind: "UNREADABLE" };

export interface RecordEntry {
  readonly seq: number;
  /** The record's own kind, whatever its payload says. */
  readonly kind: LedgerKind;
  readonly at: Date;
  readonly facts: RecordFacts;
  readonly actor: RecordActor;
  /** The timeline's marker: open for a submission or an export, the verified colour for an accept and a merge, the failure colour for a decline. */
  readonly marker: "o" | "v" | "f" | null;
  readonly hash: string;
  readonly prevHash: string;
  /** The view's last record, which the chain check's head is. */
  readonly head: boolean;
}

/** `user:<id>`'s id, or null for a service. */
export const personOf = (actor: string): string | null => (actor.startsWith("user:") ? actor.slice("user:".length) : null);

function factsOf(row: RecordRow, attempt: number): RecordFacts {
  switch (row.kind) {
    case "SUBMITTED": {
      const parsed = SubmittedPayloadSchema.safeParse(row.payload);
      if (!parsed.success) return { kind: "UNREADABLE" };
      const { anchor } = parsed.data;
      return { kind: "SUBMITTED", attempt, anchor: anchor.figure ?? anchor.sourceRow ?? anchor.section, changeClass: parsed.data.changeClass, items: parsed.data.evidence.length, words: parsed.data.rationaleWords, verified: parsed.data.verified, rubricVersion: parsed.data.rubricVersion };
    }
    case "GRADED": {
      const parsed = GradedPayloadSchema.safeParse(row.payload);
      if (!parsed.success) return { kind: "UNREADABLE" };
      const items = parsed.data.items.map((item, index) => ({ ordinal: index + 1, tier: item.tier, base: item.base, relevance: item.relevance, recency: item.recency, independence: item.independence, adjusted: item.adjusted }));
      return { kind: "GRADED", items, score: parsed.data.score, gradedBy: parsed.data.items.find((item) => item.gradedBy !== "intake-rules")?.gradedBy ?? parsed.data.items[0]?.gradedBy ?? null, rubricVersion: parsed.data.rubricVersion };
    }
    case "SENSORS": {
      const parsed = SensorsPayloadSchema.safeParse(row.payload);
      return parsed.success ? { kind: "SENSORS", verdicts: parsed.data.verdicts } : { kind: "UNREADABLE" };
    }
    case "DECIDED": {
      const parsed = DecidedPayloadSchema.safeParse(row.payload);
      if (!parsed.success) return { kind: "UNREADABLE" };
      const decided = parsed.data;
      return { kind: "DECIDED", decision: decided.decision, decidedBy: decided.decidedBy, score: decided.score, acceptAt: decided.acceptAt, floorAt: decided.floorAt, failingSensor: decided.failingSensor, criteria: decided.criteria.length, guide: decided.guide?.version ?? null, rubricVersion: decided.rubricVersion, tokens: decided.usage.inputTokens + decided.usage.outputTokens };
    }
    case "CURATOR": {
      const parsed = CuratorPayloadSchema.safeParse(row.payload);
      return parsed.success ? { kind: "CURATOR", action: parsed.data.action, overrideCode: parsed.data.overrideCode, criterion: parsed.data.criterion, part: parsed.data.part, noted: parsed.data.noteSha256 !== null } : { kind: "UNREADABLE" };
    }
    case "MERGED": {
      const parsed = MergedPayloadSchema.safeParse(row.payload);
      return parsed.success ? { kind: "MERGED", versionFrom: parsed.data.versionFrom, versionTo: parsed.data.versionTo, bump: parsed.data.bump, lab: parsed.data.check.lab, lint: parsed.data.check.lint, reverts: parsed.data.reverts } : { kind: "UNREADABLE" };
    }
    case "ENDORSED": {
      const parsed = EndorsedPayloadSchema.safeParse(row.payload);
      return parsed.success ? { kind: "ENDORSED", withdrawn: parsed.data.withdrawn } : { kind: "UNREADABLE" };
    }
    case "RETRACTED": {
      const parsed = RetractedPayloadSchema.safeParse(row.payload);
      return parsed.success ? { kind: "RETRACTED", from: parsed.data.from, outcome: parsed.data.outcome } : { kind: "UNREADABLE" };
    }
    case "EXPORT": {
      const parsed = ExportPayloadSchema.safeParse(row.payload);
      return parsed.success ? { kind: "EXPORT", records: parsed.data.records } : { kind: "UNREADABLE" };
    }
    default:
      return { kind: "UNREADABLE" };
  }
}

function markerOf(facts: RecordFacts): RecordEntry["marker"] {
  switch (facts.kind) {
    case "SUBMITTED":
    case "EXPORT":
    case "ENDORSED":
      return "o";
    case "DECIDED":
      return facts.decision === "ACCEPT" ? "v" : facts.decision === "DECLINE" ? "f" : null;
    case "CURATOR":
      return facts.action === "ACCEPT" || facts.action === "MERGE" ? "v" : facts.action === "DECLINE" ? "f" : null;
    case "MERGED":
      return "v";
    default:
      return null;
  }
}

/**
 * The entries of a suggestion's view, in chain order (35 § 5): a second attempt after a revision is its own entries,
 * its submission counted as the attempt it is. `names` holds the display names the viewer may see, by person id; a
 * person it does not hold appears by pseudonym.
 */
export function entriesOf(rows: ReadonlyArray<RecordRow>, names: ReadonlyMap<string, string>): RecordEntry[] {
  let attempt = 0;
  return rows.map((row, index) => {
    if (row.kind === "SUBMITTED") attempt += 1;
    const facts = factsOf(row, attempt);
    const person = personOf(row.actor);
    const actor: RecordActor = person === null ? { kind: "service", service: row.actor.startsWith("service:") ? row.actor.slice("service:".length) : row.actor } : { kind: "person", pseudonym: row.actor, name: names.get(person) ?? null };
    return { seq: row.seq, kind: row.kind, at: row.createdAt, facts, actor, marker: markerOf(facts), hash: row.hash, prevHash: row.prevHash, head: index === rows.length - 1 };
  });
}

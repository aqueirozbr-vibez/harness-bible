import { ApplicationFailure } from "@temporalio/activity";

import { resolveAnchor } from "@/lib/db/anchors";
import { createFromResearch, currentRubricVersion, type ResearchCreated, type ResearchSubmission, type ServiceCaller } from "@/lib/db/improve";
import { readFindings, readResearchFound, submitFinding, writeFinding, type ResearchRunRow } from "@/lib/db/research";
import { submissionOf } from "@/lib/research/submission";
import { ReaderFindingSchema } from "@/lib/schemas/researcher";

/*
 * The submission step of a run (feature-specs/42 § 4; unit 59b), the activity's own code: each finding the validation
 * passed (`found.valid`) becomes a suggestion through the one door — the anchor resolved against the release again, the
 * class computed as a person's draft has it (rule 3 reads the passage and the proposed text, rule 4 the tier), the
 * proposal's key over the anchor's content, the note as the rationale, one pending `LINK` item per source — as
 * `service:researcher`, `SUBMITTED` at once, with no owner. The same proposal already made, of any origin, is a
 * `DUPLICATE` finding and nothing is created (42 § 4.3). Each finding's row in the asker's context names its suggestion,
 * outcome `SUBMITTED`, in the same transaction as the door's create (`submitFinding`), which is the one direction that
 * link runs (40 § 3). A retry of the step reads the rows an earlier attempt wrote first: a finding already `SUBMITTED`
 * is that attempt's suggestion, whose workflow is still to start, and one decided otherwise stays as written (unit 59's
 * review). What comes back to the workflow is the ids, so it can start each suggestion's workflow as a child.
 * `submissionOf` — the class, the key, the note, the sources — is lib/research/submission.ts's since unit 74, which the
 * web tier's draft from a finding computes with too, and a person's finding sent to Improve takes the same road one at a
 * time (feature-specs/48 § 8.2 step 5, § 8.4; ./send.ts).
 */

export const RESEARCHER: ServiceCaller = { kind: "service", id: "service:researcher" };

export interface SubmitStepDeps {
  readonly readFound: typeof readResearchFound;
  /** The finding rows an earlier attempt of the step wrote. */
  readonly readFindings: typeof readFindings;
  readonly anchor: typeof resolveAnchor;
  readonly rubricVersion: () => Promise<string | null>;
  /** The door's create and the finding's row naming what it made, in one transaction. */
  readonly submit: (run: ResearchRunRow, ordinal: number, input: ResearchSubmission) => Promise<ResearchCreated>;
  readonly writeFinding: typeof writeFinding;
  readonly log: (line: string) => void;
  readonly now: () => Date;
}

export function defaultSubmitStepDeps(): SubmitStepDeps {
  return {
    readFound: readResearchFound,
    readFindings,
    anchor: resolveAnchor,
    rubricVersion: async () => (await currentRubricVersion())?.id ?? null,
    submit: (run, ordinal, input) => submitFinding(run, ordinal, (client) => createFromResearch(RESEARCHER, input, client)),
    writeFinding,
    log: (line) => console.info(line),
    now: () => new Date(),
  };
}

export async function submitStep(run: ResearchRunRow, deps: SubmitStepDeps = defaultSubmitStepDeps()): Promise<{ readonly suggestionIds: ReadonlyArray<string> }> {
  const found = await deps.readFound(run);
  if (found === null) throw ApplicationFailure.create({ type: "TEXT_PURGED", message: `research run ${run.id}: what the reader found is gone`, nonRetryable: true });
  const rubricVersionId = await deps.rubricVersion();
  if (rubricVersionId === null) throw ApplicationFailure.create({ type: "NO_RUBRIC", message: "no rubric is published: a researcher's suggestion needs one (feature-specs/30 § 5)", nonRetryable: true });
  const suggestionIds: string[] = [];
  let duplicates = 0;
  const written = new Map((await deps.readFindings(run)).map((row) => [row.ordinal, row]));
  for (const ordinal of found.valid ?? []) {
    /* an earlier attempt's row: its suggestion, still to start, or a decision that stands */
    const before = written.get(ordinal);
    if (before !== undefined) {
      if (before.outcome === "SUBMITTED" && before.suggestionId !== null) suggestionIds.push(before.suggestionId);
      continue;
    }
    const parsed = ReaderFindingSchema.safeParse(found.findings[ordinal - 1]);
    if (!parsed.success) continue;
    const finding = parsed.data;
    const resolved = await deps.anchor(finding.anchor.kind, finding.anchor.id, run.locale === "PT" ? "pt" : "en");
    if (resolved === null) {
      /* the release moved between the validation and now: the finding's anchor is gone, which the validation would have refused */
      await deps.writeFinding(run, { ordinal, outcome: "INVALID", invalidReason: "ANCHOR", suggestionId: null });
      continue;
    }
    const created = await deps.submit(run, ordinal, submissionOf(finding, resolved, rubricVersionId, run.locale, deps.now()));
    if (!created.created) {
      duplicates += 1;
      continue;
    }
    suggestionIds.push(created.id);
  }
  deps.log(`research ${run.id}: ${String(suggestionIds.length)} submitted, ${String(duplicates)} duplicate (trace ${run.traceId})`);
  return { suggestionIds };
}

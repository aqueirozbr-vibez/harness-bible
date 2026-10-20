import { ApplicationFailure } from "@temporalio/activity";

import { readResearchFound, readResearchSections, writeFinding, writeResearchFound, type ConversationRunRow, type ResearchSection } from "@/lib/db/research";
import { checkNotes, validateFindings } from "@/lib/research/validate";

/*
 * The check of a person's run (feature-specs/48 § 5.5; unit 70b), the activity's own code: what the reader found read
 * back inside the asker's context, every finding checked in code by spec 41 § 7's table (lib/research/validate.ts) —
 * `ANCHOR` read against the targets' sections, the ones the reader was given — and a row written for every finding:
 * `INVALID` with its reason, or `VALID`, which gives the finding its own id for the person's buttons and the run's view
 * (§ 8, § 16). Each page's note is kept only when its address is a page the turn saw, it is at most 60 words and it
 * passes the secret patterns; the notes kept are stored as `found.says` and `found.notes` is removed in the same write,
 * a note that failed counted in `found.notesDropped`. A retried check writes the same rows again, by the finding's
 * ordinal. What comes back is the two counts; a run whose text went fails `TEXT_PURGED`.
 */

export interface ValidateRunDeps {
  readonly readFound: typeof readResearchFound;
  readonly readSections: (releaseId: string, anchors: ReadonlyArray<string>) => Promise<ReadonlyArray<ResearchSection>>;
  readonly writeFinding: typeof writeFinding;
  readonly writeFound: typeof writeResearchFound;
  readonly log: (line: string) => void;
}

export function defaultValidateRunDeps(): ValidateRunDeps {
  return { readFound: readResearchFound, readSections: readResearchSections, writeFinding, writeFound: writeResearchFound, log: (line) => console.info(line) };
}

export async function validateRunStep(run: ConversationRunRow, deps: ValidateRunDeps = defaultValidateRunDeps()): Promise<{ readonly valid: number; readonly invalid: number }> {
  const found = await deps.readFound(run);
  if (found === null) throw ApplicationFailure.create({ type: "TEXT_PURGED", message: `research run ${run.id}: what the reader found is gone`, nonRetryable: true });
  const sections = await deps.readSections(run.releaseId, run.targetAnchors);
  const validated = validateFindings(found.findings, { sections, pages: found.pages });
  const valid: number[] = [];
  for (const entry of validated.findings) {
    if (entry.verdict.valid) valid.push(entry.ordinal);
    await deps.writeFinding(run, { ordinal: entry.ordinal, outcome: entry.verdict.valid ? "VALID" : "INVALID", invalidReason: entry.verdict.valid ? null : entry.verdict.reason, suggestionId: null });
  }
  /* a retried check reads the notes it already replaced: the ones kept stand, and so does the count */
  const notes = found.notes === undefined ? { says: found.says ?? [], dropped: found.notesDropped ?? 0 } : checkNotes(found.notes, found.pages);
  const { notes: _replaced, ...kept } = found;
  void _replaced;
  const { written } = await deps.writeFound(run, { ...kept, valid, dropped: validated.dropped, says: [...notes.says], notesDropped: notes.dropped });
  if (!written) throw ApplicationFailure.create({ type: "TEXT_PURGED", message: `research run ${run.id}: its text was purged while the findings were checked`, nonRetryable: true });
  deps.log(`research ${run.id}: ${String(valid.length)} valid, ${String(validated.findings.length - valid.length)} invalid, ${String(validated.dropped)} dropped beyond the third; ${String(notes.says.length)} note${notes.says.length === 1 ? "" : "s"} kept, ${String(notes.dropped)} dropped (trace ${run.traceId})`);
  return { valid: valid.length, invalid: validated.findings.length - valid.length };
}

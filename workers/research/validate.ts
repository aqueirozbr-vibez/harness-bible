import { ApplicationFailure } from "@temporalio/activity";

import { readResearchFound, readResearchSections, writeFinding, writeResearchFound, type ResearchRunRow, type ResearchSection } from "@/lib/db/research";
import { validateFindings } from "@/lib/research/validate";
import type { ResearchFound } from "@/lib/schemas/researcher";

/*
 * The validation step of a run (feature-specs/41 § 7; unit 58e), the activity's own code: what the reader found read
 * back inside the asker's context, the sections it was given read at the run's release, every finding checked in code
 * by `validate`, and the outcome written — an `INVALID` row with its reason and nothing of the text for each refusal,
 * and the ordinals that passed left on the run for the submission (spec 42 § 4; unit 59b), which takes those and no
 * other. Findings beyond the third were dropped by the validation and are counted on the run (`found.dropped`) and in the
 * log. What comes back to the activity is the three counts; `duplicate` is the submission's to decide (42 § 4.3) and is 0
 * here.
 */

export interface ValidateStepDeps {
  readonly readFound: typeof readResearchFound;
  readonly readSections: (releaseId: string, anchors: ReadonlyArray<string>) => Promise<ReadonlyArray<ResearchSection>>;
  readonly writeFinding: typeof writeFinding;
  readonly writeFound: (run: Pick<ResearchRunRow, "id" | "userId">, found: ResearchFound) => Promise<{ readonly written: boolean }>;
  readonly log: (line: string) => void;
}

export function defaultValidateStepDeps(): ValidateStepDeps {
  return { readFound: readResearchFound, readSections: readResearchSections, writeFinding, writeFound: (run, found) => writeResearchFound(run, found), log: (line) => console.info(line) };
}

export async function validateStep(run: ResearchRunRow, deps: ValidateStepDeps = defaultValidateStepDeps()): Promise<{ readonly valid: number; readonly invalid: number; readonly duplicate: number }> {
  const found = await deps.readFound(run);
  if (found === null) throw ApplicationFailure.create({ type: "TEXT_PURGED", message: `research run ${run.id}: what the reader found is gone`, nonRetryable: true });
  const sections = await deps.readSections(run.releaseId, run.sectionAnchors);
  const validated = validateFindings(found.findings, { sections, pages: found.pages });
  const valid: number[] = [];
  let invalid = 0;
  for (const entry of validated.findings) {
    if (entry.verdict.valid) {
      valid.push(entry.ordinal);
      continue;
    }
    invalid += 1;
    await deps.writeFinding(run, { ordinal: entry.ordinal, outcome: "INVALID", invalidReason: entry.verdict.reason, suggestionId: null });
  }
  const { written } = await deps.writeFound(run, { findings: found.findings, pages: found.pages, valid, dropped: validated.dropped });
  if (!written) throw ApplicationFailure.create({ type: "TEXT_PURGED", message: `research run ${run.id}: its text was purged while the findings were checked`, nonRetryable: true });
  deps.log(`research ${run.id}: ${String(valid.length)} valid, ${String(invalid)} invalid, ${String(validated.dropped)} dropped beyond the third (trace ${run.traceId})`);
  return { valid: valid.length, invalid, duplicate: 0 };
}

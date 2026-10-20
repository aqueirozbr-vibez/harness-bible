import { getPrisma } from "@/lib/db/client";
import { withTenant } from "@/lib/db/tenant";

/*
 * The grader's calibration set (architecture § 6.2; feature-specs/17 § 4; 22 § 3, P2.6a): a query, not a table.
 * Every flagged message with what the sensors and the grader said of it, what it cited, and the reader's coded
 * reason. It is what a curator labels from in Phase 4, and what the gate looks a flagged answer up in.
 *
 * A row says what was flagged and why. It does not say who flagged it, and it holds no text: the set calibrates a
 * grader, a flag's reason is a code and never free text (feature-specs/15 § 5.4), and the words of a message are
 * gone after 30 days while its flag stays.
 */

export interface CalibrationRow {
  readonly messageId: string;
  readonly mode: string;
  readonly flag: { readonly kind: string; readonly reason: string; readonly createdAt: Date };
  /** The cause when the flagged message is a refusal. */
  readonly refusalCause: string | null;
  /** The grader's score of the answer; null when it was not graded. */
  readonly grounded: number | null;
  readonly verdicts: ReadonlyArray<{ readonly sensor: string; readonly verdict: string; readonly detail: string }>;
  readonly citations: ReadonlyArray<{ readonly sectionId: string; readonly figureId: string | null }>;
  readonly guideVersion: string | null;
  readonly modelId: string | null;
}

/**
 * Every flagged message, oldest flag first. The flags are every reader's, and the guard admits no reader's rows
 * without a tenant, so the one cross-reader statement names who has a flag and each reader's rows are then read
 * inside that reader's own context, as the retention purge does (`lib/db/assistant.ts` `purgeAssistantText`).
 */
export async function calibrationSet(): Promise<ReadonlyArray<CalibrationRow>> {
  const prisma = getPrisma();
  const owners = await prisma.$queryRaw<Array<{ userId: string }>>`SELECT DISTINCT "userId" FROM "Flag"`;
  const rows: CalibrationRow[] = [];
  for (const owner of owners) {
    const flags = await withTenant({ userId: owner.userId, organisationId: null }, () =>
      prisma.flag.findMany({
        select: {
          kind: true,
          reason: true,
          createdAt: true,
          message: {
            select: {
              id: true,
              mode: true,
              refusalCause: true,
              grounded: true,
              guideVersion: true,
              modelId: true,
              verdicts: { orderBy: { sensor: "asc" }, select: { sensor: true, verdict: true, detail: true } },
              citations: { orderBy: { ordinal: "asc" }, select: { sectionId: true, figureId: true } },
            },
          },
        },
      }),
    );
    for (const flag of flags) {
      rows.push({
        messageId: flag.message.id,
        mode: flag.message.mode,
        flag: { kind: flag.kind, reason: flag.reason, createdAt: flag.createdAt },
        refusalCause: flag.message.refusalCause,
        grounded: flag.message.grounded === null ? null : Number(flag.message.grounded),
        verdicts: flag.message.verdicts,
        citations: flag.message.citations,
        guideVersion: flag.message.guideVersion,
        modelId: flag.message.modelId,
      });
    }
  }
  return rows.sort((a, b) => a.flag.createdAt.getTime() - b.flag.createdAt.getTime());
}

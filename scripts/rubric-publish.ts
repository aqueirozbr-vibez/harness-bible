import { publishRubricVersion } from "@/lib/db/improve";
import { withSystem } from "@/lib/db/tenant";
import { AppError } from "@/lib/errors";
import { loadRubric, RUBRIC_DIR } from "@/lib/rubrics/load";
import { CHANGE_CLASSES } from "@/lib/schemas/improve";

/*
 * npm run rubric:publish -- v1.2 [--dir <folder>] — publishes a rubric version (feature-specs/30 § 5.1): checks
 * the file against its manifest's hash, and writes the RubricVersion row and its Threshold rows if absent.
 * Idempotent: a version already published with the same hash says so and writes nothing; one published with
 * another hash is refused, as is a file whose bytes differ from its manifest, because a version is never edited
 * in place. `--dir` names another folder of rubrics, for a test that must not touch the repository's.
 */

const args = process.argv.slice(2);
const dirAt = args.indexOf("--dir");
const dir = dirAt === -1 ? RUBRIC_DIR : args[dirAt + 1];
const rest = dirAt === -1 ? args : args.filter((arg, index) => index !== dirAt && index !== dirAt + 1);
const version = rest[0];
if (version === undefined || rest.length > 1 || dir === undefined) {
  console.error("usage: npm run rubric:publish -- <version> [--dir <folder>]");
  process.exit(1);
}

async function main(): Promise<void> {
  const loaded = loadRubric(version, dir);
  const { rubric, sha256 } = loaded;
  const day = (date: string): Date => new Date(`${date}T00:00:00Z`);
  const result = await withSystem(() =>
    publishRubricVersion({
      id: rubric.version,
      publishedAt: day(rubric.publishedAt),
      appliesAt: day(rubric.appliesAt),
      sha256,
      tiers: rubric.tiers,
      adjustments: rubric.adjustments,
      examples: rubric.examples,
      thresholds: CHANGE_CLASSES.map((changeClass) => {
        const threshold = rubric.thresholds[changeClass];
        return { changeClass, acceptAt: threshold === null ? null : threshold.acceptAt, floorAt: threshold === null ? null : threshold.floorAt };
      }),
    }),
  );
  if (result.outcome === "already") {
    console.log(`rubric ${rubric.version} is published already (sha256 ${result.sha256.slice(0, 12)}…); nothing written`);
    return;
  }
  console.log(`rubric ${rubric.version} published: applies from ${rubric.appliesAt}, sha256 ${sha256.slice(0, 12)}…, ${String(result.thresholds)} threshold rows`);
}

main().catch((error: unknown) => {
  console.error(error instanceof AppError || error instanceof Error ? error.message : String(error));
  process.exit(1);
});

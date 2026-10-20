import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { readRubricManifest, RUBRIC_DIR, rubricText } from "@/lib/rubrics/load";
import { RubricSchema } from "@/lib/schemas/rubric";
import { sha256 } from "@/pipeline/renderHash";

/*
 * npm run rubric:pin -- v1.2 — writes a rubric's sha256 into its manifest, as guides:pin does for a guide. Run it
 * once when a new rubric version is created; an existing version is never re-pinned (the loader's check is the
 * point, and the row `rubric:publish` wrote carries the hash too). The file is parsed first, so a rubric that is
 * not a rubric is not pinned.
 */

const [version, ...rest] = process.argv.slice(2);
if (version === undefined || rest.length > 0) {
  console.error("usage: npm run rubric:pin -- <version>");
  process.exit(1);
}
const manifest = readRubricManifest(version);
const text = rubricText(version);
const parsed = RubricSchema.safeParse(JSON.parse(text));
if (!parsed.success) {
  console.error(`rubric ${version} is not a rubric: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  process.exit(1);
}
if (parsed.data.version !== version) {
  console.error(`rubric ${version} says it is ${parsed.data.version}`);
  process.exit(1);
}
const hash = sha256(text);
writeFileSync(join(RUBRIC_DIR, version, "manifest.json"), `${JSON.stringify({ ...manifest, sha256: hash }, null, 2)}\n`);
console.log(`rubric ${version}: ${manifest.files.join(" + ")} → sha256 ${hash} (${String(text.length)} chars)`);

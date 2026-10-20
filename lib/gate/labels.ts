import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { LabelSchema, type Label } from "@/lib/schemas/labels";

/*
 * The curator's labels as a file (feature-specs/22 § 5, D3): golden/assistant/labels/<release>.jsonl, one label a
 * line, written by hand with `npm run gate:show` as the reading aid. The file is part of the repository: a label is
 * a person's reading, and the only copy of it.
 */

export const LABELS_DIR = join(process.cwd(), "golden", "assistant", "labels");

export function labelsFileName(release: string): string {
  return `${release}.jsonl`;
}

/**
 * The release's labels in the file's order; none when nobody has labelled yet. A line that is not a label stops the
 * read and names its line: a label the gate cannot read must not become one label fewer without anyone noticing.
 */
export function readLabels(dir: string, release: string): ReadonlyArray<Label> {
  const path = join(dir, labelsFileName(release));
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .flatMap((line, index) => {
      if (line.trim().length === 0) return [];
      const where = `${labelsFileName(release)}:${String(index + 1)}`;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(`${where} is not JSON`);
      }
      const label = LabelSchema.safeParse(parsed);
      if (!label.success) throw new Error(`${where} is not a label: ${label.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`);
      return [label.data];
    });
}

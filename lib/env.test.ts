import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * The environment's one reader (code-standards § Next.js): every variable the schema declares is read from the
 * process, and nothing is read that the schema does not declare. A variable declared and never read parses as unset
 * whatever the process holds, which is how unit 53e's two settings first read as off.
 */

const source = readFileSync(join(import.meta.dirname, "env.ts"), "utf8").replace(/\r\n/g, "\n");
const schema = source.slice(source.indexOf("const EnvSchema = z"), source.indexOf(".superRefine("));
const fed = source.slice(source.indexOf("export const env: Env = EnvSchema.parse({"));

describe("lib/env.ts", () => {
  it("reads every variable it declares, and only those", () => {
    const declared = [...schema.matchAll(/^ {4}([A-Z][A-Z0-9_]+):/gm)].map((match) => match[1]);
    const read = [...fed.matchAll(/^ {2}([A-Z][A-Z0-9_]+): /gm)].map((match) => match[1]);
    expect(declared.length).toBeGreaterThan(20);
    expect([...read].sort()).toEqual([...declared].sort());
  });
});

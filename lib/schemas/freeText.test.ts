import { describe, expect, it } from "vitest";
import { z } from "zod";

import { freeTextIn } from "./freeText";
import { ReleaseIdSchema } from "./ids";

/*
 * The walk that keeps a reader's words out of a workflow's history (feature-specs/28 § 5.3, § 10.9): what it lets
 * through, what it finds and where it says it found it. That the workflow schemas themselves pass it is
 * workflows.test.ts.
 */

describe("freeTextIn", () => {
  it("finds nothing in ids, enumerations, numbers, booleans, hashes and instants", () => {
    const schema = z.strictObject({
      id: z.uuid(),
      release: ReleaseIdSchema,
      hash: z.string().regex(/^[0-9a-f]{64}$/),
      at: z.iso.datetime(),
      route: z.enum(["ACCEPT", "DECLINE"]),
      kind: z.literal("decided"),
      score: z.number(),
      seq: z.int().nonnegative(),
      endorsed: z.boolean(),
      nothing: z.null(),
      workflowId: z.templateLiteral(["proving:", z.uuid()]),
    });
    expect(freeTextIn(schema)).toEqual([]);
  });

  it("refuses a bare string, and one whose only checks are lengths", () => {
    expect(freeTextIn(z.strictObject({ note: z.string() }))).toEqual(["$.note: a string with no pattern"]);
    expect(freeTextIn(z.strictObject({ note: z.string().min(1).max(280) }))).toEqual(["$.note: a string with no pattern"]);
    expect(freeTextIn(z.string().refine((value) => value.length > 0))).toEqual(["$: a string with no pattern"]);
  });

  it("refuses a pattern that a sentence passes: a pattern in name only", () => {
    expect(freeTextIn(z.string().regex(/^.+$/))).toEqual(["$: a string whose pattern accepts a sentence"]);
    expect(freeTextIn(z.string().regex(/\?$/))).toEqual(["$: a string whose pattern accepts a sentence"]);
  });

  it("reads a template by its parts: the literals are the schema's own, the schemas between them are walked", () => {
    expect(freeTextIn(z.templateLiteral(["proving:", z.uuid()]))).toEqual([]);
    expect(freeTextIn(z.templateLiteral(["q:", z.string()]))).toEqual(["$`…`: a string with no pattern"]);
    expect(freeTextIn(z.templateLiteral(["n:", z.number(), ":", z.enum(["a", "b"])]))).toEqual([]);
  });

  it("refuses an e-mail address and a URL: one is a person's, the other carries words", () => {
    expect(freeTextIn(z.iso.date())).toEqual([]);
    expect(freeTextIn(z.email())).toEqual(['$: a string of the format "email", which is not an id, an instant or a day']);
    expect(freeTextIn(z.url())).toEqual(['$: a string of the format "url", which is not an id, an instant or a day']);
  });

  it("looks inside every wrapper and container, and says where it found the text", () => {
    const text = z.string();
    expect(freeTextIn(z.strictObject({ a: z.strictObject({ b: text }) }))).toEqual(["$.a.b: a string with no pattern"]);
    expect(freeTextIn(z.array(text))).toEqual(["$[]: a string with no pattern"]);
    expect(freeTextIn(z.tuple([z.uuid(), text]))).toEqual(["$[1]: a string with no pattern"]);
    expect(freeTextIn(z.tuple([z.uuid()], text))).toEqual(["$[…]: a string with no pattern"]);
    expect(freeTextIn(z.union([z.uuid(), text]))).toEqual(["$|1: a string with no pattern"]);
    expect(freeTextIn(z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("a") }), z.strictObject({ kind: z.literal("b"), why: text })]))).toEqual(["$|1.why: a string with no pattern"]);
    expect(freeTextIn(z.intersection(z.object({ a: z.uuid() }), z.object({ b: text })))).toEqual(["$.b: a string with no pattern"]);
    expect(freeTextIn(z.record(z.enum(["a", "b"]), text))).toEqual(["${}: a string with no pattern"]);
    expect(freeTextIn(z.record(text, z.number()))).toEqual(["${key}: a string with no pattern"]);
    for (const wrapped of [text.optional(), text.nullable(), text.default("x"), z.array(text).readonly()]) {
      expect(freeTextIn(wrapped).length, wrapped.def.type).toBe(1);
    }
  });

  it("refuses an object that keeps keys nobody named, and allows the two that do not", () => {
    expect(freeTextIn(z.looseObject({ id: z.uuid() }))).toEqual(['$.*: a schema of the kind "unknown", which this walk does not know to be free of text']);
    expect(freeTextIn(z.object({ id: z.uuid() }))).toEqual([]);
    expect(freeTextIn(z.strictObject({ id: z.uuid() }))).toEqual([]);
  });

  it("refuses every kind it does not know, by name", () => {
    for (const [kind, schema] of [
      ["unknown", z.unknown()],
      ["any", z.any()],
      ["pipe", z.uuid().transform((value) => value.length)],
      ["lazy", z.lazy(() => z.uuid())],
      ["date", z.date()],
      ["custom", z.custom<string>()],
    ] as const) {
      expect(freeTextIn(schema), kind).toEqual([`$: a schema of the kind "${kind}", which this walk does not know to be free of text`]);
    }
  });
});

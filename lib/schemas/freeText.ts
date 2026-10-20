import type { z } from "zod";

/*
 * Where a schema could carry a person's or a model's words (feature-specs/28 § 5.3; architecture § 11, invariant
 * 35). The workflow engine keeps every workflow argument, every activity argument and every result, and the 30-day
 * purge cannot reach a copy there. So what crosses to the engine is ids, enumerations, numbers, booleans, hashes
 * and instants, and this walk is what holds a schema to that: it returns every place in it that could hold a
 * sentence, and lib/schemas/workflows.test.ts runs it over everything that file exports.
 *
 * It allows by name, not refuses by name: a kind of schema it does not know is a finding, so a new kind is a
 * decision somebody takes here and not something that slips through.
 */

/*
 * Any question a reader might ask: several words, spaces, punctuation. A pattern that accepts it is a pattern in
 * name only (`.+`, or one with no anchors). This is a probe and not a proof: a pattern written to let prose through
 * behind a prefix would pass it. It is here for the pattern written carelessly, which is the one that happens.
 */
const A_SENTENCE = "What is idempotency, and why does chapter 21 care?";

/** The string formats that are an id, an instant or a day. An e-mail address is a person's; a URL carries words in its query. */
const FORMATS = new Set(["uuid", "datetime", "date"]);

/** Kinds that hold no string at all, or only the ones the schema itself lists. */
const CLOSED = new Set(["number", "boolean", "null", "enum", "literal"]);

/** Kinds that only wrap another schema. */
const WRAPPERS = new Set(["optional", "nullable", "default", "prefault", "nonoptional", "readonly", "catch"]);

interface Def {
  readonly type: string;
  readonly format?: string;
  readonly checks?: ReadonlyArray<{ readonly _zod: { readonly def: { readonly check: string } } }>;
  readonly shape?: Readonly<Record<string, z.ZodType>>;
  readonly catchall?: z.ZodType;
  readonly element?: z.ZodType;
  readonly items?: ReadonlyArray<z.ZodType>;
  readonly rest?: z.ZodType | null;
  readonly options?: ReadonlyArray<z.ZodType>;
  readonly left?: z.ZodType;
  readonly right?: z.ZodType;
  readonly innerType?: z.ZodType;
  readonly keyType?: z.ZodType;
  readonly valueType?: z.ZodType;
  /** A template's parts: the literals it is written with, and the schemas between them. */
  readonly parts?: ReadonlyArray<unknown>;
}

const isSchema = (part: unknown): part is z.ZodType => typeof part === "object" && part !== null && "def" in part;

function stringFinding(schema: z.ZodType, def: Def, path: string): ReadonlyArray<string> {
  const patterned = (def.format !== undefined && FORMATS.has(def.format)) || (def.format === undefined && (def.checks ?? []).some((check) => check._zod.def.check === "string_format"));
  if (def.format !== undefined && !FORMATS.has(def.format)) return [`${path}: a string of the format "${def.format}", which is not an id, an instant or a day`];
  if (!patterned) return [`${path}: a string with no pattern`];
  if (schema.safeParse(A_SENTENCE).success) return [`${path}: a string whose pattern accepts a sentence`];
  return [];
}

/**
 * Every place in `schema` that could hold free text, as `path: reason`; empty when there is none. `path` starts at
 * `$` and follows the keys.
 */
export function freeTextIn(schema: z.ZodType, path = "$"): ReadonlyArray<string> {
  const def = schema.def as unknown as Def;
  const { type } = def;
  if (CLOSED.has(type)) return [];
  if (type === "string") return stringFinding(schema, def, path);
  /* A template is its literals and the schemas between them: `proving:` and a uuid. The literals are the schema's own words. */
  if (type === "template_literal" && def.parts !== undefined) return def.parts.flatMap((part) => (isSchema(part) ? freeTextIn(part, `${path}\`…\``) : []));
  if (WRAPPERS.has(type) && def.innerType !== undefined) return freeTextIn(def.innerType, path);
  if (type === "object" && def.shape !== undefined) {
    const fields = Object.entries(def.shape).flatMap(([key, field]) => freeTextIn(field, `${path}.${key}`));
    /* `strictObject` has a catch-all that takes nothing; `looseObject` one that takes anything, which is found below. */
    const others = def.catchall === undefined || (def.catchall.def as unknown as Def).type === "never" ? [] : freeTextIn(def.catchall, `${path}.*`);
    return [...fields, ...others];
  }
  if (type === "array" && def.element !== undefined) return freeTextIn(def.element, `${path}[]`);
  if (type === "tuple" && def.items !== undefined) {
    return [...def.items.flatMap((item, index) => freeTextIn(item, `${path}[${String(index)}]`)), ...(def.rest === undefined || def.rest === null ? [] : freeTextIn(def.rest, `${path}[…]`))];
  }
  if (type === "union" && def.options !== undefined) return def.options.flatMap((option, index) => freeTextIn(option, `${path}|${String(index)}`));
  if (type === "intersection" && def.left !== undefined && def.right !== undefined) return [...freeTextIn(def.left, path), ...freeTextIn(def.right, path)];
  if (type === "record" && def.keyType !== undefined && def.valueType !== undefined) return [...freeTextIn(def.keyType, `${path}{key}`), ...freeTextIn(def.valueType, `${path}{}`)];
  return [`${path}: a schema of the kind "${type}", which this walk does not know to be free of text`];
}

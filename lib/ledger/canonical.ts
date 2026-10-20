import { AppError } from "@/lib/errors";

/*
 * RFC 8785, the JSON Canonicalization Scheme (architecture § 4.3;
 * feature-specs/14 § 3.1, D1): one byte sequence per JSON value, so a hash
 * computed here can be recomputed by anyone holding the record and the RFC.
 * Members sort by the UTF-16 code units of their names, nothing is
 * whitespace, strings take JSON's minimal escaping, numbers take
 * ECMAScript's Number-to-String form. The pipeline's `canonicalJson` is not
 * this (it accepts Dates and drops undefined) and keeps its own render hashes.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | ReadonlyArray<JsonValue> | { readonly [name: string]: JsonValue };

/** The RFC 8785 text of `value`. Throws `LEDGER_NOT_JSON` on anything JSON cannot carry (undefined, a Date, a bigint, NaN, Infinity): a record holding one is a defect, not something to round. */
export function canonicalize(value: JsonValue): string {
  return serialise(value, "$");
}

function serialise(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw notJson(path, String(value));
      return String(value);
    case "object":
      return Array.isArray(value) ? serialiseArray(value, path) : serialiseObject(value, path);
    default:
      throw notJson(path, typeof value);
  }
}

function serialiseArray(values: ReadonlyArray<unknown>, path: string): string {
  return `[${values.map((item, index) => serialise(item, `${path}[${index}]`)).join(",")}]`;
}

function serialiseObject(value: object, path: string): string {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw notJson(path, describeObject(value));
  const members = value as Readonly<Record<string, unknown>>;
  const names = Object.keys(members).sort();
  return `{${names.map((name) => `${JSON.stringify(name)}:${serialise(members[name], `${path}.${name}`)}`).join(",")}}`;
}

/** The refused object's constructor name; a prototype chain without one (`Object.create(Object.create(null))`) is named as such rather than dereferenced. */
function describeObject(value: object): string {
  const constructor: unknown = Reflect.get(value, "constructor");
  return typeof constructor === "function" ? constructor.name : "an object without a constructor";
}

function notJson(path: string, what: string): AppError {
  return new AppError("LEDGER_NOT_JSON", `${path} is ${what}, not a JSON value; a ledger record is hashed as JSON only`);
}

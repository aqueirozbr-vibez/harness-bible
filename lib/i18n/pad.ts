/*
 * The padded Portuguese catalogue (project-overview § Success criteria · Phase 1: "a PT label truncation snapshot
 * suite passes with every string at least 30% longer than its EN counterpart in the fixture"; ui-context § 1.4,
 * § 11: every label is sized for the longer edition, and labels wrap, never truncate).
 *
 * The fixture is not a file. It is computed from the two real catalogues: each PT string that is not already 30 %
 * longer than its EN counterpart is lengthened until it is, so the fixture can never fall behind the strings the
 * product ships. The padding is filler, not translation — its one job is to occupy the width a longer translation
 * would, with real words that wrap where words wrap.
 *
 * Length is what a reader sees: a `{placeholder}` is filled with the same value in both languages, so it counts for
 * neither, and a plural is read by its `other` branch. A string with no letter in it (`·`, `{n} / {max}`) has no
 * label to truncate and is left alone.
 *
 * Pure: no I/O. `lib/i18n/request.ts` serves it to a request that asks for it, outside production only, and
 * `tests/layout/` renders the screens with it.
 */

/** A catalogue as `messages/*.json` holds it: strings in nested groups. */
export interface Messages {
  readonly [key: string]: string | Messages;
}

/** "At least 30% longer than its EN counterpart." */
export const PAD_RATIO = 1.3;

/** The request header that asks for a fixture catalogue, and the one fixture there is. */
export const FIXTURE_HEADER = "x-hb-i18n-fixture";
export const PADDED_FIXTURE = "padded";

/** Portuguese words of several lengths, cycled in this order: short ones to fill a gap, long ones to force a wrap. */
const FILLER = ["também", "ainda", "mais", "aqui", "sempre", "então"] as const;

/** The index of the `}` that closes the `{` at `open`; the string's end when it is never closed. */
function closing(message: string, open: number): number {
  let depth = 0;
  for (let index = open; index < message.length; index += 1) {
    if (message[index] === "{") depth += 1;
    else if (message[index] === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return message.length;
}

/** What an argument contributes to the text: nothing for `{name}`, the `other` branch for a plural or a select. */
function argumentText(inner: string): string {
  const parts = /^\s*\w+\s*,\s*(plural|select|selectordinal)\s*,/.exec(inner);
  if (parts === null) return "";
  const other = /\bother\s*\{/.exec(inner.slice(parts[0].length));
  if (other === null) return "";
  const open = parts[0].length + other.index + other[0].length - 1;
  return visibleText(inner.slice(open + 1, closing(inner, open)));
}

/** The text a reader sees of an ICU message, as far as its length is concerned. */
export function visibleText(message: string): string {
  let out = "";
  let index = 0;
  while (index < message.length) {
    if (message[index] !== "{") {
      out += message[index];
      index += 1;
      continue;
    }
    const end = closing(message, index);
    out += argumentText(message.slice(index + 1, end));
    index = end + 1;
  }
  return out;
}

/** Whether a string has a label in it at all: at least one letter a reader sees. */
export function hasLabel(message: string): boolean {
  return /\p{L}/u.test(visibleText(message));
}

/** The length the fixture's string must reach for an EN string: 30 % more, rounded up. */
export function paddedLength(en: string): number {
  return Math.ceil(PAD_RATIO * visibleText(en).length);
}

/**
 * The PT string as the fixture carries it. Filler is appended after the message, outside every brace, so the result
 * is the same ICU message with a longer tail: placeholders, plural branches and their order are untouched.
 */
export function padMessage(en: string, pt: string): string {
  if (!hasLabel(en)) return pt;
  const need = paddedLength(en);
  let out = pt;
  for (let word = 0; visibleText(out).length < need; word += 1) out = `${out} ${FILLER[word % FILLER.length] ?? ""}`;
  return out;
}

/** The fixture: the PT catalogue with every string padded against its EN counterpart. Keys EN lacks are left as they are. */
export function padCatalogue(en: Messages, pt: Messages): Messages {
  const out: Record<string, string | Messages> = {};
  for (const [key, value] of Object.entries(pt)) {
    const counterpart = en[key];
    if (typeof value === "string") out[key] = typeof counterpart === "string" ? padMessage(counterpart, value) : value;
    else out[key] = padCatalogue(typeof counterpart === "object" ? counterpart : {}, value);
  }
  return out;
}

function flatten(messages: Messages, prefix = ""): ReadonlyArray<readonly [string, string]> {
  return Object.entries(messages).flatMap(([key, value]) => {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    return typeof value === "string" ? [[path, value] as const] : flatten(value, path);
  });
}

export interface FixtureStats {
  /** Every string of the catalogue. */
  readonly strings: number;
  /** Strings with no letter a reader sees: nothing to truncate, so nothing to pad. */
  readonly exempt: number;
  /** Strings the fixture had to lengthen; the rest were already 30 % longer than their EN counterpart. */
  readonly padded: number;
  /** The keys whose fixture string is still short of the ratio: the criterion's own check, and it must be empty. */
  readonly short: ReadonlyArray<string>;
}

/** The fixture measured against the criterion: is every string at least 30 % longer than its EN counterpart? */
export function fixtureStats(en: Messages, pt: Messages, fixture: Messages): FixtureStats {
  const original = new Map(flatten(pt));
  const english = new Map(flatten(en));
  let exempt = 0;
  let padded = 0;
  const short: string[] = [];
  const all = flatten(fixture);
  for (const [key, value] of all) {
    const counterpart = english.get(key);
    if (counterpart === undefined || !hasLabel(counterpart)) {
      exempt += 1;
      continue;
    }
    if (value !== original.get(key)) padded += 1;
    if (visibleText(value).length < paddedLength(counterpart)) short.push(key);
  }
  return { strings: all.length, exempt, padded, short };
}

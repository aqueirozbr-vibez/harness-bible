import type { Aid } from "./schema";

/*
 * Pure rules of a decision aid: checking an aid against its script, checking
 * a user's inputs against the declared ranges, patching the script, and
 * reading a step's values out of the script's results.
 */

const PLACEHOLDER = /\{([a-z][a-z0-9_]*)\}/g;

export interface AidProblem {
  readonly where: string;
  readonly message: string;
}

/** Every reason an aid cannot drive this script text; empty when it can. */
export function checkAid(aid: Aid, scriptText: string): ReadonlyArray<AidProblem> {
  const lines = scriptText.replace(/\r\n/g, "\n").split("\n");
  const problems: AidProblem[] = [];
  const keys = new Set(aid.inputs.map((i) => i.key));
  const used = new Set<string>();
  aid.edits.forEach((edit, index) => {
    const where = `edits[${index}] line ${edit.line}`;
    const line = lines[edit.line - 1];
    if (line === undefined) {
      problems.push({ where, message: `the script has ${lines.length} lines` });
      return;
    }
    const count = line.split(edit.find).length - 1;
    if (count !== 1) problems.push({ where, message: `"${edit.find}" occurs ${count} times on that line` });
    for (const m of edit.with.matchAll(PLACEHOLDER)) {
      if (!keys.has(m[1])) problems.push({ where, message: `placeholder {${m[1]}} is not a declared input` });
      used.add(m[1]);
    }
  });
  for (const key of keys) if (!used.has(key)) problems.push({ where: `inputs.${key}`, message: "no edit uses this input" });
  aid.steps.forEach((step, index) => {
    if (step.line !== null && step.line > lines.length) problems.push({ where: `steps[${index}]`, message: `line ${step.line} is past the end of the script` });
    /* A step may present only what it reads (feature-specs/18 § 3): a bar or a headline over a path the step does not
       read would be a number the prompt never carried, which the derive sensor could not check. */
    const reads = new Set(step.reads);
    step.bars.forEach((bar, position) => {
      if (!reads.has(bar.path)) problems.push({ where: `steps[${index}].bars[${position}]`, message: `path ${bar.path} is not among the step's reads` });
    });
    const paths = step.headline === null ? [] : step.headline.kind === "ratio" ? [...step.headline.of] : [step.headline.path];
    for (const path of paths) if (!reads.has(path)) problems.push({ where: `steps[${index}].headline`, message: `path ${path} is not among the step's reads` });
  });
  const ordinals = aid.steps.map((s) => s.ordinal);
  if (ordinals.some((o, i) => o !== i + 1)) problems.push({ where: "steps", message: "ordinals must run 1..n" });
  return problems;
}

export interface InputError {
  readonly key: string;
  readonly reason: "missing" | "not_a_number" | "below_min" | "above_max" | "not_integer";
  readonly min: number;
  readonly max: number;
}

/** The inputs a user gave, validated against the aid; errors name the range so the form can say it. */
export function checkInputs(aid: Aid, given: Readonly<Record<string, unknown>>): { readonly values: Readonly<Record<string, number>>; readonly errors: ReadonlyArray<InputError> } {
  const values: Record<string, number> = {};
  const errors: InputError[] = [];
  for (const input of aid.inputs) {
    const raw = given[input.key];
    const base = { key: input.key, min: input.min, max: input.max };
    if (raw === undefined || raw === null || raw === "") {
      errors.push({ ...base, reason: "missing" });
      continue;
    }
    const n = typeof raw === "number" ? raw : Number(String(raw).replace(",", "."));
    if (!Number.isFinite(n)) errors.push({ ...base, reason: "not_a_number" });
    else if (n < input.min) errors.push({ ...base, reason: "below_min" });
    else if (n > input.max) errors.push({ ...base, reason: "above_max" });
    else if (input.integer && !Number.isInteger(n)) errors.push({ ...base, reason: "not_integer" });
    else values[input.key] = n;
  }
  return { values, errors };
}

/** A Python literal for the scaled value: integers without a decimal point, floats shortest round-trip. */
export function pythonLiteral(value: number, scale: number, integer: boolean): string {
  const scaled = value * scale;
  if (integer && scale === 1) return String(Math.round(scaled));
  const trimmed = Number(scaled.toPrecision(12));
  return Number.isInteger(trimmed) && scale === 1 ? String(trimmed) : trimmed.toString();
}

/** The script with the aid's edits applied for these (validated) inputs. */
export function applyAid(aid: Aid, scriptText: string, values: Readonly<Record<string, number>>): string {
  const byKey = new Map(aid.inputs.map((i) => [i.key, i]));
  const lines = scriptText.replace(/\r\n/g, "\n").split("\n");
  for (const edit of aid.edits) {
    const replacement = edit.with.replace(PLACEHOLDER, (_m, key: string) => {
      const input = byKey.get(key);
      const value = values[key];
      if (input === undefined || value === undefined) throw new Error(`aid ${aid.id}: no value for {${key}}`);
      return pythonLiteral(value, input.scale, input.integer);
    });
    const index = edit.line - 1;
    const line = lines[index];
    if (line === undefined || line.split(edit.find).length !== 2) throw new Error(`aid ${aid.id}: line ${edit.line} does not hold "${edit.find}" exactly once`);
    lines[index] = line.replace(edit.find, replacement);
  }
  return lines.join("\n");
}

/** A slash path (`A/total`, `sensitivity_B/esc/0.3`; keys themselves may contain dots) read from the results object; undefined when absent. */
export function readPath(results: unknown, path: string): unknown {
  let current: unknown = results;
  for (const part of path.split("/")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** The values a step shows, keyed by their path; a missing path is reported, never invented. */
export function stepValues(aid: Aid, ordinal: number, results: unknown): { readonly values: Readonly<Record<string, unknown>>; readonly missing: ReadonlyArray<string> } {
  const step = aid.steps.find((s) => s.ordinal === ordinal);
  if (step === undefined) throw new Error(`aid ${aid.id}: no step ${ordinal}`);
  const values: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const path of step.reads) {
    const value = readPath(results, path);
    if (value === undefined) missing.push(path);
    else values[path] = value;
  }
  return { values, missing };
}

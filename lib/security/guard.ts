import { processSecrets } from "@/lib/security/processSecrets";
import { redactSecrets } from "@/lib/security/redact";

/*
 * The guard on what is written out (feature-specs/21 § 6.2): every string of a log line and every attribute of a
 * span passes through it before it leaves the process. It is a defence in depth: a line holds ids, counts, codes
 * and hashes and no text, so a finding here is a defect somewhere upstream, and the caller marks the line
 * `hb.secret.detected` so that the defect pages someone. Whatever the cause, the value does not go out.
 */

export interface Guarded<T> {
  /** The same value when nothing was found; a copy with each secret replaced otherwise. */
  readonly value: T;
  /** How many secrets were replaced. */
  readonly detected: number;
}

/** Walks strings, arrays and plain objects; everything else is returned as it is. */
export function guard<T>(value: T, literals: ReadonlyArray<string> = processSecrets()): Guarded<T> {
  if (typeof value === "string") {
    const redaction = redactSecrets(value, literals);
    return redaction.findings.length === 0 ? { value, detected: 0 } : { value: redaction.text as T, detected: redaction.findings.length };
  }
  if (Array.isArray(value)) {
    let detected = 0;
    const items = value.map((item: unknown) => {
      const guarded = guard(item, literals);
      detected += guarded.detected;
      return guarded.value;
    });
    return detected === 0 ? { value, detected: 0 } : { value: items as T, detected };
  }
  if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    let detected = 0;
    const entries = Object.entries(value).map(([key, item]): [string, unknown] => {
      const guarded = guard(item, literals);
      detected += guarded.detected;
      return [key, guarded.value];
    });
    return detected === 0 ? { value, detected: 0 } : { value: Object.fromEntries(entries) as T, detected };
  }
  return { value, detected: 0 };
}

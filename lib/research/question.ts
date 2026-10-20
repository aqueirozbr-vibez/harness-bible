import { sha256Hex } from "@/lib/ledger/hash";

/*
 * A research question's one hash (feature-specs/40 § 5; 48 § 4.2, § 15), pure. A run's `questionSha256` is the sha256
 * of the question lower-cased with its whitespace collapsed, for a legacy run (the hand-over's hash of the turn's
 * question) and for a person's run (the start's hash of the question as stored, redacted, and the workers' after they
 * redact it again) alike; the person's run's `RESEARCH` record carries the same hash, so an auditor can match the two.
 * It moved here from `lib/research/eligibility.ts` in unit 70, since a person's research has no eligibility; the
 * eligibility went with the hand-over in unit 75 (48 § 9.2).
 */

/** The question the hash is of: lower-cased, whitespace collapsed (40 § 5). */
export function normalisedQuestion(question: string): string {
  return question.toLowerCase().replace(/\s+/g, " ").trim();
}

/** The sha256 of the normalised question, as the run's row and its record carry it (48 § 4.2, § 15). */
export function questionSha256Of(question: string): string {
  return sha256Hex(normalisedQuestion(question));
}

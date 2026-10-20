import type { RefusalCause } from "@/lib/schemas/assistant";

/*
 * The scope sensor's rules (feature-specs/13 § 4.1): pure, no model, run before retrieval and before any frontier
 * call, so a question the book will not answer costs nothing. The small-model half of the sensor (§ 4.1 step 2)
 * lives in the flow, which calls `scopeRules` first and only asks the classifier when these do not decide.
 *
 * Three rules, in the order a refusal is cheapest to justify:
 *
 *   R-UNVERIFIED   the chapter the question is asked of has not passed verification in this release. The caller
 *                  supplies the verdict, because a sensor that reads the database is not a pure function.
 *   R-RECOMPUTE    the question asks for arithmetic the book did not do. The assistant quotes figures; it never
 *                  computes one (invariant 12), so this is a refusal and not a limitation to apologise for.
 *   R-SCOPE-OT     the question asks how to act on plant equipment. The book is about harnesses, and an answer
 *                  here would be an instruction to touch a live process (architecture § 9).
 *
 * Every pattern is anchored on a whole word (`\b`) and matched case-insensitively against the question alone: the
 * conversation is not evidence, because a reader may quote the book's own sentences back at it. The two lists are
 * EN and PT, since the reader may ask in either and the refusal is about the act, not the language.
 *
 * Calibrated against `golden/assistant/2026.09.jsonl` (§ 9.1): all 13 recompute questions, all 12 OT questions and
 * all 12 unverified-chapter questions refuse, and none of the 150 figure questions does. `scope.test.ts` runs the
 * whole set on every change, because a rule that grows to catch one question and swallows a figure question has
 * made the assistant useless in exactly the place it is meant to be good.
 */

/** A verb that asks for a number the book did not print, in EN and PT. */
const RECOMPUTE_VERBS =
  /\b(recompute|recalculate|re-?run|rerun|extrapolate|estimate|scale (?:it |this |the )?(?:up|down)|project|recalcule|recalcular|recalcula|reestime|reestimar|estime|estimar|extrapole|extrapolar|projete|projetar)\b/i;

/** "what would it be at", "how much would it be", and the Portuguese forms: a hypothetical reading of a figure. */
const RECOMPUTE_HYPOTHETICAL =
  /\b(what would (?:it|that|the (?:number|figure|cost|price|total)) be|how much would|how many would|qual seria|quanto seria|quantos seriam)\b/i;

/**
 * The quantity a recomputation would be done at. Not "any number": a chapter number is a number, and "how does
 * chapter 37 estimate the harness cost?" is a question the book answers by quoting itself. What marks arithmetic
 * is a *scaling* — a multiplier, a percentage, or a figure introduced as the new input ("at 2,000 queries a day").
 */
const QUANTITY =
  /(\b\d[\d.,]*\s*(?:%|x\b|times\b|vezes\b)|\b(?:double|triple|half|twice|dobro|triplo|metade|three times|três vezes|tres vezes)\b|\b(?:at|to|for|with|per|com|por)\s+\d[\d.,]*\b)/i;

/**
 * Acting on equipment: the verb list of § 4.1, in its forms. "Walk me through forcing the transmitter" is the same
 * instruction as "force the transmitter", and the golden set says so; the inflections are spelled out rather than
 * stemmed, so a reader can see exactly which words count.
 */
const OT_VERBS =
  /\b(writ(?:e|es|ing|ten)|set(?:s|ting)?|forc(?:e|es|ed|ing)|bypass(?:es|ed|ing)?|disabl(?:e|es|ed|ing)|trip(?:s|ped|ping)?|start(?:s|ed|ing)?|stop(?:s|ped|ping)?|acknowledg(?:e|es|ed|ing)|ack|push(?:es|ed|ing)?|tun(?:e|es|ed|ing)|open(?:s|ed|ing)?|clos(?:e|es|ed|ing)|overrid(?:e|es|ing)|overrode|reset(?:s|ting)?|escreva|escrever|escrevendo|ajuste|ajustar|ajustando|forçar|forçando|force|desabilite|desabilitar|desabilitando|ignore|ignorar|ignorando|inicie|iniciar|iniciando|pare|parar|parando|reconheça|reconhecer|abra|abrir|abrindo|feche|fechar|fechando)\b/i;

/**
 * The things it would be done to, and only the ones that name plant. The list is deliberately narrower than § 4.1's
 * prose, because the wide reading refused the book's own vocabulary: `loop` is "the agent loop" in a dozen chapter
 * titles, and "where does each leave the other's question **open**" paired that verb with it and refused eight
 * compare questions of the golden set. `register`, `alarm`, `controller` and `loop` are therefore not evidence by
 * themselves — a question that means them in the plant sense almost always carries a tag or one of these words
 * too, and if it does not, the classifier is still behind this (§ 4.1 step 2).
 */
const OT_OBJECTS =
  /\b(setpoint|set point|emergency stop|e-stop|parada de emergência|parada de emergencia|plc|dcs|scada|valve|válvula|valvula|breaker|disjuntor|interlock|intertravamento|historian tag|transmitter|transmissor|pump|bomba|compressor|conveyor|esteira|modbus|ladder logic|ladder|opc|actuator|atuador|speed reference|referência de velocidade|furnace|forno|boiler|caldeira|turbine|turbina|reactor|reator|kiln|pid loop|opc ua)\b/i;

/** An ISA-style instrument tag: `P-101`, `LT-104`, `V-203`. Two or three letters, a dash, three or more digits. */
const OT_TAG = /\b[A-Z]{1,3}-\d{3,}\b/;

export interface ScopeFacts {
  readonly question: string;
  /**
   * Whether every chapter the question is asked of passed verification in this release: the context chapter, both
   * chapters of a compare, the aid's chapter of a walk. The caller reads the release; this stays pure.
   */
  readonly chaptersVerified: boolean;
}

export interface ScopeRuleResult {
  readonly cause: RefusalCause | null;
  /** Which rule decided, for the verdict's detail and for the test that says why a question refused. */
  readonly rule: "unverified" | "recompute" | "ot-verb-object" | "ot-tag" | null;
}

const NONE: ScopeRuleResult = { cause: null, rule: null };

/**
 * The two sections the guide names as what the book does cover when it refuses an operations question (§ 4.1): the
 * Assistant's refusal points at them, and so does a research a person's question started that the plant-equipment rule
 * refused at its start (feature-specs/48 § 5.2).
 */
export const OT_POINTERS: ReadonlyArray<string> = ["35.2", "28.1"];

/**
 * The plant-equipment rule alone (feature-specs/48 § 5.2; unit 71): the `ot-tag` and `ot-verb-object` rules of
 * `scopeRules`, in its order, for a research's start, which has no recompute rule — research computes nothing — and
 * decides the unverified-chapter rule from the release itself. `scopeRules` asks it last, so the two never part.
 */
export function otRule(question: string): ScopeRuleResult {
  /* A tag names one instrument in a plant — and the book names one too: chapter 21's worked example is the P-101
     work order, so a reader asking what the book computed for P-101 is asking about the book. The tag alone refused
     that question on 2026-10-03 (it was a false refusal, measured through the real gateway); a tag is now an object
     like the others, and it takes a verb to act on it. */
  if (OT_VERBS.test(question) && OT_TAG.test(question)) return { cause: "R-SCOPE-OT", rule: "ot-tag" };

  /* A verb and an object together: "write to the register", "bypass the interlock". Either alone is ordinary
     English about software — the book says "set the budget" and "start the run" on every other page. */
  if (OT_VERBS.test(question) && OT_OBJECTS.test(question)) return { cause: "R-SCOPE-OT", rule: "ot-verb-object" };

  return NONE;
}

/**
 * Whether a text is about operating equipment, by this same vocabulary: a verb of the list with an instrument tag
 * or an object of the list. Improve's class detection reads it of the anchored text and of the proposed text
 * (feature-specs/30 § 4.2 rule 3, D4: one vocabulary for "this is about operating equipment", not two), where a
 * false match costs a curator a look and a miss would let a model decide a safety statement.
 */
export function aboutOperatingEquipment(text: string): boolean {
  return OT_VERBS.test(text) && (OT_TAG.test(text) || OT_OBJECTS.test(text));
}

/** The rules of § 4.1 step 1. `null` means they did not decide and the small model is asked (§ 4.1 step 2). */
export function scopeRules(facts: ScopeFacts): ScopeRuleResult {
  if (!facts.chaptersVerified) return { cause: "R-UNVERIFIED", rule: "unverified" };

  const question = facts.question;

  /* A recomputation needs both halves: the ask and the quantity to do it at. "Estimate" alone is a word the book
     itself uses about its own figures, so the verb without a quantity is not a refusal. */
  if ((RECOMPUTE_VERBS.test(question) || RECOMPUTE_HYPOTHETICAL.test(question)) && QUANTITY.test(question)) {
    return { cause: "R-RECOMPUTE", rule: "recompute" };
  }

  return otRule(question);
}

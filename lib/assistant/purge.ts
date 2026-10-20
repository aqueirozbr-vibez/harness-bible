import { BRIEF_STANCES, CompareResultSchema, LabModeResultSchema, WalkModeResultSchema } from "@/lib/schemas/assistant";

/*
 * What the retention purge does to a stored mode result (feature-specs/21 § 3; architecture § 4.4). After 30 days a
 * turn's words go and its metadata stays. Since the walk and the three shaped modes store a result on the row so a
 * reload can render it (specs 18 D4, 19 § 6), some of the model's sentences live there too: a walk's explanations, a
 * lab's two lines, a compare's open point, a brief's decision and condition. Those are words, and they go; the
 * script's numbers, the run's table, the verdict of a figure and a brief's stance are metadata, and they stay.
 *
 * Pure: the purge reads the row, calls this, and writes back only when something changed. "Changed" is decided
 * here and told by identity: the same value comes back when there is nothing of the model's left in it. The caller
 * must not compare serialisations, because the database hands a JSON column back with its keys in its own order and
 * a string comparison would find a difference every night.
 */

function stanceOf(value: unknown): string | null {
  const stance = typeof value === "object" && value !== null ? (value as { stance?: unknown }).stance : undefined;
  return typeof stance === "string" && (BRIEF_STANCES as ReadonlyArray<string>).includes(stance) ? stance : null;
}

/** The mode result with the model's sentences removed; the same value back when there is nothing of the model's in it. */
export function purgedModeResult(mode: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  const lower = mode.toLowerCase();

  if (lower === "walk") {
    const walk = WalkModeResultSchema.safeParse(value);
    if (!walk.success || walk.data.explanations.every((explanation) => explanation.text === "")) return value;
    return { ...walk.data, explanations: walk.data.explanations.map((explanation) => ({ ...explanation, text: "" })) };
  }
  if (lower === "lab") {
    const lab = LabModeResultSchema.safeParse(value);
    if (!lab.success || (lab.data.reproduces === "" && lab.data.divergingMeans === null)) return value;
    return { ...lab.data, reproduces: "", divergingMeans: null };
  }
  if (lower === "compare") {
    const compare = CompareResultSchema.safeParse(value);
    return compare.success && compare.data.openPoint !== null ? { openPoint: null } : value;
  }
  if (lower === "brief") {
    /* The stance is a code, not a sentence: it stays, and the body reads it without a decision to caption. */
    const stance = stanceOf(value);
    const keys = typeof value === "object" ? Object.keys(value) : [];
    if (stance === null ? keys.length === 0 : keys.length === 1) return value;
    return stance === null ? {} : { stance };
  }
  return value;
}

/*
 * The assistant's series for one reader (feature-specs/25 § 3). The nine statements of `lib/metrics/sql/` count every
 * reader's rows and are never a request handler's (lib/db/RAW_SQL.md), so a page a reader opens cannot run them.
 * This file holds the same definitions over the rows it is given — one reader's, read through the tenant guard by
 * `lib/db/assistantStats.ts` — as pure functions: no database, no clock.
 *
 * Each definition is its statement's, word for word, and `tests/integration/assistant-stats.test.ts` holds the two
 * together: for a reader alone in a month, every statement's month value equals what is computed here. Change a
 * definition in one place and not the other and that test fails.
 *
 * Not here: cost per active account, which divides a platform's spend by its readers and means nothing for one of
 * them (the reader's cost is the budget meter), and the two measures that are not counted from message rows — the
 * cache-read share and the purge — which the loader reads beside these.
 */

/** One assistant row, as far as the definitions read it. */
export interface StatRow {
  readonly refusalCause: string | null;
  /** Null on a turn that failed: nothing answered it. */
  readonly modelId: string | null;
  /** How many of the answer's claims were replaced by "the book does not cover this". */
  readonly substituted: number;
  readonly firstTokenMs: number | null;
  /** The grader's score, 0 to 1; null when the answer was not graded. */
  readonly grounded: number | null;
  /** The edition the answer cites (`EN`, `PT`); null when it cites nothing. */
  readonly citesEdition: string | null;
  /** The citation sensor's verdict on this turn; null when the turn has no such verdict. */
  readonly citationVerdict: string | null;
  /** The coded reasons of the flags on this message. */
  readonly flagReasons: ReadonlyArray<string>;
  /** The language of the conversation the turn belongs to. */
  readonly locale: string;
}

/** A share: its numerator, its denominator, and the value, which is null when there is nothing to divide by. */
export interface Ratio {
  readonly n: number;
  readonly d: number;
  readonly value: number | null;
}

export interface ReaderStats {
  /** Every assistant row: an answer, a refusal or a failed turn. */
  readonly turns: number;
  /** citation-rate.sql: of the answers that made claims, those whose citation verdict is PASS with no claim replaced. */
  readonly citationRate: Ratio;
  /** refusal-rate.sql, key `any`: refusals over turns. */
  readonly refusalRate: Ratio;
  /** refusal-rate.sql, one line per cause that occurred, by cause. */
  readonly refusalsByCause: ReadonlyArray<{ readonly cause: string; readonly n: number; readonly value: number }>;
  /** first-token-p95.sql: over the turns that streamed a token. */
  readonly firstTokenP95: { readonly value: number | null; readonly samples: number };
  /** grounded.sql: the median and the 10th percentile of the grader's score, over the graded answers. */
  readonly grounded: { readonly p50: number | null; readonly p10: number | null; readonly samples: number };
  /** flag-rate.sql, key `any`: flagged assistant messages over assistant messages. */
  readonly flagRate: Ratio;
  /** flag-rate.sql, one line per coded reason, by reason. */
  readonly flagsByReason: ReadonlyArray<{ readonly reason: string; readonly n: number; readonly value: number }>;
  /** edition-mismatch.sql: per reader language, the answers that cite an edition in another language. */
  readonly editionMismatch: ReadonlyArray<{ readonly locale: string; readonly n: number; readonly d: number; readonly value: number }>;
}

export function ratio(n: number, d: number): Ratio {
  return { n, d, value: d === 0 ? null : n / d };
}

/**
 * PostgreSQL's `percentile_cont(p) WITHIN GROUP (ORDER BY x)`: the value at row `1 + p·(n − 1)` of the sorted list,
 * interpolated linearly between the two rows it falls between. Null for an empty list, as the aggregate is.
 */
export function percentileCont(values: ReadonlyArray<number>, p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = p * (sorted.length - 1);
  const below = Math.floor(position);
  const above = Math.ceil(position);
  const low = sorted[below] ?? 0;
  const high = sorted[above] ?? low;
  return low + (high - low) * (position - below);
}

function counted<K extends string>(keys: ReadonlyArray<K>): ReadonlyArray<readonly [K, number]> {
  const counts = new Map<K, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return [...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** An answer: an assistant row that is neither a refusal nor a failed turn (citation-rate.sql, edition-mismatch.sql). */
function isAnswer(row: StatRow): boolean {
  return row.refusalCause === null && row.modelId !== null;
}

export function statsOf(rows: ReadonlyArray<StatRow>): ReaderStats {
  const turns = rows.length;

  /* An answer with no claims to check (citation verdict NA: a walk, whose numbers are the script's) is outside the rate. */
  const cited = rows.filter((row) => isAnswer(row) && row.citationVerdict !== null && row.citationVerdict !== "NA");
  const fullyCited = cited.filter((row) => row.citationVerdict === "PASS" && row.substituted === 0);

  const refused = rows.filter((row) => row.refusalCause !== null);
  const firstTokens = rows.flatMap((row) => (row.firstTokenMs === null ? [] : [row.firstTokenMs]));
  const scores = rows.flatMap((row) => (row.grounded === null ? [] : [row.grounded]));
  const flagged = rows.filter((row) => row.flagReasons.length > 0);

  /* An answer that cites nothing has no edition to differ from and is outside the share. */
  const citing = rows.filter((row) => isAnswer(row) && row.citesEdition !== null);

  return {
    turns,
    citationRate: ratio(fullyCited.length, cited.length),
    refusalRate: ratio(refused.length, turns),
    refusalsByCause: counted(refused.map((row) => row.refusalCause ?? "")).map(([cause, n]) => ({ cause, n, value: n / turns })),
    firstTokenP95: { value: percentileCont(firstTokens, 0.95), samples: firstTokens.length },
    grounded: { p50: percentileCont(scores, 0.5), p10: percentileCont(scores, 0.1), samples: scores.length },
    flagRate: ratio(flagged.length, turns),
    /* A message is counted once per reason it carries, as the statement's `count(DISTINCT id)` per reason does. */
    flagsByReason: counted(flagged.flatMap((row) => [...new Set(row.flagReasons)])).map(([reason, n]) => ({ reason, n, value: n / turns })),
    editionMismatch: counted(citing.map((row) => row.locale)).map(([locale, d]) => {
      const n = citing.filter((row) => row.locale === locale && (row.citesEdition ?? "").toLowerCase() !== locale).length;
      return { locale, n, d, value: n / d };
    }),
  };
}

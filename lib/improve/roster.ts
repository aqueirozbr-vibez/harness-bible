import { PARTS, type Part } from "@/lib/schemas/improve";

/*
 * The curator roster panel (feature-specs/38 § 4; unit 55c): one row per part of the book, from the roster, the
 * release's chapters, the queue and the quarter's decisions. Pure: the reads are `lib/db/roster.ts`, and every number
 * the panel prints is computed here, so the component only formats. The panel is read by curators and organisation
 * admins on Book management (38 D2 as feature-specs/47 D1 amends it): curators appear by display name (29 § 6.3);
 * nothing else of a person.
 */

/** How far back the median looks: a quarter, as the screen's `q3 2026` stamp has it. */
export const QUARTER_DAYS = 91;

export interface RosterRow {
  readonly part: Part;
  /** The part's first and last chapter in the current release, the book's order. */
  readonly chapters: { readonly first: number; readonly last: number };
  /** Display names, in roster order (who came first, first). A deleted account's name is not among them. */
  readonly curators: ReadonlyArray<string>;
  /** How many suggestions wait in the part's queue now. */
  readonly queue: number;
  /** The median time from queue entry to decision over the quarter, in milliseconds; null where the quarter had no decision in the part. */
  readonly medianWaitMs: number | null;
}

export interface RosterPanel {
  /** The parts that have chapters in the current release, in the book's order. */
  readonly rows: ReadonlyArray<RosterRow>;
  /** The first instant the median counts from, ISO-8601. */
  readonly since: string;
}

export interface RosterInput {
  /** The current release's chapters and the part each belongs to. */
  readonly chapters: ReadonlyArray<{ readonly number: number; readonly part: Part }>;
  /** The roster's rows in force, in roster order. */
  readonly roster: ReadonlyArray<{ readonly part: Part; readonly userId: string }>;
  /** The rostered people by id: the name to print, and whether the account is gone or going. */
  readonly people: ReadonlyMap<string, { readonly displayName: string; readonly deleted: boolean }>;
  /** The queue's open count by part. */
  readonly queue: ReadonlyArray<{ readonly part: Part; readonly count: number }>;
  /** The quarter's decisions: how long each waited, and the parts of the suggestion it decided. */
  readonly decisions: ReadonlyArray<{ readonly parts: ReadonlyArray<Part>; readonly waitMs: number }>;
}

/** The middle value, or the mean of the two middle values; null of nothing. */
export function median(values: ReadonlyArray<number>): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] ?? null) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** The instant `QUARTER_DAYS` before `now`. */
export function quarterStart(now: Date): Date {
  return new Date(now.getTime() - QUARTER_DAYS * 86_400_000);
}

export function rosterPanelOf(input: RosterInput, now: Date): RosterPanel {
  const rows: RosterRow[] = [];
  for (const part of PARTS) {
    const numbers = input.chapters.filter((chapter) => chapter.part === part).map((chapter) => chapter.number);
    /* A part with no chapter in the release is not a row of the book's roster, whatever the roster table holds for it. */
    if (numbers.length === 0) continue;
    const curators: string[] = [];
    for (const entry of input.roster) {
      if (entry.part !== part) continue;
      const person = input.people.get(entry.userId);
      if (person === undefined || person.deleted || curators.includes(person.displayName)) continue;
      curators.push(person.displayName);
    }
    const waits = input.decisions.filter((decision) => decision.parts.includes(part)).map((decision) => decision.waitMs);
    rows.push({
      part,
      chapters: { first: Math.min(...numbers), last: Math.max(...numbers) },
      curators,
      queue: input.queue.find((entry) => entry.part === part)?.count ?? 0,
      medianWaitMs: median(waits),
    });
  }
  return { rows, since: quarterStart(now).toISOString() };
}

import { type PathDefinition, type PathKey, type StopDefinition, stopId, stopsOf } from "./definitions";

/*
 * Progress rules (feature-specs/05 § 4.3). Pure: the loaders and actions feed
 * these functions rows and the release's section lists; nothing here touches
 * the database or the clock.
 */

export const WORDS_PER_MINUTE = 230;

export type StopState = "unread" | "in_progress" | "read";

export interface ProgressRow {
  readonly path: PathKey;
  readonly pathVersion: string;
  readonly lastSectionId: string;
  readonly completedStops: ReadonlyArray<string>;
  readonly updatedAt: Date;
}

/** Section anchors of every chapter in the release, in ordinal order. */
export type ChapterSections = ReadonlyMap<number, ReadonlyArray<string>>;

export function minutesFor(words: number): number {
  return Math.max(1, Math.ceil(words / WORDS_PER_MINUTE));
}

/** The sections a stop covers: all of a chapter's, or the listed ones. */
export function sectionsOfStop(stop: StopDefinition, chapters: ChapterSections): ReadonlyArray<string> {
  return stop.kind === "chapter" ? (chapters.get(stop.chapter) ?? []) : stop.sections;
}

/** The stop of a definition that contains a section, or null. */
export function stopContaining(definition: PathDefinition, sectionId: string, chapters: ChapterSections): StopDefinition | null {
  return stopsOf(definition).find((stop) => sectionsOfStop(stop, chapters).includes(sectionId)) ?? null;
}

/** Marker for a sections stop read part way: `decision-aids-8/21.8`. */
function partialMarker(stop: StopDefinition, sectionId: string): string {
  return `${stopId(stop)}/${sectionId}`;
}

export function stopState(stop: StopDefinition, chapters: ChapterSections, row: ProgressRow | null): { readonly state: StopState; readonly at: string | null } {
  if (row === null) return { state: "unread", at: null };
  const id = stopId(stop);
  if (row.completedStops.includes(id)) return { state: "read", at: null };
  const sections = sectionsOfStop(stop, chapters);
  if (sections.includes(row.lastSectionId)) return { state: "in_progress", at: row.lastSectionId };
  if (row.completedStops.some((c) => c.startsWith(`${id}/`))) return { state: "in_progress", at: null };
  return { state: "unread", at: null };
}

/** Stops in state read, counting only ids the definition still has (D3). */
export function doneCount(definition: PathDefinition, row: ProgressRow | null): number {
  if (row === null) return 0;
  const ids = new Set(stopsOf(definition).map(stopId));
  return row.completedStops.filter((c) => ids.has(c)).length;
}

/**
 * The row to write after a section was read: the stop becomes read when the
 * section is a chapter stop's last section, or completes a sections stop.
 */
export function applyRead(
  definition: PathDefinition,
  row: ProgressRow,
  sectionId: string,
  chapters: ChapterSections,
): { readonly lastSectionId: string; readonly completedStops: ReadonlyArray<string>; readonly completed: number } {
  const stop = stopContaining(definition, sectionId, chapters);
  const completed = new Set(row.completedStops);
  if (stop !== null) {
    const id = stopId(stop);
    const sections = sectionsOfStop(stop, chapters);
    if (stop.kind === "chapter") {
      if (sections.length > 0 && sections[sections.length - 1] === sectionId) completed.add(id);
    } else {
      completed.add(partialMarker(stop, sectionId));
      if (sections.every((s) => completed.has(partialMarker(stop, s)))) completed.add(id);
    }
  }
  const next: ProgressRow = { ...row, lastSectionId: sectionId, completedStops: [...completed] };
  return { lastSectionId: sectionId, completedStops: next.completedStops, completed: doneCount(definition, next) };
}

/** The started path a section view records against: contains the section, most recently updated first. */
export function activeRow(
  definitions: ReadonlyArray<PathDefinition>,
  rows: ReadonlyArray<ProgressRow>,
  sectionId: string,
  chapters: ChapterSections,
): ProgressRow | null {
  const ordered = [...rows].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  for (const row of ordered) {
    const definition = definitions.find((d) => d.key === row.path);
    if (definition !== undefined && stopContaining(definition, sectionId, chapters) !== null) return row;
  }
  return null;
}

/** The most recently updated started path, for Continue reading and the status bar. */
export function latestRow(rows: ReadonlyArray<ProgressRow>): ProgressRow | null {
  return [...rows].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0] ?? null;
}

/** First section of a definition: where Start path lands. */
export function firstSection(definition: PathDefinition, chapters: ChapterSections): string | null {
  const first = stopsOf(definition)[0];
  return first === undefined ? null : (sectionsOfStop(first, chapters)[0] ?? null);
}

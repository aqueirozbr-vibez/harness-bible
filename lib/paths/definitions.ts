import { z } from "zod";

/*
 * The three reading paths (feature-specs/05 § 4.2, D1). The sequences are the
 * Book-Paths screen's; they belong to the book and move to bible/book/paths/
 * when the book carries them. Titles are message keys under `paths.*`.
 */

export const PATH_KEYS = ["executive", "builder", "foundations"] as const;
export type PathKey = (typeof PATH_KEYS)[number];
export const PathKeySchema = z.enum(PATH_KEYS);

export interface ChapterStopDefinition {
  readonly kind: "chapter";
  readonly chapter: number;
}

export interface SectionsStopDefinition {
  readonly kind: "sections";
  readonly id: string;
  /** Key under `paths.stops`. */
  readonly titleKey: string;
  readonly label: string;
  readonly sections: ReadonlyArray<string>;
}

export type StopDefinition = ChapterStopDefinition | SectionsStopDefinition;

export interface PathGroupDefinition {
  /** Key under `paths.groups`. */
  readonly titleKey: string;
  readonly stops: ReadonlyArray<StopDefinition>;
}

export interface PathDefinition {
  readonly key: PathKey;
  readonly version: string;
  readonly stopNoun: "stops" | "chapters";
  readonly groups: ReadonlyArray<PathGroupDefinition>;
}

const chapters = (...numbers: ReadonlyArray<number>): ReadonlyArray<StopDefinition> => numbers.map((chapter) => ({ kind: "chapter", chapter }));

export const PATH_DEFINITIONS: ReadonlyArray<PathDefinition> = [
  {
    key: "executive",
    version: "v1.1",
    stopNoun: "stops",
    groups: [
      { titleKey: "whyNow", stops: chapters(0) },
      { titleKey: "chooseAndPay", stops: chapters(34, 37, 38) },
      { titleKey: "comply", stops: chapters(36) },
      { titleKey: "planAndProve", stops: chapters(39, 40) },
      { titleKey: "decisionAids", stops: [{ kind: "sections", id: "decision-aids-8", titleKey: "decisionAids", label: "N.8", sections: ["21.8", "23.8", "28.8", "31.8"] }] },
    ],
  },
  {
    key: "builder",
    version: "v1.2",
    stopNoun: "chapters",
    groups: [
      { titleKey: "framingAndGuides", stops: chapters(16, 17, 18) },
      { titleKey: "contextAndKnowledge", stops: chapters(19, 20) },
      { titleKey: "execution", stops: chapters(21, 22, 23, 25) },
      { titleKey: "verificationAndControl", stops: chapters(26, 27, 28, 29, 31) },
    ],
  },
  {
    key: "foundations",
    version: "v1.0",
    stopNoun: "chapters",
    groups: [
      { titleKey: "textAsNumbers", stops: chapters(1, 2) },
      { titleKey: "architecture", stops: chapters(3, 4, 5, 6) },
      { titleKey: "training", stops: chapters(7, 8, 9) },
      { titleKey: "serving", stops: chapters(10, 11) },
      { titleKey: "measuringAndFailing", stops: chapters(12, 13, 14) },
      { titleKey: "cost", stops: chapters(15) },
    ],
  },
];

/** `ch34` for a chapter stop, the declared id for a sections stop. */
export function stopId(stop: StopDefinition): string {
  return stop.kind === "chapter" ? `ch${String(stop.chapter).padStart(2, "0")}` : stop.id;
}

export function definitionOf(key: PathKey): PathDefinition {
  const found = PATH_DEFINITIONS.find((d) => d.key === key);
  if (found === undefined) throw new Error(`no path definition for ${key}`);
  return found;
}

export function stopsOf(definition: PathDefinition): ReadonlyArray<StopDefinition> {
  return definition.groups.flatMap((g) => g.stops);
}

/** Every chapter a definition touches (chapter stops and the chapters of its section stops). */
export function chaptersOf(definition: PathDefinition): ReadonlyArray<number> {
  const set = new Set<number>();
  for (const stop of stopsOf(definition)) {
    if (stop.kind === "chapter") set.add(stop.chapter);
    else stop.sections.forEach((s) => set.add(Number(s.slice(0, 2))));
  }
  return [...set].sort((a, b) => a - b);
}

/* ── validation, for the definition test and the future book file ───────── */

const SectionRef = z.string().regex(/^\d{2}\.[1-9]$/);

export const PathDefinitionSchema = z.object({
  key: PathKeySchema,
  version: z.string().regex(/^v\d+\.\d+$/),
  stopNoun: z.enum(["stops", "chapters"]),
  groups: z
    .array(
      z.object({
        titleKey: z.string().min(1),
        stops: z
          .array(
            z.discriminatedUnion("kind", [
              z.object({ kind: z.literal("chapter"), chapter: z.number().int().min(0).max(40) }),
              z.object({ kind: z.literal("sections"), id: z.string().regex(/^[a-z0-9-]+$/), titleKey: z.string().min(1), label: z.string().min(1), sections: z.array(SectionRef).min(1) }),
            ]),
          )
          .min(1),
      }),
    )
    .min(1),
});

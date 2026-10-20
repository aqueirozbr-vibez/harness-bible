import { z } from "zod";

import { LangSchema, VerifyStatusSchema } from "@/lib/schemas/domain";
import { ChapterNumberSchema, ReleaseIdSchema, SectionIdSchema } from "@/lib/schemas/ids";

/*
 * Data contract for Book Home (feature-specs/02-book-home.md Â§ 4).
 * One loader returns one HomeData; the page renders nothing that is not in it.
 */

const ChapterRefSchema = z.object({ chapter: ChapterNumberSchema });

export const HomeReleaseSchema = z
  .object({
    id: ReleaseIdSchema,
    /** Full git sha; screens print the first 8 characters. */
    gitSha: z.string().regex(/^[0-9a-f]{8,40}$/),
    publishedAt: z.coerce.date(),
    /** Last lab-suite CI run for this release; null until the first run (spec Â§ 11 D1). */
    nightlyCheckAt: z.coerce.date().nullable(),
  })
  .readonly();

export const HomeStatusSchema = z
  .object({
    chapters: z.number().int().nonnegative(),
    verifyPassed: z.number().int().nonnegative(),
    labs: z.number().int().nonnegative(),
    labsReproduced: z.number().int().nonnegative(),
    labsDiverging: z.array(ChapterRefSchema.extend({ since: z.coerce.date() })).readonly(),
    /** Chapters whose fast-moving source rows are older than 90 days. */
    stale: z.array(ChapterRefSchema.extend({ days: z.number().int().min(91) })).readonly(),
    redteamOpen: z.array(ChapterRefSchema.extend({ count: z.number().int().positive() })).readonly(),
  })
  .readonly();

export const HomeLabStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reproduced") }),
  z.object({ kind: z.literal("not_reproduced"), since: z.coerce.date() }),
  z.object({ kind: z.literal("no_lab"), carries: z.enum(["prose", "instrument"]) }),
]);

export const HomeChapterTileSchema = z
  .object({
    number: ChapterNumberSchema,
    title: z.string().min(1),
    version: z.string().regex(/^v\d+\.\d+\.\d+$/),
    daysSinceVerify: z.number().int().nonnegative().nullable(),
    verify: VerifyStatusSchema,
    redteam: VerifyStatusSchema,
    redteamOpen: z.number().int().nonnegative(),
    lab: HomeLabStateSchema,
    staleDays: z.number().int().min(91).nullable(),
    current: z.object({ sectionId: SectionIdSchema }).readonly().nullable(),
    href: z.string().startsWith("/"),
  })
  .readonly();

export const HomeGlanceSchema = z
  .object({
    verifyPassed: z.number().int().nonnegative(),
    labsReproduced: z.number().int().nonnegative(),
    stale: z
      .array(ChapterRefSchema.extend({ days: z.number().int().min(91), what: z.string().min(1) }))
      .readonly(),
  })
  .readonly();

export const HomePartSchema = z
  .object({
    key: z.enum(["P0", "P1", "P2", "P3"]),
    chapters: z.array(HomeChapterTileSchema).min(1).readonly(),
    labCount: z.number().int().nonnegative(),
    /** Curator display names; empty until the roster exists (accounts domain). */
    curators: z.array(z.string().min(1)).readonly(),
    glance: HomeGlanceSchema.nullable(),
  })
  .readonly();

export const ContinueReadingSchema = z
  .object({
    sectionId: SectionIdSchema,
    sectionTitle: z.string().min(1),
    chapterTitle: z.string().min(1),
    chapterVersion: z.string().regex(/^v\d+\.\d+\.\d+$/),
    layer: z.number().int().min(1).max(9),
    lastReadAt: z.coerce.date(),
    path: z
      .object({
        key: z.enum(["executive", "builder", "foundations"]),
        done: z.number().int().nonnegative(),
        total: z.number().int().positive(),
      })
      .readonly()
      .nullable(),
    href: z.string().startsWith("/"),
  })
  .readonly();

export const HomeDataSchema = z
  .object({
    release: HomeReleaseSchema,
    status: HomeStatusSchema,
    parts: z.array(HomePartSchema).min(1).readonly(),
    continueReading: ContinueReadingSchema.nullable(),
    sourceLang: LangSchema,
  })
  .readonly();

export type HomeData = z.infer<typeof HomeDataSchema>;
export type HomeDataInput = z.input<typeof HomeDataSchema>;
export type HomePart = z.infer<typeof HomePartSchema>;
export type HomeChapterTile = z.infer<typeof HomeChapterTileSchema>;
export type HomeStatus = z.infer<typeof HomeStatusSchema>;
export type HomeRelease = z.infer<typeof HomeReleaseSchema>;
export type ContinueReading = z.infer<typeof ContinueReadingSchema>;

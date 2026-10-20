import { z } from "zod";

import { PathKeySchema } from "@/lib/paths/definitions";
import { LangSchema } from "@/lib/schemas/domain";
import { ReleaseIdSchema, SectionIdSchema } from "@/lib/schemas/ids";

/*
 * Data contract for the reading-paths page (feature-specs/05 § 4). Names,
 * group titles and audience texts are message keys resolved by the components;
 * the loader carries keys, not strings, so it needs no request context.
 */

const HrefSchema = z.string().startsWith("/");
const VerdictSchema = z.enum(["REPRODUCED", "NOT_REPRODUCED", "KILLED", "ERROR"]);

export const PathStopSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["chapter", "sections"]),
    label: z.string().min(1),
    /** Chapter title in the edition; null for a sections stop, which carries `titleKey`. */
    title: z.string().min(1).nullable(),
    titleKey: z.string().min(1).nullable(),
    href: HrefSchema,
    sections: z.array(SectionIdSchema).readonly(),
    minutes: z.number().int().positive(),
    state: z.enum(["unread", "in_progress", "read"]),
    at: SectionIdSchema.nullable(),
    stale: z.object({ days: z.number().int().min(91) }).readonly().nullable(),
    lab: z.object({ id: z.string().min(1), verdict: VerdictSchema }).readonly().nullable(),
  })
  .readonly();

export const PathViewSchema = z
  .object({
    key: PathKeySchema,
    version: z.string().regex(/^v\d+\.\d+$/),
    stopNoun: z.enum(["stops", "chapters"]),
    groups: z.array(z.object({ titleKey: z.string().min(1), stops: z.array(PathStopSchema).min(1).readonly() }).readonly()).min(1).readonly(),
    total: z.number().int().positive(),
    done: z.number().int().nonnegative(),
    minutes: z.number().int().positive(),
    minutesLeft: z.number().int().nonnegative(),
    resume: z.object({ sectionId: SectionIdSchema, href: HrefSchema }).readonly().nullable(),
    /** The definition moved on since the row was written (D3). */
    outdated: z.boolean(),
    startedAt: z.coerce.date().nullable(),
    updatedAt: z.coerce.date().nullable(),
  })
  .readonly();

export const PathsDataSchema = z
  .object({
    release: z.object({ id: ReleaseIdSchema, gitSha: z.string().regex(/^[0-9a-f]{8,40}$/) }).readonly(),
    paths: z.array(PathViewSchema).length(3).readonly(),
    marks: z
      .object({
        bookmarks: z.number().int().nonnegative(),
        notes: z.number().int().nonnegative(),
        latest: z.object({ sectionId: SectionIdSchema, text: z.string().min(1), at: z.coerce.date(), href: HrefSchema }).readonly().nullable(),
        syncedAt: z.coerce.date().nullable(),
      })
      .readonly()
      .nullable(),
    active: z.object({ key: PathKeySchema, done: z.number().int().nonnegative(), total: z.number().int().positive(), resume: SectionIdSchema }).readonly().nullable(),
    signedIn: z.boolean(),
    sourceLang: LangSchema,
  })
  .readonly();

export type PathsData = z.infer<typeof PathsDataSchema>;
export type PathsDataInput = z.input<typeof PathsDataSchema>;
export type PathView = z.infer<typeof PathViewSchema>;
export type PathStop = z.infer<typeof PathStopSchema>;

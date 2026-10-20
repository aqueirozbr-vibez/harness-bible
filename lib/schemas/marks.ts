import { z } from "zod";

import { NOTE_MAX } from "@/lib/marks/rules";
import { LangSchema } from "@/lib/schemas/domain";
import { ReleaseIdSchema, SectionIdSchema } from "@/lib/schemas/ids";

/*
 * Data contracts for bookmarks and notes (feature-specs/07-bookmarks-notes.md § 4).
 */

const HrefSchema = z.string().startsWith("/");

/** A note body as the actions accept it: trimmed, at most NOTE_MAX; empty means "delete". */
export const NoteBodySchema = z.string().trim().max(NOTE_MAX);

/** The reader's marks on one section; null on `ChapterData` when signed out. */
export const SectionMarksSchema = z
  .object({
    bookmarked: z.boolean(),
    note: z.object({ body: z.string().min(1), updatedAt: z.coerce.date() }).readonly().nullable(),
  })
  .readonly();

const MarkRowSchema = z.object({
  sectionId: SectionIdSchema,
  /** From the section id; a mark may outlive the chapter range of a release (07 D4). */
  chapterNumber: z.number().int().nonnegative(),
  href: HrefSchema,
  /** Null when the section is not in the current release (07 D4). */
  section: z.object({ title: z.string().min(1), chapterTitle: z.string().min(1), ordinal: z.number().int().min(1).max(9) }).readonly().nullable(),
});

export const BookmarkRowSchema = MarkRowSchema.extend({ createdAt: z.coerce.date() }).readonly();
export const NoteRowSchema = MarkRowSchema.extend({ body: z.string().min(1), updatedAt: z.coerce.date() }).readonly();

export const MarksDataSchema = z
  .object({
    release: z.object({ id: ReleaseIdSchema, gitSha: z.string().regex(/^[0-9a-f]{8,40}$/) }).readonly(),
    bookmarks: z.array(BookmarkRowSchema).readonly(),
    notes: z.array(NoteRowSchema).readonly(),
    syncedAt: z.coerce.date().nullable(),
    signedIn: z.boolean(),
    sourceLang: LangSchema,
  })
  .readonly();

export type SectionMarks = z.infer<typeof SectionMarksSchema>;
export type BookmarkRow = z.infer<typeof BookmarkRowSchema>;
export type NoteRow = z.infer<typeof NoteRowSchema>;
export type MarksData = z.infer<typeof MarksDataSchema>;
export type MarksDataInput = z.input<typeof MarksDataSchema>;

"use server";

import { z } from "zod";

import { getSession, type SessionUser } from "@/lib/auth/session";
import { deleteNoteFor, saveNoteFor, setBookmarkFor } from "@/lib/db/marks";
import { recordSectionReadFor } from "@/lib/db/reader-state";
import { AppError } from "@/lib/errors";
import { ownResource, subjectOf, type PolicyAction, type ResourceKind } from "@/lib/policy/input";
import { requireAllowed } from "@/lib/policy/opa";
import { SectionIdSchema } from "@/lib/schemas/ids";
import { NoteBodySchema } from "@/lib/schemas/marks";

/*
 * Progress recording from the reader (feature-specs/05 § 5.3, D7, D8) and the
 * marks actions (feature-specs/07 § 5.3). Called by client components; the
 * results are informational. Each asks the policy before it writes
 * (feature-specs/09 § 5.3). They revalidate nothing: the pages that show
 * progress and marks render per request, and a revalidation here would
 * refresh the open reader and record the view again.
 */

export type ActionResult<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

const RecordInputSchema = z.object({ sectionId: SectionIdSchema, locale: z.enum(["en", "pt"]) });
const ToggleInputSchema = z.object({ sectionId: SectionIdSchema, on: z.boolean() });
const SaveNoteInputSchema = z.object({ sectionId: SectionIdSchema, body: NoteBodySchema });
const SectionInputSchema = z.object({ sectionId: SectionIdSchema });

function failure(error: unknown, fallback: string): ActionResult<never> {
  if (error instanceof AppError) return { ok: false, error: { code: error.code, message: error.message } };
  return { ok: false, error: { code: "MARK_WRITE_FAILED", message: error instanceof Error ? error.message : fallback } };
}

function allowed(user: SessionUser, action: PolicyAction, kind: ResourceKind, id: string, name: string): Promise<void> {
  return requireAllowed(subjectOf(user), action, ownResource(kind, id, user), { method: "ACTION", path: name });
}

export async function recordSectionRead(input: { sectionId: string; locale: string }): Promise<ActionResult<{ recorded: boolean }>> {
  const parsed = RecordInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: { code: "INVALID_INPUT", message: "sectionId must look like 21.3" } };
  const user = await getSession();
  if (user === null) return { ok: false, error: { code: "NO_SESSION", message: "sign in to keep progress" } };
  try {
    await allowed(user, "write", "path-progress", parsed.data.sectionId, "recordSectionRead");
    const recorded = await recordSectionReadFor(user, parsed.data.sectionId);
    return { ok: true, data: { recorded } };
  } catch (error) {
    return { ok: false, error: { code: error instanceof AppError ? error.code : "PROGRESS_WRITE_FAILED", message: error instanceof Error ? error.message : "progress was not recorded" } };
  }
}

/** Set or clear the bookmark on a section (07 § 5.3). */
export async function toggleBookmark(input: { sectionId: string; on: boolean }): Promise<ActionResult<{ bookmarked: boolean }>> {
  const parsed = ToggleInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: { code: "INVALID_INPUT", message: "sectionId must look like 21.3" } };
  const user = await getSession();
  if (user === null) return { ok: false, error: { code: "NO_SESSION", message: "sign in to keep marks" } };
  try {
    await allowed(user, parsed.data.on ? "write" : "delete", "bookmark", parsed.data.sectionId, "toggleBookmark");
    const bookmarked = await setBookmarkFor(user, parsed.data.sectionId, parsed.data.on);
    return { ok: true, data: { bookmarked } };
  } catch (error) {
    return failure(error, "the bookmark was not saved");
  }
}

/** Save the note on a section; an empty body deletes it (07 § 5.3). */
export async function saveNote(input: { sectionId: string; body: string }): Promise<ActionResult<{ note: { body: string; updatedAt: Date } | null }>> {
  const parsed = SaveNoteInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: { code: "INVALID_INPUT", message: "a note is at most 2000 characters on a section id like 21.3" } };
  const user = await getSession();
  if (user === null) return { ok: false, error: { code: "NO_SESSION", message: "sign in to keep marks" } };
  try {
    await allowed(user, "write", "note", parsed.data.sectionId, "saveNote");
    const note = await saveNoteFor(user, parsed.data.sectionId, parsed.data.body);
    return { ok: true, data: { note } };
  } catch (error) {
    return failure(error, "the note was not saved");
  }
}

/** Delete the note on a section (07 § 5.3). */
export async function deleteNote(input: { sectionId: string }): Promise<ActionResult<{ deleted: boolean }>> {
  const parsed = SectionInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: { code: "INVALID_INPUT", message: "sectionId must look like 21.3" } };
  const user = await getSession();
  if (user === null) return { ok: false, error: { code: "NO_SESSION", message: "sign in to keep marks" } };
  try {
    await allowed(user, "delete", "note", parsed.data.sectionId, "deleteNote");
    const deleted = await deleteNoteFor(user, parsed.data.sectionId);
    return { ok: true, data: { deleted } };
  } catch (error) {
    return failure(error, "the note was not deleted");
  }
}

export type ToggleBookmarkAction = typeof toggleBookmark;
export type SaveNoteAction = typeof saveNote;
export type DeleteNoteAction = typeof deleteNote;

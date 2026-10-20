"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { getSession } from "@/lib/auth/session";
import { deleteNoteFor, setBookmarkFor } from "@/lib/db/marks";
import { LocaleSchema } from "@/lib/i18n/routing";
import { ownResource, subjectOf } from "@/lib/policy/input";
import { requireAllowed } from "@/lib/policy/opa";
import { SectionIdSchema } from "@/lib/schemas/ids";

/*
 * Form actions of the marks page (feature-specs/07 § 5.3): input validated
 * first, then the session, then the policy (09 § 5.3), then the write inside
 * the tenant context; the page renders per request, so nothing is
 * revalidated; the URL carries the outcome.
 */

const MarkFormSchema = z.object({ sectionId: SectionIdSchema, locale: LocaleSchema });

function parseForm(formData: FormData): z.infer<typeof MarkFormSchema> | null {
  const parsed = MarkFormSchema.safeParse({ sectionId: formData.get("sectionId"), locale: formData.get("locale") });
  return parsed.success ? parsed.data : null;
}

/** Remove a bookmark from the list. */
export async function removeBookmark(formData: FormData): Promise<void> {
  const input = parseForm(formData);
  if (input === null) return;
  const user = await getSession();
  if (user === null) redirect(`/${input.locale}/marks?error=session`);
  try {
    await requireAllowed(subjectOf(user), "delete", ownResource("bookmark", input.sectionId, user), { method: "ACTION", path: "removeBookmark" });
    await setBookmarkFor(user, input.sectionId, false);
  } catch {
    redirect(`/${input.locale}/marks?error=remove#bookmarks`);
  }
  redirect(`/${input.locale}/marks?removed=${input.sectionId}#bookmarks`);
}

/** Delete a note from the list. */
export async function deleteNoteFromList(formData: FormData): Promise<void> {
  const input = parseForm(formData);
  if (input === null) return;
  const user = await getSession();
  if (user === null) redirect(`/${input.locale}/marks?error=session`);
  try {
    await requireAllowed(subjectOf(user), "delete", ownResource("note", input.sectionId, user), { method: "ACTION", path: "deleteNoteFromList" });
    await deleteNoteFor(user, input.sectionId);
  } catch {
    redirect(`/${input.locale}/marks?error=delete#notes`);
  }
  redirect(`/${input.locale}/marks?deleted=${input.sectionId}#notes`);
}

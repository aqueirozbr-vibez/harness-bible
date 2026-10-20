"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { getSession } from "@/lib/auth/session";
import { resetPathFor, startPathFor } from "@/lib/db/reader-state";
import { LocaleSchema } from "@/lib/i18n/routing";
import { PathKeySchema } from "@/lib/paths/definitions";
import { ownResource, subjectOf } from "@/lib/policy/input";
import { requireAllowed } from "@/lib/policy/opa";

/*
 * Server actions of the paths page (feature-specs/05 § 5.3). Forms post them;
 * input is validated first, the session second, the policy third
 * (feature-specs/09 § 5.3); ownership holds by construction (rows are read and
 * written inside the session's tenant context).
 */

const PathFormSchema = z.object({ path: PathKeySchema, locale: LocaleSchema });

function parseForm(formData: FormData): z.infer<typeof PathFormSchema> | null {
  const parsed = PathFormSchema.safeParse({ path: formData.get("path"), locale: formData.get("locale") });
  return parsed.success ? parsed.data : null;
}

/** Upsert the path's row at its first section and go there. */
export async function startPath(formData: FormData): Promise<void> {
  const input = parseForm(formData);
  if (input === null) return;
  const user = await getSession();
  if (user === null) redirect(`/${input.locale}/paths?error=session`);
  let first: string;
  try {
    await requireAllowed(subjectOf(user), "write", ownResource("path-progress", input.path, user), { method: "ACTION", path: "startPath" });
    first = await startPathFor(user, input.path);
  } catch {
    redirect(`/${input.locale}/paths?error=start`);
  }
  revalidatePath(`/${input.locale}/paths`);
  revalidatePath(`/${input.locale}`);
  redirect(`/${input.locale}/ch/${first.slice(0, 2)}/${first}`);
}

/** Delete the path's row; bookmarks and notes are untouched. */
export async function resetPath(formData: FormData): Promise<void> {
  const input = parseForm(formData);
  if (input === null) return;
  const user = await getSession();
  if (user === null) redirect(`/${input.locale}/paths?error=session`);
  try {
    await requireAllowed(subjectOf(user), "delete", ownResource("path-progress", input.path, user), { method: "ACTION", path: "resetPath" });
    await resetPathFor(user, input.path);
  } catch {
    redirect(`/${input.locale}/paths?error=reset`);
  }
  revalidatePath(`/${input.locale}/paths`);
  revalidatePath(`/${input.locale}`);
  redirect(`/${input.locale}/paths`);
}

import { ApiError } from "@/lib/api/errors";
import type { Spec } from "@/lib/api/handler";
import type { SessionUser } from "@/lib/auth/session";
import { deleteNoteFor, saveNoteFor, setBookmarkFor } from "@/lib/db/marks";
import { getPathsData, recordSectionReadFor, startPathFor } from "@/lib/db/reader-state";
import { ownResource } from "@/lib/policy/input";
import { BookmarkResultSchema, LangQuerySchema, NoteBodyRequestSchema, NoteDeleteResultSchema, NoteResultSchema, PathParamsSchema, ProgressBodySchema, SectionIdParamsSchema } from "@/lib/schemas/api";
import { PathsDataSchema, PathViewSchema } from "@/lib/schemas/paths";

/*
 * Reader-state endpoints (architecture § 3.4; feature-specs/05 § 5.3, 07 § 5.2,
 * 09 § 6.2): the same functions the server actions call, behind the pipeline.
 * Every PUT is idempotent by construction.
 */

const USER_RATE = { key: "user", limit: 60, windowS: 60 } as const;

function requireUser(session: SessionUser | null): SessionUser {
  if (session === null) throw new ApiError("NO_SESSION", "sign in to use this endpoint");
  return session;
}

export const pathsList: Spec<undefined, typeof LangQuerySchema, undefined, typeof PathsDataSchema> = {
  path: "/api/v1/paths",
  method: "GET",
  summary: "The three reading paths with the caller's progress",
  auth: "session",
  query: LangQuerySchema,
  response: PathsDataSchema,
  rateLimit: USER_RATE,
  policy: { action: "list", resource: ({ session }) => ownResource("path-progress", null, requireUser(session)) },
  run: ({ query, session }) => getPathsData(query.lang, session),
};

export const pathProgress: Spec<typeof PathParamsSchema, typeof LangQuerySchema, typeof ProgressBodySchema, typeof PathViewSchema> = {
  path: "/api/v1/paths/{path}/progress",
  method: "PUT",
  summary: "Record a section read on a path, starting the path when needed",
  auth: "session",
  params: PathParamsSchema,
  query: LangQuerySchema,
  body: ProgressBodySchema,
  response: PathViewSchema,
  rateLimit: USER_RATE,
  policy: { action: "write", resource: ({ params, session }) => ownResource("path-progress", params.path, requireUser(session)) },
  run: async ({ params, query, body, session }) => {
    const user = requireUser(session);
    const before = await getPathsData(query.lang, user);
    if (before.paths.find((p) => p.key === params.path)?.startedAt === null) await startPathFor(user, params.path);
    await recordSectionReadFor(user, body.sectionId);
    const after = await getPathsData(query.lang, user);
    const view = after.paths.find((p) => p.key === params.path);
    if (view === undefined) throw new ApiError("NOT_FOUND", `path ${params.path} is unknown`);
    return view;
  },
};

export const bookmarkPut: Spec<typeof SectionIdParamsSchema, undefined, undefined, typeof BookmarkResultSchema> = {
  path: "/api/v1/bookmarks/{sectionId}",
  method: "PUT",
  summary: "Bookmark a section (idempotent)",
  auth: "session",
  params: SectionIdParamsSchema,
  response: BookmarkResultSchema,
  rateLimit: USER_RATE,
  policy: { action: "write", resource: ({ params, session }) => ownResource("bookmark", params.sectionId, requireUser(session)) },
  run: async ({ params, session }) => ({ sectionId: params.sectionId, bookmarked: await setBookmarkFor(requireUser(session), params.sectionId, true) }),
};

export const bookmarkDelete: Spec<typeof SectionIdParamsSchema, undefined, undefined, typeof BookmarkResultSchema> = {
  ...bookmarkPut,
  method: "DELETE",
  summary: "Remove a bookmark (idempotent)",
  policy: { action: "delete", resource: ({ params, session }) => ownResource("bookmark", params.sectionId, requireUser(session)) },
  run: async ({ params, session }) => ({ sectionId: params.sectionId, bookmarked: await setBookmarkFor(requireUser(session), params.sectionId, false) }),
};

export const notePut: Spec<typeof SectionIdParamsSchema, undefined, typeof NoteBodyRequestSchema, typeof NoteResultSchema> = {
  path: "/api/v1/notes/{sectionId}",
  method: "PUT",
  summary: "Save the note on a section (idempotent; an empty body deletes)",
  auth: "session",
  params: SectionIdParamsSchema,
  body: NoteBodyRequestSchema,
  response: NoteResultSchema,
  rateLimit: USER_RATE,
  policy: { action: "write", resource: ({ params, session }) => ownResource("note", params.sectionId, requireUser(session)) },
  run: async ({ params, body, session }) => {
    const note = await saveNoteFor(requireUser(session), params.sectionId, body.body);
    return { sectionId: params.sectionId, note: note === null ? null : { body: note.body, updatedAt: note.updatedAt.toISOString() } };
  },
};

export const noteDelete: Spec<typeof SectionIdParamsSchema, undefined, undefined, typeof NoteDeleteResultSchema> = {
  path: "/api/v1/notes/{sectionId}",
  method: "DELETE",
  summary: "Delete the note on a section",
  auth: "session",
  params: SectionIdParamsSchema,
  response: NoteDeleteResultSchema,
  rateLimit: USER_RATE,
  policy: { action: "delete", resource: ({ params, session }) => ownResource("note", params.sectionId, requireUser(session)) },
  run: async ({ params, session }) => ({ sectionId: params.sectionId, deleted: await deleteNoteFor(requireUser(session), params.sectionId) }),
};

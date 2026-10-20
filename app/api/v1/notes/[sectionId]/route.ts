import { noteDelete, notePut } from "@/lib/api/endpoints/reader";
import { handler } from "@/lib/api/handler";

/* Built by the one pipeline (feature-specs/09 § 7); the specs live in lib/api/endpoints. */
export const PUT = handler(notePut);
export const DELETE = handler(noteDelete);

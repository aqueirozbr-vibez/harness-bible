import { bookmarkDelete, bookmarkPut } from "@/lib/api/endpoints/reader";
import { handler } from "@/lib/api/handler";

/* Built by the one pipeline (feature-specs/09 § 7); the specs live in lib/api/endpoints. */
export const PUT = handler(bookmarkPut);
export const DELETE = handler(bookmarkDelete);

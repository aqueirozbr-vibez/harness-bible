import { suggestionDelete, suggestionPatch, suggestionRead } from "@/lib/api/endpoints/suggestions";
import { handler } from "@/lib/api/handler";

/* Built by the one pipeline (feature-specs/09 § 7); the specs live in lib/api/endpoints. */
export const GET = handler(suggestionRead);
export const PATCH = handler(suggestionPatch);
export const DELETE = handler(suggestionDelete);

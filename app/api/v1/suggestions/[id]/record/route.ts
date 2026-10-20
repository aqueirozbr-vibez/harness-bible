import { suggestionRecord } from "@/lib/api/endpoints/record";
import { handler } from "@/lib/api/handler";

/* Built by the one pipeline (feature-specs/09 § 7); the specs live in lib/api/endpoints. */
export const GET = handler(suggestionRecord);

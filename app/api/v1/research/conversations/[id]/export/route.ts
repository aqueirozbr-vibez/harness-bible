import { researchConversationExport } from "@/lib/api/endpoints/research";
import { handler } from "@/lib/api/handler";

/* Built by the one pipeline (feature-specs/09 § 7); the spec lives in lib/api/endpoints. A download is a GET with headers. */
export const GET = handler(researchConversationExport);

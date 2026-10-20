import { curationDecision } from "@/lib/api/endpoints/curation";
import { handler } from "@/lib/api/handler";

/* Built by the one pipeline (feature-specs/09 § 7); the specs live in lib/api/endpoints. */
export const POST = handler(curationDecision);

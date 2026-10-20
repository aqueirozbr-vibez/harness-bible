import { objectGet, objectPut } from "@/lib/api/endpoints/storage";
import { handler } from "@/lib/api/handler";

/* Built by the one pipeline (feature-specs/09 § 7); the spec lives in lib/api/endpoints. The token is the credential: no session is read. */
export const PUT = handler(objectPut);
export const GET = handler(objectGet);

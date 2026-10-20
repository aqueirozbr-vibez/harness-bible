import { authLogout } from "@/lib/api/endpoints/auth";
import { handler } from "@/lib/api/handler";

/* Built by the one pipeline (feature-specs/09 § 7); the spec lives in lib/api/endpoints. */
export const POST = handler(authLogout);

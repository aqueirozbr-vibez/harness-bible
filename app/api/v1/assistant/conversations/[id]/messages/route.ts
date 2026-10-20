import { messagePost } from "@/lib/api/endpoints/assistant";
import { handler } from "@/lib/api/handler";

/*
 * Built by the one pipeline (feature-specs/09 § 7); the spec lives in lib/api/endpoints. The body is the stream of
 * spec 15 § 6, which the pipeline passes through with its own headers, so the route is the same two lines as every
 * other. `dynamic` is declared because a stream must never be collected into a cached response.
 */
export const dynamic = "force-dynamic";

export const POST = handler(messagePost);

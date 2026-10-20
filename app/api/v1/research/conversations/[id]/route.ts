import { researchConversationDelete, researchConversationRead } from "@/lib/api/endpoints/research";
import { handler } from "@/lib/api/handler";

export const GET = handler(researchConversationRead);
export const DELETE = handler(researchConversationDelete);

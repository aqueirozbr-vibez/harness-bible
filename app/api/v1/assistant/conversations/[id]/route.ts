import { conversationDelete, conversationRead } from "@/lib/api/endpoints/assistant";
import { handler } from "@/lib/api/handler";

export const GET = handler(conversationRead);
export const DELETE = handler(conversationDelete);

import { proposalEndorse, proposalWithdraw } from "@/lib/api/endpoints/proposals";
import { handler } from "@/lib/api/handler";

export const POST = handler(proposalEndorse);
export const DELETE = handler(proposalWithdraw);

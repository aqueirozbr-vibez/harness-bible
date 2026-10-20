import { head } from "@/lib/db/ledger";
import { currentRelease } from "@/lib/db/shared";
import { ReleaseIdSchema } from "@/lib/schemas/ids";

import type { ProvingActivities } from "../workflows/activities";

/*
 * ProvingWorkflow's activities (feature-specs/28 § 4.5): two reads of the product's own rows, one of a content
 * table and one of the ledger, which are the two kinds of row every later workflow reads. Reads are idempotent by
 * nature; the engine may run either again.
 */
export const provingActivities: ProvingActivities = {
  async currentReleaseId() {
    return ReleaseIdSchema.parse((await currentRelease()).id);
  },
  async ledgerHeadSeq() {
    return (await head())?.seq ?? 0;
  },
};

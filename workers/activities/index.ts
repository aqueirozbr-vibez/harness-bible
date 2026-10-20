import { evidenceActivitiesDefault } from "./evidence";
import { exportActivitiesDefault } from "./export";
import { mergeActivitiesDefault } from "./merge";
import { researchActivitiesDefault } from "./research";
import { researchRunActivitiesDefault } from "./researchRun";
import { sendFindingActivitiesDefault } from "./sendFinding";
import { provingActivities } from "./proving";
import { suggestionActivitiesDefault } from "./suggestion";

/*
 * Every activity the workers offer the engine (feature-specs/28 § 4.1): everything that touches the database, the
 * gateway, the network or the clock. Each workflow's activities are one object with the interface
 * workers/workflows/activities.ts declares for it; this is their union, registered on both task queues.
 */
export const activities = { ...provingActivities, ...suggestionActivitiesDefault, ...evidenceActivitiesDefault, ...mergeActivitiesDefault, ...exportActivitiesDefault, ...researchActivitiesDefault, ...researchRunActivitiesDefault, ...sendFindingActivitiesDefault };

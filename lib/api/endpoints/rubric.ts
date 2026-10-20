import { z } from "zod";

import { ApiError } from "@/lib/api/errors";
import type { Spec } from "@/lib/api/handler";
import { currentRubricVersion, readRubricVersion, type RubricVersionRow } from "@/lib/db/improve";
import { hasRubric, loadRubric, type LoadedRubric } from "@/lib/rubrics/load";
import type { PolicyResource } from "@/lib/policy/input";
import { RubricSchema, RubricVersionSchema } from "@/lib/schemas/rubric";

/*
 * The rubric's two public endpoints (feature-specs/30 § 5.2): the version in force, and a version by name. Public,
 * rate limited as the other public reads are, the body the published file. A contributor is entitled to compute
 * their own score before they submit (§ 1), and the Rubric page's download is the second of these.
 *
 * What is published is a row (lib/db/improve.ts) with the file's hash; the body is the file, loaded and checked
 * against its manifest. A row whose file is missing or has changed is a deployment's fault and is said so, not
 * served.
 */

const PUBLIC_RATE = { key: "ip", limit: 120, windowS: 60 } as const;
const rubricResource = (id: string | null): PolicyResource => ({ kind: "content", id: id === null ? "rubric" : `rubric/${id}` });

export const RubricParamsSchema = z.object({ version: RubricVersionSchema });

export interface RubricEndpointDeps {
  readonly current: (at: Date) => Promise<RubricVersionRow | null>;
  readonly read: (id: string) => Promise<RubricVersionRow | null>;
  readonly has: (version: string) => boolean;
  readonly load: (version: string) => LoadedRubric;
}

const DEPS: RubricEndpointDeps = { current: (at) => currentRubricVersion(at), read: (id) => readRubricVersion(id), has: (version) => hasRubric(version), load: (version) => loadRubric(version) };

/** The file of a published row, checked against the row's hash: what is served is what was published. */
function fileOf(row: RubricVersionRow, deps: RubricEndpointDeps): LoadedRubric["rubric"] {
  if (!deps.has(row.id)) throw new ApiError("INTERNAL", `rubric ${row.id} is published and its file is not here`);
  const loaded = deps.load(row.id);
  if (loaded.sha256 !== row.sha256) throw new ApiError("INTERNAL", `rubric ${row.id} is published with sha256 ${row.sha256.slice(0, 12)}… and the file here is ${loaded.sha256.slice(0, 12)}…`);
  return loaded.rubric;
}

export function rubricEndpoints(deps: RubricEndpointDeps = DEPS): {
  readonly rubricCurrent: Spec<undefined, undefined, undefined, typeof RubricSchema>;
  readonly rubricByVersion: Spec<typeof RubricParamsSchema, undefined, undefined, typeof RubricSchema>;
} {
  return {
    rubricCurrent: {
      path: "/api/v1/rubric/current",
      method: "GET",
      summary: "The rubric in force: tiers, adjustments, thresholds, the chips' tiers, the worked examples and the changelog",
      auth: "public",
      response: RubricSchema,
      rateLimit: PUBLIC_RATE,
      policy: { action: "read", resource: () => rubricResource(null) },
      cache: "public",
      run: async () => {
        const row = await deps.current(new Date());
        if (row === null) throw new ApiError("NOT_FOUND", "no rubric is published");
        return fileOf(row, deps);
      },
    },
    rubricByVersion: {
      path: "/api/v1/rubric/{version}",
      method: "GET",
      summary: "A published rubric by its version",
      auth: "public",
      params: RubricParamsSchema,
      response: RubricSchema,
      rateLimit: PUBLIC_RATE,
      policy: { action: "read", resource: ({ params }) => rubricResource(params.version) },
      cache: "public",
      run: async ({ params }) => {
        const row = await deps.read(params.version);
        if (row === null) throw new ApiError("NOT_FOUND", `rubric ${params.version} is not published`);
        return fileOf(row, deps);
      },
    },
  };
}

export const { rubricCurrent, rubricByVersion } = rubricEndpoints();

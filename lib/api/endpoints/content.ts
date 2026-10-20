import { ApiError } from "@/lib/api/errors";
import type { Spec } from "@/lib/api/handler";
import { getChapterData, getCurrentRelease, getHomeData } from "@/lib/db/content";
import { getFigureDerive } from "@/lib/db/figures";
import { getSearchData } from "@/lib/db/search";
import type { PolicyResource } from "@/lib/policy/input";
import { ChapterParamsSchema, ChaptersListSchema, FigureDeriveSchema, FigureParamsSchema, LangQuerySchema, ReleaseCurrentSchema, SearchQuerySchema, SectionParamsSchema } from "@/lib/schemas/api";
import { ChapterDataSchema } from "@/lib/schemas/chapter";
import { SearchDataSchema } from "@/lib/schemas/search";
import { parseSearchParams } from "@/lib/search/filters";

/*
 * The public content endpoints (architecture § 3.4; feature-specs/09 § 6.2):
 * the same loaders the pages use, behind the pipeline.
 */

const PUBLIC_RATE = { key: "ip", limit: 120, windowS: 60 } as const;
const content = (id: string | null): PolicyResource => ({ kind: "content", id });
const CONTENT = { action: "read", resource: () => content(null) } as const;

export const releasesCurrent: Spec<undefined, undefined, undefined, typeof ReleaseCurrentSchema> = {
  path: "/api/v1/releases/current",
  method: "GET",
  summary: "The pinned release",
  auth: "public",
  response: ReleaseCurrentSchema,
  rateLimit: PUBLIC_RATE,
  policy: CONTENT,
  cache: "public",
  run: async () => {
    const release = await getCurrentRelease();
    const home = await getHomeData("en", null);
    return { id: release.id, gitSha: release.gitSha, publishedAt: release.publishedAt, chapters: home.status.chapters, labs: home.status.labs };
  },
};

export const chaptersList: Spec<undefined, typeof LangQuerySchema, undefined, typeof ChaptersListSchema> = {
  path: "/api/v1/chapters",
  method: "GET",
  summary: "Every chapter of the pinned release with its verification state",
  auth: "public",
  query: LangQuerySchema,
  response: ChaptersListSchema,
  rateLimit: PUBLIC_RATE,
  policy: CONTENT,
  cache: "public",
  run: async ({ query }) => {
    const started = performance.now();
    const home = await getHomeData(query.lang, null);
    const items = home.parts.flatMap((p) => [...p.chapters]);
    return { items, count: items.length, ms: Math.round(performance.now() - started) };
  },
};

export const chapterByNumber: Spec<typeof ChapterParamsSchema, typeof LangQuerySchema, undefined, typeof ChapterDataSchema> = {
  path: "/api/v1/chapters/{n}",
  method: "GET",
  summary: "A chapter: header, outline and its first section",
  auth: "public",
  params: ChapterParamsSchema,
  query: LangQuerySchema,
  response: ChapterDataSchema,
  rateLimit: PUBLIC_RATE,
  policy: { action: "read", resource: ({ params }) => content(`ch${params.n}`) },
  cache: "public",
  run: async ({ params, query }) => {
    const data = await getChapterData(query.lang, Number(params.n), `${params.n}.1`, null);
    if (data === null) throw new ApiError("NOT_FOUND", `chapter ${params.n} is not in the pinned release`);
    return data;
  },
};

export const sectionById: Spec<typeof SectionParamsSchema, typeof LangQuerySchema, undefined, typeof ChapterDataSchema> = {
  path: "/api/v1/sections/{id}",
  method: "GET",
  summary: "A section with its figures, source rows and code panes",
  auth: "public",
  params: SectionParamsSchema,
  query: LangQuerySchema,
  response: ChapterDataSchema,
  rateLimit: PUBLIC_RATE,
  policy: { action: "read", resource: ({ params }) => content(params.id) },
  cache: "public",
  run: async ({ params, query }) => {
    const data = await getChapterData(query.lang, Number(params.id.slice(0, 2)), params.id, null);
    if (data === null) throw new ApiError("NOT_FOUND", `section ${params.id} is not in the pinned release`);
    return data;
  },
};

export const figureDerive: Spec<typeof FigureParamsSchema, undefined, undefined, typeof FigureDeriveSchema> = {
  path: "/api/v1/figures/{id}/derive",
  method: "GET",
  summary: "The derive.py line behind a derived figure",
  auth: "public",
  params: FigureParamsSchema,
  response: FigureDeriveSchema,
  rateLimit: PUBLIC_RATE,
  policy: { action: "read", resource: ({ params }) => content(params.id) },
  cache: "public",
  run: async ({ params }) => {
    const figure = await getFigureDerive(params.id);
    if (figure === null) throw new ApiError("NOT_FOUND", `figure ${params.id} is not in the pinned release`);
    if (figure.derive === null) throw new ApiError("NOT_DERIVED", `figure ${params.id} is ${figure.tier.toLowerCase()}, not derived`);
    return { ...figure, derive: figure.derive };
  },
};

export const search: Spec<undefined, typeof SearchQuerySchema, undefined, typeof SearchDataSchema> = {
  path: "/api/v1/search",
  method: "GET",
  summary: "Search sections, lab READMEs and registry rows",
  auth: "public",
  query: SearchQuerySchema,
  response: SearchDataSchema,
  rateLimit: PUBLIC_RATE,
  policy: { action: "read", resource: () => ({ kind: "search", id: null }) },
  cache: "public",
  run: async ({ query, session }) => {
    const started = performance.now();
    const { lang, ...rest } = query;
    const filters = parseSearchParams(rest as Record<string, string | ReadonlyArray<string>>);
    return getSearchData(lang, filters, session, performance.now() - started);
  },
};

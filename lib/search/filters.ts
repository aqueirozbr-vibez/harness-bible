import { z } from "zod";

import { SourceTierSchema, type SourceTier } from "@/lib/schemas/domain";

/*
 * Search filters ↔ the URL (feature-specs/06 § 5.1). Pure. Unknown values are
 * dropped, never rejected: the URL is typed by hand. Defaults are omitted from
 * generated URLs so a search stays a short link.
 */

export const HIT_KINDS = ["section", "lab", "row"] as const;
export const SORT_KEYS = ["relevance", "book", "verified"] as const;
export const AGE_KEYS = ["d30", "d90", "stale"] as const;
export const PART_KEYS = ["P0", "P1", "P2", "P3"] as const;
export const LAYER_KEYS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

export type HitKind = (typeof HIT_KINDS)[number];
export type SortKey = (typeof SORT_KEYS)[number];
export type AgeKey = (typeof AGE_KEYS)[number];
export type PartKey = (typeof PART_KEYS)[number];
export type LayerKey = (typeof LAYER_KEYS)[number];

export const DEFAULT_N = 8;
export const MORE_N = 15;
export const MAX_N = 200;
export const MAX_QUERY_LENGTH = 200;

export interface SearchFilters {
  readonly q: string;
  readonly part: ReadonlyArray<PartKey>;
  readonly layer: ReadonlyArray<LayerKey>;
  readonly tier: ReadonlyArray<SourceTier>;
  readonly age: ReadonlyArray<AgeKey>;
  readonly type: ReadonlyArray<HitKind>;
  readonly sort: SortKey;
  readonly n: number;
}

export const SearchFiltersSchema = z.object({
  q: z.string().max(MAX_QUERY_LENGTH),
  part: z.array(z.enum(PART_KEYS)).readonly(),
  layer: z.array(z.union(LAYER_KEYS.map((l) => z.literal(l)) as [z.ZodLiteral<1>, z.ZodLiteral<2>, ...z.ZodLiteral<LayerKey>[]])).readonly(),
  tier: z.array(SourceTierSchema).readonly(),
  age: z.array(z.enum(AGE_KEYS)).readonly(),
  type: z.array(z.enum(HIT_KINDS)).readonly(),
  sort: z.enum(SORT_KEYS),
  n: z.number().int().min(1).max(MAX_N),
});

export type SearchParamsInput = URLSearchParams | Record<string, string | ReadonlyArray<string> | undefined>;

function valuesOf(input: SearchParamsInput, key: string): ReadonlyArray<string> {
  if (input instanceof URLSearchParams) return input.getAll(key);
  const raw = input[key];
  if (raw === undefined) return [];
  return typeof raw === "string" ? [raw] : raw;
}

function pick<T extends string | number>(values: ReadonlyArray<string>, allowed: ReadonlyArray<T>, map: (v: string) => string | number = (v) => v): ReadonlyArray<T> {
  const out: T[] = [];
  for (const v of values) {
    const mapped = map(v) as T;
    if (allowed.includes(mapped) && !out.includes(mapped)) out.push(mapped);
  }
  return out;
}

/** Filters from the URL; every value validated, unknown values dropped, `q` trimmed and cut. */
export function parseSearchParams(input: SearchParamsInput): SearchFilters {
  const q = (valuesOf(input, "q")[0] ?? "").trim().slice(0, MAX_QUERY_LENGTH);
  const sortRaw = valuesOf(input, "sort")[0];
  const nRaw = Number(valuesOf(input, "n")[0]);
  const n = Number.isInteger(nRaw) ? Math.min(MAX_N, Math.max(1, nRaw)) : DEFAULT_N;
  return SearchFiltersSchema.parse({
    q,
    part: pick(valuesOf(input, "part"), PART_KEYS),
    layer: pick(valuesOf(input, "layer"), LAYER_KEYS, (v) => Number(v)),
    tier: pick(valuesOf(input, "tier"), SourceTierSchema.options),
    age: pick(valuesOf(input, "age"), AGE_KEYS),
    type: pick(valuesOf(input, "type"), HIT_KINDS),
    sort: SORT_KEYS.includes(sortRaw as SortKey) ? (sortRaw as SortKey) : "relevance",
    n,
  });
}

/** The URL parameters of a filter set, defaults omitted. */
export function toSearchParams(filters: SearchFilters, overrides: Partial<SearchFilters> = {}): URLSearchParams {
  const f: SearchFilters = { ...filters, ...overrides };
  const params = new URLSearchParams();
  if (f.q.length > 0) params.set("q", f.q);
  for (const v of f.part) params.append("part", v);
  for (const v of f.layer) params.append("layer", String(v));
  for (const v of f.tier) params.append("tier", v);
  for (const v of f.age) params.append("age", v);
  for (const v of f.type) params.append("type", v);
  if (f.sort !== "relevance") params.set("sort", f.sort);
  if (f.n !== DEFAULT_N) params.set("n", String(f.n));
  return params;
}

export function searchHref(locale: string, filters: SearchFilters, overrides: Partial<SearchFilters> = {}): string {
  const params = toSearchParams(filters, overrides).toString();
  return params.length === 0 ? `/${locale}/search` : `/${locale}/search?${params}`;
}

/** How many filter values are set (the sidebar's "{k} set"). */
export function activeFilterCount(filters: SearchFilters): number {
  return filters.part.length + filters.layer.length + filters.tier.length + filters.age.length + filters.type.length;
}

/** The filters with one group's value toggled, for a checkbox link. */
export function toggled<K extends "part" | "layer" | "tier" | "age" | "type">(filters: SearchFilters, group: K, value: SearchFilters[K][number]): SearchFilters {
  const current = filters[group] as ReadonlyArray<SearchFilters[K][number]>;
  const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
  return { ...filters, [group]: next, n: DEFAULT_N };
}

export const EMPTY_FILTERS: SearchFilters = { q: "", part: [], layer: [], tier: [], age: [], type: [], sort: "relevance", n: DEFAULT_N };

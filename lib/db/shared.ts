import { unstable_cache } from "next/cache";

import { getPrisma } from "@/lib/db/client";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import type { Locale } from "@/lib/i18n/routing";

/*
 * Helpers shared by the content loaders (lib/db/content.ts) and the reader-state
 * loaders (lib/db/reader-state.ts).
 */

export const STALE_AFTER_DAYS = 90;
export const RELEASE_TAG = "release:current";
/** Ingestion runs out of process, so a switched release shows within this many seconds. */
export const REVALIDATE_S = 60;
const DAY_MS = 86_400_000;

export type Editions = ReadonlyArray<{ readonly lang: "EN" | "PT"; readonly status: "PARITY" | "PENDING"; readonly title: string; readonly standfirst?: string }>;

export function requireDatabase(): void {
  if (env.DATABASE_URL === undefined) {
    throw new AppError("NO_DATABASE", "DATABASE_URL is not set; the loaders read the release database (feature-specs/04 § 8).");
  }
}

/** Cache a loader per release. Under test there is no Next.js cache, so the loader runs directly. */
export function cached<A extends ReadonlyArray<string | number>, R>(name: string, fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  if (env.NODE_ENV === "test") return fn;
  return unstable_cache(fn, [name], { tags: [RELEASE_TAG], revalidate: REVALIDATE_S });
}

export const pad = (n: number): string => String(n).padStart(2, "0");
export const ageDays = (date: Date, now: Date): number => Math.max(0, Math.floor((now.getTime() - date.getTime()) / DAY_MS));
export const escapeHtml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const firstParagraph = (html: string): string => /<p>[\s\S]*?<\/p>/.exec(html)?.[0] ?? "";

/** Bodies are rendered once with EN hrefs; the PT route rewrites the locale prefix. */
export function localise(html: string, locale: Locale): string {
  return locale === "en" ? html : html.replace(/href="\/en\//g, `href="/${locale}/`);
}

/** PT edition only when it is at parity (spec 03 D6); EN otherwise. */
export function ptAtParity(editions: Editions, locale: Locale): boolean {
  return locale === "pt" && editions.some((e) => e.lang === "PT" && e.status === "PARITY");
}

export function titleFor(editions: Editions, locale: Locale, chapter: number): string {
  const lang = ptAtParity(editions, locale) ? "PT" : "EN";
  const title = editions.find((e) => e.lang === lang)?.title ?? editions.find((e) => e.lang === "EN")?.title ?? "";
  return title.length > 0 ? title : `Chapter ${pad(chapter)}`;
}

export async function currentRelease() {
  const release = await getPrisma().release.findFirst({ where: { isCurrent: true } });
  if (release === null) {
    throw new AppError("NO_RELEASE", "the database holds no current release; run `npm run ingest` (feature-specs/04 § 6.7).");
  }
  return release;
}

import { PeekPanel } from "@/components/reader/PeekPanel";
import { getPeek } from "@/lib/db/content";
import { LocaleSchema } from "@/lib/i18n/routing";

interface PeekRouteProps {
  readonly params: Promise<{ lang: string; n: string; section: string; id: string }>;
}

/*
 * A peek keeps the section's title: the reader is still on the section, with a dialog over it. Since Next.js 16.4 an
 * intercepted navigation takes its metadata from the intercepting route, and without its own the document had no
 * title while a peek was open (axe's document-title in the read-a-section flow, 2026-10-20).
 */
export { generateMetadata } from "../../../page";

/* Intercepted /[lang]/ch/[n]/[section]/ref/[id]: the peek panel over the section (spec § 6.8, unit 18). */
export default async function PeekRoute({ params }: PeekRouteProps) {
  const { lang, n, section, id } = await params;
  const locale = LocaleSchema.parse(lang);
  const data = await getPeek(locale, id);
  return <PeekPanel id={id} data={data} locale={locale} basePath={`/${locale}/ch/${n}/${section}`} />;
}

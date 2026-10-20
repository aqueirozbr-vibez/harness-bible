import { notFound, redirect } from "next/navigation";

import { LocaleSchema } from "@/lib/i18n/routing";

interface ChapterIndexProps {
  readonly params: Promise<{ lang: string; n: string }>;
}

/* A chapter opens at its first layer, Intuition (spec § 11 D4). */
export default async function ChapterIndex({ params }: ChapterIndexProps) {
  const { lang, n } = await params;
  const locale = LocaleSchema.parse(lang);
  if (!/^\d{2}$/.test(n) || Number(n) > 40) {
    notFound();
  }
  redirect(`/${locale}/ch/${n}/${n}.1`);
}

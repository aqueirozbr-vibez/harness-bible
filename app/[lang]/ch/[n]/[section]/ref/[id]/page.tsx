import { redirect } from "next/navigation";

import { LocaleSchema } from "@/lib/i18n/routing";

interface RefUnderSectionProps {
  readonly params: Promise<{ lang: string; id: string }>;
}

/* A hard navigation to a peek URL opens the target in place (spec § 3). */
export default async function RefUnderSection({ params }: RefUnderSectionProps) {
  const { lang, id } = await params;
  const locale = LocaleSchema.parse(lang);
  redirect(`/${locale}/ref/${id}`);
}

import { notFound, redirect } from "next/navigation";

import { LocaleSchema } from "@/lib/i18n/routing";
import { classifyRef } from "@/lib/schemas/chapter";

interface RefPageProps {
  readonly params: Promise<{ lang: string; id: string }>;
}

/* Resolves a book reference (`26.3`, `ch31`, `lab21`) to its page (spec § 3). */
export default async function RefPage({ params }: RefPageProps) {
  const { lang, id } = await params;
  const locale = LocaleSchema.parse(lang);
  const ref = classifyRef(id);
  if (ref === null) {
    notFound();
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  switch (ref.kind) {
    case "section":
      redirect(`/${locale}/ch/${ref.sectionId.slice(0, 2)}/${ref.sectionId}`);
    case "chapter":
      redirect(`/${locale}/ch/${pad(ref.chapter)}`);
    case "lab":
      redirect(`/${locale}/labs/lab-${pad(ref.chapter)}`);
  }
}

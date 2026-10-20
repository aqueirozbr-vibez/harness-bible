import { notFound, redirect } from "next/navigation";

import { assistantPageHref } from "@/lib/assistant/links";
import { LocaleSchema } from "@/lib/i18n/routing";

/*
 * The conversation's old address (feature-specs/17 § 7). Since feature-specs/26 the assistant is one page and the
 * open conversation is `?ask=<id>` on it, the state the dock keeps on every other page. This route stays so that the
 * links already written — one a reader saved, the dock header's of an earlier build — still arrive.
 */
interface ConversationPageProps {
  readonly params: Promise<{ lang: string; conversationId: string }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ConversationPage({ params }: ConversationPageProps) {
  const { lang, conversationId } = await params;
  const locale = LocaleSchema.parse(lang);
  if (!UUID.test(conversationId)) notFound();
  redirect(assistantPageHref(locale, { ask: conversationId }));
}

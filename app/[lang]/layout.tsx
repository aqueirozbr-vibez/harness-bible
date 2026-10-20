import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getMessages, setRequestLocale } from "next-intl/server";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { HTML_LANG, routing } from "@/lib/i18n/routing";
import { THEME_SCRIPT } from "@/lib/theme";

import "@/app/globals.css";

/* IBM Plex, self-hosted by next/font with display swap (TRD § 5.4, ui-context § 13.1). */
const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
  variable: "--font-plex-sans",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-mono",
  display: "swap",
});

interface LangLayoutProps {
  readonly children: ReactNode;
  /** The assistant's slot (feature-specs/24 § 3.1): one mount for every page under the locale; since unit 77 the Research dock's too (feature-specs/48 § 12). */
  readonly assistant: ReactNode;
  readonly params: Promise<{ lang: string }>;
}

export function generateStaticParams() {
  return routing.locales.map((lang) => ({ lang }));
}

export default async function LangLayout({ children, assistant, params }: LangLayoutProps) {
  const { lang } = await params;
  if (!hasLocale(routing.locales, lang)) {
    notFound();
  }
  setRequestLocale(lang);
  const messages = await getMessages();
  /* The CSP nonce proxy.ts issued for this request (feature-specs/09 § 8.1). */
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <html lang={HTML_LANG[lang]} className={`${plexSans.variable} ${plexMono.variable}`} suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="col min-h-screen">
        <NextIntlClientProvider messages={messages}>
          {children}
          {assistant}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}

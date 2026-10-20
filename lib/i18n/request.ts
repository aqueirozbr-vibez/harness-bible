import { hasLocale } from "next-intl";
import { getRequestConfig } from "next-intl/server";
import { headers } from "next/headers";

import { env } from "@/lib/env";
import { FIXTURE_HEADER, PADDED_FIXTURE, padCatalogue, type Messages } from "@/lib/i18n/pad";
import { routing } from "@/lib/i18n/routing";

/**
 * Whether this request asks for the padded PT catalogue (unit 23c, `tests/layout/`). It is a development facility,
 * as the dev sign-in is: a production server never reads the header, so no request can change what it serves.
 */
async function wantsPadded(): Promise<boolean> {
  if (env.NODE_ENV === "production") return false;
  try {
    return (await headers()).get(FIXTURE_HEADER) === PADDED_FIXTURE;
  } catch {
    /* No request to read a header from: a render outside one gets the catalogue as it is. */
    return false;
  }
}

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;
  const messages = (await import(`../../messages/${locale}.json`)).default;
  if (locale === "pt" && (await wantsPadded())) {
    /* Every PT string at least 30 % longer than its EN counterpart: the truncation suite's fixture, computed from the
       two catalogues as they stand (lib/i18n/pad.ts). */
    const english = (await import("../../messages/en.json")).default as Messages;
    return { locale, messages: padCatalogue(english, messages as Messages) };
  }
  return { locale, messages };
});

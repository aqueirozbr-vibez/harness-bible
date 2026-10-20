import { useTranslations } from "next-intl";
import Link from "next/link";

import { Notice } from "@/components/ui/Notice";
import { signInHref } from "@/lib/auth/signIn";
import type { Locale } from "@/lib/i18n/routing";

interface SignInNoticeProps {
  readonly locale: Locale;
  /** Where sign-in returns to. */
  readonly next: string;
  readonly className?: string;
}

/** The "Sign in to keep progress" notice of the paths and marks pages, linking to the sign-in page (feature-specs/08 § 6.4). */
export function SignInNotice({ locale, next, className }: SignInNoticeProps) {
  const t = useTranslations("paths.signIn");
  return (
    <Notice title={t("title")} className={className}>
      <p>
        {t("body")}{" "}
        <Link href={signInHref(locale, next)} className="xref">
          {t("account")}
        </Link>
      </p>
    </Notice>
  );
}

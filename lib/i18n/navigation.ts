import { createNavigation } from "next-intl/navigation";

import { routing } from "@/lib/i18n/routing";

/** Locale-aware navigation helpers for client components (language toggle). */
export const { Link, redirect, usePathname, useRouter, getPathname } = createNavigation(routing);

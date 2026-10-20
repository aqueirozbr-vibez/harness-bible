import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

import { staticSecurityHeaders } from "./lib/security/headers";

const withNextIntl = createNextIntlPlugin("./lib/i18n/request.ts");

const production = process.env.NODE_ENV === "production";
const appUrl = process.env.APP_URL ?? "http://localhost:3000";

const nextConfig: NextConfig = {
  /* Every response carries the static security headers (feature-specs/09 § 8.1); the CSP nonce is per request in proxy.ts. */
  async headers() {
    return [{ source: "/(.*)", headers: [...staticSecurityHeaders(production)] }];
  },
  experimental: {
    /* Server actions accept only this deployment's origin (09 § 8.3). */
    serverActions: { allowedOrigins: [new URL(appUrl).host] },
  },
};

export default withNextIntl(nextConfig);

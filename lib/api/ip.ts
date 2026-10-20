import { createHash } from "node:crypto";

import { env } from "@/lib/env";

/*
 * Client address handling (feature-specs/09 § 8.6): the edge sets
 * `x-forwarded-for`; addresses are stored only as a salted hash.
 */

export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded !== null) {
    const first = forwarded.split(",")[0]?.trim();
    if (first !== undefined && first.length > 0) return first;
  }
  const real = request.headers.get("x-real-ip");
  if (real !== null && real.trim().length > 0) return real.trim();
  return "0.0.0.0";
}

/** sha256 of the address with the configured salt and the day, so a hash cannot be joined across days. */
export function hashIp(ip: string, day = new Date()): string {
  const stamp = day.toISOString().slice(0, 10);
  return createHash("sha256").update(`${env.IP_HASH_SALT}:${stamp}:${ip}`).digest("hex").slice(0, 32);
}

/** A stable key for rate limiting within the window (salted, no day so buckets survive midnight). */
export function rateKeyForIp(ip: string): string {
  return createHash("sha256").update(`${env.IP_HASH_SALT}:rl:${ip}`).digest("hex").slice(0, 24);
}

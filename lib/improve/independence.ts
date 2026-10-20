import type { Stake } from "@/lib/schemas/rubric";

/*
 * Independence without showing the contributor to a model (feature-specs/32 § 7.4). The rubric's third value, 0.7,
 * is "the contributor's own employer", and the grader may never read who the contributor is; so code decides it: an
 * item's stake is `employer` when its publisher's registrable domain is the domain of the contributor's verified
 * e-mail address, public mail providers excepted, else `vendor` when the grader said so, else `none`. A researcher's
 * suggestion has no contributor and never takes `employer`; an upload has no publisher unless 49b gave it one.
 *
 * The registrable domain is the last two labels, or the last three under a second-level public suffix of the kind
 * `com.br`, `co.uk`, `com.au`: a short table here rather than the public suffix list, which would be a dependency
 * for a comparison that is only ever made between two hosts a person wrote (a mismatch costs 0.2 of a factor in
 * one direction and nothing in the other). The public mail providers are a short list kept as data, as the spec
 * asks; a contributor at one of them has no employer the address can name.
 */

/** Public mail providers: an address at one of these names no employer. Lowercase, registrable domains. */
export const PUBLIC_MAIL_PROVIDERS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "yahoo.com.br", "ymail.com", "icloud.com", "me.com", "mac.com", "proton.me", "protonmail.com", "pm.me", "aol.com", "gmx.com", "gmx.net", "mail.com", "zoho.com", "yandex.com", "fastmail.com", "tutanota.com", "tuta.io", "hey.com",
  "uol.com.br", "bol.com.br", "terra.com.br", "globo.com", "globomail.com", "ig.com.br", "oi.com.br", "zipmail.com.br", "r7.com",
]);

/** Second-level public suffixes under which the registrable domain is three labels, not two. */
const SECOND_LEVEL_SUFFIXES: ReadonlySet<string> = new Set([
  "com.br", "net.br", "org.br", "gov.br", "edu.br", "mil.br", "art.br", "blog.br", "eco.br", "eng.br", "inf.br", "jus.br", "leg.br", "tv.br", "wiki.br",
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "net.uk", "ltd.uk", "plc.uk", "sch.uk", "nhs.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "id.au",
  "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp", "ad.jp",
  "co.nz", "org.nz", "net.nz", "govt.nz", "ac.nz",
  "co.za", "org.za", "net.za", "ac.za", "gov.za",
  "com.mx", "org.mx", "gob.mx", "edu.mx",
  "com.ar", "org.ar", "gob.ar", "edu.ar",
  "co.in", "net.in", "org.in", "ac.in", "gov.in",
  "com.sg", "org.sg", "edu.sg", "gov.sg",
  "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn",
  "com.tr", "org.tr", "edu.tr", "gov.tr",
  "co.kr", "or.kr", "ac.kr", "go.kr",
  "com.hk", "org.hk", "edu.hk", "gov.hk",
  "com.tw", "org.tw", "edu.tw", "gov.tw",
  "co.il", "org.il", "ac.il", "gov.il",
  "com.pt", "org.pt", "edu.pt", "gov.pt",
]);

/** The registrable domain of a host, lowercased: `docs.provider-two.example` → `provider-two.example`; `www.ibm.com.br` → `ibm.com.br`. Null for a host with one label or an address. */
export function registrableDomain(host: string): string | null {
  const labels = host.trim().toLowerCase().replace(/\.$/, "").split(".");
  if (labels.length < 2 || labels.some((label) => label === "")) return null;
  if (labels.every((label) => /^\d+$/.test(label))) return null;
  const lastTwo = labels.slice(-2).join(".");
  if (SECOND_LEVEL_SUFFIXES.has(lastTwo)) return labels.length >= 3 ? labels.slice(-3).join(".") : null;
  return lastTwo;
}

/** The registrable domain of an e-mail address, or null when the address names a public mail provider or is not an address. */
export function employerDomainOf(email: string | null): string | null {
  if (email === null) return null;
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  const domain = registrableDomain(email.slice(at + 1));
  if (domain === null || PUBLIC_MAIL_PROVIDERS.has(domain)) return null;
  return domain;
}

export interface StakeFacts {
  /** The grader's classification: the publisher is the vendor the claim is about, or nobody with a stake. */
  readonly graderStake: "none" | "vendor";
  /** The publisher's host as the fetcher saw it (the final URL's), or null for an upload. */
  readonly publisherHost: string | null;
  /** The contributor's verified e-mail address, or null for a researcher's suggestion. Read here and nowhere near a model. */
  readonly contributorEmail: string | null;
}

/** The item's stake, decided by code (§ 7.4): `employer` first, then what the grader said. */
export function stakeOf(facts: StakeFacts): Stake {
  const employer = employerDomainOf(facts.contributorEmail);
  const publisher = facts.publisherHost === null ? null : registrableDomain(facts.publisherHost);
  if (employer !== null && publisher !== null && employer === publisher) return "employer";
  return facts.graderStake;
}

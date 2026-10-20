/*
 * What a secret looks like (feature-specs/21 § 6.1; architecture § 5.7, § 9, invariant 9): the one table the
 * template scanner of CI and the redaction of user text and log lines both read. Each entry is a kind, which is
 * what a finding is named and what replaces the match (`[redacted:anthropic-key]`), and the shape of that kind.
 *
 * A shape is the published format of the credential where there is one (an AWS access key id is `AKIA` and sixteen
 * characters; a Google API key is `AIza` and thirty-five; a GitHub token is its prefix and thirty-six). Where the
 * format has no fixed length, the pattern asks for at least twenty characters after the prefix: the floor that lets
 * a sentence name a prefix (`keys start with sk-ant-`) without being a finding, and below which nothing issued by
 * these providers falls.
 *
 * Order matters once: a more specific kind comes before the general one that would also match it (`sk-ant-…` is an
 * Anthropic key before it is an `sk-` key; `Bearer eyJ…` is a bearer token as a whole). When two matches overlap,
 * the earlier one in the text wins, and at the same start the earlier one in this table.
 */

export const SECRET_KINDS = ["pem-block", "anthropic-key", "api-key", "aws-access-key", "github-token", "slack-token", "google-api-key", "bearer-token", "jwt", "connection-string"] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];

export interface SecretPattern {
  readonly kind: SecretKind;
  /** Global, so every occurrence is found; never sticky, so a search can start anywhere. */
  readonly pattern: RegExp;
}

export const SECRET_PATTERNS: ReadonlyArray<SecretPattern> = [
  /* A PEM block, whole when its end is there and by its first line when the paste was cut short. */
  { kind: "pem-block", pattern: /-----BEGIN [A-Z0-9 ]+-----(?:[\s\S]*?-----END [A-Z0-9 ]+-----)?/g },
  { kind: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  /* The `sk-` family: other providers' keys, and the gateway's own virtual keys, which take the same form. */
  { kind: "api-key", pattern: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { kind: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}/g },
  { kind: "slack-token", pattern: /\bxox[abp]-[A-Za-z0-9-]{20,}/g },
  { kind: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}/g },
  { kind: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g },
  /* Three base64url segments, the first two of them JSON objects (`eyJ` is `{"`). */
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  /* A URL that carries a password, `scheme://user:password@host/…`: the whole of it, to the end of the word, since
     the host and the database it names are not for a prompt either. */
  { kind: "connection-string", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s:/@]+@[^\s"'<>)]+/g },
];

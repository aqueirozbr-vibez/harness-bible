import { describe, expect, it } from "vitest";

import { findSecrets, redactionMark, redactSecrets } from "./redact";
import { SECRET_KINDS, SECRET_PATTERNS, type SecretKind } from "./secretPatterns";

/*
 * The pattern table and the redaction (feature-specs/21 § 6.1, § 6.2). Every example below is assembled from parts
 * at run time: this file holds no string that is itself shaped like a credential, so the repository's own scanners
 * have nothing to find in the test of the scanner.
 */

const chars = (alphabet: string, length: number) => Array.from({ length }, (_, index) => alphabet[(index * 7 + 3) % alphabet.length]).join("");
const ALNUM = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** One well-formed example per kind. */
const EXAMPLE: Readonly<Record<SecretKind, string>> = {
  "pem-block": ["-----BEGIN ", "PRIVATE KEY-----\n", chars(ALNUM, 64), "\n-----END ", "PRIVATE KEY-----"].join(""),
  "anthropic-key": ["sk", "ant", `api03-${chars(ALNUM, 80)}`].join("-"),
  "api-key": ["sk", chars(ALNUM, 40)].join("-"),
  "aws-access-key": `AKIA${chars(UPPER, 16)}`,
  "github-token": ["ghp", chars(ALNUM, 36)].join("_"),
  "slack-token": ["xoxb", chars("0123456789", 12), chars(ALNUM, 24)].join("-"),
  "google-api-key": `AIza${chars(ALNUM, 35)}`,
  "bearer-token": `Bearer ${chars(ALNUM, 40)}`,
  jwt: [`eyJ${chars(ALNUM, 20)}`, `eyJ${chars(ALNUM, 40)}`, chars(ALNUM, 43)].join("."),
  "connection-string": ["postgresql://reader", `${chars(ALNUM, 12)}@db.internal:5432/app`].join(":"),
};

describe("the pattern table", () => {
  it("has one pattern per kind, each global, the specific before the general", () => {
    expect(SECRET_PATTERNS.map((entry) => entry.kind)).toEqual([...SECRET_KINDS]);
    expect(SECRET_PATTERNS.every((entry) => entry.pattern.global && !entry.pattern.sticky)).toBe(true);
    const order = SECRET_PATTERNS.map((entry) => entry.kind);
    expect(order.indexOf("anthropic-key")).toBeLessThan(order.indexOf("api-key"));
    expect(order.indexOf("bearer-token")).toBeLessThan(order.indexOf("jwt"));
  });

  it.each(SECRET_KINDS)("finds a %s, whole, and nothing around it", (kind) => {
    const text = `before ${EXAMPLE[kind]} after`;
    const found = findSecrets(text);
    expect(found.map((finding) => finding.kind)).toEqual([kind]);
    expect(text.slice(found[0]?.start, found[0]?.end)).toBe(EXAMPLE[kind]);
  });

  it("leaves alone what only looks like one", () => {
    const harmless = [
      "Anthropic keys start with sk-ant- and the gateway's with sk-.",
      "The task-survival aid, a risk-management-and-governance-review, and disk-usage-at-ninety-percent.",
      "Send the header Authorization: Bearer <token> with every request.",
      "The bearer of the message; Bearer tokens expire.",
      "See https://example.com/docs/keys and http://localhost:3000/en/ch/21/21.3 for the section.",
      "Write to reader@example.com or connect to postgresql://localhost:5432/harness_bible.",
      "sha256 9f86d081884c7d659a2feae0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 and id 00000000-0000-4000-8000-00000000de01",
      "AKIA is the prefix of an access key id; AIza of a Google key; ghp_ of a GitHub token.",
      "A JWT has three parts: eyJ..., a payload and a signature.",
      "-----BEGIN is how a PEM block starts.",
      "Figure F-21-07 in 21.3 gives 76.9% at 13 calls; trace 0af7651916cd43dd8448eb211c80319c.",
    ];
    for (const text of harmless) expect(findSecrets(text), text).toEqual([]);
  });

  it("names an overlap once: the specific kind, and a bearer's token as the bearer", () => {
    expect(findSecrets(EXAMPLE["anthropic-key"]).map((finding) => finding.kind)).toEqual(["anthropic-key"]);
    expect(findSecrets(`Authorization: Bearer ${EXAMPLE.jwt}`).map((finding) => finding.kind)).toEqual(["bearer-token"]);
    expect(findSecrets(`${EXAMPLE["connection-string"]} ${EXAMPLE["api-key"]}`).map((finding) => finding.kind)).toEqual(["connection-string", "api-key"]);
  });

  it("takes a PEM block cut short by its first line, so half a pasted key is still a finding", () => {
    const cut = ["-----BEGIN RSA ", "PRIVATE KEY-----\n", chars(ALNUM, 40)].join("");
    const found = findSecrets(`key:\n${cut}`);
    expect(found.map((finding) => finding.kind)).toEqual(["pem-block"]);
    expect(found[0]?.line).toBe(2);
  });
});

describe("findSecrets", () => {
  it("says where each one is, by line, in the order of the text", () => {
    const text = `line one\nkey = ${EXAMPLE["aws-access-key"]}\n\nand ${EXAMPLE["github-token"]} then ${EXAMPLE["google-api-key"]}\n`;
    expect(findSecrets(text).map((finding) => `${String(finding.line)} ${finding.kind}`)).toEqual(["2 aws-access-key", "4 github-token", "4 google-api-key"]);
  });

  it("holds positions and kinds, never the match", () => {
    const found = findSecrets(`x ${EXAMPLE["anthropic-key"]} y`);
    expect(Object.keys(found[0] ?? {}).sort()).toEqual(["end", "kind", "line", "start"]);
    expect(JSON.stringify(found)).not.toContain(EXAMPLE["anthropic-key"].slice(10, 30));
  });

  it("finds the same on a second call: the patterns keep no place between calls", () => {
    const text = `${EXAMPLE["api-key"]} and ${EXAMPLE["api-key"]}`;
    expect(findSecrets(text)).toHaveLength(2);
    expect(findSecrets(text)).toHaveLength(2);
  });
});

describe("redactSecrets", () => {
  it("replaces each secret with its kind and keeps every other character", () => {
    const question = `Our key is ${EXAMPLE["anthropic-key"]}, why does a retried write become a second write?`;
    expect(redactSecrets(question)).toEqual({ text: "Our key is [redacted:anthropic-key], why does a retried write become a second write?", findings: ["anthropic-key"] });
  });

  it("names one finding per match, so the count is how many there were", () => {
    const result = redactSecrets(`${EXAMPLE["api-key"]}\n${EXAMPLE["api-key"]}\n${EXAMPLE["slack-token"]}`);
    expect(result.findings).toEqual(["api-key", "api-key", "slack-token"]);
    expect(result.text).toBe("[redacted:api-key]\n[redacted:api-key]\n[redacted:slack-token]");
  });

  it("returns the same string, untouched, when there is nothing to remove", () => {
    const text = "Why does a retried write without an idempotency key become a second write?";
    const result = redactSecrets(text);
    expect(result.text).toBe(text);
    expect(result.findings).toEqual([]);
  });

  it("is idempotent: what it wrote is not a secret", () => {
    const once = redactSecrets(SECRET_KINDS.map((kind) => EXAMPLE[kind]).join("\n"));
    expect(once.findings).toEqual([...SECRET_KINDS]);
    expect(once.text).toBe(SECRET_KINDS.map(redactionMark).join("\n"));
    expect(redactSecrets(once.text)).toEqual({ text: once.text, findings: [] });
  });

  it("leaves no part of any example in its output", () => {
    for (const kind of SECRET_KINDS) {
      const out = redactSecrets(`a ${EXAMPLE[kind]} b`).text;
      expect(out).toBe(`a ${redactionMark(kind)} b`);
    }
  });
});

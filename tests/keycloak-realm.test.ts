import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * The realm as code (feature-specs/09 § 3.2; infra/keycloak/README.md). Keycloak stores a flow's, a client's or a
 * mapper's description and name in columns of 255 characters and refuses the whole import when one is longer: the
 * CI job that imports the realm into a fresh Keycloak failed so on its first run (2026-10-20), on a flow description
 * of 263. This reads the template as data, without Docker, so the length is caught where the text is written.
 */

const realm: unknown = JSON.parse(readFileSync(join(import.meta.dirname, "..", "infra", "keycloak", "realm-harness-bible.json"), "utf8"));

/** Every string value in the template, with its path. */
function strings(value: unknown, path: string): ReadonlyArray<readonly [string, string]> {
  if (typeof value === "string") return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((item, index) => strings(item, `${path}[${String(index)}]`));
  if (value !== null && typeof value === "object") return Object.entries(value).flatMap(([key, item]) => strings(item, `${path}.${key}`));
  return [];
}

describe("the realm template (09 § 3.2)", () => {
  it("writes no description or name over Keycloak's 255 characters", () => {
    const long = strings(realm, "realm")
      .filter(([path]) => /\.(description|name|alias|displayName)$/.test(path))
      .filter(([, text]) => text.length > 255)
      .map(([path, text]) => `${path}: ${String(text.length)}`);
    expect(long).toEqual([]);
  });
});

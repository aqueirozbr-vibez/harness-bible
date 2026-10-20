import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The development provider's switch and what hangs from it (feature-specs/08 § 5.7; feature-specs/29 § 6.4, § 10.8):
 * it answers only where it is switched on and never in production; and the function that makes a development
 * account refuses to give a role or a verification anywhere else, before it reads a row. The database is not
 * reached here; the accounts themselves are tests/integration/dev-accounts.test.ts.
 */

const fake = vi.hoisted(() => ({ env: { AUTH_DEV_PROVIDER: undefined as "1" | undefined, NODE_ENV: "test" as string }, database: 0 }));

vi.mock("@/lib/env", () => ({ env: fake.env }));
vi.mock("@/lib/db/client", () => ({
  getPrisma: () => {
    fake.database += 1;
    throw new Error("the database is not reached in this suite");
  },
}));

import { devProviderEnabled } from "./devProvider";
import { resolveDevUser } from "./link";

const EMAIL = "dev-accounts@harness-bible.local";

beforeEach(() => {
  fake.env.AUTH_DEV_PROVIDER = undefined;
  fake.env.NODE_ENV = "test";
  fake.database = 0;
});

describe("devProviderEnabled", () => {
  it("is on where it is switched on, in development and under test", () => {
    fake.env.AUTH_DEV_PROVIDER = "1";
    expect(devProviderEnabled()).toBe(true);
    fake.env.NODE_ENV = "development";
    expect(devProviderEnabled()).toBe(true);
  });

  it("is off where nobody switched it on", () => {
    expect(devProviderEnabled()).toBe(false);
  });

  it("is off in production whatever the switch says", () => {
    fake.env.AUTH_DEV_PROVIDER = "1";
    fake.env.NODE_ENV = "production";
    expect(devProviderEnabled()).toBe(false);
  });
});

describe("resolveDevUser, asked for a role or a verification", () => {
  it("refuses where the development provider is off, before it reads a row", async () => {
    for (const as of [{ role: "CURATOR" as const }, { verified: true }, { verified: false }, { role: "READER" as const, verified: true }]) {
      await expect(resolveDevUser(EMAIL, "en", as), JSON.stringify(as)).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(fake.database).toBe(0);
  });

  it("refuses in production even with the switch on", async () => {
    fake.env.AUTH_DEV_PROVIDER = "1";
    fake.env.NODE_ENV = "production";
    await expect(resolveDevUser(EMAIL, "en", { role: "CONTRIBUTOR", verified: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(fake.database).toBe(0);
  });

  it("goes on to the account where the provider is on, and whenever it is asked for neither", async () => {
    fake.env.AUTH_DEV_PROVIDER = "1";
    await expect(resolveDevUser(EMAIL, "en", { role: "CURATOR" })).rejects.toThrow("the database is not reached in this suite");
    fake.env.AUTH_DEV_PROVIDER = undefined;
    await expect(resolveDevUser(EMAIL, "en")).rejects.toThrow("the database is not reached in this suite");
    await expect(resolveDevUser(EMAIL, "en", {})).rejects.toThrow("the database is not reached in this suite");
    expect(fake.database).toBe(3);
  });
});

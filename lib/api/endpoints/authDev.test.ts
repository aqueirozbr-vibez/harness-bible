import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The development sign-in where it must not answer (feature-specs/29 § 6.4, § 10.8): in production, or anywhere it
 * is not switched on, it is a 404 whatever the query says, the new `role` and `verified` included, and nothing is
 * resolved, changed or signed in. The pipeline's own steps are doubled, as lib/api/handler.test.ts doubles them;
 * what the endpoint does where it does answer is tests/integration/dev-accounts.test.ts.
 */

const fake = vi.hoisted(() => ({ enabled: false, resolved: 0, sessions: 0, events: 0 }));

vi.mock("@/lib/auth/devProvider", () => ({ devProviderEnabled: () => fake.enabled }));
vi.mock("@/lib/auth/link", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/link")>()),
  resolveDevUser: async () => {
    fake.resolved += 1;
    return { userId: "u", organisationId: null, role: "READER", roleChanged: false, rosterSet: [] };
  },
}));
vi.mock("@/lib/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/session")>()),
  createSession: async () => {
    fake.sessions += 1;
    return "a-session-token-of-the-suite";
  },
}));
vi.mock("@/lib/db/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/audit")>()),
  recordAuthEvent: async () => {
    fake.events += 1;
  },
}));

import { handler, type HandlerDeps } from "@/lib/api/handler";

import { authDev } from "./auth";

const deps: HandlerDeps = {
  sessionFromRequest: async () => null,
  authorize: async () => ({ allow: true }),
  consume: async () => ({ allowed: true, limit: 10, remaining: 9, resetS: 6, retryAfterS: 0 }),
  idempotency: { begin: async () => ({ kind: "new" }), complete: async () => undefined, abandon: async () => undefined },
  audit: async () => undefined,
  log: () => undefined,
};

const get = (query: string): Promise<Response> => handler(authDev, deps)(new Request(`http://localhost:3000/api/v1/auth/dev${query}`, { headers: { "x-forwarded-for": "198.51.100.46" } }), { params: {} });

beforeEach(() => {
  fake.enabled = false;
  fake.resolved = 0;
  fake.sessions = 0;
  fake.events = 0;
});

describe("GET /api/v1/auth/dev where the development provider is off", () => {
  it("answers 404 to every query, with a role, a verification, both, or values that are neither", async () => {
    for (const query of ["", "?role=CURATOR", "?verified=true", "?email=someone%40example.org&role=CONTRIBUTOR&verified=true&next=/en", "?role=emperor", "?verified=perhaps"]) {
      const response = await get(query);
      expect(response.status, query).toBe(404);
      expect(await response.json(), query).toMatchObject({ code: "NOT_FOUND" });
      expect(response.headers.get("set-cookie"), query).toBeNull();
    }
    expect(fake).toMatchObject({ resolved: 0, sessions: 0, events: 0 });
  });
});

describe("GET /api/v1/auth/dev where it is on", () => {
  beforeEach(() => {
    fake.enabled = true;
  });

  it("refuses a role that is not one of the product's and a verification that is neither true nor false, and signs nobody in", async () => {
    for (const query of ["?role=emperor", "?role=curator", "?verified=perhaps", "?role=CURATOR&verified=1"]) {
      const response = await get(query);
      expect(response.status, query).toBe(400);
      expect(await response.json(), query).toMatchObject({ code: "INVALID_INPUT", detail: { role: ["READER", "BUILDER", "CONTRIBUTOR", "CURATOR", "ORG_ADMIN"], verified: ["true", "false"] } });
    }
    expect(fake).toMatchObject({ resolved: 0, sessions: 0 });
  });

  it("signs in with a cookie when the query is one it takes", async () => {
    const response = await get("?email=someone%40harness-bible.local&role=CURATOR&verified=true&next=/en");
    expect(response.status).toBe(302);
    expect(response.headers.get("set-cookie")).toContain("hb.session=");
    expect(fake).toMatchObject({ resolved: 1, sessions: 1 });
  });
});
